/**
 * The shared search field: a 32px host-styled input with a leading glyph and
 * optional trailing actions (clear, submit). Enter/Escape/IME semantics stay
 * with the caller — this component only owns the chrome.
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './search-field.module.css'

/** Props of {@link SearchField}. */
export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> {
  /** Leading glyph; the magnifier by default. */
  readonly icon?: ReactNode
  /** Trailing controls (clear, submit) rendered INSIDE the field frame. */
  readonly trailing?: ReactNode
  readonly className?: string
  readonly inputClassName?: string
}

/** The one 32px search field used by the tab, the packs and the task windows. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { icon, trailing, className, inputClassName, type = 'text', ...input },
  ref,
) {
  return (
    <div className={clsx(css.root, className)} role="search">
      <span className={css.icon} aria-hidden="true">{icon ?? <IconSearchOutlineRegular size={14} />}</span>
      <input {...input} ref={ref} type={type} className={clsx(css.input, inputClassName)} />
      {trailing !== undefined && <span className={css.trailing}>{trailing}</span>}
    </div>
  )
})
