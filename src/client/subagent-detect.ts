/**
 * Pure subagent-membership helpers over the sessions list feed (structural
 * mirror world — no runtime imports). Used by the sidebar's auto-activation
 * effect and the Subagent page:
 *
 * - {@link directSubagentCount}: direct durable children of one session,
 * - {@link detectNewDirectSubagent}: the 0 → N transition that means "a new
 *   subagent just spawned under the current session" (the auto-open trigger),
 * - {@link countSubagentDescendants}: uninterrupted subagent-origin lineage
 *   totals (mirror of the official `indexSubagentDescendants` over the
 *   plugin's own summary rows).
 */
import type {
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentCatalog,
} from '../context-types.ts'
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

/** Count the direct subagent children of one session (durable `origin` rows). */
export function directSubagentCount(
  byId: SidebarSessionList['byId'],
  sessionId: string,
): number {
  let count = 0
  for (const summary of Object.values(byId)) {
    if (summary.origin === 'subagent' && summary.parentId === sessionId
      && !isSideThreadSummary(summary)) count += 1
  }
  return count
}

/**
 * Collect the ids of direct subagent children of one session, excluding Side
 * Chat threads. Stable under the same `isSideThreadSummary` filter as the
 * count helper.
 * @param byId - session map from the list snapshot.
 * @param sessionId - parent session whose children are collected.
 * @returns set of direct subagent session ids.
 */
export function directSubagentIds(
  byId: SidebarSessionList['byId'],
  sessionId: string,
): Set<string> {
  const ids = new Set<string>()
  for (const summary of Object.values(byId)) {
    if (summary.origin === 'subagent' && summary.parentId === sessionId
      && !isSideThreadSummary(summary)) ids.add(summary.id)
  }
  return ids
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
  const seen = new Set<string>()
  let current: SidebarSessionSummary | undefined = byId[sessionId]
  while (current !== undefined && current.origin === 'subagent'
    && current.parentId !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    current = byId[current.parentId]
  }
  return current?.id ?? sessionId
}

/**
 * Collect every catalog branch (an entry with `hasChildren`) reachable from
 * the root — the set of catalogs the always-expanded topology consumes.
 * Cycles fail soft.
 */
export function collectBranchIds(
  catalogs: Readonly<Record<string, SidebarSubagentCatalog>>,
  rootId: string | undefined,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (parentId: string): void => {
    if (seen.has(parentId)) return
    seen.add(parentId)
    for (const entry of catalogs[parentId]?.entries ?? []) {
      if (entry.kind === 'child' && entry.hasChildren) {
        out.push(entry.id)
        visit(entry.id)
      }
    }
  }
  if (rootId !== undefined) visit(rootId)
  return out
}

/**
 * Whether a new direct subagent appeared under `sessionId` between two
 * consecutive list snapshots. Triggers when any direct subagent id present
 * in `next` was absent in `prev` (per-id diff, matching `detectNewJob`).
 * Side Chat threads (`Side: ` prefix) are excluded, and switching to a
 * session that already has subagents yields false until a genuinely new id
 * arrives.
 * @param prev - previous list snapshot.
 * @param next - next list snapshot.
 * @param sessionId - parent session to inspect.
 * @returns true when a new direct subagent id appeared.
 */
export function detectNewDirectSubagent(
  prev: SidebarSessionList,
  next: SidebarSessionList,
  sessionId: string,
): boolean {
  const prevIds = directSubagentIds(prev.byId, sessionId)
  for (const summary of Object.values(next.byId)) {
    if (summary.origin !== 'subagent' || summary.parentId !== sessionId) continue
    if (isSideThreadSummary(summary)) continue
    if (!prevIds.has(summary.id)) return true
  }
  return false
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
    const seen = new Set<string>()
    let current: SidebarSessionSummary | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined
      && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.parentId === sessionId) {
        totals.count += 1
        if (descendant.running === true) totals.runningCount += 1
        break
      }
      current = byId[current.parentId]
    }
  }
  return totals
}
