/**
 * The live-preview route of the Subagent page ('subagents.live'): one
 * request per refresh instead of N per-child `subagents.history` calls.
 *
 * The route takes the already-resolved topology root (`rootSessionId`),
 * enumerates the whole descendant tree ONCE through the host subagent
 * runtime (`ctx.get('subagents')` / `listDescendants`), and folds EVERY child
 * session's newest process range with {@link foldProcess} — the plugin's port
 * of the main agent's merged process summary (category counts + the one
 * running call + its detail). It never touches DSH source and never reads the
 * model's `job_output` cursor.
 *
 * Folding a settled child is cheap by construction: the default fold stops at
 * the first range boundary it can report, so a child that is idle between
 * turns costs a handful of event reads (`snapshotEvents()` itself returns the
 * session's cached frozen snapshot, not a per-call copy).
 *
 * Degradation contract:
 * - `ctx.get('subagents')` missing or `listDescendants` failure → 503 (the
 *   Subagent page has no topology to show in such deployments anyway).
 * - One child's events missing/corrupt → that child is still REPORTED (its
 *   `running` flag is the catalog's), just without a summary; the rest of the
 *   batch is unaffected.
 */
import type {
  Context,
  SidebarChildLiveView,
  SidebarSubagentsService,
} from './context-types.ts'
import { SIDE_LABEL_PREFIX } from './sidechat-core.ts'
import { foldProcess } from './process-activity.ts'
import { requireString, SidebarError } from './wire.ts'

/** The live-preview routes of the /sidebar JSON API. */
export interface SidebarSubagentLiveRoutes {
  /**
   * Fold one tree's subagent activity into a compact live map.
   * @param payload - `{ rootSessionId }`.
   * @returns `{ live: Record<sessionId, SidebarChildLiveView> }` over the
   *   whole descendant catalog plus the topology root.
   */
  live(payload: unknown): Promise<{ live: Record<string, SidebarChildLiveView> }>
}

/**
 * Build the live-preview routes bound to the plugin context.
 * @param ctx - host plugin context.
 */
export function buildSubagentLiveApi(ctx: Context): SidebarSubagentLiveRoutes {
  return {
    async live(payload) {
      const rootSessionId = requireString(payload, 'rootSessionId')
      const subagents = ctx.get('subagents') as SidebarSubagentsService | undefined
      if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
        throw new SidebarError(
          'subagents-unavailable',
          'the subagent service is not mounted in this deployment',
          503,
        )
      }
      let descendants
      try {
        descendants = await subagents.listDescendants(rootSessionId)
      } catch (error) {
        throw new SidebarError(
          'subagents-unavailable',
          `subagent catalog read failed: ${error instanceof Error ? error.message : String(error)}`,
          503,
        )
      }

      const live: Record<string, SidebarChildLiveView> = {}
      /**
       * Fold one session into the map. `running` is the caller-visible activity
       * flag: the catalog's for a child, undefined for the topology ROOT (the
       * host cannot classify it, and the page already knows the answer from the
       * session list). The fold's own `live` gate is that flag when it exists,
       * and the LOG's evidence for the root.
       */
      const foldInto = (sessionId: string, running: boolean | undefined): void => {
        const view: SidebarChildLiveView = running === undefined ? {} : { running }
        try {
          const events = ctx.sessions.get(sessionId)?.snapshotEvents() ?? []
          const fold = foldProcess(events, { live: running !== false })
          if (fold.current.counts.length > 0 || fold.current.running !== undefined) {
            view.summary = fold.current
          }
          if (fold.text !== undefined) view.text = fold.text
          if (fold.lastEventTime !== undefined) view.lastEventTime = fold.lastEventTime
        } catch {
          // One session's event log is not readable: keep the row (a child's
          // running flag is the catalog's) and skip only its details.
        }
        live[sessionId] = view
      }

      foldInto(rootSessionId, undefined)
      for (const entry of descendants) {
        if (entry.kind !== 'child') continue
        // Side Chat threads ride the subagent origin but are sidebar tabs,
        // never topology — keep them out of the live map too.
        if (entry.label?.startsWith(SIDE_LABEL_PREFIX) ?? false) continue
        foldInto(entry.id, entry.activity === 'running')
      }
      return { live }
    },
  }
}
