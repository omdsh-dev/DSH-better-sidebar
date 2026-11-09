/**
 * Unit tests for the `agentTeam` projection adapter: reading the Lead
 * Session's board off the client snapshot, and building the roster from the
 * Lead's `subagentCatalog`.
 *
 * The value under test is DSH 0.2.2's `TeamProjection`
 * (`{ enabled, tasks, failure? }`): the roster moved out of it, so a member is
 * a direct subagent read from the catalog. `enabled: false` — and an absent
 * projection — both mean "this session leads no team", the same silent
 * degradation either way.
 */
import { describe, expect, it } from 'vitest'
import { teamMembersOf, teamProjectionOf } from '../src/client/team-projection.ts'
import type {
  SidebarChildLiveView,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentCatalogEntry,
  SidebarTeamProjection,
} from '../src/context-types.ts'

/** One Lead Session projection. */
function team(over: Partial<SidebarTeamProjection> = {}): SidebarTeamProjection {
  return { enabled: true, tasks: [], ...over }
}

/** The snapshot's projection map with one session's team installed. */
function projections(
  rootId: string,
  teamValue: SidebarTeamProjection,
): SidebarSessionList['projectionsBySession'] {
  return { [rootId]: { values: { agentTeam: teamValue }, state: 'ready', error: null } }
}

/** One direct-child catalog row. */
function entry(id: string, over: Partial<SidebarSubagentCatalogEntry> = {}): SidebarSubagentCatalogEntry {
  return { id, createdAt: 1, mode: 'one-shot', ...over }
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
    // deployment without the Team layer, or a plain subagent tree).
    const other: SidebarSessionList['projectionsBySession'] = {
      root: { values: {}, state: 'ready', error: null },
    }
    expect(teamProjectionOf(other, 'root')).toBeUndefined()
    expect(teamProjectionOf(projections('root', team()), 'someone-else')).toBeUndefined()
  })

  it('hides a board whose durable mode selection is off', () => {
    expect(teamProjectionOf(projections('root', team({ enabled: false })), 'root')).toBeUndefined()
  })

  it('keeps a board from a host that publishes no mode flag', () => {
    const legacy: SidebarTeamProjection = { tasks: [] }
    expect(teamProjectionOf(projections('root', legacy), 'root')).toBe(legacy)
  })
})

describe('teamMembersOf', () => {
  const noLive: Record<string, SidebarChildLiveView | undefined> = {}

  it('answers an empty roster without a team or without a root', () => {
    expect(teamMembersOf(undefined, 'root', [entry('w')], noLive, {})).toEqual([])
    expect(teamMembersOf(team(), undefined, [entry('w')], noLive, {})).toEqual([])
  })

  it('puts the Lead first and takes its children from the catalog', () => {
    const rows = teamMembersOf(
      team(),
      'root',
      [entry('w', { name: 'writer' }), entry('r', { name: 'reviewer' })],
      noLive,
      {},
    )
    expect(rows).toEqual([
      { id: 'root', name: 'lead', role: 'lead', status: 'idle' },
      { id: 'w', name: 'writer', role: 'teammate', status: 'idle' },
      { id: 'r', name: 'reviewer', role: 'teammate', status: 'idle' },
    ])
  })

  it('falls back to the mode label and then the id for a row without a name', () => {
    const rows = teamMembersOf(
      team(),
      'root',
      [entry('w', { label: '子代理 0' }), entry('x')],
      noLive,
      {},
    )
    expect(rows.map(row => row.name)).toEqual(['lead', '子代理 0', 'x'])
  })

  it('reads an active member activity from the live channel', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: true } }
    const rows = teamMembersOf(team(), 'root', [entry('w')], live, {})
    expect(rows[1]?.status).toBe('running')
  })

  it('falls back to the session list running flag (the Lead is no live child)', () => {
    const byId = { root: summary('root', { running: true }) }
    const rows = teamMembersOf(team(), 'root', [], noLive, byId)
    expect(rows[0]?.status).toBe('running')
  })

  it('ignores the live channel residency when the summary says the agent is not running (issue #800)', () => {
    // The live flag is the catalog's SESSION RESIDENCY: a retained session
    // whose agent died in a crash-restart reads `running` there while the
    // authoritative summary stays false. The summary wins.
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: true } }
    const byId = { w: summary('w', { running: false }) }
    const rows = teamMembersOf(team(), 'root', [entry('w')], live, byId)
    expect(rows[1]?.status).toBe('idle')
  })

  it('takes the Summary running bit even when the live channel says otherwise', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: false } }
    const byId = { w: summary('w', { running: true }) }
    const rows = teamMembersOf(team(), 'root', [entry('w')], live, byId)
    expect(rows[1]?.status).toBe('running')
  })

  it('treats a member the live channel has not mentioned as idle', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { other: { running: true } }
    const rows = teamMembersOf(team(), 'root', [entry('w')], live, {})
    expect(rows[1]?.status).toBe('idle')
  })
})