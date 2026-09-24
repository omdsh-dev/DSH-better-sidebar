/**
 * Host route tests for the Agent Teams API ('teams.view' / 'teams.taskCreate'
 * / 'teams.taskUpdate'): structural degradation (layer absent → available:
 * false; root leads no team → team: null), passthrough of the service's own
 * Remote vocabulary, CAS conflict unions returned untouched, and payload
 * validation. The plugin never imports the experimental package — the fake
 * service here is a structural double.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildTeamsApi } from '../src/team-routes.ts'
import type {
  Context,
  SidebarTeamMemberView,
  SidebarTeamTaskView,
} from '../src/context-types.ts'

/** One member row. */
function member(over: Partial<SidebarTeamMemberView> = {}): SidebarTeamMemberView {
  return {
    id: 'root', name: 'lead', role: 'lead', status: 'running', diagnostics: [], ...over,
  }
}

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

describe('teams.view route', () => {
  it('reports available:false when the experimental layer is absent', async () => {
    const api = buildTeamsApi(ctxWith(undefined, agentsWithRoot()))
    await expect(api.view({ rootSessionId: 'root' })).resolves.toEqual({ available: false })
  })

  it('reports team:null when the root agent is not live', async () => {
    const teams = { tryMembership: vi.fn(), remoteView: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, { get: () => undefined }))
    await expect(api.view({ rootSessionId: 'root' })).resolves.toEqual({ available: true, team: null })
    expect(teams.remoteView).not.toHaveBeenCalled()
  })

  it('reports team:null when tryMembership misses', async () => {
    const teams = { tryMembership: vi.fn(async () => undefined), remoteView: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.view({ rootSessionId: 'root' })).resolves.toEqual({ available: true, team: null })
    expect(teams.remoteView).not.toHaveBeenCalled()
  })

  it('reports team:null when tryMembership throws (stale member)', async () => {
    const teams = { tryMembership: vi.fn(async () => { throw new Error('stale') }), remoteView: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.view({ rootSessionId: 'root' })).resolves.toEqual({ available: true, team: null })
  })

  it('returns the service view on a membership hit', async () => {
    const view = { members: [member()], tasks: [task()] }
    const teams = {
      tryMembership: vi.fn(async () => ({ role: 'lead' })),
      remoteView: vi.fn(async () => view),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.view({ rootSessionId: 'root' })).resolves.toEqual({ available: true, team: view })
  })

  it('maps a remoteView rejection to a 400 team-error', async () => {
    const teams = {
      tryMembership: vi.fn(async () => ({ role: 'lead' })),
      remoteView: vi.fn(async () => { throw new Error('replay failed') }),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.view({ rootSessionId: 'root' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 400 }),
    )
  })
})

describe('teams.taskCreate route', () => {
  it('passes the shaped request through and returns the union', async () => {
    const created = task({ id: 'task-9', subject: '新任务' })
    const teams = {
      tryMembership: vi.fn(async () => ({ role: 'lead' })),
      remoteCreateTask: vi.fn(async () => ({ ok: true, value: created })),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    const result = await api.taskCreate({
      rootSessionId: 'root', subject: '新任务', description: '详', blockedBy: ['task-1'],
    })
    expect(result).toEqual({ ok: true, value: created })
    expect(teams.remoteCreateTask).toHaveBeenCalledWith(
      { id: 'root' },
      { subject: '新任务', description: '详', blockedBy: ['task-1'] },
    )
  })

  it('degrades to 503 on a mutation when the layer is absent', async () => {
    const api = buildTeamsApi(ctxWith(undefined, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root', subject: 's' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 503 }),
    )
  })

  it('degrades to 404 when the root leads no team', async () => {
    const teams = { tryMembership: vi.fn(async () => undefined) }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root', subject: 's' })).rejects.toThrowError(
      expect.objectContaining({ code: 'team-error', status: 404 }),
    )
  })

  it('rejects a missing subject as bad-request', async () => {
    const teams = { tryMembership: vi.fn(async () => ({ role: 'lead' })) }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskCreate({ rootSessionId: 'root' })).rejects.toThrowError(
      expect.objectContaining({ code: 'bad-request' }),
    )
  })
})

describe('teams.taskUpdate route', () => {
  it('passes the CAS request through, conflict union untouched', async () => {
    const conflict = { ok: false, error: { code: 'team-task-conflict', message: 'stale revision' } }
    const teams = {
      tryMembership: vi.fn(async () => ({ role: 'lead' })),
      remoteUpdateTask: vi.fn(async () => conflict),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    const result = await api.taskUpdate({
      rootSessionId: 'root', taskId: 'task-1', expectedRevision: 3, action: 'complete',
    })
    expect(result).toEqual(conflict)
    expect(teams.remoteUpdateTask).toHaveBeenCalledWith(
      { id: 'root' },
      { taskId: 'task-1', expectedRevision: 3, action: 'complete' },
    )
  })

  it('validates taskId / expectedRevision / action', async () => {
    const teams = { tryMembership: vi.fn(async () => ({ role: 'lead' })), remoteUpdateTask: vi.fn() }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await expect(api.taskUpdate({ rootSessionId: 'root', expectedRevision: 1, action: 'complete' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    await expect(api.taskUpdate({ rootSessionId: 'root', taskId: 't', action: 'complete' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    await expect(api.taskUpdate({ rootSessionId: 'root', taskId: 't', expectedRevision: -1, action: 'complete' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    await expect(api.taskUpdate({ rootSessionId: 'root', taskId: 't', expectedRevision: 1, action: 'nuke' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad-request' }))
    expect(teams.remoteUpdateTask).not.toHaveBeenCalled()
  })

  it('forwards optional edit fields when present', async () => {
    const teams = {
      tryMembership: vi.fn(async () => ({ role: 'lead' })),
      remoteUpdateTask: vi.fn(async () => ({ ok: true, value: task() })),
    }
    const api = buildTeamsApi(ctxWith(teams, agentsWithRoot()))
    await api.taskUpdate({
      rootSessionId: 'root', taskId: 'task-1', expectedRevision: 2, action: 'reassign', owner: 'writer',
    })
    expect(teams.remoteUpdateTask).toHaveBeenCalledWith(
      { id: 'root' },
      { taskId: 'task-1', expectedRevision: 2, action: 'reassign', owner: 'writer' },
    )
  })
})
