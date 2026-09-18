/**
 * Authority to build the sidebar's WebSocket URLs on.
 *
 * A browser deployment serves its UI and these routes from one origin, so the
 * page origin is that authority. The Electron desktop carrier instead serves
 * its UI from dsh-app://app — a custom scheme whose protocol handler never
 * upgrades a WebSocket — and publishes the loopback authority of its embedded
 * webServer on the transport seat it injects into that page. Sockets addressed
 * there pass the host's fence and reach the same routes.
 *
 * @returns scheme, host and port to resolve `/sidebar/ws/*` paths against.
 */
export function websocketAuthority(): string {
  const carrier = (globalThis as { __DSH_TRANSPORT__?: { webOrigin?: unknown } }).__DSH_TRANSPORT__
  const published = carrier?.webOrigin
  return typeof published === 'string' && published !== '' ? published : location.origin
}
