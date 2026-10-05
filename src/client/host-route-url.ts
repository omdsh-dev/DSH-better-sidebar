/**
 * Prefix-safe resolution of the plugin's own host routes (HTTP and WebSocket).
 *
 * The client half talks to the Host at `/sidebar/*`. Built with a leading
 * slash those URLs pin themselves to the ORIGIN ROOT, so a GUI served under a
 * reverse-proxy directory (`https://host/dataops/proxy/3080/`) sends every
 * request OUTSIDE the prefix: the JSON API answers 404, lazy chunks never
 * load, media and HTML previews stay blank, and the WebSockets close with
 * 1006. Resolving a RELATIVE path against the injected transport base keeps
 * the request under the page's own directory — the same shape DSH's own client
 * uses (`new URL(REMOTE_STREAM_MUX_PATH.slice(1), __DSH_TRANSPORT__?.streamBaseUrl
 * ?? document.baseURI)` in `@deepseek-ai/dsh-api-gateway`).
 *
 * The base is normalized to a directory first (search/hash dropped, trailing
 * slash forced) so a launch-token query cannot leak into the route and a
 * prefix written without its final slash cannot eat the last path segment.
 */
import { hostTransportBase } from './desktop-env.ts'

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
export function hostRouteUrl(path: string, baseUrl: string = hostTransportBase()): URL {
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
