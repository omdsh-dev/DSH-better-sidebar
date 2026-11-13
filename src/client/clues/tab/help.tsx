/** The three-step clue guide in the host's accessible modal layer. */
import { type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconContextInjectionOutlineRegular,
  IconFolderOpenRegular,
  IconLinkOutlineRegular,
  IconPaperPlaneOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from '../../locales.ts'
import css from './help.module.css'

export interface ClueHelpOverlayProps { onClose(): void }

/** Preserve the existing first-visit acknowledgment across the modal change. */
export const CLUE_HELP_SEEN_KEY = 'dsh-better-sidebar:clues-help-seen-v2'
export function clueHelpSeen(): boolean {
  try { return window.localStorage.getItem(CLUE_HELP_SEEN_KEY) === '1' } catch { return false }
}
export function markClueHelpSeen(): void {
  try { window.localStorage.setItem(CLUE_HELP_SEEN_KEY, '1') } catch { /* Storage is optional. */ }
}
export function forgetClueHelpSeen(): void {
  try { window.localStorage.removeItem(CLUE_HELP_SEEN_KEY) } catch { /* Storage is optional. */ }
}

export function ClueHelpOverlay({ onClose }: ClueHelpOverlayProps): ReactNode {
  return <Modal open onClose={onClose} title={t('clueHelpTitle')} closeLabel={t('clueHelpClose')}
    className={css.guideDialog} contentClassName={css.guideContent} backdropBlur={false}>
    <section className={css.guide} data-clue-help>
    <ol className={css.steps}>
      <li data-clue-help-step><IconFolderOpenRegular size={18} /><span><strong>{t('clueHelpSelectLabel')}</strong><small>{t('clueHelpSelectBody')}</small></span></li>
      <li data-clue-help-step><IconContextInjectionOutlineRegular size={18} /><span><strong>{t('clueHelpInsertLabel')}</strong><small>{t('clueHelpInsertBody')}</small></span></li>
      <li data-clue-help-step><IconPaperPlaneOutlineRegular size={18} /><span><strong>{t('clueHelpReadLabel')}</strong><small>{t('clueHelpReadBody')}</small></span></li>
    </ol>
    <p className={css.hint}><IconLinkOutlineRegular size={14} /><span>{t('clueHelpPackBody')}</span></p>
    </section>
  </Modal>
}
