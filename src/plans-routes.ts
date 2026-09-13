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
 * of this plugin) plus the host's OWN acceptance rule for its body, mirrored
 * in {@link planBodyOf}: the host validates `/^#\s+\S/` INSIDE `execute`,
 * after the call row is already in the log, so both faces would otherwise
 * surface — and announce — submissions the user never saw a review card for.
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

/** The model-facing exit tool of the host's plan mode (mirrored client-side). */
const EXIT_PLAN_TOOL = 'exit_plan_mode'

/** Per-response cap on shipped plan rows (one plan is two rows). */
export const PLANS_EVENTS_CAP = 2000

/** Per-session cap of mirrored rows (a bounded, lossy ring). */
const MIRROR_MAX_ROWS = 400

/**
 * The session-event shape this module reads. The host's append feed and the
 * plugin's structural mirror type their events differently (`data` is a closed
 * union there, a plain record here), and plan rows are identified from these
 * fields alone — reading through the narrow shape keeps the matchers usable
 * from both sides.
 */
interface PlanEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * The plan markdown inside one call's arguments, or undefined when the host
 * would refuse the submission. Mirrors the tool's own rule (`args.plan.trim()`
 * against `/^#\s+\S/`) — see the module doc for why a logged call can carry a
 * body the host never accepted.
 */
function planBodyOf(argumentsRaw: unknown): string | undefined {
  if (typeof argumentsRaw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsRaw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const plan = (parsed as { plan?: unknown }).plan
  if (typeof plan !== 'string') return undefined
  const body = plan.trim()
  return /^#\s+\S/.test(body) ? body : undefined
}

/** The call id of one ACCEPTED exit-tool call, or undefined for anything else. */
function acceptedExitCallIdOf(event: PlanEventLike): string | undefined {
  if (event.type !== 'tool/call') return undefined
  const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
  if (data.name !== EXIT_PLAN_TOOL || typeof data.callId !== 'string') return undefined
  return planBodyOf(data.arguments) === undefined ? undefined : data.callId
}

/** The call id one `tool/result` pairs with, or undefined for anything else. */
function resultCallIdOf(event: PlanEventLike): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const message = (event.data as { message?: unknown }).message as { source?: { callId?: unknown } } | undefined
  const callId = message?.source?.callId
  return typeof callId === 'string' ? callId : undefined
}

/**
 * The plan rows of one session, oldest first. The accepted call ids are
 * collected over the WHOLE log before the cursor narrows anything — `afterSeq`
 * bounds what is shipped, never what a result may pair with.
 */
function takePlanRows(
  log: readonly SidebarSessionEvent[],
  afterSeq: number,
  limit: number,
): readonly SidebarSessionEvent[] {
  const planCalls = new Set<string>()
  for (const event of log) {
    const callId = acceptedExitCallIdOf(event)
    if (callId !== undefined) planCalls.add(callId)
  }
  const filtered = log.filter((event) => {
    const callId = acceptedExitCallIdOf(event) ?? resultCallIdOf(event)
    return callId !== undefined && planCalls.has(callId) && event.seq > afterSeq
  })
  if (filtered.length <= limit) return filtered
  const capped = filtered.slice(filtered.length - limit)
  // Never ship a result whose call fell off the cap's front: the fold pairs by
  // call id, so a headless result is dropped and takes its whole revision with
  // it — which the page's "keep every revision" contract forbids. Dropping the
  // orphan row instead keeps every SHIPPED pair whole.
  let start = 0
  while (start < capped.length && acceptedExitCallIdOf(capped[start]!) === undefined) start += 1
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
  const mirroredIds = new Map<string, Set<string>>()

  const mirror = (sessionId: string, event: PlanEventLike): void => {
    let rows = mirrored.get(sessionId)
    if (rows === undefined) mirrored.set(sessionId, rows = [])
    rows.push({ type: event.type, seq: event.seq, time: event.time, data: event.data as Record<string, unknown> })
    if (rows.length > MIRROR_MAX_ROWS) {
      const removed = rows.splice(0, rows.length - MIRROR_MAX_ROWS)
      const ids = mirroredIds.get(sessionId)
      if (ids !== undefined) {
        for (const row of removed) {
          const callId = acceptedExitCallIdOf(row)
          if (callId !== undefined) ids.delete(callId)
        }
        if (ids.size === 0) mirroredIds.delete(sessionId)
      }
    }
  }

  // Detaching on dispose (not only on fiber teardown) keeps a manual
  // `dispose()` from leaving a listener that keeps mirroring rows.
  let detach: (() => void) | undefined
  if (typeof ctx.on === 'function') {
    detach = ctx.on('session/event', (session, event) => {
      const sessionId = (session as { id?: unknown } | null)?.id
      if (typeof sessionId !== 'string') return
      const callId = acceptedExitCallIdOf(event)
      if (callId !== undefined) {
        let ids = mirroredIds.get(sessionId)
        if (ids === undefined) mirroredIds.set(sessionId, ids = new Set())
        ids.add(callId)
        mirror(sessionId, event)
        const views = subscribers.get(sessionId)
        if (views !== undefined) {
          const notice: PlanNotice = { sessionId, seq: event.seq }
          for (const send of views) send(notice)
        }
        return
      }
      // A result only joins the mirror when it pairs with a mirrored call.
      const resultId = resultCallIdOf(event)
      if (resultId === undefined || !mirroredIds.get(sessionId)?.has(resultId)) return
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
      mirroredIds.clear()
    },
  }
}
