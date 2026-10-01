/**
 * The plugin's side of a native right-Sidebar tab.
 *
 * A plugin tab descriptor is one registration in the plugin's own registry
 * (`ctx.betterSidebar`); this module adapts the native tab record to that
 * descriptor's component contract. The native surface carries the tab's
 * record (id, kind, title, content identity, navigation params, lifetime
 * signal); the plugin's components expect a `SidebarTab` plus the explorer
 * state the plugin's own layout used to hold — both live here.
 *
 * The adapter owns three things the native layout does not carry:
 *
 * - a synthetic plugin `SidebarTab` per native tab id, minted from the native
 *   record + `navigation.params` and kept live across navigations, so a
 *   component that retitles itself (`updateTab`) or rewrites its path (the
 *   editor's in-place file switch) keeps working;
 * - the explorer's expansion/reveal sets: EXPANSION lives in the per-session
 *   state the workbench already uses (one set per session, shared by every
 *   native tab of that session — a closed tab cannot drop it), while the
 *   transient "show in folder" reveal stays per tab;
 * - the per-kind instance counter behind titles like "Terminal 2".
 *
 * Nothing here is a singleton: the registry is created once per client
 * activation and handed to every registration.
 */
import { createElement, useMemo, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '../../context-types.ts'
import type { SessionScope } from '../api.ts'
import { RenderBoundary } from '../RenderBoundary.tsx'
import { OrphanedTab } from '../OrphanedTab.tsx'
import { referenceInChat } from '../reference-in-chat.ts'
import type { BetterSidebarService } from '../service.ts'
import { toggleExpanded } from '../state.ts'
import type { SidebarStore, SidebarTab, TabType } from '../state.ts'
import css from '../sidebar.module.css'

/** The chip glyph's size: the tab strip's own icon scale. */
const CHIP_ICON_SIZE = 14

/** The editor kind: a chip for a file row shows the file's own glyph. */
const EDITOR_KIND = 'editor'

/**
 * The plugin-side seed a native open carries in `navigation.params`.
 * JSON-shaped by convention (the native surface does not validate it).
 */
export interface NativeTabParams {
  /** Overrides the descriptor's title for this instance. */
  readonly title?: string
  /** A file path (the editor window's content seed). */
  readonly path?: string
  /** A URL the tab navigates to on mount (the browser tab's seed). */
  readonly url?: string
  /** A diff reference (the diff tab's content seed). */
  readonly diff?: SidebarTab['diff']
  /** JSON-serializable custom state carried on the synthetic record. */
  readonly meta?: unknown
  /** A line to land on (file addresses carry it as a navigation parameter). */
  readonly line?: number
}

/** The native tab information this adapter reads (structural mirror of `useTabInfo`). */
export interface NativeTabInfo {
  readonly tab: {
    readonly id: string
    readonly kind: string
    readonly title: string
    readonly contentId: string
    readonly visible: boolean
    readonly navigation: {
      readonly address: string
      readonly params: NativeTabParams | undefined
      readonly revision: number
    }
    readonly signal: AbortSignal
  }
}

/** One native tab's plugin-side view state. */
interface View {
  tab: SidebarTab
  scope: SessionScope
  /**
   * A PROJECTION of the session's expansion set (never an authoritative copy):
   * refreshed from the store on every `ensure` and on every store change, so
   * every native tab of one session shows the same set and reopening a tab
   * cannot reset it. Cached only for referential stability — a fresh array on
   * each render would re-run the tree's load effect for nothing.
   */
  expanded: string[]
  /** The transient "show in folder" highlight: per tab by design. */
  revealed: string[]
  /** Bumped on every mutation; the components subscribe to it. */
  version: number
}

/**
 * The record key: one native tab id names a tab in EVERY session (the host's
 * per-session counter restarts at `tab1`), and DSH 0.1.7 keeps visited bodies
 * mounted through hiding, tab selection and Session switches
 * (`SidebarRightTabDefinition.keepMounted`). Two sessions' `tab1` are therefore
 * ALIVE AT THE SAME TIME — a registry keyed by the bare id would hand one
 * session's tree/scroll/draft state to the other. The seat's session is part
 * of the record's identity.
 */
function viewKey(sessionId: string, id: string): string {
  return `${sessionId}::${id}`
}

/** The plugin-side record registry for native tabs. */
export interface NativeTabRecords {
  /**
   * The synthetic record for one seat's native tab, minted on first sight and
   * kept across navigations (a navigation refreshes the seed fields, never the
   * identity or a plugin-side title/meta mutation).
   * @param input - the native record, its seat session, and the content scope.
   * @returns the current view state.
   */
  ensure(input: {
    /**
     * The SEAT session this tab is drawn in — the record's identity. Not to be
     * confused with `scope.sessionId`: a file address carries its own session,
     * which is the namespace its content is read/written in.
     */
    sessionId: string
    id: string
    kind: string
    title: string
    params: NativeTabParams | undefined
    scope: SessionScope
    /**
     * The descriptor's own factory, called ONCE for a record that arrives
     * without seed fields (a native guide open, which knows nothing about the
     * plugin's per-instance minting): it supplies the title and the meta a
     * view needs — the side chat's thread bootstrap, the terminal's name.
     */
    mint?: () => { title?: string; meta?: unknown } | undefined
  }): View
  /** One record by its seat session and native tab id. */
  get(sessionId: string, id: string): View | undefined
  /** Whether this seat session has a record for the id. */
  has(sessionId: string, id: string): boolean
  /** Merge a patch into the synthetic record (the `updateTab` path). */
  update(sessionId: string, id: string, patch: { title?: string; path?: string; meta?: unknown }): void
  /**
   * Forget one record. Called when the NATIVE TAB really closes — never from a
   * body unmount, because a Session switch remounts bodies while the reader's
   * state must survive.
   */
  drop(sessionId: string, id: string): void
  /**
   * Bind the plugin store — the per-session state is the AUTHORITY for every
   * view's expansion set. Idempotent; the first call also subscribes to store
   * changes so a toggle made anywhere (the workbench, another native tab, a
   * persisted restore) refreshes every native view.
   */
  attachStore(store: SidebarStore): void
  /**
   * Toggle one directory in the SCOPE session's expansion set (the set every
   * view of that session mirrors); `sessionId` names the record's SEAT.
   */
  toggleExpanded(sessionId: string, id: string, path: string): void
  /**
   * Keep only records of these sessions; the rest are forgotten. A session the
   * user deleted never unmounts anything the plugin can hook, so its records
   * (and a retained body) would otherwise live for the life of the page.
   */
  retain(sessions: ReadonlySet<string>): void
  /** Mint the next instance number of a kind (titles like "Terminal 2"). */
  nextInstance(kind: string): number
  /** A per-record version for `useSyncExternalStore`. */
  versionOf(sessionId: string, id: string): number
  /** Subscribe to record changes (title/path/meta/expanded). */
  subscribe(listener: () => void): () => void
}

/** Whether two expansion sets hold the same paths in the same order. */
function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

/** Create the record registry for one client activation. */
export function createNativeTabRecords(): NativeTabRecords {
  const views = new Map<string, View>()
  const instances = new Map<string, number>()
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const put = (key: string, view: View): void => {
    views.set(key, { ...view, version: view.version + 1 })
    notify()
  }
  /** The session-state authority (bound through {@link NativeTabRecords.attachStore}). */
  let store: SidebarStore | undefined
  /** The session's expansion set (absent session = nothing expanded yet). */
  const expandedOf = (sessionId: string): string[] =>
    store?.getSessionStates().get(sessionId)?.expanded ?? []
  /**
   * Re-read every view's expansion projection from the session state. Views
   * that changed get a version bump (which is what re-renders their bodies);
   * identical sets keep their array identity so the tree's `expanded` prop —
   * and therefore its load effect — stays stable.
   */
  const syncExpanded = (): void => {
    if (store === undefined) return
    // One map copy for the whole pass (getSessionStates copies by contract).
    const states = store.getSessionStates()
    let changed = false
    for (const [id, entry] of views) {
      const next = states.get(entry.scope.sessionId)?.expanded ?? []
      if (samePaths(entry.expanded, next)) continue
      views.set(id, { ...entry, expanded: next, version: entry.version + 1 })
      changed = true
    }
    if (changed) notify()
  }
  return {
    attachStore(next) {
      if (store === next) return
      store = next
      // One listener for the whole registry: the store lives as long as this
      // activation, so the returned disposer is not kept.
      next.subscribe(syncExpanded)
      syncExpanded()
    },
    ensure({ sessionId, id, kind, title, params, scope, mint }) {
      const key = viewKey(sessionId, id)
      const existing = views.get(key)
      if (existing === undefined) {
        const seeded = params?.title === undefined && params?.meta === undefined ? mint?.() : undefined
        const meta = params?.meta ?? seeded?.meta
        const minted: View = {
          tab: {
            id,
            type: kind as TabType,
            title: params?.title ?? seeded?.title ?? title,
            ...(params?.path === undefined ? {} : { path: params.path }),
            ...(params?.diff === undefined ? {} : { diff: params.diff }),
            ...(meta === undefined ? {} : { meta }),
          },
          scope,
          expanded: expandedOf(scope.sessionId),
          revealed: [],
          version: 0,
        }
        views.set(key, minted)
        return minted
      }
      // A navigation may carry new seed fields (the editor's in-place switch,
      // a browser tab pointed at another URL); the record's identity and any
      // plugin-side mutation (title/meta from updateTab) stay.
      const patch: Partial<SidebarTab> = {}
      if (params?.path !== undefined && params.path !== existing.tab.path) patch.path = params.path
      if (params?.diff !== undefined) patch.diff = params.diff
      if (params?.url !== undefined) {
        const meta = typeof existing.tab.meta === 'object' && existing.tab.meta !== null
          ? existing.tab.meta as Record<string, unknown>
          : {}
        patch.meta = { ...meta, url: params.url }
      }
      // The expansion set always mirrors the CURRENT session state (a record
      // reused for another session must not keep the previous one's set).
      const expanded = expandedOf(scope.sessionId)
      if (existing.scope.sessionId !== scope.sessionId || !samePaths(existing.expanded, expanded)) {
        views.set(key, { ...existing, scope, expanded, tab: { ...existing.tab, ...patch } })
        return views.get(key)!
      }
      if (existing.scope.cwd !== scope.cwd) {
        views.set(key, { ...existing, scope, tab: { ...existing.tab, ...patch } })
        return views.get(key)!
      }
      if (Object.keys(patch).length === 0) return existing
      const next: View = { ...existing, tab: { ...existing.tab, ...patch } }
      views.set(key, next)
      return next
    },
    get: (sessionId, id) => views.get(viewKey(sessionId, id)),
    has: (sessionId, id) => views.has(viewKey(sessionId, id)),
    update(sessionId, id, patch) {
      const key = viewKey(sessionId, id)
      const entry = views.get(key)
      if (entry === undefined) return
      put(key, { ...entry, tab: { ...entry.tab, ...patch } })
    },
    drop(sessionId, id) {
      if (views.delete(viewKey(sessionId, id))) notify()
    },
    toggleExpanded(sessionId, id, path) {
      const entry = views.get(viewKey(sessionId, id))
      if (entry === undefined || store === undefined) return
      const scopeSessionId = entry.scope.sessionId
      // The ACTIVE session goes through `reduce` (it notifies, so the native
      // views refresh through the subscription); a background session goes
      // through `reduceFor`, which deliberately stays silent — refresh here.
      if (store.getSnapshot().sessionId === scopeSessionId) {
        store.reduce(state => toggleExpanded(state, path))
        return
      }
      store.reduceFor(scopeSessionId, state => toggleExpanded(state, path))
      syncExpanded()
    },
    retain(sessions) {
      let dropped = false
      for (const key of [...views.keys()]) {
        // The key's prefix is the seat session; a session id may itself carry
        // the separator only if the host allowed one, so split on the first.
        const separator = key.indexOf('::')
        const owner = separator === -1 ? key : key.slice(0, separator)
        if (!sessions.has(owner)) {
          views.delete(key)
          dropped = true
        }
      }
      if (dropped) notify()
    },
    nextInstance(kind) {
      const next = (instances.get(kind) ?? 0) + 1
      instances.set(kind, next)
      return next
    },
    versionOf: (sessionId, id) => views.get(viewKey(sessionId, id))?.version ?? 0,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** What a body registration injects (the plugin's business face). */
export interface NativeBodyInjected {
  readonly sessionId: string
  readonly ctx: Context
  readonly store: SidebarStore
  readonly service: BetterSidebarService
  readonly records: NativeTabRecords
  /** The descriptor id this body draws (one registration per descriptor). */
  readonly descriptorId: string
  /**
   * Extra seed fields derived from the native record — a file address carries
   * its path there, not in `navigation.params`.
   */
  readonly paramsOf?: (info: NativeTabInfo) => NativeTabParams | undefined
  /**
   * The session the body acts in, when the record names one (a
   * `session`-scoped file address names its own session); absent falls back to
   * the session the slot is scoped to.
   */
  readonly sessionIdOf?: (info: NativeTabInfo) => string | undefined
}

/** The props the slot framework adds to every tab body and title. */
export interface NativeBodyFrameworkProps {
  readonly useTabInfo: () => NativeTabInfo
}

/** Subscribe a component to its own record's mutations. */
function useRecordVersion(records: NativeTabRecords, sessionId: string, id: string): number {
  return useSyncExternalStore(
    listener => records.subscribe(listener),
    () => records.versionOf(sessionId, id),
  )
}

/** The current session's workspace root, live from the client session list. */
function useSessionCwd(ctx: Context, sessionId: string): string | undefined {
  return useSyncExternalStore(
    useMemo(() => (listener: () => void) => ctx.sessions.list.subscribe(listener), [ctx]),
    () => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
  )
}

/**
 * One plugin tab rendered inside the native right Sidebar: the descriptor's
 * own component with the plugin's props, over a synthetic record minted from
 * the native tab.
 *
 * The record OUTLIVES this component on purpose. `keepMounted` holds a body
 * mounted through hiding and tab switches, but a Session switch still remounts
 * it on the host side (measured: `drop`+`mint` for the SAME key inside one
 * switch), and the reader's exploration state only lives in the record. The
 * registry therefore keeps it until the tab is closed (`surface.close`) or its
 * session disappears (`retain`) — see the record registry's own notes.
 */
export function NativeTabBody(props: NativeBodyInjected & NativeBodyFrameworkProps): ReactNode {
  const { ctx, store, service, records, descriptorId, useTabInfo } = props
  const info = useTabInfo()
  const nativeTab = info.tab
  // TWO sessions meet here and they are not interchangeable: the SEAT session
  // (the native column this body is drawn in) keys the record, while the SCOPE
  // session is the namespace the content is read/written in — a file address
  // carries its own session, which is the one that resolves its path.
  const seatSessionId = props.sessionId
  const scopeSessionId = props.sessionIdOf?.(info) ?? seatSessionId
  const version = useRecordVersion(records, seatSessionId, nativeTab.id)
  const cwd = useSessionCwd(ctx, scopeSessionId)
  const scope = useMemo((): SessionScope => ({ sessionId: scopeSessionId, cwd }), [scopeSessionId, cwd])
  // `version` is not read: it only forces this render when the record changed.
  void version
  const derived = props.paramsOf?.(info)
  const params = derived === undefined && nativeTab.navigation.params === undefined
    ? undefined
    : { ...derived, ...nativeTab.navigation.params }
  const descriptor = service.getTab(descriptorId)
  const view = records.ensure({
    sessionId: seatSessionId,
    id: nativeTab.id,
    kind: nativeTab.kind,
    title: nativeTab.title,
    params,
    scope,
    mint: () => {
      const state = store.getSnapshot().state
      if (descriptor?.createTab === undefined || state === undefined) return undefined
      const minted = descriptor.createTab(state)
      return minted === null ? undefined : { title: minted.tab.title, meta: minted.tab.meta }
    },
  })
  if (descriptor === undefined) {
    // The orphaned fallback sits in the SAME native host as a live body, so
    // it gets the same full-height box (its own root also relies on the
    // `flex: 1` contract the column host restores). The host div carries
    // `data-dsh-native-tab-host` (empty value) so the e2e lane can assert
    // the fill, mirroring `data-dsh-better-sidebar`.
    return createElement(
      'div',
      { className: css.nativeTabHost, 'data-dsh-native-tab-host': '' },
      createElement(OrphanedTab, { ctx, store, scope, tab: view.tab, visible: nativeTab.visible }),
    )
  }
  return createElement(
    RenderBoundary,
    { className: css.tabBoundaryError },
    // The full-height host wrapper (see the `.nativeTabHost` rule in
    // sidebar.module.css for the native `.paneBody` contract); its
    // `data-dsh-native-tab-host` attribute lets the e2e lane assert the fill.
    createElement(
      'div',
      { className: css.nativeTabHost, 'data-dsh-native-tab-host': '' },
      createElement(descriptor.component, {
        ctx,
        store,
        scope,
        tab: view.tab,
        visible: nativeTab.visible,
        expanded: view.expanded,
        revealed: view.revealed,
        onToggleDir: (path: string) => { records.toggleExpanded(seatSessionId, nativeTab.id, path) },
        onReferenceFile: (path: string, isDir: boolean) => { referenceInChat(ctx, scopeSessionId, cwd, path, isDir) },
        onOpenDiff: (tab: SidebarTab) => {
          service.openTab({
            type: 'diff',
            title: tab.title,
            id: tab.id,
            ...(tab.diff === undefined ? {} : { diff: tab.diff }),
          }, scope)
        },
        onSubagentJump: (childSessionId: string) => {
          service.openTab({ type: 'subagent', meta: { childSessionId } }, scope)
        },
      }),
    ),
  )
}

/** What a title registration injects. */
export interface NativeTitleInjected {
  readonly records: NativeTabRecords
  readonly service: BetterSidebarService
  /** The descriptor id this title belongs to (one registration per descriptor). */
  readonly descriptorId: string
  /**
   * The seat session this chip is drawn in. The strip renders BEFORE the pane
   * body, and every session's retitled tabs live in the same registry, so the
   * chip must name its session instead of reading whichever record the id
   * happens to hit.
   */
  readonly sessionId: string
}

/**
 * A live tab chip: the type's glyph followed by the synthetic record's title
 * (the editor rewrites it on an in-place file switch, the side chat on the
 * thread's first prompt). Without this registration the chip would keep the
 * title captured when the tab opened.
 *
 * The host's tab definition has no icon field — a chip is drawn from the
 * `title` text alone — but this slot IS the chip's content, so the glyph is
 * ours to add. Placement follows the plugin's own semantics: an editor tab
 * with a path shows that file's icon (the same glyph the tree row shows), and
 * every other tab shows its descriptor's icon. Both ride
 * `descriptor.icon`, so the workbench strip, the guide capsules and the chip
 * cannot drift apart.
 */
export function NativeTabTitle(props: NativeTitleInjected & NativeBodyFrameworkProps): ReactNode {
  const { records, service, descriptorId, sessionId, useTabInfo } = props
  const nativeTab = useTabInfo().tab
  const version = useSyncExternalStore(
    listener => records.subscribe(listener),
    () => records.versionOf(sessionId, nativeTab.id),
  )
  const record = records.get(sessionId, nativeTab.id)
  const title = record?.tab.title ?? nativeTab.title
  // `version` is read so a title/path/meta mutation re-renders the chip; the
  // icon itself is derived from the record, never stored.
  void version
  const descriptor = service.getTab(descriptorId) ?? service.getTab(record?.tab.type ?? nativeTab.kind)
  const path = record?.tab.path
  const icon = path !== undefined && descriptorId === EDITOR_KIND
    ? service.fileIcon(path, CHIP_ICON_SIZE)
    : undefined
  const glyph = icon ?? (typeof descriptor?.icon === 'function'
    ? descriptor.icon(CHIP_ICON_SIZE)
    : descriptor?.icon)
  if (glyph === undefined || glyph === null) return title
  return (
    <>
      {/* Decorative: the chip's accessible name stays the title. */}
      <span className={css.chipIcon} aria-hidden="true">{glyph}</span>
      {title}
    </>
  )
}

/** The component pair one descriptor contributes to the native surface. */
export interface NativeTabComponents {
  readonly body: ComponentType<NativeBodyInjected & NativeBodyFrameworkProps>
  readonly title: ComponentType<NativeTitleInjected & NativeBodyFrameworkProps>
}
