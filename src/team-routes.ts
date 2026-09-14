/**
 * The Agent Teams routes of the /sidebar JSON API ('teams.view' /
 * 'teams.taskCreate' / 'teams.taskUpdate'). The experimental
 * `dsh-experimental-agent-team` service (`ctx.agentTeams`) exists only when
 * the deployment opts in, so the routes degrade structurally:
 *
 * - service absent (`ctx.get('agentTeams')` undefined) → `{available:false}`
 *   — the client hides the whole Teams block silently (absence is a
 *   deployment fact, never an error banner);
 * - the tree's root agent is not a team member (`tryMembership` miss) →
 *   `{available:true, team:null}` — the page shows the plain agent graph;
 * - hit → the service's own Remote vocabulary (`remoteView` /
 *   `remoteCreateTask` / `remoteUpdateTask`), whose mutation result union
 *   already keeps CAS conflicts (`team-task-conflict`) distinct from other
 *   rejections — the route passes it through untouched so the client's
 *   edit popover can render "someone else changed this task, refreshing".
 *
 * Teams are implicit (TeamId ≡ the lead's session id) and every service
 * method demands the live member Agent as its authority token, so the
 * routes re-derive the caller per request (`ctx.agents.get(rootSessionId)`)
 * exactly like the jobs.kill fence. Zero DSH source changes; the plugin
 * never imports the experimental package (structural mirrors only).
 */
import type {
  Context,
  SidebarAgentTeamsService,
  SidebarAgentsService,
  SidebarCreateTeamTaskRequest,
  SidebarTeamMemberView,
  SidebarTeamTaskMutationResult,
  SidebarTeamTaskView,
  SidebarUpdateTeamTaskRequest,
} from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

/** The Agent Teams routes of the sidebar API. */
export interface SidebarTeamsRoutes {
  /**
   * The team led by the tree's root agent, if any.
   * @param payload - `{ rootSessionId }`.
   * @returns `{ available: false }` when the deployment lacks the
   *   experimental layer; `{ available: true, team: null }` when the root
   *   leads no team; otherwise the members + task board.
   */
  view(payload: unknown): Promise<
    | { available: false }
    | { available: true; team: { members: SidebarTeamMemberView[]; tasks: SidebarTeamTaskView[] } | null }
  >
  /** Create one shared task (payload = `{ rootSessionId, ...request }`). */
  taskCreate(payload: unknown): Promise<SidebarTeamTaskMutationResult>
  /** CAS-mutate one shared task (payload = `{ rootSessionId, ...request }`). */
  taskUpdate(payload: unknown): Promise<SidebarTeamTaskMutationResult>
}

/** The CAS actions the wire accepts (mirrors the domain union). */
const TASK_ACTIONS = new Set([
  'claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete',
])

/** Narrow an unknown payload value to a string array (else undefined). */
function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length === value.length ? out : undefined
}

/**
 * Build the Agent Teams routes bound to the plugin context.
 * @param ctx - host plugin context.
 */
export function buildTeamsApi(ctx: Context): SidebarTeamsRoutes {
  const teams = ctx.get('agentTeams') as SidebarAgentTeamsService | undefined
  const agents = ctx.get('agents') as SidebarAgentsService | undefined

  /**
   * The live lead agent of the requested tree plus its membership check.
   * Throws 503 team-error when the experimental layer is absent (a mutation
   * can never be accepted there); returns undefined when the root simply
   * leads no team (a normal page state).
   */
  const membershipOf = async (
    payload: unknown,
  ): Promise<{ svc: SidebarAgentTeamsService; agent: unknown } | undefined> => {
    if (teams === undefined) {
      throw new SidebarError('team-error', 'the agent-teams layer is not mounted in this deployment', 503)
    }
    const rootSessionId = requireString(payload, 'rootSessionId')
    const agent = agents?.get(rootSessionId)
    if (agent === undefined) {
      // The root is not live in this process (cold session / other harness):
      // teams are live-led by definition, so there is nothing to show.
      return undefined
    }
    try {
      if (await teams.tryMembership(agent) === undefined) return undefined
    } catch {
      return undefined
    }
    return { svc: teams, agent }
  }

  /** Service rejections become a 400 team-error; CAS conflicts ride the union. */
  const serviceError = (error: unknown): SidebarError =>
    new SidebarError('team-error', error instanceof Error ? error.message : String(error), 400)

  return {
    async view(payload) {
      if (teams === undefined) return { available: false }
      const membership = await membershipOf(payload)
      if (membership === undefined) return { available: true, team: null }
      try {
        const team = await membership.svc.remoteView(membership.agent)
        return { available: true, team }
      } catch (error) {
        throw serviceError(error)
      }
    },
    async taskCreate(payload) {
      const membership = await membershipOf(payload)
      if (membership === undefined) {
        throw new SidebarError('team-error', 'the tree root leads no team', 404)
      }
      const record = payload as Record<string, unknown>
      const req: SidebarCreateTeamTaskRequest = {
        subject: requireString(payload, 'subject'),
        description: typeof record.description === 'string' ? record.description : '',
        ...(stringArrayOf(record.blockedBy) !== undefined ? { blockedBy: stringArrayOf(record.blockedBy) } : {}),
        ...(stringArrayOf(record.writeScopes) !== undefined ? { writeScopes: stringArrayOf(record.writeScopes) } : {}),
      }
      try {
        return await membership.svc.remoteCreateTask(membership.agent, req)
      } catch (error) {
        throw serviceError(error)
      }
    },
    async taskUpdate(payload) {
      const membership = await membershipOf(payload)
      if (membership === undefined) {
        throw new SidebarError('team-error', 'the tree root leads no team', 404)
      }
      const record = payload as Record<string, unknown>
      const expectedRevision = record.expectedRevision
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new SidebarError('bad-request', 'missing or invalid "expectedRevision"')
      }
      const action = record.action
      if (typeof action !== 'string' || !TASK_ACTIONS.has(action)) {
        throw new SidebarError('bad-request', 'missing or invalid "action"')
      }
      const req: SidebarUpdateTeamTaskRequest = {
        taskId: requireString(payload, 'taskId'),
        expectedRevision,
        action: action as SidebarUpdateTeamTaskRequest['action'],
        ...(typeof record.subject === 'string' ? { subject: record.subject } : {}),
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
        ...(stringArrayOf(record.blockedBy) !== undefined ? { blockedBy: stringArrayOf(record.blockedBy) } : {}),
        ...(stringArrayOf(record.writeScopes) !== undefined ? { writeScopes: stringArrayOf(record.writeScopes) } : {}),
        ...(typeof record.owner === 'string' ? { owner: record.owner } : {}),
      }
      try {
        return await membership.svc.remoteUpdateTask(membership.agent, req)
      } catch (error) {
        throw serviceError(error)
      }
    },
  }
}
