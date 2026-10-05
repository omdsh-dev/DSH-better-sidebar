/**
 * The Agent Teams WRITE routes of the /sidebar JSON API ('teams.taskCreate' /
 * 'teams.taskUpdate').
 *
 * The READ path is deliberately absent. DSH 0.1.7 replaced the 0.1.6 Remote
 * trio (`remoteView` / `remoteCreateTask` / `remoteUpdateTask`, which this
 * plugin's `teams.view` route mirrored) with the Lead Session's `agentTeam`
 * Session projection: the browser already receives it in
 * `SessionListState.projectionsBySession`, so the Tasks page reads the board
 * straight off the shared snapshot (see ./client/team-projection.ts) and no
 * host route, poller or observation handshake is involved. That also removed
 * the only reason this file needed `tryMembership` for reads.
 *
 * What remains cannot be done in the browser: `createTask` / `updateTask`
 * demand the exact live Lead Agent as their authority credential, which only
 * the host holds. The experimental `dsh-experimental-agent-team` service
 * (`ctx.agentTeams`) exists only when the deployment opts in, so the routes
 * degrade structurally:
 *
 * - service absent (`ctx.get('agentTeams')` undefined) → 503 `team-error`
 *   (a mutation can never be accepted there; the page silently hides the
 *   whole Teams block because the projection is absent too, so this is the
 *   belt to that pair of braces);
 * - the tree's root agent is not live in this process (cold session / another
 *   harness) → 404 `team-error`; teams are live-led by definition;
 * - the root leads no team (`tryMembership` miss) → 404 `team-error`.
 *
 * Rejections are THROWN by 0.1.7 (0.1.6 returned a `TeamTaskMutationResult`
 * union), so the CAS conflict has to be translated back into a wire code the
 * client can route on: `TEAM_TASK_STALE_REVISION` → `team-conflict` (409),
 * every other `TeamError` → `team-error` (400). The message is never parsed.
 *
 * Teams are implicit (TeamId ≡ the lead's session id) and every service
 * method demands the live member Agent as its authority token, so the routes
 * re-derive the caller per request (`ctx.agents.get(rootSessionId)`) exactly
 * like the jobs.kill fence. Zero DSH source changes; the plugin never imports
 * the experimental package (structural mirrors only).
 */
import type {
  Context,
  SidebarAgentTeamsService,
  SidebarAgentsService,
  SidebarCreateTeamTaskRequest,
  SidebarTeamTaskMutationResult,
  SidebarUpdateTeamTaskRequest,
} from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

/** The Agent Teams write routes of the sidebar API. */
export interface SidebarTeamsRoutes {
  /** Create one shared task (payload = `{ rootSessionId, ...request }`). */
  taskCreate(payload: unknown): Promise<SidebarTeamTaskMutationResult>
  /** CAS-mutate one shared task (payload = `{ rootSessionId, ...request }`). */
  taskUpdate(payload: unknown): Promise<SidebarTeamTaskMutationResult>
}

/** The CAS actions the wire accepts (mirrors the domain union). */
const TASK_ACTIONS = new Set([
  'claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete',
])

/** The service's stale-revision code (0.1.6 returned it as a result union). */
const STALE_REVISION_CODE = 'TEAM_TASK_STALE_REVISION'

/** Narrow an unknown payload value to a string array (else undefined). */
function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length === value.length ? out : undefined
}

/**
 * The thrown value's `HarnessError` code, when it carries one. Read
 * structurally: the plugin does not import `@deepseek-ai/dsh-llm` for a
 * string, and a non-TeamError rejection simply has no code to route on.
 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Build the Agent Teams write routes bound to the plugin context.
 * @param ctx - host plugin context.
 */
export function buildTeamsApi(ctx: Context): SidebarTeamsRoutes {
  const teams = ctx.get('agentTeams') as SidebarAgentTeamsService | undefined
  const agents = ctx.get('agents') as SidebarAgentsService | undefined

  /**
   * The live lead agent of the requested tree plus its membership check.
   * Throws 503 when the experimental layer is absent and 404 when the root
   * simply leads no team (a normal page state, but never for a mutation).
   */
  const membershipOf = async (
    payload: unknown,
  ): Promise<{ svc: SidebarAgentTeamsService; agent: unknown }> => {
    if (teams === undefined) {
      throw new SidebarError('team-error', 'the agent-teams layer is not mounted in this deployment', 503)
    }
    const rootSessionId = requireString(payload, 'rootSessionId')
    const agent = agents?.get(rootSessionId)
    if (agent === undefined) {
      // The root is not live in this process (cold session / other harness):
      // teams are live-led by definition, so there is nothing to mutate.
      throw new SidebarError('team-error', 'the tree root is not live in this process', 404)
    }
    try {
      if (teams.tryMembership(agent) === undefined) {
        throw new SidebarError('team-error', 'the tree root leads no team', 404)
      }
    } catch (error) {
      if (error instanceof SidebarError) throw error
      throw new SidebarError('team-error', error instanceof Error ? error.message : String(error), 404)
    }
    return { svc: teams, agent }
  }

  /**
   * Translate one service rejection: a stale revision keeps its own wire code
   * so the client's task window can say "someone else changed this task"
   * instead of showing a generic failure.
   */
  const serviceError = (error: unknown): SidebarError => {
    const message = error instanceof Error ? error.message : String(error)
    return errorCodeOf(error) === STALE_REVISION_CODE
      ? new SidebarError('team-conflict', message, 409)
      : new SidebarError('team-error', message, 400)
  }

  return {
    async taskCreate(payload) {
      const membership = await membershipOf(payload)
      const record = payload as Record<string, unknown>
      const blockedBy = stringArrayOf(record.blockedBy)
      const writeScopes = stringArrayOf(record.writeScopes)
      const req: SidebarCreateTeamTaskRequest = {
        subject: requireString(payload, 'subject'),
        description: typeof record.description === 'string' ? record.description : '',
        ...(blockedBy !== undefined ? { blockedBy } : {}),
        ...(writeScopes !== undefined ? { writeScopes } : {}),
      }
      try {
        return { ok: true, value: await membership.svc.createTask(membership.agent, req) }
      } catch (error) {
        throw serviceError(error)
      }
    },
    async taskUpdate(payload) {
      const membership = await membershipOf(payload)
      const record = payload as Record<string, unknown>
      const expectedRevision = record.expectedRevision
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new SidebarError('bad-request', 'missing or invalid "expectedRevision"')
      }
      const action = record.action
      if (typeof action !== 'string' || !TASK_ACTIONS.has(action)) {
        throw new SidebarError('bad-request', 'missing or invalid "action"')
      }
      const blockedBy = stringArrayOf(record.blockedBy)
      const writeScopes = stringArrayOf(record.writeScopes)
      const req: SidebarUpdateTeamTaskRequest = {
        taskId: requireString(payload, 'taskId'),
        expectedRevision,
        action: action as SidebarUpdateTeamTaskRequest['action'],
        ...(typeof record.subject === 'string' ? { subject: record.subject } : {}),
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
        ...(blockedBy !== undefined ? { blockedBy } : {}),
        ...(writeScopes !== undefined ? { writeScopes } : {}),
        ...(typeof record.owner === 'string' ? { owner: record.owner } : {}),
      }
      try {
        return { ok: true, value: await membership.svc.updateTask(membership.agent, req) }
      } catch (error) {
        throw serviceError(error)
      }
    },
  }
}
