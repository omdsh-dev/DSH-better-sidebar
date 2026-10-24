/**
 * The root the explorer and the git panel should use for one session.
 *
 * The client session list carries the session HEADER cwd, captured once when
 * the session started. The HOST is the authority on where the session is
 * actually working, because it can follow the agent into a linked git worktree
 * including one belonging to a different repository. Ask the host, prefer
 * its answer, and re-ask when the window regains focus, when the document
 * becomes visible again, when a file refresh is requested, and on a slow timer
 * so a mid-session worktree move is picked up.
 *
 * ONE store per `sessionId` (the `ui/git-status.ts` shape: a module-level Map
 * of slots with `retain()` / `release()` and `useSyncExternalStore`). The host
 * keeps every visited native tab body mounted, so a per-hook poller meant one
 * 5 s `session.cwd` POST per live body — three visited tabs on one session
 * were three requests per tick, and each of those lands in the host's
 * `activeWorktreeRootOf` (up to four real `git` spawns on a cache miss, whose
 * TTL is shorter than this cadence). The store therefore runs EXACTLY ONE
 * timer per session, and only while at least one subscriber reports itself
 * visible (`visible: false` is what the host hands a parked tab body, and the
 * sidebar shell passes its own panel-open state). A parked body holds no timer
 * and issues no request; `document.hidden` pauses the timers the same way.
 *
 * A parked body keeps its last answer — releasing the last visible subscriber
 * stops the timer but does not drop the resolved root, so re-showing a tab
 * paints the worktree the session was in instead of falling back to the frozen
 * list cwd. Becoming visible again (a subscriber turning visible, the document
 * turning visible, or the window regaining focus) refreshes immediately once
 * instead of waiting for the next tick. Both listeners belong to the store:
 * the old per-instance `window.focus` listener was added once per mounted hook
 * and never removed for the life of the page.
 *
 * Shared by both client surfaces: the plugin's own sidebar shell
 * (`Sidebar.tsx`) and the native DSH right-sidebar tab body
 * (`native/tab-adapter.tsx`). They used to disagree — the native body read the
 * frozen list summary directly, so a host-side worktree change never reached
 * the file list drawn in the host's own right Sidebar.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { api } from './api.ts'

/** How often the host is re-asked while the document is visible. */
const SESSION_ROOT_POLL_MS = 5_000

interface Slot {
  readonly sessionId: string
  /** The last host answer; kept while parked (see the module comment). */
  cwd: string | undefined
  /** The `useSyncExternalStore` snapshot: bumped when `cwd` changes. */
  version: number
  /** Subscribers that report themselves visible. */
  visible: number
  timer: number | undefined
  /** Bumped per request so a late answer from an older one is dropped. */
  generation: number
  listeners: Set<() => void>
}

const slots = new Map<string, Slot>()

/** Whether the store's one-shot window/document listeners are attached. */
let listening = false

/** The slot of one session, created on first use. */
function slotOf(sessionId: string): Slot {
  const existing = slots.get(sessionId)
  if (existing !== undefined) return existing
  const slot: Slot = {
    sessionId, cwd: undefined, version: 0, visible: 0,
    timer: undefined, generation: 0, listeners: new Set(),
  }
  slots.set(sessionId, slot)
  attachListeners()
  return slot
}

function notify(slot: Slot): void {
  slot.version += 1
  for (const listener of slot.listeners) listener()
}

/**
 * Ask the host where the session is working now. A hidden document issues
 * nothing: the answer would only drive panels nobody can see.
 */
function fetchSlot(slot: Slot): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const generation = ++slot.generation
  api.sessionCwd({ sessionId: slot.sessionId })
    .then((result) => {
      if (generation !== slot.generation) return
      if (slot.cwd === result.cwd) return
      slot.cwd = result.cwd
      notify(slot)
    })
    .catch(() => { /* the explorer/git rows surface their own errors */ })
}

function startTimer(slot: Slot): void {
  if (slot.timer !== undefined) return
  slot.timer = window.setInterval(() => { fetchSlot(slot) }, SESSION_ROOT_POLL_MS)
}

function stopTimer(slot: Slot): void {
  if (slot.timer === undefined) return
  window.clearInterval(slot.timer)
  slot.timer = undefined
}

/** Re-read every session that has at least one visible subscriber. */
function refreshVisible(): void {
  for (const slot of slots.values()) {
    if (slot.visible > 0) fetchSlot(slot)
  }
}

/**
 * Attach the store's listeners once, on the first slot: `focus` and the file
 * refresh are window events, so per-hook listeners accumulated for the life of
 * the page (a body that remounts on every session switch added another).
 */
function attachListeners(): void {
  if (listening) return
  listening = true
  window.addEventListener('focus', refreshVisible)
  window.addEventListener('dsh-sidebar:refresh-files', refreshVisible)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // A hidden page polls nothing: pause every cadence rather than waking on
      // each tick to decide it must not fetch.
      for (const slot of slots.values()) stopTimer(slot)
      return
    }
    for (const slot of slots.values()) {
      if (slot.visible === 0) continue
      startTimer(slot)
      fetchSlot(slot)
    }
  })
}

/** One more visible subscriber: the first one owns the timer and re-reads now. */
function retain(slot: Slot): void {
  slot.visible += 1
  if (slot.visible > 1) return
  startTimer(slot)
  fetchSlot(slot)
}

/** One fewer visible subscriber: the last one takes the timer with it. */
function release(slot: Slot): void {
  slot.visible = Math.max(0, slot.visible - 1)
  if (slot.visible === 0) stopTimer(slot)
}

/** What the caller hands the hook. */
export interface SessionRootOptions {
  /**
   * Whether this caller is on screen. Defaults to true; a parked caller
   * (`visible: false`) holds no timer and issues no request, and keeps the
   * last resolved root until it comes back.
   */
  visible?: boolean
}

/**
 * Resolve the live workspace root for one session.
 * @param ctx - client plugin context (owns the session list feed + API).
 * @param sessionId - the session to resolve; `undefined` resolves to `undefined`.
 * @param options - `visible: false` parks this caller (no polling).
 * @returns the host's active root, falling back to the list summary cwd.
 */
export function useSessionRoot(
  ctx: Context,
  sessionId: string | undefined,
  options: SessionRootOptions = {},
): string | undefined {
  const { visible = true } = options
  const summaryCwd = useSyncExternalStore(
    useMemo(() => (listener: () => void) => ctx.sessions.list.subscribe(listener), [ctx]),
    () => sessionId === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
  )
  const slot = sessionId === undefined ? undefined : slotOf(sessionId)
  const subscribe = useCallback((listener: () => void) => {
    if (slot === undefined) return () => {}
    slot.listeners.add(listener)
    return () => { slot.listeners.delete(listener) }
  }, [slot])
  useSyncExternalStore(subscribe, () => slot?.version ?? 0, () => slot?.version ?? 0)

  useEffect(() => {
    if (slot === undefined || !visible) return undefined
    retain(slot)
    return () => { release(slot) }
  }, [slot, visible])

  return slot?.cwd ?? summaryCwd
}
