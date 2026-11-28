/** Shared single and multiple choice control with host placement and keyboard behavior. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { Menu } from './Menu.tsx'
import css from './select-menu.module.css'

export interface SelectOption {
  readonly value: string
  readonly label: ReactNode
  readonly disabled?: boolean
  readonly icon?: ReactNode
  readonly description?: ReactNode
  readonly title?: string
}
interface SelectCommonProps {
  readonly options: readonly SelectOption[]
  readonly ariaLabel: string
  readonly disabled?: boolean
  readonly className?: string
  readonly title?: string
  readonly placeholder?: ReactNode
}
export type SelectMenuProps = SelectCommonProps & ({
  readonly value: string
  onChange(value: string): void
  readonly values?: never
  readonly onValuesChange?: never
} | {
  readonly values: readonly string[]
  onValuesChange(values: string[]): void
  readonly value?: never
  readonly onChange?: never
})

export function SelectMenu(props: SelectMenuProps): ReactNode {
  const { options, ariaLabel, disabled, className, title, placeholder } = props
  const [open, setOpen] = useState(false)
  // The host menu positions from an anchor POINT (rc.2 replaced the rect
  // callback), so the trigger's frame is sampled when the menu opens rather
  // than read during render.
  const [point, setPoint] = useState<{ x: number; y: number } | undefined>(undefined)
  const trigger = useRef<HTMLButtonElement>(null)
  const anchorAtTrigger = (): void => {
    const rect = trigger.current?.getBoundingClientRect()
    setPoint(rect === undefined ? undefined : { x: rect.x, y: rect.y })
  }
  const valueId = useId()
  const multiple = props.values !== undefined
  const selectedValues = props.values ?? [props.value]
  const selected = options.filter(option => selectedValues.includes(option.value))
  const selectedLabel = selected.length === 0 ? placeholder ?? props.value ?? ariaLabel
    : multiple ? selected.map(option => option.label).reduce<ReactNode[]>((labels, label, index) => index ? [...labels, ', ', label] : [label], [])
      : selected[0]!.label
  const locked = disabled === true || options.length === 0
  useEffect(() => { if (locked) setOpen(false) }, [locked])
  // The host menu is mounted only while open. Its rc.2 placement needs a DOM,
  // so an always-mounted (closed) menu would break the server-rendered
  // settings surfaces that render this control.
  return (
    <div className={css.root}>
      <button ref={trigger} type="button" className={clsx(css.trigger, className)}
        aria-label={ariaLabel} aria-describedby={valueId} aria-haspopup="menu" aria-expanded={open && !locked}
        title={title ?? selected[0]?.title ?? (typeof selectedLabel === 'string' ? selectedLabel : ariaLabel)}
        disabled={locked} onClick={() => { anchorAtTrigger(); setOpen(current => !current) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            anchorAtTrigger()
            setOpen(true)
          }
        }}>
        {!multiple && selected[0]?.icon}<span id={valueId} className={css.label}>{selectedLabel}</span><IconChevronDownOutlineRegular size={14} />
      </button>
      {open && !locked && (
        <Menu open onClose={() => { setOpen(false) }} portal compact autoFocus
          listClassName={css.list}
          anchorPoint={point} anchor={<span />}
          items={options.map(option => ({ id: option.value, disabled: option.disabled, icon: option.icon,
            label: option.description ? <span className={css.optionCopy}><span>{option.label}</span><span className={css.optionDescription}>{option.description}</span></span> : option.label }))}
          selectedId={multiple ? undefined : props.value} selectedIds={multiple ? props.values : undefined}
          onSelect={next => {
            if (locked || !options.some(option => option.value === next && !option.disabled)) return
            if (props.values !== undefined) {
              const values = new Set(props.values)
              if (values.has(next)) values.delete(next); else values.add(next)
              props.onValuesChange(options.filter(option => values.has(option.value)).map(option => option.value))
            } else {
              setOpen(false)
              // The host menu unmounts with the portal; return focus to the
              // trigger explicitly so keyboard users are not dropped on <body>.
              trigger.current?.focus()
              if (next !== props.value) props.onChange(next)
            }
          }} />
      )}
    </div>
  )
}
