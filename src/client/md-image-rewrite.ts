/**
 * Markdown local-image rewriting for the preview. The DSH MarkdownText
 * renderer only renders images whose destination is an absolute HTTP(S)
 * URL — a relative path like `./pic.png` degrades to plain alt text. This
 * module walks the markdown source and rewrites local image destinations
 * into absolute media-route URLs; the resolver is injected, so the module
 * stays pure and unit-testable (tests/md-image-rewrite.spec.ts).
 *
 * Scope: inline images `![alt](dest)` only. Fenced code blocks and inline
 * code spans are left untouched, as are scheme URLs (http/data/mailto/…),
 * root-relative URLs (`/…`), and anchors (`#…`). Reference-style images
 * (`![alt][ref]`) and multi-line destinations are out of scope.
 */

/** Build the absolute URL for one local image destination (null = leave it). */
export type LocalImageResolver = (dest: string) => string | null

/** Any URI scheme (http:, data:, mailto:, …) — never a local file. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** Opening fence: 0-3 spaces indent + a 3+ backtick/tilde run. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Resolve a decoded relative destination against the markdown file's
 * directory into an absolute '/' path (the sidebar's fs convention on all
 * platforms). Query/hash suffixes are dropped; `.`/`..` segments normalize.
 */
export function resolveLocalPath(baseDir: string, dest: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(dest) } catch { decoded = dest }
  decoded = decoded.split(/[?#]/)[0] ?? ''
  const parts = `${baseDir}/${decoded.replace(/\\/g, '/')}`.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { stack.pop(); continue }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}

/** Decide whether one image destination can be local (null = leave as-is). */
function rewriteDest(dest: string, resolve: LocalImageResolver): string | null {
  if (dest === '') return null
  if (SCHEME_RE.test(dest)) return null // http:, data:, mailto:, …
  if (dest.startsWith('/') || dest.startsWith('#')) return null
  const url = resolve(dest)
  return url === null || url === dest ? null : url
}

/** Rewrite the inline images of one non-fenced line. */
function rewriteImageLine(line: string, resolve: LocalImageResolver): string {
  let out = ''
  let index = 0
  let inCode = false
  while (index < line.length) {
    if (line[index] === '`') {
      const run = /^`+/.exec(line.slice(index))![0]
      inCode = !inCode
      out += run
      index += run.length
      continue
    }
    if (!inCode && line[index] === '!' && line[index + 1] === '[') {
      const close = line.indexOf('](', index + 2)
      if (close !== -1) {
        const end = line.indexOf(')', close + 2)
        if (end !== -1) {
          const alt = line.slice(index + 2, close)
          let dest = line.slice(close + 2, end).trim()
          // Optional title: everything after the first whitespace.
          const space = dest.search(/\s/)
          if (space !== -1) dest = dest.slice(0, space)
          if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
          const resolved = rewriteDest(dest, resolve)
          if (resolved !== null) {
            out += `![${alt}](${resolved})`
            index = end + 1
            continue
          }
        }
      }
    }
    out += line[index]
    index += 1
  }
  return out
}

/**
 * Rewrite local image destinations across the markdown source. Fences
 * (both ``` and ~~~) protect their content; inline code spans are skipped
 * line-by-line. Fence detection runs on the original lines (split happens
 * before any rewrite), so the longer rewritten URLs cannot disturb it.
 */
export function rewriteLocalImages(text: string, resolve: LocalImageResolver): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  for (const line of lines) {
    const fence = FENCE_RE.exec(line)
    if (fence !== null) {
      const char = fence[1]!.charAt(0)
      const length = fence[1]!.length
      if (!inFence) {
        inFence = true
        fenceChar = char
        fenceLength = length
      } else if (char === fenceChar && length >= fenceLength) {
        inFence = false
        fenceChar = ''
        fenceLength = 0
      }
      out.push(line)
      continue
    }
    out.push(inFence ? line : rewriteImageLine(line, resolve))
  }
  return out.join('\n')
}
