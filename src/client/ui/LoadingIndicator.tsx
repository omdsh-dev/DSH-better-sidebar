/** Shared loading feedback. CSS motion stops with hidden pages and reduced motion. */
import type { AriaRole, ReactNode } from 'react'
import clsx from 'clsx'
import { IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from '../locales.ts'
import css from './loading-indicator.module.css'

export interface LoadingIndicatorProps {
  label?: ReactNode
  inline?: boolean
  size?: number
  className?: string
  role?: AriaRole
}

export function LoadingIndicator({ label, inline = false, size = 14, className, role = 'status' }: LoadingIndicatorProps): ReactNode {
  const text = label === undefined ? t('loading') : label
  return <span className={clsx(css.root, inline && css.inline, className)}
    role={role} aria-live={role === 'presentation' || role === 'none' ? undefined : 'polite'} aria-label={text === '' ? t('loading') : undefined}
    data-loading-indicator data-kind="loading">
    <span className={css.glyph} aria-hidden="true"><IconLoadingOutlineRegular size={size} /></span>
    {text === '' || text === null ? null : <span className={css.label}>{text}</span>}
  </span>
}
