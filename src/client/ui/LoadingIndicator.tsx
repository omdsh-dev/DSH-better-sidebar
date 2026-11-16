/** Shared loading feedback. CSS motion stops with hidden pages and reduced motion. */
import type { AriaRole, ReactNode } from 'react'
import clsx from 'clsx'
import { t } from '../locales.ts'
import css from './loading-indicator.module.css'

export interface LoadingIndicatorProps {
  label?: ReactNode
  inline?: boolean
  /** Fill the available content area instead of occupying a status line. */
  centered?: boolean
  size?: number
  className?: string
  role?: AriaRole
}

export function LoadingIndicator({ label, inline = false, centered = false, size = centered ? 24 : 14, className, role = 'status' }: LoadingIndicatorProps): ReactNode {
  const text = label === undefined ? t('loading') : label
  return <span className={clsx(css.root, inline && css.inline, centered && css.centered, className)}
    role={role} aria-live={role === 'presentation' || role === 'none' ? undefined : 'polite'} aria-label={text === '' ? t('loading') : undefined}
    data-loading-indicator data-kind="loading" data-centered={centered || undefined}>
    <span className={css.glyph} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" focusable="false">
        <circle className={css.track} cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
    {text === '' || text === null ? null : <span className={css.label}>{text}</span>}
  </span>
}
