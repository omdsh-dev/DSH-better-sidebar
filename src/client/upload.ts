/**
 * File-upload plumbing for the files window: turn a file picker or a drag-drop
 * into per-file base64 uploads through the sidebar's `/sidebar/upload` route.
 *
 * A dropped folder arrives as `File` objects with `webkitRelativePath` filled
 * (Chromium), so the relative path is preserved for every nested file and the
 * host recreates the tree under the chosen directory. Uploads run sequentially
 * so one slow file cannot starve the others; each result reports its own
 * outcome (the tree keeps going after a failure).
 */
import { api } from './api.ts'
import type { SessionScope } from './api.ts'
import type { CopyKey } from './locales.ts'

/** One pending file: the browser File plus the workspace-relative target path. */
export interface UploadItem {
  file: File
  relativePath: string
}

/** One settled upload. */
export interface UploadResult {
  relativePath: string
  ok: boolean
  path?: string
  error?: string
}

/** Bytes -> base64 without relying on any global btoa semantics (the host
 *  half's btoa is UTF-8-flavored; the page's is Latin-1 — this is neither). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const enc = (n: number): string => CH.charAt((n >> 18) & 63) + CH.charAt((n >> 12) & 63) + CH.charAt((n >> 6) & 63) + CH.charAt(n & 63)
  let out = ''
  const len = bytes.length
  let i = 0
  for (; i + 2 < len; i += 3) {
    out += enc(((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0))
  }
  const rem = len - i
  if (rem === 1) {
    out += CH.charAt((bytes[i] ?? 0) >> 2) + CH.charAt(((bytes[i] ?? 0) & 3) << 4) + '=='
  } else if (rem === 2) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1] ?? 0
    out += CH.charAt(b0 >> 2) + CH.charAt(((b0 & 3) << 4) | (b1 >> 4)) + CH.charAt((b1 & 15) << 2) + '='
  }
  return out
}

function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer().then((ab) => new Uint8Array(ab))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsArrayBuffer(file)
  })
}

/** Sanitize a relative target: strip leading slashes, reject traversal. */
function relativePathOf(file: File): string | undefined {
  const rel = (file.webkitRelativePath || file.name || '').replace(/^\/+/, '')
  if (rel === '' || rel.split(/[\\/]+/).some((s) => s === '.' || s === '..' || s === '')) return undefined
  return rel
}

/** Collect a picker selection (webkitdirectory folders carry relative paths). */
export function uploadItemsFromFiles(files: FileList | readonly File[]): UploadItem[] {
  const items: UploadItem[] = []
  for (const file of files) {
    const rel = relativePathOf(file)
    if (rel !== undefined) items.push({ file, relativePath: rel })
  }
  return items
}

/** Collect a drag-drop payload (files only; folder entries keep their paths). */
export function uploadItemsFromDrop(data: DataTransfer | undefined): UploadItem[] {
  if (data === undefined || data.files.length === 0) return []
  return uploadItemsFromFiles(data.files)
}

/** The host-side cap mirrors the route's guard: ~48MB of payload. */
export const MAX_UPLOAD_BYTES = 48 * 1024 * 1024

/**
 * Upload every item into `dir` (absolute, inside the session workspace),
 * sequentially, reporting progress as `(done, total, currentRelativePath)`.
 * Resolves with one result per item — never rejects.
 */
export async function uploadToDir(
  scope: SessionScope,
  dir: string,
  items: UploadItem[],
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<UploadResult[]> {
  const results: UploadResult[] = []
  let done = 0
  for (const item of items) {
    onProgress?.(done, items.length, item.relativePath)
    try {
      const bytes = await readFileBytes(item.file)
      if (bytes.length > MAX_UPLOAD_BYTES) {
        results.push({ relativePath: item.relativePath, ok: false, error: 'file-too-large' })
      } else {
        const res = await api.uploadFile(scope, dir, item.relativePath, bytesToBase64(bytes))
        results.push({ relativePath: item.relativePath, ok: true, path: res.path })
      }
    } catch (error) {
      results.push({
        relativePath: item.relativePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    done++
  }
  onProgress?.(done, items.length, '')
  return results
}

/** Fold a result list into a one-line status for the tree hint. */
export function summarizeResults(
  results: UploadResult[],
  t: (key: CopyKey, params?: Record<string, string | number>) => string,
): string {
  const okCount = results.filter((r) => r.ok).length
  const failed = results.find((r) => !r.ok)
  if (failed !== undefined) {
    const detail = failed.error === 'file-too-large' ? t('uploadTooLarge') : (failed.error ?? t('uploadFailedUnknown'))
    return t('uploadFailed', { error: detail })
  }
  return t('uploadDone', { count: okCount })
}
