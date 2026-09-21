/**
 * Loopback-authority recognition, shared by the host half and the browser
 * half so the two can never drift apart again.
 *
 * Two surfaces classify a hostname as "local" and must agree exactly:
 * - the host's `browser.probe` route refuses to probe local addresses
 *   (src/index.ts, via src/trust-fence.ts), and
 * - the browser tab's address-bar policy refuses to navigate to them
 *   (src/client/browser.ts).
 *
 * They used to carry private copies that had already drifted: the client
 * accepted `0.0.0.0` and the host did not, so `browser.probe` happily probed
 * `http://0.0.0.0:<port>/` while the address bar refused it. Both copies also
 * missed the IPv4-mapped IPv6 spellings (`::ffff:127.0.0.1`, `::ffff:7f00:1`),
 * which the OS routes straight to loopback — so the "loopback stays
 * unreachable" guarantee held for neither surface.
 *
 * Pure string/URL work, zero imports: safe in the browser bundle.
 */

/** Strip the brackets a URL host keeps on IPv6 literals and lowercase it. */
function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/** Whether a dotted quad sits in 127.0.0.0/8. */
function isLoopbackQuad(dotted: string): boolean {
  const parts = dotted.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a hostname names a loopback (or otherwise local) authority.
 *
 * Recognized: `localhost` and any `*.localhost` name, `127.0.0.0/8` in dotted
 * form, the IPv6 loopback `::1`, the unspecified addresses `0.0.0.0` and `::`
 * (connecting to them reaches the local host), and IPv4-mapped IPv6 literals
 * (`::ffff:127.0.0.1` and its canonical `::ffff:7f00:1` spelling) whose
 * embedded IPv4 address is loopback.
 *
 * WHATWG URL normalization already collapses the exotic spellings of a
 * loopback IPv4 address (`127.1`, `2130706433`, `0x7f000001`) to `127.0.0.1`,
 * so the dotted-quad branch covers them wherever the value came from a parsed
 * URL.
 *
 * @param hostname - a URL hostname (brackets optional).
 * @returns true when the authority is local.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  // IPv4-mapped IPv6, both spellings: the dotted tail and the canonical
  // hex form the URL parser produces for it.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (mappedDotted !== null) return isLoopbackQuad(mappedDotted[1]!)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mappedHex !== null) return (parseInt(mappedHex[1]!, 16) >> 8) === 0x7f
  return isLoopbackQuad(host)
}
