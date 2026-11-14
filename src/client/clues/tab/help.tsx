/** The three-step clue guide in the host's accessible modal layer. */
import { type ReactNode } from 'react'
import clsx from 'clsx'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconContextInjectionOutlineRegular,
  IconFolderOpenRegular,
  IconLinkOutlineRegular,
  IconPaperPlaneOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ActionButton } from '../../ui/index.ts'
import { t } from '../../locales.ts'
import design from '../../ui/design.module.css'
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
  return (
    <Modal
      open
      onClose={onClose}
      title={t('clueHelpTitle')}
      closeLabel={t('clueHelpClose')}
      className={clsx(design.surface, css.guideDialog)}
      contentClassName={css.guideContent}
      backdropBlur={false}
      footer={(
        <ActionButton variant="primary" size="sm" onClick={onClose}>
          {t('clueHelpDone')}
        </ActionButton>
      )}
    >
      <section className={css.guide} data-clue-help>
        <ol className={css.steps}>
          <li data-clue-help-step>
            <span className={css.stepHead}>
              <span className={css.stepIndex}>01</span>
              <IconFolderOpenRegular size={16} />
            </span>
            <strong>{t('clueHelpSelectLabel')}</strong>
            <small>{t('clueHelpSelectBody')}</small>
          </li>
          <li data-clue-help-step>
            <span className={css.stepHead}>
              <span className={css.stepIndex}>02</span>
              <IconContextInjectionOutlineRegular size={16} />
            </span>
            <strong>{t('clueHelpInsertLabel')}</strong>
            <small>{t('clueHelpInsertBody')}</small>
          </li>
          <li data-clue-help-step>
            <span className={css.stepHead}>
              <span className={css.stepIndex}>03</span>
              <IconPaperPlaneOutlineRegular size={16} />
            </span>
            <strong>{t('clueHelpReadLabel')}</strong>
            <small>{t('clueHelpReadBody')}</small>
          </li>
        </ol>
        <p className={css.hint}>
          <IconLinkOutlineRegular size={14} />
          <span>{t('clueHelpPackBody')}</span>
        </p>
      </section>
    </Modal>
  )
}
