/**
 * One collapsible workbench section: the VSCode-style `>` bar.
 *
 * The header is a native button inside its heading, so Enter/Space activation,
 * focus order and the pressed/expanded announcement come from the platform.
 * `actions` sit BESIDE that button (never inside it): a toolbar control must
 * stay clickable without collapsing or expanding the section.
 *
 * The body stays mounted while collapsed (`hidden`), which is what lets a
 * caller's draft — a range form, a search box, an uncommitted selection — come
 * back exactly as it was left. The owning page controls `open`; this component
 * only requests the next value through `onOpenChange`.
 */
import { useId, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './workbench-section.module.css'

/** Props of {@link WorkbenchSection}. */
export interface WorkbenchSectionProps {
  /** The full section title; rendered verbatim (never uppercased). */
  title: string
  /** Optional leading glyph, rendered at the caller's size. */
  icon?: ReactNode
  /** Optional trailing figure in the header (a count, a total, …). */
  count?: ReactNode
  /**
   * Header actions. Rendered as a SIBLING of the disclosure button so a click
   * on one cannot toggle the section.
   */
  actions?: ReactNode
  /** Controlled expanded state. */
  open: boolean
  /** Requested next state; the owner decides whether it sticks. */
  onOpenChange(open: boolean): void
  /** Section body. It remains mounted while collapsed. */
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** Optional heading id for callers that resolve the section by id. */
  headingId?: string
  /** 0 = the page's own section; 1 = a nested section (indented header). */
  level?: 0 | 1
  /**
   * fill (default) lets an open section take the slack; compact caps it at 40%
   * of the stack so a second open section stays reachable.
   */
  size?: 'fill' | 'compact'
}

/** The VSCode-style collapsible section. */
export function WorkbenchSection(props: WorkbenchSectionProps): ReactNode {
  const { title, icon, count, actions, open, onOpenChange, children, className, bodyClassName, headingId, level = 0, size = 'fill' } = props
  const bodyId = useId()
  return (
    <div
      className={clsx(css.root, className)}
      data-workbench-section
      data-open={open ? 'true' : 'false'}
      data-level={level}
      data-size={size}
    >
      <div className={css.header}>
        <h3 className={css.heading} id={headingId}>
          <button
            type="button"
            className={css.toggle}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => { onOpenChange(!open) }}
          >
            <span className={css.chevron} aria-hidden="true">
              {open
                ? <IconChevronDownOutlineRegular size={14} />
                : <IconChevronRightOutlineRegular size={14} />}
            </span>
            {icon !== undefined && <span className={css.icon} aria-hidden="true">{icon}</span>}
            <span className={css.title}>{title}</span>
            {count !== undefined && <span className={css.count}>{count}</span>}
          </button>
        </h3>
        {actions !== undefined && <div className={css.actions}>{actions}</div>}
      </div>
      <div id={bodyId} className={clsx(css.body, bodyClassName)} hidden={!open}>
        {children}
      </div>
    </div>
  )
}
