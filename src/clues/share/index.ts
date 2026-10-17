/**
 * S7 integration surface: the `.cluepack` share service and the raw ZIP
 * route handlers S9 registers.
 *
 * Two layers:
 * - {@link installCluesShare} wires the export/import business service into
 *   one Cordis mount, registers the JSON-safe `clues.share.*` methods on the
 *   S1 service seam (`exportPreview`, `exportInspect`, `exportProgress`,
 *   `importPreview`), and releases everything through `ctx.effect`.
 * - {@link createCluesShareRoutes} returns the four raw HTTP handlers. They
 *   carry archive bytes (never JSON-encoded bodies), enforce the fence and a
 *   request-size cap, and forward a cancellation signal derived from the
 *   response connection. S9 mounts each route with `ctx.webServer.register`.
 *
 * Route table (all exact paths, POST only):
 * ```
 * /sidebar/clues/share/export-preview   JSON body → JSON export preview
 * /sidebar/clues/share/export           JSON body → application/zip (download)
 * /sidebar/clues/share/import-preview   ZIP body  → JSON import preview
 * /sidebar/clues/share/import           ZIP body  → JSON import result
 * ```
 *
 * Request shapes (S9 must follow these exactly):
 * - `export-preview` / `export`: JSON body
 *   `{ workspaceId, mode, packIds?, clueIds?, exportId? }`. The export route
 *   reads `exportId` from this body; the preview ignores it.
 * - `import-preview` / `import`: the archive is the RAW request body; the
 *   target workspace cannot also be JSON, so it travels as
 *   `?workspaceId=<id>`. An explicit receiver remap list travels as
 *   `?remap=<encodeURIComponent(JSON.stringify(ClueShareLocatorRemap[]))>`.
 *   Both routes share this shape.
 *
 * The export route accepts an optional `exportId` in its JSON body. When one is
 * present, per-item progress and the terminal outcome (including a
 * `complete:false` partial issue list) are readable from
 * `clues.share.exportProgress`, and the ZIP response carries the same
 * complete/issue counters as `x-cluepack-*` headers — a ZIP body alone cannot
 * tell the client that the pack it is downloading is incomplete.
 *
 * The export/import transfer operations are deliberately NOT JSON API
 * methods: a clue pack is a file, and base64-in-JSON would inflate it and
 * force the whole archive through the generic 1 MiB body parser.
 */
import type { Context, SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from '../../context-types.ts'
import type { CluesService } from '../service.ts'
import { ClueError, isClueError, type ClueApiContext, type ClueErrorCategory } from '../types.ts'
import { readJsonBody, SidebarError, writeError, writeJson, writeOk } from '../../wire.ts'
import {
  exportPack as runExportPack,
  inspectExport as runInspectExport,
  previewExport as runPreviewExport,
  wellFormedText,
  type ClueShareExportDeps,
  type ClueShareExportInspection,
  type ClueShareExportParams,
  type ClueShareExportPreview,
  type ClueShareExportProgress,
  type ClueShareExportResult,
} from './export.ts'
import {
  importPack as runImportPack,
  parseClueShareRemap,
  previewImport as runPreviewImport,
  type ClueShareImportDeps,
  type ClueShareImportParams,
  type ClueShareImportPreview,
  type ClueShareImportResult,
  type ClueShareLocatorRemap,
} from './import.ts'
import type { CluepackIssue } from './manifest.ts'
import { DEFAULT_ZIP_LIMITS, type ZipReadLimits } from './zip.ts'

export * from './zip.ts'
export * from './manifest.ts'
export * from './export.ts'
export * from './import.ts'

/** Default maximum archive accepted by the raw import routes. */
export const DEFAULT_MAX_IMPORT_BYTES = DEFAULT_ZIP_LIMITS.maxArchiveBytes
/**
 * Default maximum decoded archive accepted by the `clues.share.importPreview`
 * API method.
 *
 * The generic `/sidebar/api` dispatcher reads every ordinary JSON body with a
 * 1 MiB cap (`src/wire.ts`), so at most ~768 KiB decoded could ever arrive
 * here. This method deliberately advertises a smaller, actually REACHABLE
 * bound (512 KiB): an archive above it is refused by the method with a
 * pointer at the raw `import-preview` route instead of dying on the
 * dispatcher's generic body limit. Real archives use the raw route.
 */
export const DEFAULT_MAX_API_IMPORT_BYTES = 512 * 1024
/** Maximum number of tracked export progress ids kept in memory. */
const MAX_TRACKED_EXPORTS = 16
/** How long a finished/failed export's progress stays readable. */
const EXPORT_PROGRESS_TTL_MS = 10 * 60 * 1000

/** Options of {@link installCluesShare} (test seams + limits). */
export interface InstallCluesShareOptions {
  readonly now?: () => string
  readonly zipLimits?: Partial<ZipReadLimits>
  readonly maxSnapshotBytes?: number
  /** Finished-archive bound; keep it inside the import route's body cap. */
  readonly maxArchiveBytes?: number
  readonly maxEntries?: number
  readonly maxTotalBytes?: number
  readonly maxManifestBytes?: number
  readonly readFileBytes?: (path: string) => Promise<Uint8Array>
  readonly statFile?: (path: string) => Promise<{ readonly size: number; readonly isFile: boolean }>
  /** Decoded archive bound of the `clues.share.importPreview` API method. */
  readonly maxApiImportBytes?: number
}

/**
 * One tracked export as the S9 UI polls it.
 *
 * The raw export route answers with the ZIP only; progress and the terminal
 * partial/complete state must not be dropped (spec §4: per-item progress,
 * failures and an explicit "incomplete" download prompt). A client generates
 * an `exportId`, sends it in the export body, and polls
 * `clues.share.exportProgress`.
 */
export interface ClueShareExportStatus {
  readonly exportId: string
  readonly updatedAt: string
  readonly phase: ClueShareExportProgress['phase']
  readonly completed: number
  readonly total: number
  readonly key?: string
  readonly status?: 'ok' | 'issue'
  readonly reason?: string
  /** True once the export settled (an outcome or a failure is present). */
  readonly done: boolean
  /** Present when the archive was produced; `complete:false` marks a partial download. */
  readonly outcome?: {
    readonly complete: boolean
    readonly fileName: string
    readonly issues: readonly CluepackIssue[]
    readonly stats: ClueShareExportResult['stats']
  }
  /** Present when the export failed or was cancelled before producing bytes. */
  readonly failure?: {
    readonly category: ClueErrorCategory
    readonly message: string
  }
}

/** Bounded, in-memory export progress channel shared by the routes and the API. */
export interface CluesShareExportProgressStore {
  /** Record one progress event of an in-flight export. */
  record(exportId: string, progress: ClueShareExportProgress): void
  /** Record a produced archive (complete or partial) and its issue list. */
  finish(exportId: string, result: ClueShareExportResult): void
  /** Record a terminal failure/cancellation (the route still throws its envelope). */
  fail(exportId: string, error: unknown): void
  /** Latest known state, or `undefined` for an unknown/expired id. */
  read(exportId: string): ClueShareExportStatus | undefined
  dispose(): void
}

/**
 * Create one bounded progress store. Entries expire after a TTL and the map
 * never grows past `maxEntries` (oldest first), so a client that forgets to
 * poll cannot leak memory.
 * @param options - clock/TTL/bound seams (tests).
 */
export function createCluesShareExportProgressStore(options: {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
} = {}): CluesShareExportProgressStore {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? EXPORT_PROGRESS_TTL_MS
  const maxEntries = options.maxEntries ?? MAX_TRACKED_EXPORTS
  const entries = new Map<string, { status: ClueShareExportStatus; at: number }>()
  let disposed = false
  const prune = (): void => {
    const cutoff = now() - ttlMs
    for (const [id, entry] of entries) {
      if (entry.at <= cutoff) entries.delete(id)
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }
  const put = (status: ClueShareExportStatus): void => {
    if (disposed) return
    prune()
    // Re-insert so Map iteration order really is "least recently written".
    entries.delete(status.exportId)
    entries.set(status.exportId, { status, at: now() })
  }
  const timestamp = (): string => new Date(now()).toISOString()
  return {
    record(exportId, progress) {
      put({
        exportId,
        updatedAt: timestamp(),
        phase: progress.phase,
        completed: progress.completed,
        total: progress.total,
        ...(progress.key === undefined ? {} : { key: progress.key }),
        ...(progress.status === undefined ? {} : { status: progress.status }),
        ...(progress.reason === undefined ? {} : { reason: progress.reason }),
        done: progress.phase === 'done',
      })
    },
    finish(exportId, result) {
      const previous = entries.get(exportId)?.status
      put({
        exportId,
        updatedAt: timestamp(),
        phase: 'done',
        completed: previous?.completed ?? 0,
        total: previous?.total ?? 0,
        done: true,
        outcome: {
          complete: result.complete,
          fileName: result.fileName,
          issues: result.issues,
          stats: result.stats,
        },
      })
    },
    fail(exportId, error) {
      const previous = entries.get(exportId)?.status
      put({
        exportId,
        updatedAt: timestamp(),
        phase: previous?.phase ?? 'collect',
        completed: previous?.completed ?? 0,
        total: previous?.total ?? 0,
        done: true,
        failure: isClueError(error)
          ? { category: error.category, message: error.message }
          : { category: 'failed', message: 'the clue pack export failed' },
      })
    },
    read(exportId) {
      if (disposed) return undefined
      prune()
      return entries.get(exportId)?.status
    },
    dispose() {
      disposed = true
      entries.clear()
    },
  }
}

/** The share business service returned by {@link installCluesShare}. */
export interface CluesShareService {
  previewExport(params: ClueShareExportParams): Promise<ClueShareExportPreview>
  /** Resolve the exact portable references for the share-confirmation screen. */
  inspectExport(params: ClueShareExportParams): Promise<ClueShareExportInspection>
  exportPack(params: ClueShareExportParams): Promise<ClueShareExportResult>
  previewImport(params: ClueShareImportParams): Promise<ClueShareImportPreview>
  importPack(params: ClueShareImportParams): Promise<ClueShareImportResult>
  /** Progress channel of the raw export route (bounded, in-memory). */
  readonly progress: CluesShareExportProgressStore
  /** Releases registered API methods; persisted clue data is untouched. */
  dispose(): void
}

/** Concrete services the share layer wraps (exported for S9/tests). */
export interface ClueShareServiceDeps {
  readonly clues: CluesService
  readonly export?: Omit<ClueShareExportDeps, 'clues'>
  readonly import?: Omit<ClueShareImportDeps, 'clues'>
}

/** Route paths of the share surface (single source for S9). */
export const CLUES_SHARE_ROUTE_PATHS = {
  exportPreview: '/sidebar/clues/share/export-preview',
  export: '/sidebar/clues/share/export',
  importPreview: '/sidebar/clues/share/import-preview',
  import: '/sidebar/clues/share/import',
} as const

/** Options of {@link createCluesShareRoutes}. */
export interface CluesShareRouteOptions {
  /**
   * Maximum archive body accepted by the import routes. Defaults to the same
   * shared limit the exporter uses, so an archive this plugin builds is one
   * this route accepts.
   */
  readonly maxImportBytes?: number
  /** Maximum JSON body accepted by the export/preview routes. */
  readonly maxJsonBytes?: number
}

/** The raw route handlers of the share surface. */
export interface CluesShareRouteHandlers {
  readonly exportPreview: SidebarWebRoute
  readonly export: SidebarWebRoute
  readonly importPreview: SidebarWebRoute
  readonly import: SidebarWebRoute
  /** Registration order for `ctx.webServer.register`. */
  readonly routes: readonly SidebarWebRoute[]
}

/** The browser-trust fence every /sidebar route uses. */
export type CluesShareFence = (req: SidebarHttpRequest) => boolean

/** Create the business service without installing it (tests/S9 seams). */
export function createCluesShareService(deps: ClueShareServiceDeps): CluesShareService {
  const exportDeps: ClueShareExportDeps = { clues: deps.clues, ...deps.export }
  const importDeps: ClueShareImportDeps = { clues: deps.clues, ...deps.import }
  const progress = createCluesShareExportProgressStore()
  let disposed = false
  const ensureLive = (): void => {
    if (disposed) throw new ClueError('failed', 'the clue share service is no longer mounted')
  }
  return {
    previewExport(params) {
      ensureLive()
      return runPreviewExport(exportDeps, params)
    },
    inspectExport(params) {
      ensureLive()
      return runInspectExport(exportDeps, params)
    },
    exportPack(params) {
      ensureLive()
      return runExportPack(exportDeps, params)
    },
    previewImport(params) {
      ensureLive()
      return runPreviewImport(importDeps, params)
    },
    importPack(params) {
      ensureLive()
      return runImportPack(importDeps, params)
    },
    progress,
    dispose() {
      disposed = true
      progress.dispose()
    },
  }
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One optional string-array payload field (the service validates ids). */
function stringArrayOf(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new ClueError('invalid-request', `"${field}" must be an array of strings`)
  }
  return value as string[]
}

/** Export params from a JSON payload (both the API and the routes use this). */
function exportParamsOf(payload: unknown, signal?: AbortSignal): ClueShareExportParams {
  if (!isRecord(payload)) {
    throw new ClueError('invalid-request', 'the clue export payload must be a JSON object')
  }
  return {
    workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : '',
    mode: payload.mode as ClueShareExportParams['mode'],
    ...(payload.packIds === undefined ? {} : { packIds: stringArrayOf(payload.packIds, 'packIds') }),
    ...(payload.clueIds === undefined ? {} : { clueIds: stringArrayOf(payload.clueIds, 'clueIds') }),
    ...(signal === undefined ? {} : { signal }),
  }
}

/** Import params from a JSON payload carrying a base64 archive (API method). */
function importParamsOf(
  payload: unknown,
  context: ClueApiContext,
  maxBytes: number,
): ClueShareImportParams {
  if (!isRecord(payload)) {
    throw new ClueError('invalid-request', 'the clue import payload must be a JSON object')
  }
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : ''
  if (typeof payload.archiveBase64 !== 'string' || payload.archiveBase64 === '') {
    throw new ClueError('invalid-request', '"archiveBase64" must be a non-empty base64 string')
  }
  const encoded = payload.archiveBase64
  // Buffer.from(..., 'base64') silently ignores invalid characters, so it can
  // never be relied on to reject input. Validate the alphabet/padding
  // explicitly and check the decoded bound BEFORE decoding, so a malformed or
  // oversized payload is reported as such instead of being parsed as a ZIP.
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ClueError('invalid-request', '"archiveBase64" is not valid base64')
  }
  if (Math.floor((encoded.length / 4) * 3) - 2 > maxBytes) {
    throw new ClueError(
      'invalid-request',
      `the archive is too large for the JSON clue API (limit ${maxBytes} bytes); use the raw import route`,
    )
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength === 0) {
    throw new ClueError('invalid-request', '"archiveBase64" decoded to an empty archive')
  }
  if (bytes.byteLength > maxBytes) {
    throw new ClueError(
      'invalid-request',
      `the archive is too large for the JSON clue API (${bytes.byteLength} bytes; limit ${maxBytes}); use the raw import route`,
    )
  }
  const remap = parseClueShareRemap(payload.remap)
  return {
    workspaceId,
    bytes,
    ...(remap === undefined ? {} : { remap }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  }
}

/**
 * Install the share service into one mount.
 *
 * Registers `clues.share.exportPreview` and `clues.share.importPreview` on the
 * S1 API seam (both JSON-only). The byte-carrying export/import operations
 * stay on the raw routes from {@link createCluesShareRoutes}, per the S7
 * integration contract.
 * @param ctx - plugin context (used for lifecycle only).
 * @param clues - the live clue service.
 * @param options - test seams and limits.
 */
export function installCluesShare(
  ctx: Context,
  clues: CluesService,
  options: InstallCluesShareOptions = {},
): CluesShareService {
  const service = createCluesShareService({
    clues,
    export: {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes: options.maxSnapshotBytes }),
      ...(options.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: options.maxArchiveBytes }),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
      ...(options.maxManifestBytes === undefined ? {} : { maxManifestBytes: options.maxManifestBytes }),
      ...(options.readFileBytes === undefined ? {} : { readFileBytes: options.readFileBytes }),
      ...(options.statFile === undefined ? {} : { statFile: options.statFile }),
    },
    import: {
      ...(options.zipLimits === undefined ? {} : { zipLimits: options.zipLimits }),
    },
  })
  const maxApiImportBytes = options.maxApiImportBytes ?? DEFAULT_MAX_API_IMPORT_BYTES
  const disposers = [
    clues.registerApi('clues.share.exportPreview', (payload, context) =>
      service.previewExport(exportParamsOf(payload, context.signal))),
    // The confirmation screen's "what exactly will be shared?" step. It calls
    // `portable` per live clue (never `read`) because spec §3 requires the
    // user to see the resource information before choosing the share scope.
    clues.registerApi('clues.share.exportInspect', (payload, context) =>
      service.inspectExport(exportParamsOf(payload, context.signal))),
    // Progress/outcome polling for the raw export route (S9). Bounded and
    // in-memory: an unknown or expired exportId reads as `null`.
    clues.registerApi('clues.share.exportProgress', (payload) => {
      if (!isRecord(payload) || typeof payload.exportId !== 'string' || payload.exportId.trim() === '') {
        throw new ClueError('invalid-request', '"exportId" must be a non-empty string')
      }
      return service.progress.read(payload.exportId) ?? null
    }),
    clues.registerApi('clues.share.importPreview', (payload, context) =>
      service.previewImport(importParamsOf(payload, context, maxApiImportBytes))),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    service.dispose()
  }, 'dsh-better-sidebar: clue share service')
  return service
}

/** Read a raw byte body with an explicit cap. */
async function readBinaryBody(req: SidebarHttpRequest, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.byteLength
    if (total > limit) {
      throw new SidebarError('too-large', `request body exceeds the ${limit} byte limit`, 413)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Percent-encode one RFC 5987 `ext-value` (the `filename*=UTF-8''…` form).
 *
 * `encodeURIComponent` leaves `!'()*` unescaped. RFC 5987's `attr-char`
 * excludes `'()*` (it allows `!` and `.`), so those three are escaped here;
 * the result is conformant, and an escaped `!` would also be legal. A pack
 * name with an apostrophe therefore no longer produces a non-conformant
 * header. `src/archive-route.ts` has the same encoder gap, but that file is
 * outside S7's write scope (EXEC-CONTRACTS §1) — the conformant helper lives
 * here until the integration owner converges both.
 */
function rfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** The `content-disposition` value of one cluepack download (RFC 5987). */
export function cluepackDisposition(fileName: string): string {
  // The file name derives from a pack name, which S1 accepts as arbitrary
  // text; an unpaired surrogate would make encodeURIComponent throw and turn
  // the download into a 500. Never hand the encoder ill-formed text.
  const wellFormed = wellFormedText(fileName)
  const ascii = [...wellFormed]
    .filter(char => {
      const code = char.codePointAt(0)!
      return code >= 0x20 && code <= 0x7e && char !== '"' && char !== '\\'
    })
    .join('')
  const fallback = /^\.*$/.test(ascii.replace(/\.cluepack$/i, '')) ? 'cluepack.cluepack' : ascii
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Value(wellFormed)}`
}

/** The request's workspace id (`?workspaceId=`), or a typed failure. */
function workspaceIdOf(req: SidebarHttpRequest): string {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const workspaceId = url.searchParams.get('workspaceId')
  if (workspaceId === null || workspaceId.trim() === '') {
    throw new SidebarError('bad-request', 'workspaceId is required')
  }
  return workspaceId
}

/**
 * The request's optional remap list (`?remap=<JSON>`).
 *
 * The import routes carry the archive as the RAW body, so their receiver
 * choices cannot be JSON fields of the same request. The query parameter is
 * the serializable seam S9 forwards from its confirmation UI; it is validated
 * by the same `parseClueShareRemap` the JSON API method uses.
 */
function remapOf(req: SidebarHttpRequest): ClueShareLocatorRemap[] | undefined {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const raw = url.searchParams.get('remap')
  if (raw === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new SidebarError('bad-request', '"remap" must be JSON')
  }
  return parseClueShareRemap(value)
}

/**
 * The caller's optional export progress id. It is the only key the client can
 * poll `clues.share.exportProgress` with, so it is bounded to an opaque,
 * header-safe alphabet instead of accepting arbitrary text.
 */
function exportIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.exportId === undefined) return undefined
  const exportId = payload.exportId
  if (typeof exportId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(exportId)) {
    throw new ClueError('invalid-request', '"exportId" must be 1..128 characters of [A-Za-z0-9._-]')
  }
  return exportId
}

/** Common guard of one POST-only, fenced route. */
function guard(req: SidebarHttpRequest, res: SidebarHttpResponse, fence: CluesShareFence): boolean {
  if (!fence(req)) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
    return false
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
    return false
  }
  return true
}

/**
 * A cancellation signal tied to the response connection.
 *
 * The plugin's structural HTTP faces expose no event API, so the runtime's
 * `once`/`off` are feature-detected: a real Node response aborts a long export
 * as soon as the client disconnects, while tests and fake responses simply
 * never abort. The signal is also forwarded into every export/import step.
 */
function cancellationOf(res: SidebarHttpResponse): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const emitter = res as {
    once?: (event: string, listener: () => void) => void
    off?: (event: string, listener: () => void) => void
  }
  const onClose = (): void => controller.abort()
  if (typeof emitter.once === 'function') emitter.once('close', onClose)
  return {
    signal: controller.signal,
    release: () => {
      if (typeof emitter.off === 'function') emitter.off('close', onClose)
    },
  }
}

/** Build the four raw route handlers. */
export function createCluesShareRoutes(
  share: CluesShareService,
  fence: CluesShareFence,
  options: CluesShareRouteOptions = {},
): CluesShareRouteHandlers {
  const maxImportBytes = options.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES
  const maxJsonBytes = options.maxJsonBytes ?? (1 << 20)
  const route = (
    path: string,
    handler: (req: SidebarHttpRequest, res: SidebarHttpResponse) => Promise<void>,
  ): SidebarWebRoute => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!guard(req, res, fence)) return
      try {
        await handler(req, res)
      } catch (error) {
        writeError(res, error)
      }
    },
  })

  const exportPreview = route(CLUES_SHARE_ROUTE_PATHS.exportPreview, async (req, res) => {
    const payload = await readJsonBody(req, maxJsonBytes)
    const { signal, release } = cancellationOf(res)
    try {
      writeOk(res, await share.previewExport(exportParamsOf(payload, signal)))
    } finally {
      release()
    }
  })

  const exportRoute = route(CLUES_SHARE_ROUTE_PATHS.export, async (req, res) => {
    const payload = await readJsonBody(req, maxJsonBytes)
    const exportId = exportIdOf(payload)
    const { signal, release } = cancellationOf(res)
    try {
      const result = await share.exportPack({
        ...exportParamsOf(payload, signal),
        ...(exportId === undefined ? {} : { onProgress: progress => share.progress.record(exportId, progress) }),
      })
      if (exportId !== undefined) share.progress.finish(exportId, result)
      // The ZIP body cannot carry progress or a "this pack is incomplete"
      // marker, and a browser download would otherwise look like a clean
      // success even when items failed (spec §4). The counters + the exact
      // issue list are exposed through `clues.share.exportProgress`; the
      // headers give a same-origin fetch a synchronous partial/complete flag.
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': cluepackDisposition(result.fileName),
        'cache-control': 'no-store',
        'content-length': String(result.bytes.byteLength),
        'x-cluepack-complete': result.complete ? 'true' : 'false',
        'x-cluepack-issues': String(result.issues.length),
        'x-cluepack-clues': String(result.stats.clues),
        'x-cluepack-packs': String(result.stats.packs),
        'x-cluepack-snapshots': String(result.stats.snapshots),
      })
      res.end(result.bytes)
    } catch (error) {
      if (exportId !== undefined) share.progress.fail(exportId, error)
      throw error
    } finally {
      release()
    }
  })

  const importPreview = route(CLUES_SHARE_ROUTE_PATHS.importPreview, async (req, res) => {
    const workspaceId = workspaceIdOf(req)
    const remap = remapOf(req)
    const bytes = await readBinaryBody(req, maxImportBytes)
    const { signal, release } = cancellationOf(res)
    try {
      writeOk(res, await share.previewImport({
        workspaceId,
        bytes,
        signal,
        ...(remap === undefined ? {} : { remap }),
      }))
    } finally {
      release()
    }
  })

  const importRoute = route(CLUES_SHARE_ROUTE_PATHS.import, async (req, res) => {
    const workspaceId = workspaceIdOf(req)
    const remap = remapOf(req)
    const bytes = await readBinaryBody(req, maxImportBytes)
    const { signal, release } = cancellationOf(res)
    try {
      writeOk(res, await share.importPack({
        workspaceId,
        bytes,
        signal,
        ...(remap === undefined ? {} : { remap }),
      }))
    } finally {
      release()
    }
  })

  return {
    exportPreview,
    export: exportRoute,
    importPreview,
    import: importRoute,
    routes: [exportPreview, exportRoute, importPreview, importRoute],
  }
}
