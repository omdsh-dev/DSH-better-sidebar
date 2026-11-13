import { forwardRef, type ComponentProps, type ReactNode } from 'react'
import clsx from 'clsx'
import { Menu as HostMenu, MenuSurface as HostMenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import design from './design.module.css'
import css from './menu.module.css'

/** Preserve the host's placement and keyboard contracts on a plugin surface. */
export function Menu({ listClassName, ...props }: ComponentProps<typeof HostMenu>): ReactNode {
  return <HostMenu {...props} listClassName={clsx(design.surface, css.menu, listClassName)} />
}

export const MenuSurface = forwardRef<HTMLDivElement, ComponentProps<typeof HostMenuSurface>>(function MenuSurface({ className, ...props }, ref) {
  return <HostMenuSurface {...props} ref={ref} className={clsx(design.surface, css.menu, className)} />
})
