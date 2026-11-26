import { useEffect, useId, useState } from 'react'
import { REWRITE_ACTIONS, REWRITE_PROMPTS, selectionPrompt, type SelectionSettings, type RewriteAction } from '../selection-settings.ts'
import { api, type GitModelCatalog } from './api.ts'
import { t } from './locales.ts'
import { ActionButton, Notice, SettingRow, TextArea, TextInput, ToggleSwitch } from './ui/index.ts'
import css from './selection-settings.module.css'

const labels = {
  rewrite: 'clueSelectionRewrite', translate: 'clueSelectionTranslate',
  expand: 'clueSelectionExpand', humanize: 'selectionHumanize', shorten: 'clueSelectionShorten', continue: 'clueSelectionContinue',
  insertMain: 'selectionInsertMain', insertSide: 'selectionInsertSide',
} as const

/** The settings document uses the same revision-guarded writer as the other groups. */
export function SelectionSettingsPanel({ value, sessionId, onChange }: {
  value: SelectionSettings; sessionId?: string; onChange(value: SelectionSettings): void
}) {
  const [catalog, setCatalog] = useState<GitModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const listId = useId()
  useEffect(() => {
    if (sessionId === undefined) return
    let active = true
    api.gitModels({ sessionId }).then(result => { if (active) setCatalog(result) }, cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [sessionId])
  const patch = (changes: Partial<SelectionSettings>): void => { onChange({ ...value, ...changes }) }
  const label = (id: string): string => value.customActions.find(action => action.id === id)?.name ?? t(labels[id as keyof typeof labels])
  const toggle = (id: string): React.ReactNode => <ToggleSwitch aria-label={label(id)} checked={!value.disabled[id]}
    onChange={enabled => { patch({ disabled: { ...value.disabled, [id]: !enabled } }) }} />
  const move = (ids: string[], id: string, delta: number): string[] => {
    const next = [...ids]
    const index = next.indexOf(id)
    const target = index + delta
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    return next
  }
  const orderButtons = (id: string, ids: string[], onOrder: (order: string[]) => void): React.ReactNode => <>
    <ActionButton variant="ghost" size="sm" disabled={ids.indexOf(id) === 0} aria-label={t('selectionOrderUp') + ': ' + label(id)}
      onClick={() => { onOrder(move(ids, id, -1)) }}>↑</ActionButton>
    <ActionButton variant="ghost" size="sm" disabled={ids.indexOf(id) === ids.length - 1} aria-label={t('selectionOrderDown') + ': ' + label(id)}
      onClick={() => { onOrder(move(ids, id, 1)) }}>↓</ActionButton>
  </>
  return <div className={css.root} data-selection-settings>
    <h2 className={css.heading}>{t('selectionSettings')}</h2>
    <p className={css.hint}>{t('selectionSettingsDesc')}</p>
    <SettingRow label={t('selectionEnabled')}><ToggleSwitch aria-label={t('selectionEnabled')} checked={value.enabled}
      onChange={enabled => { patch({ enabled }) }} /></SettingRow>
    <SettingRow label={t('selectionAutoRun')} description={t('selectionAutoRunDesc')}>
      <ToggleSwitch aria-label={t('selectionAutoRun')} checked={value.autoRun} onChange={autoRun => { patch({ autoRun }) }} />
    </SettingRow>
    {value.menuOrder.map(id => <SettingRow key={id} label={label(id)} data-selection-setting={id}>
      {orderButtons(id, value.menuOrder, menuOrder => { patch({ menuOrder: menuOrder as SelectionSettings['menuOrder'] }) })}{toggle(id)}
    </SettingRow>)}
    {(['insertMain', 'insertSide'] as const).map(id => <SettingRow key={id} label={label(id)}>{toggle(id)}</SettingRow>)}
    <h3 className={css.heading}>{t('clueSelectionRewrite')}</h3>
    {value.rewriteOrder.map(id => <div key={id} data-selection-setting={id}>
      <SettingRow label={label(id)}>
        {orderButtons(id, value.rewriteOrder, rewriteOrder => { patch({ rewriteOrder }) })}{toggle(id)}
      </SettingRow>
      <details className={css.editor}><summary>{t('selectionPrompt')}</summary>
        {!REWRITE_ACTIONS.includes(id as typeof REWRITE_ACTIONS[number]) && <TextInput aria-label={t('selectionActionName') + ': ' + label(id)}
          key={label(id)} defaultValue={label(id)} maxLength={100} onBlur={event => {
            const nextName = event.target.value.trim()
            if (nextName !== '') patch({ customActions: value.customActions.map(action => action.id === id ? { ...action, name: nextName } : action) })
          }} />}
        <TextArea aria-label={t('selectionPrompt') + ': ' + label(id)} key={selectionPrompt(value, id)} defaultValue={selectionPrompt(value, id)} rows={4} maxLength={8192}
          onBlur={event => {
            const nextPrompt = event.target.value.trim()
            if (REWRITE_ACTIONS.includes(id as typeof REWRITE_ACTIONS[number])) patch({ prompts: { ...value.prompts, [id]: nextPrompt || REWRITE_PROMPTS[id as RewriteAction] } })
            else if (nextPrompt !== '') patch({ customActions: value.customActions.map(action => action.id === id ? { ...action, prompt: nextPrompt } : action) })
          }} />
        {REWRITE_ACTIONS.includes(id as typeof REWRITE_ACTIONS[number])
          ? <ActionButton variant="ghost" size="sm" onClick={() => { patch({ prompts: { ...value.prompts, [id]: REWRITE_PROMPTS[id as RewriteAction] } }) }}>{t('selectionReset')}</ActionButton>
          : <ActionButton variant="ghost" size="sm" onClick={() => { patch({ customActions: value.customActions.filter(action => action.id !== id), rewriteOrder: value.rewriteOrder.filter(action => action !== id) }) }}>{t('delete')}</ActionButton>}
      </details>
    </div>)}
    <details className={css.editor}><summary>{t('selectionAddAction')}</summary>
      <TextInput aria-label={t('selectionActionName')} value={name} maxLength={100} onChange={event => { setName(event.target.value) }} />
      <TextArea aria-label={t('selectionPrompt')} value={prompt} rows={4} maxLength={8192} onChange={event => { setPrompt(event.target.value) }} />
      <ActionButton variant="ghost" disabled={!name.trim() || !prompt.trim() || value.customActions.length >= 20} onClick={() => {
        const id = 'custom-' + crypto.randomUUID()
        patch({ customActions: [...value.customActions, { id, name: name.trim(), prompt: prompt.trim() }], rewriteOrder: [...value.rewriteOrder, id] })
        setName(''); setPrompt('')
      }}>{t('selectionAddAction')}</ActionButton>
    </details>
    <h3 className={css.heading}>{t('clueSelectionTranslate')}</h3>
    <SettingRow label={t('selectionLanguage')} description={t('selectionLanguageHint')}>
      <TextInput aria-label={t('selectionLanguage')} placeholder={t('selectionUiLanguage')} defaultValue={value.translationLanguage} key={value.translationLanguage}
        maxLength={100} onBlur={event => { patch({ translationLanguage: event.target.value.trim() }) }} />
    </SettingRow>
    <SettingRow label={t('selectionModel')}>
      <TextInput aria-label={t('selectionModel')} placeholder={t('selectionFollowModel')} defaultValue={value.translationModel} key={value.translationModel}
        list={listId} maxLength={500} onBlur={event => {
          const route = event.target.value.trim()
          if (route === '' || /^[^/]+\/.+$/u.test(route)) { patch({ translationModel: route }); setError(null) }
          else setError(t('commitModelInvalid'))
        }} />
      <datalist id={listId}>{catalog?.providers.flatMap(provider => provider.models.map(model => <option key={provider.provider + '/' + model.id} value={provider.provider + '/' + model.id} />))}</datalist>
    </SettingRow>
    {error !== null && <Notice kind="error">{error}</Notice>}
  </div>
}
