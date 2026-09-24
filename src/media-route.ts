/**
 * Pure helpers for the `/sidebar/file` media route: extension → content
 * type (image / PDF / HTML / video), the video extension set that unlocks the
 * streaming cap, and HTTP byte-range parsing.
 *
 * Video is why the route grew byte ranges at all: a browser's `<video>`
 * element only enables scrubbing (and, on some engines, playback) when the
 * server answers `Range` with `206 Partial Content`, and a clip is routinely
 * far larger than the image-oriented `mediaLimit`. The route therefore
 * streams video (and any other media) with `createReadStream` and answers
 * ranges; these helpers carry the decision logic so the byte-range contract
 * stays unit-testable without a live server (see tests/media-route.spec.ts).
 */
import { extname } from 'node:path'

/** Content types for the media route, by extension (video last). */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.m2ts': 'video/mp2t',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
}

/**
 * The extensions the media route treats as video: they get the streaming
 * (byte-range) treatment and the larger `videoLimit` cap instead of
 * `mediaLimit`. Container support is the browser's business — a codec the
 * engine cannot decode still renders the viewer's fallback, which is why
 * exotic containers are listed rather than filtered.
 */
export const VIDEO_EXTENSIONS: readonly string[] = [
  '.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov', '.qt', '.mkv',
  '.avi', '.wmv', '.flv', '.m2ts', '.mpeg', '.mpg', '.3gp', '.3g2',
]

/** True when the path's extension is one the media route streams as video. */
export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.includes(extname(path).toLowerCase())
}

/** Content type served by /sidebar/file (binary-safe fallback for unknowns). */
export function mediaTypeForPath(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * First value of a request header Node may have folded into an array
 * (duplicate `Range`/`If-Range` lines) — `undefined` when absent.
 */
export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** One inclusive byte range of a resource. */export interface ByteRange {
  /** First byte of the slice. */
  start: number
  /** Last byte of the slice (inclusive). */
  end: number
}

/** What one `Range` header means for a resource of a known size. */
export type RangeResolution =
  /** Serve the whole resource (no header, a malformed one, or If-Range said so). */
  | { kind: 'full' }
  /** Serve one slice with 206 Partial Content. */
  | { kind: 'partial'; range: ByteRange }
  /** No satisfiable range: answer 416 with `bytes * /size`. */
  | { kind: 'unsatisfiable' }

/**
 * Resolve one `Range` header against a resource size (RFC 9110 §14.1.1 /
 * §14.2). A header that is not a byte range, or whose specs are all
 * malformed, is ignored (full response) — as the RFC prescribes. Of several
 * ranges the first satisfiable one is served (browsers issue a single range
 * for `<video>`; multipart/byteranges is deliberately not implemented).
 */
export function parseRangeHeader(header: string | undefined, size: number): RangeResolution {
  if (header === undefined) return { kind: 'full' }
  const match = /^bytes=(.*)$/i.exec(header.trim())
  if (match === null) return { kind: 'full' }
  if (size <= 0) return { kind: 'unsatisfiable' }
  let unsatisfiable = false
  for (const spec of (match[1] ?? '').split(',')) {
    const parsed = /^(\d*)-(\d*)$/.exec(spec.trim())
    if (parsed === null) continue
    const [, firstText, lastText] = parsed
    if (firstText === '' && lastText === '') continue
    // `bytes=-N`: the last N bytes. N=0 is unsatisfiable by definition.
    if (firstText === '') {
      const suffix = Number(lastText)
      if (!Number.isSafeInteger(suffix) || suffix <= 0) { unsatisfiable = true; continue }
      return { kind: 'partial', range: { start: Math.max(0, size - suffix), end: size - 1 } }
    }
    const start = Number(firstText)
    if (!Number.isSafeInteger(start)) continue
    if (start >= size) { unsatisfiable = true; continue }
    // `bytes=N-`: from N to the end.
    if (lastText === '') return { kind: 'partial', range: { start, end: size - 1 } }
    const last = Number(lastText)
    if (!Number.isSafeInteger(last) || last < start) continue
    return { kind: 'partial', range: { start, end: Math.min(last, size - 1) } }
  }
  return unsatisfiable ? { kind: 'unsatisfiable' } : { kind: 'full' }
}

/** The `Content-Range` value of a 206 response. */
export function contentRangeHeader(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}

/** The `Content-Range` value of a 416 response (no satisfiable range). */
export function unsatisfiedContentRange(size: number): string {
  return `bytes */${size}`
}

/**
 * The route's entity tag: size + mtime is enough to detect the one thing a
 * range response cares about (the file changed under a scrubbing player)
 * without hashing a multi-gigabyte clip.
 */
export function mediaETag(size: number, mtimeMs: number): string {
  return `"${size}-${Math.floor(mtimeMs)}"`
}

/**
 * Whether an `If-Range` guard allows the range to be served. Absent/empty
 * guards always pass; an entity tag is compared verbatim, an HTTP-date
 * against the `Last-Modified` we advertise. False means "send the whole
 * resource instead" (the client's copy is stale).
 */
export function ifRangeMatches(value: string | undefined, etag: string, lastModified: string): boolean {
  if (value === undefined) return true
  const trimmed = value.trim()
  if (trimmed === '') return true
  if (trimmed.startsWith('"') || trimmed.startsWith('W/')) return trimmed === etag
  return trimmed === lastModified
}
