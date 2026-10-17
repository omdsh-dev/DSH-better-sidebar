/**
 * Client side of the `.cluepack` share surface (S9).
 *
 * The export/import BUSINESS service is node-only (it reads snapshots and
 * zips bytes on the host). The browser half therefore never imports that
 * module: it calls the generic JSON methods through the plugin's ONE
 * `/sidebar/api` transport and posts the byte-carrying export/import to the
 * four raw routes, exactly like the file/archive routes.
 *
 * Why the split:
 * - previews/inspection/progress are small JSON documents (`clues.share.*`);
 * - the archive itself is raw bytes: the browser hands the `File`/`Blob`
 *   straight into the request body (no base64 inflation) and receives the ZIP
 *   as a stream, then downloads it;
 * - progress is an explicit poll while a request is in flight — no background
 *   timer survives the operation, and an abort clears it.
 *
 * Nothing here executes an import, accesses a source, or reads a credential:
 * the host owns all of that; this module only moves bytes and reports state.
 */
import { call } from '../api.ts'
import { hostRouteUrl } from '../host-route-url.ts'

/** The two archive modes (mirrors the S7 protocol; no node import). */
export type CluepackMode = 'snapshot' | 'reference'

/** One preview row shown on the export confirmation screen. */
export interface ShareExportItemPreview {
  readonly clueId: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  readonly unresolved?: string
  readonly snapshotMode: boolean
}

/** `clues.share.exportPreview` result (metadata only). */
export interface ShareExportPreview {
  readonly mode: CluepackMode
  readonly fileName: string
  readonly items: readonly ShareExportItemPreview[]
  readonly packs: readonly { readonly packId: string; readonly name: string; readonly members: number }[]
  readonly warnings: readonly string[]
  readonly totals: { readonly clues: number; readonly packs: number; readonly sources: number }
}

/** One portable-reference row of the export confirmation. */
export interface ShareExportSharedItem {
  readonly clueId: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  readonly portable: { readonly portable: boolean; readonly reason?: string }
  readonly unresolved?: string
  readonly snapshotMode: boolean
}

/** `clues.share.exportInspect` result. */
export interface ShareExportInspection {
  readonly mode: CluepackMode
  readonly fileName: string
  readonly items: readonly ShareExportSharedItem[]
  readonly warnings: readonly string[]
}

/** One import confirmation row. */
export interface ShareImportItemPreview {
  readonly key: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  readonly portable: boolean
  readonly snapshot: boolean
  readonly snapshotFetchedAt?: string
  readonly willBeUnresolved: boolean
  readonly unresolvedReason?: string
}

/** `import-preview` route result. */
export interface ShareImportPreview {
  readonly workspaceId: string
  readonly mode: CluepackMode
  readonly exportedAt: string
  readonly packNames: readonly string[]
  readonly packs: readonly { readonly key: string; readonly name: string; readonly members: number }[]
  readonly items: readonly ShareImportItemPreview[]
  readonly missingSources: readonly string[]
  readonly snapshotCount: number
  readonly unresolvedCount: number
  readonly warnings: readonly string[]
}

/** One import summary. */
export interface ShareImportResult {
  readonly workspaceId: string
  readonly mode: CluepackMode
  readonly clues: readonly { readonly clueId: string; readonly title: string; readonly unresolved: boolean }[]
  readonly packs: readonly { readonly packId: string; readonly name: string; readonly members: number }[]
  readonly snapshots: readonly { readonly snapshotId: string; readonly clueKey: string }[]
  readonly complete: boolean
  readonly partial: boolean
  readonly cancelled: boolean
  readonly requiresAcceptance: boolean
  readonly reasons: readonly string[]
}

/** One progress frame of either direction. */
export interface ShareProgress {
  readonly phase: string
  readonly completed: number
  readonly total: number
}

/** Result of one archive export (the raw download + its completeness). */
export interface ShareExportResult {
  readonly blob: Blob
  readonly fileName: string
  readonly complete: boolean
  readonly issues: number
}

/** Route paths (single spelling with S7's exported constant). */
export const SHARE_ROUTE_PATHS = {
  exportPreview: '/sidebar/clues/share/export-preview',
  export: '/sidebar/clues/share/export',
  importPreview: '/sidebar/clues/share/import-preview',
  import: '/sidebar/clues/share/import',
} as const

/** A bounded, opaque operation id for progress polling. */
function operationId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`
}

/** Fetch one raw route and unwrap the JSON envelope (errors carry wire codes). */
async function rawJson<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(hostRouteUrl(path.slice(1)).href, init)
  } catch (error) {
    throw new ShareClientError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed = await response.json().catch(() => null) as
    | { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
    | null
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new ShareClientError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** One typed share failure (the wire code stays available to the UI). */
export class ShareClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ShareClientError'
  }
}

/** Poll one progress channel while an operation is in flight (bounded). */
function pollProgress(
  method: 'clues.share.exportProgress' | 'clues.share.importProgress',
  payload: Record<string, unknown>,
  onProgress: ((progress: ShareProgress) => void) | undefined,
  isDone: () => boolean,
): () => void {
  if (onProgress === undefined) return () => undefined
  let stopped = false
  let timer: number | undefined
  const tick = (): void => {
    if (stopped || isDone()) return
    void call<ShareProgress | null>(method, payload).then((progress) => {
      if (stopped || progress === null) return
      onProgress(progress)
    }).catch(() => { /* progress is observability only */ }).finally(() => {
      if (!stopped && !isDone()) timer = window.setTimeout(tick, 500)
    })
  }
  tick()
  return () => {
    stopped = true
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

/** Preview one export without touching any source. */
export function previewShareExport(input: {
  readonly workspaceId: string
  readonly mode: CluepackMode
  readonly packIds: readonly string[]
  readonly signal?: AbortSignal
}): Promise<ShareExportPreview> {
  return call<ShareExportPreview>('clues.share.exportPreview', {
    workspaceId: input.workspaceId,
    mode: input.mode,
    packIds: [...input.packIds],
  }, input.signal)
}

/** Resolve the exact portable references the archive would carry. */
export function inspectShareExport(input: {
  readonly workspaceId: string
  readonly mode: CluepackMode
  readonly packIds: readonly string[]
  readonly signal?: AbortSignal
}): Promise<ShareExportInspection> {
  return call<ShareExportInspection>('clues.share.exportInspect', {
    workspaceId: input.workspaceId,
    mode: input.mode,
    packIds: [...input.packIds],
  }, input.signal)
}

/** The download name of a `content-disposition` header (best effort). */
function fileNameOf(disposition: string | null, fallback: string): string {
  if (disposition === null) return fallback
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (encoded?.[1] !== undefined) {
    try {
      return decodeURIComponent(encoded[1])
    } catch {
      return fallback
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain?.[1] ?? fallback
}

/**
 * Export the selected packs and hand back the ZIP as a Blob.
 * @param input - workspace, mode, packs and the progress/cancel seams.
 */
export async function exportShareArchive(input: {
  readonly workspaceId: string
  readonly mode: CluepackMode
  readonly packIds: readonly string[]
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ShareProgress) => void
}): Promise<ShareExportResult> {
  const exportId = operationId('export')
  let done = false
  const stop = pollProgress('clues.share.exportProgress', { exportId }, input.onProgress, () => done)
  try {
    const response = await fetch(hostRouteUrl(SHARE_ROUTE_PATHS.export.slice(1)).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        mode: input.mode,
        packIds: [...input.packIds],
        exportId,
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (!response.ok) {
      const parsed = await response.json().catch(() => null) as
        | { error?: { code?: string; message?: string } }
        | null
      throw new ShareClientError(
        parsed?.error?.code ?? 'http',
        parsed?.error?.message ?? `HTTP ${response.status}`,
      )
    }
    const blob = await response.blob()
    return {
      blob,
      fileName: fileNameOf(response.headers.get('content-disposition'), 'clues.cluepack'),
      complete: response.headers.get('x-cluepack-complete') !== 'false',
      issues: Number(response.headers.get('x-cluepack-issues') ?? '0') || 0,
    }
  } catch (error) {
    if (error instanceof ShareClientError) throw error
    if ((error as { name?: string } | undefined)?.name === 'AbortError') throw error
    throw new ShareClientError('network', error instanceof Error ? error.message : String(error))
  } finally {
    done = true
    stop()
  }
}

/** Save one exported archive through a temporary object URL. */
export function downloadShareArchive(result: ShareExportResult): void {
  const url = URL.createObjectURL(result.blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = result.fileName
    anchor.rel = 'noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // The click reads the URL synchronously; revoke on the next turn so the
    // download has definitely started.
    window.setTimeout(() => { URL.revokeObjectURL(url) }, 1_000)
  }
}

/** Preview one archive (raw bytes go straight into the body). */
export function previewShareImport(input: {
  readonly workspaceId: string
  readonly bytes: Uint8Array
  readonly signal?: AbortSignal
}): Promise<ShareImportPreview> {
  const query = new URLSearchParams({ workspaceId: input.workspaceId })
  return rawJson<ShareImportPreview>(`${SHARE_ROUTE_PATHS.importPreview}?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: input.bytes as unknown as BodyInit,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
}

/**
 * Import one archive.
 * @param input - workspace, bytes and the progress/cancel seams.
 */
export async function importShareArchive(input: {
  readonly workspaceId: string
  readonly bytes: Uint8Array
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ShareProgress) => void
}): Promise<ShareImportResult> {
  const importId = operationId('import')
  const query = new URLSearchParams({ workspaceId: input.workspaceId, importId })
  let done = false
  const stop = pollProgress('clues.share.importProgress', { importId }, input.onProgress, () => done)
  try {
    return await rawJson<ShareImportResult>(`${SHARE_ROUTE_PATHS.import}?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: input.bytes as unknown as BodyInit,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } finally {
    done = true
    stop()
  }
}
