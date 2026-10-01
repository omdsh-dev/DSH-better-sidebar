/**
 * A fresh random id for client code, safe in an insecure context.
 *
 * `crypto.randomUUID` exists only in a SECURE context (https, or a loopback
 * host): on plain http to any other host — a local stand such as
 * `http://<site>.tracy.test:51790` — it is `undefined`, and a bare call threw
 * inside the side-chat tab factory ("slot entry crashed in
 * 'sidebar.right.pane.tab'", measured 26/09/2026). `crypto.getRandomValues`
 * is available in every context, so it is the fallback; the time-based tail
 * covers a runtime with no Web Crypto at all (tests, old hosts).
 *
 * Every id the client bundle mints goes through here — never call
 * `crypto.randomUUID` directly in `src/client`.
 */

/** @returns a UUID when the runtime can make one, otherwise a random base-36 id. */
export function randomId(): string {
  const webCrypto = typeof crypto === 'undefined' ? undefined : crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16))
    // RFC 4122 version 4 layout, so the fallback has the same shape.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}
