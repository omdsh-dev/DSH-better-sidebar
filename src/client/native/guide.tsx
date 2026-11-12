/**
 * The plugin's start page: the native guide slot's chain replacement.
 *
 * It draws the host's registered guide cards itself so the page can use a
 * two-column grid, a configurable row budget, and a "More" card. A card is
 * opened through the guide tab's own actions, exactly like the shipped guide
 * does, so the guide tab is replaced rather than left behind.
 */
import { createElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  IconEllipsisOutlineRegular,
  IconPluginPinwheelOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { SidebarPrefs } from '../../prefs-shared.ts'
import type { HostShellCatalog } from '../terminal-client.ts'
import type { SidebarStore } from '../state.ts'
import type { BetterSidebarService } from '../service.ts'
import { t } from '../locales.ts'
import { mergeGuideEntries, type NativeGuideCatalog, type NativeGuideEntry } from './guide-catalog.ts'
import { columnsForWidth, computeGuideLayout, orderGuideEntries } from './guide-layout.ts'
import { GuideOrderDialog } from './guide-order.tsx'
import { saveGuideOrder, saveGuideRows, setGuideEntryEnabled, setGuideEntryHidden } from './guide-prefs.ts'
import css from './guide.module.css'

/** The terminal service slice the card's native menu needs. */
export interface GuideShellMenu {
  launchShells: (signal: AbortSignal) => Promise<HostShellCatalog>
  selectShell: (path: string) => void
}

/** The native tab actions a guide card opens through (structurally the host's). */
interface GuideActions {
  openTab: (kind: string, options: { replaceTab?: boolean; params?: Record<string, unknown> }) => void
  close: () => void
}

/** What the chain component receives from the native registration. */
export interface NativeGuideProps {
  /** Host-injected hook for the guide tab's own record. */
  useTabInfo?: () => { tab: { actions: GuideActions } } | undefined
  catalog: NativeGuideCatalog
  store: SidebarStore
  /** The plugin registry, so disabled types stay in the reorder inventory. */
  service: BetterSidebarService
  /** Present only when the host exposes both shell catalog and selection. */
  shellMenu?: GuideShellMenu | undefined
  /** Host plugin discovery action, when the service exists. */
  onBrowsePlugins?: () => void
  /** Host "create your plugin" action, when the workspace can start a session. */
  onCreatePlugin?: () => void
}

/** The grid's inputs, extracted for direct rendering in tests. */
export interface GuideGridProps {
  entries: readonly NativeGuideEntry[]
  prefs: Pick<SidebarPrefs, 'guideOrder' | 'guideHidden' | 'guideRows' | 'guideAlign' | 'tabsEnabled'>
  /** Pane width in CSS pixels. */
  width: number
  onOpen: (entry: NativeGuideEntry, params?: Record<string, unknown>) => void
  onSaveOrder?: (order: readonly string[]) => void
  onToggleHidden?: (entry: NativeGuideEntry, hidden: boolean) => void
  onSaveRows?: (rows: number) => void
  /** The editable inventory (live cards plus disabled plugin descriptors). */
  inventory?: readonly NativeGuideEntry[]
  /** Host "Browse other plugins" action, when the navigation service exists. */
  onBrowsePlugins?: () => void
  /** Host "Create your plugin" action, when the workspace can start a session. */
  onCreatePlugin?: () => void
  shellMenu?: GuideShellMenu | undefined
}

/** One card's glyph, when it has one. */
function cardIcon(entry: NativeGuideEntry): ReactNode {
  const Icon: ComponentType<{ size?: number }> | undefined = entry.icon
  return Icon === undefined ? null : createElement(Icon, { size: 16 })
}

/** Menu glyphs sit in a fixed 14px box; some custom icons keep their own
 *  baseline, so center the SVG explicitly or it rides 2px above the label. */
function menuIcon(icon: ReactNode): ReactNode {
  return icon === null ? null : <span className={css.menuIcon} aria-hidden="true">{icon}</span>
}

/** The terminal card's shell menu: the host's shell catalog, drawn natively here. */
function TerminalMenu(props: {
  entry: NativeGuideEntry
  shellMenu: GuideShellMenu
  onOpen: (entry: NativeGuideEntry, params?: Record<string, unknown>) => void
}) {
  const { entry, shellMenu, onOpen } = props
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'ready'; shells: HostShellCatalog['shells']; selected?: string }
    | { phase: 'failed'; message: string }
  >({ phase: 'loading' })

  useEffect(() => {
    if (!open) return
    const lifetime = new AbortController()
    let live = true
    setState({ phase: 'loading' })
    Promise.resolve()
      .then(() => shellMenu.launchShells(lifetime.signal))
      .then((catalog) => {
        if (!live) return
        setState({
          phase: 'ready',
          shells: catalog.shells,
          ...(catalog.selectedShell === undefined ? {} : { selected: catalog.selectedShell }),
        })
      }, (error: unknown) => {
        if (!live) return
        setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      live = false
      lifetime.abort()
    }
  }, [open, attempt, shellMenu])

  const items = state.phase === 'loading'
    ? [{ id: 'loading', label: t('loading'), disabled: true }]
    : state.phase === 'failed'
      ? [
        { id: 'failed', label: t('guideShellFailed', { error: state.message }), disabled: true },
        { id: 'retry', label: t('terminalRetry') },
      ]
      : state.shells.length === 0
        ? [{ id: 'empty', label: t('guideShellEmpty'), disabled: true }]
        : state.shells.map(shell => ({ id: shell.path, label: shell.name }))

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      portal
      autoFocus
      align="end"
      items={items}
      selectedId={state.phase === 'ready' ? state.selected : undefined}
      onSelect={(id) => {
        if (state.phase === 'failed') {
          if (id === 'retry') setAttempt(value => value + 1)
          return
        }
        if (state.phase !== 'ready') return
        shellMenu.selectShell(id)
        setOpen(false)
        onOpen(entry, { shellPath: id })
      }}
      anchor={(
        <button
          type="button"
          className={css.cardMenuButton}
          data-guide-shell-menu="true"
          aria-label={t('terminal')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconEllipsisOutlineRegular size={14} />
        </button>
      )}
    />
  )
}

/** One card in the start-page grid. */
function GuideCard(props: {
  entry: NativeGuideEntry
  onOpen: (entry: NativeGuideEntry, params?: Record<string, unknown>) => void
  shellMenu?: GuideShellMenu | undefined
}) {
  const { entry, onOpen, shellMenu } = props
  const description = entry.description?.()
  const terminal = entry.kind === 'terminal' && shellMenu !== undefined
  return (
    <div className={css.card} data-sidebar-right-guide-entry={entry.kind}>
      <button
        type="button"
        className={css.cardMain}
        aria-label={description === undefined ? entry.title() : entry.title() + ' ' + description}
        onClick={() => { onOpen(entry) }}
      >
        <span className={css.cardIcon} aria-hidden="true">{cardIcon(entry)}</span>
        <span className={css.cardText}>
          <span className={css.cardTitle}>{entry.title()}</span>
          {description === undefined ? null : <span className={css.cardDesc}>{description}</span>}
        </span>
      </button>
      {terminal ? <TerminalMenu entry={entry} shellMenu={shellMenu} onOpen={onOpen} /> : null}
    </div>
  )
}

/** The whole start-page grid, including the More card and the order dialog. */
export function GuideGrid(props: GuideGridProps) {
  const {
    entries, prefs, width, onOpen, onSaveOrder, onToggleHidden, onSaveRows,
    onBrowsePlugins, onCreatePlugin, shellMenu,
  } = props
  const inventory = props.inventory ?? entries
  const [orderOpen, setOrderOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // A Better Sidebar type's switch is the FEATURE switch (tabsEnabled), not
  // the start-page visibility map; older guideHidden keys for those types are
  // ignored so the two surfaces cannot disagree.
  const hiddenForLayout: Record<string, boolean> = { ...prefs.guideHidden }
  for (const entry of entries) {
    if (entry.descriptorId !== undefined) delete hiddenForLayout[entry.key]
  }
  const layout = computeGuideLayout(entries, {
    order: prefs.guideOrder,
    hidden: hiddenForLayout,
    rows: prefs.guideRows,
    width,
    // The More card is also the home of the host's plugin discovery/creation
    // actions, so it stays available even when every tab fits.
    reserveMore: true,
  })
  const orderedAll = orderGuideEntries(inventory, prefs.guideOrder)
  const switchHidden: Record<string, boolean> = {}
  for (const entry of orderedAll) {
    switchHidden[entry.key] = entry.descriptorId === undefined
      ? prefs.guideHidden[entry.key] === true
      : prefs.tabsEnabled[entry.descriptorId] === false
  }

  const move = (key: string, delta: -1 | 1): void => {
    const keys = orderedAll.map(entry => entry.key)
    const at = keys.indexOf(key)
    const to = at + delta
    if (at < 0 || to < 0 || to >= keys.length) return
    const next = [...keys]
    const [moved] = next.splice(at, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    onSaveOrder?.(next)
  }

  const hostActions = [
    ...(onBrowsePlugins === undefined
      ? []
      : [{ id: 'browse', label: t('guideBrowsePlugins'), icon: menuIcon(<IconPluginPinwheelOutlineRegular size={16} />) }]),
    ...(onCreatePlugin === undefined
      ? []
      : [{ id: 'create', label: t('guideCreatePlugin'), icon: menuIcon(<IconPlusOutlineRegular size={16} />) }]),
  ]
  const moreItems = [
    ...layout.overflow.map(entry => ({
      id: 'open:' + entry.key,
      label: entry.title(),
      icon: menuIcon(cardIcon(entry)),
    })),
    ...(layout.overflow.length === 0 ? [] : [{ type: 'separator' as const, id: 'overflow-separator' }]),
    ...hostActions,
    ...(hostActions.length === 0 ? [] : [{ type: 'separator' as const, id: 'actions-separator' }]),
    { id: 'order', label: t('guideOrder'), icon: menuIcon(<IconSettingsOutlineRegular size={14} />) },
  ]

  /** The grid body; the More anchor is a card-sized Menu trigger. */
  const moreCard = (
    <div className={css.moreSlot}>
    <Menu
      open={moreOpen}
      onClose={() => { setMoreOpen(false) }}
      portal
      autoFocus
      align="end"
      items={moreItems}
      onSelect={(id) => {
        setMoreOpen(false)
        if (id === 'browse') {
          onBrowsePlugins?.()
          return
        }
        if (id === 'create') {
          onCreatePlugin?.()
          return
        }
        if (id === 'order') {
          setOrderOpen(true)
          return
        }
        if (!id.startsWith('open:')) return
        const key = id.slice('open:'.length)
        const entry = layout.overflow.find(candidate => candidate.key === key)
        if (entry !== undefined) onOpen(entry)
      }}
      anchor={(
        <button
          type="button"
          className={clsx(css.card, css.moreCard)}
          data-guide-more="true"
          aria-label={t('guideMore')}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => { setMoreOpen(value => !value) }}
        >
          <span className={css.cardIcon} aria-hidden="true">
            <IconEllipsisOutlineRegular size={18} />
          </span>
          <span className={css.cardText}>
            <span className={css.cardTitle}>{t('guideMore')}</span>
          </span>
        </button>
      )}
    />
    </div>
  )

  return (
    <div
      className={css.guide}
      data-guide-columns={layout.columns}
      data-guide-rows={layout.rows}
      data-guide-align={prefs.guideAlign}
    >
      {layout.visible.length === 0 && !layout.showMore ? (
        <p className={css.empty}>{t('guideEmpty')}</p>
      ) : (
        <div className={clsx(css.grid, layout.columns === 2 ? css.gridTwo : css.gridOne)}>
          {layout.visible.map(entry => (
            <GuideCard key={entry.key} entry={entry} onOpen={onOpen} shellMenu={shellMenu} />
          ))}
          {layout.showMore ? moreCard : null}
        </div>
      )}
      <GuideOrderDialog
        open={orderOpen}
        onClose={() => { setOrderOpen(false) }}
        entries={orderedAll}
        hidden={switchHidden}
        onMove={move}
        onToggle={(entry, hidden) => { onToggleHidden?.(entry, hidden) }}
        rows={prefs.guideRows}
        onRows={(next) => { onSaveRows?.(next) }}
      />
    </div>
  )
}

/** Measure the pane width so the grid can choose one or two columns. */
function useGuideWidth(ref: { current: HTMLDivElement | null }): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    const measure = (): void => { setWidth(node.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [ref])
  return width
}

/** The chain component registered into the host's guide slot. */
export function NativeGuide(props: NativeGuideProps) {
  const { catalog, store, service, shellMenu, onBrowsePlugins, onCreatePlugin, useTabInfo } = props
  const entries = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
  const [descriptors, setDescriptors] = useState(() => service.getTabs())
  useEffect(() => service.subscribe(() => setDescriptors(service.getTabs())), [service])
  // The store's members are methods (they read their receiver); bind them
  // through arrows or useSyncExternalStore crashes on the first render.
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
  const prefs = snapshot.prefs
  const liveEntries = entries.filter(entry => entry.descriptorId === undefined
    || prefs.tabsEnabled[entry.descriptorId] !== false)
  const inventory = mergeGuideEntries(entries, descriptors, prefs.tabsEnabled)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const width = useGuideWidth(rootRef)
  const actions = useTabInfo?.()?.tab.actions

  const open = (entry: NativeGuideEntry, params?: Record<string, unknown>): void => {
    if (actions === undefined) return
    actions.openTab(entry.kind, { replaceTab: true, ...(params === undefined ? {} : { params }) })
    actions.close()
  }

  return (
    <div
      ref={rootRef}
      className={clsx(css.root, prefs.guideAlign === 'top' ? css.rootTop : css.rootCenter)}
      data-sidebar-right-guide=""
      data-dsh-guide-grid="true"
      data-guide-columns={columnsForWidth(width)}
      data-guide-rows={prefs.guideRows}
      data-guide-align={prefs.guideAlign}
    >
      <GuideGrid
        entries={liveEntries}
        inventory={inventory}
        prefs={prefs}
        width={width}
        onOpen={open}
        onSaveOrder={(order) => { saveGuideOrder(store, order) }}
        onToggleHidden={(entry, hidden) => {
          if (entry.descriptorId === undefined) setGuideEntryHidden(store, entry.key, hidden)
          else setGuideEntryEnabled(store, entry.descriptorId, !hidden)
        }}
        onSaveRows={(next) => { saveGuideRows(store, next) }}
        onBrowsePlugins={onBrowsePlugins}
        onCreatePlugin={onCreatePlugin}
        shellMenu={shellMenu}
      />
    </div>
  )
}
