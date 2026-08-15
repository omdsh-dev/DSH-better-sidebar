/**
 * Pure URL vocabulary of the /sidebar/html route (HTML previewer).
 *
 * Why path-encoded parameters instead of a query string: the previewed
 * page resolves its relative assets (./style.css, img/x.png) against the
 * document URL, and the WHATWG URL algorithm DROPS the query of a
 * path-relative reference — `/sidebar/html?a=1&path=/a/b/` + `./style.css`
 * would lose the session scope and the route would reject the asset.
 * Encoding everything into the URL path keeps relative resolution inside
 * the same route with every request self-contained:
 *
 *   /sidebar/html/<sessionId>/<absolute-path segments, encodeURIComponent'd>
 *   /sidebar/html/S/Users/me/proj/index.html
 *     + ./style.css → /sidebar/html/S/Users/me/proj/style.css
 *   Windows: C:\Users\me\a.html → /sidebar/html/S/C%3A/Users/me/a.html
 *
 * This module is intentionally dependency-free (no node imports, no wire
 * helpers) so the client bundle can import `encodeHtmlUrl` without tripping
 * the build-time purity gate; the host converts decode failures into
 * SidebarError responses at the route boundary.
 */

/** One decoded route reference. */
export interface HtmlRouteRef {
  sessionId: string
  /** Absolute file path (leading slash; Windows drives keep their colon). */
  path: string
}

/** Decode outcome: the reference, or a client-error description. */
export type HtmlDecodeResult =
  | { ok: true; ref: HtmlRouteRef }
  | { ok: false; status: 400 | 404; message: string }

/** The route prefix both encoders/decoders agree on. */
export const HTML_ROUTE_PREFIX = '/sidebar/html/'

/** Build the route URL for one absolute file path (client + tests). */
export function encodeHtmlUrl(sessionId: string, path: string): string {
  const segments = path.split(/[\\/]+/).filter(segment => segment !== '')
  return `${HTML_ROUTE_PREFIX}${encodeURIComponent(sessionId)}/${segments.map(encodeURIComponent).join('/')}`
}

/**
 * Decode a route pathname into the session + absolute file path. Rejects
 * a wrong prefix (404), an empty or double-slash path, malformed percent
 * encoding, and a missing sessionId or file path (400). The caller still
 * must bound the decoded path with requireAbsolute + isWithin(cwd) — a
 * decoded `..` segment resolves outside the cwd and is refused there.
 */
export function decodeHtmlUrl(pathname: string): HtmlDecodeResult {
  if (!pathname.startsWith(HTML_ROUTE_PREFIX)) {
    return { ok: false, status: 404, message: 'not an html route' }
  }
  const rest = pathname.slice(HTML_ROUTE_PREFIX.length)
  if (rest === '' || rest.includes('//')) {
    return { ok: false, status: 400, message: 'invalid html route path' }
  }
  let segments: string[]
  try {
    segments = rest.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return { ok: false, status: 400, message: 'malformed URL encoding' }
  }
  const [sessionId, ...pathSegments] = segments
  if (sessionId === undefined || sessionId === '' || pathSegments.length === 0 || pathSegments.some(segment => segment === '')) {
    return { ok: false, status: 400, message: 'sessionId and file path are required' }
  }
  // A Windows drive segment ('D:') is the FIRST path segment of an encoded
  // drive path. Rejoining it with a leading slash would yield '/D:/work/...'
  // which node's path.resolve() mangles into 'D:\D:\work\...' on Windows —
  // the html route's isWithin(cwd) fence would then reject every drive path.
  // Keep the drive form slash-free so requireAbsolute() resolves it verbatim.
  const first = pathSegments[0] ?? ''
  const path = /^[A-Za-z]:$/.test(first)
    ? pathSegments.join('/')
    : `/${pathSegments.join('/')}`
  return { ok: true, ref: { sessionId, path } }
}
