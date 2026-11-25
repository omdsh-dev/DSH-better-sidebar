/** One 32px borderless row: workspace / title on the left, tools on the right. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './sidebar-toolbar.module.css'

/** Props of {@link SidebarToolbar}. */
export interface SidebarToolbarProps {
  readonly start?: ReactNode
  readonly end?: ReactNode
  readonly className?: string
}

/** The single top row of a sidebar surface. */
export function SidebarToolbar({ start, end, className }: SidebarToolbarProps): ReactNode {
  return (
    <div className={clsx(css.toolbar, className)} data-sidebar-toolbar>
      {start !== undefined && <div className={css.start}>{start}</div>}
      {end !== undefined && <div className={css.end}>{end}</div>}
    </div>
  )
}
