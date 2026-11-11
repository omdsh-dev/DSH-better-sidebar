/**
 * The shared on/off switch: a real checkbox (native semantics and focus)
 * driving a styled track/thumb. Used by the settings rows and the start-page
 * order list.
 */
import css from './Switch.module.css'

/** One labelled switch. */
export function Switch(props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  const { checked, onChange, label } = props
  return (
    <label className={css.switch}>
      <input
        type="checkbox"
        className={css.switchInput}
        checked={checked}
        aria-label={label}
        onChange={event => { onChange(event.currentTarget.checked) }}
      />
      <span className={css.switchTrack} aria-hidden="true">
        <span className={css.switchThumb} />
      </span>
    </label>
  )
}
