/**
 * The workspace-fence refusal surface. The raw wire text (`path "..." is
 * outside workspace`) is never shown as-is: the editor / file-tree error
 * slots render the localized reason.
 *
 * Upstream pairs the reason with a one-click "turn the fence off" that flips
 * the `workspaceFence` pref through the settings route. This fork has no such
 * switch (0.18.1-tracy.1): the host's settings route refuses the pref, and
 * the fs routes ignore it — see fenceEnabledOf in src/index.ts for why a
 * multi-site host cannot offer it. A button that can only fail is not shown.
 */
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function FenceErrorNotice() {
  return (
    <div className={css.fenceError}>
      <span>{t('fenceErrorReason')}</span>
    </div>
  )
}
