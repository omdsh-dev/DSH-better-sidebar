/**
 * Plan-event matchers shared by the host's plan routes and the client's plan
 * page. Plan mode belongs to the host's `dsh-plan-mode` plugin (not a
 * dependency), so the exit tool is matched by NAME and its acceptance rule is
 * mirrored here — once, for both faces, so they cannot drift apart.
 *
 * The host validates the body INSIDE `execute`, after the call row is already
 * in the log, so a logged call can carry a body the user never saw a review
 * card for. The aborted-before-dispatch exclusion covers the rest of those
 * cases: only the paired result knows the call never ran.
 */

/** The model-facing exit tool of the host's plan mode. */
export const PLAN_EXIT_TOOL = 'exit_plan_mode'

/** The event-window cap both sides run: the client must hold one full
 *  response, so the two numbers live here rather than as synced literals. */
export const PLAN_EVENTS_WINDOW = 2_000

/** The window-relay event across the core-bundle → plan-chunk boundary. */
export const PLAN_CHANGED_EVENT = 'dsh-sidebar:plan-changed'

/** The narrow event shape both sides read (host events are a closed union,
 *  mirrored rows a plain record — these fields alone identify plan rows). */
export interface PlanEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** The plan markdown inside one call's arguments, or undefined when the host
 *  would refuse the submission (`args.plan.trim()` against `/^#\s+\S/`). */
export function planBodyOf(argumentsRaw: unknown): string | undefined {
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

/** The call id of one exit-tool call whose body the host would accept. */
export function acceptedExitCallIdOf(event: PlanEventLike): string | undefined {
  if (event.type !== 'tool/call') return undefined
  const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
  if (data.name !== PLAN_EXIT_TOOL || typeof data.callId !== 'string') return undefined
  return planBodyOf(data.arguments) === undefined ? undefined : data.callId
}

/** The call id one `tool/result` pairs with, or undefined for anything else. */
export function resultCallIdOf(event: PlanEventLike): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const message = (event.data as { message?: unknown }).message as { source?: { callId?: unknown } } | undefined
  const callId = message?.source?.callId
  return typeof callId === 'string' ? callId : undefined
}

/** The abort code the harness stamps on a call it skipped BEFORE dispatch —
 *  such a row carries a perfectly acceptable plan body the user never saw.
 *  The value is the dsh-tools constant's VALUE, not its name: the export is
 *  `TOOL_ABORTED_BEFORE_DISPATCH` and it holds `'ABORTED_BEFORE_DISPATCH'`. */
const ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

function abortCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** The call ids a paired result marks as aborted before dispatch. Must run
 *  over the WHOLE log: the abort lands on the result, after the call row. */
export function abortedPlanCallIdsOf(events: readonly PlanEventLike[]): Set<string> {
  const aborted = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    if (abortCodeOf((event.data as { error?: unknown } | null)?.error) !== ABORTED_BEFORE_DISPATCH) continue
    const callId = resultCallIdOf(event)
    if (callId !== undefined) aborted.add(callId)
  }
  return aborted
}
