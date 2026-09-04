/**
 * The shared subagent-lineage walks over the sessions list feed (structural
 * mirror world — no runtime imports). Every public walk here answers a
 * topology question by following the DURABLE subagent-origin chain upward
 * (child → parent → …); one private generator ({@link subagentOriginChain})
 * is the single implementation of that walk, seen-set guarded so cycles fail
 * soft (the walk just stops; nothing throws).
 *
 * subagent-detect.ts and subagent-jobs.ts re-export these for their
 * established import sites — the auto-activation triggers and the Subagent
 * page both consume them through the original module paths.
 */
import type { SidebarSessionList, SidebarSessionSummary } from '../context-types.ts'
import { SIDE_LABEL_PREFIX } from '../sidechat-core.ts'

/**
 * Side Chat threads ride the subagent origin (main-list hiding + the RPC
 * ownership fence) but they are NOT subagent topology: they carry the
 * durable 'Side: ' label and live as sidebar tabs. Excluding them here
 * keeps the auto-open trigger and the Subagent page counts clean.
 */
export function isSideThreadSummary(summary: SidebarSessionSummary): boolean {
  return summary.origin === 'subagent' && summary.displayTitle.startsWith(SIDE_LABEL_PREFIX)
}

/**
 * Yield `start`'s uninterrupted subagent-origin chain upward: each summary
 * while it is a subagent with a known parent, then its parent row, and so
 * on. A revisited id ends the walk (cycles fail soft); the row that BREAKS
 * the chain — the first non-subagent ancestor, or a parent id with no row —
 * is deliberately NOT yielded: callers observe it through where the walk
 * stopped (the row after the last yielded one is `byId[last.parentId]`).
 */
function* subagentOriginChain(
  byId: SidebarSessionList['byId'],
  start: SidebarSessionSummary,
): Generator<SidebarSessionSummary> {
  const seen = new Set<string>()
  let current: SidebarSessionSummary | undefined = start
  while (current?.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    yield current
    current = byId[current.parentId]
  }
}

/**
 * The main agent of the current session's tree: walk the durable parent
 * chain upward until the first non-subagent session. The Subagent page shows
 * THIS root's full topology regardless of how deep the current selection is
 * (a session whose row is still hydrating, or a broken chain, degrades to
 * the session itself).
 */
export function rootAncestor(
  byId: SidebarSessionList['byId'],
  sessionId: string | undefined,
): string | undefined {
  if (sessionId === undefined) return undefined
  const start = byId[sessionId]
  // A hydrating (or unknown) row degrades to the session itself.
  if (start === undefined) return sessionId
  let last: SidebarSessionSummary | undefined
  for (const node of subagentOriginChain(byId, start)) last = node
  if (last === undefined) return start.id
  // The walk stopped one row past the last chain node: that parent row is
  // the root (still missing from the feed → the session itself). Every
  // yielded node carries a parent id (the generator's walk condition).
  return byId[last.parentId!]?.id ?? sessionId
}

/** Descendant totals of one session through an uninterrupted subagent-origin chain. */
export interface SubagentDescendantTotals {
  count: number
  runningCount: number
}

/**
 * Index every subagent descendant under each ancestor it reaches through an
 * uninterrupted subagent-origin chain (same semantics as the official
 * `indexSubagentDescendants`; cycles fail soft).
 */
export function countSubagentDescendants(
  byId: SidebarSessionList['byId'],
  sessionId: string,
): SubagentDescendantTotals {
  const totals: SubagentDescendantTotals = { count: 0, runningCount: 0 }
  for (const descendant of Object.values(byId)) {
    if (descendant.origin !== 'subagent' || isSideThreadSummary(descendant)) continue
    for (const node of subagentOriginChain(byId, descendant)) {
      if (node.parentId === sessionId) {
        totals.count += 1
        if (descendant.running === true) totals.runningCount += 1
        break
      }
    }
  }
  return totals
}

/**
 * Every session id of the topology tree rooted at `rootId` (the root plus
 * each session whose uninterrupted subagent-origin chain reaches it — same
 * lineage semantics as {@link countSubagentDescendants}; cycles fail soft).
 * Sessions outside the tree (orphans, other trees) are excluded, so the
 * jobs section never shows foreign work.
 */
export function treeSessionIds(
  byId: SidebarSessionList['byId'],
  rootId: string | undefined,
): Set<string> {
  const ids = new Set<string>()
  // A root with no row in the feed cannot be reached by walking: only real
  // rows anchor tree membership (a parent pointer naming a hydrating root
  // does not pull the orphaned branch into the tree).
  if (rootId === undefined || byId[rootId] === undefined) return ids
  for (const summary of Object.values(byId)) {
    // The root row itself belongs to its own tree even though it is not a
    // subagent (it is usually the main agent).
    if (summary.id === rootId) {
      ids.add(summary.id)
      continue
    }
    for (const node of subagentOriginChain(byId, summary)) {
      if (node.parentId === rootId) {
        ids.add(summary.id)
        break
      }
    }
  }
  return ids
}
