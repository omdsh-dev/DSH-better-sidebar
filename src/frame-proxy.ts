/**
 * The two pure halves of the frame route: which URLs may be fetched, and how a document is
 * adjusted so it renders correctly when served from a different origin.
 *
 * WHY THE ROUTE EXISTS. Joomla sends `X-Frame-Options: SAMEORIGIN` by default and WordPress does
 * the same, so the sidebar's browser tab shows "refused to connect" for a perfectly healthy site.
 * Measured on 2026-08-31 against a freshly provisioned site: `curl` answered **200**, the frame
 * answered an error page. That header is set by the server and enforced by the browser — nothing
 * running inside the page can opt out of it. Only a third party that fetches the document and
 * serves it again can embed it, and this is that third party.
 *
 * TWO DESIGN DECISIONS, both pinned by `tests/frame-proxy.spec.ts`:
 *
 * 1. **Only the HTML document goes through the proxy. Every asset goes direct.** The injected
 *    `<base href>` is what does it: `/media/x.css` then resolves against the site itself rather
 *    than the dsh host. This is also correct rather than merely cheap — `X-Frame-Options` applies
 *    to embedded documents, never to images or stylesheets, so proxying those would copy bytes
 *    for nothing.
 *
 * 2. **Internal addresses are never fetched.** A route that takes an arbitrary url and fetches it
 *    is an SSRF door: it runs on the dsh host, so it reaches what the browser cannot — cloud
 *    metadata at `169.254.169.254`, private `10.x` networks, the machine's own loopback.
 *
 * WHAT THIS ROUTE DOES NOT DO, said plainly so nobody expects it to: cookies do not travel, so
 * any page behind a login renders logged out. It is a viewer, not a session.
 */

/** Why a URL cannot be framed, or `null` when it can. */
export type FrameRefusal = 'shape' | 'scheme' | 'local'

/** Private IPv4 ranges plus link-local, which carries cloud metadata endpoints. */
const PRIVATE_IPV4 = [
  /^10\./,
  /^192\.168\./,
  // 172.16.0.0/12 — the range STOPS at 172.31. `^172\.` would wrongly refuse public space.
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./
]

/**
 * Whether an address may be fetched on the server's behalf.
 *
 * Hostname checks only — deliberately. Resolving DNS here to catch a public name pointing at a
 * private address would be a different guard with a different failure mode (a name that resolves
 * differently between this check and the fetch), and the fetch itself is what would have to be
 * pinned. This refuses the addresses an attacker can write down directly.
 * @param raw The URL as given.
 * @returns The refusal, or `null` when the URL is allowed.
 */
export function frameUrlRefusal(raw: string): FrameRefusal | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'shape'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme'

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return 'local'
  if (/^127\./.test(host)) return 'local'
  if (PRIVATE_IPV4.some((range) => range.test(host))) return 'local'
  return null
}

/** `<head>` with any attributes, in any case, possibly spanning lines. */
const HEAD_OPEN = /<head\b[^>]*>/i
/** A `<base>` the page declares itself. */
const BASE_TAG = /<base\b[^>]*>/i

/**
 * Escape a URL for use inside a double-quoted HTML attribute.
 *
 * A `"` in the address would close the attribute early and turn the rest into further attributes
 * — which is how a link becomes an event handler.
 * @param value The URL.
 * @returns The escaped URL.
 */
function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Give a document a `<base>` so its relative links and assets still resolve against the site it
 * came from, not against the host serving this copy.
 *
 * A page that declares its own `<base>` is left ALONE. It knows better than we do, and the first
 * `<base>` in a document wins — so injecting one would silently change how every link on the page
 * resolves.
 * @param html The document as fetched.
 * @param baseUrl The address it was fetched from.
 * @returns The document, ready to be framed.
 */
/**
 * Where the frame route lives, as the browser reaches it: the authority a reverse proxy names in
 * `x-forwarded-host` (else `Host`), the scheme it names in `x-forwarded-proto`, and the mount
 * prefix the webserver reports for this request (`/site.example` when dsh is published under a
 * path, '' at the root). The injected navigation script appends `/sidebar/frame` to this.
 * @param headers - the incoming request headers.
 * @param mount - the request's mount prefix from `webServer.mountOf(req)`, '' at the root.
 * @returns the absolute prefix, or undefined when no authority is known (no script is injected then).
 */
export function hostOriginFor(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  mount = '',
): string | undefined {
  const first = (value: string | string[] | undefined): string =>
    (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() ?? ''
  const host = first(headers['x-forwarded-host']) || first(headers.host)
  if (host === '') return undefined
  const scheme = first(headers['x-forwarded-proto']) === 'https' ? 'https' : 'http'
  return `${scheme}://${host}${mount}`
}

export function frameableHtml(html: string, baseUrl: string, hostOrigin?: string): string {
  const tag = BASE_TAG.test(html) ? '' : `<base href="${attribute(baseUrl)}">`
  const script = hostOrigin === undefined ? '' : navigationScript(hostOrigin)
  if (tag === '' && script === '') return html
  const head = HEAD_OPEN.exec(html)
  if (head !== null) {
    const at = head.index + head[0].length
    return html.slice(0, at) + tag + script + html.slice(at)
  }
  // No `<head>` at all — a bare fragment, or markup the server built by hand. Prepending still
  // works: browsers hoist a leading `<base>` into the head they synthesise.
  return tag + script + html
}

/**
 * A small script that keeps in-page navigation inside the route.
 *
 * WHY IT IS NEEDED. The `<base>` that makes assets resolve against the origin site does the same
 * to every LINK — so the first click leaves the route, reaches the site directly, and meets the
 * `X-Frame-Options` refusal all over again. Measured 2026-08-31: the site rendered, then opening
 * one article gave "refused to connect".
 *
 * Rewriting `href` attributes in the markup was the alternative, and it is worse: it means
 * parsing HTML with regexes, and it misses everything built at runtime. A capture-phase listener
 * sees the DOM as it really is, including links a script added a moment ago.
 *
 * 🔒 The route URL is built against `hostOrigin`, ABSOLUTE. A relative one would resolve against
 * the `<base>` we just injected — straight back to the site it exists to avoid.
 *
 * Links that leave the site are left alone: they open as they normally would, and framing a
 * third-party page was never this route's job.
 * @param hostOrigin - where the route lives, e.g. `http://127.0.0.1:51730`.
 * @returns The script tag to inject.
 */
function navigationScript(hostOrigin: string): string {
  const origin = JSON.stringify(hostOrigin)
  return (
    `<script>(function(){var H=${origin};` +
    'function through(u){return H+"/sidebar/frame?url="+encodeURIComponent(u)}' +
    'addEventListener("click",function(e){' +
    'if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;' +
    'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;' +
    // `target=_blank` means the author wants a new tab; sending it through the route would
    // silently change that into an in-frame navigation.
    'if(a.target&&a.target!=="_self")return;' +
    'var u;try{u=new URL(a.href,document.baseURI)}catch(x){return}' +
    'if(u.protocol!=="http:"&&u.protocol!=="https:")return;' +
    'if(u.origin!==new URL(document.baseURI).origin)return;' +
    'e.preventDefault();location.href=through(u.href)},true);' +
    // Forms that GET on the same site (a search box, for instance) would leave too.
    'addEventListener("submit",function(e){' +
    'var f=e.target;if(!f||f.method&&f.method.toLowerCase()!=="get")return;' +
    'var u;try{u=new URL(f.action||document.baseURI,document.baseURI)}catch(x){return}' +
    'if(u.origin!==new URL(document.baseURI).origin)return;' +
    'e.preventDefault();' +
    'var q=new URLSearchParams(new FormData(f));u.search=q.toString();' +
    'location.href=through(u.href)},true);})()</script>'
  )
}

/** What a consumer plugin may attach to one framed request. */
export interface FrameCredentials {
  /** A `Cookie` header value, e.g. a viewing session the deployment minted for this host. */
  cookie?: string
  /** Extra request headers. */
  headers?: Record<string, string>
}

/**
 * A provider the deployment registers: given the target, say what to send with the request.
 *
 * Returning `null` (or nothing) means "send nothing extra", which is the default and the only
 * behaviour before a consumer registers one.
 */
export type FrameCredentialProvider = (url: URL) => Promise<FrameCredentials | null> | FrameCredentials | null

/** Header names a provider may never set, because they decide where the request actually goes. */
const RESERVED_HEADERS = new Set(['host', 'accept', 'content-length', 'connection', 'transfer-encoding'])

/** A header name or value carrying CR or LF splits one request into two. */
const SPLITS_REQUEST = /[\r\n]/

/**
 * Merge a provider's credentials into the route's own headers.
 *
 * WHY THIS IS A FUNCTION AND NOT A SPREAD. A provider is code written elsewhere, and the two ways
 * it can go wrong are both silent: a `host` override sends the body to a server the SSRF guard
 * never checked, and a CR or LF in a name or value splits the request in two — the far side then
 * reads a second request the author never wrote.
 *
 * Offending entries are DROPPED, not sanitised. Rewriting a value quietly changes what the caller
 * asked for; dropping it leaves the request exactly as the route built it.
 * @param base - the headers the route set for itself.
 * @param credentials - what the provider returned, if anything.
 * @returns The headers to send.
 */
export function frameRequestHeaders(
  base: Record<string, string>,
  credentials: FrameCredentials | null | undefined
): Record<string, string> {
  const out: Record<string, string> = { ...base }
  if (!credentials) return out
  if (typeof credentials.cookie === 'string' && !SPLITS_REQUEST.test(credentials.cookie)) {
    out.cookie = credentials.cookie
  }
  for (const [name, value] of Object.entries(credentials.headers ?? {})) {
    if (typeof value !== 'string') continue
    if (SPLITS_REQUEST.test(name) || SPLITS_REQUEST.test(value)) continue
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}
