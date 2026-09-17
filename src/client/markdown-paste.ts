/**
 * Markdown editor paste-image helpers: turn a clipboard image into a unique
 * filename under the configured Obsidian image directory and an embed
 * token `![[name.ext]]` for insertion at the cursor. Pure (no CodeMirror /
 * network) so unit tests cover naming and clipboard extraction without a
 * browser editor.
 */

/** MIME → file extension for clipboard image blobs (unknown → png). */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

/** Map a clipboard image MIME type to a file extension (default `png`). */
export function extensionForImageMime(mime: string): string {
  const key = mime.trim().toLowerCase()
  return MIME_EXT[key] ?? 'png'
}

/**
 * Build a collision-resistant filename `pasted-YYYYMMDD-HHMMSS.ext`. When
 * `suffix` is set (same-second pastes), it is appended before the extension
 * as `-N`.
 */
export function pastedImageFileName(now: Date, ext: string, suffix?: number): string {
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  const stamp = `${y}${mo}${d}-${h}${mi}${s}`
  const mid = suffix !== undefined && suffix > 0 ? `-${suffix}` : ''
  return `pasted-${stamp}${mid}.${ext}`
}

/** Obsidian-style image embed token inserted into the markdown source. */
export function obsidianImageEmbed(fileName: string): string {
  return `![[${fileName}]]`
}

/** One clipboard image ready to upload (blob + suggested filename). */
export interface ClipboardImage {
  blob: Blob
  fileName: string
}

/**
 * Pick the first `image/*` item from a paste `DataTransfer`. Prefers
 * `items` (typed clipboard entries) over `files`. Returns undefined when
 * the clipboard has no image (plain text paste should proceed normally).
 *
 * @param data - The paste event's `clipboardData` (may be null).
 * @param now - Clock for the generated filename (injectable in tests).
 * @param suffix - Optional same-second collision counter.
 */
export function clipboardImageOf(
  data: DataTransfer | null | undefined,
  now: Date = new Date(),
  suffix?: number,
): ClipboardImage | undefined {
  if (data === null || data === undefined) return undefined

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const blob = item.getAsFile()
    if (blob === null) continue
    const ext = extensionForImageMime(item.type || blob.type)
    return { blob, fileName: pastedImageFileName(now, ext, suffix) }
  }

  for (const file of Array.from(data.files ?? [])) {
    if (!file.type.startsWith('image/')) continue
    const ext = extensionForImageMime(file.type)
    return { blob: file, fileName: pastedImageFileName(now, ext, suffix) }
  }

  return undefined
}
