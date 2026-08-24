import { isAbsolutePath } from './paths.ts'

const MARKDOWN_LINK_ROUTE = '/__dsh-better-sidebar-markdown-link'

/** Hide explicit HTML anchor markers from the rendered Markdown preview. */
export function stripMarkdownAnchorTags(text: string): string {
  return text.replace(
    /<a\s+[^>]*\bid\s*=\s*(["'])[^"']+\1[^>]*>\s*<\/a\s*>/gi,
    '',
  )
}

/** Decode a Markdown href without making malformed percent escapes fatal. */
function decodeHref(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Normalize a workspace path using browser-safe POSIX separators. */
function normalizePath(value: string): string {
  const slash = value.replace(/\\/g, '/')
  let prefix = ''
  let rest = slash
  if (/^[A-Za-z]:\//.test(rest)) {
    prefix = rest.slice(0, 3)
    rest = rest.slice(3)
  } else if (rest.startsWith('//')) {
    prefix = '//'
    rest = rest.slice(2)
  } else if (rest.startsWith('/')) {
    prefix = '/'
    rest = rest.slice(1)
  }

  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (prefix === '') parts.push(part)
      continue
    }
    parts.push(part)
  }
  const body = parts.join('/')
  if (prefix === '/' || prefix.endsWith('/')) return prefix + body
  if (prefix === '//') return prefix + body
  return prefix === '' ? body : `${prefix}/${body}`
}

/** Resolve a local Markdown link relative to the file currently previewed. */
export function resolveMarkdownLink(sourcePath: string, href: string): string | null {
  const raw = href.trim()
  if (raw === '' || raw.startsWith('#') || raw.startsWith('//')) return null
  // Keep web, mail, data and file URLs in the normal browser behavior.
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(raw)) return null

  const fragment = raw.search(/[?#]/)
  const encodedTarget = fragment === -1 ? raw : raw.slice(0, fragment)
  const target = decodeHref(encodedTarget).trim()
  if (!/\.(?:md|markdown)$/i.test(target)) return null

  const separator = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'))
  const directory = separator >= 0 ? sourcePath.slice(0, separator) : ''
  const absolute = isAbsolutePath(target)
    ? target
    : `${directory}/${target}`
  return normalizePath(absolute)
}

/** Resolve an in-page Markdown anchor (the `#heading` form). */
export function resolveMarkdownAnchor(href: string): string | null {
  const raw = decodeHref(href.trim())
  if (!raw.startsWith('#') || raw.length <= 1) return null
  return raw.slice(1)
}

/** Return the original target carried by a sanitized same-origin marker URL. */
export function markdownLinkTarget(href: string, origin: string): string {
  try {
    const url = new URL(href, origin)
    if (url.origin === new URL(origin).origin && url.pathname === MARKDOWN_LINK_ROUTE) {
      return url.searchParams.get('target') ?? href
    }
  } catch {
    // Leave malformed or non-marker links to the normal resolver.
  }
  return href
}

/** Rewrite local Markdown file links into safe same-origin marker URLs. */
export function rewriteMarkdownFileLinks(text: string, sourcePath: string, origin: string): string {
  if (origin === '') return text
  const marker = (href: string): string => `${origin}${MARKDOWN_LINK_ROUTE}?target=${encodeURIComponent(href)}`
  const rewriteNonCode = (chunk: string): string => chunk.replace(
    /(!?\[[^\]]*\])\((<[^>]+>|[^)\s]+)([^)]*)\)/g,
    (whole, label: string, rawTarget: string, suffix: string) => {
      if (label.startsWith('!')) return whole
      const href = rawTarget.startsWith('<') && rawTarget.endsWith('>')
        ? rawTarget.slice(1, -1)
        : rawTarget
      const navigable = resolveMarkdownAnchor(href) !== null || resolveMarkdownLink(sourcePath, href) !== null
      return !navigable
        ? whole
        : `${label}(${marker(href)}${suffix})`
    },
  )
  const rewriteChunk = (chunk: string): string => chunk
    .split(/(`+[^`\n]*`+)/g)
    .map((part, index) => index % 2 === 1 ? part : rewriteNonCode(part))
    .join('')
  // Keep fenced code blocks as source text; links inside code must not become
  // navigation controls in the preview.
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((chunk, index) => index % 2 === 1 ? chunk : rewriteChunk(chunk))
    .join('')
}
