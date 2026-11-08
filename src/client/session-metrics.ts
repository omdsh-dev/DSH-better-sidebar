/**
 * The Tasks page's per-session METRICS: how much a node consumed (tokens) and
 * how long it actually worked (its own turn timing) — the two facts the node
 * detail popover adds beside the state.
 *
 * Both come from the host's session projections, which the client publishes in
 * `SessionListState.projectionsBySession` (see the mirror in
 * ../context-types.ts). This module is the pure adapter between that snapshot
 * and the shape the view model carries, plus the two display rules, so the
 * popover never re-derives them:
 *
 * - **Tokens** are a session TOTAL in four disjoint buckets. The reader wants
 *   one number plus a breakdown, so {@link totalTokens} sums them (input
 *   buckets + output) and {@link inputTokens} keeps the billed-input half.
 * - **Duration** is `settledMs` (closed turns) plus the live part of an open
 *   turn. `active.through` only advances when an event commits, so a running
 *   node's elapsed time is measured to `Date.now()` and refreshed by the page's
 *   own poll — never by a timer of this module's own.
 *
 * Everything degrades silently: a session with no events, a host without the
 * projection, or a key the fold omitted simply reports nothing, and the caller
 * hides the row rather than printing a zero it cannot justify.
 */
import type {
  SidebarProjectionSnapshot,
  SidebarSubagentTiming,
  SidebarTokenUsage,
} from '../context-types.ts'

/** One session's metrics, as the view model carries them on its node. */
export interface SessionMetrics {
  usage?: SidebarTokenUsage
  timing?: SidebarSubagentTiming
}

/** The billed input tokens: every bucket that is not output. */
export function inputTokens(usage: SidebarTokenUsage): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** The session's total tokens (input buckets + output). */
export function totalTokens(usage: SidebarTokenUsage): number {
  return inputTokens(usage) + usage.outputTokens
}

/**
 * The node's elapsed working time in ms, or undefined when the host published
 * no timing for it.
 *
 * @param timing - the session's `subagentTiming`.
 * @param now - the clock the caller's render is pinned to.
 */
export function elapsedMs(timing: SidebarSubagentTiming | undefined, now: number): number | undefined {
  if (timing === undefined) return undefined
  const active = timing.active === undefined ? 0 : Math.max(0, now - timing.active.since)
  const total = timing.settledMs + active
  // 0 means "no closed turn and no open one" — the projection's init state,
  // which is indistinguishable from "this session never worked". Show nothing.
  return total > 0 ? total : undefined
}

/**
 * Fold the projection snapshot into one metrics row per session.
 *
 * Sessions the snapshot does not carry are simply absent (the page's own poll
 * fills them in), and a session carrying neither key is omitted so the caller's
 * map stays small.
 *
 * @param projections - `SessionListState.projectionsBySession`.
 */
export function sessionMetrics(
  projections: Readonly<Record<string, SidebarProjectionSnapshot>> | undefined,
): Readonly<Record<string, SessionMetrics>> {
  const out: Record<string, SessionMetrics> = {}
  for (const [sessionId, snapshot] of Object.entries(projections ?? {})) {
    const usage = snapshot.values.tokenUsage
    const timing = snapshot.values.subagentTiming
    if (usage === undefined && timing === undefined) continue
    out[sessionId] = {
      ...(usage === undefined ? {} : { usage }),
      ...(timing === undefined ? {} : { timing }),
    }
  }
  return out
}
