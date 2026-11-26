/**
 * The clue surfaces' non-blocking notice strip (S9 glue).
 *
 * Refused @ inserts, save conflicts and copy failures must be visible where the
 * gesture happened — the composer is outside the clue Tab, so the tab's own
 * inline error line is not enough. This module owns ONE plugin-created status
 * element pinned to the page corner (never a patch of host DOM), announced
 * politely, auto-dismissed, and re-used by every caller so a burst of failures
 * cannot stack a dozen strips.
 *
 * Colors ride the skin tokens (`--dsw-alias-*`), matching every other plugin
 * surface; the text never carries a token, a secret or raw stdout.
 */

/** How long one notice stays visible before it fades out. */
const NOTICE_TTL_MS = 5_000
/** The one live strip (module scope: one activation, one strip). */
let host: HTMLDivElement | undefined
let text: HTMLSpanElement | undefined
let timer: number | undefined

/** Remove the strip and its timer (HMR-safe; also the test seam). */
export function clearClueNotice(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }
  host?.remove()
  host = undefined
  text = undefined
}

/**
 * Show one user-visible notice for a few seconds.
 * @param message - already-localized text; never a raw error payload.
 */
export function notifyClue(message: string): void {
  if (message.trim() === '') return
  if (host === undefined || text === undefined || !host.isConnected) {
    clearClueNotice()
    host = document.createElement('div')
    host.setAttribute('data-dsh-better-sidebar-clue-notice', '')
    host.setAttribute('role', 'status')
    host.setAttribute('aria-live', 'polite')
    host.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'z-index:2147483001',
      'max-width:min(420px,calc(100vw - 24px))',
      'padding:8px 12px',
      'border-radius:8px',
      'border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))',
      'background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base))',
      'color:var(--dsw-alias-label-primary)',
      'font:12px/18px var(--dsw-font-family-base)',
      'overflow-wrap:anywhere',
      'pointer-events:none',
    ].join(';')
    text = document.createElement('span')
    host.appendChild(text)
    document.body.appendChild(host)
  }
  text.textContent = message
  if (timer !== undefined) window.clearTimeout(timer)
  timer = window.setTimeout(() => { clearClueNotice() }, NOTICE_TTL_MS)
}
