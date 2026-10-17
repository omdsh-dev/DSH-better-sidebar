/**
 * S7 integration surface: the `.cluepack` share service and the raw ZIP
 * route handlers S9 registers.
 *
 * Two layers:
 * - {@link installCluesShare} wires the export/import business service into
 *   one Cordis mount and registers the JSON-safe `clues.share.*` methods
 *   (`exportPreview`, `exportInspect`, `exportProgress`, `importPreview`,
 *   `importProgress`, `import`). {@link CluesShareService.dispose} releases
 *   the methods whether the mount effect runs or the caller disposes directly.
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
 *   `?remap=<encodeURIComponent(JSON.stringify(ClueShareLocatorRemap[]))>`,
 *   and an optional progress id as `?importId=<id>`. Both routes share the
 *   workspace/remap shape; only `import` records progress.
 *
 * The export route accepts an optional `exportId` in its JSON body. When one is
 * present, per-item progress and the terminal outcome (including a
 * `complete:false` partial issue list, e.g. a stale stored snapshot after a
 * failed live read) are readable from `clues.share.exportProgress`, and the ZIP
 * response carries the same complete/issue counters as `x-cluepack-*` headers —
 * a ZIP body alone cannot tell the client that the pack it is downloading is
 * incomplete. The raw import route mirrors this with `importId` and
 * `clues.share.importProgress`.
 *
 * The `clues.share.import` API method accepts a moderate archive as base64 plus
 * the remap list in the JSON body (no URL-length cap) and is meant for small
 * packs and automation; the raw routes remain the transfer path for real
 * archives (the generic JSON dispatcher caps bodies at 1 MiB).
 */
import type { Context, SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from '../../context-types.ts'
import type { CluesService } from '../service.ts'
import { ClueError, isClueError, type ClueApiContext, type ClueErrorCategory } from '../types.ts'
import { readJsonBody, SidebarError, writeError, writeJson, writeOk } from '../../wire.ts'
import { SAFE_FAILURE_REASONS } from './reasons.ts'
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
  type ClueShareImportProgress,
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
 * JSON API method names of this surface, for S9 wiring.
 *
 * S9 calls these through the generic typed clue API (`call('clues.share.*')`);
 * this module is node-only, so do NOT import these constants into a client
 * bundle. They exist so the raw-route registration, S9 and tests share one
 * spelling instead of duplicating string literals.
 */
export const CLUES_SHARE_API_METHODS = {
  exportPreview: 'clues.share.exportPreview',
  exportInspect: 'clues.share.exportInspect',
  exportProgress: 'clues.share.exportProgress',
  importPreview: 'clues.share.importPreview',
  importProgress: 'clues.share.importProgress',
  import: 'clues.share.import',
} as const

/** Prefix of S1 storage failures, whose raw message embeds a host path. */
const S1_STORE_MESSAGE = /^clue (?:storage|snapshot)/i

/**
 * Strip the host's absolute data path from one S1 storage failure.
 *
 * `CluesStore` wraps an fs error (or the state file path) into its message.
 * The share routes and the progress channels must not echo that to the
 * browser: the clue errors are surfaced by category elsewhere, so replacing
 * the message with the fixed category wording loses nothing actionable for a
 * client. Every other error (archive validation, conflict reasons, …) keeps
 * its own safe text.
 */
function safeShareErrorOf(error: unknown): unknown {
  if (isClueError(error) && S1_STORE_MESSAGE.test(error.message)) {
    return new ClueError(error.category, SAFE_FAILURE_REASONS[error.category])
  }
  return error
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

/** One tracked import as the S9 UI polls it (symmetric with the export status). */
export interface ClueShareImportStatus {
  readonly importId: string
  readonly updatedAt: string
  readonly phase: ClueShareImportProgress['phase']
  readonly completed: number
  readonly total: number
  readonly key?: string
  readonly status?: 'ok' | 'issue'
  readonly reason?: string
  readonly done: boolean
  /** Present when the import settled; `partial:true` requires explicit acceptance. */
  readonly outcome?: {
    readonly complete: boolean
    readonly partial: boolean
    readonly cancelled: boolean
    readonly requiresAcceptance: boolean
    readonly clues: number
    readonly packs: number
    readonly snapshots: number
    readonly issues: readonly CluepackIssue[]
    readonly manifestIssues: readonly CluepackIssue[]
    readonly reasons: readonly string[]
  }
  /** Present when the import failed or was cancelled before the first write. */
  readonly failure?: {
    readonly category: ClueErrorCategory
    readonly message: string
  }
}

/** Bounded, in-memory import progress channel shared by the routes and the API. */
export interface CluesShareImportProgressStore {
  record(importId: string, progress: ClueShareImportProgress): void
  finish(importId: string, result: ClueShareImportResult): void
  fail(importId: string, error: unknown): void
  read(importId: string): ClueShareImportStatus | undefined
  dispose(): void
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
 * Inner bounded map shared by both progress channels.
 *
 * Terminal entries expire after the TTL and are evicted oldest-first once the
 * map grows past its bound. ACTIVE entries (a request still in flight) are
 * never evicted or expired: AGENTS requires that a module-level Map keeps every
 * key with a live request, otherwise a client polling a long-running export
 * would lose the entry it is waiting for. The bound can therefore be exceeded
 * transiently by active entries, and the map drops back as soon as they settle.
 */
function createBoundedStatusStore<T>(options: {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
} = {}): {
  put(id: string, status: T, terminal: boolean): void
  read(id: string): T | undefined
  dispose(): void
} {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? EXPORT_PROGRESS_TTL_MS
  const maxEntries = options.maxEntries ?? MAX_TRACKED_EXPORTS
  const entries = new Map<string, { status: T; at: number; terminal: boolean }>()
  let disposed = false
  const prune = (): void => {
    const cutoff = now() - ttlMs
    for (const [id, entry] of entries) {
      if (entry.terminal && entry.at <= cutoff) entries.delete(id)
    }
    // Active keys are never evicted. Settled entries get the remaining
    // capacity, but always keep the newest outcome so a client that polls
    // right after completion can still read it even when more than
    // `maxEntries` requests are in flight.
    const terminals: string[] = []
    let active = 0
    for (const [id, entry] of entries) {
      if (entry.terminal) terminals.push(id)
      else active += 1
    }
    const allowedTerminal = Math.max(1, maxEntries - active)
    while (terminals.length > allowedTerminal) {
      const oldest = terminals.shift()!
      entries.delete(oldest)
    }
  }
  return {
    put(id, status, terminal) {
      if (disposed) return
      // Re-insert so Map iteration order really is "least recently written".
      entries.delete(id)
      entries.set(id, { status, at: now(), terminal })
      prune()
    },
    read(id) {
      if (disposed) return undefined
      prune()
      return entries.get(id)?.status
    },
    dispose() {
      disposed = true
      entries.clear()
    },
  }
}

/**
 * Create one bounded export progress store. Entries expire after a TTL and the
 * map never grows past `maxEntries` (oldest first), so a client that forgets
 * to poll cannot leak memory.
 * @param options - clock/TTL/bound seams (tests).
 */
export function createCluesShareExportProgressStore(options: {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
} = {}): CluesShareExportProgressStore {
  const now = options.now ?? (() => Date.now())
  const store = createBoundedStatusStore<ClueShareExportStatus>(options)
  const timestamp = (): string => new Date(now()).toISOString()
  return {
    record(exportId, progress) {
      store.put(exportId, {
        exportId,
        updatedAt: timestamp(),
        phase: progress.phase,
        completed: progress.completed,
        total: progress.total,
        ...(progress.key === undefined ? {} : { key: progress.key }),
        ...(progress.status === undefined ? {} : { status: progress.status }),
        ...(progress.reason === undefined ? {} : { reason: progress.reason }),
        done: progress.phase === 'done',
      }, progress.phase === 'done')
    },
    finish(exportId, result) {
      const previous = store.read(exportId)
      store.put(exportId, {
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
      }, true)
    },
    fail(exportId, error) {
      const previous = store.read(exportId)
      store.put(exportId, {
        exportId,
        updatedAt: timestamp(),
        phase: previous?.phase ?? 'collect',
        completed: previous?.completed ?? 0,
        total: previous?.total ?? 0,
        done: true,
        failure: isClueError(error)
          ? { category: error.category, message: error.message }
          : { category: 'failed', message: 'the clue pack export failed' },
      }, true)
    },
    read(exportId) {
      return store.read(exportId)
    },
    dispose() {
      store.dispose()
    },
  }
}

/**
 * Create one bounded import progress store (same eviction/TTL policy as export).
 * @param options - clock/TTL/bound seams (tests).
 */
export function createCluesShareImportProgressStore(options: {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
} = {}): CluesShareImportProgressStore {
  const now = options.now ?? (() => Date.now())
  const store = createBoundedStatusStore<ClueShareImportStatus>(options)
  const timestamp = (): string => new Date(now()).toISOString()
  return {
    record(importId, progress) {
      store.put(importId, {
        importId,
        updatedAt: timestamp(),
        phase: progress.phase,
        completed: progress.completed,
        total: progress.total,
        ...(progress.key === undefined ? {} : { key: progress.key }),
        ...(progress.status === undefined ? {} : { status: progress.status }),
        ...(progress.reason === undefined ? {} : { reason: progress.reason }),
        done: progress.phase === 'done',
      }, progress.phase === 'done')
    },
    finish(importId, result) {
      const previous = store.read(importId)
      store.put(importId, {
        importId,
        updatedAt: timestamp(),
        phase: 'done',
        completed: previous?.completed ?? 0,
        total: previous?.total ?? 0,
        done: true,
        outcome: {
          complete: result.complete,
          partial: result.partial,
          cancelled: result.cancelled,
          requiresAcceptance: result.requiresAcceptance,
          clues: result.clues.length,
          packs: result.packs.length,
          snapshots: result.snapshots.length,
          issues: result.issues,
          manifestIssues: result.manifestIssues,
          reasons: result.reasons,
        },
      }, true)
    },
    fail(importId, error) {
      const previous = store.read(importId)
      store.put(importId, {
        importId,
        updatedAt: timestamp(),
        phase: previous?.phase ?? 'validate',
        completed: previous?.completed ?? 0,
        total: previous?.total ?? 0,
        done: true,
        failure: isClueError(error)
          ? { category: error.category, message: error.message }
          : { category: 'failed', message: 'the clue pack import failed' },
      }, true)
    },
    read(importId) {
      return store.read(importId)
    },
    dispose() {
      store.dispose()
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
  /** Progress channel of the raw import route (bounded, in-memory). */
  readonly importProgress: CluesShareImportProgressStore
  /** Releases registered API methods and progress; persisted clue data is untouched. */
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

/** Optional lifecycle hook of {@link createCluesShareService} (API disposers). */
export interface CreateCluesShareServiceOptions {
  /** Runs once when the service is disposed (releases registered API methods). */
  readonly onDispose?: () => void
}

/** Create the business service without installing it (tests/S9 seams). */
export function createCluesShareService(
  deps: ClueShareServiceDeps,
  options: CreateCluesShareServiceOptions = {},
): CluesShareService {
  const exportDeps: ClueShareExportDeps = { clues: deps.clues, ...deps.export }
  const importDeps: ClueShareImportDeps = { clues: deps.clues, ...deps.import }
  const progress = createCluesShareExportProgressStore()
  const importProgress = createCluesShareImportProgressStore()
  let disposed = false
  const ensureLive = (): void => {
    if (disposed) throw new ClueError('failed', 'the clue share service is no longer mounted')
  }
  /**
   * One business call with the S1 storage message sanitized. S1 embeds the
   * host's absolute data path in its storage errors, and every caller here
   * (routes, progress channels, the JSON API dispatcher) would otherwise echo
   * that path to the browser.
   */
  const guarded = <T>(run: Promise<T>): Promise<T> =>
    run.catch((error: unknown) => { throw safeShareErrorOf(error) })
  return {
    previewExport(params) {
      ensureLive()
      return guarded(runPreviewExport(exportDeps, params))
    },
    inspectExport(params) {
      ensureLive()
      return guarded(runInspectExport(exportDeps, params))
    },
    exportPack(params) {
      ensureLive()
      return guarded(runExportPack(exportDeps, params))
    },
    previewImport(params) {
      ensureLive()
      return guarded(runPreviewImport(importDeps, params))
    },
    importPack(params) {
      ensureLive()
      return guarded(runImportPack(importDeps, params))
    },
    progress,
    importProgress,
    dispose() {
      if (disposed) return
      disposed = true
      options.onDispose?.()
      progress.dispose()
      importProgress.dispose()
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
 * Registers the JSON-safe `clues.share.*` methods on the S1 API seam:
 * previews/inspection/progress plus the moderate-archive JSON import. The
 * byte-carrying export and raw ZIP import stay on the routes from
 * {@link createCluesShareRoutes}, per the S7 integration contract.
 * @param ctx - plugin context (used for lifecycle only).
 * @param clues - the live clue service.
 * @param options - test seams and limits.
 */
export function installCluesShare(
  ctx: Context,
  clues: CluesService,
  options: InstallCluesShareOptions = {},
): CluesShareService {
  const registeredDisposers: Array<() => void> = []
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
  }, { onDispose: () => { for (const dispose of registeredDisposers.splice(0)) dispose() } })
  const maxApiImportBytes = options.maxApiImportBytes ?? DEFAULT_MAX_API_IMPORT_BYTES
  /** Record an import's progress/outcome under the caller's JSON-safe id. */
  const trackImport = (
    importId: string | undefined,
    run: (onProgress?: (progress: ClueShareImportProgress) => void) => Promise<ClueShareImportResult>,
  ): Promise<ClueShareImportResult> => {
    if (importId === undefined) return run()
    return run(progress => service.importProgress.record(importId, progress)).then(
      (result) => {
        service.importProgress.finish(importId, result)
        return result
      },
      (error: unknown) => {
        service.importProgress.fail(importId, error)
        throw error
      },
    )
  }
  registeredDisposers.push(
    clues.registerApi(CLUES_SHARE_API_METHODS.exportPreview, (payload, context) =>
      service.previewExport(exportParamsOf(payload, context.signal))),
    // The confirmation screen's "what exactly will be shared?" step. It calls
    // `portable` per live clue (never `read`) because spec §3 requires the
    // user to see the resource information before choosing the share scope.
    clues.registerApi(CLUES_SHARE_API_METHODS.exportInspect, (payload, context) =>
      service.inspectExport(exportParamsOf(payload, context.signal))),
    // Progress/outcome polling for the raw export route (S9). Bounded and
    // in-memory: an unknown or expired exportId reads as `null`.
    clues.registerApi(CLUES_SHARE_API_METHODS.exportProgress, (payload) => {
      if (!isRecord(payload) || typeof payload.exportId !== 'string' || payload.exportId.trim() === '') {
        throw new ClueError('invalid-request', '"exportId" must be a non-empty string')
      }
      return service.progress.read(payload.exportId) ?? null
    }),
    clues.registerApi(CLUES_SHARE_API_METHODS.importPreview, (payload, context) =>
      service.previewImport(importParamsOf(payload, context, maxApiImportBytes))),
    // JSON import for a moderate archive: unlike the raw route, the receiver
    // remap list travels in the BODY, so it is not capped by the URL length.
    clues.registerApi(CLUES_SHARE_API_METHODS.import, async (payload, context) => {
      const params = importParamsOf(payload, context, maxApiImportBytes)
      const importId = importIdOf(isRecord(payload) ? payload.importId : undefined)
      return trackImport(importId, onProgress => service.importPack({
        ...params,
        ...(onProgress === undefined ? {} : { onProgress }),
      }))
    }),
    // Progress/outcome polling for the raw import route (symmetric with
    // exportProgress): a long import must be observable and cancellable.
    clues.registerApi(CLUES_SHARE_API_METHODS.importProgress, (payload) => {
      const importId = importIdOf(isRecord(payload) ? payload.importId : undefined)
      if (importId === undefined) {
        throw new ClueError('invalid-request', '"importId" must be a non-empty string')
      }
      return service.importProgress.read(importId) ?? null
    }),
  )
  ctx.effect(() => () => service.dispose(), 'dsh-better-sidebar: clue share service')
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

/**
 * The caller's optional import progress id (JSON body field or raw-route query).
 * Same bounded alphabet as `exportId`, for the same reason.
 */
function importIdOf(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new ClueError('invalid-request', '"importId" must be 1..128 characters of [A-Za-z0-9._-]')
  }
  return value
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

/** Refuse a request whose connection closed while its body was still arriving. */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ClueError('cancelled', 'the request was cancelled before the body was fully read')
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
    const { signal, release } = cancellationOf(res)
    try {
      const payload = await readJsonBody(req, maxJsonBytes)
      throwIfCancelled(signal)
      writeOk(res, await share.previewExport(exportParamsOf(payload, signal)))
    } finally {
      release()
    }
  })

  const exportRoute = route(CLUES_SHARE_ROUTE_PATHS.export, async (req, res) => {
    const { signal, release } = cancellationOf(res)
    let exportId: string | undefined
    try {
      const payload = await readJsonBody(req, maxJsonBytes)
      throwIfCancelled(signal)
      const progressId = exportIdOf(payload)
      exportId = progressId
      const result = await share.exportPack({
        ...exportParamsOf(payload, signal),
        ...(progressId === undefined ? {} : { onProgress: progress => share.progress.record(progressId, progress) }),
      })
      if (progressId !== undefined) share.progress.finish(progressId, result)
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
    const { signal, release } = cancellationOf(res)
    try {
      const workspaceId = workspaceIdOf(req)
      const remap = remapOf(req)
      const bytes = await readBinaryBody(req, maxImportBytes)
      throwIfCancelled(signal)
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
    const { signal, release } = cancellationOf(res)
    let importId: string | undefined
    try {
      const workspaceId = workspaceIdOf(req)
      const remap = remapOf(req)
      const progressId = importIdOf(new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('importId') ?? undefined)
      importId = progressId
      const bytes = await readBinaryBody(req, maxImportBytes)
      throwIfCancelled(signal)
      const result = await share.importPack({
        workspaceId,
        bytes,
        signal,
        ...(remap === undefined ? {} : { remap }),
        ...(progressId === undefined ? {} : { onProgress: progress => share.importProgress.record(progressId, progress) }),
      })
      if (progressId !== undefined) share.importProgress.finish(progressId, result)
      writeOk(res, result)
    } catch (error) {
      if (importId !== undefined) share.importProgress.fail(importId, error)
      throw error
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
