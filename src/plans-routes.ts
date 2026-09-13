/**
 * Plan-page routes of the /sidebar JSON API ('plans.events') plus the
 * plan-submission push feed behind `/sidebar/ws/plans`.
 *
 * Plan mode belongs to the host's `dsh-plan-mode` plugin: the model presents a
 * finished plan through its `exit_plan_mode` tool, whose `plan` argument
 * carries the whole document as markdown. That argument is the ONLY durable
 * source — the `plan/mode` session events and the `plan` projection carry
 * booleans only, and the review question's `detail` is a purely in-memory seam
 * that never reaches the session log. So the page reads the session's event
 * log, the same preference the changes lens follows for file operations.
 *
 * The exit tool is matched by NAME only (`dsh-plan-mode` is not a dependency
 * of this plugin) plus the host's OWN acceptance rule for its body — both
 * live in `./plan-events.ts`, shared with the client's plan page.
 *
 * Two faces:
 *
 * - 'plans.events' — the plan rows of one session: every accepted exit-tool
 *   call plus its paired result. Rows are PRE-FILTERED by tool name host-side
 *   (rather than shipping the whole tool window the way 'changes.ops' does),
 *   which is what keeps a long session's EARLIEST plans on the wire.
 * - the push feed — one `{ sessionId, seq }` notice per accepted submission,
 *   to whichever sidebar views are attached for that session, plus a small
 *   mirror of the rows it saw. No queue and no replay on attach: a dropped
 *   notice costs nothing (the plan is in the log for good, one click away),
 *   while replaying one would pop the column open on a mere page reload.
 */
import type { Context, SidebarSessionEvent } from './context-types.ts'
import { sessionEventWindow } from './session-store.ts'
import {
  abortedPlanCallIdsOf,
  acceptedExitCallIdOf,
  resultCallIdOf,
  type PlanEventLike,
} from './plan-events.ts'

/** Per-session cap of mirrored rows (a bounded, lossy ring). */
const MIRROR_MAX_ROWS = 400

/** How many sessions the mirror keeps at once. */
const MIRROR_MAX_SESSIONS = 64

/**
 * The plan rows of one session, oldest first: every accepted exit-tool call
 * plus its paired result. The accepted call ids are collected over the WHOLE
 * log before the cursor narrows anything, and calls aborted before dispatch
 * are ruled out here, so the wire window and the page's fold agree exactly.
 */
function takePlanRows(
  log: readonly SidebarSessionEvent[],
  afterSeq: number,
  limit: number,
): readonly SidebarSessionEvent[] {
  const aborted = abortedPlanCallIdsOf(log)
  // Accepted call ids cached per ROW: the filter and cap trim below re-ask
  // rows the collection already judged, and every ask re-parses the body.
  const accepted = new Map<SidebarSessionEvent, string>()
  for (const event of log) {
    const callId = acceptedExitCallIdOf(event)
    if (callId !== undefined && !aborted.has(callId)) accepted.set(event, callId)
  }
  const planCalls = new Set(accepted.values())
  const filtered = log.filter((event) => {
    const callId = accepted.get(event) ?? resultCallIdOf(event)
    return callId !== undefined && planCalls.has(callId) && event.seq > afterSeq
  })
  if (filtered.length <= limit) return filtered
  const capped = filtered.slice(filtered.length - limit)
  // Never ship a result whose call fell off the cap's front: the fold pairs by
  // call id, so a headless result is dropped and takes its whole revision with
  // it — which the page's "keep every revision" contract forbids. Dropping the
  // orphan row instead keeps every SHIPPED pair whole.
  let start = 0
  while (start < capped.length && !accepted.has(capped[start]!)) start += 1
  return capped.slice(start)
}

/** The two plan routes of the sidebar API. */
export interface SidebarPlansRoutes {
  /**
   * The plan rows of one session past `afterSeq` (0/absent = whole log),
   * oldest first. An unavailable log is an empty window, never an error.
   */
  events(payload: unknown): Promise<{ events: readonly SidebarSessionEvent[]; lastSeq: number }>
}

/** Live-mirrored plan rows, one session at a time (see {@link createPlanPushes}). */
export interface PlanRowMirror {
  rows(sessionId: string): readonly SidebarSessionEvent[]
}

/**
 * Build the plans routes bound to the plugin context.
 * @param ctx - host plugin context.
 * @param mirror - live-mirrored plan rows (the store's log can lag — see the
 *   {@link sessionEventWindow} note on the rehydration boundary).
 * @param limit - response cap in rows; longer logs ship their most recent
 *   window (a plan is two rows, so this bounds thousands of revisions).
 */
export function buildPlansApi(ctx: Context, mirror: PlanRowMirror, limit: number): SidebarPlansRoutes {
  return {
    events: (payload) => sessionEventWindow(
      ctx,
      payload,
      (log, afterSeq) => takePlanRows(log, afterSeq, limit),
      (sessionId) => mirror.rows(sessionId),
    ),
  }
}

/** One plan-submission notice (the wire face over the push socket). */
export interface PlanNotice {
  readonly sessionId: string
  readonly seq: number
}

/** The plan push feed: per-session subscribers plus the mirrored rows. */
export interface PlanPushes extends PlanRowMirror {
  /** Attach one sidebar view; returns the detacher. */
  subscribe(sessionId: string, send: (notice: PlanNotice) => void): () => void
  /** Drop every subscriber and mirrored row (plugin teardown). */
  dispose(): void
}

/**
 * Create the plan push feed over the session append feed. A notice is
 * published the moment the model CALLS the exit tool with an accepted plan —
 * which is before the review question reaches the user, the exact moment the
 * page should already be open on the new revision. Result-side flips
 * (pending → approved/unadopted) are deliberately NOT pushed: the page's own
 * poll settles them, so the feed needs no memory of which calls it has seen.
 *
 * The feed also MIRRORS the rows it saw, because the store session's log can
 * freeze at its rehydration boundary after a host restart — the same hazard
 * `jobs-routes` mirrors job_output for. The mirror is a bounded ring: the
 * store remains the durable source, this only patches the window it can miss.
 */
export function createPlanPushes(ctx: Context): PlanPushes {
  const subscribers = new Map<string, Set<(notice: PlanNotice) => void>>()
  const mirrored = new Map<string, SidebarSessionEvent[]>()

  const mirror = (sessionId: string, event: PlanEventLike): void => {
    // Map iteration order is insertion order: a NEW session evicts the oldest
    // one, so a long-lived host's mirror cannot grow without bound.
    if (!mirrored.has(sessionId) && mirrored.size >= MIRROR_MAX_SESSIONS) {
      const oldest = mirrored.keys().next().value
      if (oldest !== undefined) mirrored.delete(oldest)
    }
    let rows = mirrored.get(sessionId)
    if (rows === undefined) mirrored.set(sessionId, rows = [])
    rows.push({ type: event.type, seq: event.seq, time: event.time, data: event.data as Record<string, unknown> })
    if (rows.length > MIRROR_MAX_ROWS) rows.splice(0, rows.length - MIRROR_MAX_ROWS)
  }

  // Detaching on dispose (not only on fiber teardown) keeps a manual
  // `dispose()` from leaving a listener that keeps mirroring rows.
  let detach: (() => void) | undefined
  if (typeof ctx.on === 'function') {
    detach = ctx.on('session/event', (session, event) => {
      const sessionId = (session as { id?: unknown } | null)?.id
      if (typeof sessionId !== 'string') return
      if (acceptedExitCallIdOf(event) !== undefined) {
        mirror(sessionId, event)
        const views = subscribers.get(sessionId)
        if (views !== undefined) {
          const notice: PlanNotice = { sessionId, seq: event.seq }
          for (const send of views) send(notice)
        }
        return
      }
      // A result only joins the mirror when it pairs with a call still in the
      // session's ring (a rolled-off call's result would ship headless).
      const resultId = resultCallIdOf(event)
      if (resultId === undefined) return
      const rows = mirrored.get(sessionId)
      if (rows === undefined || !rows.some((row) => acceptedExitCallIdOf(row) === resultId)) return
      mirror(sessionId, event)
    })
    ctx.effect(() => () => { detach?.() }, 'dsh-better-sidebar: plan push feed')
  }

  return {
    rows: (sessionId) => mirrored.get(sessionId) ?? [],
    subscribe(sessionId, send) {
      let views = subscribers.get(sessionId)
      if (views === undefined) {
        views = new Set()
        subscribers.set(sessionId, views)
      }
      views.add(send)
      return () => {
        const current = subscribers.get(sessionId)
        current?.delete(send)
        if (current !== undefined && current.size === 0) subscribers.delete(sessionId)
      }
    },
    dispose() {
      detach?.()
      detach = undefined
      subscribers.clear()
      mirrored.clear()
    },
  }
}
