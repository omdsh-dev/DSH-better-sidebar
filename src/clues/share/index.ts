/**
 * S7 integration surface: the `.cluepack` share service and the raw ZIP
 * route handlers S9 registers.
 *
 * Two layers:
 * - {@link installCluesShare} wires the export/import business service into
 *   one Cordis mount, registers the JSON-safe `clues.share.*` preview methods
 *   on the S1 service seam, and releases everything through `ctx.effect`.
 * - {@link createCluesShareRoutes} returns the four raw HTTP handlers. They
 *   carry archive bytes (never JSON-encoded bodies), enforce the fence and a
 *   request-size cap, and forward a cancellation signal derived from the
 *   response connection. S9 mounts each route with `ctx.webServer.register`.
 *
 * Route table (all exact paths, POST only):
 * ```
 * /sidebar/clues/share/export-preview   JSON  → JSON export preview
 * /sidebar/clues/share/export           JSON  → application/zip (download)
 * /sidebar/clues/share/import-preview   ZIP   → JSON import preview
 * /sidebar/clues/share/import           ZIP   → JSON import result
 * ```
 *
 * The export/import transfer operations are deliberately NOT JSON API
 * methods: a clue pack is a file, and base64-in-JSON would inflate it and
 * force the whole archive through the generic 1 MiB body parser.
 */
import type { Context, SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from '../../context-types.ts'
import type { CluesService } from '../service.ts'
import { ClueError, type ClueApiContext } from '../types.ts'
import { readJsonBody, SidebarError, writeError, writeJson, writeOk } from '../../wire.ts'
import {
  exportPack as runExportPack,
  previewExport as runPreviewExport,
  type ClueShareExportDeps,
  type ClueShareExportParams,
  type ClueShareExportPreview,
  type ClueShareExportResult,
} from './export.ts'
import {
  importPack as runImportPack,
  previewImport as runPreviewImport,
  type ClueShareImportDeps,
  type ClueShareImportParams,
  type ClueShareImportPreview,
  type ClueShareImportResult,
} from './import.ts'
import { DEFAULT_ZIP_LIMITS, type ZipReadLimits } from './zip.ts'

export * from './zip.ts'
export * from './manifest.ts'
export * from './export.ts'
export * from './import.ts'

/** Default maximum archive accepted by the raw import routes. */
export const DEFAULT_MAX_IMPORT_BYTES = DEFAULT_ZIP_LIMITS.maxArchiveBytes
/** Default maximum decoded archive accepted by the `clues.share.importPreview` API. */
export const DEFAULT_MAX_API_IMPORT_BYTES = 8 * 1024 * 1024

/** Options of {@link installCluesShare} (test seams + limits). */
export interface InstallCluesShareOptions {
  readonly now?: () => string
  readonly zipLimits?: Partial<ZipReadLimits>
  readonly maxSnapshotBytes?: number
  readonly maxArchiveBytes?: number
  readonly readFileBytes?: (path: string) => Promise<Uint8Array>
  readonly statSize?: (path: string) => Promise<number>
  /** Decoded archive bound of the `clues.share.importPreview` API method. */
  readonly maxApiImportBytes?: number
}

/** The share business service returned by {@link installCluesShare}. */
export interface CluesShareService {
  previewExport(params: ClueShareExportParams): Promise<ClueShareExportPreview>
  exportPack(params: ClueShareExportParams): Promise<ClueShareExportResult>
  previewImport(params: ClueShareImportParams): Promise<ClueShareImportPreview>
  importPack(params: ClueShareImportParams): Promise<ClueShareImportResult>
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
  /** Maximum archive body accepted by the import routes. */
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
  let disposed = false
  const ensureLive = (): void => {
    if (disposed) throw new ClueError('failed', 'the clue share service is no longer mounted')
  }
  return {
    previewExport(params) {
      ensureLive()
      return runPreviewExport(exportDeps, params)
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
    dispose() {
      disposed = true
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
  let bytes: Buffer
  try {
    bytes = Buffer.from(payload.archiveBase64, 'base64')
  } catch {
    throw new ClueError('invalid-request', '"archiveBase64" is not valid base64')
  }
  if (bytes.byteLength === 0) {
    throw new ClueError('invalid-request', '"archiveBase64" decoded to an empty archive')
  }
  if (bytes.byteLength > maxBytes) {
    throw new ClueError(
      'invalid-request',
      `the archive is too large for the JSON clue API (${bytes.byteLength} bytes; limit ${maxBytes}); use the raw import route`,
    )
  }
  return {
    workspaceId,
    bytes,
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
      ...(options.readFileBytes === undefined ? {} : { readFileBytes: options.readFileBytes }),
      ...(options.statSize === undefined ? {} : { statSize: options.statSize }),
    },
    import: {
      ...(options.zipLimits === undefined ? {} : { zipLimits: options.zipLimits }),
    },
  })
  const maxApiImportBytes = options.maxApiImportBytes ?? DEFAULT_MAX_API_IMPORT_BYTES
  const disposers = [
    clues.registerApi('clues.share.exportPreview', (payload, context) =>
      service.previewExport(exportParamsOf(payload, context.signal))),
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

/** The `content-disposition` value of one cluepack download (RFC 5987). */
export function cluepackDisposition(fileName: string): string {
  const ascii = [...fileName]
    .filter(char => {
      const code = char.codePointAt(0)!
      return code >= 0x20 && code <= 0x7e && char !== '"' && char !== '\\'
    })
    .join('')
  const fallback = /^\.*$/.test(ascii.replace(/\.cluepack$/i, '')) ? 'cluepack.cluepack' : ascii
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
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
    const { signal, release } = cancellationOf(res)
    try {
      const result = await share.exportPack(exportParamsOf(payload, signal))
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': cluepackDisposition(result.fileName),
        'cache-control': 'no-store',
      })
      res.end(result.bytes)
    } finally {
      release()
    }
  })

  const importPreview = route(CLUES_SHARE_ROUTE_PATHS.importPreview, async (req, res) => {
    const workspaceId = workspaceIdOf(req)
    const bytes = await readBinaryBody(req, maxImportBytes)
    const { signal, release } = cancellationOf(res)
    try {
      writeOk(res, await share.previewImport({ workspaceId, bytes, signal }))
    } finally {
      release()
    }
  })

  const importRoute = route(CLUES_SHARE_ROUTE_PATHS.import, async (req, res) => {
    const workspaceId = workspaceIdOf(req)
    const bytes = await readBinaryBody(req, maxImportBytes)
    const { signal, release } = cancellationOf(res)
    try {
      writeOk(res, await share.importPack({ workspaceId, bytes, signal }))
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
