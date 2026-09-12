/**
 * Resolve one host-owned route through the GUI document base. This preserves
 * reverse-proxy prefixes (for example code-server's `/proxy/<port>/`) that
 * are intentionally absent from `location.origin`.
 *
 * `document.baseURI` may include a query (the one-time launch token), omit a
 * trailing slash, or be reset to `/` by an HTML `<base href="/">`. Treat the
 * longer of the document base and the current location directory as the
 * prefix so `new URL('sidebar/…', base)` cannot replace the last segment.
 */
export function hostRouteUrl(path: string, baseUrl: string = hostDocumentBase()): URL {
  return new URL(path.replace(/^\/+/, ''), directoryBase(baseUrl))
}

/** Resolve one host-owned WebSocket route through the GUI document base. */
export function hostWebSocketUrl(path: string, baseUrl: string = hostDocumentBase()): URL {
  const url = hostRouteUrl(path, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

/**
 * The prefix that relative `/sidebar/*` routes should resolve against.
 * Prefer the current location directory when it is longer than
 * `document.baseURI` (DSH's own `<base href="/">` would otherwise drop a
 * reverse-proxy prefix that is still present in the address bar).
 */
export function hostDocumentBase(): string {
  const doc = typeof document !== 'undefined' ? document.baseURI : ''
  const loc = typeof location !== 'undefined' && typeof location.href === 'string' ? location.href : ''
  if (doc !== '' && loc !== '') {
    try {
      const docPath = new URL(doc).pathname
      const locPath = new URL(loc).pathname
      return locPath.length > docPath.length ? loc : doc
    } catch {
      return loc
    }
  }
  return loc !== '' ? loc : doc !== '' ? doc : 'http://dsh.internal/'
}

/** Strip search/hash and force a trailing slash so relative resolution stays under the prefix. */
function directoryBase(baseUrl: string): string {
  const url = new URL(baseUrl, 'http://dsh.internal')
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}
