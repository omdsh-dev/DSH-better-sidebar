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
 * Two faces:
 *
 * - 'plans.events' — one session's plans, ALREADY FOLDED: the fold that turns
 *   the log into revisions lives in `./plan-events.ts` and runs here, once.
 *   The page therefore holds no event log, no cursor and no second copy of
 *   the acceptance rule.
 * - the push feed — one `{ sessionId, seq }` notice per accepted submission,
 *   to whichever sidebar views are attached for that session. No queue and no
 *   replay on attach: a dropped notice costs nothing (the plan is in the log
 *   for good, one click away), while replaying one would pop the column open
 *   on a mere page reload.
 */
import type { Context, SidebarSessionEvent } from './context-types.ts'
import { sessionEventWindow } from './session-store.ts'
import {
  acceptedExitCallIdOf,
  derivePlans,
  resultCallIdOf,
  type PlanList,
} from './plan-events.ts'

/**
 * The session's plan rows, oldest first, capped to the tail window the fold
 * will read: every accepted exit-tool call plus the results that pair with
 * one. Calls aborted before dispatch ship too — telling them apart from a
 * real submission is the FOLD's job (over the whole window, where the abort
 * collection runs), and this filter only decides which rows are plan rows.
 */
function takePlanRows(
  log: readonly SidebarSessionEvent[],
  limit: number,
): readonly SidebarSessionEvent[] {
  // Result pairing is a whole-window question: a capped scan would drop the
  // result of a call that fell off the head of the window.
  const paired = new Set<string>()
  for (const event of log) {
    const callId = acceptedExitCallIdOf(event)
    if (callId !== undefined) paired.add(callId)
  }
  const rows = log.filter((event) => {
    const callId = acceptedExitCallIdOf(event) ?? resultCallIdOf(event)
    return callId !== undefined && paired.has(callId)
  })
  const capped = rows.length > limit ? rows.slice(rows.length - limit) : rows
  // Never start the window on an orphan result: the fold pairs by call id, so
  // a headless result contributes nothing and would only eat the cap. The
  // rows that follow it are whole revisions.
  let start = 0
  while (start < capped.length && resultCallIdOf(capped[start]!) !== undefined) start += 1
  return capped.slice(start)
}

/** The one route of the plan API. */
export interface SidebarPlansRoutes {
  /** One session's plan revisions, oldest first. An unavailable log is an
   *  empty list, never an error. */
  events(payload: unknown): Promise<PlanList>
}

/**
 * Build the plans routes bound to the plugin context.
 * @param ctx - host plugin context.
 * @param limit - response cap in rows; longer logs ship their most recent
 *   window (a plan is two rows, so this bounds thousands of revisions).
 */
export function buildPlansApi(ctx: Context, limit: number): SidebarPlansRoutes {
  return {
    events: async (payload) => {
      const { events } = await sessionEventWindow(ctx, payload, (log) => takePlanRows(log, limit))
      return derivePlans(events)
    },
  }
}

/** One plan-submission notice (the wire face over the push socket). */
export interface PlanNotice {
  readonly sessionId: string
  readonly seq: number
}

/** The plan push feed: per-session subscribers. */
export interface PlanPushes {
  /** Attach one sidebar view; returns the detacher. */
  subscribe(sessionId: string, send: (notice: PlanNotice) => void): () => void
  /** Drop every subscriber (plugin teardown). */
  dispose(): void
}

/**
 * Create the plan push feed over the session append feed. A notice is
 * published the moment the model CALLS the exit tool with an accepted plan —
 * which is before the review question reaches the user, the exact moment the
 * page should already be open on the new revision. Result-side flips
 * (pending → approved/unadopted) are deliberately NOT pushed: the page's own
 * poll settles them, so the feed needs no memory of which calls it has seen.
 */
export function createPlanPushes(ctx: Context): PlanPushes {
  const subscribers = new Map<string, Set<(notice: PlanNotice) => void>>()

  // Detaching on dispose (not only on fiber teardown) keeps a manual
  // `dispose()` from leaving a listener behind.
  let detach: (() => void) | undefined
  if (typeof ctx.on === 'function') {
    detach = ctx.on('session/event', (session, event) => {
      const sessionId = (session as { id?: unknown } | null)?.id
      if (typeof sessionId !== 'string') return
      if (acceptedExitCallIdOf(event) === undefined) return
      const views = subscribers.get(sessionId)
      if (views === undefined) return
      const notice: PlanNotice = { sessionId, seq: event.seq }
      for (const send of views) send(notice)
    })
    ctx.effect(() => () => { detach?.() }, 'dsh-better-sidebar: plan push feed')
  }

  return {
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
    },
  }
}
