import { forwardRef, useId, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import clsx from 'clsx'
import { isLikelyImeKey } from '../ime-guard.ts'
import kit from './kit.module.css'
import css from './controls.module.css'

type DataAttributes = { readonly [key: `data-${string}`]: string | number | boolean | undefined }
type InputProps = InputHTMLAttributes<HTMLInputElement> & DataAttributes

export const TextInput = forwardRef<HTMLInputElement, InputProps>(function TextInput({ className, type = 'text', ...props }, ref) {
  return <input {...props} ref={ref} type={type} className={clsx(kit.input, className)} />
})

export const NumberInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(function NumberInput({ className, ...props }, ref) {
  return <TextInput {...props} ref={ref} type="number" className={clsx(css.number, className)} />
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & DataAttributes>(function TextArea({ className, ...props }, ref) {
  return <textarea {...props} ref={ref} className={clsx(kit.input, css.textarea, className)} />
})

/** Keep the native input for forms, labels and keyboard operation. */
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(function Checkbox({ className, ...props }, ref) {
  return <span className={css.checkbox}>
    <input {...props} ref={ref} type="checkbox" className={clsx(css.checkboxInput, className)} />
    <span className={css.checkboxBox} aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
  </span>
})

export const ToggleSwitch = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & DataAttributes & {
  checked: boolean
  onChange(checked: boolean): void
}>(function ToggleSwitch({ checked, onChange, onClick, className, type = 'button', ...props }, ref) {
  return <button {...props} ref={ref} type={type} role="switch" aria-checked={checked}
    className={clsx(css.switch, className)} onClick={event => { onClick?.(event); if (!event.defaultPrevented) onChange(!checked) }}>
    <span className={css.switchTrack} aria-hidden="true"><span className={css.switchThumb} /></span>
  </button>
})

export interface TabOption {
  readonly [key: `data-${string}`]: string | number | boolean | undefined
  readonly value: string
  readonly label: ReactNode
  readonly disabled?: boolean
  readonly id?: string
  readonly controls?: string
  /** Hover text for a label the strip may clip (segmented tracks). */
  readonly title?: string
}

/** Automatic activation, roving focus and one Tab stop per tablist. */
export function Tabs({ value, options, onChange, ariaLabel, className, variant = 'plain' }: {
  value: string
  options: readonly TabOption[]
  onChange(value: string): void
  ariaLabel: string
  className?: string
  /** 'plain' is the hairline strip; 'segmented' is the full-width host track. */
  variant?: 'plain' | 'segmented'
}): ReactNode {
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const enabled = options.filter(option => !option.disabled)
  const segmented = variant === 'segmented'
  return <div ref={list} aria-orientation={'horizontal'} role="tablist" aria-label={ariaLabel} data-variant={variant}
    className={clsx(css.tabs, segmented && css.tabsSegmented, className)}>
    {options.map(option => <button {...Object.fromEntries(Object.entries(option).filter(([key]) => key.startsWith('data-')))} key={option.value} type="button" role="tab" id={option.id ?? id + option.value}
      aria-controls={option.controls} aria-selected={value === option.value} disabled={option.disabled} title={option.title}
      tabIndex={value === option.value || !enabled.some(item => item.value === value) && option === enabled[0] ? 0 : -1}
      className={clsx(css.tab, segmented && css.tabSegmented)} onClick={() => { onChange(option.value) }} onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || isLikelyImeKey(event.nativeEvent)) return
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || enabled.length === 0) return
        event.preventDefault()
        const current = enabled.findIndex(item => item.value === option.value)
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
        const step = event.key === 'ArrowRight' !== rtl ? 1 : -1
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + step + enabled.length) % enabled.length
        const next = enabled[index]!
        onChange(next.value)
        const focusNext = (): void => {
          const button = list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[options.indexOf(next)]
          button?.focus()
        }
        focusNext()
        // A settings write may render the parent before this handler returns;
        // focus the tab again on the committed DOM, not the detached one.
        queueMicrotask(focusNext)
      }}>{option.label}</button>)}
  </div>
}

export function SettingRow({ label, description, htmlFor, children, className, ...props }: HTMLAttributes<HTMLDivElement> & {
  label: ReactNode
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
}): ReactNode {
  return <div {...props} className={clsx(css.settingRow, className)}>
    <div className={css.settingCopy}>
      {htmlFor ? <label className={css.settingLabel} htmlFor={htmlFor}>{label}</label> : <div className={css.settingLabel}>{label}</div>}
      {description && <div className={css.settingDescription}>{description}</div>}
    </div>
    <div className={css.settingControl}>{children}</div>
  </div>
}
