/**
 * The clue tab's help overlay (S9).
 *
 * A first-visit explainer over the TAB CONTENT ONLY (never the chat, other tabs
 * or the whole app), reopenable from the header's `?`. The state is a browser
 * local preference (`localStorage`), so it does not depend on an account, does
 * not travel between machines, and does not reappear on every session.
 *
 * The diagram expresses only real relations: sources provide resources, a clue
 * is ONE resource reference, a pack is a collection OF clues. Short copy covers
 * what the page does NOT do: the body/@ insert only drafts, pins copy nothing,
 * a workspace binding auto-provides references, and sending never fetches
 * bodies (the model reads them on demand through the read-only tools).
 *
 * Focus: opening focuses the close control, Tab stays inside the dialog, and
 * the container restores focus to the `?` button on close. Animation is a pure
 * fade that `prefers-reduced-motion` removes.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { VscReferences } from 'react-icons/vsc'
import { t } from '../../locales.ts'
import css from './clues-tab.module.css'

/** Props of the help dialog. */
export interface ClueHelpOverlayProps {
  onClose(): void
}

/** The first-visit marker key (per browser, not per account/session). */
export const CLUE_HELP_SEEN_KEY = 'dsh-better-sidebar:clues-help-seen-v1'

/** Whether the help was already shown in this browser. */
export function clueHelpSeen(): boolean {
  try {
    return window.localStorage.getItem(CLUE_HELP_SEEN_KEY) === '1'
  } catch {
    // A storage-denied host (private mode/embedded webview) shows the help
    // again; the reader can still close it. Never throw from a render path.
    return false
  }
}

/** Remember that the help was shown (best effort). */
export function markClueHelpSeen(): void {
  try {
    window.localStorage.setItem(CLUE_HELP_SEEN_KEY, '1')
  } catch {
    // Ignore: the overlay already worked for this visit.
  }
}

/** `window.setTimeout` handle used by the focus trap listeners. */
interface FocusableElement extends HTMLElement {
  disabled?: boolean
}

/** Every focusable child of the dialog, in DOM order. */
function focusablesOf(root: HTMLElement): FocusableElement[] {
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<FocusableElement>(selector)]
    .filter(element => element.offsetParent !== null || element === document.activeElement)
}

/** The help overlay. */
export function ClueHelpOverlay({ onClose }: ClueHelpOverlayProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || dialogRef.current === null) return
      const focusables = focusablesOf(dialogRef.current)
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const activeElement = document.activeElement
      if (event.shiftKey && (activeElement === first || activeElement === dialogRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [onClose])

  return (
    <div className={css.helpBackdrop} data-clue-help>
      <div
        ref={dialogRef}
        className={css.helpDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clue-help-title"
      >
        <div className={css.helpHead}>
          <h2 id="clue-help-title" className={css.helpTitle}>{t('clueHelpTitle')}</h2>
          <button
            ref={closeRef}
            type="button"
            className={css.iconButton}
            aria-label={t('clueHelpClose')}
            title={t('clueHelpClose')}
            onClick={onClose}
          >
            <IconCloseOutlineRegular size={16} />
          </button>
        </div>

        <div className={css.helpDiagram} role="img" aria-label={t('clueHelpDiagramAria')}>
          <div className={css.helpNode}>
            <span className={css.helpNodeTitle}>{t('clueHelpSourceLabel')}</span>
            <span className={css.helpNodeBody}>{t('clueHelpSourceBody')}</span>
          </div>
          <span className={css.helpArrow} aria-hidden="true">→</span>
          <div className={css.helpNode}>
            <span className={css.helpNodeTitle}><VscReferences size={16} /> {t('clueHelpClueLabel')}</span>
            <span className={css.helpNodeBody}>{t('clueHelpClueBody')}</span>
          </div>
          <span className={css.helpArrow} aria-hidden="true">→</span>
          <div className={css.helpNode}>
            <span className={css.helpNodeTitle}>{t('clueHelpPackLabel')}</span>
            <span className={css.helpNodeBody}>{t('clueHelpPackBody')}</span>
          </div>
        </div>

        <ul className={css.helpList}>
          <li>{t('clueHelpInsertBody')}</li>
          <li>{t('clueHelpPinBody')}</li>
          <li>{t('clueHelpBindBody')}</li>
          <li>{t('clueHelpReadBody')}</li>
        </ul>

        <div className={css.helpFoot}>
          <button type="button" className={css.primaryButton} onClick={onClose}>{t('close')}</button>
        </div>
      </div>
    </div>
  )
}
