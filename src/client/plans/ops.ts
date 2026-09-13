/**
 * Plan extraction for the plan page: folds the session's append-only event
 * log into one entry per plan the model presented through the host's
 * `exit_plan_mode` tool. Pure — no React, no DOM, no i18n (the caller
 * supplies the fallback label).
 *
 * The host tool's own acceptance rule is mirrored rather than approximated:
 * a body must open on a `# ` heading (`/^#\s+\S/`), and the host validates
 * that INSIDE `execute` — after its `tool/call` row is already in the log. A
 * rejected submission therefore leaves behind a call the user never saw a
 * review card for, and extracting it would put a phantom plan on the page.
 */
import type { SidebarSessionEvent } from '../../context-types.ts'

/** The model-facing exit tool of the host's plan mode (mirrored host-side). */
const EXIT_PLAN_TOOL = 'exit_plan_mode'

/** How a plan's review settled; the third state is "keep planning", NOT a
 *  rejection — the enum avoids `rejected` so the wording cannot drift back. */
export type PlanStatus = 'pending' | 'approved' | 'unadopted'

/** One extracted plan revision. */
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

/** The 'tool/result' message envelope inside a session event's data. */
interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
}

/** One 'tool-result' content block (the inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  isError?: unknown
}

/**
 * The abort code the harness stamps on a call it skipped BEFORE dispatch (a
 * stop keystroke landing between the model's tool call and its execution).
 * Such a row carries the model's original arguments — a perfectly acceptable
 * plan body — so {@link extractPlans} has to recognize the abort to keep it
 * off the page.
 */
const ABORTED_BEFORE_DISPATCH = 'TOOL_ABORTED_BEFORE_DISPATCH'

/** The harness error's code on a tool/result event, when it carries one. */
function abortCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Whether a tool result reported an error (the inner block's isError flag). */
function resultIsError(message: ToolResultMessageLike): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    if (block === null || typeof block !== 'object') return false
    return (block as ToolResultBlockLike).type === 'tool-result'
      && (block as ToolResultBlockLike).isError === true
  })
}

/** The first markdown heading of any level — the same rule the host's review
 *  card uses for its title, so the page and the chat card name a plan alike. */
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
 * The plan markdown inside one call's arguments, or undefined when the call
 * is not an accepted plan submission. See the module doc for why a logged
 * call can carry a body the host refused.
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

/**
 * Fold a session event log into the plans it contains, OLDEST FIRST. The
 * order is deliberately the opposite of `extractFileOps`' newest-first: that
 * list is an activity feed, this one is a document history — v1..vN run
 * forward in time, so the selector's index and the version number stay one
 * and the same and "the latest" is simply the last entry.
 *
 * A `tool/call` of the exit tool seeds a pending plan with the markdown the
 * model sent; its paired `tool/result` settles it — an error result means the
 * user kept planning (or dismissed the question), anything else means
 * approval. Every malformed shape is SKIPPED rather than thrown over: one bad
 * row must never cost the reader the plans around it.
 * @param events - the session's append-only event log (oldest → newest).
 * @returns the plan revisions in submission order.
 */
export function extractPlans(events: readonly SidebarSessionEvent[]): PlanEntry[] {
  const byCall = new Map<string, PlanEntry>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
      if (data.name !== EXIT_PLAN_TOOL || typeof data.callId !== 'string') continue
      // A repeated row (the wire window can overlap across polls) must never
      // reset a settled revision: the FIRST sighting of a call owns the entry.
      if (byCall.has(data.callId)) continue
      const body = planBodyOf(data.arguments)
      if (body === undefined) continue
      const title = firstHeadingOf(body)
      byCall.set(data.callId, {
        callId: data.callId,
        seq: event.seq,
        time: event.time,
        ...(title === undefined ? {} : { title }),
        body,
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
      // A skipped-before-dispatch call never reached a review card, so it is
      // dropped rather than settled — see {@link ABORTED_BEFORE_DISPATCH}.
      if (abortCodeOf((event.data as { error?: unknown }).error) === ABORTED_BEFORE_DISPATCH) {
        byCall.delete(callId)
        continue
      }
      byCall.set(callId, {
        ...plan,
        status: resultIsError(message) ? 'unadopted' : 'approved',
        settledTime: event.time,
      })
    }
  }
  return [...byCall.values()].sort((a, b) => a.seq - b.seq)
}
