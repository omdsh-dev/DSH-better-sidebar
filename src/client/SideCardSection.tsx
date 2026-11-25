/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 *
 * The section is DECLARATIVE and GROUPED (S8). Its five clue groups plus the
 * start-page editor form one horizontal tab row, which scrolls locally when
 * the settings column is narrow:
 *  - 常规: new conversations open the panel by default, the default panel width
 *    as a percent of the window, the open-path interception toggle, and the
 *    narrow-viewport ("手机") switches — the DSH settings-row recipe
 *    (title/desc left + control right, hairline separators);
 *  - 标签页: one compact ROW per REGISTERED tab type (built-ins and external
 *    plugins alike), clicked to toggle `prefs.tabsEnabled[id]`, with the
 *    secondary-settings popup. Programmatic-only types (`hidden: true`, e.g.
 *    the built-in diff page or dsh-remote's `dsh-remote:file`) are NOT listed:
 *    they have no + menu row and no native guide entry, so a switch could only
 *    break their opens without hiding anything (#1009);
 *  - 文件预览: one compact ROW per REGISTERED file viewer
 *    (`prefs.viewersEnabled[id]`);
 *  - 开始页: the start-page takeover switch, the card row budget, the vertical
 *    alignment, and the ordered card/visibility list — the same preferences
 *    the host's native start page reads;
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
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconInspectOutlineRegular,
  IconLayersOutlineRegular,
  IconLinkOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import { SelectionSettingsPanel } from './SelectionSettings.tsx'
import { selectionSettingsOf } from '../selection-settings.ts'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CLUE_PREFS_ID, CLUE_WINDOW_SURFACE_SETTING, type SidebarPrefs } from '../prefs-shared.ts'
import { api } from './api.ts'
import { parsePrefs, syncClueWindowSurface } from './prefs.ts'
import { AddPluginModal, type PluginKind } from './add-plugin-modal.tsx'
import { t } from './locales.ts'
import type { SidebarStore } from './state.ts'
import { mergeGuideEntries, type NativeGuideCatalog, type NativeGuideEntry } from './native/guide-catalog.ts'
import { orderGuideEntries } from './native/guide-layout.ts'
import { GuideOrderList } from './native/guide-order.tsx'
import { GuideRowsInput } from './native/guide-rows.tsx'
import type {
  BetterSidebarService,
  FileViewerDescriptor,
  SidebarSettingsRenderProps,
  SidebarSettingToggle,
  TabDescriptor,
} from './service.ts'
import type { BetterSidebarCluesClientFace } from './clues/registry.ts'
import { clueRuntimeApi, type ClueRuntimeApi } from './clues/runtime-api.ts'
import { openClueSourceConfigWindow } from './clues/windows/source-config.tsx'
import { ClueSourcesPanel, hasSourceConfiguration } from './clues/settings/sources.tsx'
import { SourceCatalogBody } from './clues/settings/source-catalog-modal.tsx'
import { deriveClueSourceStatus, type ClueSourceStatus } from './clues/settings/status.ts'
import { subscribeClueRuntime } from './clues/settings/runtime-state.ts'
import { subscribeInstallPolling } from './clues/settings/install-polling.ts'
import {
  CLUE_SETTINGS_GROUPS,
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
import { ActionButton, IconButton, NumberInput, SelectMenu, SettingRow, Tabs, TextArea, TextInput, ToggleSwitch } from './ui/index.ts'
import css from './SideCardSection.module.css'
import design from './ui/design.module.css'

/** Injected business face: the shared store (prefs cache) + the sidebar service (registries). */
export interface SideCardSectionInjected {
  store: SidebarStore
  service: BetterSidebarService
  /** Live host guide cards; absent in harness renders that do not mount the start page. */
  guideCatalog?: NativeGuideCatalog
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
  initialGroup?: SettingsGroup
}

/** Full section props: the runtime share plus the injected face. */
export type SideCardSectionProps = PropsRuntime<'settings.section'> & SideCardSectionInjected

/**
 * Host preferences the General group owns (approved S8 spec §2: 常规 covers
 * auto-open / mobile behavior). A feature popup must not render a second
 * control for the same key — the Subagents tab still DECLARES these two for
 * history, but the one settings home is General.
 */
const GENERAL_OWNED_SETTING_KEYS = new Set<string>(['autoOpenSubagent', 'autoOpenJobs'])

/**
 * The last revision every mounted section has seen for one settings face.
 *
 * Both settings entry points render this component against the SAME document.
 * A slow mount read in one entry must not overwrite a newer save made by the
 * other, so the known revision is shared per injected face (production: the
 * one `api` object; tests: the injected fake).
 */
const knownSettingsRevisions = new WeakMap<object, number>()

/** Record a revision if it is newer than everything seen for this face. */
function noteSettingsRevision(face: object, revision: number | undefined): void {
  if (revision === undefined) return
  const known = knownSettingsRevisions.get(face)
  if (known === undefined || revision > known) knownSettingsRevisions.set(face, revision)
}

/**
 * The section's group ids: the clue navigation tuple plus the start-page
 * editor, which is not a clue deep-link target.
 */
type SettingsGroup = ClueSettingsGroup | 'startPage' | 'selection'

/** The label of each group, keyed by the group id. */
const SETTINGS_GROUP_LABEL: Record<SettingsGroup, () => string> = {
  general: () => t('settingsGeneralTitle'),
  tabs: () => t('settingsGroupTabs'),
  startPage: () => t('settingsStartPageTitle'),
  selection: () => t('selectionSettings'),
  viewers: () => t('settingsViewersTitle'),
  sources: () => t('settingsGroupSources'),
  appearance: () => t('settingsGroupAppearance'),
}

/**
 * The groups, in navigation order: the clue navigation tuple (which owns the
 * deep-link ids) with the start-page editor after the tab inventory, matching
 * the previous ungrouped section's order. Adding or reordering a clue group
 * stays one edit.
 */
const SETTINGS_GROUP_ORDER: readonly SettingsGroup[] = [
  ...CLUE_SETTINGS_GROUPS.slice(0, 2),
  'startPage',
  'selection',
  ...CLUE_SETTINGS_GROUPS.slice(2),
]

const SETTINGS_GROUPS: readonly { id: SettingsGroup; label(): string }[] =
  SETTINGS_GROUP_ORDER.map(id => ({ id, label: SETTINGS_GROUP_LABEL[id] }))

const SETTINGS_GROUP_ICON: Record<SettingsGroup, ReactNode> = {
  general: <IconSettingsOutlineRegular size={14} />,
  tabs: <IconPanelLeftOutlineRegular size={14} />,
  startPage: <IconLayersOutlineRegular size={14} />,
  selection: <IconInspectOutlineRegular size={14} />,
  viewers: <IconInspectOutlineRegular size={14} />,
  sources: <IconLinkOutlineRegular size={14} />,
  appearance: <IconPersonalizationOutlineRegular size={14} />,
}

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

/** Whether a wire value is a plain record (the maps the host deep-merges). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Merge two wire patches the way the host's settings.update merges a plain
 * object: nested plain objects merge recursively, arrays and scalars replace.
 * Used for both the kept-409 patch chain and the local rollback, so a sparse
 * nested-map edit never drops a sibling key.
 */
function mergeWirePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key]
    next[key] = isPlainRecord(current) && isPlainRecord(value)
      ? mergeWirePatch(current, value)
      : value
  }
  return next
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

/**
 * The tab inventory: the types that actually reach the side card, in + menu
 * order. `hidden` types are programmatic-only (no + menu row, no native
 * guide entry), so they have no side-card presence to switch — listing them
 * produced switches whose only observable effect was to refuse their own
 * opens (#1009).
 * @param tabs - the service's whole registry.
 * @returns a sorted copy without the hidden types.
 */
function tabInventory(tabs: readonly TabDescriptor[]): TabDescriptor[] {
  return tabs.filter(tab => tab.hidden !== true).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/** An empty, reference-stable guide inventory for harness renders without a catalog. */
const EMPTY_GUIDE_ENTRIES: readonly NativeGuideEntry[] = []
const NOOP_SUBSCRIBE = (): (() => void) => () => {}

/** Viewer inventory order: priority desc (the catch-all `code` comes last). */
function viewerOrder(a: FileViewerDescriptor, b: FileViewerDescriptor): number {
  return (b.priority ?? 0) - (a.priority ?? 0)
}

/** Whether a feature declares any secondary settings (gear button shows). */
function hasSettings(feature: TabDescriptor | FileViewerDescriptor): boolean {
  const settings = feature.settings
  return settings !== undefined && (
    // Rows the General group owns are not repeated in a feature popup.
    (settings.toggles?.filter(toggle => !GENERAL_OWNED_SETTING_KEYS.has(toggle.key)).length ?? 0) > 0
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
 * The body of a feature's secondary settings popup: one row (title/desc +
 * control) per declared setting. Switches reuse the host control; text and
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
  /** The save failure of one row (S8 §7: the error sits on its own row). */
  errorFor?: (key: string) => string | undefined
  /** Row-key prefix for the error's data attribute (`pref:` / `plugin:<id>:`) */
  rowKeyPrefix?: string
}) {
  const { toggles, prefs, onToggle, onCommit, onSelectValue, onPatterns, valueSource, errorFor, rowKeyPrefix = '' } = props
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
              error={errorFor?.(toggle.key)}
              errorKey={`${rowKeyPrefix}${toggle.key}`}
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
              error={errorFor?.(toggle.key)}
              errorKey={`${rowKeyPrefix}${toggle.key}`}
              onSelectValue={onSelectValue}
            />
          )
        }
        if ((toggle.type ?? 'switch') === 'switch') {
          return (
            <SettingRow key={toggle.key} label={title} description={textOf(toggle.desc)} className={css.popupRow}>
              <ToggleSwitch
                aria-label={title}
                checked={read(toggle.key) === true}
                onChange={(next) => { onToggle(toggle, next) }}
              />
              {errorFor?.(toggle.key) !== undefined && (
                <p className={css.rowError} role="alert" data-settings-error={`${rowKeyPrefix}${toggle.key}`}>
                  {errorFor(toggle.key)}
                </p>
              )}
            </SettingRow>
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
            error={errorFor?.(toggle.key)}
            errorKey={`${rowKeyPrefix}${toggle.key}`}
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
  error?: string
  errorKey?: string
  onCommit?: (toggle: SidebarSettingToggle, raw: string) => string
}) {
  const { toggle, title, value, error, errorKey, onCommit } = props
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const canonical = onCommit?.(toggle, draft) ?? draft
    setDraft(canonical)
  }
  const number = toggle.type === 'number'
  const FieldInput = number ? NumberInput : TextInput
  return (
    <SettingRow label={title} description={textOf(toggle.desc)} className={css.popupRow}>
      <span className={css.control}>
        <FieldInput
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
      {error !== undefined && (
        <p className={css.rowError} role="alert" data-settings-error={errorKey}>{error}</p>
      )}
    </SettingRow>
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
    <TextArea
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

/** Preserve descriptor scalar types while the shared menu owns all interaction. */
function SettingSelect(props: {
  label: string
  value: unknown
  options: NonNullable<SidebarSettingToggle['options']>
  multi?: boolean
  onSelect: (next: unknown) => void
  placeholder?: string
}) {
  const { label, value, options, multi, onSelect, placeholder } = props
  const picked: readonly unknown[] = multi ? (Array.isArray(value) ? value : []) : [value]
  const selected = options.flatMap((option, index) => picked.includes(option.value) ? [String(index)] : [])
  const choices = options.map((option, index) => ({
    value: String(index),
    label: textOf(option.title),
    title: textOf(option.title),
    description: textOf(option.desc) || undefined,
    icon: iconOf(option.icon, 16),
  }))
  return <SelectMenu
    ariaLabel={label}
    options={choices}
    placeholder={placeholder ?? '—'}
    {...(multi ? {
      values: selected,
      onValuesChange: (values: readonly string[]) => {
        onSelect(options.filter((_, index) => values.includes(String(index))).map(option => option.value))
      },
    } : {
      value: selected[0] ?? '',
      onChange: (index: string) => { onSelect(options[Number(index)]!.value) },
    })}
  />
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
  error?: string
  errorKey?: string
  onSelectValue?: (toggle: SidebarSettingToggle, next: unknown) => void
}) {
  const { toggle, title, value, error, errorKey, onSelectValue } = props
  return (
    <SettingRow label={title} description={textOf(toggle.desc)} className={css.popupRow}>
      <span className={css.control}>
        <SettingSelect
          label={title}
          value={value}
          options={toggle.options ?? []}
          placeholder={toggle.placeholder}
          multi={toggle.multi === true}
          onSelect={(next) => { onSelectValue?.(toggle, next) }}
        />
      </span>
      {error !== undefined && (
        <p className={css.rowError} role="alert" data-settings-error={errorKey}>{error}</p>
      )}
    </SettingRow>
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
  error?: string
  errorKey?: string
  onPatterns?: (toggle: SidebarSettingToggle, next: string[]) => void
}) {
  const { toggle, title, value, error, errorKey, onPatterns } = props
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
        <TextInput
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
        <ActionButton onClick={commitAdd}>
          {t('explorerExcludeAdd')}
        </ActionButton>
      </div>
      {error !== undefined && (
        <p className={css.rowError} role="alert" data-settings-error={errorKey}>{error}</p>
      )}
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
  /** Row-addressed save failures (the error renders on the row that wrote). */
  writeErrors?: Readonly<Record<string, string>>
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
  const { feature, prefs, store, service, writeErrors = {}, onToggle, onCommit, onSelectValue, onPatterns, onPluginToggle, onPluginCommit, onPluginSelectValue, onPluginPatterns, onPluginWrite, onClose } = props
  const render = feature.settings?.render
  // General is the ONE home for the auto-open preferences (S8 §2); the
  // Subagents card still declares them for history, but the popup must not
  // render a duplicate control for the same host pref.
  const toggles = (feature.settings?.toggles ?? [])
    .filter(toggle => !GENERAL_OWNED_SETTING_KEYS.has(toggle.key))
  const pluginToggles = feature.settings?.pluginToggles ?? []
  if (render === undefined && toggles.length === 0 && pluginToggles.length === 0) return null
  // Plugin rows read their values from the descriptor's OWN blob through
  // an explicit value source — no projection onto the prefs face, so a
  // plugin key can never collide with (or silently read) a host pref of
  // the same name. A key the user never wrote falls back to the row's own
  // declared `defaultValue` (filled in when the descriptor was registered):
  // without it a fresh document shows "no value" for a feature that already
  // behaves as its default.
  const pluginBlob = prefs.pluginSettings[feature.id] ?? {}
  const readPluginValue = (key: string): unknown => {
    const stored = pluginBlob[key]
    if (stored !== undefined) return stored
    return pluginToggles.find(row => row.key === key)?.defaultValue
  }
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
              errorFor={(key) => writeErrors[`pref:${key}`]}
              rowKeyPrefix="pref:"
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
              valueSource={readPluginValue}
              errorFor={(key) => writeErrors[`plugin:${feature.id}:${key}`]}
              rowKeyPrefix={`plugin:${feature.id}:`}
            />
          )}
        </div>
      )}
      {render !== undefined && (
        <>
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
          {/* A custom panel's write failure has no declarative row to attach
              to; it still belongs to the panel that made the write, so it
              renders right below it (declared plugin rows above own theirs). */}
          {Object.entries(writeErrors)
            .filter(([key]) => key.startsWith(`plugin:${feature.id}:`))
            .filter(([key]) => !pluginToggles.some(toggle => toggle.key === key.slice(`plugin:${feature.id}:`.length)))
            .map(([key, message]) => (
              <p key={key} className={css.rowError} role="alert" data-settings-error={key}>{message}</p>
            ))}
        </>
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
  /** Friendly inline failure copy (row-addressed by the caller). */
  readonly message?: string
  /** Rows whose kept 409 edits this successful write finally saved. */
  readonly savedRows?: readonly string[]
}

/** The declared needs of one source, as a stable coverage signature. */
function sourceNeedsKey(source: ClueSourceDescriptor): string {
  return JSON.stringify([source.dependencyIds ?? [], source.connectionId ?? null])
}

/**
 * Render the Side card preferences section.
 * @param props - composed slot props (runtime share + injected store/service).
 * @returns the section element tree.
 */
export function SideCardSection(props: SideCardSectionInjected & Partial<PropsRuntime<'settings.section'>>) {
  const { store, service, guideCatalog } = props
  const settingsId = useId()
  const settingsFace = props.settings ?? api
  const clues = props.clues ?? service.clues
  const windows = props.windows ?? service.windows
  const runtime = props.runtime ?? clueRuntimeApi

  const [prefs, setPrefs] = useState<SidebarPrefs>(() => store.getPrefs())
  // Save failures are addressed by ROW (S8 §7): the control that made the
  // write renders its own error, not a single banner far above it.
  const [writeErrors, setWriteErrors] = useState<Record<string, string>>({})
  // Which feature's secondary settings popup is open (null = closed).
  const [settingsFor, setSettingsFor] = useState<TabDescriptor | FileViewerDescriptor | null>(null)
  // Whether the "add plugin" modal is open, and for which extension point
  // (null = closed). The source entry has its own explicit no-catalog body
  // (there is no source-category catalog to reuse).
  const [addPluginsOpen, setAddPluginsOpen] = useState<PluginKind | 'source' | null>(null)
  // The LATEST optimistic prefs, kept in sync with the state. Nested-map
  // merges (tabsEnabled / viewersEnabled / pluginSettings / clue source maps)
  // MUST build from this ref, not from the render-time `prefs`: two same-tick
  // writes (e.g. a settings panel updating several plugin keys at once) would
  // otherwise both spread the stale map and the later patch would drop the
  // earlier key even though the commits are serialized.
  const optimisticRef = useRef(prefs)
  useEffect(() => { optimisticRef.current = prefs }, [prefs])
  // The last values the SERVER confirmed (mount read or a successful write).
  // A failed optimistic edit rolls back HERE, not to its own pre-write
  // snapshot: two rapid writes that both fail must not let the second
  // rollback resurrect the first edit the server rejected.
  const confirmedRef = useRef(prefs)

  // The active settings group. A pending deep link (Tab gear → Clue sources)
  // seeds it; the mount effect consumes it exactly once.
  const [group, setGroup] = useState<SettingsGroup>(() =>
    props.initialGroup ?? peekClueSettingsTarget()?.group ?? 'general')
  const consumedTargetRef = useRef(false)
  const pendingSourceRef = useRef<string | undefined>(undefined)

  // The declarative inventory: the registered tab types and file viewers.
  // Local state + service.subscribe (registry changes are rare — plugin
  // load/unload — so a plain effect is enough; no external-store ceremony).
  const [tabs, setTabs] = useState<TabDescriptor[]>(() => tabInventory(service.getTabs()))
  const [viewers, setViewers] = useState<FileViewerDescriptor[]>(() => [...service.getFileViewers()].sort(viewerOrder))
  useEffect(() => service.subscribe(() => {
    setTabs(tabInventory(service.getTabs()))
    setViewers([...service.getFileViewers()].sort(viewerOrder))
  }), [service])

  // The host's registered guide cards: the start-page inventory. The catalog
  // is optional so harness renders (and a host without the native surface)
  // simply see no start-page rows.
  const subscribeGuide = guideCatalog?.subscribe ?? NOOP_SUBSCRIBE
  const snapshotGuide = guideCatalog === undefined
    ? () => EMPTY_GUIDE_ENTRIES
    : () => guideCatalog.getSnapshot()
  const guideEntries = useSyncExternalStore(subscribeGuide, snapshotGuide, snapshotGuide)
  const guideInventory = mergeGuideEntries(guideEntries, tabs, prefs.tabsEnabled)
  const orderedGuide = orderGuideEntries(guideInventory, prefs.guideOrder)
  const guideSwitchHidden: Record<string, boolean> = {}
  for (const entry of orderedGuide) {
    guideSwitchHidden[entry.key] = entry.descriptorId === undefined
      ? prefs.guideHidden[entry.key] === true
      : prefs.tabsEnabled[entry.descriptorId] === false
  }

  // Clue source displays (client-registered names/icons) follow the registry.
  const [displays, setDisplays] = useState<readonly ClueSourceDisplayDescriptor[]>(() => clues.getSourceDisplays())

  // Clue source catalogue + S2 statuses. Loaded ONLY when the Clue sources
  // group is opened (an explicit status read — no timer, no auto-login).
  const [catalogue, setCatalogue] = useState<CluesSourcesCatalogResult | null>(null)
  // Starts true: the first paint of the Sources group must not say "no
  // sources / plugin not loaded" while the explicit read is still in flight.
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [dependencyStatuses, setDependencyStatuses] = useState<readonly DependencyStatus[]>([])
  const [connectionStatuses, setConnectionStatuses] = useState<readonly ConnectionStatusProjection[]>([])
  const [dependencyProbeFailed, setDependencyProbeFailed] = useState(false)
  const [connectionProbeFailed, setConnectionProbeFailed] = useState(false)
  // Sanitized one-line reasons of the failed status reads, kept PER KIND so a
  // connection failure can never be rendered as a dependency's reason (and
  // vice versa). The affected rows are request-failed AND the panel offers a
  // retry: a probe failure is a retryable state, not a dead end.
  const [dependencyProbeError, setDependencyProbeError] = useState<string | null>(null)
  const [connectionProbeError, setConnectionProbeError] = useState<string | null>(null)
  const [statusChecked, setStatusChecked] = useState(false)
  // Which catalogue snapshot the current projections actually cover, keyed by
  // source id and signed by the needs it declared. A source that appears (or
  // changes its declared dependency/connection set) while a probe is in
  // flight is NOT covered by those projections yet: it stays `unchecked`
  // instead of fabricating a terminal missing / not-configured verdict from
  // the previous table read.
  const [statusCoverage, setStatusCoverage] = useState<ReadonlyMap<string, string>>(() => new Map())
  // Whether any DEPENDENCY of a source currently has a running install task
  // (bus observation). The table overlays `installing` on top of the last
  // status read: the pre-install badge must not stay Ready/Missing while the
  // task runs, and a terminal observation restores the derived state.
  const [installingDependencies, setInstallingDependencies] = useState<ReadonlySet<string>>(() => new Set())
  // Dependencies whose install just settled: their pre-install status is no
  // longer an answer. Keep the row `unchecked` until the post-install probe
  // completes (S2 §6.3: only a passing probe may show ready).
  const [postInstallDependencies, setPostInstallDependencies] = useState<ReadonlySet<string>>(() => new Set())
  const sourcesLoadedRef = useRef(false)
  const sourcesRequestRef = useRef(0)
  const sourcesAbortRef = useRef<AbortController | null>(null)
  // The S6 configuration window can outlive this settings section (it is
  // hosted outside the settings dialog). Its close callback must never start a
  // catalogue read for an unmounted section.
  const sectionMountedRef = useRef(true)
  // Terminal task ids already used to trigger one post-install re-read.
  const terminalTaskIdsRef = useRef<Set<string>>(new Set())
  // The latest installing overlay, readable from the shared-poller listener
  // without re-subscribing on every state identity change.
  const installingDependenciesRef = useRef<ReadonlySet<string>>(installingDependencies)
  useEffect(() => { installingDependenciesRef.current = installingDependencies }, [installingDependencies])
  const catalogueRef = useRef<CluesSourcesCatalogResult | null>(null)
  useEffect(() => { catalogueRef.current = catalogue }, [catalogue])
  const displaysRef = useRef(displays)
  useEffect(() => { displaysRef.current = displays }, [displays])
  useEffect(() => {
    sectionMountedRef.current = true
    return () => {
      sectionMountedRef.current = false
      sourcesAbortRef.current?.abort()
    }
  }, [])

  /** Read the catalogue, then the S2 status projections it needs. */
  const loadSources = useCallback(async (refresh = false): Promise<void> => {
    if (!sectionMountedRef.current) return
    const request = sourcesRequestRef.current + 1
    sourcesRequestRef.current = request
    const controller = new AbortController()
    sourcesAbortRef.current?.abort()
    sourcesAbortRef.current = controller
    const isCurrent = (): boolean =>
      sectionMountedRef.current
      && !controller.signal.aborted
      && request === sourcesRequestRef.current
    setSourcesLoading(true)
    setSourcesError(null)
    setDependencyProbeError(null)
    setConnectionProbeError(null)
    // NOTE: `statusChecked`, the probe flags and the last projections are NOT
    // reset here. A reload of an already-checked table keeps showing its
    // last-known verdict while the fresh read is in flight; the failure path
    // below must simply never upgrade an unchecked table to "checked".
    try {
      const catalogueNext = await clues.api.sources(controller.signal)
      if (!isCurrent()) return
      setCatalogue(catalogueNext)
      const needsDependencies = catalogueNext.sources.some(source => (source.dependencyIds?.length ?? 0) > 0)
      const needsConnections = catalogueNext.sources.some(source => source.connectionId !== undefined)
      let dependenciesNext: readonly DependencyStatus[] = []
      let connectionsNext: readonly ConnectionStatusProjection[] = []
      let dependenciesFailed = false
      let connectionsFailed = false
      if (needsDependencies) {
        try {
          dependenciesNext = await runtime.dependenciesInspect(refresh ? { refresh: true } : undefined, controller.signal)
        } catch (caught) {
          dependenciesFailed = true
          if (isCurrent()) setDependencyProbeError(errorTextOf(caught))
        }
      }
      if (needsConnections) {
        try {
          connectionsNext = await runtime.connectionsStatus(undefined, controller.signal, refresh)
        } catch (caught) {
          connectionsFailed = true
          if (isCurrent()) setConnectionProbeError(errorTextOf(caught))
        }
      }
      if (!isCurrent()) return
      setDependencyStatuses(dependenciesNext)
      setConnectionStatuses(connectionsNext)
      setDependencyProbeFailed(dependenciesFailed)
      setConnectionProbeFailed(connectionsFailed)
      // A completed dependency read is the post-install answer: drop the task
      // overlay for every dependency it reports as no longer installing.
      // Without this, closing the source-config window stops the shared
      // poller, no terminal bus observation ever arrives, and a table opened
      // later keeps rendering "Installing" forever even though the fresh DTO
      // says ready/missing. A failed read keeps the overlay (it proved
      // nothing).
      if (!dependenciesFailed) {
        const installingNow = new Set(
          dependenciesNext
            .filter(status => status.state === 'installing')
            .map(status => status.dependencyId),
        )
        setInstallingDependencies(current => {
          if (current.size === 0) return current
          let changed = false
          const next = new Set<string>()
          for (const dependencyId of current) {
            if (installingNow.has(dependencyId)) next.add(dependencyId)
            else changed = true
          }
          return changed ? next : current
        })
      }
      // The completed observation covers EXACTLY this catalogue's declared
      // needs. Anything that changed meanwhile is re-checked next read.
      setStatusCoverage(new Map(catalogueNext.sources.map(source => [source.sourceId, sourceNeedsKey(source)])))
      setStatusChecked(true)
      // The completed probe is the post-install answer for every settled
      // dependency (cleared only on success: a failed read stays unchecked).
      setPostInstallDependencies(current => (current.size === 0 ? current : new Set()))
    } catch (caught) {
      if (isCurrent()) {
        // The catalogue itself failed. `statusChecked` stays as it was: a
        // first-load failure never checked anything, and a later failure
        // leaves the previous completed observation visible as last-known.
        setSourcesError(errorTextOf(caught))
      }
    } finally {
      if (isCurrent()) setSourcesLoading(false)
    }
  }, [clues, runtime])

  useEffect(() => {
    if (group !== 'sources' || sourcesLoadedRef.current) return
    sourcesLoadedRef.current = true
    void loadSources()
  }, [group, loadSources])

  // The registry can change while the section stays mounted (a source plugin
  // registers after the group was opened). Re-read the catalogue then, so the
  // new source appears without closing/reopening Settings.
  //
  // BOUNDARY (S1): this client bridge has NO host→client push for a source the
  // HOST half registers (`registerSource`); only a client display registration
  // (`registerSourceDisplay`, this subscription) or the explicit Retry re-reads
  // the catalogue. A host-only registration therefore appears on the next
  // explicit read (reopen / Retry). S9 owns adding a host-side push or
  // documenting that reopen semantics; S8 must not invent a second polling RPC
  // just to see it. The source table also never auto-polls statuses (spec §4).
  useEffect(() => clues.subscribe(() => {
    setDisplays(clues.getSourceDisplays())
    if (sourcesLoadedRef.current) void loadSources()
  }), [clues, loadSources])

  // Another view of the same runtime (a source config window) publishes the
  // statuses/tasks it just observed: refresh the table badge without a
  // remount. A running install task overlays `installing` immediately; a
  // terminal observation triggers ONE post-install status re-read (S2 §6.3:
  // only a passing probe may return the row to ready).
  useEffect(() => subscribeClueRuntime(runtime, observation => {
    if (!sourcesLoadedRef.current) return
    if (observation.kind === 'statuses') {
      // A status read that no longer reports `installing` means the task has
      // settled (or vanished): drop the overlay before the reload lands.
      if (observation.dependencies.length > 0) {
        setInstallingDependencies(current => {
          if (current.size === 0) return current
          let changed = false
          const next = new Set(current)
          for (const dependency of observation.dependencies) {
            if (dependency.state !== 'installing' && next.delete(dependency.dependencyId)) changed = true
          }
          return changed ? next : current
        })
      }
      void loadSources()
      return
    }
    if (observation.tasks.length === 0) return
    setInstallingDependencies(current => {
      let changed = false
      const next = new Set(current)
      for (const task of observation.tasks) {
        if (task.state === 'running') {
          if (!next.has(task.dependencyId)) {
            next.add(task.dependencyId)
            changed = true
          }
        } else if (next.delete(task.dependencyId)) {
          changed = true
        }
      }
      return changed ? next : current
    })
    const terminal = observation.tasks.filter(task =>
      task.state !== 'running' && !terminalTaskIdsRef.current.has(task.taskId))
    if (terminal.length === 0) return
    for (const task of terminal) terminalTaskIdsRef.current.add(task.taskId)
    setPostInstallDependencies(current => {
      const next = new Set(current)
      for (const task of terminal) next.add(task.dependencyId)
      return next
    })
    // Bound the "already refreshed" set: task ids cannot accumulate for the
    // lifetime of a settings page (AGENTS §5 module/instance bookkeeping).
    while (terminalTaskIdsRef.current.size > 128) {
      const oldest = terminalTaskIdsRef.current.values().next().value
      if (oldest === undefined) break
      terminalTaskIdsRef.current.delete(oldest)
    }
    void loadSources()
  }), [runtime, loadSources])

  // The table can outlive the configuration window that started an install.
  // Closing that window stops ITS subscription, but no terminal bus
  // observation would follow and the row would stay "Installing" forever.
  // While any row shows the installing overlay, the table itself keeps the ONE
  // shared poller observing; the terminal task then clears the overlay and the
  // re-read shows the real DTO state (ready / missing / request-failed).
  const hasInstallingOverlay = installingDependencies.size > 0
  useEffect(() => {
    if (!hasInstallingOverlay) return
    return subscribeInstallPolling(runtime, observation => {
      // Transient failures are the poller's own retry loop; only its final
      // gave-up notification means no observation will ever arrive again.
      if (observation.error !== undefined) return
      if (observation.gaveUp === true) {
        // Do not claim live progress we can no longer observe: drop the
        // overlay and re-read the DTO (a still-installing DTO is then the
        // honest last-known answer, not a frozen task badge).
        setInstallingDependencies(current => (current.size === 0 ? current : new Set()))
        void loadSources()
        return
      }
      // The bus carries tasks, not their absence: a task the runtime stopped
      // reporting would otherwise leave this overlay polling forever.
      const reported = new Set(observation.tasks.map(task => task.dependencyId))
      if (![...installingDependenciesRef.current].some(id => !reported.has(id))) return
      setInstallingDependencies(current => {
        if (current.size === 0) return current
        let changed = false
        const next = new Set<string>()
        for (const dependencyId of current) {
          if (reported.has(dependencyId)) next.add(dependencyId)
          else changed = true
        }
        return changed ? next : current
      })
      void loadSources()
    })
  }, [runtime, hasInstallingOverlay, loadSources])

  /** Explicit reload of the source list (the panel's Retry action). */
  const reloadSources = (): void => {
    sourcesLoadedRef.current = true
    void loadSources(true)
  }

  /** Derived per-source state (never ready before an observation completed). */
  const statusById = useMemo(() => {
    const map = new Map<string, ClueSourceStatus>()
    for (const source of catalogue?.sources ?? []) {
      const installing = (source.dependencyIds ?? []).some(id => installingDependencies.has(id))
      if (installing) {
        // The task observation outranks the last dependency DTO (which was
        // read before the install started and may still say ready/missing).
        map.set(source.sourceId, { kind: 'installing' })
        continue
      }
      const awaitingProbe = (source.dependencyIds ?? []).some(id => postInstallDependencies.has(id))
      if (awaitingProbe) {
        // The install settled; the pre-install DTO is not the post-install
        // answer. Stay unchecked until the re-read actually completes.
        map.set(source.sourceId, { kind: 'unchecked' })
        continue
      }
      const needsDependencies = (source.dependencyIds?.length ?? 0) > 0
      const dependenciesFailedHere = needsDependencies && dependencyProbeFailed
      const connectionFailedHere = source.connectionId !== undefined && connectionProbeFailed
      // Attribute the failure to the probe the row actually depends on: a
      // connection error must never be rendered as a dependency's reason
      // (and vice versa).
      const requestFailedDetail = dependenciesFailedHere
        ? dependencyProbeError
        : connectionFailedHere
          ? connectionProbeError
          : null
      map.set(source.sourceId, deriveClueSourceStatus({
        dependencyIds: source.dependencyIds,
        connectionId: source.connectionId,
        ...(source.connectionCapability === undefined ? {} : { requiredCapability: source.connectionCapability }),
        dependencies: dependencyStatuses,
        connections: connectionStatuses,
        requestFailed: dependenciesFailedHere || connectionFailedHere,
        ...(requestFailedDetail === null ? {} : { requestFailedDetail }),
        checked: statusChecked && statusCoverage.get(source.sourceId) === sourceNeedsKey(source),
      }))
    }
    return map
  }, [catalogue, dependencyStatuses, connectionStatuses, dependencyProbeFailed, connectionProbeFailed, dependencyProbeError, connectionProbeError, statusChecked, statusCoverage, installingDependencies, postInstallDependencies])

  /** Open one source's S6 configuration window (stable identity = focus). */
  const openSourceConfig = useCallback((source: ClueSourceDescriptor): void => {
    // Nothing to configure means nothing to open: a source with no CLI
    // dependency and no connection has no settings page.
    if (!hasSourceConfiguration(source)) return
    const display = displaysRef.current.find(item => item.sourceId === source.sourceId)
    openClueSourceConfigWindow({
      windows,
      source,
      display,
      runtime,
      onClose: () => {
        // Mutations and terminal observations already invalidate status reads.
        if (sourcesLoadedRef.current) void loadSources()
      },
    })
  }, [windows, runtime, loadSources])

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
      // The live subscriber is the receiver: consume the one-shot target so a
      // later mount of Settings does not replay this deep link.
      consumeClueSettingsTarget()
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
  // The mount read: a click that lands before it settles waits for the same
  // read instead of writing without `expectedRevision`.
  const initialReadRef = useRef<Promise<{ value?: unknown; revision?: number }> | undefined>(undefined)
  // Whether the user already wrote since mount: the mount read must not
  // clobber a newer optimistic edit (the window is milliseconds, but a slow
  // route must never silently revert a just-made change).
  const dirtyRef = useRef(false)
  // Writes between optimistic apply and settlement. Store notifications are
  // ignored meanwhile: the broad subscription must not replace an edit that
  // is still on its way to the server.
  const inFlightWritesRef = useRef(0)
  // A 409 whose retry also failed keeps its edit locally. The patch rides the
  // NEXT write (so the kept value eventually saves instead of vanishing) and
  // store notifications are ignored until it settles. The rows are tracked
  // separately so the eventual save can clear exactly their inline errors.
  const unsavedPatchRef = useRef<Record<string, unknown> | null>(null)
  const unsavedRowsRef = useRef<Set<string>>(new Set())
  // Serialize commits: a queued write must observe the previous write's
  // revision; a failed write must not poison the queue for later ones.
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())
  // The wire patch of every commit that has not settled yet, in queue order.
  // A settled write's response is the document at THAT revision: when a later
  // optimistic edit is still queued, the response must be overlaid with the
  // queued patches, otherwise the older response hides the newer edit
  // (`applyOutcome` would otherwise setPrefs the pre-edit document).
  const pendingWritesRef = useRef<{ token: number; patch: Record<string, unknown> }[]>([])
  const writeTokenRef = useRef(0)

  useEffect(() => {
    syncClueWindowSurface(prefs)
  }, [prefs])

  // Sync the persisted document once on mount: the revision and the current
  // values (another tab may have changed them since the store hydrated).
  useEffect(() => {
    let cancelled = false
    const read = settingsFace.settingsGet()
    initialReadRef.current = read
    void read.then((view) => {
      if (cancelled) return
      const known = knownSettingsRevisions.get(settingsFace)
      if (view.revision !== undefined) {
        noteSettingsRevision(settingsFace, view.revision)
        revisionRef.current = Math.max(revisionRef.current ?? view.revision, view.revision)
        // The other settings entry already saved a newer document. Adopting
        // this older read would resurrect its values in the shared store.
        if (known !== undefined && view.revision < known) {
          // The store holds that newer confirmed document; use it as the
          // rollback base for a later failed edit from this entry.
          confirmedRef.current = store.getPrefs()
          return
        }
      }
      if (dirtyRef.current) return
      const next = parsePrefs(view.value)
      confirmedRef.current = next
      // Refresh the shared store too: both settings entry points render this
      // ONE component against the same store and revision chain.
      store.setPrefs(next)
      setPrefs(next)
    }).catch(() => { /* the store's defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [settingsFace, store])

  // Another surface's save refreshes this mounted surface (same store) — but
  // only when this surface has no edit of its own in flight or kept after a
  // 409. Otherwise a session/tab notification would silently replace the
  // user's optimistic value with the last saved document.
  useEffect(() => store.subscribe(() => {
    if (inFlightWritesRef.current > 0 || unsavedPatchRef.current !== null) return
    setPrefs(store.getPrefs())
  }), [store])

  /**
   * Persist one patch through the settings route (serialized, revision-guarded).
   * Nested maps are sent SPARSE: the host deep-merges plain objects, so a
   * concurrent entry's sibling key (e.g. `tabsEnabled.other`) survives even
   * when this entry's local map is older. A 409 re-reads the revision while
   * keeping the edit on screen, then retries the same patch once. A kept 409
   * edit is retried together with the next write, so it is never silently
   * dropped from the UI while missing on the server.
   */
  const commit = (patch: Record<string, unknown>, rowKey: string): Promise<CommitOutcome> => {
    dirtyRef.current = true
    let conflicted = false
    // Register the sparse wire patch before the write enters the queue: a
    // response may settle while this entry's LATER edits are still queued.
    const token = writeTokenRef.current + 1
    writeTokenRef.current = token
    pendingWritesRef.current = [...pendingWritesRef.current, { token, patch }]
    const dropPending = (): void => {
      pendingWritesRef.current = pendingWritesRef.current.filter(entry => entry.token !== token)
    }
    const currentRevision = async (): Promise<number> => {
      // Another entry may have advanced the document since this mount read.
      const known = knownSettingsRevisions.get(settingsFace)
      if (known !== undefined && (revisionRef.current === undefined || known > revisionRef.current)) {
        revisionRef.current = known
      }
      if (revisionRef.current !== undefined) return revisionRef.current
      const initial = initialReadRef.current
      if (initial !== undefined) {
        try {
          const view = await initial
          noteSettingsRevision(settingsFace, view.revision)
          if (view.revision !== undefined) {
            revisionRef.current = Math.max(revisionRef.current ?? view.revision, view.revision)
          }
        } catch {
          // Fall through to a fresh read below.
        }
      }
      if (revisionRef.current !== undefined) return revisionRef.current
      const view = await settingsFace.settingsGet()
      noteSettingsRevision(settingsFace, view.revision)
      if (view.revision === undefined) {
        // Never issue an unguarded write: without a revision the 409 contract
        // cannot be honored, so fail visibly instead.
        throw new Error('the settings document revision is unavailable')
      }
      revisionRef.current = Math.max(revisionRef.current ?? view.revision, view.revision)
      return revisionRef.current
    }
    let attempted: Record<string, unknown> = patch
    const run = inFlightRef.current.then(async () => {
      const unsaved = unsavedPatchRef.current
      // Deep-merge the sparse wire patches: two edits to different keys of
      // the same nested map must not drop each other while queued.
      const combined = unsaved === null ? patch : mergeWirePatch(unsaved, patch)
      attempted = combined
      const write = async (): Promise<{ value?: unknown; revision?: number }> =>
        settingsFace.settingsUpdate(combined, await currentRevision())
      let view: { value?: unknown; revision?: number }
      try {
        view = await write()
      } catch (caught) {
        if (!isSettingsConflict(caught)) throw caught
        conflicted = true
        // Keep the edit; fence the retry on the freshly read revision.
        const refreshed = await settingsFace.settingsGet()
        noteSettingsRevision(settingsFace, refreshed.revision)
        if (refreshed.revision === undefined) {
          throw new Error('the settings document revision is unavailable', { cause: caught })
        }
        revisionRef.current = Math.max(revisionRef.current ?? refreshed.revision, refreshed.revision)
        view = await write()
      }
      // Read the newest revision observed BEFORE this response. A newer
      // successful write from the other settings entry may have already
      // confirmed a later document while this request was in flight; adopting
      // this older full-document response would overwrite it in the shared
      // store and hide the other entry's saved edit.
      const knownBefore = knownSettingsRevisions.get(settingsFace)
      const next = parsePrefs(view.value)
      const superseded = view.revision !== undefined
        && knownBefore !== undefined
        && view.revision < knownBefore
      if (view.revision !== undefined) {
        revisionRef.current = Math.max(revisionRef.current ?? view.revision, view.revision)
        noteSettingsRevision(settingsFace, view.revision)
      }
      const savedRows = [...unsavedRowsRef.current]
      unsavedRowsRef.current.clear()
      unsavedPatchRef.current = null
      let display: SidebarPrefs
      if (superseded) {
        // Keep the other entry's newer confirmed document. This write still
        // saved its own rows (their errors clear), but its older values must
        // not win over that newer revision.
        confirmedRef.current = store.getPrefs()
        display = store.getPrefs()
      } else {
        confirmedRef.current = next
        store.setPrefs(next)
        display = next
      }
      // Re-apply edits that are still queued behind this write: the response
      // is the document at THIS revision, and must not hide a later click.
      for (const entry of pendingWritesRef.current) {
        if (entry.token === token) continue
        display = parsePrefs(mergeWirePatch(display as unknown as Record<string, unknown>, entry.patch))
      }
      // Drop this write before the next queued run starts (the queue's
      // chained promise may resume before the outer settle handler).
      dropPending()
      return { next: display, savedRows }
    })
    inFlightWritesRef.current += 1
    // A failed commit must not poison the queue: later writes still run.
    inFlightRef.current = run.then(() => undefined, () => undefined)
    return run.then(
      ({ next, savedRows }) => {
        dropPending()
        inFlightWritesRef.current -= 1
        return { ok: true, prefs: next, savedRows }
      },
      (caught) => {
        dropPending()
        inFlightWritesRef.current -= 1
        if (conflicted) {
          unsavedPatchRef.current = attempted
          unsavedRowsRef.current.add(rowKey)
        }
        return conflicted
          ? { ok: false, prefs, keepEdit: true, message: messageOf(caught) }
          : { ok: false, prefs, message: messageOf(caught) }
      },
    )
  }

  /** Record one row's save failure (S8 §7: the error belongs to that row). */
  const setWriteError = (rowKey: string, message: string): void => {
    setWriteErrors(current => ({ ...current, [rowKey]: message }))
  }

  /** Clear one row's save failure. */
  const clearWriteError = (rowKey: string): void => {
    setWriteErrors(current => {
      if (current[rowKey] === undefined) return current
      const next = { ...current }
      delete next[rowKey]
      return next
    })
  }

  /**
   * Settle one commit. Success adopts the server values (and clears the errors
   * of rows whose kept 409 edits this write finally saved). A non-conflict
   * failure rolls back to the last SERVER-CONFIRMED values (plus any edit the
   * 409 path is still keeping for the next write) — not to this write's own
   * pre-write snapshot, which may already contain an earlier failed edit.
   */
  const applyOutcome = (outcome: CommitOutcome, rowKey: string): void => {
    if (outcome.ok) {
      // A click that landed AFTER the response but BEFORE this settle handler
      // is in the queue (its patch registered, response not adopted yet).
      // Overlay it here too, or the older response's document hides it.
      let display = outcome.prefs
      for (const entry of pendingWritesRef.current) {
        display = parsePrefs(mergeWirePatch(display as unknown as Record<string, unknown>, entry.patch))
      }
      optimisticRef.current = display
      setPrefs(display)
      clearWriteError(rowKey)
      for (const savedRow of outcome.savedRows ?? []) clearWriteError(savedRow)
      return
    }
    if (outcome.keepEdit !== true) {
      const kept = unsavedPatchRef.current
      let rollback = (kept === null
        ? confirmedRef.current
        : mergeWirePatch(confirmedRef.current as unknown as Record<string, unknown>, kept)) as SidebarPrefs
      // A later edit is still queued: roll back only THIS write's optimistic
      // value, never the newer edit the user just made.
      for (const entry of pendingWritesRef.current) {
        rollback = parsePrefs(mergeWirePatch(rollback as unknown as Record<string, unknown>, entry.patch))
      }
      optimisticRef.current = rollback
      setPrefs(rollback)
    }
    setWriteError(rowKey, outcome.message ?? t('settingsSaveFailed'))
  }

  /**
   * Optimistically apply one pref patch, then commit.
   * @param patch - the full local value (the UI reads this shape).
   * @param rowKey - the row that owns the write (its inline error home).
   * @param wirePatch - the sparse patch to send (defaults to `patch`); nested
   *   maps send only the touched key so the host's deep merge preserves the
   *   other entry's edits.
   */
  const applyPref = (
    patch: Record<string, unknown>,
    rowKey: string,
    wirePatch: Record<string, unknown> = patch,
  ): void => {
    const previous = optimisticRef.current
    const next = { ...previous, ...patch } as SidebarPrefs
    optimisticRef.current = next
    setPrefs(next)
    clearWriteError(rowKey)
    void commit(wirePatch, rowKey).then(outcome => applyOutcome(outcome, rowKey))
  }

  /** Flip one per-tab enable switch (send ONLY that key; the host deep-merges). */
  const onToggleTab = (id: string, next: boolean): void => {
    applyPref(
      { tabsEnabled: { ...optimisticRef.current.tabsEnabled, [id]: next } },
      `tab:${id}`,
      { tabsEnabled: { [id]: next } },
    )
  }

  /** Flip one per-viewer enable switch (sparse map, same reason). */
  const onToggleViewer = (id: string, next: boolean): void => {
    applyPref(
      { viewersEnabled: { ...optimisticRef.current.viewersEnabled, [id]: next } },
      `viewer:${id}`,
      { viewersEnabled: { [id]: next } },
    )
  }

  /** Hide/show one start-page card without touching its tab type. */
  const onToggleGuide = (key: string, shown: boolean): void => {
    const next = { ...optimisticRef.current.guideHidden }
    if (shown) delete next[key]
    else next[key] = true
    // A deletion cannot ride the host's deep merge, so a re-shown card sends
    // the explicit `false` while the UI keeps the sparse map.
    applyPref({ guideHidden: next }, `guide:${key}`, { guideHidden: { [key]: !shown } })
  }

  /**
   * One unified switch: Better Sidebar types use the same feature switch as
   * the card above; host/third-party types only have start-page visibility.
   */
  const onToggleGuideEntry = (entry: NativeGuideEntry, shown: boolean): void => {
    if (entry.descriptorId === undefined) {
      onToggleGuide(entry.key, shown)
      return
    }
    applyPref(
      { tabsEnabled: { ...optimisticRef.current.tabsEnabled, [entry.descriptorId]: shown } },
      `tab:${entry.descriptorId}`,
      { tabsEnabled: { [entry.descriptorId]: shown } },
    )
  }

  /** Move one card within the current explicit order. */
  const onMoveGuide = (key: string, delta: -1 | 1): void => {
    const keys = orderedGuide.map(entry => entry.key)
    const at = keys.indexOf(key)
    const to = at + delta
    if (at < 0 || to < 0 || to >= keys.length) return
    const next = [...keys]
    const [moved] = next.splice(at, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    applyPref({ guideOrder: next }, 'pref:guideOrder')
  }

  /** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
  const onToggleSetting = (toggle: SidebarSettingToggle, next: boolean): void => {
    applyPref({ [toggle.key]: next }, `pref:${toggle.key}`)
  }

  /** Commit one declaratively-declared select row (the option's value, or an
   *  array of values under `multi`). */
  const onSelectSetting = (toggle: SidebarSettingToggle, next: unknown): void => {
    applyPref({ [toggle.key]: next }, `pref:${toggle.key}`)
  }

  /** Commit one declaratively-declared patterns row (the whole string list). */
  const onPatternsSetting = (toggle: SidebarSettingToggle, next: string[]): void => {
    applyPref({ [toggle.key]: next }, `pref:${toggle.key}`)
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
      applyPref({ [toggle.key]: clamped }, `pref:${toggle.key}`)
      return String(clamped)
    }
    applyPref({ [toggle.key]: raw }, `pref:${toggle.key}`)
    return raw
  }

  /** Commit the free-form custom CSS (the user-space escape hatch). */
  const commitCustomCss = (raw: string): void => {
    applyPref({ customCss: raw }, 'pref:customCss')
  }

  /** Persist one plugin-owned setting of one descriptor (sparse pluginSettings map). */
  const applyPluginSetting = (descriptorId: string, key: string, value: unknown): void => {
    applyPref(
      { pluginSettings: mergePluginSetting(optimisticRef.current.pluginSettings, descriptorId, key, value) },
      `plugin:${descriptorId}:${key}`,
      { pluginSettings: { [descriptorId]: { [key]: value } } },
    )
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

  /** Flip one source enable switch (sparse clueSourcesEnabled map). */
  const onToggleSource = (sourceId: string, next: boolean): void => {
    applyPref(
      { clueSourcesEnabled: { ...optimisticRef.current.clueSourcesEnabled, [sourceId]: next } },
      `source:${sourceId}`,
      { clueSourcesEnabled: { [sourceId]: next } },
    )
  }

  /** Flip one source @ switch (sparse clueSourcesMentionEnabled map). */
  const onToggleSourceMention = (sourceId: string, next: boolean): void => {
    applyPref(
      { clueSourcesMentionEnabled: { ...optimisticRef.current.clueSourcesMentionEnabled, [sourceId]: next } },
      `sourceMention:${sourceId}`,
      { clueSourcesMentionEnabled: { [sourceId]: next } },
    )
  }

  /** Flip the independent clue-pack @ switch. */
  const onTogglePacksMention = (next: boolean): void => {
    applyPref({ cluePacksMentionEnabled: next }, 'packs')
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
    const wire = {} as Record<string, boolean>
    for (const id of ids) {
      map[id] = next
      wire[id] = next
    }
    applyPref({ clueSourcesEnabled: map }, 'batch', { clueSourcesEnabled: wire })
  }

  /** Batch-write the @ map ONCE, with the same future-source rule. */
  const setAllSourceMentions = (next: boolean): void => {
    const ids = registeredSourceIds()
    if (ids.length === 0) return
    const map = { ...optimisticRef.current.clueSourcesMentionEnabled }
    const wire = {} as Record<string, boolean>
    for (const id of ids) {
      map[id] = next
      wire[id] = next
    }
    applyPref({ clueSourcesMentionEnabled: map }, 'batch', { clueSourcesMentionEnabled: wire })
  }

  /** One inventory row: a persistent visual toggle and a separate settings action. */
  const renderCard = (props: {
    title: string
    desc: string
    icon?: ReactNode
    enabled: boolean
    rowKey: string
    error?: string
    onToggle: (next: boolean) => void
    /** An absent handler leaves the aligned settings action disabled. */
    onOpenSettings?: () => void
  }) => {
    const hasSettingsAction = props.onOpenSettings !== undefined
    return (
      <div
        className={clsx(css.card, props.enabled && css.cardOn)}
        data-settings-row={props.rowKey}
      >
        <div className={css.cardMain} title={props.desc}>
          {props.icon !== null && props.icon !== undefined && (
            <span className={css.cardIconChip}>{props.icon}</span>
          )}
          <span className={css.cardText}>
            <span className={css.cardTitle}>{props.title}</span>
            {props.rowKey.startsWith('viewer:') && <span className={css.cardDesc}>{props.desc}</span>}
          </span>
          <ToggleSwitch
            aria-label={props.title}
            checked={props.enabled}
            data-settings-toggle={props.enabled ? 'on' : 'off'}
            onChange={props.onToggle}
          />
        </div>
        <IconButton
          icon={<IconSettingsOutlineRegular size={14} />}
          label={`${props.title} ${t('settingsPopup')}`}
          disabled={!hasSettingsAction}
          onClick={() => { props.onOpenSettings?.() }}
        />
        {props.error !== undefined && (
          <p className={css.cardError} role="alert" data-settings-error={props.rowKey}>
            {props.error}
          </p>
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
      <h2 className={css.groupHeading}>
        <span>{t('settingsGroupTabs')}</span>
        <span className={css.count}>{tabs.length}</span>
      </h2>
      <div className={css.grid}>
        {tabs.map(tab => (
          <Fragment key={tab.id}>
            {renderCard({
              title: textOf(tab.title),
              desc: tab.id,
              icon: iconOf(tab.icon, 16),
              enabled: prefs.tabsEnabled[tab.id] !== false,
              rowKey: `tab:${tab.id}`,
              error: writeErrors[`tab:${tab.id}`],
              onToggle: (next) => { onToggleTab(tab.id, next) },
              onOpenSettings: hasSettings(tab)
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
          <span className={css.cardIconChip}><IconPlusOutlineRegular size={16} /></span>
          <span className={css.cardText}>
            <span className={css.cardTitle}>{t('addPluginsTabCard')}</span>
          </span>
        </button>
      </div>
    </div>
  )

  /** The file-viewer inventory + the dashed add-previewer entry. */
  const renderViewersGroup = () => (
    <div className={css.group}>
      <h2 className={css.groupHeading}>
        <span>{t('settingsViewersTitle')}</span>
        <span className={css.count}>{viewers.length}</span>
      </h2>
      <div className={css.grid}>
        {viewers.map(viewer => (
          <Fragment key={viewer.id}>
            {renderCard({
              title: textOf(viewer.title) || viewer.id,
              desc: viewer.exts.length === 0 ? t('settingsViewerCatchAll') : viewer.exts.join(' · '),
              icon: iconOf(viewer.icon, 16),
              enabled: prefs.viewersEnabled[viewer.id] !== false,
              rowKey: `viewer:${viewer.id}`,
              error: writeErrors[`viewer:${viewer.id}`],
              onToggle: (next) => { onToggleViewer(viewer.id, next) },
              onOpenSettings: hasSettings(viewer)
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
          <span className={css.cardIconChip}><IconPlusOutlineRegular size={16} /></span>
          <span className={css.cardText}>
            <span className={css.cardTitle}>{t('addPluginsViewerCard')}</span>
          </span>
        </button>
      </div>
    </div>
  )

  /** One row-addressed save failure (the row renders its own message). */
  const renderWriteError = (rowKey: string) => writeErrors[rowKey] === undefined
    ? null
    : (
      <p className={css.rowError} role="alert" data-settings-error={rowKey}>
        {writeErrors[rowKey]}
      </p>
    )

  return (
    <div className={clsx(design.surface, css.section)} data-sidebar-settings>
      <div className={css.settingsShell}>
        <div className={css.navRail}>
          <Tabs value={group} onChange={value => { setGroup(value as SettingsGroup) }}
            ariaLabel={t('clueSettingsGroupsAria')} className={css.groupNav}
            options={SETTINGS_GROUPS.map(item => ({
              value: item.id,
              id: `${settingsId}-${item.id}-tab`,
              controls: `${settingsId}-panel`,
              label: <><span className={css.groupIcon} aria-hidden="true">{SETTINGS_GROUP_ICON[item.id]}</span><span>{item.label()}</span></>,
            }))} />
        </div>
        <div className={css.navSelect}>
          <SelectMenu className={css.groupSelect}
            value={group}
            ariaLabel={t('clueSettingsGroupsAria')}
            onChange={value => { setGroup(value as SettingsGroup) }}
            options={SETTINGS_GROUPS.map(item => ({
              value: item.id,
              label: item.label(),
              icon: SETTINGS_GROUP_ICON[item.id],
            }))} />
        </div>

        <div className={css.groupPane} role="tabpanel" id={`${settingsId}-panel`} aria-labelledby={`${settingsId}-${group}-tab`}>
          {group === 'general' && (
            <div className={css.group}>
              <h2 className={css.groupHeading}>{t('settingsGeneralTitle')}</h2>
              <SettingRow label={t('settingsOpenToolsTitle')} description={t('settingsOpenToolsDesc')} className={css.row}>
                <ToggleSwitch
                  aria-label={t('settingsOpenToolsTitle')}
                  checked={prefs.agentOpenTools}
                  onChange={(next) => { applyPref({ agentOpenTools: next }, 'pref:agentOpenTools') }}
                />
                {renderWriteError('pref:agentOpenTools')}
              </SettingRow>

              {/* 自动打开: the two task-page activation preferences live in
                  General (approved S8 IA), even though the Subagents tab still
                  declares them for the popup-era configuration. */}
              <SettingRow label={t('settingsSubagentTitle')} description={t('settingsSubagentDesc')} className={css.row}>
                <ToggleSwitch
                  aria-label={t('settingsSubagentTitle')}
                  checked={prefs.autoOpenSubagent}
                  onChange={(next) => { applyPref({ autoOpenSubagent: next }, 'pref:autoOpenSubagent') }}
                />
                {renderWriteError('pref:autoOpenSubagent')}
              </SettingRow>
              <SettingRow label={t('settingsJobsTitle')} description={t('settingsJobsDesc')} className={css.row}>
                <ToggleSwitch
                  aria-label={t('settingsJobsTitle')}
                  checked={prefs.autoOpenJobs}
                  onChange={(next) => { applyPref({ autoOpenJobs: next }, 'pref:autoOpenJobs') }}
                />
                {renderWriteError('pref:autoOpenJobs')}
              </SettingRow>

              {/* 手机: the narrow-viewport adaptations. Both switches only ever
                  change what happens on a NARROW viewport (the plugin's own
                  768px bracket), so a desktop reader's behaviour is untouched
                  whatever they pick — and neither rewrites the wide-viewport
                  switches above. */}
              <div className={css.subHeading}>{t('settingsMobileTitle')}</div>
              <SettingRow label={t('settingsMobileNoAutoOpenTitle')} description={t('settingsMobileNoAutoOpenDesc')} className={css.row}>
                <ToggleSwitch
                  aria-label={t('settingsMobileNoAutoOpenTitle')}
                  checked={prefs.mobileNoAutoOpen}
                  onChange={(next) => { applyPref({ mobileNoAutoOpen: next }, 'pref:mobileNoAutoOpen') }}
                />
                {renderWriteError('pref:mobileNoAutoOpen')}
              </SettingRow>
              <SettingRow label={t('settingsMobileTreeTitle')} description={t('settingsMobileTreeDesc')} className={css.row}>
                <ToggleSwitch
                  aria-label={t('settingsMobileTreeTitle')}
                  checked={prefs.mobileDefaultTree}
                  onChange={(next) => { applyPref({ mobileDefaultTree: next }, 'pref:mobileDefaultTree') }}
                />
                {renderWriteError('pref:mobileDefaultTree')}
              </SettingRow>
            </div>
          )}

          {group === 'tabs' && renderTabsGroup()}
          {group === 'selection' && <>
            <SelectionSettingsPanel value={selectionSettingsOf(prefs)} sessionId={store.getSnapshot().sessionId}
              onChange={value => { applyPluginSetting('clues', 'selection', value) }} />
            {renderWriteError('plugin:clues:selection')}
          </>}

          {group === 'startPage' && (
            <div className={css.group}>
              <h2 className={css.groupHeading}>
                <span>{t('settingsStartPageTitle')}</span>
                <span className={css.count}>{orderedGuide.length}</span>
              </h2>
              <p className={css.groupHint}>{t('settingsStartPageDesc')}</p>
              <SettingRow label={t('settingsGuideTakeoverTitle')} description={t('settingsGuideTakeoverDesc')} className={css.row}>
                <ToggleSwitch
                  aria-label={t('settingsGuideTakeoverTitle')}
                  checked={prefs.guideTakeover}
                  onChange={(next) => { applyPref({ guideTakeover: next }, 'pref:guideTakeover') }}
                />
                {renderWriteError('pref:guideTakeover')}
              </SettingRow>
              <SettingRow label={t('settingsGuideRowsTitle')} description={t('settingsGuideRowsDesc')} className={css.row}>
                <GuideRowsInput
                  value={prefs.guideRows}
                  label={t('settingsGuideRowsTitle')}
                  onCommit={(next) => { applyPref({ guideRows: next }, 'pref:guideRows') }}
                />
                {renderWriteError('pref:guideRows')}
              </SettingRow>
              <SettingRow label={t('settingsGuideAlignTitle')} description={t('settingsGuideAlignDesc')} className={css.row}>
                <span className={css.segmented} role="radiogroup" aria-label={t('settingsGuideAlignTitle')}>
                  {(['center', 'top'] as const).map(value => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      className={clsx(css.segment, prefs.guideAlign === value && css.segmentOn)}
                      aria-checked={prefs.guideAlign === value}
                      onClick={() => { applyPref({ guideAlign: value }, 'pref:guideAlign') }}
                    >
                      {t(value === 'center' ? 'settingsGuideAlignCenter' : 'settingsGuideAlignTop')}
                    </button>
                  ))}
                </span>
                {renderWriteError('pref:guideAlign')}
              </SettingRow>
              <div className={css.guideOrderHeader}>
                <span>{t('guideOrder')}</span>
                <button
                  type="button"
                  className={css.guideReset}
                  onClick={() => { applyPref({ guideOrder: [] }, 'pref:guideOrder') }}
                >
                  {t('settingsGuideReset')}
                </button>
              </div>
              {orderedGuide.length === 0
                ? <p className={css.guideEmpty}>{t('guideEmpty')}</p>
                : (
                  <GuideOrderList
                    entries={orderedGuide}
                    hidden={guideSwitchHidden}
                    onMove={onMoveGuide}
                    onToggle={(entry, hidden) => { onToggleGuideEntry(entry, !hidden) }}
                  />
                )}
              {renderWriteError('pref:guideOrder')}
            </div>
          )}

          {group === 'viewers' && renderViewersGroup()}

          {group === 'sources' && (
            <div className={css.group}>
              <h2 className={css.groupHeading}>
                <span>{t('settingsGroupSources')}</span>
                <span className={css.count}>{catalogue?.sources.length ?? 0}</span>
              </h2>
              <ClueSourcesPanel
                sources={catalogue?.sources ?? []}
                displays={displays}
                statuses={statusById}
                prefs={prefs}
                writeErrors={writeErrors}
                loading={sourcesLoading}
                error={sourcesError}
                statusError={dependencyProbeError ?? connectionProbeError}
                catalogueLoaded={catalogue !== null}
                onToggleSource={onToggleSource}
                onToggleMention={onToggleSourceMention}
                onTogglePacksMention={onTogglePacksMention}
                onChangeWindowSurface={surface => { applyPluginSetting(CLUE_PREFS_ID, CLUE_WINDOW_SURFACE_SETTING, surface) }}
                onEnableAll={() => { setAllSources(true) }}
                onDisableAll={() => { setAllSources(false) }}
                onMentionAll={() => { setAllSourceMentions(true) }}
                onMentionNone={() => { setAllSourceMentions(false) }}
                onConfigure={openSourceConfigById}
                onAddSource={() => { setAddPluginsOpen('source') }}
                onReload={reloadSources}
              />
            </div>
          )}

          {group === 'appearance' && (
            <div className={css.group}>
              <h2 className={css.groupHeading}>{t('settingsCustomCssTitle')}</h2>
              <CssDraft
                key={prefs.customCss}
                value={prefs.customCss}
                label={t('settingsCustomCssTitle')}
                placeholder={t('settingsCustomCssPlaceholder')}
                onCommit={commitCustomCss}
              />
              {renderWriteError('pref:customCss')}
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
          closeLabel={t('close')}
          className={clsx(design.surface, css.popupDialog)}
          contentClassName={css.dialogContent}
          footer={(
            <ActionButton onClick={() => { setSettingsFor(null) }}>
              {t('settingsDone')}
            </ActionButton>
          )}
        >
          <SettingsBody
            feature={settingsFor}
            prefs={prefs}
            writeErrors={writeErrors}
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
          install). The clue-source entry is a SOURCE catalog of its own (S8
          §5): it must not present the TAB catalog as source recommendations.
          It mirrors the same body in `source-catalog-modal.tsx` — topic,
          search, category groups, jump and copy — because the generic
          AddPluginModal is outside this Spec's write scope. S9 can replace the
          mirror with one generic AddPluginModal('source') (recorded in
          `source-catalog.ts`).
          Mounted only while open (Modal runs hooks unconditionally — same
          SSR rule as the settings popup above). */}
      {addPluginsOpen === 'source' ? (
        <Modal
          open
          onClose={() => { setAddPluginsOpen(null) }}
          title={t('clueAddSource')}
          closeLabel={t('close')}
          className={clsx(design.surface, css.pluginModal)}
          contentClassName={css.dialogContent}
          footer={(
            <ActionButton onClick={() => { setAddPluginsOpen(null) }}>
              {t('settingsDone')}
            </ActionButton>
          )}
        >
          <SourceCatalogBody />
        </Modal>
      ) : addPluginsOpen !== null ? (
        <AddPluginModal
          service={service}
          onClose={() => { setAddPluginsOpen(null) }}
          kind={addPluginsOpen}
        />
      ) : null}
    </div>
  )
}
