/**
 * The sidebar shell: panels mounted inside the unified panel host — a
 * fixed, viewport-sized containing block ([data-dsh-panel-host]) appended
 * to document.body — instead of individual fixed-position elements, so a
 * desktop shell's intermediate wrapper transforms can never hijack the
 * panels' fixed containing block (the core AppFrame owns the left sidebar /
 * center / details columns and has no right-side hole for plugins). The
 * right panel hosts the original workbench; the bottom panel hosts a
 * second, independent workbench. The bottom panel squeezes ONLY the center
 * column (the agent output area): it spans from the app shell's own left
 * sidebar to the right panel's left edge, so neither sidebar gives up any
 * position (the right panel keeps its full height). A persistent two-button
 * cluster at the top-right corner toggles each panel; the right panel's
 * width drags from its left edge, the bottom panel's height from its top
 * edge, and the shared corner drags both at once. The whole layout lives in
 * the per-session store, so switching conversations swaps the sidebar.
 *
 * The shell binds the workbench actions to the store and dispatches tab
 * content to the views. New tabs come from the + menu (explorer / git /
 * terminal; editors open from the explorer). Tabs live in one tree only —
 * they never cross panels; only the panel sizes drag against each other.
 *
 * Narrow (mobile, <768px) viewports show ONLY the right sidebar: entering
 * narrow migrates the bottom panel's tabs INTO the right tree
 * (migrateBottomTabs) — one workbench, the bottom tabs thrown into its
 * strips. The right panel becomes a full-width drawer, the bottom panel
 * and its toggle button disappear, and the layout push is disabled (the
 * drawer floats). Widening does not migrate back: the tabs keep living in
 * the right tree.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { appendToDraft, insertFileReference } from './conversation-draft.ts'
import {
  BOTTOM_MIN, PANEL_MIN, agentUuidOf, firstLeaf, floatTab,
  isAgentTabId, leafWithTab, migrateBottomTabs,
  moveTab, moveTabToEdge, openDiffTab, resizeSplitIn,
  setBottomHeight, setTabPin, setWidth, toggleBottomPanel, toggleExpanded, togglePanel,
  type DropZone, type SidebarState, type SidebarStore, type SidebarTab,
} from './state.ts'
import { getPinnedHomeScope } from './pinned.ts'
import { IconPanelBottomOutline16, IconPanelRightOutline16 } from './icons.tsx'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
import { isNarrowWidth, useViewportSize } from './breakpoints.ts'
import { layoutPushSize } from './layout-push.ts'
import { parseDesktopEnv } from './desktop-env.ts'
import { getWcoSnapshot, subscribeWco } from './wco.ts'
import { getShellPreset } from './shell-presets.ts'
import { computeTitleBarStrip } from './titlebar-strip.ts'
import { TabContent, buildNewTabOptions } from './sidebar/TabContent.tsx'
import { useCenterColumn } from './sidebar/use-center-column.ts'
import { useHostFeeds } from './sidebar/use-host-feeds.ts'
import { usePinnedTabs } from './sidebar/use-pinned-tabs.ts'
import { FreeWindowLayer, useFloatDragout } from './sidebar/free-windows.tsx'
import type { TabDragPayload } from './TabBar.tsx'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import { api } from './api.ts'
import css from './sidebar.module.css'

/**
 * OS file drags over the sidebar belong to the sidebar, not to the chat:
 * DSH's composer (InputBar) listens for file drags on the DOCUMENT and
 * answers with a full-screen "drop image here" mask plus image intake on
 * drop. Both panel-host render sites swallow the whole event quartet —
 * enter/over/leave/drop — so the region is a black hole to that document
 * listener. All four must be stopped: InputBar keeps an enter/leave depth
 * counter, and a leave that escapes without its matching enter unbalances
 * the count (this was the full-screen mask flickering over the sidebar).
 * The conversation column keeps DSH's native overlay and intake untouched;
 * gated on the 'Files' type so in-app drags (tab reorder, split zones)
 * propagate exactly as before.
 */
const swallowOsFileDrag = (event: ReactDragEvent): void => {
  if (!(event.dataTransfer?.types.includes('Files') ?? false)) return
  event.preventDefault()
  event.stopPropagation()
}

/** The four drag events a file drag must never carry past the panel host. */
const osFileDragShield = {
  onDragEnter: swallowOsFileDrag,
  onDragOver: swallowOsFileDrag,
  onDragLeave: swallowOsFileDrag,
  onDrop: swallowOsFileDrag,
}

/**
 * Append one user-space stylesheet (preset or custom CSS) as a tagged
 * `<style>` element. The tag attribute carries the source identity so the
 * running configuration is inspectable in DevTools; the returned tag is
 * removed by the caller's effect cleanup.
 */
function injectUserCss(attr: string, id: string, cssText: string): HTMLStyleElement {
  const tag = document.createElement('style')
  tag.setAttribute(attr, id)
  tag.textContent = cssText
  document.head.appendChild(tag)
  return tag
}

export function Sidebar(props: { ctx: Context; store: SidebarStore }) {
  const { ctx, store } = props

  // Copy freshness: re-render the whole tree when the DSH locale switches.
  // The module-level t() reads the active locale at call time, so a root
  // re-render alone re-localizes every panel (no memo barriers below).
  const localeRevision = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.locale.subscribe(callback), [ctx]),
    useCallback(() => ctx.locale.getSnapshot().active, [ctx]),
  )
  void localeRevision

  // better-locale override freshness: when @huanlin/dsh-plugin-better-locale
  // is installed and the user picks an override language (e.g. ja), the
  // store's `active` changes but the DSH locale's `active` does NOT —
  // better-locale keeps the dsh active value (zh/en) unchanged and only
  // patches `LocaleRuntime.prototype.lookup`. The localeRevision uSES
  // above reads `getSnapshot().active`, so it sees no change and skips
  // re-render. This second uSES reads the better-locale store's `active`
  // directly, so an override switch fires a full re-render and t() picks
  // up the new override text. Optional: ctx.get returns undefined when
  // better-locale is absent (or when ctx is a minimal test mock without
  // a `get` method), in which case this is a no-op uSES.
  type BetterLocaleStore = {
    readonly active: string | undefined
    subscribe(listener: () => void): () => void
  }
  const betterLocaleStore = typeof ctx.get === 'function'
    ? (ctx as unknown as {
        get(name: 'betterLocale'): BetterLocaleStore | undefined
      }).get('betterLocale')
    : undefined
  const betterLocaleActive = useSyncExternalStore(
    useMemo(() => {
      const store = betterLocaleStore
      if (store === undefined) return (_cb: () => void) => () => {}
      return (callback: () => void) => store.subscribe(callback)
    }, [betterLocaleStore]),
    useMemo(() => {
      const store = betterLocaleStore
      if (store === undefined) return () => undefined
      return () => store.active
    }, [betterLocaleStore]),
  )
  void betterLocaleActive

  // Tab-registry revision: TabContent memo cells must pick up a descriptor
  // a plugin registers/disposes after mount (the + menu / icons already read
  // the registry at render). Rare events (plugin (un)mount), so one full
  // re-render per change is fine — this is what keeps the memoized cells
  // from going stale, mirroring the localeRevision mechanism above.
  const [tabsVersion, setTabsVersion] = useState(0)
  useEffect(() => {
    const service = ctx.get('betterSidebar')
    if (service === undefined) return
    return service.subscribe(() => setTabsVersion(version => version + 1))
  }, [ctx])

  // Narrow (mobile) viewports collapse the two panels into one: the right
  // panel becomes a full-width drawer holding BOTH workbenches, the bottom
  // panel (and its toggle button) disappears, and the layout push is
  // disabled (the drawer floats over the app shell). Entering narrow
  // MIGRATES the bottom tree's tabs into the right tree (migrateBottomTabs)
  // — the merged display is the right sidebar alone, the bottom tabs thrown
  // into its strips. Widening never rewrites the migrated state: the tabs
  // keep living in the right tree.
  const viewport = useViewportSize()
  const narrow = isNarrowWidth(viewport.width)

  // On-screen keyboard / visual-viewport inset (mobile, split-screen, …):
  // when the visual viewport shrinks below the layout viewport, bottom-
  // anchored panels would hide under the keyboard. Track the inset and
  // offset the bottom-anchored surfaces by it. The obscured bottom strip is
  // innerHeight − (vv.height + vv.offsetTop): offsetTop is nonzero while
  // the visual viewport is scrolled/zoomed under browser chrome, so
  // omitting it would over-lift the panels (CR #232 P2). offsetTop changes
  // through the viewport's scroll event too, so both events are listened.
  // Guarded: browsers without visualViewport (older WebViews, jsdom) stay
  // at 0. rAF-throttled, same pattern as useNarrowViewport.
  const [keyboardInset, setKeyboardInset] = useState(0)
  const [visualViewportHeight, setVisualViewportHeight] = useState<number | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      setKeyboardInset(inset > 1 ? Math.round(inset) : 0)
      setVisualViewportHeight(Math.max(0, Math.round(vv.height)))
    }
    const onResize = (): void => { if (frame === null) frame = requestAnimationFrame(measure) }
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onResize)
    measure()
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])
  // The bottom panel is offset above the on-screen keyboard. Cap its height
  // against that same visible area, not the taller layout viewport, so the
  // conversation keeps PANEL_MIN even on wide touch devices.
  const layoutViewportHeight = visualViewportHeight ?? viewport.height

  // Current conversation (the sessions list feed).
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const current = sessionList.current

  // Per-session sidebar state.
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  useEffect(() => { store.setSession(current) }, [current, store])

  const state = snapshot.state
  const sessionId = snapshot.sessionId
  const summaryCwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd
  const pushedBottomHeight = (bottomOpen: boolean, bottomHeight: number): number => layoutPushSize({
    narrow,
    panelOpen: false,
    bottomOpen,
    width: 0,
    bottomHeight,
    viewportWidth: viewport.width,
    viewportHeight: layoutViewportHeight,
  }).height

  // The collapsed toggle cluster reclaims the top-right corner, so the DSH
  // session header's right-aligned utilities (the "Session log" download
  // capsule) must yield. layout.css keys off this body attribute to push the
  // header's right padding out past the cluster. Only the CLOSED panel needs
  // it — an open panel reserves AppFrame padding, moving the header clear.
  const collapsed = state === undefined || !state.panelOpen
  useEffect(() => {
    if (collapsed) document.body.setAttribute('data-dsh-sidebar-collapsed', '')
    else document.body.removeAttribute('data-dsh-sidebar-collapsed')
    return () => { document.body.removeAttribute('data-dsh-sidebar-collapsed') }
  }, [collapsed])

  // Title-bar / shell compatibility (the "位置兼容模式" scheme):
  //   auto    — CONSERVATIVE: only the standard Window Controls Overlay
  //             geometry contributes (the real caption-overlay height,
  //             reactive to maximize/restore). No URL stamp, no preset, no
  //             guess — plain browsers see zero modification.
  //   preset  — an opt-in built-in shell preset (shell-presets.ts) adds its
  //             per-shell strip as the no-WCO fallback.
  //   custom  — the user's own CSS (injected below) + the legacy manual
  //             strip px.
  // The resolved strip drives the SAME body attribute + CSS variable as the
  // legacy boolean did, so the CSS contract is unchanged (layout.css /
  // sidebar.module.css); only the value source changed. The cleanup removes
  // both on unmount/boundary swap so a crashed sidebar never leaves them
  // behind.
  const desktopEnv = parseDesktopEnv()
  const wco = useSyncExternalStore(
    useMemo(() => subscribeWco, []),
    getWcoSnapshot,
  )
  const scheme = snapshot.prefs.titleBarScheme
  const preset = scheme === 'preset' ? getShellPreset(snapshot.prefs.titleBarPresetId) : undefined
  const titleBarStrip = computeTitleBarStrip(
    desktopEnv, wco, scheme, preset, snapshot.prefs.titleBarStripPx,
  )
  const titleBarCompat = titleBarStrip > 0
  useEffect(() => {
    const root = document.documentElement
    if (titleBarCompat) {
      document.body.setAttribute('data-dsh-title-bar-compat', '')
      root.style.setProperty('--dsh-title-bar-strip', `${titleBarStrip}px`)
    } else {
      document.body.removeAttribute('data-dsh-title-bar-compat')
      root.style.removeProperty('--dsh-title-bar-strip')
    }
    return () => {
      document.body.removeAttribute('data-dsh-title-bar-compat')
      root.style.removeProperty('--dsh-title-bar-strip')
    }
  }, [titleBarCompat, titleBarStrip])

  // User-space CSS injection (the escape hatch): preset CSS (scheme
  // `preset`) and free-form custom CSS (scheme `custom`) are appended AFTER
  // the plugin's own styles — later in the cascade wins ties, and
  // `!important` can override the JS-written inline strip variable. Each
  // source gets its own tagged <style> so the running configuration stays
  // inspectable; tags are removed on change/unmount so a stale stylesheet
  // never outlives its fiber (HMR-safe).
  const presetCss = scheme === 'preset' ? preset?.css ?? '' : ''
  const customCss = scheme === 'custom' ? snapshot.prefs.customCss : ''
  useEffect(() => {
    const tags: HTMLStyleElement[] = []
    if (presetCss !== '') tags.push(injectUserCss('data-dsh-preset-css', preset?.id ?? '', presetCss))
    if (customCss !== '') tags.push(injectUserCss('data-dsh-custom-css', 'custom', customCss))
    return () => { for (const tag of tags) tag.remove() }
  }, [presetCss, customCss, preset?.id])

  /**
   * Bottom-panel merge on narrow viewports: whenever a session is current
   * while narrow (mount, session switch, or a desktop→narrow transition),
   * throw the bottom tree's tabs into the right tree. Idempotent — after
   * the first migration the bottom tree is empty and the reducer returns
   * the same reference, so this effect settles immediately.
   */
  useEffect(() => {
    if (!narrow || sessionId === undefined) return
    store.reduce(migrateBottomTabs)
  }, [narrow, sessionId, store])

  // While the session's header is still hydrating (or the session is blank),
  // the list summary may carry no cwd; ask the host once (it falls back to
  // the process cwd) so the explorer root and terminal cwd are real from
  // first paint instead of showing "no session".
  const [fetchedCwd, setFetchedCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    setFetchedCwd(undefined)
    if (sessionId === undefined || summaryCwd !== undefined) return
    let cancelled = false
    api.sessionCwd({ sessionId })
      .then(result => { if (!cancelled) setFetchedCwd(result.cwd) })
      .catch(() => { /* the explorer/git rows surface their own errors */ })
    return () => { cancelled = true }
  }, [sessionId, summaryCwd])
  const cwd = summaryCwd ?? fetchedCwd

  // The + menu options ride a memo so the two Workbenches share ONE array
  // identity across renders that did not change the store (drag state,
  // viewport resize): fresh arrays per render re-rendered every LeafView's
  // + affordance whether or not anything tab-related moved.
  const newTabOptions = useMemo(
    () => (state === undefined || sessionId === undefined ? [] : buildNewTabOptions(state, ctx, { sessionId, cwd })),
    // state is the whole session state — every field it wraps is fair game
    // for the descriptors' available() callbacks. (The render's own guard
    // sits below every hook; this memo must handle the no-session case
    // itself.)
    [state, ctx, sessionId, cwd],
  )

  // Host feeds (sidebar/use-host-feeds.ts): the agent-terminals / agent-opens
  // WebSocket pushes and the subagent / background-job auto-activation
  // triggers, all keyed on the current session. The jump-back ref is the one
  // piece the render side consumes (renderTab's onSubagentJump arms it).
  const { subagentJumpRef } = useHostFeeds({ ctx, store, sessionList, sessionId })

  // Center-column tracking (sidebar/use-center-column.ts): the bottom panel
  // spans ONLY the app shell's center column ("squeezes the agent output
  // area"); the hook locates the AppFrame's center column DOM (host anchor
  // observers + slow retry), measures its edges into a ref, and writes them
  // straight to the bottom panel element — per-frame tracking without
  // re-rendering the shell (the comments live with the hook now).
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const { centerColRef, centerRectRef, centerMeasured, measureCenter, draggingRef } = useCenterColumn(bottomRef, state?.bottomOpen)

  // Free-window drag-out gesture (sidebar/free-windows.tsx): watches the
  // document for OUR tab drags hovering the conversation column and floats
  // the tab on release. Returns the drop-zone hint geometry for the layer.
  const { floatHint } = useFloatDragout({ narrow, sessionId, store, centerColRef })

  /**
   * Bottom-panel first-expansion auto terminal: the FIRST time the user
   * expands the bottom panel in a session, try to open a fresh terminal tab
   * there. "Try" is literal — the terminal's own quota and enable switch
   * gate the attempt (a full quota or a disabled terminal type makes it a
   * no-op). Gated on the bottomPanelAutoTerminal pref (the terminal tab's
   * nested settings toggle, default on). Only a false→true TRANSITION fires
   * (a panel persisted open never counts as an expansion), and the session's
   * bottomOpenedOnce flag is set atomically with the first fire so later
   * expansions never repeat it.
   */
  const bottomWasOpenRef = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    // The bottom panel does not exist on narrow viewports (the two
    // workbenches merge into one panel), so the first-expansion auto
    // terminal is a desktop-only behavior.
    if (narrow) return
    if (state === undefined) return
    const wasOpen = bottomWasOpenRef.current
    bottomWasOpenRef.current = state.bottomOpen
    if (wasOpen === undefined || wasOpen || !state.bottomOpen) return
    if (state.bottomOpenedOnce) return
    if (store.getPrefs().bottomPanelAutoTerminal === false) return
    if (ctx.get('betterSidebar')?.isTabEnabled('terminal') === false) return
    // Land the tab in the bottom panel's first pane; the once-flag is set
    // atomically so later expansions never repeat the auto-open.
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id, bottomOpenedOnce: true }))
    ctx.get('betterSidebar')?.openTab({ type: 'terminal' })
  }, [state, store, ctx, narrow])

  // Panel drags: the right panel's width (left edge strip), the bottom
  // panel's height (top edge strip), and the shared corner (both at once).
  // Drags write the sizes DIRECTLY to the DOM (panel styles + the layout CSS
  // variables) instead of round-tripping the store on every pointer move —
  // a store reduce re-renders both workbenches (terminals, editors…) per
  // move, which is the visible drag lag. The store is committed once on
  // pointer up (clamping + persistence).
  const panelRef = useRef<HTMLDivElement | null>(null)
  const widthDrag = useRef({ startX: 0, startWidth: 0 })
  const [draggingWidth, setDraggingWidth] = useState(false)
  const bottomDrag = useRef({ startY: 0, startHeight: 0 })
  const [draggingBottom, setDraggingBottom] = useState(false)
  const cornerDrag = useRef({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const [draggingCorner, setDraggingCorner] = useState(false)
  const anyDragging = draggingWidth || draggingBottom || draggingCorner

  // Pause center-column measurement while dragging, and re-measure once the
  // drag settles at its committed size. The store commit lands on release and
  // the final width equals the last drag width, so no ResizeObserver event
  // fires to refresh centerRect — this explicit re-measure covers that gap.
  useEffect(() => {
    draggingRef.current = anyDragging
    if (!anyDragging) measureCenter()
    // draggingRef is a stable ref object from useCenterColumn (same
    // provenance note as the float effect above).
  }, [anyDragging, measureCenter, draggingRef])

  // Clamp mirrors of setWidth/setBottomHeight for mid-drag values (the store
  // re-clamps on commit; these keep the panels from overshooting mid-drag).
  const clampWidth = (width: number): number =>
    Math.min(Math.max(PANEL_MIN, Math.round(width)), Math.max(PANEL_MIN, window.innerWidth))
  const clampHeight = (height: number): number =>
    Math.min(Math.max(BOTTOM_MIN, Math.round(height)), Math.max(BOTTOM_MIN, window.innerHeight - PANEL_MIN))

  /** Single writer for the layout-push variables: the app shell gives up
   *  the panel's width/height while open (0 while collapsed) through
   *  layout.css's margins. Every size change — drag frames and committed
   *  state — flows through here so the push never forks between paths. */
  const writeGeometry = (width: number, height: number): void => {
    document.documentElement.style.setProperty('--dsh-sidebar-width', `${width}px`)
    document.documentElement.style.setProperty('--dsh-sidebar-height', `${height}px`)
    // The corner handle positions itself relative to the panel (CSS
    // `bottom: calc(var(--dsh-sidebar-height) + 6px)`), so these two layout
    // variables are all it needs — no viewport coordinates written here
    // (issue #106: skins that inset the panels must not fight JS coords).
  }

  /** Last size a drag actually applied to the DOM (updated by applyDrag).
   *  When a pointer stream dies without any position info (issue #247: an
   *  ultra-fast flick whose release events carried no usable coordinates),
   *  the abort path adopts this instead of rolling back to the pre-drag
   *  value — the DOM's current size is the only truthful record left. */
  const lastDragSize = useRef<{ width: number; height: number } | null>(null)

  /** Apply a drag size to the DOM without touching React state or the store.
   *  The bottom panel's right edge tracks the right panel's left edge HERE
   *  too — React state only updates on release, so the inline right must be
   *  written directly or the bottom panel would lag the sidebar mid-drag.
   *  The layout push rides the shared writer (writeGeometry). */
  const applyDrag = (width: number, height: number): void => {
    lastDragSize.current = { width, height }
    panelRef.current?.style.setProperty('width', `${width}px`)
    bottomRef.current?.style.setProperty('height', `${height}px`)
    // centerRect.right is the center column's right edge at the committed
    // width (innerWidth - state.width - detailsWidth), so this equals
    // `width + detailsWidth` — derived from the measured column, keeping the
    // drag write-only (no React re-render mid-drag).
    bottomRef.current?.style.setProperty('right', `${(window.innerWidth - centerRectRef.current.right) + (width - (state?.width ?? 0))}px`)
    const bottomPush = !narrow && state?.bottomOpen === true ? height + keyboardInset : 0
    // The pushed width must ride the same gate as the committed push effect
    // (layoutPushSize): a collapsed right panel pushes 0. The bottom strip is
    // the only drag reachable with the panel closed — writing the panel's
    // persisted width preference here squeezed #root mid-drag, dropped the
    // host viewport across its 1024px auto-collapse breakpoint, and the
    // native left sidebar snapped to its 56px rail (and back on release).
    const pushWidth = !narrow && state?.panelOpen === true ? Math.min(width, window.innerWidth) : 0
    writeGeometry(pushWidth, bottomPush)
  }

  // Drags write at most once per frame: pointer events fire several times
  // faster than the display refresh, and each write reflows the app shell
  // (the layout push) plus the panels — batching to one write per frame is
  // what keeps the drag smooth. The store is still committed once on release.
  const dragFrame = useRef<number | null>(null)
  const pendingDrag = useRef<{ width: number; height: number } | null>(null)
  const scheduleDrag = (width: number, height: number): void => {
    pendingDrag.current = { width, height }
    if (dragFrame.current !== null) return
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null
      const pending = pendingDrag.current
      if (pending !== null) {
        pendingDrag.current = null
        applyDrag(pending.width, pending.height)
      }
    })
  }

  /** Flush any pending drag write and stop scheduling (the store commit on
   *  pointer up applies the final clamped values). */
  const stopDragScheduling = (): void => {
    if (dragFrame.current !== null) {
      cancelAnimationFrame(dragFrame.current)
      dragFrame.current = null
    }
    pendingDrag.current = null
  }

  /**
   * Finalize a drag on pointer up: flush the LAST drag frame to the DOM
   * synchronously, then commit the SAME clamped values to the store. A fast
   * release cancels the rAF before it ran — without the flush the DOM would
   * sit at the pre-drag size until React re-renders with the committed
   * value, and a value that never made it into a move handler would never
   * be applied at all. The measurement pause ends here too: the center
   * column is re-measured BEFORE the committed re-render lands, so the
   * bottom panel's React-rendered right edge already reflects the new
   * width (otherwise the re-render would re-apply the stale rect — the
   * bottom panel visibly jumps for one frame).
   */
  const commitDrag = (
    width: number,
    height: number,
    reduce: (state: SidebarState) => SidebarState,
  ): void => {
    stopDragScheduling()
    applyDrag(width, height)
    draggingRef.current = false
    measureCenter()
    store.reduce(reduce)
  }

  /** Set once a drag's pointerup handler commits — premature capture loss
   *  (pointercancel / lostpointercapture without pointerup) must then be told
   *  apart from a normal release. */
  const dragCommitted = useRef(false)
  /**
   * Abort a drag whose pointer stream was interrupted (pointercancel, or
   * capture lost before pointerup): no pointerup will arrive, so without
   * this the dragging state would stick true and center-column measurement
   * would stay paused forever — the bottom panel freezes at stale edges and
   * stops tracking sidebar/app-rail layout changes.
   *
   * A FAST release is the common trigger: browsers merge pointermove bursts,
   * and an ultra-fast flick can cancel the stream before ANY move lands.
   * The commit order is therefore: the LAST KNOWN dragged size (the rAF
   * pending value) first, then the interrupting event's own pointer
   * position (only pointercancel is trusted to carry coordinates —
   * lostpointercapture's coordinates are not guaranteed, so the handlers
   * pass the event only from pointercancel), and finally the size the drag
   * last APPLIED to the DOM (lastDragSize). A drag that produced none of
   * those (pure down+up at the same spot) commits the store's own sizes —
   * a no-op, never an explicit rollback (issue #247: v0.13.1 never reverted
   * an interrupted fast flick; the abort path added in the unified-host
   * refactor did, and that regression is what this ordering removes).
   *
   * Every commit path marks the drag committed, so the interrupt
   * double-fire (pointercancel → lostpointercapture) cannot commit once
   * and then roll the same drag back.
   */
  const abortDrag = (reset: () => void, event?: { clientX: number; clientY: number }): void => {
    if (dragCommitted.current) return
    const pending = pendingDrag.current
    let width: number | undefined
    let height: number | undefined
    if (pending !== null) {
      width = pending.width
      height = pending.height
    } else if (event !== undefined) {
      // No move ever landed: the cancel position is all we have — commit it
      // (clamped) instead of rolling back the flick.
      if (draggingWidth) {
        width = clampWidth(widthDrag.current.startWidth + (widthDrag.current.startX - event.clientX))
        height = pushedBottomHeight(state?.bottomOpen === true, state?.bottomHeight ?? 0)
      } else if (draggingBottom) {
        width = Math.min(state?.width ?? 0, window.innerWidth)
        height = pushedBottomHeight(true, clampHeight(bottomDrag.current.startHeight + (bottomDrag.current.startY - event.clientY)))
      } else if (draggingCorner) {
        width = clampWidth(cornerDrag.current.startWidth + (cornerDrag.current.startX - event.clientX))
        height = pushedBottomHeight(true, clampHeight(cornerDrag.current.startHeight + (cornerDrag.current.startY - event.clientY)))
      }
    }
    if (width !== undefined && height !== undefined) {
      dragCommitted.current = true
      pendingDrag.current = null
      if (dragFrame.current !== null) {
        cancelAnimationFrame(dragFrame.current)
        dragFrame.current = null
      }
      applyDrag(width, height)
      draggingRef.current = false
      measureCenter()
      store.reduce(s => setBottomHeight(setWidth(s, width), height))
    } else {
      // No pending write and no usable event coordinates: keep the size the
      // drag last applied instead of rolling back to the pre-drag value
      // (the flick's moves may have been consumed by the rAF just before
      // the stream died — the DOM already shows the dragged size). Clamp to
      // the current geometry like the layout-push effect (closed/narrow
      // panels are written 0 by the push).
      dragCommitted.current = true
      stopDragScheduling()
      const last = lastDragSize.current
      const { width: adoptedWidth, height: adoptedHeight } = layoutPushSize({
        narrow,
        panelOpen: state?.panelOpen === true,
        bottomOpen: state?.bottomOpen === true,
        width: last?.width ?? state?.width ?? 0,
        bottomHeight: last?.height ?? state?.bottomHeight ?? 0,
        viewportWidth: viewport.width,
        viewportHeight: layoutViewportHeight,
      })
      applyDrag(adoptedWidth, adoptedHeight)
      draggingRef.current = false
      measureCenter()
      store.reduce(s => setBottomHeight(setWidth(s, adoptedWidth), adoptedHeight))
    }
    reset()
  }

  // Layout push: the app shell gives up the panel's width/height while the
  // panels are open (0 while collapsed), so the conversation and input bar
  // are squeezed instead of covered. The margins are capped at the viewport
  // so a stale persisted size (e.g. fullscreen on a bigger window) can never
  // crush the app shell to zero. Dragging disables the layout transition.
  // On NARROW viewports the drawer FLOATS over the app shell — no push, the
  // conversation keeps the full width behind the drawer.
  useEffect(() => {
    const { width, height } = layoutPushSize({
      narrow,
      panelOpen: snapshot.state?.panelOpen === true,
      bottomOpen: snapshot.state?.bottomOpen === true,
      width: snapshot.state?.width ?? 0,
      bottomHeight: snapshot.state?.bottomHeight ?? 0,
      viewportWidth: viewport.width,
      viewportHeight: layoutViewportHeight,
    })
    const bottomPush = !narrow && snapshot.state?.bottomOpen === true
      ? height + keyboardInset
      : 0
    writeGeometry(width, bottomPush)
  }, [narrow, snapshot.state?.panelOpen, snapshot.state?.width, snapshot.state?.bottomOpen, snapshot.state?.bottomHeight, viewport.width, layoutViewportHeight, keyboardInset])
  // Unmount must release the push (issue #31): when the boundary swaps the
  // whole sidebar after a render crash (or the plugin fiber is disposed /
  // HMR), the CSS variables would otherwise stay on <html> and layout.css
  // keeps squeezing #root with a stale margin — "the sidebar cannot be
  // hidden" until a full reload. This lives in an UNMOUNT-ONLY effect, NOT
  // in the push effect's cleanup: React can yield between a passive
  // effect's cleanup and setup phases, and removing the variables on a
  // dependency change used to paint the push-less layout for a frame (the
  // center column went full width) while the re-add restarted the margin
  // transition — the bottom panel flashed full width after every width
  // drag (issue #258). Keeping the variables continuously valid while
  // mounted makes the push invisible to mid-flush style recals.
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty('--dsh-sidebar-width')
      document.documentElement.style.removeProperty('--dsh-sidebar-height')
    }
  }, [])
  useEffect(() => {
    if (anyDragging) document.body.setAttribute('data-dsh-sidebar-dragging', '')
    else document.body.removeAttribute('data-dsh-sidebar-dragging')
  }, [anyDragging])


  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (paneId, tabId) => {
      // A closed terminal releases its pty immediately — including when its
      // socket is mid-reconnect, where the unmount close frame never reaches
      // the host and the process would hold the quota until the grace ends.
      // Agent terminals (tabId `agent:<uuid>`) close through a different
      // host route: the WS close frame is the primary path (sent by
      // TerminalView on unmount), and the agent-pty.close HTTP route is the
      // fallback when the WS is down.
      const current = store.getSnapshot().state
      // Terminal tabs may live in EITHER tree (the bottom panel hosts them
      // too) — the pty-release lookup covers both, or the HTTP fallback is
      // skipped for a bottom-panel terminal whose WS frame never arrived.
      const leaf = current === undefined
        ? undefined
        : leafWithTab(current.splits, tabId) ?? leafWithTab(current.bottomSplits, tabId)
      const tab = leaf?.tabs.find(candidate => candidate.id === tabId)
      // Route through the service: the tab-bar close is the canonical close
      // path (finds the pane itself, fires descriptor.onClose); the session
      // scope (with its cwd) rides to the callback.
      ctx.get('betterSidebar')?.closeTab(tabId, sessionId === undefined ? undefined : { sessionId, cwd })
      if (tab?.type === 'terminal') {
        if (isAgentTabId(tabId)) {
          const uuid = agentUuidOf(tabId)
          void api.agentPtyClose(uuid).catch(() => { /* the host may already have released it */ })
        } else if (sessionId !== undefined) {
          void api.ptyClose({ sessionId, cwd }, tabId).catch(() => { /* the host may already have released it */ })
        }
      }
    },
    activateTab: (paneId, tabId) => {
      // Route through the service: same reducer (finds the pane in EITHER
      // tree, sets the active pane) and fires descriptor.onActivate; the
      // session scope (with its cwd) rides to the callback.
      ctx.get('betterSidebar')?.activateTab(tabId, sessionId === undefined ? undefined : { sessionId, cwd })
    },
    focusPane: (paneId) => { store.reduce(s => ({ ...s, activePane: paneId })) },
    moveTabToEdge: (payload: TabDragPayload, toPane: string, zone: DropZone) => {
      store.reduce(s => moveTabToEdge(s, payload.paneId, payload.tabId, toPane, zone))
    },
    moveTabBefore: (payload: TabDragPayload, toPane: string, beforeTabId: string) => {
      store.reduce((s) => {
        let index = -1
        const source = leafWithTab(s.splits, beforeTabId)
        if (source !== undefined && source.id === toPane) {
          index = source.tabs.findIndex(tab => tab.id === beforeTabId)
        }
        return moveTab(s, payload.paneId, payload.tabId, toPane, index)
      })
    },
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduce(s => resizeSplitIn(s, splitId, index, deltaFrac))
    },
    // The tab context menu's "move to free window": no drop point exists, so
    // the window is born over the conversation column's center (the user's
    // focus area; clamped into the viewport by the reducer) — the same
    // landing the drag-out gesture produces.
    floatTab: (tabId) => {
      const col = centerColRef.current
      const rect = col !== null && col.isConnected ? col.getBoundingClientRect() : null
      const x = rect !== null ? (rect.left + rect.right) / 2 : window.innerWidth / 2
      const y = rect !== null ? (rect.top + rect.bottom) / 2 : window.innerHeight / 2
      store.reduce(s => floatTab(s, tabId, x, y))
    },
    // Pin/unpin a terminal tab (v0.17.0+): the home cwd is snapshotted at
    // pin time so a workspace-scoped pin only resurfaces in sessions whose
    // cwd matches. Unpin passes null — the tab stays open in its home
    // session, just unmarked.
    pinTab: (tabId, scope) => {
      store.reduce(s => setTabPin(s, tabId, scope === null ? null : { scope, homeCwd: cwd }))
    },
  }), [store, sessionId, cwd, ctx, centerColRef])

  // Pinned virtual tabs (sidebar/use-pinned-tabs.ts): cross-session pinned
  // tabs inject into the right panel's first leaf, and the actions are
  // wrapped so pinned virtual ids route to the HOME session (reduceFor +
  // revision bump).
  const { augmentedTree, wrappedActions } = usePinnedTabs({ store, sessionId, cwd, snapshot, actions })

  /**
   * The explorer's @-reference button. Directories append the folder mention
   * (`@dir/`) as plain text so DSH's folder decoration and completion keep
   * working; files insert a structured chip like the native `@` picker, so
   * the whole reference stays one link instead of decorating only the
   * leading folder. Resolves the session-scope ctx and the conversation
   * input service at click time; a missing service or scope degrades to a
   * logged no-op, never a crash. Defined above the no-session early return
   * — a hook must never sit behind a conditional return (React counts hooks
   * per render).
   */
  const referenceInChat = useCallback((path: string, isDir: boolean): void => {
    if (sessionId === undefined) return
    const rel = relativeTo(cwd ?? '', path)
    if (isDir) {
      appendToDraft(ctx, sessionId, `@${rel === '.' ? './' : `${rel}/`}`)
      return
    }
    if (!insertFileReference(ctx, sessionId, rel)) {
      appendToDraft(ctx, sessionId, `@${rel}`)
    }
  }, [ctx, sessionId, cwd])

  if (state === undefined || sessionId === undefined) {
    // Keep the unavailable controls focusable: touch users have no hover, so
    // focus is the only way the existing Tooltip can explain what is missing.
    return (
      <div data-dsh-panel-host {...osFileDragShield}>
        <div className={css.toggleCluster} data-dsh-toggle-cluster>
          {!narrow && (
            <Tooltip label={t('noSession')} side="bottom" delayMs={500}>
              <button type="button" className={css.toggleButton} aria-disabled="true" aria-label={t('noSession')}>
                <IconPanelBottomOutline16 />
              </button>
            </Tooltip>
          )}
          <Tooltip label={t('noSession')} side="bottom" delayMs={500}>
            <button type="button" className={css.toggleButton} aria-disabled="true" aria-label={t('noSession')}>
              <IconPanelRightOutline16 />
            </button>
          </Tooltip>
        </div>
      </div>
    )
  }

  const bottomPanelHeight = layoutPushSize({
    narrow,
    panelOpen: state.panelOpen,
    // Keep the hidden panel's geometry ready for its slide-in transition;
    // only the layout push itself becomes zero while it is closed.
    bottomOpen: true,
    width: state.width,
    bottomHeight: state.bottomHeight,
    viewportWidth: viewport.width,
    viewportHeight: layoutViewportHeight,
  }).height

  const onNewTab = (optionId: string): void => {
    const service = ctx.get('betterSidebar')
    const descriptor = service?.getTab(optionId)
    if (service === undefined || descriptor === undefined) return
    const title = typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
    // The session scope rides along: lifecycle callbacks receive it (and
    // the open stays in the current session, as before).
    service.openTab({ type: optionId, title }, { sessionId, cwd })
  }

  /**
   * The explorer's @-reference button: append `@<relative path>` to the
   * session's composer draft (space-separated). Resolves the session-scope
   * ctx and the conversation input service at click time; a missing service
   * or scope degrades to a logged no-op, never a crash.
   */
  /**
   * The tab icon: an editor tab WITH a file path (the per-path windows of
   * split mode — `meta.dir` marks folder windows, which keep the folder
   * glyph) shows the same file icon the tree row shows (`fileIcon`, feature
   * `fileIcons`); every other tab uses its tab-type descriptor icon.
   */
  const tabIconOf = (tab: SidebarTab): ReactNode => {
    if (tab.type === 'editor' && tab.path !== undefined && (tab.meta as { dir?: boolean } | undefined)?.dir !== true) {
      return ctx.get('betterSidebar')?.fileIcon(tab.path, 14) ?? null
    }
    const descriptor = ctx.get('betterSidebar')?.getTab(tab.type)
    if (descriptor === undefined) return null
    return typeof descriptor.icon === 'function' ? descriptor.icon(14) : descriptor.icon
  }

  /**
   * The tab badge from the tab-type registry: a count (99+ capped) or a
   * short text pill. A throwing badge is swallowed (no pill) — the tab
   * strip must never break because a plugin's badge computation failed.
   */
  const tabBadgeOf = (tab: SidebarTab): ReactNode => {
    const descriptor = ctx.get('betterSidebar')?.getTab(tab.type)
    if (descriptor?.badge === undefined) return null
    let value: string | number | null | undefined
    try {
      value = descriptor.badge(ctx, { sessionId, cwd }, state)
    } catch (error) {
      console.error('[dsh-better-sidebar] tab badge error:', error)
      return null
    }
    if (value === null || value === undefined || value === '') return null
    const text = typeof value === 'number' ? (value > 99 ? '99+' : String(value)) : String(value)
    return <span className={css.tabBadge}>{text}</span>
  }

  /**
   * Render one tab's content. `active` (from the workbench) tells whether
   * this tab is the active one in its pane; combined with the panel's
   * open/closed state it gates live views (the Subagent topology pauses its
   * polling while the page is not actually visible). The pane id travels
   * with the tab so diff tabs can split below their source pane.
   */
  // `placement` decides the visibility contract handed to the tab component:
  // pane tabs are visible while their panel is open and they are active, but
  // a free window is its own surface — its tab stays visible no matter what
  // the panels do (the AGENTS §7.5 contract; plugin components honor
  // `visible` to pause work, so tying floats to panelOpen would blank them
  // the moment the sidebar collapses).
  const renderTab = (tab: SidebarTab, active: boolean, paneId: string, placement: 'top' | 'bottom' | 'float' = 'top') => {
    // Pinned virtual tabs: pass the home session's scope (sessionId + cwd) so
    // TerminalView's WS URL resolves to the home PTY, and effectiveTabId so
    // the descriptor component receives the ORIGINAL tab id (the virtual id
    // is only a display key). Regular tabs: effectiveTabId is undefined (no
    // override), scope is the current session's.
    const home = getPinnedHomeScope(tab)
    return (
      <TabContent
        tab={tab}
        effectiveTabId={home?.tabId}
        paneId={paneId}
        sessionId={home?.sessionId ?? sessionId}
        cwd={home?.cwd ?? cwd}
        expanded={state.expanded}
        revealed={state.revealed ?? []}
        onToggleDir={(path) => { store.reduce(s => toggleExpanded(s, path)) }}
        onReferenceFile={referenceInChat}
        ctx={ctx}
        store={store}
        visible={
          placement === 'float'
            ? true
            : placement === 'bottom'
              ? state.bottomOpen && active
              : state.panelOpen && active
        }
        onSubagentJump={(childSessionId) => { subagentJumpRef.current = childSessionId }}
        onOpenDiff={(diffTab) => { store.reduce(s => openDiffTab(s, paneId, diffTab)) }}
        localeRevision={localeRevision}
        tabsVersion={tabsVersion}
      />
    )
  }

  return (
    <div data-dsh-panel-host {...osFileDragShield}>
      {/*
        The persistent toggle cluster at the top-right corner: the bottom
        panel's button (bottom glyph) LEFT of the right panel's (side glyph).
        Always pinned to the viewport corner — inside the right panel's
        top-right while it is open, sitting flush in the tab strip whose
        right end it really squeezes (the strip reserves its width via CSS),
        so the tabs genuinely yield space to it.
      */}
      <div className={css.toggleCluster} data-dsh-toggle-cluster>
        {/*
          Narrow viewports merge the two workbenches into the one drawer —
          there is no bottom panel, so its toggle button is not offered.
        */}
        {!narrow && (
          <Tooltip label={state.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={state.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')}
              onClick={() => { store.reduce(toggleBottomPanel) }}
            >
              <IconPanelBottomOutline16 />
            </button>
          </Tooltip>
        )}
        <Tooltip label={state.panelOpen ? t('collapse') : t('expand')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.toggleButton}
            aria-label={state.panelOpen ? t('collapse') : t('expand')}
            onClick={() => { store.reduce(togglePanel) }}
          >
            <IconPanelRightOutline16 />
          </button>
        </Tooltip>
      </div>
      {/*
        The right panel stays mounted while collapsed (hidden off-screen) so
        the slide in/out can animate; visibility hides it after the slide
        settles. Its bottom edge follows the bottom panel's height (0 while
        the bottom panel is closed) — the VSCode-style "sidebar above panel".
        On NARROW viewports it is a full-width drawer holding both
        workbenches (see MobileWorkbench); the width drag strip is not
        offered there — a full-screen sheet has nothing to drag.
      */}
      <div
        ref={panelRef}
        className={clsx(css.panel, !state.panelOpen && css.panelHidden)}
        data-dsh-panel
        style={{
          width: narrow ? '100vw' : Math.min(state.width, window.innerWidth),
          // Narrow drawer: keep the bottom-anchored sheet above the on-screen
          // keyboard (visualViewport inset); desktop panels are full-height
          // and unaffected.
          bottom: narrow && keyboardInset > 0 ? `${keyboardInset}px` : undefined,
        }}
       
        data-dragging={anyDragging || undefined}
      >
          {!narrow && (
            <div
              className={clsx(css.panelResize, draggingWidth && css.panelResizeActive)}
             
              onPointerDown={(event) => {
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                dragCommitted.current = false
                widthDrag.current = { startX: event.clientX, startWidth: state.width }
                setDraggingWidth(true)
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                const { startX, startWidth } = widthDrag.current
                const width = clampWidth(startWidth + (startX - event.clientX))
                const height = pushedBottomHeight(state.bottomOpen, state.bottomHeight)
                scheduleDrag(width, height)
              }}
              onPointerUp={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                if (dragCommitted.current) return
                dragCommitted.current = true
                event.currentTarget.releasePointerCapture(event.pointerId)
                const { startX, startWidth } = widthDrag.current
                // The up position is the pointer's FINAL position — a fast
                // flick's tail is coalesced into the up event, so the last
                // pointermove (the rAF pending value) can be stale. Commit
                // from the up position (v0.13.1 semantics; issue #247).
                const width = clampWidth(startWidth + (startX - event.clientX))
                const height = pushedBottomHeight(state.bottomOpen, state.bottomHeight)
                commitDrag(width, height, s => setWidth(s, width))
                setDraggingWidth(false)
              }}
              onPointerCancel={(event) => { abortDrag(() => setDraggingWidth(false), event) }}
              onLostPointerCapture={() => { abortDrag(() => setDraggingWidth(false)) }}
            />
          )}
        <div className={css.panelBody}>
          <Workbench
            state={state}
            tree={augmentedTree}
            newTabOptions={newTabOptions}
            actions={wrappedActions}
            onNewTab={onNewTab}
            renderTab={renderTab}
            getTabIcon={tabIconOf}
            getTabBadge={tabBadgeOf}
          />
        </div>
        {/*
          The shared corner (only while BOTH panels are open): the
          intersection of the right panel's left edge and the bottom panel's
          top edge. Horizontal drags resize the right panel's width, vertical
          drags the bottom panel's height — the two panels drag against each
          other. Rendered INSIDE the right panel and positioned by CSS
          relative to it (left edge + the bottom panel's height via the
          --dsh-sidebar-height layout variable) — no JS-written viewport
          coordinates to keep in sync. (Never on narrow viewports: the
          bottom panel does not exist there.)
        */}
        {!narrow && state.panelOpen && state.bottomOpen && (
          <div
            className={css.cornerHandle}
            data-dragging={draggingCorner || undefined}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragCommitted.current = false
              cornerDrag.current = {
                startX: event.clientX,
                startY: event.clientY,
                startWidth: state.width,
                startHeight: state.bottomHeight,
              }
              setDraggingCorner(true)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const { startX, startY, startWidth, startHeight } = cornerDrag.current
              const width = clampWidth(startWidth + (startX - event.clientX))
              const height = pushedBottomHeight(true, clampHeight(startHeight + (startY - event.clientY)))
              scheduleDrag(width, height)
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              if (dragCommitted.current) return
              dragCommitted.current = true
              event.currentTarget.releasePointerCapture(event.pointerId)
              const { startX, startY, startWidth, startHeight } = cornerDrag.current
              // Up position wins over the rAF pending value (see the width
              // strip handler — issue #247).
              const width = clampWidth(startWidth + (startX - event.clientX))
              const height = pushedBottomHeight(true, clampHeight(startHeight + (startY - event.clientY)))
              commitDrag(width, height, s => setBottomHeight(setWidth(s, width), height))
              setDraggingCorner(false)
            }}
            onPointerCancel={(event) => { abortDrag(() => setDraggingCorner(false), event) }}
            onLostPointerCapture={() => { abortDrag(() => setDraggingCorner(false)) }}
          />
        )}
      </div>
      {/*
        The bottom panel: a second, independent workbench. It squeezes ONLY
        the center column (the agent output area): it starts at the app
        shell's own left sidebar and ends at the right panel's left edge —
        neither sidebar gives up any position (the right panel keeps its
        full height). Its resize strip is the top edge; hidden by sliding
        down like the right panel. On NARROW viewports it does not exist —
        the bottom workbench lives inside the drawer (MobileWorkbench).
      */}
      {/* The bottom panel only becomes VISIBLE once the center column is
          measured: before that, `centerRect` is the {0,0} fallback and
          `right` computes to the full viewport width — the panel (and its
          overflow content) would flash full-width for a frame until the
          first measurement lands. Rendering stays unconditional so the
          mount/render chain (auto-terminal etc.) is never gated on
          geometry. */}
      {!narrow && (
      <div
        ref={bottomRef}
        className={clsx(css.bottomPanel, !state.bottomOpen && css.bottomPanelHidden)}
        data-dsh-panel
        data-dsh-bottom-panel
        style={{
          height: bottomPanelHeight,
          left: centerRectRef.current.left,
          // Keep the panel above the on-screen keyboard when the visual
          // viewport shrinks (see the keyboardInset effect).
          bottom: keyboardInset > 0 ? `${keyboardInset}px` : undefined,
          // Direct from the center column's measured right edge: the bottom
          // panel spans ONLY the center column, ending exactly at the
          // details column's left edge (the details column sits between the
          // center and the right panel, and the right panel's reserved frame
          // padding is already baked into centerRect.right).
          right: window.innerWidth - centerRectRef.current.right,
          // The seam against the open right panel needs its own hairline
          // (the right panel's border-left alone is covered by this panel's
          // fill — without it the corner looks cut off).
          borderRight: state.panelOpen ? '1px solid var(--dsw-alias-border-l2)' : undefined,
          // Unmeasured center column → keep the panel invisible (zero-size
          // geometry would flash full-width overflow instead).
          visibility: centerMeasured ? undefined : 'hidden',
        }}
       
        data-dragging={(draggingBottom || draggingCorner) || undefined}
      >
        <div
          className={clsx(css.bottomResize, draggingBottom && css.bottomResizeActive)}
         
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragCommitted.current = false
            bottomDrag.current = { startY: event.clientY, startHeight: state.bottomHeight }
            setDraggingBottom(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const { startY, startHeight } = bottomDrag.current
            const height = pushedBottomHeight(true, clampHeight(startHeight + (startY - event.clientY)))
            scheduleDrag(Math.min(state.width, window.innerWidth), height)
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            if (dragCommitted.current) return
            dragCommitted.current = true
            event.currentTarget.releasePointerCapture(event.pointerId)
            const { startY, startHeight } = bottomDrag.current
            // Up position wins over the rAF pending value (see the width
            // strip handler — issue #247).
            const height = pushedBottomHeight(true, clampHeight(startHeight + (startY - event.clientY)))
            commitDrag(Math.min(state.width, window.innerWidth), height, s => setBottomHeight(s, height))
            setDraggingBottom(false)
          }}
          onPointerCancel={(event) => { abortDrag(() => setDraggingBottom(false), event) }}
          onLostPointerCapture={() => { abortDrag(() => setDraggingBottom(false)) }}
        />
        {/*
          The bottom panel's own close control at its tab strip's right end
          (the strip reserves the width via CSS so the + menu never hides
          under it): one tap collapses the panel.
        */}
        <Tooltip label={t('collapseBottomPanel')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.bottomClose}
            aria-label={t('collapseBottomPanel')}
            onClick={() => { store.reduce(toggleBottomPanel) }}
          >
            <IconCloseFill14 />
          </button>
        </Tooltip>
        <div className={css.panelBody}>
          <Workbench
            state={state}
            tree={state.bottomSplits}
            newTabOptions={newTabOptions}
            actions={actions}
            onNewTab={onNewTab}
            renderTab={(tab, active, paneId) => renderTab(tab, active, paneId, 'bottom')}
            getTabIcon={tabIconOf}
            getTabBadge={tabBadgeOf}
          />
        </div>
      </div>
      )}
      {/*
        Free windows + the drag-out hint: the layer renders the floats (the
        array's order is the stacking order) reusing the regular tab
        renderer, followed by the dashed drop-zone overlay (sidebar/
        free-windows.tsx renders both as one fragment — DOM unchanged).
      */}
      <FreeWindowLayer
        floats={state.floats}
        hint={floatHint}
        renderTab={renderTab}
        getTabIcon={tabIconOf}
        store={store}
        ctx={ctx}
        sessionId={sessionId}
        cwd={cwd}
      />
    </div>
  )
}
