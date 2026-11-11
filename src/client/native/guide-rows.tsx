/**
 * The maximum-row control shared by the settings section and the guide's
 * reorder dialog. One implementation keeps the clamping and the commit-on-
 * blur/Enter behavior identical in both places.
 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './guide.module.css'

/** Props of the shared row-count input. */
export interface GuideRowsInputProps {
  /** The stored maximum row count. */
  value: number
  /** Called with a validated count (safe integer >= 1). */
  onCommit: (rows: number) => void
  /** Accessible name. */
  label: string
}

/** A compact number input that commits on blur or Enter. */
export function GuideRowsInput({ value, onCommit, label }: GuideRowsInputProps) {
  const commit = (raw: string, input: HTMLInputElement): void => {
    const parsed = Number(raw)
    const next = Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : value
    if (next !== value) onCommit(next)
    input.value = String(next)
  }
  return (
    <Input
      key={value}
      type="number"
      min={1}
      step={1}
      className={css.rowsInput}
      defaultValue={String(value)}
      aria-label={label}
      onBlur={event => { commit(event.currentTarget.value, event.currentTarget) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}
