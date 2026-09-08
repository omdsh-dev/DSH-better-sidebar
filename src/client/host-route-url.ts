/**
 * Resolve one host-owned route through the GUI document base. This preserves
 * reverse-proxy prefixes (for example code-server's `/proxy/<port>/`) that
 * are intentionally absent from `location.origin`.
 */
export function hostRouteUrl(path: string, baseUrl: string = document.baseURI): URL {
  return new URL(path.replace(/^\/+/, ''), baseUrl)
}

/** Resolve one host-owned WebSocket route through the GUI document base. */
export function hostWebSocketUrl(path: string, baseUrl: string = document.baseURI): URL {
  const url = hostRouteUrl(path, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}
