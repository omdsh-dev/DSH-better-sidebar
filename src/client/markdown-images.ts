/**
 * Markdown-preview local-image resolution. The shared `MarkdownText` (from
 * @deepseek-ai/dsh-client-ui-primitives) only renders absolute http(s) image
 * URLs — relative links are disabled for chat security — so a local image in
 * a previewed `.md` (`![alt](./img.png)`, an absolute `/cwd/img.png`, or a
 * reference definition) would otherwise fall back to its alt text. This
 * dependency-free helper rewrites those destinations into absolute
 * `/sidebar/file` media URLs, resolved against the injected transport base so
 * a reverse-proxy prefix survives; `MarkdownText` accepts them because they are
 * absolute http(s), and the host media route then serves the bytes.
 */

import type { SessionScope } from './api.ts'
import { hostRouteUrl } from './host-route-url.ts'
import { maskCodeRegions } from './markdown-code.ts'
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
 * Shared with the markdown navigation resolver (`markdown-navigation.ts`),
 * which canonicalizes a claimed link target the same way.
 */
export function normalizeLocalPath(path: string): string {
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
 *
 * Code regions — inline spans AND fenced blocks, the latter opened by ``` ``` ```
 * OR `~~~` (see `markdown-code.ts`, the mask both source rewriters share) — are
 * masked before rewriting so documentation that demonstrates `![alt](./img.png)`
 * is not mutated into a `/sidebar/file` URL. Reference definitions are only
 * rewritten when their label is actually referenced by an image (collapsed
 * `[![][id]]`, full `![alt][id]`, or shortcut `![]` referencing the next
 * definition) — a plain link `[text][id]` must not have its destination
 * redirected to the media route.
 * @param text - The raw markdown source (inline + reference images).
 * @param scope - The session scope (sessionId + cwd) for the media route.
 * @param filePath - The absolute path of the opened `.md` file.
 * @param baseUrl - The injected transport base (`hostTransportBase()` in the
 * renderers); injected so the core rewrite stays pure and unit-testable.
 * @returns The markdown with local image destinations rewritten in place.
 */
/**
 * Resolve one media destination against the session's media route: local
 * (relative or absolute) paths become absolute `/sidebar/file` URLs, resolved
 * through `baseUrl` so the shared MarkdownText http(s) allowlist accepts them
 * AND a reverse-proxy prefix is preserved, while remote URLs, `#`-anchors and
 * empty destinations are returned untouched. Shared by the markdown image rewriter below and by the
 * preview's raw-HTML sanitizer (`markdown-html.tsx`, which meets the same
 * allowlist when rendering `<img src="./x.png">` inside HTML blocks).
 */
export function resolveLocalMediaDest(
  dest: string,
  scope: SessionScope,
  filePath: string,
  baseUrl: string,
): string {
  const trimmed = dest.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return dest
  if (isRemoteUrl(trimmed)) return dest
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash === -1 ? '/' : filePath.slice(0, slash + 1)
  const candidate = isAbsolutePath(trimmed) ? trimmed : directory + trimmed
  // Mirrors api.ts fileUrl/mediaUrl for the /sidebar/file media route, made
  // absolute (and prefix-preserving) so the shared MarkdownText http(s)
  // allowlist accepts it.
  const params = new URLSearchParams({ sessionId: scope.sessionId, path: normalizeLocalPath(candidate) })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  return hostRouteUrl(`sidebar/file?${params.toString()}`, baseUrl).href
}

export function rewriteLocalImageUrls(
  text: string,
  scope: SessionScope,
  filePath: string,
  baseUrl: string,
): string {
  const resolve = (dest: string): string => resolveLocalMediaDest(dest, scope, filePath, baseUrl)

  // Fenced blocks (``` ``` ``` AND `~~~`) and inline code spans are masked so
  // image-looking text inside documentation examples is never rewritten; the
  // original text goes back in after the rewrite.
  const { masked, restore } = maskCodeRegions(text)

  const inline = masked.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, dest) => {
    return `![${alt}](${resolve(dest)})`
  })

  // Collect labels referenced by image syntax (full `![alt][id]` and
  // collapsed `![][id]`) so only those reference definitions are rewritten.
  // A shortcut reference (`![alt]` with no `[id]`) resolves to the label
  // text `alt` itself; include it too. Plain links `[text][id]` never match
  // the leading `!` and are left untouched.
  const imageLabels = new Set<string>()
  const labelRe = /!\[([^\]]*)\](?:\[((?:[^\][]|\[[^\]]*\])*)\])?/g
  let labelMatch: RegExpExecArray | null
  while ((labelMatch = labelRe.exec(inline)) !== null) {
    const alt = labelMatch[1] ?? ''
    const ref = labelMatch[2]
    imageLabels.add(ref !== undefined && ref !== '' ? ref.toLowerCase() : alt.toLowerCase())
  }

  const refsRewritten = inline.replace(/^(\s*\[([^\]]+)\]:\s*)(<[^>]+>|[^\s]+)/gm, (match, head: string, label: string, dest: string) => {
    if (!imageLabels.has(label.toLowerCase())) return match
    return `${head}${resolve(dest.replace(/^<|>$/g, ''))}`
  })

  return restore(refsRewritten)
}
