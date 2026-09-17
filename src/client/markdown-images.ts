/**
 * Markdown-preview local-image resolution. The shared `MarkdownText` (from
 * @deepseek-ai/dsh-client-ui-primitives) only renders absolute http(s) image
 * URLs — relative links are disabled for chat security — so a local image in
 * a previewed `.md` (`![alt](./img.png)`, an absolute `/cwd/img.png`, an
 * Obsidian embed `![[x.png]]`, or a reference definition) would otherwise
 * fall back to its alt text. This dependency-free helper rewrites those
 * destinations into absolute `/sidebar/file` media URLs (prefixed with the
 * GUI's own origin) so `MarkdownText` accepts them; the host media route
 * then serves the bytes, still restricted to files under the session cwd.
 *
 * Obsidian embeds resolve against a configurable image directory (the
 * markdown viewer's `imageDir` setting, default `images`) anchored at the
 * session cwd — vault-root-relative like Obsidian itself — via
 * {@link rewriteObsidianImageEmbeds}.
 */

import type { SessionScope } from './api.ts'
import { isAbsolutePath } from './paths.ts'

/**
 * The default Obsidian-style image directory (`![[x.png]]` → `<cwd>/images/x.png`).
 * Configurable through the markdown viewer's `imageDir` setting row
 * (persisted in `pluginSettings['markdown']`); the resolved directory is
 * relative to the session cwd unless an absolute path is configured.
 */
export const DEFAULT_IMAGE_DIR = 'images'

/** File extensions Obsidian embeds render as images (others are left as-is). */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|tiff?)$/i

/** Obsidian embed source: `![[target]]` (name | optional `|alt` / `|WxH`). */
const OBSIDIAN_EMBED_RE = /!\[\[([^\]]+)\]\]/g

/**
 * Normalize the persisted `imageDir` setting value into a usable directory
 * name: a non-empty trimmed string wins, anything else (missing, empty —
 * the text row stores '' when cleared) falls back to the default.
 */
export function imageDirOf(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_IMAGE_DIR
}

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
 *
 * Code spans (`` `...` ``) and fenced code blocks (``` ```...``` ```) are
 * masked before rewriting so documentation that demonstrates `![alt](./img.png)`
 * is not mutated into a `/sidebar/file` URL. Reference definitions are only
 * rewritten when their label is actually referenced by an image (collapsed
 * `[![][id]]`, full `![alt][id]`, or shortcut `![]` referencing the next
 * definition) — a plain link `[text][id]` must not have its destination
 * redirected to the media route.
 * @param text - The raw markdown source (inline + reference images).
 * @param scope - The session scope (sessionId + cwd) for the media route.
 * @param filePath - The absolute path of the opened `.md` file.
 * @param origin - The GUI's own origin (`window.location.origin`); injected
 * so the core rewrite stays pure and unit-testable.
 * @returns The markdown with local image destinations rewritten in place.
 */
/**
 * Resolve one media destination against the session's media route: local
 * (relative or absolute) paths become absolute `/sidebar/file` URLs (prefixed
 * with the GUI's own origin so the shared MarkdownText http(s) allowlist
 * accepts them), while remote URLs, `#`-anchors and empty destinations are
 * returned untouched. Shared by the markdown image rewriter below and by the
 * preview's raw-HTML sanitizer (`markdown-html.tsx`, which meets the same
 * allowlist when rendering `<img src="./x.png">` inside HTML blocks).
 */
export function resolveLocalMediaDest(
  dest: string,
  scope: SessionScope,
  filePath: string,
  origin: string,
): string {
  const trimmed = dest.trim()
  // Idempotency: a destination already rewritten to this GUI's media route
  // (a prior pass, an Obsidian embed lowered below) passes through untouched
  // — re-resolving it against the file directory would corrupt the URL.
  if (trimmed.startsWith(`${origin}/sidebar/file?`)) return dest
  if (trimmed === '' || trimmed.startsWith('#')) return dest
  if (isRemoteUrl(trimmed)) return dest
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash === -1 ? '/' : filePath.slice(0, slash + 1)
  const candidate = isAbsolutePath(trimmed) ? trimmed : directory + trimmed
  // Mirrors api.ts fileUrl/mediaUrl for the /sidebar/file media route, made
  // absolute so the shared MarkdownText http(s) allowlist accepts it.
  const params = new URLSearchParams({ sessionId: scope.sessionId, path: normalizeLocalPath(candidate) })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  return `${origin}/sidebar/file?${params.toString()}`
}

/**
 * The directory Obsidian embeds resolve against (and where pasted images
 * are written): an absolute `imageDir` config is used verbatim; a relative
 * one is anchored at the session cwd (the project root — Obsidian embeds
 * are vault-root-relative, not file-relative), falling back to the opened
 * file's directory when the scope carries no cwd.
 */
export function resolveObsidianBaseDir(imageDir: string, scope: SessionScope, filePath: string): string {
  if (isAbsolutePath(imageDir)) return imageDir.replace(/[\\/]+$/, '')
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash === -1 ? '/' : filePath.slice(0, slash + 1)
  const root = scope.cwd !== undefined && scope.cwd !== '' ? scope.cwd : directory
  return `${root.replace(/[\\/]+$/, '')}/${imageDir}`
}

/**
 * Lower one Obsidian image embed (`![[x.png]]`) into a standard markdown
 * image whose destination is a media-route URL. `![[x.png|alt]]` uses `alt`
 * as the alt text; `![[x.png|WxH]]` (Obsidian size syntax) is accepted but
 * the size is dropped (no scaling in the preview). Embeds whose target is
 * not an image (notes, pdfs…) are returned unchanged — they stay wiki-link
 * text the shared MarkdownText renders verbatim. Code-fenced examples are
 * masked before this runs (see {@link rewriteLocalImageUrls}).
 */
export function rewriteObsidianImageEmbeds(
  text: string,
  scope: SessionScope,
  filePath: string,
  origin: string,
  imageDir: string = DEFAULT_IMAGE_DIR,
): string {
  return text.replace(OBSIDIAN_EMBED_RE, (match, inner: string) => {
    const pipe = inner.split('|')
    const name = (pipe[0] ?? '').trim()
    if (!IMAGE_EXT_RE.test(name)) return match
    const arg = pipe.slice(1).join('|').trim()
    // Only free-form alt text is used; Obsidian's WxH sizing is dropped.
    const alt = arg !== '' && !/^\d+(?:x\d+)?$/i.test(arg) ? arg : name
    const base = resolveObsidianBaseDir(imageDir, scope, filePath)
    const candidate = normalizeLocalPath(`${base}/${name}`)
    const params = new URLSearchParams({ sessionId: scope.sessionId, path: candidate })
    if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
    return `![${alt}](${origin}/sidebar/file?${params.toString()})`
  })
}

export function rewriteLocalImageUrls(
  text: string,
  scope: SessionScope,
  filePath: string,
  origin: string,
  imageDir: string = DEFAULT_IMAGE_DIR,
): string {
  const resolve = (dest: string): string => resolveLocalMediaDest(dest, scope, filePath, origin)

  // Mask fenced code blocks and inline code spans so image-looking text
  // inside documentation examples is never rewritten. The sentinel uses a
  // character unlikely to appear in prose; the original spans are restored
  // after the image rewrite.
  const masks: string[] = []
  const masked = text
    .replace(/```[\s\S]*?```/g, (block) => { masks.push(block); return `\u0000${masks.length - 1}\u0000` })
    .replace(/`[^`\n]*`/g, (span) => { masks.push(span); return `\u0000${masks.length - 1}\u0000` })

  // Obsidian embeds (`![[x.png]]`) first: lowered into standard `![x](url)`
  // images whose destinations are already media-route URLs, so the inline
  // pass below leaves them untouched (resolve is idempotent on them).
  const obsidian = rewriteObsidianImageEmbeds(masked, scope, filePath, origin, imageDir)

  const inline = obsidian.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, dest) => {
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

  // eslint-disable-next-line no-control-regex -- NUL is the deliberate mask sentinel (cannot appear in source markdown)
  return refsRewritten.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => masks[Number(index)] ?? '')
}
