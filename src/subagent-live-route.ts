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
import type {
  Context,
  SidebarSessionEvent,
  SidebarSessionPersistenceService,
  SidebarSubagentsService,
} from './context-types.ts'
import { SIDE_LABEL_PREFIX } from './sidechat-core.ts'
import { lastActivity, type LastActivity } from './subagent-activity.ts'
import { requireString, SidebarError } from './wire.ts'

/** The live-preview routes of the /sidebar JSON API. */
export interface SidebarSubagentLiveRoutes {
  /**
   * Fold one tree's running subagent histories into a compact live map
   * and resolve active model names for sessions in the tree.
   * @param payload - `{ rootSessionId }`.
   * @returns `{ live, models }`.
   */
  live(payload: unknown): Promise<{
    live: Record<string, LastActivity>
    models: Record<string, string>
  }>
}

/**
 * The recent-message window of the live preview: only the last 12 surface
 * messages of a child's log are folded, matching the old per-card
 * `subagents.history({ maxMessages: 12 })` window. Keeps stale tool calls
 * out of the preview and bounds the backward scan per child.
 */
export const LIVE_WINDOW_MESSAGES = 12

/**
 * Scan session events backwards to find the active model name.
 */
export function extractModelFromEvents(events: readonly SidebarSessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type === 'request/header') {
      const model = (event as { data?: { header?: { config?: { model?: unknown } } } }).data?.header?.config?.model
      if (typeof model === 'string' && model !== '') return model
    }
    if (event.type === 'request/context') {
      const model = (event as { data?: { model?: unknown } }).data?.model
      if (typeof model === 'string' && model !== '') return model
    }
    if (event.type === 'model/selection') {
      const data = (event as { data?: { model?: unknown; next?: { model?: unknown }; lastUsed?: { model?: unknown } } }).data
      const model = data?.model ?? data?.next?.model ?? data?.lastUsed?.model
      if (typeof model === 'string' && model !== '') return model
    }
    if (event.type === 'subagent/descriptor') {
      const model = (event as { data?: { agentModel?: unknown } }).data?.agentModel
      if (typeof model === 'string' && model !== '') return model
    }
  }
  return undefined
}

/** Resolve the effective model name of a session from live runtime or persistence. */
async function resolveSessionModel(ctx: Context, sessionId: string): Promise<string | undefined> {
  // 1. Live agent options
  try {
    const agents = ctx.get('agents') as { get(id: string): { options?: { model?: unknown } } | undefined } | undefined
    const agentModel = agents?.get(sessionId)?.options?.model
    if (typeof agentModel === 'string' && agentModel !== '') return agentModel
  } catch {
    // Live agent lookup might fail or be absent
  }

  // 2. Live session requestHeader, requestContext, or snapshotEvents
  try {
    const session = ctx.sessions?.get(sessionId) as {
      requestHeader?: () => { config?: { model?: unknown } } | undefined
      requestContext?: () => { model?: unknown } | undefined
      snapshotEvents?: () => readonly SidebarSessionEvent[]
    } | undefined
    const headerModel = session?.requestHeader?.()?.config?.model
    if (typeof headerModel === 'string' && headerModel !== '') return headerModel
    const contextModel = session?.requestContext?.()?.model
    if (typeof contextModel === 'string' && contextModel !== '') return contextModel
    const events = session?.snapshotEvents?.()
    if (events !== undefined && events.length > 0) {
      const eventModel = extractModelFromEvents(events)
      if (eventModel !== undefined) return eventModel
    }
  } catch {
    // In-memory session lookup might fail
  }

  // 3. Cold session persistence
  try {
    const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
    if (persistence !== undefined && typeof persistence.inspect === 'function') {
      const inspected = await persistence.inspect(sessionId)
      const eventModel = extractModelFromEvents(inspected.events)
      if (eventModel !== undefined) return eventModel
    }
  } catch {
    // Session not found in persistence or service absent
  }

  return undefined
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

      const live: Record<string, LastActivity> = {}
      const sessionIds = new Set<string>([rootSessionId])

      for (const entry of descendants) {
        if (entry.kind !== 'child') continue
        // Side Chat threads ride the subagent origin but are sidebar tabs,
        // never topology — keep them out of both live map and topology models.
        if (entry.label?.startsWith(SIDE_LABEL_PREFIX) ?? false) continue

        sessionIds.add(entry.id)
        // Same gate the client renders cards on: only catalog-running
        // children get live lines (spec: "仅对 running 且非 Side Chat").
        if (entry.activity === 'running') {
          try {
            const activity = lastActivity(
              ctx.sessions.get(entry.id)?.snapshotEvents() ?? [],
              LIVE_WINDOW_MESSAGES,
            )
            if (activity.text !== undefined || activity.tool !== undefined) {
              live[entry.id] = activity
            }
          } catch {
            // One child's event log is not readable: skip only that child.
          }
        }
      }

      const models: Record<string, string> = {}
      await Promise.all(
        Array.from(sessionIds).map(async (id) => {
          try {
            const model = await resolveSessionModel(ctx, id)
            if (model !== undefined) {
              models[id] = model
            }
          } catch {
            // Ignore error for individual session
          }
        }),
      )

      return { live, models }
    },
  }
}
