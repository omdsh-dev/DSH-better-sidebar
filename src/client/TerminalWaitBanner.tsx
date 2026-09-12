/**
 * The "Agent 正在等待 {needle}" wait banner: rendered at the top of an
 * agent-owned terminal's view while the model blocks in terminal_wait_for.
 * The skip button asks the host to abort every active wait on the terminal
 * (`agent-pty.skip-wait`); the banner disappears when the host's next
 * agent-terminals push drops the waiting field — no optimistic UI. Kept in
 * its own module (no xterm imports) so jsdom tests can render it directly.
 */
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Cap the needle shown inline; the full text rides the title tooltip. */
const NEEDLE_DISPLAY_CAP = 80

/** Truncate one needle for inline display (title attr carries the full text).
 *  Cut by Unicode code points, not UTF-16 code units — a naive slice can split
 *  a surrogate pair at the cutoff and render a dangling replacement char. */
export function truncateNeedle(needle: string): string {
  const points = Array.from(needle)
  return points.length > NEEDLE_DISPLAY_CAP
    ? `${points.slice(0, NEEDLE_DISPLAY_CAP - 1).join('')}…`
    : needle
}

export function TerminalWaitBanner(props: { needle: string; onSkip: () => void }) {
  const { needle, onSkip } = props
  return (
    <div className={css.terminalWaitBanner}>
      <span
        className={css.terminalWaitNeedle}
        title={needle}
        role="status"
        aria-live="polite"
        aria-label={t('terminalWaitBanner', { needle })}
      >
        {t('terminalWaitBanner', { needle: truncateNeedle(needle) })}
      </span>
      <button type="button" className={css.terminalRetry} onClick={onSkip}>
        {t('terminalSkipWait')}
      </button>
    </div>
  )
}
