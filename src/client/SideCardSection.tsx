/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 *
 * The section is DECLARATIVE and GROUPED (S8). A wide layout shows the five
 * spec groups as a side navigation; below the repo's 768px narrow bracket a
 * native <select> replaces it, so 320/390px viewports never overflow:
 *  - 常规: the existing general + narrow-viewport ("手机") switches;
 *  - 标签页: one SMALL CARD per REGISTERED tab type (built-ins and external
 *    plugins alike), in a responsive grid, clicked to toggle
 *    `prefs.tabsEnabled[id]`, with the secondary-settings popup;
 *  - 文件预览: one SMALL CARD per REGISTERED file viewer
 *    (`prefs.viewersEnabled[id]`);
 *  - 线索来源: the S8 source table — source/@ switches, the derived
 *    dependency/connection state, the per-source configuration window, the
 *    local clue-pack @ switch, the four ONE-COMMIT batch actions and the
 *    add-source plugin entry;
 *  - 外观: the existing custom-CSS escape hatch.
 *
 * Every existing preference keeps its key, value and save semantics: writes
 * ride the plugin's own fenced settings route with the shared revision guard
 * (the S1 namespace discovered at runtime by the host's `ownEntryId`), the
 * shared SidebarStore is refreshed on success, and the sidebar's consumption
 * points re-render immediately. A 409 conflict now KEEPS the user's edit,
 * re-reads the revision and retries once; a still-failing write shows the
 * conflict copy and never claims the value was saved. A failed non-conflict
 * write reverts the optimistic UI, as before.
 *
 * No second settings store, namespace or RPC exists: both entry points (the
 * existing Sidebar settings seat and the host's plugin settings seat S9
 * mounts) use THIS component and the same inject faces. The clue source
 * catalogue comes from `ctx.betterSidebar.clues`, the source configuration
 * window from `ctx.betterSidebar.windows`, and dependency/connection calls
 * from the typed S8 wrapper (`clues.dependencies.*` / `clues.connections.*`).
 * Settings only ever store preferences and non-secret configuration — clue
 * bodies, pack members and snapshots never reach this document.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineRegular,
  Input,
  Menu,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarPrefs } from '../prefs-shared.ts'
import { api } from './api.ts'
import { parsePrefs } from './prefs.ts'
import { AddPluginModal, type PluginKind } from './add-plugin-modal.tsx'
import { t } from './locales.ts'
import type { SidebarStore } from './state.ts'
import type {
  BetterSidebarService,
  FileViewerDescriptor,
  SidebarSettingsRenderProps,
  SidebarSettingToggle,
  TabDescriptor,
} from './service.ts'
import type { BetterSidebarCluesClientFace } from './clues/registry.ts'
import { clueRuntimeApi, type ClueRuntimeApi } from './clues/runtime-api.ts'
import { SourceConfigPage } from './clues/settings/config.tsx'
import { ClueSourcesPanel } from './clues/settings/sources.tsx'
import { deriveClueSourceStatus, type ClueSourceStatus } from './clues/settings/status.ts'
import {
  consumeClueSettingsTarget,
  peekClueSettingsTarget,
  subscribeClueSettingsTarget,
  type ClueSettingsGroup,
} from './clues/settings/navigation.ts'
import type { BetterSidebarWindowsClientFace } from './windows/types.ts'
import type {
  ClueSourceDescriptor,
  ClueSourceDisplayDescriptor,
  CluesSourcesCatalogResult,
} from '../clues/types.ts'
import type {
  ConnectionStatusProjection,
  DependencyStatus,
} from '../clues/runtime/types.ts'
import css from './SideCardSection.module.css'

/** Injected business face: the shared store (prefs cache) + the sidebar service (registries). */
export interface SideCardSectionInjected {
  store: SidebarStore
  service: BetterSidebarService
  /**
   * Settings wire seam. Production omits it (the plugin's own fenced route);
   * tests/exotic hosts may inject the same two calls. Both entry points share
   * this ONE route — never a second settings store.
   */
  settings?: Pick<typeof api, 'settingsGet' | 'settingsUpdate'>
  /** Clue extension face (defaults to `service.clues` — `ctx.betterSidebar.clues`). */
  clues?: BetterSidebarCluesClientFace
  /** Window face (defaults to `service.windows` — `ctx.betterSidebar.windows`). */
  windows?: BetterSidebarWindowsClientFace
  /** S2 runtime wrapper (defaults to the S8 typed `clueRuntimeApi`). */
  runtime?: ClueRuntimeApi
  /** Initially visible group (deep-link/tests); defaults to the pending target then 常规. */
  initialGroup?: ClueSettingsGroup
}

/** Full section props: the runtime share plus the injected face. */
export type SideCardSectionProps = PropsRuntime<'settings.section'> & SideCardSectionInjected

/** The five groups, in navigation order (approved S8 spec §2). */
const SETTINGS_GROUPS: readonly { id: ClueSettingsGroup; label(): string }[] = [
  { id: 'general', label: () => t('settingsGeneralTitle') },
  { id: 'tabs', label: () => t('settingsGroupTabs') },
  { id: 'viewers', label: () => t('settingsViewersTitle') },
  { id: 'sources', label: () => t('settingsGroupSources') },
  { id: 'appearance', label: () => t('settingsGroupAppearance') },
]

/** The one-line wire failure text (no prefix). */
function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether one failure is the settings revision conflict (HTTP 409). */
function isSettingsConflict(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as { code?: unknown }).code === 'settings-conflict'
}

/** Map one wire failure to the inline message (the conflict gets friendly copy). */
function messageOf(error: unknown): string {
  if (isSettingsConflict(error)) {
    return `${t('settingsSaveFailed')} ${t('settingsConflict')}`
  }
  return `${t('settingsSaveFailed')} ${errorTextOf(error)}`
}

/** Resolve an i18n-friendly string-or-function value. */
function textOf(value: string | (() => string) | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'function' ? value() : value
}

/** Resolve a descriptor icon (ReactNode or size function). */
function iconOf(icon: ReactNode | ((size: number) => ReactNode) | undefined, size: number): ReactNode {
  if (icon === undefined) return null
  return typeof icon === 'function' ? icon(size) : icon
}

/** Tab inventory order: hidden types (editor/diff) last, then + menu order. */
function tabOrder(a: TabDescriptor, b: TabDescriptor): number {
  if (a.hidden !== b.hidden) return a.hidden === true ? 1 : -1
  return (a.order ?? 100) - (b.order ?? 100)
}

/** Viewer inventory order: priority desc (the catch-all `code` comes last). */
function viewerOrder(a: FileViewerDescriptor, b: FileViewerDescriptor): number {
  return (b.priority ?? 0) - (a.priority ?? 0)
}

/** Whether a feature declares any secondary settings (gear button shows). */
function hasSettings(feature: TabDescriptor | FileViewerDescriptor): boolean {
  const settings = feature.settings
  return settings !== undefined && (
    (settings.toggles?.length ?? 0) > 0
    || (settings.pluginToggles?.length ?? 0) > 0
    || settings.render !== undefined
  )
}

/** A feature's display name (viewers fall back to their id). */
function featureNameOf(feature: TabDescriptor | FileViewerDescriptor): string {
  return textOf('title' in feature ? feature.title : undefined) || feature.id
}

/**
 * Merge one plugin-owned setting into a pluginSettings map (pure, v0.12.0+).
 * Sequential merges are additive: each call spreads the map it was GIVEN,
 * so building from the latest optimistic map keeps earlier keys intact
 * (two same-tick writes must not drop each other).
 */
export function mergePluginSetting(
  pluginSettings: Record<string, Record<string, unknown>>,
  descriptorId: string,
  key: string,
  value: unknown,
): Record<string, Record<string, unknown>> {
  return {
    ...pluginSettings,
    [descriptorId]: { ...(pluginSettings[descriptorId] ?? {}), [key]: value },
  }
}

/**
 * Render a custom settings panel (`settings.render`) with error containment:
 * a throwing panel shows an inline error line instead of breaking the whole
 * settings page.
 */
function SettingsRender(props: {
  render: (renderProps: SidebarSettingsRenderProps) => ReactNode
  renderProps: SidebarSettingsRenderProps
}) {
  let content: ReactNode
  try {
    content = props.render(props.renderProps)
  } catch (error) {
    content = (
      <div className={css.error} role="alert">
        {t('settingsSaveFailed')} {errorTextOf(error)}
      </div>
    )
  }
  return <>{content}</>
}

/**
 * The custom switch: a real checkbox (hidden, native semantics and focus)
 * driving a styled track/thumb. Used by the general toggle rows and the
 * secondary settings popup rows. `disabled`/`title` let a row explain a locked
 * control (e.g. a feature whose settings are dormant while it is off).
 */
function Switch(props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}) {
  const { checked, onChange, label, disabled, title } = props
  return (
    <label className={css.switch} title={title}>
      <input
        type="checkbox"
        className={css.switchInput}
        checked={checked}
        disabled={disabled === true}
        aria-label={label}
        onChange={event => { onChange(event.currentTarget.checked) }}
      />
      <span className={css.switchTrack} aria-hidden="true">
        <span className={css.switchThumb} />
      </span>
    </label>
  )
}

/**
 * The body of a feature's secondary settings popup: one row (title/desc +
 * control) per declared setting. Switches render the custom switch; text and
 * number rows render a free-form / numeric input committed on blur/Enter
 * (clamped to the declared min/max). Extracted so the rows are testable
 * without opening the Modal (the Modal portal renders only while open).
 */
export function FeatureSettingsRows(props: {
  toggles: readonly SidebarSettingToggle[]
  prefs: SidebarPrefs
  onToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  /** Commit one text/number row; returns the canonical value the row should
   *  display (clamped for numbers, the current pref when the input is
   *  invalid). Optional: rows with no handler keep their draft. */
  onCommit?: (toggle: SidebarSettingToggle, raw: string) => string
  /** Commit one select row: the picked option's value (single) or the array
   *  of picked values (`multi: true`). Optional: rows with no handler are
   *  display-only. */
  onSelectValue?: (toggle: SidebarSettingToggle, next: unknown) => void
  /** Commit one patterns row: the whole string list after an add/remove.
   *  Optional: rows with no handler are display-only. */
  onPatterns?: (toggle: SidebarSettingToggle, next: string[]) => void
  /** Explicit value source (v0.12.0+): when given, rows read their values
   *  from it instead of the `prefs` face — plugin-owned rows read their
   *  own blob, so a plugin key can never collide with (or silently read)
   *  a host pref of the same name. (Named `valueSource`, not `valueOf`:
   *  the latter collides with the inherited Object.prototype.valueOf.) */
  valueSource?: (key: string) => unknown
}) {
  const { toggles, prefs, onToggle, onCommit, onSelectValue, onPatterns, valueSource } = props
  const read = valueSource ?? ((key: string): unknown => (prefs as unknown as Record<string, unknown>)[key])
  return (
    <div className={css.popupRows}>
      {toggles.map(toggle => {
        const title = textOf(toggle.title)
        if (toggle.type === 'patterns') {
          return (
            <PatternsRow
              key={toggle.key}
              toggle={toggle}
              title={title}
              value={read(toggle.key)}
              onPatterns={onPatterns}
            />
          )
        }
        if (toggle.type === 'select') {
          return (
            <SelectRow
              key={toggle.key}
              toggle={toggle}
              title={title}
              value={read(toggle.key)}
              onSelectValue={onSelectValue}
            />
          )
        }
        if ((toggle.type ?? 'switch') === 'switch') {
          return (
            <div key={toggle.key} className={css.popupRow}>
              <span className={css.rowText}>
                <span className={css.title}>{title}</span>
                {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
              </span>
              <Switch
                label={title}
                checked={read(toggle.key) === true}
                onChange={(next) => { onToggle(toggle, next) }}
              />
            </div>
          )
        }
        const value = String(read(toggle.key) ?? '')
        // Keyed by the committed value: a failed commit reverts prefs, the
        // key changes, and the row remounts with the stored value (typing
        // never changes the key, so mid-edit drafts survive re-renders).
        return (
          <TypedRow
            key={`${toggle.key}:${value}`}
            toggle={toggle}
            title={title}
            value={value}
            onCommit={onCommit}
          />
        )
      })}
    </div>
  )
}

/**
 * One text/number row: a controlled input whose draft is local state,
 * committed on blur/Enter through the parent's onCommit. The parent's
 * canonical return is adopted (clamped numbers, stored value for invalid
 * input); a `unit` suffix renders after the input (e.g. 'px').
 */
function TypedRow(props: {
  toggle: SidebarSettingToggle
  title: string
  value: string
  onCommit?: (toggle: SidebarSettingToggle, raw: string) => string
}) {
  const { toggle, title, value, onCommit } = props
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const canonical = onCommit?.(toggle, draft) ?? draft
    setDraft(canonical)
  }
  const number = toggle.type === 'number'
  return (
    <div className={css.popupRow}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
      </span>
      <span className={css.control}>
        <Input
          type={number ? 'number' : 'text'}
          className={number ? css.typedInputNumber : css.typedInput}
          value={draft}
          min={toggle.min}
          max={toggle.max}
          step={1}
          placeholder={toggle.placeholder}
          aria-label={title}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {toggle.unit !== undefined && <span className={css.suffix}>{toggle.unit}</span>}
      </span>
    </div>
  )
}

/**
 * The multi-line custom-CSS input (the user-space escape hatch): a monospace
 * textarea whose draft is local state, committed on blur or Cmd/Ctrl+Enter
 * through the parent's handler. Keyed by the stored value so an external
 * commit remounts it with the canonical text (same pattern as TypedRow).
 */
function CssDraft(props: {
  value: string
  onCommit: (raw: string) => void
  label: string
  placeholder?: string
}) {
  const { value, onCommit, label, placeholder } = props
  const [draft, setDraft] = useState(value)
  return (
    <textarea
      className={css.cssTextArea}
      rows={6}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onChange={event => { setDraft(event.currentTarget.value) }}
      onBlur={() => { onCommit(draft) }}
      onKeyDown={event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.blur()
      }}
    />
  )
}

/**
 * The reusable dropdown — the primitives Menu, NOT a native <select>: a
 * closed anchor button (picked option text + chevron) opening one Menu item
 * per option (big-icon cards when any option carries an icon). Single-pick
 * commits the option's value and closes; `multi` toggles membership and
 * commits the picked values as an array (in options order), staying open.
 * Used by the declarative select rows (SelectRow).
 */
function SelectMenu(props: {
  label: string
  value: unknown
  options: readonly {
    value: string | number | boolean
    title: string | (() => string)
    desc?: string | (() => string)
    icon?: ReactNode | ((size: number) => ReactNode)
  }[]
  multi?: boolean
  onSelect: (next: unknown) => void
  placeholder?: string
}) {
  const { label, value, options, multi, onSelect, placeholder } = props
  const [open, setOpen] = useState(false)
  const hasIcons = options.some(option => option.icon !== undefined)
  const picked: readonly unknown[] = multi ? (Array.isArray(value) ? value : []) : [value]
  const selected = options.filter(option => picked.includes(option.value))

  /** Commit one picked option (toggle semantics under multi). */
  const pick = (index: number): void => {
    const option = options[index]
    if (option === undefined) return
    if (!multi) {
      onSelect(option.value)
      setOpen(false)
      return
    }
    const current = Array.isArray(value) ? [...value] : []
    const at = current.indexOf(option.value)
    if (at >= 0) current.splice(at, 1)
    else current.push(option.value)
    // Stable wire order: follow the declared options order, not pick order.
    onSelect(options.filter(o => current.includes(o.value)).map(o => o.value))
  }

  const anchor = (
    <button
      type="button"
      className={css.selectAnchor}
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => { setOpen(now => !now) }}
    >
      {!multi && hasIcons && selected[0] !== undefined && (
        <span className={css.selectAnchorIcon}>{iconOf(selected[0].icon, 16)}</span>
      )}
      <span className={css.selectAnchorText}>
        {selected.length === 0 ? (placeholder ?? '—') : selected.map(option => textOf(option.title)).join(', ')}
      </span>
      <IconChevronDownOutlineRegular size={12} />
    </button>
  )

  return (
    <Menu
      open={open}
      anchor={anchor}
      items={options.map((option, index) => ({
        id: String(index),
        label: hasIcons
          ? (
            <span className={css.selectOption}>
              <span className={css.selectOptionIcon}>{iconOf(option.icon, 24)}</span>
              <span className={css.selectOptionText}>
                <span className={css.title}>{textOf(option.title)}</span>
                {textOf(option.desc) !== '' && <span className={css.desc}>{textOf(option.desc)}</span>}
              </span>
            </span>
          )
          : textOf(option.title),
      }))}
      selectedId={!multi && selected[0] !== undefined ? String(options.indexOf(selected[0])) : undefined}
      selectedIds={multi ? selected.map(option => String(options.indexOf(option))) : undefined}
      onSelect={(id) => { pick(Number(id)) }}
      onClose={() => { setOpen(false) }}
      portal
    />
  )
}

/**
 * One select row: a dropdown over the toggle's declared `options` (the
 * shared SelectMenu). When any option carries an icon, the dropdown renders
 * big-icon option cards (icon + title + desc) and the closed anchor shows
 * the selected option's icon as well; without icons both are a single line
 * of text. Single-pick commits the option's value and closes; `multi`
 * toggles membership, commits the picked values as an array (in options
 * order), and stays open.
 */
function SelectRow(props: {
  toggle: SidebarSettingToggle
  title: string
  value: unknown
  onSelectValue?: (toggle: SidebarSettingToggle, next: unknown) => void
}) {
  const { toggle, title, value, onSelectValue } = props
  return (
    <div className={css.popupRow}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
      </span>
      <span className={css.control}>
        <SelectMenu
          label={title}
          value={value}
          options={toggle.options ?? []}
          multi={toggle.multi === true}
          onSelect={(next) => { onSelectValue?.(toggle, next) }}
        />
      </span>
    </div>
  )
}

/**
 * One patterns row (`type: 'patterns'`): an editable string list — the
 * committed values render as removable chips, and a permanently-present
 * input adds new entries (Enter or the add button; blanks and duplicates
 * are dropped). Every add/remove commits the WHOLE list through the
 * parent's onPatterns — the list is one atomic pref value.
 */
function PatternsRow(props: {
  toggle: SidebarSettingToggle
  title: string
  value: unknown
  onPatterns?: (toggle: SidebarSettingToggle, next: string[]) => void
}) {
  const { toggle, title, value, onPatterns } = props
  const patterns = Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
  const [draft, setDraft] = useState('')
  const commitAdd = (): void => {
    const next = draft.trim()
    setDraft('')
    if (next === '' || patterns.includes(next)) return
    onPatterns?.(toggle, [...patterns, next])
  }
  return (
    <div className={css.patternsRow}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
      </span>
      {patterns.length > 0 && (
        <div className={css.patternsChips}>
          {patterns.map((pattern, index) => (
            <span key={`${pattern}:${index}`} className={css.patternsChip}>
              {pattern}
              <button
                type="button"
                className={css.patternsChipRemove}
                aria-label={`${t('explorerExcludeRemove')} ${pattern}`}
                title={t('explorerExcludeRemove')}
                onClick={() => { onPatterns?.(toggle, patterns.filter((_, at) => at !== index)) }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={css.patternsAdd}>
        <Input
          type="text"
          className={css.patternsInput}
          value={draft}
          placeholder={toggle.patternsPlaceholder ?? toggle.placeholder}
          aria-label={title}
          spellCheck={false}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitAdd()
            }
          }}
        />
        <button type="button" className={css.done} onClick={commitAdd}>
          {t('explorerExcludeAdd')}
        </button>
      </div>
    </div>
  )
}

/**
 * The secondary settings popup body of one feature (tab or viewer):
 * - the host-prefs `toggles` rows, then the plugin-owned `pluginToggles`
 *   rows (their values live in `pluginSettings[feature.id]`, projected onto
 *   the prefs face so the shared row renderer reads them);
 * - `settings.render` (custom panel) AFTER those rows when declared — the
 *   custom panel is an extension of the row list, not a replacement, so a
 *   feature can keep its declarative rows (e.g. the editor's
 *   open-behavior picker) and still ship a custom configuration area.
 */
export function SettingsBody(props: {
  feature: TabDescriptor | FileViewerDescriptor
  prefs: SidebarPrefs
  store: SidebarStore
  service: BetterSidebarService
  onToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  onCommit: (toggle: SidebarSettingToggle, raw: string) => string
  onSelectValue: (toggle: SidebarSettingToggle, next: unknown) => void
  onPatterns: (toggle: SidebarSettingToggle, next: string[]) => void
  onPluginToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  onPluginCommit: (toggle: SidebarSettingToggle, raw: string) => string
  onPluginSelectValue: (toggle: SidebarSettingToggle, next: unknown) => void
  onPluginPatterns: (toggle: SidebarSettingToggle, next: string[]) => void
  onPluginWrite: (key: string, value: unknown) => void
  onClose: () => void
}) {
  const { feature, prefs, store, service, onToggle, onCommit, onSelectValue, onPatterns, onPluginToggle, onPluginCommit, onPluginSelectValue, onPluginPatterns, onPluginWrite, onClose } = props
  const render = feature.settings?.render
  const toggles = feature.settings?.toggles ?? []
  const pluginToggles = feature.settings?.pluginToggles ?? []
  if (render === undefined && toggles.length === 0 && pluginToggles.length === 0) return null
  // Plugin rows read their values from the descriptor's OWN blob through
  // an explicit value source — no projection onto the prefs face, so a
  // plugin key can never collide with (or silently read) a host pref of
  // the same name.
  const pluginBlob = prefs.pluginSettings[feature.id] ?? {}
  return (
    <div>
      {(toggles.length > 0 || pluginToggles.length > 0) && (
        <div className={css.popupRows}>
          {toggles.length > 0 && (
            <FeatureSettingsRows
              toggles={toggles}
              prefs={prefs}
              onToggle={onToggle}
              onCommit={onCommit}
              onSelectValue={onSelectValue}
              onPatterns={onPatterns}
            />
          )}
          {pluginToggles.length > 0 && (
            <FeatureSettingsRows
              toggles={pluginToggles}
              prefs={prefs}
              onToggle={onPluginToggle}
              onCommit={onPluginCommit}
              onSelectValue={onPluginSelectValue}
              onPatterns={onPluginPatterns}
              valueSource={(key) => pluginBlob[key]}
            />
          )}
        </div>
      )}
      {render !== undefined && (
        <SettingsRender
          render={render}
          renderProps={{
            store,
            service,
            prefs,
            pluginSettings: prefs.pluginSettings[feature.id] ?? {},
            updatePluginSetting: onPluginWrite,
            close: onClose,
          }}
        />
      )}
    </div>
  )
}

/** One settings-write outcome (the conflict outcome keeps the optimistic edit). */
interface CommitOutcome {
  readonly ok: boolean
  readonly prefs: SidebarPrefs
  /** A 409 happened: the edit stays on screen and the copy says it is unsaved. */
  readonly keepEdit?: boolean
}

/**
 * Render the Side card preferences section.
 * @param props - composed slot props (runtime share + injected store/service).
 * @returns the section element tree.
 */
export function SideCardSection(props: SideCardSectionProps) {
  const { store, service } = props
  const settingsFace = props.settings ?? api
  const clues = props.clues ?? service.clues
  const windows = props.windows ?? service.windows
  const runtime = props.runtime ?? clueRuntimeApi

  const [prefs, setPrefs] = useState<SidebarPrefs>(() => store.getPrefs())
  const [error, setError] = useState<string | null>(null)
  // Which feature's secondary settings popup is open (null = closed).
  const [settingsFor, setSettingsFor] = useState<TabDescriptor | FileViewerDescriptor | null>(null)
  // Whether the "add plugin" modal is open, and for which extension point
  // (null = closed). The source entry reuses the TAB plugin flow.
  const [addPluginsOpen, setAddPluginsOpen] = useState<PluginKind | null>(null)
  // The LATEST optimistic prefs, kept in sync with the state. Nested-map
  // merges (tabsEnabled / viewersEnabled / pluginSettings / clue source maps)
  // MUST build from this ref, not from the render-time `prefs`: two same-tick
  // writes (e.g. a settings panel updating several plugin keys at once) would
  // otherwise both spread the stale map and the later patch would drop the
  // earlier key even though the commits are serialized.
  const optimisticRef = useRef(prefs)
  useEffect(() => { optimisticRef.current = prefs }, [prefs])

  // The active settings group. A pending deep link (Tab gear → Clue sources)
  // seeds it; the mount effect consumes it exactly once.
  const [group, setGroup] = useState<ClueSettingsGroup>(() =>
    props.initialGroup ?? peekClueSettingsTarget()?.group ?? 'general')
  const consumedTargetRef = useRef(false)
  const pendingSourceRef = useRef<string | undefined>(undefined)

  // The declarative inventory: the registered tab types and file viewers.
  const [tabs, setTabs] = useState<TabDescriptor[]>(() => [...service.getTabs()].sort(tabOrder))
  const [viewers, setViewers] = useState<FileViewerDescriptor[]>(() => [...service.getFileViewers()].sort(viewerOrder))
  useEffect(() => service.subscribe(() => {
    setTabs([...service.getTabs()].sort(tabOrder))
    setViewers([...service.getFileViewers()].sort(viewerOrder))
  }), [service])

  // Clue source displays (client-registered names/icons) follow the registry.
  const [displays, setDisplays] = useState<readonly ClueSourceDisplayDescriptor[]>(() => clues.getSourceDisplays())
  useEffect(() => clues.subscribe(() => { setDisplays(clues.getSourceDisplays()) }), [clues])

  // Clue source catalogue + S2 statuses. Loaded ONLY when the Clue sources
  // group is opened (an explicit status read — no timer, no auto-login).
  const [catalogue, setCatalogue] = useState<CluesSourcesCatalogResult | null>(null)
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [dependencyStatuses, setDependencyStatuses] = useState<readonly DependencyStatus[]>([])
  const [connectionStatuses, setConnectionStatuses] = useState<readonly ConnectionStatusProjection[]>([])
  const [dependencyProbeFailed, setDependencyProbeFailed] = useState(false)
  const [connectionProbeFailed, setConnectionProbeFailed] = useState(false)
  // Sanitized one-line reason of a failed status read. It is rendered on the
  // affected rows (their derived state is request-failed), not as a page
  // banner pretending the WHOLE list failed.
  const [statusProbeError, setStatusProbeError] = useState<string | null>(null)
  const [statusChecked, setStatusChecked] = useState(false)
  const sourcesLoadedRef = useRef(false)
  const sourcesRequestRef = useRef(0)
  const catalogueRef = useRef<CluesSourcesCatalogResult | null>(null)
  useEffect(() => { catalogueRef.current = catalogue }, [catalogue])
  const displaysRef = useRef(displays)
  useEffect(() => { displaysRef.current = displays }, [displays])

  /** Read the catalogue, then the S2 status projections it needs. */
  const loadSources = useCallback(async (): Promise<void> => {
    const request = sourcesRequestRef.current + 1
    sourcesRequestRef.current = request
    setSourcesLoading(true)
    setSourcesError(null)
    try {
      const catalogueNext = await clues.api.sources()
      if (request !== sourcesRequestRef.current) return
      setCatalogue(catalogueNext)
      const needsDependencies = catalogueNext.sources.some(source => (source.dependencyIds?.length ?? 0) > 0)
      const needsConnections = catalogueNext.sources.some(source => source.connectionId !== undefined)
      let dependenciesNext: readonly DependencyStatus[] = []
      let connectionsNext: readonly ConnectionStatusProjection[] = []
      let dependenciesFailed = false
      let connectionsFailed = false
      if (needsDependencies) {
        try {
          dependenciesNext = await runtime.dependenciesInspect()
        } catch (caught) {
          dependenciesFailed = true
          if (request === sourcesRequestRef.current) setStatusProbeError(errorTextOf(caught))
        }
      }
      if (needsConnections) {
        try {
          connectionsNext = await runtime.connectionsStatus()
        } catch (caught) {
          connectionsFailed = true
          if (request === sourcesRequestRef.current) setStatusProbeError(errorTextOf(caught))
        }
      }
      if (request !== sourcesRequestRef.current) return
      setDependencyStatuses(dependenciesNext)
      setConnectionStatuses(connectionsNext)
      setDependencyProbeFailed(dependenciesFailed)
      setConnectionProbeFailed(connectionsFailed)
      setStatusChecked(true)
    } catch (caught) {
      if (request === sourcesRequestRef.current) {
        setSourcesError(errorTextOf(caught))
        setStatusChecked(true)
      }
    } finally {
      if (request === sourcesRequestRef.current) setSourcesLoading(false)
    }
  }, [clues, runtime])

  useEffect(() => {
    if (group !== 'sources' || sourcesLoadedRef.current) return
    sourcesLoadedRef.current = true
    void loadSources()
  }, [group, loadSources])

  /** Explicit reload of the source list (the panel's Retry action). */
  const reloadSources = (): void => {
    sourcesLoadedRef.current = true
    void loadSources()
  }

  /** Derived per-source state (never ready before an observation completed). */
  const statusById = useMemo(() => {
    const map = new Map<string, ClueSourceStatus>()
    for (const source of catalogue?.sources ?? []) {
      const needsDependencies = (source.dependencyIds?.length ?? 0) > 0
      map.set(source.sourceId, deriveClueSourceStatus({
        dependencyIds: source.dependencyIds,
        connectionId: source.connectionId,
        dependencies: dependencyStatuses,
        connections: connectionStatuses,
        requestFailed: (needsDependencies && dependencyProbeFailed)
          || (source.connectionId !== undefined && connectionProbeFailed),
        ...(statusProbeError === null ? {} : { requestFailedDetail: statusProbeError }),
        checked: statusChecked,
      }))
    }
    return map
  }, [catalogue, dependencyStatuses, connectionStatuses, dependencyProbeFailed, connectionProbeFailed, statusProbeError, statusChecked])

  /** Open one source's S6 configuration window (stable identity = focus). */
  const openSourceConfig = useCallback((source: ClueSourceDescriptor): void => {
    const display = displaysRef.current.find(item => item.sourceId === source.sourceId)
    const name = display?.name ?? (source.name.trim() === '' ? source.sourceId : source.name)
    windows.open({
      id: `clue-source:${source.sourceId}`,
      title: t('clueConfigTitle', { source: name }),
      size: 'collection',
      content: (
        <SourceConfigPage
          sourceId={source.sourceId}
          sourceName={name}
          dependencyIds={source.dependencyIds ?? []}
          {...(source.connectionId === undefined ? {} : { connectionId: source.connectionId })}
          runtime={runtime}
        />
      ),
    })
  }, [windows, runtime])

  /** Open by id; remember it until the catalogue is available. */
  const openSourceConfigById = useCallback((sourceId: string): void => {
    const source = catalogueRef.current?.sources.find(item => item.sourceId === sourceId)
    if (source === undefined) {
      pendingSourceRef.current = sourceId
      return
    }
    pendingSourceRef.current = undefined
    openSourceConfig(source)
  }, [openSourceConfig])

  // Consume the one-shot deep link and follow later ones while mounted.
  useEffect(() => {
    if (!consumedTargetRef.current) {
      consumedTargetRef.current = true
      const target = consumeClueSettingsTarget()
      if (target !== undefined) {
        setGroup(target.group)
        if (target.sourceId !== undefined) openSourceConfigById(target.sourceId)
      }
    }
    return subscribeClueSettingsTarget(target => {
      setGroup(target.group)
      if (target.sourceId !== undefined) openSourceConfigById(target.sourceId)
    })
  }, [openSourceConfigById])

  // A deep-linked source may arrive after the catalogue; open it once known.
  useEffect(() => {
    const pending = pendingSourceRef.current
    if (pending === undefined || catalogue === null) return
    const source = catalogue.sources.find(item => item.sourceId === pending)
    if (source === undefined) {
      pendingSourceRef.current = undefined
      return
    }
    pendingSourceRef.current = undefined
    openSourceConfig(source)
  }, [catalogue, openSourceConfig])

  // The settings document revision (guards concurrent writes). A ref: commits
  // read the freshest value at execution time, no re-render needed.
  const revisionRef = useRef<number | undefined>(undefined)
  // Whether the user already wrote since mount: the mount read must not
  // clobber a newer optimistic edit (the window is milliseconds, but a slow
  // route must never silently revert a just-made change).
  const dirtyRef = useRef(false)
  // Serialize commits: a queued write must observe the previous write's
  // revision; a failed write must not poison the queue for later ones.
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())

  // Sync the persisted document once on mount: the revision and the current
  // values (another tab may have changed them since the store hydrated).
  useEffect(() => {
    let cancelled = false
    void settingsFace.settingsGet().then((view) => {
      if (cancelled) return
      revisionRef.current = view.revision
      if (dirtyRef.current) return
      const next = parsePrefs(view.value)
      // Refresh the shared store too: both settings entry points render this
      // ONE component against the same store and revision chain.
      store.setPrefs(next)
      setPrefs(next)
    }).catch(() => { /* the store's defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [settingsFace, store])

  // Another surface's save refreshes this mounted surface (same store).
  useEffect(() => store.subscribe(() => {
    setPrefs(store.getPrefs())
  }), [store])

  /**
   * Persist one patch through the settings route (serialized, revision-guarded).
   * A 409 is NOT a failure of the user's intent: re-read the revision while
   * keeping the edit on screen, then retry the same patch once.
   */
  const commit = (patch: Record<string, unknown>): Promise<CommitOutcome> => {
    dirtyRef.current = true
    let conflicted = false
    const write = async (): Promise<{ value?: unknown; revision?: number }> =>
      settingsFace.settingsUpdate({ ...patch }, revisionRef.current)
    const run = inFlightRef.current.then(async () => {
      let view: { value?: unknown; revision?: number }
      try {
        view = await write()
      } catch (caught) {
        if (!isSettingsConflict(caught)) throw caught
        conflicted = true
        // Keep the edit; fence the retry on the freshly read revision.
        const refreshed = await settingsFace.settingsGet()
        revisionRef.current = refreshed.revision
        view = await write()
      }
      const next = parsePrefs(view.value)
      revisionRef.current = view.revision
      store.setPrefs(next)
      return next
    })
    // A failed commit must not poison the queue: later writes still run.
    inFlightRef.current = run.then(() => undefined, () => undefined)
    return run.then(
      (next) => ({ ok: true, prefs: next }),
      (caught) => {
        setError(messageOf(caught))
        return conflicted
          ? { ok: false, prefs, keepEdit: true }
          : { ok: false, prefs }
      },
    )
  }

  /** Settle one commit: success adopts the server values; a conflict keeps the edit. */
  const applyOutcome = (previous: SidebarPrefs, outcome: CommitOutcome): void => {
    if (outcome.ok) setPrefs(outcome.prefs)
    else if (outcome.keepEdit !== true) setPrefs(previous)
  }

  /** Optimistically apply one pref patch, then commit (revert on failure). */
  const applyPref = (patch: Record<string, unknown>): void => {
    const previous = optimisticRef.current
    const next = { ...previous, ...patch } as SidebarPrefs
    optimisticRef.current = next
    setPrefs(next)
    setError(null)
    void commit(patch).then(outcome => applyOutcome(previous, outcome))
  }

  /** Flip one per-tab enable switch (merge into the tabsEnabled map). */
  const onToggleTab = (id: string, next: boolean): void => {
    applyPref({ tabsEnabled: { ...optimisticRef.current.tabsEnabled, [id]: next } })
  }

  /** Flip one per-viewer enable switch (merge into the viewersEnabled map). */
  const onToggleViewer = (id: string, next: boolean): void => {
    applyPref({ viewersEnabled: { ...optimisticRef.current.viewersEnabled, [id]: next } })
  }

  /** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
  const onToggleSetting = (toggle: SidebarSettingToggle, next: boolean): void => {
    applyPref({ [toggle.key]: next })
  }

  /** Commit one declaratively-declared select row (the option's value, or an
   *  array of values under `multi`). */
  const onSelectSetting = (toggle: SidebarSettingToggle, next: unknown): void => {
    applyPref({ [toggle.key]: next })
  }

  /** Commit one declaratively-declared patterns row (the whole string list). */
  const onPatternsSetting = (toggle: SidebarSettingToggle, next: string[]): void => {
    applyPref({ [toggle.key]: next })
  }

  /**
   * Commit one declaratively-declared text/number row. Numbers are parsed
   * and clamped to the toggle's declared min/max (an unparsable input falls
   * back to the CURRENT stored value, mirroring the width row); text rows
   * persist as-is (empty is meaningful, e.g. the theme-default font).
   * Returns the canonical value the row should display.
   */
  const onCommitSetting = (toggle: SidebarSettingToggle, raw: string): string => {
    if (toggle.type === 'number') {
      const parsed = Number(raw)
      const fallback = String((prefs as unknown as Record<string, unknown>)[toggle.key] ?? '')
      if (!Number.isFinite(parsed)) return fallback
      let clamped = Math.round(parsed)
      if (toggle.min !== undefined) clamped = Math.max(toggle.min, clamped)
      if (toggle.max !== undefined) clamped = Math.min(toggle.max, clamped)
      applyPref({ [toggle.key]: clamped })
      return String(clamped)
    }
    applyPref({ [toggle.key]: raw })
    return raw
  }

  /** Commit the free-form custom CSS (the user-space escape hatch). */
  const commitCustomCss = (raw: string): void => {
    applyPref({ customCss: raw })
  }

  /** Persist one plugin-owned setting of one descriptor (merged into the pluginSettings blob). */
  const applyPluginSetting = (descriptorId: string, key: string, value: unknown): void => {
    applyPref({ pluginSettings: mergePluginSetting(optimisticRef.current.pluginSettings, descriptorId, key, value) })
  }

  /** Flip one plugin-owned switch row (same row shape, plugin-scoped key). */
  const onPluginToggle = (descriptorId: string, toggle: SidebarSettingToggle, next: boolean): void => {
    applyPluginSetting(descriptorId, toggle.key, next)
  }

  /** Commit one plugin-owned text/number row (clamped like the host rows). */
  const onPluginCommitSetting = (descriptorId: string, toggle: SidebarSettingToggle, raw: string): string => {
    if (toggle.type === 'number') {
      const parsed = Number(raw)
      const blob = prefs.pluginSettings[descriptorId] ?? {}
      const fallback = String(blob[toggle.key] ?? '')
      if (!Number.isFinite(parsed)) return fallback
      let clamped = Math.round(parsed)
      if (toggle.min !== undefined) clamped = Math.max(toggle.min, clamped)
      if (toggle.max !== undefined) clamped = Math.min(toggle.max, clamped)
      applyPluginSetting(descriptorId, toggle.key, clamped)
      return String(clamped)
    }
    applyPluginSetting(descriptorId, toggle.key, raw)
    return raw
  }

  /** The currently registered source ids (the batch-action scope). */
  const registeredSourceIds = (): string[] =>
    (catalogueRef.current?.sources ?? []).map(source => source.sourceId)

  /** Flip one source enable switch (merged clueSourcesEnabled map). */
  const onToggleSource = (sourceId: string, next: boolean): void => {
    applyPref({ clueSourcesEnabled: { ...optimisticRef.current.clueSourcesEnabled, [sourceId]: next } })
  }

  /** Flip one source @ switch (merged clueSourcesMentionEnabled map). */
  const onToggleSourceMention = (sourceId: string, next: boolean): void => {
    applyPref({ clueSourcesMentionEnabled: { ...optimisticRef.current.clueSourcesMentionEnabled, [sourceId]: next } })
  }

  /** Flip the independent clue-pack @ switch. */
  const onTogglePacksMention = (next: boolean): void => {
    applyPref({ cluePacksMentionEnabled: next })
  }

  /**
   * Batch-write one source map ONCE. Only the ids registered RIGHT NOW are
   * named; a source added later stays absent (= ON), so an "all off" can
   * never become a hidden "never allow future sources" policy.
   */
  const setAllSources = (next: boolean): void => {
    const ids = registeredSourceIds()
    if (ids.length === 0) return
    const map = { ...optimisticRef.current.clueSourcesEnabled }
    for (const id of ids) map[id] = next
    applyPref({ clueSourcesEnabled: map })
  }

  /** Batch-write the @ map ONCE, with the same future-source rule. */
  const setAllSourceMentions = (next: boolean): void => {
    const ids = registeredSourceIds()
    if (ids.length === 0) return
    const map = { ...optimisticRef.current.clueSourcesMentionEnabled }
    for (const id of ids) map[id] = next
    applyPref({ clueSourcesMentionEnabled: map })
  }

  /**
   * One SMALL toggle card for the responsive inventory grid: the card's main
   * area is the switch (click to flips, visual state IS the state), the icon
   * sits in a rounded chip, the check badge pins to the far right, and a
   * feature that declares related settings gets a labeled SETTINGS STRIP
   * across the card's bottom edge (gear icon + text) opening its settings
   * popup — discoverable at rest, not a hover-only ghost corner button.
   */
  const renderCard = (props: {
    title: string
    desc: string
    icon?: ReactNode
    enabled: boolean
    onToggle: (next: boolean) => void
    /** A feature with declared related settings shows the settings strip. */
    onOpenSettings?: () => void
  }) => {
    const hasSettingsStrip = props.onOpenSettings !== undefined
    return (
      <div
        className={clsx(css.card, props.enabled && css.cardOn)}
      >
        <button
          type="button"
          className={css.cardMain}
          aria-pressed={props.enabled}
          title={props.desc}
          onClick={() => { props.onToggle(!props.enabled) }}
        >
          <span className={css.cardTop}>
            {props.icon !== null && props.icon !== undefined && (
              <span className={css.cardIconChip}>{props.icon}</span>
            )}
            <span className={css.cardTitle}>{props.title}</span>
            {props.enabled && (
              <span className={css.cardSwitch} aria-hidden="true">
                <span className={css.cardSwitchTrack}>
                  <span className={css.cardSwitchThumb} />
                </span>
              </span>
            )}
          </span>
          <span className={css.cardDesc}>{props.desc}</span>
        </button>
        {hasSettingsStrip && (
          <button
            type="button"
            className={css.cardSettings}
            aria-label={`${props.title} ${t('settingsPopup')}`}
            onClick={props.onOpenSettings}
          >
            <IconSettingsOutlineRegular size={12} />
            <span>{t('settingsPopup')}</span>
          </button>
        )}
      </div>
    )
  }

  /**
   * The tab inventory: one card per registered tab type + the dashed
   * add-plugin entry (the same cards as before the grouping refactor).
   */
  const renderTabsGroup = () => (
    <div className={css.group}>
      <div className={css.groupHeading}>
        <span>{t('settingsGroupTabs')}</span>
        <span className={css.count}>{tabs.length}</span>
      </div>
      <div className={css.grid}>
        {tabs.map(tab => (
          <Fragment key={tab.id}>
            {renderCard({
              title: textOf(tab.title),
              desc: tab.id,
              icon: iconOf(tab.icon, 16),
              enabled: prefs.tabsEnabled[tab.id] !== false,
              onToggle: (next) => { onToggleTab(tab.id, next) },
              // The settings gear only while the feature is enabled: its
              // related settings are dormant while the feature is off.
              onOpenSettings: prefs.tabsEnabled[tab.id] !== false && hasSettings(tab)
                ? () => { setSettingsFor(tab) }
                : undefined,
            })}
          </Fragment>
        ))}
        {/* The "add tab plugin" entry: same card size as the inventory,
            but a dashed border — it opens the TAB-registration plugin
            modal instead of toggling a feature. */}
        <button
          type="button"
          className={clsx(css.card, css.addCard)}
          onClick={() => { setAddPluginsOpen('tab') }}
        >
          <span className={css.cardTop}>
            <span className={css.cardIconChip}>
              <IconPlusOutlineRegular size={16} />
            </span>
            <span className={css.cardTitle}>{t('addPluginsTabCard')}</span>
          </span>
          <span className={css.cardDesc}>{t('addPluginsTabCardDesc')}</span>
        </button>
      </div>
    </div>
  )

  /** The file-viewer inventory + the dashed add-previewer entry. */
  const renderViewersGroup = () => (
    <div className={css.group}>
      <div className={css.groupHeading}>
        <span>{t('settingsViewersTitle')}</span>
        <span className={css.count}>{viewers.length}</span>
      </div>
      <div className={css.grid}>
        {viewers.map(viewer => (
          <Fragment key={viewer.id}>
            {renderCard({
              title: textOf(viewer.title) || viewer.id,
              desc: viewer.exts.length === 0 ? t('settingsViewerCatchAll') : viewer.exts.join(' · '),
              icon: iconOf(viewer.icon, 16),
              enabled: prefs.viewersEnabled[viewer.id] !== false,
              onToggle: (next) => { onToggleViewer(viewer.id, next) },
              onOpenSettings: prefs.viewersEnabled[viewer.id] !== false && hasSettings(viewer)
                ? () => { setSettingsFor(viewer) }
                : undefined,
            })}
          </Fragment>
        ))}
        {/* The "add preview plugin" entry: dashed card opening the
            FILE-PREVIEWER registration modal. */}
        <button
          type="button"
          className={clsx(css.card, css.addCard)}
          onClick={() => { setAddPluginsOpen('viewer') }}
        >
          <span className={css.cardTop}>
            <span className={css.cardIconChip}>
              <IconPlusOutlineRegular size={16} />
            </span>
            <span className={css.cardTitle}>{t('addPluginsViewerCard')}</span>
          </span>
          <span className={css.cardDesc}>{t('addPluginsViewerCardDesc')}</span>
        </button>
      </div>
    </div>
  )

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('settingsIntro')}</p>

      {/* The managing plugin's own identity: name + version badge, so the
          section is attributable at a glance (the version is the service
          instance's, kept in lockstep with package.json by
          tests/service.spec.ts). */}
      <div className={css.versionBadge}>
        <span className={css.versionBadgeName}>DSH-better-sidebar</span>
        <span className={css.versionBadgeTag}>v{service.version}</span>
      </div>

      <div className={css.settingsShell}>
        {/* Wide form: the five groups as a side navigation. */}
        <nav className={css.groupNav} aria-label={t('clueSettingsGroupsAria')}>
          {SETTINGS_GROUPS.map(item => (
            <button
              key={item.id}
              type="button"
              className={css.groupNavItem}
              aria-current={group === item.id ? 'page' : undefined}
              onClick={() => { setGroup(item.id) }}
            >
              {item.label()}
            </button>
          ))}
        </nav>

        {/* Narrow form: the same five groups as one native select (no
            horizontal overflow, keyboard friendly). */}
        <div className={css.groupSelectWrap}>
          <select
            className={css.groupSelect}
            aria-label={t('clueSettingsGroupsAria')}
            value={group}
            onChange={event => { setGroup(event.currentTarget.value as ClueSettingsGroup) }}
          >
            {SETTINGS_GROUPS.map(item => (
              <option key={item.id} value={item.id}>{item.label()}</option>
            ))}
          </select>
        </div>

        <div className={css.groupPane}>
          {group === 'general' && (
            <div className={css.group}>
              <div className={css.groupHeading}>{t('settingsGeneralTitle')}</div>
              <div className={css.row}>
                <span className={css.rowText}>
                  <span className={css.title}>{t('settingsOpenToolsTitle')}</span>
                  <span className={css.desc}>{t('settingsOpenToolsDesc')}</span>
                </span>
                <Switch
                  label={t('settingsOpenToolsTitle')}
                  checked={prefs.agentOpenTools}
                  onChange={(next) => { applyPref({ agentOpenTools: next }) }}
                />
              </div>

              {/* 手机: the narrow-viewport adaptations. Both switches only ever
                  change what happens on a NARROW viewport (the plugin's own
                  768px bracket), so a desktop reader's behaviour is untouched
                  whatever they pick — and neither rewrites the wide-viewport
                  switches above. */}
              <div className={css.subHeading}>{t('settingsMobileTitle')}</div>
              <div className={css.row}>
                <span className={css.rowText}>
                  <span className={css.title}>{t('settingsMobileNoAutoOpenTitle')}</span>
                  <span className={css.desc}>{t('settingsMobileNoAutoOpenDesc')}</span>
                </span>
                <Switch
                  label={t('settingsMobileNoAutoOpenTitle')}
                  checked={prefs.mobileNoAutoOpen}
                  onChange={(next) => { applyPref({ mobileNoAutoOpen: next }) }}
                />
              </div>
              <div className={css.row}>
                <span className={css.rowText}>
                  <span className={css.title}>{t('settingsMobileTreeTitle')}</span>
                  <span className={css.desc}>{t('settingsMobileTreeDesc')}</span>
                </span>
                <Switch
                  label={t('settingsMobileTreeTitle')}
                  checked={prefs.mobileDefaultTree}
                  onChange={(next) => { applyPref({ mobileDefaultTree: next }) }}
                />
              </div>
            </div>
          )}

          {group === 'tabs' && renderTabsGroup()}

          {group === 'viewers' && renderViewersGroup()}

          {group === 'sources' && (
            <div className={css.group}>
              <div className={css.groupHeading}>
                <span>{t('settingsGroupSources')}</span>
                <span className={css.count}>{catalogue?.sources.length ?? 0}</span>
              </div>
              <ClueSourcesPanel
                sources={catalogue?.sources ?? []}
                displays={displays}
                statuses={statusById}
                prefs={{
                  clueSourcesEnabled: prefs.clueSourcesEnabled,
                  clueSourcesMentionEnabled: prefs.clueSourcesMentionEnabled,
                  cluePacksMentionEnabled: prefs.cluePacksMentionEnabled,
                }}
                loading={sourcesLoading}
                error={sourcesError}
                onToggleSource={onToggleSource}
                onToggleMention={onToggleSourceMention}
                onTogglePacksMention={onTogglePacksMention}
                onEnableAll={() => { setAllSources(true) }}
                onDisableAll={() => { setAllSources(false) }}
                onMentionAll={() => { setAllSourceMentions(true) }}
                onMentionNone={() => { setAllSourceMentions(false) }}
                onConfigure={openSourceConfigById}
                onAddSource={() => { setAddPluginsOpen('tab') }}
                onReload={reloadSources}
              />
            </div>
          )}

          {group === 'appearance' && (
            <div className={css.group}>
              <div className={css.groupHeading}>{t('settingsCustomCssTitle')}</div>
              <CssDraft
                key={prefs.customCss}
                value={prefs.customCss}
                label={t('settingsCustomCssTitle')}
                placeholder={t('settingsCustomCssPlaceholder')}
                onCommit={commitCustomCss}
              />
            </div>
          )}
        </div>
      </div>

      {/* The secondary settings popup: a feature's declared related settings
          as title/desc + switch rows in a wider-than-default Modal with a
          Done footer (Modal chrome is the app's own). Mounted only while a
          feature is open — the Modal primitive runs hooks unconditionally,
          so a closed-but-mounted Modal would break SSR (and the
          renderToString spec) under the test dual-react split. */}
      {settingsFor !== null && (
        <Modal
          open
          onClose={() => { setSettingsFor(null) }}
          title={featureNameOf(settingsFor)}
          description={t('settingsPopupDesc', { feature: featureNameOf(settingsFor) })}
          closeLabel={t('close')}
          className={css.popupDialog}
          footer={(
            <button type="button" className={css.done} onClick={() => { setSettingsFor(null) }}>
              {t('settingsDone')}
            </button>
          )}
        >
          <SettingsBody
            feature={settingsFor}
            prefs={prefs}
            onToggle={onToggleSetting}
            onCommit={onCommitSetting}
            onSelectValue={onSelectSetting}
            onPatterns={onPatternsSetting}
            onPluginToggle={(toggle, next) => { onPluginToggle(settingsFor.id, toggle, next) }}
            onPluginCommit={(toggle, raw) => onPluginCommitSetting(settingsFor.id, toggle, raw)}
            onPluginSelectValue={(toggle, next) => { applyPluginSetting(settingsFor.id, toggle.key, next) }}
            onPluginPatterns={(toggle, next) => { applyPluginSetting(settingsFor.id, toggle.key, next) }}
            onPluginWrite={(key, value) => { applyPluginSetting(settingsFor.id, key, value) }}
            onClose={() => { setSettingsFor(null) }}
            store={store}
            service={service}
          />
        </Modal>
      )}

      {/* The "add plugin" modal (opened by the dashed cards above): declares
          the extension point of the clicked kind, opens the GitHub topic,
          and lists the matching recommended plugin catalog with per-entry
          install buttons (copying the command; nothing claims a successful
          install). The clue-source entry reuses this flow with the tab kind
          (S8: sources ship as DSH plugins, and installing a plugin is not the
          same action as installing the CLI it needs).
          Mounted only while open (Modal runs hooks unconditionally — same
          SSR rule as the settings popup above). */}
      {addPluginsOpen !== null && (
        <AddPluginModal
          service={service}
          onClose={() => { setAddPluginsOpen(null) }}
          kind={addPluginsOpen}
        />
      )}

      {error !== null && (
        <div className={css.error} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
