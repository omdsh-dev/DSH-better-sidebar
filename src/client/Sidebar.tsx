/**
 * The sidebar shell: ONE surface — the bottom workbench docked to the
 * conversation column.
 *
 * DSH 0.1.5 owns the right column: its native Sidebar hosts every tab type
 * this plugin registers (client/native/), so this shell renders no right
 * panel of its own. What remains plugin-owned is the bottom workbench: it
 * spans ONLY the AppFrame's center column (the agent output area), from the
 * app shell's own left sidebar to the details column's left edge, so neither
 * sidebar gives up any position. Its height drags from its top edge, and the
 * expand/collapse control is a header button registered into DSH's
 * `conversation.session.header.utilities` list slot
 * (sidebar/bottom-toggle.tsx) — the header's right corner belongs to the
 * native sidebar's own expand control.
 *
 * The panel is mounted inside the unified panel host — a fixed,
 * viewport-sized containing block ([data-dsh-panel-host]) appended to
 * document.body — instead of a fixed-position element, so a desktop shell's
 * intermediate wrapper transforms can never hijack its containing block.
 * The whole layout lives in the per-session store, so switching
 * conversations swaps the workbench.
 *
 * The shell binds the workbench actions to the store and dispatches tab
 * content to the views. New tabs come from the + menu (explorer / git /
 * terminal; editors open from the explorer).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { referenceInChat as referenceInChatShared } from './reference-in-chat.ts'
import {
  BOTTOM_MIN, CONVERSATION_MIN, agentUuidOf, firstLeaf, isAgentTabId,
  leafWithTab, moveTab, moveTabToEdge, openDiffTab, resizeSplitIn,
  setBottomHeight, setTabPin, toggleBottomPanel, toggleExpanded,
  type DropZone, type SidebarStore, type SidebarTab,
} from './state.ts'
import { getPinnedHomeScope } from './pinned.ts'
import { IconPanelBottomOutline16 } from './icons.tsx'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
import { useViewportSize } from './breakpoints.ts'
import { bottomPushHeight } from './layout-push.ts'
import { parseDesktopEnv } from './desktop-env.ts'
import { getWcoSnapshot, subscribeWco } from './wco.ts'
import { getShellPreset } from './shell-presets.ts'
import { computeTitleBarStrip } from './titlebar-strip.ts'
import { TabContent, buildNewTabOptions } from './sidebar/TabContent.tsx'
import { confirmDiscardDraft, dirtyCount, editorDirtyRevision, subscribeEditorDirty } from './editor-dirty.ts'
import { useCenterColumn } from './sidebar/use-center-column.ts'
import { useHostFeeds } from './sidebar/use-host-feeds.ts'
import { usePinnedTabs } from './sidebar/use-pinned-tabs.ts'
import type { TabDragPayload } from './TabBar.tsx'
import { t } from './locales.ts'
import { api } from './api.ts'
import css from './sidebar.module.css'

/**
 * OS file drags over the sidebar belong to the sidebar, not to the chat:
 * DSH's composer (InputBar) listens for file drags on the DOCUMENT and
 * answers with a full-screen "drop image here" mask plus image intake on
 * drop. The panel host swallows the whole event quartet —
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

  const viewport = useViewportSize()

  // On-screen keyboard / visual-viewport inset (mobile, split-screen, …):
  // when the visual viewport shrinks below the layout viewport, bottom-
  // anchored panels would hide under the keyboard. Track the inset and
  // offset the bottom-anchored surfaces by it. The obscured bottom strip is
  // innerHeight − (vv.height + vv.offsetTop): offsetTop is nonzero while
  // the visual viewport is scrolled/zoomed under browser chrome, so
  // omitting it would over-lift the panel (CR #232 P2). offsetTop changes
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
  // The bottom workbench is offset above the on-screen keyboard. Cap its
  // height against that same visible area, not the taller layout viewport,
  // so the conversation keeps CONVERSATION_MIN even on wide touch devices.
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

  // Unload guard: a browser refresh / tab close / navigation would drop every
  // open unsaved draft at once. The listener is armed only while at least one
  // draft is dirty (subscribeEditorDirty fires on every register/clear), so a
  // clean session navigates away without a prompt. Every session's drafts
  // count — the page is going away, not just the visible conversation. The
  // message itself is the browser's own generic warning (custom text ignored).
  const dirtyRevision = useSyncExternalStore(subscribeEditorDirty, () => editorDirtyRevision())
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirtyCount() === 0) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => { window.removeEventListener('beforeunload', onBeforeUnload) }
  }, [dirtyRevision])

  const summaryCwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd

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

  // The + menu options ride a memo so the workbench does not rebuild the
  // array identity across renders that did not change the store (drag state,
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

  // Center-column tracking (sidebar/use-center-column.ts): the bottom
  // workbench spans ONLY the app shell's center column ("squeezes the agent
  // output area"); the hook locates the AppFrame's center column DOM (host
  // anchor observers + slow retry), measures its edges into a ref, and
  // writes them straight to the bottom panel element — per-frame tracking
  // without re-rendering the shell (the comments live with the hook now).
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const { centerRectRef, centerMeasured, measureCenter, draggingRef } = useCenterColumn(bottomRef, state?.bottomOpen)

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
    ctx.get('betterSidebar')?.openTab({ type: 'terminal', target: 'bottom' })
  }, [state, store, ctx])

  // The bottom panel's height drag (top edge strip). Drags write the size
  // DIRECTLY to the DOM (panel style + the layout CSS variable) instead of
  // round-tripping the store on every pointer move — a store reduce
  // re-renders the workbench (terminals, editors…) per move, which is the
  // visible drag lag. The store is committed once on pointer up
  // (clamping + persistence).
  const bottomDrag = useRef({ startY: 0, startHeight: 0 })
  const [draggingBottom, setDraggingBottom] = useState(false)

  // Pause center-column measurement while dragging, and re-measure once the
  // drag settles at its committed size. The store commit lands on release and
  // the final height equals the last drag height, so no ResizeObserver event
  // fires to refresh centerRect — this explicit re-measure covers that gap.
  useEffect(() => {
    draggingRef.current = draggingBottom
    if (!draggingBottom) measureCenter()
    // draggingRef is a stable ref object from useCenterColumn (same
    // provenance note as the hook's own comments).
  }, [draggingBottom, measureCenter, draggingRef])

  // Clamp mirror of setBottomHeight for mid-drag values (the store re-clamps
  // on commit; this keeps the panel from overshooting mid-drag).
  const clampHeight = (height: number): number =>
    Math.min(Math.max(BOTTOM_MIN, Math.round(height)), Math.max(BOTTOM_MIN, window.innerHeight - CONVERSATION_MIN))

  /** Single writer for the layout-push variable: the app shell gives up the
   *  workbench's height while it is open (0 while collapsed) through
   *  layout.css's margin on the center column. Every size change — drag
   *  frames and committed state — flows through here so the push never
   *  forks between paths. The right column is DSH's native Sidebar, so no
   *  width is written. */
  const writeGeometry = (height: number): void => {
    document.documentElement.style.setProperty('--dsh-sidebar-height', `${height}px`)
  }

  /** Last height a drag actually applied to the DOM (updated by applyDrag).
   *  When a pointer stream dies without any position info (issue #247: an
   *  ultra-fast flick whose release events carried no usable coordinates),
   *  the abort path adopts this instead of rolling back to the pre-drag
   *  value — the DOM's current size is the only truthful record left. */
  const lastDragHeight = useRef<number | null>(null)

  /** Apply a drag height to the DOM without touching React state or the
   *  store. The layout push rides the shared writer (writeGeometry). */
  const applyDrag = (height: number): void => {
    lastDragHeight.current = height
    bottomRef.current?.style.setProperty('height', `${height}px`)
    const push = state?.bottomOpen === true ? height + keyboardInset : 0
    writeGeometry(push)
  }

  // Drags write at most once per frame: pointer events fire several times
  // faster than the display refresh, and each write reflows the app shell
  // (the layout push) plus the panel — batching to one write per frame is
  // what keeps the drag smooth. The store is still committed once on release.
  const dragFrame = useRef<number | null>(null)
  const pendingDrag = useRef<number | null>(null)
  const scheduleDrag = (height: number): void => {
    pendingDrag.current = height
    if (dragFrame.current !== null) return
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null
      const pending = pendingDrag.current
      if (pending !== null) {
        pendingDrag.current = null
        applyDrag(pending)
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
   * Finalize the drag on pointer up: flush the LAST drag frame to the DOM
   * synchronously, then commit the SAME clamped value to the store. A fast
   * release cancels the rAF before it ran — without the flush the DOM would
   * sit at the pre-drag size until React re-renders with the committed
   * value, and a value that never made it into a move handler would never
   * be applied at all. The measurement pause ends here too: the center
   * column is re-measured BEFORE the committed re-render lands, so the
   * panel's React-rendered edges already reflect the new height.
   */
  const commitDrag = (height: number): void => {
    stopDragScheduling()
    applyDrag(height)
    draggingRef.current = false
    measureCenter()
    store.reduce(s => setBottomHeight(s, height))
  }

  /** Set once a drag's pointerup handler commits — premature capture loss
   *  (pointercancel / lostpointercapture without pointerup) must then be told
   *  apart from a normal release. */
  const dragCommitted = useRef(false)
  /**
   * Abort a drag whose pointer stream was interrupted (pointercancel, or
   * capture lost before pointerup): no pointerup will arrive, so without
   * this the dragging state would stick true and center-column measurement
   * would stay paused forever — the panel freezes at stale edges and stops
   * tracking layout changes.
   *
   * A FAST release is the common trigger: browsers merge pointermove bursts,
   * and an ultra-fast flick can cancel the stream before ANY move lands.
   * The commit order is therefore: the LAST KNOWN dragged size (the rAF
   * pending value) first, then the interrupting event's own pointer
   * position (only pointercancel is trusted to carry coordinates —
   * lostpointercapture's coordinates are not guaranteed, so the handlers
   * pass the event only from pointercancel), and finally the size the drag
   * last APPLIED to the DOM (lastDragHeight). A drag that produced none of
   * those (pure down+up at the same spot) commits the store's own height —
   * a no-op, never an explicit rollback (issue #247).
   *
   * Every commit path marks the drag committed, so the interrupt
   * double-fire (pointercancel → lostpointercapture) cannot commit once
   * and then roll the same drag back.
   */
  const abortDrag = (reset: () => void, event?: { clientY: number }): void => {
    if (dragCommitted.current) return
    const pending = pendingDrag.current
    let height: number | undefined
    if (pending !== null) {
      height = pending
    } else if (event !== undefined) {
      // No move ever landed: the cancel position is all we have — commit it
      // (clamped) instead of rolling back the flick.
      height = clampHeight(bottomDrag.current.startHeight + (bottomDrag.current.startY - event.clientY))
    }
    if (height !== undefined) {
      dragCommitted.current = true
      stopDragScheduling()
      applyDrag(height)
      draggingRef.current = false
      measureCenter()
      store.reduce(s => setBottomHeight(s, height))
    } else {
      // No pending write and no usable event coordinates: keep the height the
      // drag last applied instead of rolling back to the pre-drag value (the
      // flick's moves may have been consumed by the rAF just before the
      // stream died — the DOM already shows the dragged size).
      dragCommitted.current = true
      stopDragScheduling()
      const adopted = clampHeight(lastDragHeight.current ?? state?.bottomHeight ?? BOTTOM_MIN)
      applyDrag(adopted)
      draggingRef.current = false
      measureCenter()
      store.reduce(s => setBottomHeight(s, adopted))
    }
    reset()
  }

  // Layout push: the app shell gives up the workbench's height while it is
  // open (0 while collapsed), so the conversation and input bar are squeezed
  // instead of covered. The margin is capped at the viewport so a stale
  // persisted height (e.g. fullscreen on a bigger window) can never crush the
  // app shell to zero. Dragging disables the layout transition.
  useEffect(() => {
    const height = bottomPushHeight({
      open: snapshot.state?.bottomOpen === true,
      height: snapshot.state?.bottomHeight ?? 0,
      viewportHeight: layoutViewportHeight,
    })
    writeGeometry(snapshot.state?.bottomOpen === true ? height + keyboardInset : 0)
  }, [snapshot.state?.bottomOpen, snapshot.state?.bottomHeight, layoutViewportHeight, keyboardInset])
  // Unmount must release the push (issue #31): when the boundary swaps the
  // whole sidebar after a render crash (or the plugin fiber is disposed /
  // HMR), the CSS variable would otherwise stay on <html> and layout.css
  // keeps squeezing #root with a stale margin — "the sidebar cannot be
  // hidden" until a full reload. This lives in an UNMOUNT-ONLY effect, NOT
  // in the push effect's cleanup: React can yield between a passive
  // effect's cleanup and setup phases, and removing the variable on a
  // dependency change used to paint the push-less layout for a frame.
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty('--dsh-sidebar-height')
    }
  }, [])
  useEffect(() => {
    if (draggingBottom) document.body.setAttribute('data-dsh-sidebar-dragging', '')
    else document.body.removeAttribute('data-dsh-sidebar-dragging')
  }, [draggingBottom])

  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (paneId, tabId) => {
      // An unsaved editor draft would be dropped by the unmount — ask first.
      // The confirmation is the SAME guard the refresh button uses, so every
      // close path (tab X, middle click, tab context menu, the tree's
      // close-on-rename/delete) funnels through here and warns exactly once.
      if (!confirmDiscardDraft(tabId, t('closeUnsavedConfirm'))) return
      // A closed terminal releases its pty immediately — including when its
      // socket is mid-reconnect, where the unmount close frame never reaches
      // the host and the process would hold the quota until the grace ends.
      // Agent terminals (tabId `agent:<uuid>`) close through a different
      // host route: the WS close frame is the primary path (sent by
      // TerminalView on unmount), and the agent-pty.close HTTP route is the
      // fallback when the WS is down.
      const current = store.getSnapshot().state
      const leaf = current === undefined ? undefined : leafWithTab(current.bottomSplits, tabId)
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
      // Route through the service: same reducer (finds the pane, sets the
      // active pane) and fires descriptor.onActivate; the session scope
      // (with its cwd) rides to the callback.
      ctx.get('betterSidebar')?.activateTab(tabId, sessionId === undefined ? undefined : { sessionId, cwd })
    },
    focusPane: (paneId) => { store.reduce(s => ({ ...s, activePane: paneId })) },
    moveTabToEdge: (payload: TabDragPayload, toPane: string, zone: DropZone) => {
      store.reduce(s => moveTabToEdge(s, payload.paneId, payload.tabId, toPane, zone))
    },
    moveTabBefore: (payload: TabDragPayload, toPane: string, beforeTabId: string) => {
      store.reduce((s) => {
        let index = -1
        const source = leafWithTab(s.bottomSplits, beforeTabId)
        if (source !== undefined && source.id === toPane) {
          index = source.tabs.findIndex(tab => tab.id === beforeTabId)
        }
        return moveTab(s, payload.paneId, payload.tabId, toPane, index)
      })
    },
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduce(s => resizeSplitIn(s, splitId, index, deltaFrac))
    },
    // Pin/unpin a terminal tab (v0.17.0+): the home cwd is snapshotted at
    // pin time so a workspace-scoped pin only resurfaces in sessions whose
    // cwd matches. Unpin passes null — the tab stays open in its home
    // session, just unmarked.
    pinTab: (tabId, scope) => {
      store.reduce(s => setTabPin(s, tabId, scope === null ? null : { scope, homeCwd: cwd }))
    },
  }), [store, sessionId, cwd, ctx])

  // Pinned virtual tabs (sidebar/use-pinned-tabs.ts): cross-session pinned
  // tabs inject into the bottom workbench's first leaf, and the actions are
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
    referenceInChatShared(ctx, sessionId, cwd, path, isDir)
  }, [ctx, sessionId, cwd])

  if (state === undefined || sessionId === undefined) {
    // No conversation yet: the host stays mounted (the drag shield keeps
    // covering the region) but nothing is rendered — the toggle button lives
    // in DSH's session header, which does not exist without a session.
    return <div data-dsh-panel-host {...osFileDragShield} />
  }

  const bottomPanelHeight = bottomPushHeight({
    open: true,
    height: state.bottomHeight,
    viewportHeight: layoutViewportHeight,
  })

  const onNewTab = (optionId: string): void => {
    const service = ctx.get('betterSidebar')
    const descriptor = service?.getTab(optionId)
    if (service === undefined || descriptor === undefined) return
    const title = typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
    // The session scope rides along: lifecycle callbacks receive it. The
    // open is bottom-targeted so the tab lands in THIS workbench, not in the
    // native right Sidebar.
    service.openTab({ type: optionId, title, target: 'bottom' }, { sessionId, cwd })
  }

  /**
   * The tab icon from the tab-type registry. An editor tab WITH a file path
   * (the per-path windows of split mode — `meta.dir` marks folder windows,
   * which keep the folder glyph) shows the same file icon the tree row shows
   * (`fileIcon`, feature `fileIcons`); every other tab uses its tab-type
   * descriptor icon.
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
    // Agent-terminal wait indicator (sidebar-internal, deliberately NOT a
    // TabDescriptor.badge — that API is type-keyed and shared with external
    // plugins, and cannot address one tab): the agent-terminals push mirrors
    // the model's live terminal_wait_for into state.agentWaits; an agent tab
    // whose uuid is waiting shows the hourglass pill.
    if (isAgentTabId(tab.id)) {
      const wait = state.agentWaits?.[agentUuidOf(tab.id)]
      if (wait !== undefined) return <span className={css.tabBadge}>{'⏳'}</span>
    }
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
  const renderTab = (tab: SidebarTab, active: boolean, paneId: string) => {
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
        visible={state.bottomOpen && active}
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
        The bottom workbench: it squeezes ONLY the center column (the agent
        output area): it starts at the app shell's own left sidebar and ends
        at the details column's left edge — neither sidebar gives up any
        position. Its resize strip is the top edge; hidden by sliding down.
        It only becomes VISIBLE once the center column is measured: before
        that, `centerRect` is the {0,0} fallback and `right` computes to the
        full viewport width — the panel (and its overflow content) would
        flash full-width for a frame until the first measurement lands.
        Rendering stays unconditional so the mount/render chain (auto-terminal
        etc.) is never gated on geometry.
      */}
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
          // details column's left edge.
          right: window.innerWidth - centerRectRef.current.right,
          // Unmeasured center column → keep the panel invisible (zero-size
          // geometry would flash full-width overflow instead).
          visibility: centerMeasured ? undefined : 'hidden',
        }}
        data-dragging={draggingBottom || undefined}
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
            scheduleDrag(clampHeight(startHeight + (startY - event.clientY)))
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            if (dragCommitted.current) return
            dragCommitted.current = true
            event.currentTarget.releasePointerCapture(event.pointerId)
            const { startY, startHeight } = bottomDrag.current
            // Up position wins over the rAF pending value (see the abortDrag
            // comment — issue #247).
            commitDrag(clampHeight(startHeight + (startY - event.clientY)))
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
            tree={augmentedTree}
            newTabOptions={newTabOptions}
            actions={wrappedActions}
            onNewTab={onNewTab}
            renderTab={renderTab}
            getTabIcon={tabIconOf}
            getTabBadge={tabBadgeOf}
          />
        </div>
      </div>
    </div>
  )
}

/** The header control that expands/collapses the bottom workbench (see
 *  sidebar/bottom-toggle.tsx — registered into DSH's session header). */
export function BottomDockToggle(props: { store: SidebarStore }) {
  const { store } = props
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const open = snapshot.state?.bottomOpen === true
  const label = open ? t('collapseBottomPanel') : t('expandBottomPanel')
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.toggleButton}
        data-dsh-bottom-toggle
        data-active={open ? 'true' : undefined}
        aria-label={label}
        aria-pressed={open}
        onClick={() => { store.reduce(toggleBottomPanel) }}
      >
        <IconPanelBottomOutline16 />
      </button>
    </Tooltip>
  )
}
