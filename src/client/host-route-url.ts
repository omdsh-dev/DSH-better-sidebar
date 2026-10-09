/**
 * Prefix-safe resolution of the plugin's own host routes (HTTP and WebSocket).
 *
 * The client half talks to the Host at `/sidebar/*`. Built with a leading
 * slash those URLs pin themselves to the ORIGIN ROOT, so a GUI served under a
 * reverse-proxy directory (`https://host/dataops/proxy/3080/`) sends every
 * request OUTSIDE the prefix: the JSON API answers 404, lazy chunks never
 * load, media and HTML previews stay blank, and the WebSockets close with
 * 1006. Resolving a RELATIVE path against the page's own base keeps the
 * request under the page's own directory.
 *
 * The two transports need DIFFERENT bases, and the desktop shell is why:
 *
 * - **HTTP** rides the PAGE base (`document.baseURI`). In the Electron shell
 *   the page is `dsh-app://app/`, and the shell's protocol handler forwards
 *   every non-static path to the Host (`protocol.handle` → `forwardWebRequest`
 *   in the shell's `main.js`), so `dsh-app://app/sidebar/api/…` reaches the
 *   Host same-origin — the exact shape `fetch('/sidebar/api/…')` produced
 *   before the prefix fix. The shell also publishes
 *   `__DSH_TRANSPORT__.streamBaseUrl` = the Host's real origin
 *   (`new URL(hostUrl).origin`), which is a DIFFERENT origin from the page:
 *   sending the plugin's JSON POSTs there makes them cross-origin, and the
 *   plugin's routes answer no `Access-Control-Allow-*` headers (the shell's own
 *   UI avoids this by going through the same-origin forwarding), so the browser
 *   rejects them — every tree/git/editor request fails as "Failed to fetch".
 * - **WebSocket** needs that injected base: a custom scheme cannot host `ws:`,
 *   and `dsh-app://app`'s host is the literal string `app`, whose DNS lookup
 *   never completes (see `desktop-env.ts`). The Host accepts the shell page's
 *   origin on those sockets.
 */
import { hostHttpBase, hostTransportBase } from './desktop-env.ts'

/** Placeholder origin for the non-DOM case (specs / SSR): resolution needs an
 *  absolute base, but the caller never issues the resulting request. */
const PLACEHOLDER_ORIGIN = 'http://dsh.internal/'

/**
 * Resolve one host route against the injected base. Leading slashes are
 * stripped on purpose — keeping one would discard a reverse-proxy prefix.
 * @param path - The route, with or without a leading slash
 * (`sidebar/api/fs.tree`, `sidebar/ws/fs-watch`).
 * @param baseUrl - Override for the shared transport base; specs pass a static
 * prefix so resolution stays pure.
 * @returns The absolute route URL (the base's origin + any prefix included).
 */
export function hostRouteUrl(path: string, baseUrl: string = hostHttpBase()): URL {
  return new URL(path.replace(/^\/+/, ''), directoryBase(baseUrl))
}

/** {@link hostRouteUrl} with the `ws:`/`wss:` scheme `WebSocket` requires. */
export function hostWebSocketUrl(path: string, baseUrl: string = hostTransportBase()): URL {
  const url = hostRouteUrl(path, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

/**
 * Turn any transport base into a directory base: drop the query (the launch
 * token rides there) and the hash, then force a trailing slash. DSH serves the
 * GUI from a directory, so a base without the final slash is the same prefix
 * with the browser's own trailing-slash elision — resolving against it
 * verbatim would replace its last segment instead of appending to it.
 */
function directoryBase(baseUrl: string): string {
  const url = new URL(baseUrl === '' ? PLACEHOLDER_ORIGIN : baseUrl, PLACEHOLDER_ORIGIN)
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}
