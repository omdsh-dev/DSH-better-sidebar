/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 *
 * The section is DECLARATIVE — it renders the enable/disable inventory from
 * the sidebar service's registries instead of hardcoding rows:
 *  - 常规: new conversations open the panel by default (a toggle card), and
 *    the default panel width as a percent of the window (number input row).
 *  - 侧边栏内容: one SMALL CARD per REGISTERED tab type (built-ins and
 *    external plugins alike), laid out in a responsive grid that wraps
 *    several cards per row — icon + title + type id, clicked to toggle the
 *    switch persisted in `prefs.tabsEnabled[id]`.
 *  - 文件预览: one SMALL CARD per REGISTERED file viewer — icon + title +
 *    the extensions it covers, clicked to toggle `prefs.viewersEnabled[id]`.
 *
 * A card's on/off state is its VISUAL STATE: enabled = highlighted (brand
 * border + tinted fill + a check badge pinned to the card's far right),
 * disabled = neutral and dimmed. Features that declare `settings.toggles`
 * / `settings.texts` carry a gear corner button that opens a native Modal
 * with the related settings as native checkbox rows (e.g. the Subagent
 * page's "auto-open when a subagent appears") and/or multi-line text rows
 * (e.g. the Explorer page's exclude patterns).
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
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconCheckOutline16,
  IconCodeOutline16,
  IconPanelLeftOutline16,
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
import type { SidebarStore } from './state.ts'
import type {
  BetterSidebarService,
  FileViewerDescriptor,
  SidebarSettingText,
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

/** Read one string-array pref by declarative key (missing/non-array = []). */
function prefStrings(prefs: SidebarPrefs, key: string): string[] {
  const value = (prefs as unknown as Record<string, unknown>)[key]
  return Array.isArray(value) ? value : []
}

/**
 * One declarative TEXT row: a multi-line input (one value per line) that
 * commits on blur — the explorer exclude patterns. Draft stays local while
 * typing; the external value (prefs round-trip) re-syncs the draft only
 * when the committed array actually changes, so in-progress edits are
 * never clobbered by re-renders.
 */
export function TextSettingRow(props: {
  text: SidebarSettingText
  prefs: SidebarPrefs
  onCommit: (text: SidebarSettingText, lines: string[]) => void
}) {
  const { text, prefs, onCommit } = props
  const title = textOf(text.title)
  const value = prefStrings(prefs, text.key)
  const serialized = useMemo(() => value.join('\n'), [value])
  const [draft, setDraft] = useState(serialized)
  useEffect(() => { setDraft(serialized) }, [serialized])
  /** Normalize: trim, drop blanks, dedupe preserving order. */
  const normalized = (): string[] => {
    const lines: string[] = []
    for (const line of draft.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || lines.includes(trimmed)) continue
      lines.push(trimmed)
    }
    return lines
  }
  /** Commit only when the edit actually changed the patterns (blur on a
   *  pristine box writes nothing). */
  const commit = (): void => {
    const lines = normalized()
    if (lines.length === value.length && lines.every((line, i) => line === value[i])) return
    onCommit(text, lines)
  }
  return (
    <div className={css.textRow} key={text.key}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(text.desc) !== '' && <span className={css.desc}>{textOf(text.desc)}</span>}
      </span>
      <textarea
        className={css.textSetting}
        rows={3}
        spellCheck={false}
        value={draft}
        placeholder={textOf(text.placeholder)}
        aria-label={title}
        onChange={event => { setDraft(event.currentTarget.value) }}
        onBlur={commit}
        onKeyDown={event => {
          // Ctrl/Cmd+Enter commits without leaving the box; plain Enter
          // starts a new pattern line.
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

/**
 * The body of a feature's secondary settings popup: one native checkbox row
 * per declared toggle, then one multi-line text row per declared text.
 * Extracted so the rows are testable without opening the Modal (the Modal
 * portal renders only while open).
 */
export function FeatureSettingsRows(props: {
  toggles: readonly SidebarSettingToggle[]
  texts: readonly SidebarSettingText[]
  prefs: SidebarPrefs
  onToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  onCommitText: (text: SidebarSettingText, lines: string[]) => void
}) {
  const { toggles, texts, prefs, onToggle, onCommitText } = props
  return (
    <div className={css.popupRows}>
      {toggles.map(toggle => {
        const title = textOf(toggle.title)
        return (
          <label key={toggle.key} className={css.popupRow}>
            <span className={css.rowText}>
              <span className={css.title}>{title}</span>
              {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
            </span>
            <input
              type="checkbox"
              className={css.toggle}
              checked={prefBool(prefs, toggle.key)}
              aria-label={title}
              onChange={event => { onToggle(toggle, event.currentTarget.checked) }}
            />
          </label>
        )
      })}
      {texts.map(text => (
        <TextSettingRow key={text.key} text={text} prefs={prefs} onCommit={onCommitText} />
      ))}
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
      setPrefs(next)
      setWidthDraft(String(next.defaultWidthPercent))
    }).catch(() => { /* the store's defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [])

  /** Persist one patch through the settings route (serialized, revision-guarded). */
  const commit = (patch: Record<string, unknown>): Promise<{ ok: boolean; prefs: SidebarPrefs }> => {
    dirtyRef.current = true
    const run = inFlightRef.current.then(async () => {
      const view = await api.settingsUpdate(
        { ...patch },
        revisionRef.current,
      )
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
        return { ok: false, prefs }
      },
    )
  }

  /** Settle one commit: success adopts the server values, failure reverts. */
  const applyOutcome = (previous: SidebarPrefs, outcome: { ok: boolean; prefs: SidebarPrefs }): void => {
    const settled = outcome.ok ? outcome.prefs : previous
    setPrefs(settled)
    setWidthDraft(String(settled.defaultWidthPercent))
  }

  /** Optimistically flip one boolean pref, then commit (revert on failure). */
  const togglePref = (patch: Record<string, unknown>): void => {
    const previous = prefs
    setPrefs({ ...previous, ...patch } as SidebarPrefs)
    setError(null)
    void commit(patch).then(outcome => applyOutcome(previous, outcome))
  }

  const onToggle = (next: boolean): void => {
    togglePref({ openByDefault: next })
  }

  /** Flip one per-tab enable switch (merge into the tabsEnabled map). */
  const onToggleTab = (id: string, next: boolean): void => {
    togglePref({ tabsEnabled: { ...prefs.tabsEnabled, [id]: next } })
  }

  /** Flip one per-viewer enable switch (merge into the viewersEnabled map). */
  const onToggleViewer = (id: string, next: boolean): void => {
    togglePref({ viewersEnabled: { ...prefs.viewersEnabled, [id]: next } })
  }

  /** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
  const onToggleSetting = (toggle: SidebarSettingToggle, next: boolean): void => {
    togglePref({ [toggle.key]: next })
  }

  /** Commit one declaratively-declared text setting (a SidebarPrefs string-array field). */
  const onCommitTextSetting = (text: SidebarSettingText, lines: string[]): void => {
    const previous = prefs
    setPrefs({ ...previous, [text.key]: lines } as SidebarPrefs)
    setError(null)
    void commit({ [text.key]: lines }).then(outcome => applyOutcome(previous, outcome))
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
    void commit({ defaultWidthPercent: clamped }).then(outcome => applyOutcome(previous, outcome))
  }

  /**
   * One SMALL toggle card for the responsive inventory grid: the card's main
   * area is the switch (click to flips, visual state IS the state), the
   * check badge sits at the far right, and a feature that declares related
   * settings carries a gear corner button opening its settings popup.
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
              <span className={css.cardIcon}>{props.icon}</span>
            )}
            <span className={css.cardTitle}>{props.title}</span>
            {props.enabled && (
              <span className={css.cardCheck}>
                <IconCheckOutline16 size={14} />
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
            <IconSettingsOutline16 size={14} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHeading}>{t('settingsGeneralTitle')}</div>
      {renderCard({
        title: t('settingsOpenTitle'),
        desc: t('settingsOpenDesc'),
        icon: <IconPanelLeftOutline16 size={16} />,
        enabled: prefs.openByDefault,
        onToggle,
      })}
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
      {renderCard({
        title: t('settingsOpenPathTitle'),
        desc: t('settingsOpenPathDesc'),
        icon: <IconCodeOutline16 size={16} />,
        enabled: prefs.interceptOpenPath,
        onToggle: (next) => { togglePref({ interceptOpenPath: next }) },
      })}

      {/* 侧边栏内容: one small card per registered tab type in a responsive
          grid; features declaring `settings.toggles` open their settings in
          the popup (gear corner button) instead of nested inline rows. */}
      <div className={css.sectionHeading}>{t('settingsTabsTitle')}</div>
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
                && ((tab.settings?.toggles?.length ?? 0) > 0
                  || (tab.settings?.texts?.length ?? 0) > 0)
                ? () => { setSettingsFor(tab) }
                : undefined,
            })}
          </Fragment>
        ))}
      </div>

      {/* 文件预览: one small card per registered file viewer. */}
      <div className={css.sectionHeading}>{t('settingsViewersTitle')}</div>
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

      {/* The secondary settings popup: a feature's declared related settings
          as native checkbox rows (Modal chrome is the app's own). Mounted
          only while a feature is open — the Modal primitive runs hooks
          unconditionally, so a closed-but-mounted Modal would break SSR
          (and the renderToString spec) under the test dual-react split. */}
      {settingsFor !== null && (
        <Modal
          open
          onClose={() => { setSettingsFor(null) }}
          title={textOf(settingsFor.title)}
          closeLabel={t('close')}
        >
          <FeatureSettingsRows
            toggles={settingsFor.settings?.toggles ?? []}
            texts={settingsFor.settings?.texts ?? []}
            prefs={prefs}
            onToggle={onToggleSetting}
            onCommitText={onCommitTextSetting}
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
