/**
 * Desktop-shell HTML preview inlining.
 *
 * The shell only injects its `x-dsh-desktop-renderer` header for a subframe
 * whose origin is literally `dsh-app://app`; a sandboxed HTML preview frame is
 * an opaque origin, so both the document navigation and every resource it
 * requests from `dsh-app:` are rejected by the shell before they reach the
 * plugin's routes (#1143). The sanctioned shape (the host's own document
 * preview uses it) is a self-contained document in a sandboxed `blob:` frame:
 * the trusted top frame fetches the HTML and its local resources through the
 * plugin routes, rewrites them to `data:` URLs / inline style and script
 * blocks, and the frame then needs no `dsh-app:` request at all.
 *
 * This module is pure on purpose (no fetch, no React): the caller supplies
 * `fetchResource`, so the resolution and rewriting rules are unit-testable and
 * the component owns transport, aborting and object-URL lifetime.
 *
 * Only resources inside the previewed file's own folder are inlined: the top
 * frame fetches with the GUI's own credentials and the bytes end up readable
 * by the page's scripts, so it must never fetch more than the page could load
 * as a plain folder of files (see {@link insidePreviewFolder}). External
 * http(s) URLs, `data:`, `blob:` and `file:` are left exactly as authored; an
 * out-of-folder or failed local fetch also leaves the authored reference (the
 * page still renders, the one resource may not). The returned document is
 * always UTF-8 and keeps the route's `object-src 'none'` defense as a meta
 * CSP; the iframe sandbox attribute remains the primary boundary (no
 * `allow-same-origin` is ever added).
 */
import { HTML_ROUTE_PREFIX } from '../html-route.ts'

/** One fetched local resource, already in memory. */
export interface InlineResource {
  readonly bytes: Uint8Array
  readonly mediaType: string
}

/**
 * Fetch one same-origin resource. The caller decides how (the component uses
 * `fetch` with same-origin credentials and an abort signal); returning
 * undefined means "leave the authored reference alone".
 */
export type FetchInlineResource = (url: string) => Promise<InlineResource | undefined>

/** Same protocol, credentials, host and port — `URL.origin` is `null` for
 *  custom schemes such as `dsh-app:`, so it cannot be used here. */
function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol
    && a.username === b.username
    && a.password === b.password
    && a.hostname === b.hostname
    && a.port === b.port
}

/**
 * Resolve a same-origin resource reference. Returns undefined for empty /
 * fragment destinations, external origins, and every non-http(s)/non-custom
 * protocol this preview cannot inline.
 */
export function inlineableUrl(reference: string, baseUrl: string): URL | undefined {
  const trimmed = reference.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return undefined
  let url: URL
  let base: URL
  try {
    base = new URL(baseUrl)
    url = new URL(trimmed, base)
  } catch {
    return undefined
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:' || url.protocol === 'javascript:') {
    return undefined
  }
  if (!sameOrigin(url, base)) return undefined
  return url
}

/**
 * Whether a resolved resource URL lies inside the previewed file's own folder:
 * same origin, the document is a `/sidebar/html/<session>/...` route, and the
 * resource path is the document's folder prefix followed only by plain name
 * segments. Each segment is checked DECODED, because the route decodes it
 * before joining the path: an empty, `.` or `..` segment, or one hiding a `/`
 * or `\` (`%2F`, `%5C`, or a raw backslash, which a non-special scheme keeps
 * in the path), is refused. Everything else — a walk out of the folder,
 * another session's route, `/sidebar/file` or any other same-origin endpoint —
 * is never fetched. The folder comes from `documentUrl`, never from an
 * authored `<base>`, so a page cannot widen it.
 * @param resourceUrl - The absolute resource URL about to be fetched.
 * @param documentUrl - The previewed file's absolute route URL.
 * @returns true only for a file at or below the document's folder.
 */
export function insidePreviewFolder(resourceUrl: string, documentUrl: string): boolean {
  let resource: URL
  let page: URL
  try {
    resource = new URL(resourceUrl)
    page = new URL(documentUrl)
  } catch {
    return false
  }
  if (!sameOrigin(resource, page)) return false
  // The document must BE an html route, with the prefix at the start of the
  // path (the same contract as decodeHtmlUrl), not merely contain one later.
  // Inlining only runs in the desktop shell, whose page is `dsh-app://app/`, so
  // its routes sit at the origin root; a reverse-proxied web deployment (the
  // one place a directory prefix exists) keeps the route-src iframe instead.
  if (!page.pathname.startsWith(HTML_ROUTE_PREFIX)) return false
  const folder = page.pathname.slice(0, page.pathname.lastIndexOf('/') + 1)
  // Fail closed unless the session segment is non-empty and the folder
  // extends past `/sidebar/html/<session>`.
  const sessionEnd = folder.indexOf('/', HTML_ROUTE_PREFIX.length)
  if (sessionEnd <= HTML_ROUTE_PREFIX.length) return false
  if (!resource.pathname.startsWith(folder)) return false
  const rest = resource.pathname.slice(folder.length)
  if (rest === '') return false
  return rest.split('/').every((segment) => {
    let name: string
    try {
      name = decodeURIComponent(segment)
    } catch {
      return false
    }
    return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  })
}

/** Base64 in bounded chunks so a multi-megabyte asset cannot overflow the
 *  argument stack through `String.fromCharCode(...bytes)`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** The displayable `data:` URL for one fetched resource. */
function dataUrlOf(resource: InlineResource): string {
  const mediaType = resource.mediaType === '' ? 'application/octet-stream' : resource.mediaType
  return `data:${mediaType};base64,${bytesToBase64(resource.bytes)}`
}

/** Decode a text resource (HTML is fetched separately by the caller). */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Per-document resource cache: the same image/CSS URL used twice is fetched
 * once, and every failure is memoized as "not inlined" instead of retried.
 */
class ResourceCache {
  private readonly entries = new Map<string, Promise<InlineResource | undefined>>()

  constructor(private readonly fetchResource: FetchInlineResource) {}

  get(url: string): Promise<InlineResource | undefined> {
    let entry = this.entries.get(url)
    if (entry === undefined) {
      entry = this.fetchResource(url).catch(() => undefined)
      this.entries.set(url, entry)
    }
    return entry
  }
}

/** `url(...)` in CSS, with or without quotes. */
const CSS_URL_RE = /url\(\s*(?:(["'])(.*?)\1|([^'")\s]+))\s*\)/gi
/** `@import "x";` / `@import url(x) screen;`. */
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^'")\s;]+))\s*\)?\s*([^;]*);/gi

/** The referenced URL of one `url(...)` match. */
function cssUrlOf(match: RegExpMatchArray): string | undefined {
  return match[2] ?? match[3]
}

/**
 * Rewrite one stylesheet's `@import` and `url(...)` references to inlined
 * content. Imported stylesheets are recursively expanded; a cycle yields an
 * empty expansion. Failures leave the authored reference untouched.
 * @param css - The stylesheet source.
 * @param cssUrl - The stylesheet's own URL (base for relative references).
 * @param cache - Per-document resource cache.
 * @param seen - Stylesheet URLs already on the current import chain.
 * @returns The rewritten CSS.
 */
async function inlineCss(css: string, cssUrl: string, cache: ResourceCache, seen: ReadonlySet<string> = new Set()): Promise<string> {
  if (seen.has(cssUrl)) return ''
  const chain = new Set(seen)
  chain.add(cssUrl)

  const importReplacements = new Map<string, string>()
  for (const match of [...css.matchAll(CSS_IMPORT_RE)]) {
    const reference = cssUrlOf(match)
    if (reference === undefined) continue
    const url = inlineableUrl(reference, cssUrl)
    if (url === undefined) continue
    const resource = await cache.get(url.href)
    if (resource === undefined) continue
    const nested = await inlineCss(decodeText(resource.bytes), url.href, cache, chain)
    const media = (match[4] ?? '').trim()
    importReplacements.set(match[0], media === '' ? nested : `@media ${media} {\n${nested}\n}`)
  }
  const withImports = css.replace(CSS_IMPORT_RE, (match) => importReplacements.get(match) ?? match)

  const urlReplacements = new Map<string, string>()
  const references = new Set<string>()
  for (const match of withImports.matchAll(CSS_URL_RE)) {
    const reference = cssUrlOf(match)
    if (reference === undefined || reference.startsWith('#')) continue
    references.add(reference)
  }
  await Promise.all([...references].map(async (reference) => {
    const url = inlineableUrl(reference, cssUrl)
    if (url === undefined) return
    const resource = await cache.get(url.href)
    if (resource === undefined) return
    urlReplacements.set(reference, `url("${dataUrlOf(resource)}")`)
  }))
  return withImports.replace(CSS_URL_RE, (match, _quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    const reference = quoted ?? bare
    if (reference === undefined) return match
    return urlReplacements.get(reference) ?? match
  })
}

/** Inline one attribute that holds a single resource URL. */
async function inlineAttribute(element: Element, attribute: string, baseUrl: string, cache: ResourceCache): Promise<void> {
  const reference = element.getAttribute(attribute)
  if (reference === null) return
  const url = inlineableUrl(reference, baseUrl)
  if (url === undefined) return
  const resource = await cache.get(url.href)
  if (resource === undefined) return
  element.setAttribute(attribute, dataUrlOf(resource))
}

/** Rewrite a `srcset` attribute. A value already carrying an inline/data URL
 *  is left alone: splitting it on commas would mangle the payload. */
async function inlineSrcset(value: string, baseUrl: string, cache: ResourceCache): Promise<string> {
  if (/\b(?:data|blob):/i.test(value)) return value
  const candidates = value.split(',').map(candidate => candidate.trim()).filter(candidate => candidate !== '')
  const rewritten: string[] = []
  for (const candidate of candidates) {
    const match = /^(\S+)(\s+.*)?$/.exec(candidate)
    if (match === null) {
      rewritten.push(candidate)
      continue
    }
    const url = inlineableUrl(match[1] ?? '', baseUrl)
    if (url === undefined) {
      rewritten.push(candidate)
      continue
    }
    const resource = await cache.get(url.href)
    rewritten.push(resource === undefined ? candidate : `${dataUrlOf(resource)}${match[2] ?? ''}`)
  }
  return rewritten.join(', ')
}

/** Inline one stylesheet `<link>` as a `<style>` element. */
async function inlineStylesheet(link: Element, baseUrl: string, cache: ResourceCache): Promise<void> {
  const reference = link.getAttribute('href')
  if (reference === null) return
  const url = inlineableUrl(reference, baseUrl)
  if (url === undefined) return
  const resource = await cache.get(url.href)
  if (resource === undefined) return
  const style = link.ownerDocument.createElement('style')
  const media = link.getAttribute('media')
  if (media !== null && media !== '') style.setAttribute('media', media)
  style.textContent = await inlineCss(decodeText(resource.bytes), url.href, cache)
  link.replaceWith(style)
}

/** Inline one external script as its own text. */
async function inlineScript(script: Element, baseUrl: string, cache: ResourceCache): Promise<void> {
  const reference = script.getAttribute('src')
  if (reference === null) return
  const url = inlineableUrl(reference, baseUrl)
  if (url === undefined) return
  const resource = await cache.get(url.href)
  if (resource === undefined) return
  script.removeAttribute('src')
  script.removeAttribute('integrity')
  script.removeAttribute('crossorigin')
  script.removeAttribute('async')
  script.removeAttribute('defer')
  script.textContent = decodeText(resource.bytes).replace(/<\/script/gi, '<\\/script')
}

/** Whether a `link` element is a stylesheet. */
function isStylesheet(link: Element): boolean {
  const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
  return rel.includes('stylesheet') && link.hasAttribute('href')
}

/**
 * Build the self-contained document for one HTML file.
 * @param html - The authored HTML text.
 * @param documentUrl - The file's absolute route URL (the base for relatives).
 * @param fetchResource - Resource fetcher (injected; may fail); only called
 *  for URLs inside the document's own folder.
 * @returns The rewritten, UTF-8, self-contained HTML.
 */
export async function inlineHtmlDocument(
  html: string,
  documentUrl: string,
  fetchResource: FetchInlineResource,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const baseElement = doc.querySelector('base[href]')
  let baseUrl = documentUrl
  const authoredBase = baseElement?.getAttribute('href')
  if (authoredBase !== undefined && authoredBase !== null && authoredBase !== '') {
    try {
      baseUrl = new URL(authoredBase, documentUrl).href
    } catch {
      // A malformed base falls back to the document URL.
    }
  }
  baseElement?.removeAttribute('href')

  // Every fetch funnels through this cache: anything outside the previewed
  // file's folder resolves to "not inlined" without a request.
  const cache = new ResourceCache((url) => (insidePreviewFolder(url, documentUrl) ? fetchResource(url) : Promise.resolve(undefined)))
  const tasks: Promise<void>[] = []

  for (const link of [...doc.querySelectorAll('link')]) {
    if (isStylesheet(link)) tasks.push(inlineStylesheet(link, baseUrl, cache))
  }
  for (const script of [...doc.querySelectorAll('script[src]')]) {
    tasks.push(inlineScript(script, baseUrl, cache))
  }
  for (const image of [...doc.querySelectorAll('img[src]')]) {
    tasks.push(inlineAttribute(image, 'src', baseUrl, cache))
  }
  for (const image of [...doc.querySelectorAll('img[srcset]')]) {
    tasks.push(inlineSrcset(image.getAttribute('srcset') ?? '', baseUrl, cache).then((value) => image.setAttribute('srcset', value)))
  }
  for (const source of [...doc.querySelectorAll('source[src]')]) {
    tasks.push(inlineAttribute(source, 'src', baseUrl, cache))
  }
  for (const source of [...doc.querySelectorAll('source[srcset]')]) {
    tasks.push(inlineSrcset(source.getAttribute('srcset') ?? '', baseUrl, cache).then((value) => source.setAttribute('srcset', value)))
  }
  for (const video of [...doc.querySelectorAll('video[src]')]) {
    tasks.push(inlineAttribute(video, 'src', baseUrl, cache))
  }
  for (const video of [...doc.querySelectorAll('video[poster]')]) {
    tasks.push(inlineAttribute(video, 'poster', baseUrl, cache))
  }
  for (const audio of [...doc.querySelectorAll('audio[src]')]) {
    tasks.push(inlineAttribute(audio, 'src', baseUrl, cache))
  }
  for (const track of [...doc.querySelectorAll('track[src]')]) {
    tasks.push(inlineAttribute(track, 'src', baseUrl, cache))
  }
  for (const input of [...doc.querySelectorAll('input[type="image"][src]')]) {
    tasks.push(inlineAttribute(input, 'src', baseUrl, cache))
  }
  for (const image of [...doc.querySelectorAll('image')]) {
    for (const attribute of ['href', 'xlink:href']) {
      if (image.hasAttribute(attribute)) tasks.push(inlineAttribute(image, attribute, baseUrl, cache))
    }
  }

  const styleElements = [...doc.querySelectorAll('style')]
  const styledElements = [...doc.querySelectorAll('[style]')]
  for (const style of styleElements) {
    const source = style.textContent ?? ''
    tasks.push(inlineCss(source, baseUrl, cache).then((css) => { style.textContent = css }))
  }
  for (const element of styledElements) {
    const source = element.getAttribute('style') ?? ''
    tasks.push(inlineCss(source, baseUrl, cache).then((css) => element.setAttribute('style', css)))
  }

  await Promise.all(tasks)

  // The route declared UTF-8 for the document; the blob has no HTTP header to
  // carry that, so the meta must. A conflicting authored charset is removed.
  for (const meta of [...doc.querySelectorAll('meta[charset], meta[http-equiv]')]) {
    if (meta.hasAttribute('charset')) {
      meta.remove()
      continue
    }
    if ((meta.getAttribute('http-equiv') ?? '').toLowerCase() === 'content-type') {
      meta.setAttribute('content', 'text/html; charset=utf-8')
    }
  }
  const head = doc.head ?? doc.documentElement
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  head.prepend(charset)
  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', "object-src 'none'")
  head.prepend(csp)

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}
