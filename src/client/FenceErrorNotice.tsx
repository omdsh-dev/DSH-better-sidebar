/**
 * The workspace-fence refusal surface. The raw wire text (`path "..." is
 * outside workspace`) is never shown as-is: the editor / file-tree error
 * slots render the localized reason plus a one-click global off — the click
 * flips the `workspaceFence` pref through the settings route, adopts the
 * returned document into the store (so every prefs reader — the changes tab's open
 * guard, the settings page — flips with it), and calls `onDisabled` so the
 * caller retries the failed operation immediately.
 */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { t } from './locales.ts'
import { parsePrefs } from './prefs.ts'
import css from './sidebar.module.css'
import type { SidebarStore } from './state.ts'

export function FenceErrorNotice(props: { store: SidebarStore; onDisabled: () => void }) {
  const { store, onDisabled } = props
  const [busy, setBusy] = useState(false)
  const disable = (): void => {
    if (busy) return
    setBusy(true)
    api.settingsUpdate({ workspaceFence: false }).then((view) => {
      store.setPrefs(parsePrefs(view.value))
      onDisabled()
    }).catch((error: unknown) => {
      // The fence stays armed on failure (the notice remains, button
      // re-enabled); the console carries the cause.
      console.error('workspace fence disable failed', error)
      setBusy(false)
    })
  }
  return (
    <div className={css.fenceError}>
      <span>{t('fenceErrorReason')}</span>
      <Button variant="outline" disabled={busy} onClick={disable}>{t('fenceDisableAction')}</Button>
    </div>
  )
}
