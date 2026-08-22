/**
 * Markdown-preview local-image resolution. The shared `MarkdownText` (from
 * @deepseek-ai/dsh-client-ui-primitives) only renders absolute http(s) image
 * URLs — relative links are disabled for chat security — so a local image in
 * a previewed `.md` (`![alt](./img.png)`, an absolute `/cwd/img.png`, or a
 * reference definition) would otherwise fall back to its alt text. This
 * dependency-free helper rewrites those destinations into absolute
 * `/sidebar/file` media URLs (prefixed with the GUI's own origin) so
 * `MarkdownText` accepts them; the host media route then serves the bytes,
 * still restricted to files under the session cwd.
 */

import type { SessionScope } from './api.ts'
import { isAbsolutePath } from './paths.ts'

/**
 * True for a destination that is a remote URL — an absolute `scheme:` URL
 * that is not a Windows drive path (`C:\...`). http/https/data/mailto etc.
 * all match here and are handed back to `MarkdownText` untouched.
 */
function isRemoteUrl(dest: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(dest) && !/^[A-Za-z]:[\\/]/.test(dest)
}

/**
 * Collapse `.`/`..` segments of an absolute local path, preserving its root
 * (POSIX `/`), its Windows drive (`C:\`), or its UNC `\\server\share`
 * prefix. The host's `requireAbsolute` (`path.resolve`) normalizes anyway,
 * but producing a canonical path here keeps the `/sidebar/file` URL clean.
 */
function normalizeLocalPath(path: string): string {
  const drive = /^([A-Za-z]:)[\\/]/.exec(path)?.[1]
  const body = drive !== undefined ? path.slice(drive.length) : path
  const parts = body.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  if (drive !== undefined) return `${drive}\\${out.join('\\')}`
  const separator = path.startsWith('\\') ? '\\' : '/'
  const root = path.startsWith('/') ? '/' : path.startsWith('\\') ? '\\\\' : ''
  return `${root}${out.join(separator)}`
}

/**
 * Rewrite markdown image destinations that point at local files into
 * absolute `/sidebar/file` media URLs. Relative destinations resolve against
 * the opened file's directory (normalizing `.`/`..` segments); absolute
 * local paths pass through. Remote (http/https/data/mailto) and `#`-anchor
 * destinations are left untouched for `MarkdownText`. Reference-style images
 * (`![x][id]` + `[id]: url`) are covered by rewriting their definition lines.
 * @param text - The raw markdown source (inline + reference images).
 * @param scope - The session scope (sessionId + cwd) for the media route.
 * @param filePath - The absolute path of the opened `.md` file.
 * @param origin - The GUI's own origin (`window.location.origin`); injected
 * so the core rewrite stays pure and unit-testable.
 * @returns The markdown with local image destinations rewritten in place.
 */
export function rewriteLocalImageUrls(
  text: string,
  scope: SessionScope,
  filePath: string,
  origin: string,
): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash === -1 ? '/' : filePath.slice(0, slash + 1)
  const mediaUrl = (candidate: string): string => {
    // Mirrors api.ts fileUrl/mediaUrl for the /sidebar/file media route, made
    // absolute so the shared MarkdownText http(s) allowlist accepts it.
    const params = new URLSearchParams({ sessionId: scope.sessionId, path: candidate })
    if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
    return `${origin}/sidebar/file?${params.toString()}`
  }
  const resolve = (dest: string): string => {
    const trimmed = dest.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return dest
    if (isRemoteUrl(trimmed)) return dest
    const candidate = isAbsolutePath(trimmed) ? trimmed : directory + trimmed
    return mediaUrl(normalizeLocalPath(candidate))
  }
  const inline = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, dest) => {
    return `![${alt}](${resolve(dest)})`
  })
  // Reference-style images: rewrite their `[id]: <url>` definitions.
  return inline.replace(/^(\s*\[[^\]]+\]:\s*)(<[^>]+>|[^\s]+)/gm, (_match, head, dest) => {
    return `${head}${resolve(dest.replace(/^<|>$/g, ''))}`
  })
}
