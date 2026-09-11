/**
 * Host-feed subscriptions (extracted from Sidebar.tsx, behavior identical):
 * the WebSocket pushes (agent terminals, agent opens) and the session-list
 * driven auto-activation triggers (subagent, background jobs, topology
 * jump-back). All of it reacts to the host's live feeds for the CURRENT
 * session; the sidebar shell only consumes the returned jump-back ref.
 */
import { useEffect, useRef } from 'react'
import type { Context, SidebarSessionList } from '../../context-types.ts'
import { reconcileAgentTerminals, type SidebarStore } from '../state.ts'
import { isNarrowWidth } from '../breakpoints.ts'
import { detectNewDirectSubagent } from '../subagent-detect.ts'
import { detectNewJob } from '../subagent-jobs.ts'
import { t } from '../locales.ts'

/** How many consecutive reconnect failures stop the agent-terminals push loop
 * (mirror of the terminal view's own cap; the loop restarts on session switch). */
const FAILURE_LIMIT = 3

/**
 * Subagent auto-open debounce (ms). The host delivers a new child's origin
 * and its title in SEPARATE frames: a Side Chat thread's first visible
 * frame still shows a fallback title (no 'Side: ' prefix), so an immediate
 * 0→N decision mistakes it for a genuine subagent and pops the task page.
 * The trigger therefore re-evaluates against the live snapshot once the
 * title frame has had time to land.
 */
const AUTO_OPEN_DEBOUNCE_MS = 500

/**
 * The native column's public face, as this module reaches it. Both actions
 * act on the session whose surface is MOUNTED (the controller reads its
 * binding), which is why the park below is gated on the target session being
 * the on-screen one.
 */
interface NativeColumnFace {
  isExpanded?: () => boolean
  toggleExpanded?: () => void
}

/**
 * Activate the Tasks page (the `subagent` tab type) in DSH's native right
 * Sidebar — the landing the two auto-open switches promise: the right column
 * IS the sidebar the user means, while the plugin's own bottom workbench only
 * serves its own flows (its `+` menu and the first-expansion terminal). Every
 * other open in this plugin already lands there, so a `target: 'bottom'` here
 * puts the Tasks page in the bottom bar instead.
 *
 * A background activation must not take over a narrow viewport: below 768px
 * the host draws that column FULLSCREEN, so the tab is placed and the column
 * is put back to collapsed — parked, waiting behind the expand control,
 * instead of covering the chat. The host expands on every open
 * (`openContent` plans `setExpanded(true)`) and offers no option to suppress
 * it, hence the read-then-restore pair: both commits land in one React batch,
 * so the column never renders the intermediate state. The viewport is read
 * when the activation FIRES (the debounced subagent trigger included), so a
 * resize while arming is honoured.
 *
 * @param ctx - the client context (`ctx.sidebarRight` + `ctx.betterSidebar`).
 * @param sessionId - the session the feed reports the activity for.
 * @param options.background - `true` for background activity (parks on narrow
 *   viewports); `false` for the explicit topology jump-back, which is a user
 *   gesture and always leaves the column as the host expanded it.
 */
function activateTasksPage(ctx: Context, sessionId: string, options: { background: boolean }): void {
  const column = ctx.get('sidebarRight') as unknown as NativeColumnFace | undefined
  const park = options.background
    // The face acts on the MOUNTED session: parking is only meaningful (and
    // only safe) when the activation targets the one on screen.
    && ctx.sessions.list.getSnapshot().current === sessionId
    && isNarrowWidth(window.innerWidth)
    // Only a column the user had COLLAPSED is put back: an expanded one is in
    // use, and closing it under the user would be worse than the takeover.
    && column?.isExpanded?.() === false
  ctx.get('betterSidebar')?.openTab({ type: 'subagent', title: t('subagent') })
  if (park) column?.toggleExpanded?.()
}

export function useHostFeeds(feeds: {
  ctx: Context
  store: SidebarStore
  sessionList: SidebarSessionList
  sessionId: string | undefined
}): { subagentJumpRef: { current: string | undefined } } {
  const { ctx, store, sessionList, sessionId } = feeds

  /**
   * Agent terminals push: subscribe to the host's live list of agent-owned
   * terminals for this session (created by the model through the
   * `terminal_create` tool). The host pushes a JSON array on every
   * create / close / exit; the sidebar reconciles the list into tabs
   * (id `agent:<uuid>`, title from the agent). A disconnected socket
   * retries with a short backoff so a refresh or transient drop reattaches
   * the same shell without losing the agent's work — capped like the
   * terminal view's own reconnect loop, so a refused endpoint never spins
   * forever (the next session switch restarts the loop).
   * While the terminal tab type is disabled in settings, pushes are
   * ignored (no auto-added tabs); re-enabling makes the next push converge.
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-terminals', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const list = JSON.parse(event.data) as Array<{ uuid: string; title: string; command: string; exited: boolean }>
          if (!Array.isArray(list)) return
          store.reduce(s => ctx.get('betterSidebar')?.isTabEnabled('terminal') === false
            ? s
            : reconcileAgentTerminals(s, list))
        } catch {
          // Malformed push: ignore (the next push will reconcile).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          console.error('[dsh-better-sidebar] agent-terminals connection failed; stopping reconnect loop', sessionId)
          return
        }
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, ctx, store])

  /**
   * Agent opens push: subscribe to the host's `sidebar_open` requests for
   * this session (the model actively opens a file / folder / HTTP(S) page).
   * The host pushes one JSON request per open; the sidebar routes it to the
   * matching built-in tab: a file opens in the editor (per-path dedupe), a
   * folder opens a file window whose tree is rooted at the folder
   * (`meta.dir`), and a URL opens in the browser tab. A disconnected socket
   * retries with a short backoff (mirror of the agent-terminals loop): the
   * host queue keeps undelivered requests and replays them on the first
   * attach, so a refresh or a session switch lands the opens the model
   * queued while no view was connected.
   * While the side-card setting is off, pushes are ignored as a defensive
   * gate — the host already unregisters the tool and drains the queue.
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-opens', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const request = JSON.parse(event.data) as { kind?: unknown; target?: unknown; title?: unknown; files?: unknown }
          if (request === null || typeof request !== 'object') return
          if (request.kind === 'refresh') {
            const files = Array.isArray(request.files) ? request.files : undefined
            window.dispatchEvent(new CustomEvent('dsh-sidebar:refresh-files', { detail: { files } }))
            return
          }
          if (request.kind !== 'file' && request.kind !== 'folder' && request.kind !== 'url') return
          if (typeof request.target !== 'string' || request.target === '') return
          if (store.getPrefs().agentOpenTools !== true) return
          const scope = { sessionId }
          const title = typeof request.title === 'string' && request.title !== '' ? request.title : undefined
          if (request.kind === 'url') {
            ctx.get('betterSidebar')?.openTab({ type: 'browser', url: request.target, title }, scope)
          } else if (request.kind === 'folder') {
            ctx.get('betterSidebar')?.openTab({
              type: 'editor',
              title,
              path: request.target,
              id: `editor:${request.target}`,
              meta: { dir: true },
            }, scope)
          } else {
            ctx.get('betterSidebar')?.openFile(scope, request.target, title)
          }
        } catch {
          // Malformed push: ignore (the next push carries its own request).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          console.error('[dsh-better-sidebar] agent-opens connection failed; stopping reconnect loop', sessionId)
          return
        }
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, ctx, store])

  /**
   * Subagent auto-activation: the moment the current conversation spawns its
   * FIRST direct subagent (a 0 → N transition on the list feed), the "auto
   * open" pref is on, and the Tasks tab type is enabled in settings, activate
   * the Tasks page in DSH's native right Sidebar. Single-instance semantics
   * focus an existing tab in place; a new tab lands in that column and is
   * never duplicated. Landing it EXPANDS the column on wide viewports, while
   * a narrow viewport (where the host draws that column fullscreen) parks the
   * tab instead of taking the screen over — see {@link activateTasksPage}.
   * Switching to a session that already has subagents never triggers — its
   * baseline starts at the current count — so a deliberate layout is never
   * fought.
   *
   * The decision is DEBOUNCED (AUTO_OPEN_DEBOUNCE_MS): a Side Chat thread
   * is also a subagent-origin child, and its 'Side: ' title lands one frame
   * after its origin — an immediate check would misread that first frame as
   * a new subagent and pop this page on every thread creation. The timer
   * re-evaluates the ORIGINAL baseline against the live snapshot; by then
   * the title filter (isSideThreadSummary) sees the settled label.
   */
  const listBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  const autoOpenPendingRef = useRef<{ baseline: SidebarSessionList; timer: number } | null>(null)
  useEffect(() => {
    const prev = listBaselineRef.current
    listBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (autoOpenPendingRef.current !== null) return
    if (!detectNewDirectSubagent(prev, sessionList, sessionId)) return
    const baseline = prev
    const timer = window.setTimeout(() => {
      autoOpenPendingRef.current = null
      if (!detectNewDirectSubagent(baseline, ctx.sessions.list.getSnapshot(), sessionId)) return
      if (!store.getPrefs().autoOpenSubagent) return
      if (ctx.get('betterSidebar')?.isTabEnabled('subagent') === false) return
      activateTasksPage(ctx, sessionId, { background: true })
    }, AUTO_OPEN_DEBOUNCE_MS)
    autoOpenPendingRef.current = { baseline, timer }
  }, [sessionList, sessionId, store, ctx])

  // A session switch (or unmount) voids any armed auto-open recheck.
  useEffect(() => () => {
    const pending = autoOpenPendingRef.current
    if (pending !== null) window.clearTimeout(pending.timer)
    autoOpenPendingRef.current = null
  }, [sessionId])

  /**
   * Job auto-activation: the moment a NEW background job appears for the
   * current conversation (a job id the previous snapshot lacked), the
   * auto-open pref is on, and the Tasks tab type is enabled, activate the Tasks
   * page that contains the background-jobs section — in DSH's native right
   * Sidebar, expanded on wide viewports and parked on narrow ones exactly like
   * the subagent trigger ({@link activateTasksPage}). Unlike that trigger
   * (0 → N only), ANY new job id triggers: the agent may start several jobs in
   * one session, and each should surface. A fresh page load never triggers —
   * its baseline starts at the current snapshot.
   */
  const jobBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  useEffect(() => {
    const prev = jobBaselineRef.current
    jobBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (!detectNewJob(prev, sessionList, sessionId)) return
    if (!store.getPrefs().autoOpenJobs) return
    if (ctx.get('betterSidebar')?.isTabEnabled('subagent') === false) return
    activateTasksPage(ctx, sessionId, { background: true })
  }, [sessionList, sessionId, store, ctx])

  /**
   * Topology jump-back: clicking a subagent node on the Subagent page calls
   * the official `openSubagent`, which switches the sidebar to that child
   * session's OWN layout (a fresh child session defaults to the explorer).
   * The README contract says the Subagent page must stay open with the jumped
   * node highlighted — so once the current session becomes the recorded jump
   * target, re-open the Tasks page on top of the child's layout, in DSH's
   * native right Sidebar. This one is an explicit user gesture, so it always
   * takes the host's expansion (no narrow-viewport parking). Only this node
   * click arms the flag, so switching to a subagent session by any other means
   * keeps that session's own layout untouched.
   */
  const subagentJumpRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const pending = subagentJumpRef.current
    if (pending === undefined || sessionId !== pending) return
    subagentJumpRef.current = undefined
    activateTasksPage(ctx, sessionId, { background: false })
  }, [sessionId, store, ctx])

  return { subagentJumpRef }
}
