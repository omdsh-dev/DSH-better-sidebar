/**
 * Key-capture input for the Side card shortcut rows: a button styled like
 * the settings controls that shows the current combo (platform-aware label,
 * e.g. `⌘B` / `Ctrl+B`) and records the NEXT key chord when focused/clicked.
 * Recording rules:
 * - any chord with mod/meta/ctrl/alt is captured and committed (canonical
 *   `mod+key` form via {@link comboFromEvent});
 * - Backspace/Delete disables the shortcut (commits '');
 * - Escape cancels without a change; blur also cancels;
 * - a bare key (no modifier) is refused — a shortcut must never fire while
 *   typing.
 * The button carries `data-dsh-shortcut-capture` so the global shortcut
 * listener skips it (recording Cmd+B must not toggle the panel mid-capture).
 */
import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { comboFromEvent, isMacPlatform, shortcutLabel } from './shortcut-combo.ts'
import { t } from './locales.ts'
import css from './KeyCaptureInput.module.css'

/** Props: the canonical combo ('' = disabled) and its commit callback. */
export interface KeyCaptureInputProps {
  value: string
  ariaLabel: string
  onChange: (combo: string) => void
  /** Optional element rendered after the key pill (e.g. a hint icon). */
  children?: ReactNode
}

/** The key-capture control (SSR-safe: recording state starts idle). */
export function KeyCaptureInput(props: KeyCaptureInputProps) {
  const { value, ariaLabel, onChange, children } = props
  const [capturing, setCapturing] = useState(false)
  const isMac = isMacPlatform()

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    // The capture control owns every key while recording: never let the
    // event reach the page (Space would re-click the button, Cmd+B would
    // otherwise toggle the panel through the global listener).
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setCapturing(false)
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      setCapturing(false)
      onChange('')
      return
    }
    if (event.nativeEvent.isComposing) return
    const combo = comboFromEvent(event, isMac)
    if (combo === '') return // lone modifier (or a refused bare key): keep recording
    setCapturing(false)
    onChange(combo)
  }

  const label = shortcutLabel(value, isMac)
  return (
    <button
      type="button"
      className={css.capture + (capturing ? ` ${css.capturing}` : '') + (label === '' ? ` ${css.disabled}` : '')}
      aria-label={ariaLabel}
      title={capturing ? t('shortcutCaptureHint') : ariaLabel}
      data-dsh-shortcut-capture=""
      onKeyDown={onKeyDown}
      onBlur={() => { setCapturing(false) }}
      onClick={() => { setCapturing(true) }}
    >
      {capturing ? t('shortcutCaptureHint') : (label === '' ? t('shortcutDisabled') : label)}
      {children}
    </button>
  )
}
