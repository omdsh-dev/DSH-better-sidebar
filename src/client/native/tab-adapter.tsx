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
 * - the explorer's per-tab expansion/reveal sets;
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
  expanded: string[]
  revealed: string[]
  /** Bumped on every mutation; the components subscribe to it. */
  version: number
}

/** The plugin-side record registry for native tabs. */
export interface NativeTabRecords {
  /**
   * The synthetic record for a native tab, minted on first sight and kept
   * across navigations (a navigation refreshes the seed fields, never the
   * identity or a plugin-side title/meta mutation).
   * @param input - the native record and the session it lives in.
   * @returns the current view state.
   */
  ensure(input: {
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
  /** One record by native tab id (the live pane's record). */
  get(id: string): View | undefined
  /**
   * One session's record for an id — the live one when that session owns it,
   * else the parked copy. A chip reads this: the tab strip renders BEFORE the
   * pane body, so looking up the live slot alone would read the previous
   * session's record on a conversation switch.
   * @param sessionId - the session whose record is wanted; undefined falls
   *   back to the live slot.
   * @param id - the native tab id.
   * @returns the session's record, or undefined when it has none yet.
   */
  peek(sessionId: string | undefined, id: string): View | undefined
  /** Whether this id belongs to a native tab (vs the plugin's own layout). */
  has(id: string): boolean
  /** Merge a patch into the synthetic record (the `updateTab` path). */
  update(id: string, patch: { title?: string; path?: string; meta?: unknown }): void
  /**
   * Forget a record because its native TAB is gone (the host closed it) —
   * both the live slot and any parked copy. Nothing on a body's unmount may
   * call this: the host mounts one tab body per pane, so a tab switch or a
   * conversation switch unmounts a body whose record must survive.
   * @param id - the native tab id.
   * @param sessionId - whose tab closed; omitted forgets every copy.
   */
  drop(id: string, sessionId?: string): void
  /** Toggle one directory in a record's expansion set. */
  toggleExpanded(id: string, path: string): void
  /** Mint the next instance number of a kind (titles like "Terminal 2"). */
  nextInstance(kind: string): number
  /** A per-record version for `useSyncExternalStore`. */
  versionOf(id: string): number
  /** Subscribe to record changes (title/path/meta/expanded). */
  subscribe(listener: () => void): () => void
}

/** Create the record registry for one client activation. */
export function createNativeTabRecords(): NativeTabRecords {
  /**
   * The LIVE record per native tab id: the tab whose body the host currently
   * has mounted. The host mounts ONE body per pane, so a conversation switch
   * replaces the pane's contents and this slot is handed to the entering
   * session's tab — whose id is the SAME (`tab1`, `tab2`, … per session).
   */
  const views = new Map<string, View>()
  /**
   * Records a conversation switch displaced, keyed `sessionId::tabId`. Native
   * ids restart in every session, so the live slot cannot hold two sessions'
   * records of one id: the leaving session's record parks here and is
   * restored when the reader switches back. Without this the entering
   * session's tab overwrites the leaving one's state (tree expansion, an
   * in-place opened file), which is the state loss a conversation switch
   * used to show.
   */
  const parked = new Map<string, View>()
  const instances = new Map<string, number>()
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const parkKey = (sessionId: string, id: string): string => `${sessionId}::${id}`
  const put = (id: string, view: View): void => {
    views.set(id, { ...view, version: view.version + 1 })
    notify()
  }

  /** Build one record from a native tab's own seed (no plugin-side state). */
  const mintRecord = (
    id: string,
    kind: string,
    title: string,
    params: NativeTabParams | undefined,
    scope: SessionScope,
    mint: (() => { title?: string; meta?: unknown } | undefined) | undefined,
    version: number,
  ): View => {
    const seeded = params?.title === undefined && params?.meta === undefined ? mint?.() : undefined
    const meta = params?.meta ?? seeded?.meta
    return {
      tab: {
        id,
        type: kind as TabType,
        title: params?.title ?? seeded?.title ?? title,
        ...(params?.path === undefined ? {} : { path: params.path }),
        ...(params?.diff === undefined ? {} : { diff: params.diff }),
        ...(meta === undefined ? {} : { meta }),
      },
      scope,
      expanded: [],
      revealed: [],
      version,
    }
  }

  return {
    ensure({ id, kind, title, params, scope, mint }) {
      const existing = views.get(id)
      const sameSession = existing !== undefined && existing.scope.sessionId === scope.sessionId

      // A different session owning the live slot means the pane switched
      // conversations (native ids restart per session). Park the leaving
      // session's record — its whole plugin-side state — and clear the slot:
      // the entering session must NOT inherit it, and must not overwrite it
      // either (that is the state loss an A → B → A round trip used to show).
      if (existing !== undefined && !sameSession) {
        parked.set(parkKey(existing.scope.sessionId, id), existing)
        views.delete(id)
      }

      if (sameSession) {
        // This tab's own record. A navigation may carry new seed fields (the
        // editor's in-place switch, a browser tab pointed at another URL); the
        // record's identity and any plugin-side mutation (title/meta from
        // updateTab) stay.
        const patch: Partial<SidebarTab> = {}
        if (params?.path !== undefined && params.path !== existing.tab.path) patch.path = params.path
        if (params?.diff !== undefined) patch.diff = params.diff
        if (params?.url !== undefined) {
          const meta = typeof existing.tab.meta === 'object' && existing.tab.meta !== null
            ? existing.tab.meta as Record<string, unknown>
            : {}
          patch.meta = { ...meta, url: params.url }
        }
        if (existing.scope.cwd !== scope.cwd) {
          views.set(id, { ...existing, scope, tab: { ...existing.tab, ...patch } })
          return views.get(id)!
        }
        if (Object.keys(patch).length === 0) return existing
        const next: View = { ...existing, tab: { ...existing.tab, ...patch } }
        views.set(id, next)
        return next
      }

      // No live record for this (id, session): revive this session's parked
      // copy — the reader is switching BACK — refreshed with the navigation
      // seed the current open carries.
      const restored = parked.get(parkKey(scope.sessionId, id))
      if (restored !== undefined) {
        parked.delete(parkKey(scope.sessionId, id))
        const patch: Partial<SidebarTab> = {}
        if (params?.path !== undefined && params.path !== restored.tab.path) patch.path = params.path
        if (params?.diff !== undefined) patch.diff = params.diff
        const next: View = { ...restored, scope, tab: { ...restored.tab, ...patch } }
        views.set(id, next)
        return next
      }

      // A genuinely new tab for this session.
      views.set(id, mintRecord(id, kind, title, params, scope, mint, 0))
      return views.get(id)!
    },
    get: id => views.get(id),
    peek(sessionId, id) {
      const live = views.get(id)
      if (sessionId === undefined) return live
      if (live !== undefined && live.scope.sessionId === sessionId) return live
      return parked.get(parkKey(sessionId, id))
    },
    has: id => views.has(id),
    update(id, patch) {
      const entry = views.get(id)
      if (entry === undefined) return
      put(id, { ...entry, tab: { ...entry.tab, ...patch } })
    },
    drop(id, sessionId) {
      let dropped = false
      if (sessionId === undefined) {
        dropped = views.delete(id)
        for (const key of [...parked.keys()]) {
          if (key.endsWith(`::${id}`)) { parked.delete(key); dropped = true }
        }
      } else {
        const key = parkKey(sessionId, id)
        if (parked.delete(key)) dropped = true
        const live = views.get(id)
        if (live !== undefined && live.scope.sessionId === sessionId) dropped = views.delete(id) || dropped
      }
      if (dropped) notify()
    },
    toggleExpanded(id, path) {
      const entry = views.get(id)
      if (entry === undefined) return
      const expanded = entry.expanded.includes(path)
        ? entry.expanded.filter(candidate => candidate !== path)
        : [...entry.expanded, path]
      put(id, { ...entry, expanded })
    },
    nextInstance(kind) {
      const next = (instances.get(kind) ?? 0) + 1
      instances.set(kind, next)
      return next
    },
    versionOf: id => views.get(id)?.version ?? 0,
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
function useRecordVersion(records: NativeTabRecords, id: string): number {
  return useSyncExternalStore(
    listener => records.subscribe(listener),
    () => records.versionOf(id),
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
 * the native tab and dropped when the record ends.
 */
export function NativeTabBody(props: NativeBodyInjected & NativeBodyFrameworkProps): ReactNode {
  const { ctx, store, service, records, descriptorId, useTabInfo } = props
  const info = useTabInfo()
  const nativeTab = info.tab
  const version = useRecordVersion(records, nativeTab.id)
  const sessionId = props.sessionIdOf?.(info) ?? props.sessionId
  const cwd = useSessionCwd(ctx, sessionId)
  const scope = useMemo((): SessionScope => ({ sessionId, cwd }), [sessionId, cwd])
  // `version` is not read: it only forces this render when the record changed.
  void version
  const derived = props.paramsOf?.(info)
  const params = derived === undefined && nativeTab.navigation.params === undefined
    ? undefined
    : { ...derived, ...nativeTab.navigation.params }
  const descriptor = service.getTab(descriptorId)
  const view = records.ensure({
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
  // No unmount cleanup: the host mounts ONE tab body per pane, so looking at
  // another tab (or switching conversations) unmounts this body while the tab
  // stays open. The record must outlive it — the state has to be there when
  // the reader comes back. The only exit is a real tab close, which goes
  // through `SidebarSurface.close` → `records.drop(id, sessionId)`.
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
        onToggleDir: (path: string) => { records.toggleExpanded(nativeTab.id, path) },
        onReferenceFile: (path: string, isDir: boolean) => { referenceInChat(ctx, sessionId, cwd, path, isDir) },
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
   * The session the chip's pane belongs to. A chip renders BEFORE the pane
   * body (the strip is above it), so on a conversation switch the live slot
   * may still hold the PREVIOUS session's record — the chip must read its own
   * session's record to show that session's title/path.
   */
  readonly sessionId?: string
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
  const { records, service, descriptorId, useTabInfo } = props
  const nativeTab = useTabInfo().tab
  const version = useSyncExternalStore(
    listener => records.subscribe(listener),
    () => records.versionOf(nativeTab.id),
  )
  // Read through the SESSION, not the bare live slot: the strip renders before
  // the body's `ensure`, so right after a conversation switch the live slot
  // can still be the other session's record (same id in every session).
  const record = records.peek(props.sessionId, nativeTab.id)
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
