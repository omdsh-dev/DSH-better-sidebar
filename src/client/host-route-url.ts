/** Resolve one Host-owned client route against the injected document base.
 * @param path - Root-style or relative Host route path.
 * @param baseUrl - Browser document base or an explicit test base.
 * @returns The absolute route URL.
 */
export function hostRouteUrl(path: string, baseUrl: string = document.baseURI): URL {
  return new URL(path.replace(/^\/+/, ''), baseUrl)
}

/** Resolve one Host-owned WebSocket route against the injected document base.
 * @param path - Root-style or relative Host WebSocket route path.
 * @param baseUrl - Browser document base or an explicit test base.
 * @returns The absolute ws: or wss: route URL.
 */
export function hostWebSocketUrl(path: string, baseUrl: string = document.baseURI): URL {
  const url = hostRouteUrl(path, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}
