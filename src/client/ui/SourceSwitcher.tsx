/**
 * The shared single-source switcher: a full-width segmented track when the
 * surface is wide enough, and the same values as a select on narrow surfaces
 * (the Linear/VSCode rule: never a row of clipped buttons).
 *
 * Both forms render from ONE item list; CSS container queries pick the visible
 * one, so no measurement observer is involved. The hidden form is
 * `display: none` and therefore out of the tab order.
 */
import { useId, type ReactNode } from 'react'
import clsx from 'clsx'
import { Tabs } from './controls.tsx'
import { SelectMenu } from './SelectMenu.tsx'
import css from './source-switcher.module.css'

/** One selectable source: its stable id, the localized label and its glyph. */
export interface SourceSwitcherItem {
  readonly value: string
  readonly label: string
  readonly icon?: ReactNode
  readonly disabled?: boolean
  /** Full hover text when the segment label can clip. */
  readonly title?: string
}

/** Props of {@link SourceSwitcher}. */
export interface SourceSwitcherProps {
  readonly items: readonly SourceSwitcherItem[]
  readonly value: string
  onChange(value: string): void
  readonly ariaLabel: string
  readonly className?: string
}

/** The one full-width source selector. */
export function SourceSwitcher({ items, value, onChange, ariaLabel, className }: SourceSwitcherProps): ReactNode {
  const id = useId()
  if (items.length === 0) return null
  return (
    <div
      className={clsx(css.root, className)}
      data-clue-source-navigation
      data-clue-active-source={value}
      data-source-count={items.length}
    >
      <div className={css.wide}>
        <Tabs
          variant="segmented"
          value={value}
          onChange={onChange}
          ariaLabel={ariaLabel}
          className={css.tabs}
          options={items.map(item => ({
            value: item.value,
            id: `${id}-${item.value}`,
            title: item.title ?? item.label,
            ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
            label: (
              <span className={css.tabLabel}>
                {item.icon !== undefined && <span className={css.tabIcon} aria-hidden="true">{item.icon}</span>}
                <span className={css.tabText}>{item.label}</span>
              </span>
            ),
          }))}
        />
      </div>
      <div className={css.narrow}>
        <SelectMenu
          className={css.select}
          value={value}
          onChange={onChange}
          ariaLabel={ariaLabel}
          title={ariaLabel}
          options={items.map(item => ({
            value: item.value,
            label: item.label,
            ...(item.icon === undefined ? {} : { icon: item.icon }),
            ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
          }))}
        />
      </div>
    </div>
  )
}
