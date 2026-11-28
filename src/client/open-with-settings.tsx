/**
 * The editor tab's custom settings panel ("打开方式"): the file tree's
 * "open with" configuration — the optional SSH host marking the workspace as
 * remote, and the user-defined editors (name + URL template with `{path}` +
 * whether they speak the VSCode URL dialect). Persisted as the editor
 * blob's `openWith` key through the settings popup's `updatePluginSetting`.
 *
 * The popup renders the declarative rows (the editorExplorer picker) ABOVE
 * this panel — SettingsBody renders the custom panel after the row list, so
 * this component owns only its own section.
 */
import { useState } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import {
  isValidCustomEditor,
  newCustomEditorId,
  parseOpenWithConfig,
  type CustomEditor,
  type OpenWithConfig,
} from './open-with.ts'
import { ActionButton, Checkbox, IconButton, SettingRow, TextInput } from './ui/index.ts'
import { t } from './locales.ts'
import css from './SideCardSection.module.css'

export function OpenWithSettings(props: {
  pluginSettings: Record<string, unknown>
  updatePluginSetting: (key: string, value: unknown) => void
}) {
  const { pluginSettings, updatePluginSetting } = props
  // Local draft seeded from the persisted blob (each commit re-renders the
  // popup with the round-tripped prefs; the local state stays authoritative
  // while the popup is open, so typing never fights an in-flight write).
  const [draft, setDraft] = useState<OpenWithConfig>(() => parseOpenWithConfig(pluginSettings.openWith))

  const commit = (next: OpenWithConfig): void => {
    setDraft(next)
    updatePluginSetting('openWith', next)
  }

  const setSshHost = (sshHost: string): void => commit({ ...draft, sshHost })

  const patchCustom = (id: string, patch: Partial<CustomEditor>): void => {
    commit({
      ...draft,
      customEditors: draft.customEditors.map(editor => editor.id === id ? { ...editor, ...patch } : editor),
    })
  }

  const removeCustom = (id: string): void => {
    commit({
      ...draft,
      customEditors: draft.customEditors.filter(editor => editor.id !== id),
      // A removed editor can never stay pinned (the menu prunes unknown ids
      // anyway; this keeps the blob clean).
      pinned: draft.pinned.filter(pinnedId => pinnedId !== `custom:${id}`),
    })
  }

  const addCustom = (): void => {
    commit({
      ...draft,
      customEditors: [...draft.customEditors, { id: newCustomEditorId(), name: '', urlTemplate: '', isVscodeFamily: false }],
    })
  }

  const hasInvalid = draft.customEditors.some(editor => !isValidCustomEditor(editor))

  return (
    <div className={css.popupRows}>
      <SettingRow label={t('openWithSettingsSshTitle')} description={t('openWithSettingsSshDesc')} className={css.popupRow}>
        <TextInput
          className={css.typedInput}
          aria-label={t('openWithSettingsSshTitle')}
          value={draft.sshHost}
          placeholder={t('openWithSettingsSshPlaceholder')}
          spellCheck={false}
          onChange={(event) => { setSshHost(event.target.value) }}
        />
      </SettingRow>
      <SettingRow label={t('openWithSettingsCustomTitle')} className={css.popupRow}>
        <ActionButton onClick={addCustom}>{t('openWithSettingsAdd')}</ActionButton>
      </SettingRow>
      {draft.customEditors.map(editor => (
        <div key={editor.id} className={css.openWithEditorRow}>
          <TextInput
            className={css.openWithEditorInput}
            aria-label={t('openWithSettingsName')}
            value={editor.name}
            placeholder={t('openWithSettingsName')}
            spellCheck={false}
            onChange={(event) => { patchCustom(editor.id, { name: event.target.value }) }}
          />
          <TextInput
            className={css.openWithEditorTemplate}
            aria-label={t('openWithSettingsTemplate')}
            value={editor.urlTemplate}
            placeholder={t('openWithSettingsTemplate')}
            spellCheck={false}
            onChange={(event) => { patchCustom(editor.id, { urlTemplate: event.target.value }) }}
          />
          <label className={css.openWithFamily} title={t('openWithSettingsFamilyDesc')}>
            <Checkbox
              checked={editor.isVscodeFamily}
              onChange={(event) => { patchCustom(editor.id, { isVscodeFamily: event.currentTarget.checked }) }}
            />
            <span>{t('openWithSettingsFamily')}</span>
          </label>
          <IconButton icon={<IconCloseOutlineRegular size={14} />} label={t('openWithSettingsRemove')}
            danger onClick={() => { removeCustom(editor.id) }} />
        </div>
      ))}
      {hasInvalid && (
        <div className={css.openWithHint} role="note">
          {t('openWithSettingsInvalidHint')}
        </div>
      )}
    </div>
  )
}
