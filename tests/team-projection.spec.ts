/**
 * Unit tests for the `agentTeam` projection adapter: reading the Lead
 * Session's board off the client snapshot, and overlaying runtime activity
 * onto the durable roster.
 *
 * The shape under test is DSH 0.1.7's `TeamProjection` (see the experimental
 * package's `lib/types/types.d.ts`): `{ members: {id,name,role,phase,error?},
 * tasks: TeamTaskView[], failure? }`. There is no `available` flag and no
 * `model` field — a projection that is absent means "this session leads no
 * team" (or the deployment never mounted the layer), which is the same silent
 * degradation either way.
 */
import { describe, expect, it } from 'vitest'
import { teamMembersOf, teamProjectionOf } from '../src/client/team-projection.ts'
import type {
  SidebarChildLiveView,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarTeamMemberProjection,
  SidebarTeamProjection,
} from '../src/context-types.ts'

/** One durable roster row. */
function member(over: Partial<SidebarTeamMemberProjection> = {}): SidebarTeamMemberProjection {
  return { id: 'w', name: 'writer', role: 'teammate', phase: 'active', ...over }
}

/** One Lead Session projection. */
function team(over: Partial<SidebarTeamProjection> = {}): SidebarTeamProjection {
  return { members: [member()], tasks: [], ...over }
}

/** The snapshot's projection map with one session's team installed. */
function projections(
  rootId: string,
  teamValue: SidebarTeamProjection,
): SidebarSessionList['projectionsBySession'] {
  return { [rootId]: { values: { agentTeam: teamValue }, state: 'ready', error: null } }
}

/** A summary row. */
function summary(id: string, over: Partial<SidebarSessionSummary> = {}): SidebarSessionSummary {
  return { id, displayTitle: id, ...over }
}

describe('teamProjectionOf', () => {
  it('reads the root session own projection', () => {
    const value = team()
    expect(teamProjectionOf(projections('root', value), 'root')).toBe(value)
  })

  it('answers undefined without a root, without a snapshot, or without a team', () => {
    expect(teamProjectionOf(projections('root', team()), undefined)).toBeUndefined()
    expect(teamProjectionOf(undefined, 'root')).toBeUndefined()
    // A session the projection store knows, but which leads no team (the
    // deployment without the experimental layer, or a plain subagent tree).
    const other: SidebarSessionList['projectionsBySession'] = {
      root: { values: {}, state: 'ready', error: null },
    }
    expect(teamProjectionOf(other, 'root')).toBeUndefined()
    expect(teamProjectionOf(projections('root', team()), 'someone-else')).toBeUndefined()
  })
})

describe('teamMembersOf', () => {
  const noLive: Record<string, SidebarChildLiveView | undefined> = {}

  it('answers an empty roster without a team', () => {
    expect(teamMembersOf(undefined, noLive, {})).toEqual([])
  })

  it('carries the durable phase and the member identity through', () => {
    const rows = teamMembersOf(
      team({ members: [member({ id: 'lead', name: 'lead', role: 'lead' }), member({ id: 'w' })] }),
      noLive,
      {},
    )
    expect(rows).toEqual([
      { id: 'lead', name: 'lead', role: 'lead', phase: 'active', status: 'idle', diagnostics: [] },
      { id: 'w', name: 'writer', role: 'teammate', phase: 'active', status: 'idle', diagnostics: [] },
    ])
  })

  it('reads an active member activity from the live channel', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: true } }
    expect(teamMembersOf(team(), live, {})[0]?.status).toBe('running')
  })

  it('falls back to the session list running flag (the Lead is no live child)', () => {
    const byId = { lead: summary('lead', { running: true }) }
    const rows = teamMembersOf(
      team({ members: [member({ id: 'lead', name: 'lead', role: 'lead' })] }),
      noLive,
      byId,
    )
    expect(rows[0]?.status).toBe('running')
  })

  it('never claims a running turn while the durable phase disagrees', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: true } }
    const provisioning = teamMembersOf(team({ members: [member({ phase: 'provisioning' })] }), live, {})
    expect(provisioning[0]?.status).toBe('provisioning')
    const failed = teamMembersOf(team({ members: [member({ phase: 'failed' })] }), live, {})
    expect(failed[0]?.status).toBe('failed')
  })

  it('exposes the durable member error as the diagnostics list', () => {
    const rows = teamMembersOf(
      team({ members: [member({ phase: 'failed', error: 'spawn rejected' })] }),
      noLive,
      {},
    )
    expect(rows[0]?.diagnostics).toEqual(['spawn rejected'])
  })

  it('treats a member the live channel has not mentioned as idle', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { other: { running: true } }
    expect(teamMembersOf(team(), live, {})[0]?.status).toBe('idle')
  })
})
