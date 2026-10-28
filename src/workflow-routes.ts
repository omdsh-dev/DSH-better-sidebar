/**
 * The workflow-runs route of the /sidebar JSON API ('workflows.list'). DSH
 * keeps workflow runs holder-owned and process-local — there is NO service
 * registry, NO HTTP route, and NO persistence for them (`dsh-workflow`
 * README: "Runs are holder-owned, not service-tracked"). The one durable
 * observation surface is the session event log: `dsh-tool-workflow`'s
 * recorder appends four `tool-workflow/*` event types to the calling agent's
 * session (top-level runs only), which is exactly what the official
 * `dsh-client-ui-workflow-run` panel folds in the browser.
 *
 * This route folds the SAME events server-side for every session of the
 * current tree (the root plus its subagent descendants), so the Tasks page
 * can hang run nodes under the agent that started them. Like the job-output
 * replay it merges the store's event log with a live `session/event` mirror
 * (deduped by seq), because the store session can lag the live append feed
 * after a host restart. Zero DSH writes; the runs of a deployment that never
 * uses the workflow tool simply never produce events and the route returns
 * an empty list (no error — absence is the normal case, not a failure).
 */
import type { Context, SidebarSessionEvent, SidebarSubagentsService } from './context-types.ts'
import { foldWorkflowRuns, type WorkflowRunView } from './workflow-runs.ts'
import { requireString } from './wire.ts'

/** The workflow-runs route of the sidebar API. */
export interface SidebarWorkflowRoutes {
  /**
   * Fold the workflow runs of every session in one tree.
   * @param payload - `{ rootSessionId }`.
   * @returns `{ runs: WorkflowRunView[] }`, oldest run first; empty when the
   *   tree never ran a workflow (or the DSH version predates the recorder).
   */
  list(payload: unknown): Promise<{ runs: WorkflowRunView[] }>
}

/** Per-session cap of mirrored live workflow events (a bounded, lossy ring). */
const MIRROR_MAX_ENTRIES = 500

/**
 * The live workflow-event mirror: subscribes to the session append feed and
 * caches `tool-workflow/*` rows the session store's own log can lag behind
 * (the same rehydration-boundary gap the job-output mirror exists for).
 */
function createWorkflowEventMirror(ctx: Context): { entries(sessionId: string): readonly SidebarSessionEvent[] } {
  const perSession = new Map<string, SidebarSessionEvent[]>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API degrade to seed-only folding.
    return { entries: () => [] }
  }
  const dispose = ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string' || !event.type.startsWith('tool-workflow/')) return
    let list = perSession.get(sessionId)
    if (list === undefined) perSession.set(sessionId, list = [])
    // The vendored cordis `on` overload wins over the plugin's string-keyed
    // one and types the event as the rich SessionEvent union; the mirror
    // only ever needs the minimal structural slice, so restate it here.
    const minimal: SidebarSessionEvent = {
      type: event.type,
      seq: event.seq,
      time: event.time,
      data: event.data as Record<string, unknown>,
    }
    list.push(minimal)
    if (list.length > MIRROR_MAX_ENTRIES) {
      list.splice(0, list.length - MIRROR_MAX_ENTRIES)
    }
  })
  ctx.effect(() => dispose, 'dsh-better-sidebar: workflow event mirror')
  return { entries: (sessionId) => perSession.get(sessionId) ?? [] }
}

/**
 * Build the workflow-runs route bound to the plugin context. The tree walk
 * reuses the host subagent runtime (`ctx.get('subagents')`); without it the
 * route still folds the root session alone (a degraded but honest tree of
 * one), matching the Subagent page's own fallback lineage.
 * @param ctx - host plugin context.
 */
/** One session's folded runs, keyed by the exact input window they came from. */
interface RunCacheEntry {
  /** Store log length when the fold ran. */
  length: number
  /** Store log's last event seq when the fold ran (-1 for an empty log). */
  lastSeq: number
  /** Live-mirror length when the fold ran. */
  mirrorLength: number
  /** Live mirror's last seq when the fold ran (-1 for an empty mirror). */
  mirrorLastSeq: number
  runs: WorkflowRunView[]
}

export function buildWorkflowsApi(ctx: Context): SidebarWorkflowRoutes {
  const mirror = createWorkflowEventMirror(ctx)
  /**
   * Per-session fold cache.
   *
   * The store log is append-only and the mirror is a bounded ring, so
   * `(length, last seq)` of both identifies the exact input the previous fold
   * saw. A settled session's runs never change, yet every 5 s poll re-read and
   * re-folded every session of the tree. Entries are pruned to the tree being
   * reported so a session that leaves it stops being retained.
   */
  const folds = new Map<string, RunCacheEntry>()
  /** The tree's session ids: the root plus every descendant the catalog knows. */
  const treeSessionIds = async (rootSessionId: string): Promise<string[]> => {
    const subagents = ctx.get('subagents') as SidebarSubagentsService | undefined
    if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
      return [rootSessionId]
    }
    try {
      const descendants = await subagents.listDescendants(rootSessionId)
      return [rootSessionId, ...descendants.map(entry => entry.id)]
    } catch {
      // The catalog read failed (stale root, deployment seam missing): the
      // root session alone still yields its own runs.
      return [rootSessionId]
    }
  }
  return {
    async list(payload) {
      const rootSessionId = requireString(payload, 'rootSessionId')
      const ids = await treeSessionIds(rootSessionId)
      const tree = new Set(ids)
      for (const key of folds.keys()) if (!tree.has(key)) folds.delete(key)
      const runs: WorkflowRunView[] = []
      for (const sessionId of ids) {
        try {
          const stored = ctx.sessions.get(sessionId)?.snapshotEvents() ?? []
          const mirrored = mirror.entries(sessionId)
          const length = stored.length
          const lastSeq = length === 0 ? -1 : stored[length - 1]!.seq
          const mirrorLength = mirrored.length
          const mirrorLastSeq = mirrorLength === 0 ? -1 : mirrored[mirrorLength - 1]!.seq
          const cached = folds.get(sessionId)
          if (cached !== undefined
            && cached.length === length
            && cached.lastSeq === lastSeq
            && cached.mirrorLength === mirrorLength
            && cached.mirrorLastSeq === mirrorLastSeq) {
            runs.push(...cached.runs)
            continue
          }
          // Merge the store's event log with the live mirror, deduped by
          // seq — an event mirrored live AND already stored never
          // double-folds.
          const bySeq = new Map<number, SidebarSessionEvent>()
          for (const event of stored) {
            if (event.type.startsWith('tool-workflow/')) bySeq.set(event.seq, event)
          }
          for (const event of mirrored) bySeq.set(event.seq, event)
          const ordered = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
          const folded = bySeq.size === 0 ? [] : foldWorkflowRuns(ordered, sessionId)
          folds.set(sessionId, { length, lastSeq, mirrorLength, mirrorLastSeq, runs: folded })
          runs.push(...folded)
        } catch {
          // One session's log is not readable/foldable: skip only it.
        }
      }
      runs.sort((left, right) => left.startedSeq - right.startedSeq)
      return { runs }
    },
  }
}
