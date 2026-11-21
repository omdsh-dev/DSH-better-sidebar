/**
 * Content types for media files and HTML preview resources, by extension.
 *
 * Lifted out of the host entry (`index.ts`) so the route modules can share it
 * without importing the plugin entry (which imports THEM). `index.ts`
 * re-exports {@link mediaTypeForPath}, so the public surface is unchanged.
 */
import { extname } from 'node:path'

/** Extension → content type. */
export const MEDIA_TYPES: Record<string, string> = {
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
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  // Media containers: `<video>` / `<audio>` pick their demuxer from this
  // header, so a media file answered as octet-stream is a coin flip even when
  // the browser can decode it. `.ogg` is audio on purpose — a Theora video in
  // Ogg is vanishingly rare next to Vorbis/Opus audio.
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
}

/**
 * The content type one path is served as.
 * @param path - a file path (only its extension matters).
 * @returns the mapped type, or the binary-safe fallback.
 */
export function mediaTypeForPath(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}
