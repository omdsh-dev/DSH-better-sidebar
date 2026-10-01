/**
 * Browser-trust fence for the sidebar routes, copied from the /api gateway's
 * fence in @deepseek-ai/dsh-client-connection
 * (src/api-request-trust.ts + src/loopback-hostname.ts, BSD-3-Clause,
 * copied here because the package does not export these helpers and the
 * plugin must not depend on its internals) with one addition: the desktop
 * shell's application origin, which reaches only the routes the shell does not
 * forward. Host-header loopback or a configured trusted authority passes;
 * cross-site browser markers refuse.
 * This is a DNS-rebinding / cross-site defense, not authentication.
 */
import type { IncomingHttpHeaders } from 'node:http'

/** The request facts the fence reads (structural subset of IncomingMessage). */
interface ApiTrustRequest {
  headers: IncomingHttpHeaders
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Origin of the Electron desktop shell's application page. The shell serves the
 * GUI from the `dsh-app:` scheme, so a page-initiated WebSocket handshake
 * carries this origin while the socket itself targets the Host's loopback
 * authority — an authority match is impossible by construction. The shell's own
 * request forwarder admits exactly this non-null origin and refuses every other
 * one; WebSocket upgrades bypass that forwarder (the scheme handler does not
 * carry them), which is why this fence is the first place the shell origin is
 * ever compared against a request.
 */
const SHELL_APP_ORIGIN = 'dsh-app://app'

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one sidebar request may reach the plugin routes.
 * @param request - node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
export function isTrustedApiRequest(request: ApiTrustRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin fence: when a browser attaches an Origin it must name this
  // hostname (the Host fence above already bound the authority, so the port
  // must not re-decide trust). Comparing hostname, not host: some Chromium
  // builds (Edge 151) serialize the Origin of a non-default-port loopback page
  // without the port, and refusing those bricks every /sidebar route. Absent
  // Origin is fine — the Host fence above already bound the request. The
  // literal "null" (sandboxed iframes, file: pages) is an opaque origin, refused.
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  // Checked only after the Host fence above bound the authority: the shell
  // page's fixed origin is admitted as itself, never as an authority.
  if (origin === SHELL_APP_ORIGIN) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
