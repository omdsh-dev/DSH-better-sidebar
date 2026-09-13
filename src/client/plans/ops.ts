/**
 * Plan extraction for the plan page: folds the session's append-only event
 * log into one entry per plan the model presented through the host's
 * `exit_plan_mode` tool. Pure — no React, no DOM, no i18n (the caller
 * supplies the fallback label). The acceptance rule (heading check, aborted
 * calls) lives in `src/plan-events.ts`, shared with the host's ship side.
 */
import type { SidebarSessionEvent } from '../../context-types.ts'
import {
  abortedPlanCallIdsOf,
  planBodyOf,
  PLAN_EXIT_TOOL,
} from '../../plan-events.ts'
import { resultIsError, type ToolResultMessageLike } from '../changes/ops.ts'

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

/**
 * The first markdown heading of any level — the same rule the host's review
 * card uses for its title, so the page and the chat card name a plan alike. */
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
  // The abort lands on the result, after the call row, so the exclusion runs
  // over the whole window before the fold.
  const aborted = abortedPlanCallIdsOf(events)
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
      if (data.name !== PLAN_EXIT_TOOL || typeof data.callId !== 'string') continue
      // A repeated row (the wire window can overlap across polls) must never
      // reset a settled revision: the FIRST sighting of a call owns the entry.
      if (byCall.has(data.callId)) continue
      if (aborted.has(data.callId)) continue
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
      byCall.set(callId, {
        ...plan,
        status: resultIsError(message) ? 'unadopted' : 'approved',
        settledTime: event.time,
      })
    }
  }
  return [...byCall.values()].sort((a, b) => a.seq - b.seq)
}
