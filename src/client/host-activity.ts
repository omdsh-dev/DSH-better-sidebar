/** Idle means no live host job and no running direct subagent (Side Chat excluded). */
import type { SidebarJobView, SidebarSessionList } from '../context-types.ts'
import { isSideThreadSummary } from './subagent-lineage.ts'
import { isJobLive } from './subagent-jobs.ts'

/** Read the same session/job feeds used by background auto-activation. */
export function isSessionActivityIdle(
  list: SidebarSessionList,
  sessionId: string,
  jobs: readonly SidebarJobView[] = [],
): boolean {
  if (jobs.some(isJobLive)) return false
  return !Object.values(list.byId).some(summary =>
    summary.origin === 'subagent' && summary.parentId === sessionId
    && !isSideThreadSummary(summary) && summary.running === true)
}
