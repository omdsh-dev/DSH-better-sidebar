/**
 * Pure "has this session's background activity settled?" predicate over the
 * sessions list feed (structural mirror world — no runtime imports). The
 * auto-open triggers (./sidebar/use-host-feeds.ts) pop the Tasks page when a
 * subagent or a background job APPEARS; the opt-in auto-collapse uses this to
 * decide when the activity that opened it is over.
 *
 * A conversation is idle when every background job the host reports for it has
 * settled AND no direct subagent child of it is still running. Both halves are
 * deliberately conservative about what counts as busy: only an explicit
 * `status: 'running' | 'stopping'` job and an explicit `running === true`
 * child (or a catalog row with `activity: 'running'`) do. A feed that never
 * reports the field therefore reads as idle, which is the safe direction for a
 * feature whose entire job is to hand the column back — anything the host DOES
 * report stays authoritative. Side Chat threads are not subagents (see
 * `isSideThreadSummary`), so a thread the user is chatting in never holds the
 * column open.
 *
 * Scope note: this looks at ONE session — the conversation the auto-open
 * triggers act on, whose own jobs and direct children are exactly what pops its
 * Tasks page. A running child's own jobs are covered by the child's `running`
 * flag, and deeper lineage is covered by its branch's own auto-open.
 */
import type { SidebarSessionList } from '../context-types.ts'
import { isSideThreadSummary } from './subagent-lineage.ts'

/**
 * Whether `sessionId` has no running subagent and no live background job.
 * @param list - the client session list snapshot (jobs mirror included).
 * @param sessionId - the conversation to inspect.
 * @returns `true` when nothing is left running for that conversation.
 */
export function isSessionActivityIdle(
  list: SidebarSessionList,
  sessionId: string,
): boolean {
  for (const job of list.jobsBySession?.[sessionId] ?? []) {
    if (job.status === 'running' || job.status === 'stopping') return false
  }
  for (const summary of Object.values(list.byId)) {
    if (summary.origin !== 'subagent' || summary.parentId !== sessionId) continue
    if (isSideThreadSummary(summary)) continue
    if (summary.running === true) return false
  }
  for (const entry of list.subagentsByParent?.[sessionId]?.entries ?? []) {
    if (entry.kind === 'child' && entry.activity === 'running') return false
  }
  return true
}
