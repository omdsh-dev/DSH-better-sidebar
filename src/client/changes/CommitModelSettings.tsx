/**
 * The Git card's pinned-model setting: which provider/model drafts commit
 * messages. It renders inside the card's settings popup through the
 * descriptor's `settings.render` seam because the option list is DISCOVERED
 * at runtime (`git.models` asks the harness LLM service what it can serve) —
 * a declarative toggle can only declare a static option set at registration.
 *
 * The value lives in the descriptor's own plugin-settings blob
 * (`pluginSettings.git.commitModel`) as a single `provider/model` string;
 * empty (or absent) means "follow the conversation", so a malformed or
 * dormant setting can never lock the feature out.
 */
import { useEffect, useState } from 'react'
import { api, type GitModelCatalog } from '../api.ts'
import { t } from '../locales.ts'
import type { SidebarSettingsRenderProps } from '../service.ts'
import css from './changes.module.css'

/** The plugin-owned setting key (mirrored host-side in src/index.ts). */
export const COMMIT_MODEL_SETTING_KEY = 'commitModel'

/** One `<option>` value: the route the host dispatches on. */
function routeValue(provider: string, model: string): string {
  return `${provider}/${model}`
}

export function CommitModelSettings(props: SidebarSettingsRenderProps) {
  const { store, pluginSettings, updatePluginSetting } = props
  const sessionId = store.getSnapshot().sessionId
  const stored = pluginSettings[COMMIT_MODEL_SETTING_KEY]
  const value = typeof stored === 'string' ? stored : ''
  const [catalog, setCatalog] = useState<GitModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    setError(null)
    api.gitModels({ sessionId })
      .then(view => { if (!cancelled) setCatalog(view) })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { cancelled = true }
  }, [sessionId])

  // Only providers that actually advertise a model can form a route: the
  // host refuses a `provider/` pair with an empty model half.
  const options = (catalog?.providers ?? []).flatMap(provider => provider.models.map(model => ({
    value: routeValue(provider.provider, model.id),
    label: `${provider.name} · ${model.name}`,
  })))

  return (
    <div className={css.commitModel}>
      <div className={css.commitModelTitle}>{t('commitModelTitle')}</div>
      <div className={css.commitModelDesc}>{t('commitModelDesc')}</div>
      <select
        className={css.commitModelSelect}
        value={value}
        disabled={sessionId === undefined}
        onChange={(event) => { updatePluginSetting(COMMIT_MODEL_SETTING_KEY, event.target.value) }}
      >
        <option value="">{t('commitModelFollow')}</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {catalog !== null && options.length === 0 && (
        <div className={css.commitModelHint}>{t('commitModelEmpty')}</div>
      )}
      {error !== null && <div className={css.gitError}>{error}</div>}
    </div>
  )
}
