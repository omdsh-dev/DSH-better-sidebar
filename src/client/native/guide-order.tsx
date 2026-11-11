/**
 * Shared start-page order editor: the settings section renders the list inline,
 * the guide's "More" menu renders it inside a dialog. Both act on the same
 * catalog/order/visibility vocabulary.
 */
import { createElement } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { NativeGuideEntry } from './guide-catalog.ts'
import { t } from '../locales.ts'
import { Switch } from '../Switch.tsx'
import { GuideRowsInput } from './guide-rows.tsx'
import css from './guide.module.css'

/** The list's actions; callers own persistence. */
export interface GuideOrderListProps {
  entries: readonly NativeGuideEntry[]
  hidden: Readonly<Record<string, boolean>>
  onMove: (key: string, delta: -1 | 1) => void
  onToggle: (key: string, hidden: boolean) => void
}

/** The inline order/visibility list. */
export function GuideOrderList({ entries, hidden, onMove, onToggle }: GuideOrderListProps) {
  return (
    <div className={css.orderList}>
      {entries.map((entry, index) => {
        const shown = hidden[entry.key] !== true
        const title = entry.title()
        const description = entry.description?.() ?? entry.kind
        return (
          <div className={clsx(css.orderRow, !shown && css.orderRowHidden)} key={entry.key}>
            <span className={css.orderIcon} aria-hidden="true">
              {entry.icon === undefined ? null : createElement(entry.icon, { size: 16 })}
            </span>
            <span className={css.orderText}>
              <span className={css.orderTitle}>{title}</span>
              <span className={css.orderDesc}>{description}</span>
            </span>
            <span className={css.orderActions}>
              <button
                type="button"
                className={css.orderButton}
                aria-label={`${t('guideOrder')}: ${title} ↑`}
                disabled={index === 0}
                onClick={() => { onMove(entry.key, -1) }}
              >
                <IconChevronUpOutlineRegular size={12} />
              </button>
              <button
                type="button"
                className={css.orderButton}
                aria-label={`${t('guideOrder')}: ${title} ↓`}
                disabled={index === entries.length - 1}
                onClick={() => { onMove(entry.key, 1) }}
              >
                <IconChevronDownOutlineRegular size={12} />
              </button>
              <Switch
                label={`${t('settingsGuideShow')}: ${title}`}
                checked={shown}
                onChange={(next) => { onToggle(entry.key, !next) }}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The order editor opened from the guide's "More" menu. */
export function GuideOrderDialog(props: GuideOrderListProps & {
  open: boolean
  onClose: () => void
  rows: number
  onRows: (rows: number) => void
}) {
  const { open, onClose, entries, hidden, onMove, onToggle, rows, onRows } = props
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('guideOrder')}
      closeLabel={t('dismiss')}
      footer={(
        <button type="button" className={css.dialogDone} onClick={onClose}>
          {t('settingsDone')}
        </button>
      )}
    >
      <div className={css.dialogRow}>
        <span className={css.dialogRowText}>
          <span className={css.dialogRowTitle}>{t('settingsGuideRowsTitle')}</span>
          <span className={css.dialogRowDesc}>{t('settingsGuideRowsDesc')}</span>
        </span>
        <GuideRowsInput
          value={rows}
          label={t('settingsGuideRowsTitle')}
          onCommit={onRows}
        />
      </div>
      <GuideOrderList entries={entries} hidden={hidden} onMove={onMove} onToggle={onToggle} />
    </Modal>
  )
}
