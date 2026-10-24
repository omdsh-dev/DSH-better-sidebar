/**
 * Host route tests for the Agent Teams WRITE API ('teams.taskCreate' /
 * 'teams.taskUpdate'): structural degradation (layer absent → 503, root not
 * live / leads no team → 404), the exact request shape the 0.1.7 service
 * demands, and the rejection→wire-code mapping that keeps a stale CAS
 * revision distinct from every other failure.
 *
 * There is deliberately no `teams.view` coverage left: DSH 0.1.7 moved the
 * board's read path onto the Lead Session's `agentTeam` projection, which the
 * client reads off its own snapshot (tests/team-projection.spec.ts). The 0.1.6
 * `remoteView` vocabulary this suite used to lock down no longer exists in the
 * service — that is the drift this file now guards against.
 *
 * The plugin never imports the experimental package; the fake service here is
 * a structural double whose method names and rejection shapes mirror
 * `@deepseek-ai/dsh-experimental-agent-team@0.1.7-rc.1`'s `TeamService`.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildTeamsApi } from '../src/team-routes.ts'
import type { Context, SidebarTeamTaskView } from '../src/context-types.ts'

/** One task row. */
function task(over: Partial<SidebarTeamTaskView> = {}): SidebarTeamTaskView {
  return {
    id: 'task-1', revision: 1, subject: 's', description: 'd', status: 'pending',
    blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...over,
  }
}

/** A context serving the given agentTeams/agents faces. */
function ctxWith(teams: unknown, agents: unknown): Context {
  return {
    get: (key: string) => (key === 'agentTeams' ? teams : key === 'agents' ? agents : undefined),
  } as unknown as Context
}

/** An agents face resolving one live root agent. */
function agentsWithRoot(): { get(id: string): { id: string } | undefined } {
  return { get: (id: string) => (id === 'root' ? { id: 'root' } : undefined) }
}

/** The service's typed rejection (a `TeamError` / `HarnessError` subclass). */
function teamError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code, name: 'TeamError' })
}

describe('teams.taskCreate route', () => {
  it('passes the shaped request through and returns the committed view', async () => {
    const created = task({ id: 'task-9', subject: '新任务' })
    const teams = {
      tryMembership: vi.fn(() => ({ role: 'lead' })),
      createTask: vi.fn(async () => created),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    const result = await api.taskCreate({
      rootSessionId: 'root', subject: '新任务', description: '详', blockedBy: ['task-1'],
    })
    expect(result).toEqual({ ok: true, value: created })
    expect(teams.createTask).toHaveBeenCalledWith(
      { id: 'root' },
      { subject: '新任务', description: '详', blockedBy: ['task-1'] },
    )
  })

  it('degrades to 503 when the experimental layer is absent', async () => {
    const api = buildTeamsApi(ctxWith(undefined, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root', subject: 's' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 503 }),
    )
  })

  it('degrades to 404 when the root agent is not live in this process', async () => {
    const teams = { tryMembership: vi.fn(() => ({ role: 'lead' })), createTask: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, { get: () => undefined }))
    await expect(api.taskCreate({ rootSessionId: 'root', subject: 's' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 404 }),
    )
    expect(teams.createTask).not.toHaveBeenCalled()
  })

  it('degrades to 404 when tryMembership misses (root leads no team)', async () => {
    const teams = { tryMembership: vi.fn(() => undefined), createTask: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root', subject: 's' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 404 }),
    )
  })

  it('maps a throwing tryMembership to 404 (stale member identity)', async () => {
    const teams = {
      tryMembership: vi.fn(() => { throw new Error('stale') }),
      createTask: vi.fn(),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root', subject: 's' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 404 }),
    )
  })

  it('rejects a missing subject as bad-request before calling the service', async () => {
    const teams = { tryMembership: vi.fn(() => ({ role: 'lead' })), createTask: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root' })).rejects.toThrowError(
      expect.objectContaining({ code: 'bad-request' }),
    )
    expect(teams.createTask).not.toHaveBeenCalled()
  })

  it('maps a service rejection to a 400 team-error', async () => {
    const teams = {
      tryMembership: vi.fn(() => ({ role: 'lead' })),
      createTask: vi.fn(async () => { throw teamError('TEAM_TASK_LIMIT', 'task limit reached') }),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root', subject: 's' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 400, message: 'task limit reached' }),
    )
  })
})

describe('teams.taskUpdate route', () => {
  it('passes the CAS request through and returns the committed view', async () => {
    const done = task({ status: 'completed', revision: 2 })
    const teams = {
      tryMembership: vi.fn(() => ({ role: 'lead' })),
      updateTask: vi.fn(async () => done),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    const result = await api.taskUpdate({
      rootSessionId: 'root', taskId: 'task-1', expectedRevision: 1, action: 'complete',
    })
    expect(result).toEqual({ ok: true, value: done })
    expect(teams.updateTask).toHaveBeenCalledWith(
      { id: 'root' },
      { taskId: 'task-1', expectedRevision: 1, action: 'complete' },
    )
  })

  it('maps a stale revision to 409 team-conflict (0.1.7 throws instead of returning)', async () => {
    const teams = {
      tryMembership: vi.fn(() => ({ role: 'lead' })),
      updateTask: vi.fn(async () => {
        throw teamError('TEAM_TASK_STALE_REVISION', 'stale team task "task-1" revision 1; current revision is 2')
      }),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskUpdate({
      rootSessionId: 'root', taskId: 'task-1', expectedRevision: 1, action: 'complete',
    })).rejects.toThrowError(expect.objectContaining({ code: 'team-conflict', status: 409 }))
  })

  it('keeps every other rejection on team-error, never on team-conflict', async () => {
    for (const code of ['TEAM_TASK_NOT_FOUND', 'TEAM_NOT_MEMBER', 'TEAM_DISPOSED']) {
      const teams = {
        tryMembership: vi.fn(() => ({ role: 'lead' })),
        updateTask: vi.fn(async () => { throw teamError(code, 'nope') }),
      }
      const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
      await expect(api.taskUpdate({
        rootSessionId: 'root', taskId: 't', expectedRevision: 1, action: 'complete',
      })).rejects.toThrowError(expect.objectContaining({ code: 'team-error', status: 400 }))
    }
  })

  it('reports an untagged rejection as a 400 with its own message', async () => {
    const teams = {
      tryMembership: vi.fn(() => ({ role: 'lead' })),
      updateTask: vi.fn(async () => { throw new Error('board exploded') }),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskUpdate({
      rootSessionId: 'root', taskId: 't', expectedRevision: 1, action: 'complete',
    })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 400, message: 'board exploded' }),
    )
  })

  it('validates taskId / expectedRevision / action before calling the service', async () => {
    const teams = { tryMembership: vi.fn(() => ({ role: 'lead' })), updateTask: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskUpdate({ rootSessionId: 'root', expectedRevision: 1, action: 'complete' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    await expect(api.taskUpdate({ rootSessionId: 'root', taskId: 't', action: 'complete' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    await expect(api.taskUpdate({ rootSessionId: 'root', taskId: 't', expectedRevision: -1, action: 'complete' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    await expect(api.taskUpdate({ rootSessionId: 'root', taskId: 't', expectedRevision: 1, action: 'nuke' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    expect(teams.updateTask).not.toHaveBeenCalled()
  })

  it('forwards optional edit fields only when present', async () => {
    const teams = {
      tryMembership: vi.fn(() => ({ role: 'lead' })),
      updateTask: vi.fn(async () => task()),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await api.taskUpdate({
      rootSessionId: 'root', taskId: 'task-1', expectedRevision: 2, action: 'reassign', owner: 'writer',
    })
    expect(teams.updateTask).toHaveBeenCalledWith(
      { id: 'root' },
      { taskId: 'task-1', expectedRevision: 2, action: 'reassign', owner: 'writer' },
    )
    teams.updateTask.mockClear()
    await api.taskUpdate({
      rootSessionId: 'root', taskId: 'task-1', expectedRevision: 2, action: 'edit',
      subject: 'S', description: 'D', blockedBy: ['task-2'], writeScopes: ['src/'],
    })
    expect(teams.updateTask).toHaveBeenCalledWith(
      { id: 'root' },
      {
        taskId: 'task-1', expectedRevision: 2, action: 'edit',
        subject: 'S', description: 'D', blockedBy: ['task-2'], writeScopes: ['src/'],
      },
    )
  })

  it('never leaks the 0.1.6 remote vocabulary into the service call', async () => {
    const teams = {
      tryMembership: vi.fn(() => ({ role: 'lead' })),
      updateTask: vi.fn(async () => task()),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await api.taskUpdate({ rootSessionId: 'root', taskId: 't', expectedRevision: 1, action: 'claim' })
    expect(Object.keys(teams)).not.toContain('remoteUpdateTask')
    expect(Object.keys(teams)).not.toContain('remoteView')
  })
})
