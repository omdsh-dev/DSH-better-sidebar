/**
 * The plan domain: the shapes of a plan revision, the matchers that recognize
 * one, and the single fold that turns a session log into the list of them.
 *
 * Plan mode belongs to the host's `dsh-plan-mode` plugin (not a dependency of
 * this one), so the exit tool is matched by NAME and the host's own acceptance
 * rule is mirrored here. Both faces run THIS module — the host folds with it,
 * the client renders the types it declares — which is what keeps a page entry
 * and a shipped row from drifting apart.
 *
 * The host validates the body INSIDE `execute`, after the call row is already
 * in the log, so a logged call can carry a body the user never saw a review
 * card for. The aborted-before-dispatch exclusion covers the rest of those
 * cases: only the paired result knows the call never ran.
 *
 * The `result*` helpers live here rather than beside their changes-tab caller
 * so the fold can settle a plan without a host module reaching into the
 * client's own ops module. `jobs-routes.ts` still carries its own private
 * copies (a mirror of the same tool-result shape) — pre-existing, and out of
 * this module's scope.
 */
import type { SidebarSessionEvent } from './context-types.ts'

/** The model-facing exit tool of the host's plan mode. */
export const PLAN_EXIT_TOOL = 'exit_plan_mode'

/** Row window of one plan response: the tail of the plan rows past which the
 *  earliest revisions fall off. Folding runs over this window, so it bounds a
 *  single response rather than a client-held cursor. */
export const PLAN_EVENTS_WINDOW = 2_000

/** The window-relay event across the core-bundle → plan-chunk boundary. */
export const PLAN_CHANGED_EVENT = 'dsh-sidebar:plan-changed'

/** The narrow event shape the matchers read (host events are a closed union —
 *  these fields alone identify plan rows). */
export interface PlanEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** How a plan's review settled; the third state is "keep planning", NOT a
 *  rejection — the enum avoids `rejected` so the wording cannot drift back. */
export type PlanStatus = 'pending' | 'approved' | 'unadopted'

/** One plan revision as the plan page shows it. */
export interface PlanEntry {
  /** Stable identity: the originating tool-call id. */
  readonly callId: string
  /** The call event's seq (ordering key; the log is append-only). */
  readonly seq: number
  /** Unix epoch ms of the submission. */
  readonly time: number
  /** The body's first markdown heading; absent when it has none (the host's
   *  own card title falls back the same way). */
  readonly title?: string
  /** The plan document exactly as the model presented it (outer blanks trimmed). */
  readonly body: string
  readonly status: PlanStatus
  /** Unix epoch ms of the review outcome; present once the status settled. */
  readonly settledTime?: number
}

/** One session's plan revisions, oldest first (the route's answer). */
export type PlanList = readonly PlanEntry[]

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

/** The exit-tool call's id and accepted body — the ONE place the host's
 *  acceptance rule is applied to a call row. Undefined for anything else,
 *  a body the host itself would refuse included. */
function acceptedExitOf(event: PlanEventLike): { callId: string; body: string } | undefined {
  if (event.type !== 'tool/call') return undefined
  const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
  if (data.name !== PLAN_EXIT_TOOL || typeof data.callId !== 'string') return undefined
  const body = planBodyOf(data.arguments)
  return body === undefined ? undefined : { callId: data.callId, body }
}

/** The call id of one exit-tool call whose body the host would accept. */
export function acceptedExitCallIdOf(event: PlanEventLike): string | undefined {
  return acceptedExitOf(event)?.callId
}

/** The call id one `tool/result` pairs with, or undefined for anything else. */
export function resultCallIdOf(event: PlanEventLike): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const message = (event.data as { message?: unknown }).message as { source?: { callId?: unknown } } | undefined
  const callId = message?.source?.callId
  return typeof callId === 'string' ? callId : undefined
}

/** The 'tool/result' message envelope inside a session event's data. */
export interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
}

/** One 'tool-result' content block (inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  content?: unknown
  isError?: unknown
}

/** Whether a tool result reported an error (the inner block's isError flag). */
export function resultIsError(message: ToolResultMessageLike): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    if (block === null || typeof block !== 'object') return false
    return (block as ToolResultBlockLike).type === 'tool-result'
      && (block as ToolResultBlockLike).isError === true
  })
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

/** The call ids a paired result marks as aborted before dispatch — exit-tool
 *  calls only: the host's agent loop stamps a call+abort-result pair for
 *  EVERY tool a stop skips before dispatch, and only the exit-tool pair has
 *  plan faces to keep consistent. Must run over the WHOLE log: the abort
 *  lands on the result, after the call row — which is what the fold reads. */
export function abortedPlanCallIdsOf(events: readonly PlanEventLike[]): Set<string> {
  const planCalls = new Set<string>()
  for (const event of events) {
    const callId = acceptedExitCallIdOf(event)
    if (callId !== undefined) planCalls.add(callId)
  }
  const aborted = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    if (abortCodeOf((event.data as { error?: unknown } | null)?.error) !== ABORTED_BEFORE_DISPATCH) continue
    const callId = resultCallIdOf(event)
    if (callId !== undefined && planCalls.has(callId)) aborted.add(callId)
  }
  return aborted
}

/**
 * The first markdown heading of any level — the same rule the host's review
 * card uses for its title, so the page and the chat card name a plan alike.
 */
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/

/** The body's first heading text, or undefined when it has none. */
function firstHeadingOf(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const match = HEADING_RE.exec(line)
    if (match !== null && match[1] !== undefined) return match[1]
  }
  return undefined
}

/**
 * Fold a session log into the plans it contains, OLDEST FIRST. The order is
 * deliberately the opposite of `extractFileOps`' newest-first: that list is an
 * activity feed, this one is a document history — v1..vN run forward in time,
 * so the selector's index and the version number stay one and the same and
 * "the latest" is simply the last entry.
 *
 * A `tool/call` of the exit tool seeds a pending plan with the markdown the
 * model sent; its paired `tool/result` settles it — an error result means the
 * user kept planning (or dismissed the question), anything else means
 * approval. Every malformed shape is SKIPPED rather than thrown over: one bad
 * row must never cost the reader the plans around it.
 *
 * Run over the whole window, never a delta: anything narrower loses the call
 * rows whose results it still has to pair, which is how a settled revision
 * would silently fall back to pending.
 *
 * @param events - the session's append-only event log (oldest → newest).
 * @returns the plan revisions in submission order.
 */
export function derivePlans(events: readonly SidebarSessionEvent[]): PlanEntry[] {
  const byCall = new Map<string, PlanEntry>()
  // The abort lands on the result, after the call row, so the exclusion runs
  // over the whole window before the fold.
  const aborted = abortedPlanCallIdsOf(events)
  for (const event of events) {
    if (event.type === 'tool/call') {
      const accepted = acceptedExitOf(event)
      if (accepted === undefined) continue
      // A repeated row must never reset a settled revision: the FIRST sighting
      // of a call owns the entry.
      if (byCall.has(accepted.callId)) continue
      if (aborted.has(accepted.callId)) continue
      const title = firstHeadingOf(accepted.body)
      byCall.set(accepted.callId, {
        callId: accepted.callId,
        seq: event.seq,
        time: event.time,
        ...(title === undefined ? {} : { title }),
        body: accepted.body,
        status: 'pending',
      })
      continue
    }
    if (event.type === 'tool/result') {
      const message = (event.data as { message?: unknown }).message as ToolResultMessageLike | undefined
      if (message === undefined) continue
      const callId = message.source?.callId
      if (typeof callId !== 'string') continue
      const plan = byCall.get(callId)
      if (plan === undefined) continue
      byCall.set(callId, {
        ...plan,
        status: resultIsError(message) ? 'unadopted' : 'approved',
        settledTime: event.time,
      })
    }
  }
  return [...byCall.values()].sort((a, b) => a.seq - b.seq)
}
