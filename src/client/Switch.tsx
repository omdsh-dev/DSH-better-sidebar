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
    // The parent's write is asynchronous. Derive the next value from the PROP
    // instead of the event's checkbox state: the controlled value can be reset
    // before React's change handler runs, which previously made a switch
    // impossible to turn back on.
    <label className={css.switch}>
      <input
        type="checkbox"
        className={css.switchInput}
        checked={checked}
        aria-label={label}
        onChange={() => { onChange(!checked) }}
      />
      <span className={css.switchTrack} aria-hidden="true">
        <span className={css.switchThumb} />
      </span>
    </label>
  )
}
