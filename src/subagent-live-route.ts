/**
 * The live-preview route of the Subagent page ('subagents.live'): one
 * request per refresh instead of N per-child `subagents.history` calls.
 *
 * The route takes the already-resolved topology root (`rootSessionId`),
 * enumerates the whole descendant tree ONCE through the host subagent
 * runtime (`ctx.get('subagents')` / `listDescendants`), keeps only rows the
 * catalog reports running (`activity: 'running'` — the same gate the client
 * renders cards on), and folds the newest text/tool activity from each
 * child's attached session event log. It never touches DSH source and never
 * reads the model's `job_output` cursor.
 *
 * Degradation contract:
 * - `ctx.get('subagents')` missing or `listDescendants` failure → 503 (the
 *   Subagent page has no topology to show in such deployments anyway).
 * - One child's events missing/corrupt → that child is skipped, the rest of
 *   the batch still returns.
 */
import type { Context, SidebarSubagentsService } from './context-types.ts'
import { SIDE_LABEL_PREFIX } from './sidechat-core.ts'
import { lastActivity, type LastActivity } from './subagent-activity.ts'
import { requireString, SidebarError } from './wire.ts'

/** The live-preview routes of the /sidebar JSON API. */
export interface SidebarSubagentLiveRoutes {
  /**
   * Fold one tree's running subagent histories into a compact live map.
   * @param payload - `{ rootSessionId }`.
   * @returns `{ live: Record<childSessionId, LastActivity> }`; children with
   *   no text/tool yet are omitted.
   */
  live(payload: unknown): Promise<{ live: Record<string, LastActivity> }>
}

/**
 * The recent-message window of the live preview: only the last 12 surface
 * messages of a child's log are folded, matching the old per-card
 * `subagents.history({ maxMessages: 12 })` window. Keeps stale tool calls
 * out of the preview and bounds the backward scan per child.
 */
export const LIVE_WINDOW_MESSAGES = 12

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

      const live: Record<string, LastActivity> = {}
      for (const entry of descendants) {
        // Same gate the client renders cards on: only catalog-running
        // children get live lines (spec: "仅对 running 且非 Side Chat").
        if (entry.kind !== 'child' || entry.activity !== 'running') continue
        // Side Chat threads ride the subagent origin but are sidebar tabs,
        // never topology — keep them out of the live map too.
        if (entry.label?.startsWith(SIDE_LABEL_PREFIX) ?? false) continue
        try {
          const activity = lastActivity(
            ctx.sessions.get(entry.id)?.events ?? [],
            LIVE_WINDOW_MESSAGES,
          )
          if (activity.text !== undefined || activity.tool !== undefined) {
            live[entry.id] = activity
          }
        } catch {
          // One child's event log is not readable: skip only that child.
        }
      }
      return { live }
    },
  }
}
