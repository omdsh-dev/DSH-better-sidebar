/**
 * The Tasks page's read of the HOST's client jobs service (`ctx.jobs`).
 *
 * The plugin used to carry its own three-route jobs transport: a per-session
 * `jobs.list` fan-out every 3s, a `job_output` trace replayed from the owner
 * session's event log (the registry's only read is the model's CONSUMING
 * cursor, which a human pane must never move), and a kill passthrough. The
 * host service replaces all three — and this module is the whole data layer of
 * that swap, kept apart from the DRAWER so the auto-open trigger in
 * `sidebar/use-host-feeds.ts` reads the same feed the page renders.
 *
 * Structural detection only (the plugin never imports the host package): a
 * deployment without the service sees `undefined` and renders no jobs surface.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SidebarSessionList } from '../context-types.ts'
import type {
  Context,
  SidebarClientJobsService,
  SidebarJobsSnapshot,
} from '../context-types.ts'
import { type TreeJob } from './subagent-jobs.ts'

/** The empty snapshot a deployment without the jobs service reads. */
const EMPTY_JOBS: SidebarJobsSnapshot = { rows: {}, observed: {} }

/**
 * The client jobs service, when this deployment mounts the host jobs UI.
 * @param ctx - the client context.
 */
export function clientJobs(ctx: Context): SidebarClientJobsService | undefined {
  const service = ctx.get('jobs') as SidebarClientJobsService | undefined
  if (service === undefined) return undefined
  if (typeof service.watchRows !== 'function' || typeof service.observe !== 'function') return undefined
  if (typeof service.kill !== 'function' || service.state === undefined) return undefined
  return service
}

/**
 * Subscribe to the jobs snapshot (roster + observations).
 * @param jobs - the client jobs service (absent → an empty snapshot forever).
 */
export function useJobsSnapshot(jobs: SidebarClientJobsService | undefined): SidebarJobsSnapshot {
  const subscribe = useMemo(
    () => (callback: () => void) => (jobs === undefined ? () => {} : jobs.state.subscribe(callback)),
    [jobs],
  )
  const read = useCallback(() => (jobs === undefined ? EMPTY_JOBS : jobs.state.getSnapshot()), [jobs])
  return useSyncExternalStore(subscribe, read)
}

/**
 * Watch (and release) one roster per session, while the page is on screen. The
 * host shares a single stream between watchers of one session, so this is
 * cheap; the key is the joined id list so a re-render with the same tree does
 * not re-subscribe.
 * @param jobs - the client jobs service.
 * @param sessionIds - the tree's sessions (the root included).
 * @param active - whether the page is visible at all.
 */
export function useJobWatchers(
  jobs: SidebarClientJobsService | undefined,
  sessionIds: readonly string[],
  active: boolean,
): void {
  const key = sessionIds.join(',')
  useEffect(() => {
    if (jobs === undefined || !active || key === '') return
    const releases = key.split(',').map(sessionId => jobs.watchRows(sessionId))
    return () => {
      for (const release of releases) release()
    }
  }, [jobs, key, active])
}

/**
 * Observe ONE job's output while its panel is open; the release runs on close.
 * @param jobs - the client jobs service.
 * @param ownerSessionId - the session the roster carried the job under.
 * @param jobId - the observed job (undefined closes the observation).
 */
export function useJobObservation(
  jobs: SidebarClientJobsService | undefined,
  ownerSessionId: string | undefined,
  jobId: string | undefined,
): void {
  useEffect(() => {
    if (jobs === undefined || jobId === undefined) return
    return jobs.observe(ownerSessionId, jobId)
  }, [jobs, ownerSessionId, jobId])
}

/**
 * One job's rows as the drawer renders them, deduped across the tree.
 *
 * An UNOWNED job is visible to every watched session, so the union of rosters
 * repeats it: rows are keyed by job id and attributed to the watched session
 * whose roster carried them (which is also the session the observation and the
 * kill go through). Jobs owned by a session outside the tree are dropped.
 *
 * @param snapshot - the client service snapshot.
 * @param byId - the session mirror (owner labels).
 * @param treeIds - the tree's session ids (root included).
 */
export function collectRows(
  snapshot: SidebarJobsSnapshot,
  byId: SidebarSessionList['byId'],
  treeIds: ReadonlySet<string>,
): TreeJob[] {
  const rows: TreeJob[] = []
  const seen = new Set<string>()
  for (const [watched, jobs] of Object.entries(snapshot.rows)) {
    for (const job of jobs) {
      if (seen.has(job.id)) continue
      if (job.owner !== undefined && !treeIds.has(job.owner)) continue
      seen.add(job.id)
      rows.push({
        ownerSessionId: watched,
        ownerTitle: byId[job.owner ?? watched]?.displayTitle ?? job.owner ?? watched,
        job,
      })
    }
  }
  return rows
}
