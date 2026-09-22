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
 *   UNC (\\server\share\... or //server/share/...):
 *     → /sidebar/html/S//server/share/proj/a.html  ('//' right after the
 *       sessionId marks the UNC prefix; the WHATWG URL keeps '//' intact so
 *       relative assets still resolve inside the same route)
 *
 * Zero or more OPTIONAL marker segments may ride between the sessionId and
 * the path. A marker is a segment whose RAW (still-encoded) form starts with
 * `$`, which is collision-proof: `encodeURIComponent` percent-encodes `$`
 * (to `%24`), so a real path segment can never produce one. Two exist:
 *
 *   `$c<encodeURIComponent(cwd)>`  the session's workspace root
 *   `$r`                           the path that follows is RELATIVE to it
 *
 *   /sidebar/html/S/$cC%253A%255Cproj/$r/index.html
 *
 * The cwd marker exists because this route cannot carry a query (see above)
 * and the session may still be detached when the first preview request
 * arrives — without it the host falls back to its process cwd and the
 * workspace fence then refuses every project file with `forbidden`. The
 * relative marker exists because DSH's own file addresses spell a workspace
 * file relatively, and the decoder would otherwise rebuild it with a leading
 * `/` — which Windows roots on the current drive (`C:\index.html`, ENOENT).
 * Riding in the path keeps both attached through relative asset resolution.
 *
 * Both are advisory: the host still prefers its own authoritative session
 * cwd and re-validates the resolved path, so forged values cannot widen
 * access.
 *
 * The decoder rebuilds the marker as a forward-slash `//server/share/...`
 * path. That form is intentionally platform-neutral: `node:path` resolves it
 * to `\\server\share\...` on win32 and `/server/share/...` on POSIX, so the
 * host's existing requireAbsolute + isWithin fence needs no platform signal
 * (a leading `//` is a legal POSIX absolute path, so no data is lost on
 * either platform).
 *
 * This module is intentionally dependency-free (no node imports, no wire
 * helpers) so the client bundle can import `encodeHtmlUrl` without tripping
 * the build-time purity gate; the host converts decode failures into
 * SidebarError responses at the route boundary.
 */

/** One decoded route reference. */
export interface HtmlRouteRef {
  sessionId: string
  /**
   * Absolute file path (leading slash; Windows drives keep their colon), or
   * a workspace-relative path when `relative` is true.
   */
  path: string
  /**
   * The client's cwd hint when the URL carried one. Advisory only: the host
   * prefers its attached session header and re-validates the resolved path.
   */
  cwd?: string
  /** Whether `path` is relative to the session workspace root. */
  relative?: boolean
}

/** Decode outcome: the reference, or a client-error description. */
export type HtmlDecodeResult =
  | { ok: true; ref: HtmlRouteRef }
  | { ok: false; status: 400 | 404; message: string }

/** The route prefix both encoders/decoders agree on. */
export const HTML_ROUTE_PREFIX = '/sidebar/html/'

/**
 * Prefix of the optional marker segments. `encodeURIComponent` encodes `$`,
 * so a raw segment starting with this character is unambiguously a marker.
 */
const MARKER = '$'

/** Marker carrying the session workspace root: `$c<encoded cwd>`. */
const CWD_MARKER = `${MARKER}c`

/** Marker declaring the path that follows workspace-relative: `$r`. */
const RELATIVE_MARKER = `${MARKER}r`

/**
 * Whether a path is absolute in any spelling the host accepts (POSIX root,
 * Windows drive, UNC). Mirrors the client's `isAbsolutePath`; kept local so
 * this module stays dependency-free for the client bundle's purity gate.
 */
function isAbsoluteSpelling(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
}

/**
 * Build the route URL for one file path (client + tests).
 * @param path - absolute, or relative to the session workspace root.
 * @param cwd - optional session cwd hint; see the module comment for why it
 * rides in the path instead of a query.
 */
export function encodeHtmlUrl(sessionId: string, path: string, cwd?: string): string {
  const unc = /^[\\/]{2}[^\\/]/.test(path)
  const relative = !isAbsoluteSpelling(path)
  const segments = path.split(/[\\/]+/).filter(segment => segment !== '')
  const markers = [
    ...(cwd !== undefined && cwd !== '' ? [`${CWD_MARKER}${encodeURIComponent(cwd)}`] : []),
    ...(relative ? [RELATIVE_MARKER] : []),
  ]
  const prefix = markers.length === 0 ? '' : `${markers.join('/')}/`
  return `${HTML_ROUTE_PREFIX}${encodeURIComponent(sessionId)}/${prefix}${unc ? '/' : ''}${segments.map(encodeURIComponent).join('/')}`
}

/**
 * Decode a route pathname into the session + file path (plus the optional
 * cwd hint and the relative flag). Rejects a wrong prefix (404), an empty
 * path, malformed percent encoding, and a missing sessionId or file path
 * (400). The caller still must bound the decoded path with the workspace
 * real-path guard — a decoded `..` segment resolves outside the cwd and is
 * refused there.
 */
export function decodeHtmlUrl(pathname: string): HtmlDecodeResult {
  if (!pathname.startsWith(HTML_ROUTE_PREFIX)) {
    return { ok: false, status: 404, message: 'not an html route' }
  }
  const rest = pathname.slice(HTML_ROUTE_PREFIX.length)
  if (rest === '') {
    return { ok: false, status: 400, message: 'invalid html route path' }
  }
  // Split first, decode after: the cwd marker must be read from the RAW
  // segment (a real path segment starting with '$' arrives as '%24…').
  const rawSegments = rest.split('/')
  let segments: string[]
  try {
    segments = rawSegments.map(segment => decodeURIComponent(segment))
  } catch {
    return { ok: false, status: 400, message: 'malformed URL encoding' }
  }
  const [sessionId, ...pathSegments] = segments
  if (sessionId === undefined || sessionId === '') {
    return { ok: false, status: 400, message: 'sessionId and file path are required' }
  }
  // Consume the marker segments that sit between the sessionId and the path.
  // They are read from the RAW segments (a real path segment starting with
  // '$' arrives as '%24…', so it can never be mistaken for a marker).
  let cwd: string | undefined
  let relative = false
  for (let index = 1; (rawSegments[index] ?? '').startsWith(MARKER); index += 1) {
    const decoded = pathSegments[0] ?? ''
    if (decoded.startsWith(CWD_MARKER)) {
      const value = decoded.slice(CWD_MARKER.length)
      if (value === '') {
        return { ok: false, status: 400, message: 'invalid cwd segment' }
      }
      cwd = value
    } else if (decoded === RELATIVE_MARKER) {
      relative = true
    } else {
      return { ok: false, status: 400, message: 'unknown marker segment' }
    }
    pathSegments.shift()
  }
  // An empty FIRST path segment is the UNC marker (encodeHtmlUrl emits
  // '<sid>//server/share/...' for UNC paths); the encoder filters empty
  // segments everywhere else, so an empty segment can only be the marker or
  // a malformed URL — both handled here.
  const unc = pathSegments[0] === ''
  const tail = unc ? pathSegments.slice(1) : pathSegments
  if (tail.length === 0 || tail.some(segment => segment === '')) {
    return { ok: false, status: 400, message: 'sessionId and file path are required' }
  }
  let path: string
  if (relative) {
    // Declared workspace-relative: rebuilding it with a leading '/' would
    // make Windows root it on the current drive. The host joins it onto the
    // session workspace instead.
    path = tail.join('/')
  } else if (unc) {
    // Rebuild the platform-neutral forward-slash form `//server/share/...`;
    // requireAbsolute() resolves it to the platform's own UNC/POSIX spelling.
    path = `//${tail.join('/')}`
  } else if (/^[A-Za-z]:$/.test(tail[0] ?? '')) {
    // A Windows drive segment ('D:') is the FIRST path segment of an encoded
    // drive path. Rejoining it with a leading slash would yield '/D:/work/...'
    // which node's path.resolve() mangles into 'D:\D:\work\...' on Windows —
    // the html route's workspace fence would then reject every drive path.
    // Keep the drive form slash-free so requireAbsolute() resolves it verbatim.
    path = tail.join('/')
  } else {
    path = `/${tail.join('/')}`
  }
  return {
    ok: true,
    ref: {
      sessionId,
      path,
      ...(cwd === undefined ? {} : { cwd }),
      ...(relative ? { relative: true } : {}),
    },
  }
}
