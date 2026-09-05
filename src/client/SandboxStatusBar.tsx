/**
 * The live sandbox status row of the two built-in web surfaces (HTML
 * preview and the browser tab): a green "sandbox on" state with a one-tap
 * TEMPORARY unlock, or a RED "sandbox off" state (global setting or the
 * temporary unlock) with a restore action. A surface may additionally expose
 * one persistent/global action in the same row (the browser uses it to write
 * `browserNoSandbox` for every browser tab and future session).
 *
 * The temporary unlock is component state only — it never writes the
 * global side card setting (`htmlViewerNoSandbox` / `browserNoSandbox`);
 * it lasts until the surface unmounts (tab switch / file switch) or the
 * user restores the sandbox from the row. Persistent actions are optional,
 * so the HTML preview keeps its existing local-only status controls.
 */
import clsx from 'clsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function SandboxStatusBar(props: {
  /** The effective sandbox state (global pref OR the local temporary unlock). */
  sandboxed: boolean
  /** Whether the sandbox is off due to the LOCAL temporary unlock (shows the restore action). */
  local: boolean
  /** The red-state explanation (e.g. "the page runs with full GUI privileges"). */
  dangerCopy: string
  onUnlock: () => void
  onRestore: () => void
  /** Optional persistent action (for example the browser-wide sandbox setting). */
  persistentAction?: {
    label: string
    title?: string
    pending?: boolean
    onClick: () => void
  }
}) {
  const { sandboxed, local, dangerCopy, onUnlock, onRestore, persistentAction } = props
  const persistentButton = persistentAction === undefined ? null : (
    <button
      type="button"
      className={css.sandboxAction}
      title={persistentAction.title}
      disabled={persistentAction.pending === true}
      aria-busy={persistentAction.pending === true ? 'true' : undefined}
      onClick={persistentAction.onClick}
    >
      {persistentAction.label}
    </button>
  )
  if (sandboxed) {
    const copy = t('sandboxStatusOn')
    return (
      <div className={clsx(css.sandboxStatus, css.sandboxStatusOn)}>
        <span className={css.sandboxDot} />
        <span className={css.sandboxStatusText} title={copy}>{copy}</span>
        <div className={css.sandboxActions}>
          <button
            type="button"
            className={css.sandboxAction}
            onClick={onUnlock}
          >
            {t('sandboxUnlock')}
          </button>
          {persistentButton}
        </div>
      </div>
    )
  }
  return (
    <div className={clsx(css.sandboxStatus, css.sandboxStatusOff)}>
      <span className={css.sandboxDot} />
      <span className={css.sandboxStatusText} title={dangerCopy}>{dangerCopy}</span>
      {(local || persistentButton !== null) && (
        <div className={css.sandboxActions}>
          {local && (
            <button
              type="button"
              className={css.sandboxAction}
              onClick={onRestore}
            >
              {t('sandboxRestore')}
            </button>
          )}
          {persistentButton}
        </div>
      )}
    </div>
  )
}
