/**
 * The plugin's last-resort diagnostic strip.
 *
 * `fail()` in `index.tsx` reports a thrown client-lifecycle error by pinning a
 * visible strip to the page: a blank panel must never be the only symptom.
 * This module owns that strip's DOM and its LIFECYCLE — one host element with
 * a stable id, one row per failure PHASE (a repeated failure updates its own
 * row instead of stacking another), a per-row close button, a row cap, and a
 * `clear()` for the fiber's disposer (issue #767).
 *
 * Deliberately dependency-free DOM: no React and no CSS module is reachable
 * from the paths that call it (the failure may BE a broken render), so the
 * colors ride skin token chains with the pre-skin hexes as the chain tails —
 * with no skin on the page it renders exactly as the old hardcoded bar did,
 * and any `--dsw-alias-*` skin re-themes it (guide §12: no hardcoded colors).
 */

/** The strip host's stable id: what the e2e lanes and a user-side cleanup
 *  script address, instead of the old z-index magic number. */
export const DIAGNOSTIC_STRIP_ID = 'dsh-better-sidebar-diagnostic'

/** Per-phase attribute, so one row can be told from another outside React. */
export const DIAGNOSTIC_PHASE_ATTR = 'data-dsh-better-sidebar-diagnostic-phase'

/** How many distinct phases one strip keeps before the oldest row is dropped.
 *  The strip reports failures; a page accumulating more than a handful of
 *  them is already beyond what the strip can usefully say. */
export const DIAGNOSTIC_MAX_ROWS = 4

/** The strip: report one phase's message, or clear everything it owns. */
export interface DiagnosticStrips {
  /** Show `message` for `phase` — replacing that phase's row when it exists. */
  report(phase: string, message: string): void
  /** Remove every row and the host (the fiber's disposer). */
  clear(): void
}

/** One phase's row plus the text node a repeat report rewrites. */
interface Row {
  readonly el: HTMLDivElement
  readonly text: HTMLSpanElement
}

/** Fixed bottom-left stack; the rows paint, the host only lays them out. */
const HOST_STYLE = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;'
  + 'display:flex;flex-direction:column;gap:6px;align-items:flex-start;pointer-events:none'

/** One bar — same paint as the pre-#767 element (token chains, hex tails). */
const ROW_STYLE = 'pointer-events:auto;max-width:100%;display:flex;gap:8px;align-items:flex-start;'
  + 'padding:8px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;'
  + 'color:var(--dsw-alias-state-error-primary,#f2a1a1);'
  + 'background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base,#1b1b22));'
  + 'border:1px solid var(--dsw-alias-state-error-primary,#f2a1a1);border-radius:8px;white-space:pre-wrap'

const TEXT_STYLE = 'flex:1 1 auto;min-width:0'

const CLOSE_STYLE = 'flex:0 0 auto;appearance:none;border:0;background:transparent;color:inherit;'
  + 'font:inherit;line-height:1;padding:0 2px;cursor:pointer;opacity:.7'

/**
 * Create one activation's strip registry. The instance is scoped to a client
 * activation (never a module-level singleton), so its disposer can hand the
 * page back exactly as it found it.
 */
export function createDiagnosticStrips(): DiagnosticStrips {
  let host: HTMLDivElement | undefined
  const rows = new Map<string, Row>()

  /** Mount a fresh host, adopting-and-emptying any leftover from a previous
   *  activation: one page never carries two strips under the same id. */
  const attach = (): HTMLDivElement => {
    const leftover = document.getElementById(DIAGNOSTIC_STRIP_ID)
    if (leftover !== null && leftover !== host) leftover.remove()
    const el = document.createElement('div')
    el.id = DIAGNOSTIC_STRIP_ID
    el.style.cssText = HOST_STYLE
    document.body.appendChild(el)
    host = el
    // The previous host took its rows with it.
    rows.clear()
    return el
  }

  /** Drop one phase's row; the host goes when its last row does. */
  const drop = (phase: string): void => {
    const row = rows.get(phase)
    if (row === undefined) return
    rows.delete(phase)
    row.el.remove()
    if (rows.size === 0) {
      host?.remove()
      host = undefined
    }
  }

  return {
    report(phase: string, message: string): void {
      try {
        const container = host !== undefined && host.isConnected ? host : attach()
        const existing = rows.get(phase)
        if (existing !== undefined) {
          existing.text.textContent = message
          return
        }
        const row = document.createElement('div')
        row.style.cssText = ROW_STYLE
        row.setAttribute(DIAGNOSTIC_PHASE_ATTR, phase)
        const text = document.createElement('span')
        text.style.cssText = TEXT_STYLE
        text.textContent = message
        const close = document.createElement('button')
        close.type = 'button'
        close.style.cssText = CLOSE_STYLE
        // The strip is English (and unlocalized) by construction: it reports
        // before/without the locale chain it is often reporting a failure OF.
        close.textContent = '\u00d7'
        close.title = 'Dismiss'
        close.setAttribute('aria-label', `Dismiss the ${phase} diagnostic`)
        close.addEventListener('click', () => { drop(phase) })
        row.append(text, close)
        container.appendChild(row)
        rows.set(phase, { el: row, text })
        if (rows.size > DIAGNOSTIC_MAX_ROWS) {
          const oldest = rows.keys().next().value
          if (oldest !== undefined) drop(oldest)
        }
      } catch {
        // Nothing left to report with.
      }
    },
    clear(): void {
      rows.clear()
      host?.remove()
      host = undefined
    },
  }
}
