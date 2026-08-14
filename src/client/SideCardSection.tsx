/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 *
 * The section is DECLARATIVE — it renders the enable/disable inventory from
 * the sidebar service's registries instead of hardcoding rows:
 *  - 常规: new conversations open the panel by default (a toggle row), the
 *    default panel width as a percent of the window (number input row), and
 *    the open-path interception toggle — the DSH settings-row recipe
 *    (title/desc left + control right, hairline separators).
 *  - 侧边栏内容: one SMALL CARD per REGISTERED tab type (built-ins and
 *    external plugins alike), laid out in a responsive grid that wraps
 *    several cards per row — icon chip + title + type id, clicked to toggle
 *    the switch persisted in `prefs.tabsEnabled[id]`.
 *  - 文件预览: one SMALL CARD per REGISTERED file viewer — icon chip + title
 *    + the extensions it covers, clicked to toggle `prefs.viewersEnabled[id]`.
 *
 * Every group lives in a container card (the DSH PluginCard recipe: l2
 * hairline, 16px radius, layer-3 fill) with a heading and an inventory count
 * badge (the settings catalogHeading recipe); the section opens with a
 * one-line intro (the DSH section heading+intro recipe).
 *
 * A card's on/off state is its VISUAL STATE: enabled = highlighted (brand
 * border + tinted fill + a circular check badge pinned to the card's far
 * right), disabled = neutral and dimmed. Features that declare
 * `settings.toggles` carry a gear corner button that opens a native Modal
 * (wider than the primitive default) with the related settings as
 * title/desc + custom-switch rows and a Done footer. The toggles
 * themselves are custom switches: a real checkbox (native semantics and
 * focus) driving a styled track/thumb.
 *
 * Writes ride the plugin's own fenced settings route (the host calls the
 * settings seam in-process — the DSH settings RPC domain does not serve
 * third-party namespaces to configuration clients); the shared SidebarStore
 * is refreshed on success so the very next brand-new session seeds from the
 * new values and the sidebar's consumption points (the + menu, derived
 * flows) re-render immediately. Any failure reverts the optimistic UI and
 * shows the wire error inline — a broken settings surface never crashes the
 * shell.
 */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  IconCheckOutline16,
  IconSettingsOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  clampWidthPercent,
  WIDTH_PERCENT_MAX,
  WIDTH_PERCENT_MIN,
  type SidebarPrefs,
} from '../prefs-shared.ts'
import { api } from './api.ts'
import { parsePrefs } from './prefs.ts'
import { t } from './locales.ts'
import { captureShortcutEvent, displayChord, SHORTCUT_DEFS } from './shortcuts.ts'
import type { SidebarStore } from './state.ts'
import type {
  BetterSidebarService,
  FileViewerDescriptor,
  SidebarSettingToggle,
  TabDescriptor,
} from './service.ts'
import css from './SideCardSection.module.css'

/** Injected business face: the shared store (prefs cache) + the sidebar service (registries). */
export interface SideCardSectionInjected {
  store: SidebarStore
  service: BetterSidebarService
}

/** Full section props: the runtime share plus the injected face. */
export type SideCardSectionProps = PropsRuntime<'settings.section'> & SideCardSectionInjected

/** A preference update may be static or derived from the latest successful
 * store value when its serialized write reaches the head of the queue. */
type PrefPatch = Record<string, unknown>
type PrefPatchInput = PrefPatch | ((current: SidebarPrefs) => PrefPatch)

/** Resolve one static/derived patch against a validated preference snapshot. */
function resolvePrefPatch(input: PrefPatchInput, current: SidebarPrefs): PrefPatch {
  return typeof input === 'function' ? input(current) : input
}

/** Map one wire failure to the inline message (the conflict gets friendly copy). */
function messageOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'settings-conflict') {
    return `${t('settingsSaveFailed')} ${t('settingsConflict')}`
  }
  return `${t('settingsSaveFailed')} ${error instanceof Error ? error.message : String(error)}`
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

/** Read one boolean pref by declarative key (missing = false). */
function prefBool(prefs: SidebarPrefs, key: string): boolean {
  return (prefs as unknown as Record<string, boolean>)[key] === true
}

/**
 * The custom switch: a real checkbox (hidden, native semantics and focus)
 * driving a styled track/thumb. Used by the general toggle rows and the
 * secondary settings popup rows.
 */
function Switch(props: {
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
}) {
  const { toggles, prefs, onToggle, onCommit } = props
  return (
    <div className={css.popupRows}>
      {toggles.map(toggle => {
        const title = textOf(toggle.title)
        if ((toggle.type ?? 'switch') === 'switch') {
          return (
            <div key={toggle.key} className={css.popupRow}>
              <span className={css.rowText}>
                <span className={css.title}>{title}</span>
                {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
              </span>
              <Switch
                label={title}
                checked={prefBool(prefs, toggle.key)}
                onChange={(next) => { onToggle(toggle, next) }}
              />
            </div>
          )
        }
        const value = String((prefs as unknown as Record<string, unknown>)[toggle.key] ?? '')
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
 * One configurable-shortcut row: activate the button, then press the desired
 * chord. Modifier-only keydowns show a live preview; a valid final key commits
 * immediately. Escape, Tab, click-away, and unsupported/bare keys never alter
 * the stored chord. Captured keydowns stop here so the shortcut currently being
 * edited cannot also trigger its app/browser action.
 */
export function ShortcutRow(props: {
  title: string
  value: string
  onCommit: (chord: string) => void
}) {
  const { title, value, onCommit } = props
  const [recording, setRecording] = useState(false)
  const [preview, setPreview] = useState('')
  const [feedback, setFeedback] = useState<'modifier-required' | 'unsupported-key' | null>(null)
  const descId = useId()

  const cancelRecording = (): void => {
    setRecording(false)
    setPreview('')
    setFeedback(null)
  }

  const desc = feedback === 'modifier-required'
    ? t('settingsShortcutModifierRequired')
    : feedback === 'unsupported-key'
      ? t('settingsShortcutUnsupported')
      : recording
        ? t('settingsShortcutRecording')
        : t('settingsShortcutDesc')

  return (
    <div className={clsx(css.row, css.shortcutRow)}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        <span
          id={descId}
          className={clsx(css.desc, feedback !== null && css.shortcutError)}
          aria-live="polite"
        >
          {desc}
        </span>
      </span>
      <span className={css.control}>
        <button
          type="button"
          className={clsx(css.shortcutRecorder, recording && css.shortcutRecorderActive)}
          aria-label={t('settingsShortcutRecordAria', { shortcut: title })}
          aria-describedby={descId}
          aria-pressed={recording}
          aria-invalid={feedback !== null ? true : undefined}
          onClick={() => {
            if (recording) cancelRecording()
            else {
              setRecording(true)
              setPreview('')
              setFeedback(null)
            }
          }}
          onBlur={cancelRecording}
          onKeyDown={event => {
            if (!recording) return
            const noModifiers = !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
            // A bare Tab cancels and keeps its native focus-navigation action;
            // the recorder must never become a keyboard trap.
            if (event.key === 'Tab' && noModifiers) {
              cancelRecording()
              return
            }
            event.preventDefault()
            event.stopPropagation()
            if (event.repeat) return
            if (event.key === 'Escape' && noModifiers) {
              cancelRecording()
              return
            }
            const captured = captureShortcutEvent(event)
            if (captured.kind === 'modifier') {
              setPreview(captured.preview)
              setFeedback(null)
              return
            }
            if (captured.kind === 'invalid') {
              setPreview('')
              setFeedback(captured.reason)
              return
            }
            setPreview('')
            setFeedback(null)
            setRecording(false)
            onCommit(captured.chord)
          }}
        >
          {recording && <span className={css.shortcutRecordingDot} aria-hidden="true" />}
          <span className={css.shortcutValue}>
            {recording ? (preview || t('settingsShortcutPressKeys')) : displayChord(value)}
          </span>
        </button>
      </span>
    </div>
  )
}

/**
 * Render the Side card preferences section.
 * @param props - composed slot props (runtime share + injected store/service).
 * @returns the section element tree.
 */
export function SideCardSection({ store, service }: SideCardSectionProps) {
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => store.getPrefs())
  const [widthDraft, setWidthDraft] = useState<string>(String(store.getPrefs().defaultWidthPercent))
  const [error, setError] = useState<string | null>(null)
  // Which feature's secondary settings popup is open (null = closed).
  const [settingsFor, setSettingsFor] = useState<TabDescriptor | null>(null)

  // The declarative inventory: the registered tab types and file viewers.
  // Local state + service.subscribe (registry changes are rare — plugin
  // load/unload — so a plain effect is enough; no external-store ceremony).
  const [tabs, setTabs] = useState<TabDescriptor[]>(() => [...service.getTabs()].sort(tabOrder))
  const [viewers, setViewers] = useState<FileViewerDescriptor[]>(() => [...service.getFileViewers()].sort(viewerOrder))
  useEffect(() => service.subscribe(() => {
    setTabs([...service.getTabs()].sort(tabOrder))
    setViewers([...service.getFileViewers()].sort(viewerOrder))
  }), [service])

  // The settings document revision (guards concurrent writes). A ref: commits
  // read the freshest value at execution time, no re-render needed.
  const revisionRef = useRef<number | undefined>(undefined)
  // The last authoritative settings value accepted from the route. Unlike
  // rendered `prefs`, this never contains optimistic edits, so queued writes
  // can safely derive from it and failed writes can always roll back to it.
  const committedPrefsRef = useRef<SidebarPrefs>(store.getPrefs())
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
    void api.settingsGet().then((view) => {
      if (cancelled) return
      revisionRef.current = view.revision
      if (dirtyRef.current) return
      const next = parsePrefs(view.value)
      committedPrefsRef.current = next
      store.setPrefs(next)
      setPrefs(next)
      setWidthDraft(String(next.defaultWidthPercent))
    }).catch(() => { /* the store's defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [])

  /** Persist one patch through the settings route (serialized, revision-guarded).
   *  Derived patches resolve only when their write runs, after every earlier
   *  successful write has refreshed the committed baseline. */
  const commit = (patchInput: PrefPatchInput): Promise<{ ok: boolean; prefs: SidebarPrefs }> => {
    dirtyRef.current = true
    const run = inFlightRef.current.then(async () => {
      const patch = resolvePrefPatch(patchInput, committedPrefsRef.current)
      const view = await api.settingsUpdate(
        { ...patch },
        revisionRef.current,
      )
      const next = parsePrefs(view.value)
      revisionRef.current = view.revision
      committedPrefsRef.current = next
      store.setPrefs(next)
      return next
    })
    // A failed commit must not poison the queue: later writes still run.
    inFlightRef.current = run.then(() => undefined, () => undefined)
    return run.then(
      (next) => ({ ok: true, prefs: next }),
      (caught) => {
        setError(messageOf(caught))
        // Another optimistic edit may already be queued, so the per-render
        // `prefs` snapshot is not a safe rollback target. The committed ref
        // advances only after an accepted mount read or successful write.
        return { ok: false, prefs: committedPrefsRef.current }
      },
    )
  }

  /** Settle one commit from its server-success or authoritative rollback value. */
  const applyOutcome = (outcome: { ok: boolean; prefs: SidebarPrefs }): void => {
    setPrefs(outcome.prefs)
    setWidthDraft(String(outcome.prefs.defaultWidthPercent))
  }

  /** Optimistically apply one pref patch, then commit (revert on failure). */
  const applyPref = (patchInput: PrefPatchInput): void => {
    const previous = prefs
    const patch = resolvePrefPatch(patchInput, previous)
    setPrefs({ ...previous, ...patch } as SidebarPrefs)
    setError(null)
    void commit(patchInput).then(applyOutcome)
  }

  const onToggle = (next: boolean): void => {
    applyPref({ openByDefault: next })
  }

  /** Flip one per-tab enable switch (merge into the tabsEnabled map). */
  const onToggleTab = (id: string, next: boolean): void => {
    applyPref({ tabsEnabled: { ...prefs.tabsEnabled, [id]: next } })
  }

  /** Flip one per-viewer enable switch (merge into the viewersEnabled map). */
  const onToggleViewer = (id: string, next: boolean): void => {
    applyPref({ viewersEnabled: { ...prefs.viewersEnabled, [id]: next } })
  }

  /** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
  const onToggleSetting = (toggle: SidebarSettingToggle, next: boolean): void => {
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

  /** Commit one shortcut chord (canonicalized) into the shortcuts map. The
   *  factory re-merges when its queued write begins, so a preceding pending
   *  shortcut write is preserved on success and omitted if it failed. */
  const onCommitShortcut = (id: string, chord: string): void => {
    applyPref(current => ({ shortcuts: { ...current.shortcuts, [id]: chord } }))
  }

  const commitWidth = (): void => {
    const parsed = Number(widthDraft)
    if (!Number.isFinite(parsed)) {
      setWidthDraft(String(prefs.defaultWidthPercent))
      return
    }
    const clamped = clampWidthPercent(parsed)
    const previous = prefs
    setPrefs({ ...previous, defaultWidthPercent: clamped })
    setWidthDraft(String(clamped))
    setError(null)
    void commit({ defaultWidthPercent: clamped }).then(applyOutcome)
  }

  /**
   * One SMALL toggle card for the responsive inventory grid: the card's main
   * area is the switch (click to flips, visual state IS the state), the icon
   * sits in a rounded chip, the check badge pins to the far right, and a
   * feature that declares related settings carries a gear corner button
   * opening its settings popup.
   */
  const renderCard = (props: {
    title: string
    desc: string
    icon?: ReactNode
    enabled: boolean
    onToggle: (next: boolean) => void
    /** A feature with declared related settings shows the gear corner button. */
    onOpenSettings?: () => void
  }) => {
    const hasSettings = props.onOpenSettings !== undefined
    return (
      <div
        className={clsx(css.card, props.enabled && css.cardOn, hasSettings && css.cardWithGear)}
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
              <span className={css.cardCheck}>
                <IconCheckOutline16 size={12} />
              </span>
            )}
          </span>
          <span className={css.cardDesc}>{props.desc}</span>
        </button>
        {hasSettings && (
          <button
            type="button"
            className={css.cardGear}
            aria-label={`${props.title} ${t('settingsPopup')}`}
            title={t('settingsPopup')}
            onClick={props.onOpenSettings}
          >
            <IconSettingsOutline16 size={12} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('settingsIntro')}</p>

      {/* 常规: the DSH settings-row recipe — title/desc left, control right. */}
      <div className={css.group}>
        <div className={css.groupHeading}>{t('settingsGeneralTitle')}</div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsOpenTitle')}</span>
            <span className={css.desc}>{t('settingsOpenDesc')}</span>
          </span>
          <Switch
            label={t('settingsOpenTitle')}
            checked={prefs.openByDefault}
            onChange={onToggle}
          />
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsWidthTitle')}</span>
            <span className={css.desc}>{t('settingsWidthDesc')}</span>
          </span>
          <span className={css.control}>
            <Input
              type="number"
              className={css.percentInput}
              value={widthDraft}
              min={WIDTH_PERCENT_MIN}
              max={WIDTH_PERCENT_MAX}
              step={1}
              aria-label={t('settingsWidthTitle')}
              onChange={event => { setWidthDraft(event.currentTarget.value) }}
              onBlur={commitWidth}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            <span className={css.suffix}>{t('settingsWidthSuffix')}</span>
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsOpenPathTitle')}</span>
            <span className={css.desc}>{t('settingsOpenPathDesc')}</span>
          </span>
          <Switch
            label={t('settingsOpenPathTitle')}
            checked={prefs.interceptOpenPath}
            onChange={(next) => { applyPref({ interceptOpenPath: next }) }}
          />
        </div>
      </div>

      {/* 快捷键: one recorder row per plugin keyboard shortcut. Activating the
          button captures the next modifier-plus-key chord and commits it
          immediately; the stored/default chord is resolved for display. */}
      <div className={css.group}>
        <div className={css.groupHeading}>{t('settingsShortcutsTitle')}</div>
        {SHORTCUT_DEFS.map(def => (
          <ShortcutRow
            key={`${def.id}:${prefs.shortcuts[def.id] ?? def.defaultChord}`}
            title={t(def.titleKey)}
            value={prefs.shortcuts[def.id] ?? def.defaultChord}
            onCommit={(chord) => { onCommitShortcut(def.id, chord) }}
          />
        ))}
      </div>

      {/* 侧边栏内容: one small card per registered tab type in a responsive
          grid; features declaring `settings.toggles` open their settings in
          the popup (gear corner button) instead of nested inline rows. */}
      <div className={css.group}>
        <div className={css.groupHeading}>
          <span>{t('settingsTabsTitle')}</span>
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
                onOpenSettings: prefs.tabsEnabled[tab.id] !== false
                  && (tab.settings?.toggles?.length ?? 0) > 0
                  ? () => { setSettingsFor(tab) }
                  : undefined,
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {/* 文件预览: one small card per registered file viewer. */}
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
              })}
            </Fragment>
          ))}
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
          title={textOf(settingsFor.title)}
          description={t('settingsPopupDesc', { feature: textOf(settingsFor.title) })}
          closeLabel={t('close')}
          className={css.popupDialog}
          footer={(
            <button type="button" className={css.done} onClick={() => { setSettingsFor(null) }}>
              {t('settingsDone')}
            </button>
          )}
        >
          <FeatureSettingsRows
            toggles={settingsFor.settings?.toggles ?? []}
            prefs={prefs}
            onToggle={onToggleSetting}
            onCommit={onCommitSetting}
          />
        </Modal>
      )}

      {error !== null && (
        <div className={css.error} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
