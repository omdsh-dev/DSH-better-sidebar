import { describe, expect, it } from 'vitest'
import {
  allLeaves, makeDefaultState, openTabInActivePane, reconcileAgentTerminals,
  tabOpenIn, toggleBottomPanel,
} from '../src/client/state.ts'

describe('agent terminal reconciliation', () => {
  it('adds tabs for new agent terminals', () => {
    let s = makeDefaultState(400, true)
    s = reconcileAgentTerminals(s, [
      { uuid: 'aaa-111', title: 'dev server' },
      { uuid: 'bbb-222', title: 'python repl' },
    ])
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
    expect(tabOpenIn(s, 'agent:bbb-222')).toBe(true)
    // The titles are preserved.
    const tabs = allLeaves(s.splits).flatMap(leaf => leaf.tabs)
    const agentTab = tabs.find(t => t.id === 'agent:aaa-111')
    expect(agentTab?.title).toBe('dev server')
    expect(agentTab?.type).toBe('terminal')
  })

  it('removes tabs for agent terminals that vanished from the server list', () => {
    let s = makeDefaultState(400, true)
    s = reconcileAgentTerminals(s, [
      { uuid: 'aaa-111', title: 'keep' },
      { uuid: 'bbb-222', title: 'remove' },
    ])
    expect(tabOpenIn(s, 'agent:bbb-222')).toBe(true)
    // Next push drops bbb-222.
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'keep' }])
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
    expect(tabOpenIn(s, 'agent:bbb-222')).toBe(false)
  })

  it('is a no-op (same reference) when the lists already match', () => {
    let s = makeDefaultState(400, true)
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    const next = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    expect(next).toBe(s)
  })

  it('does not touch non-agent terminal tabs', () => {
    let s = makeDefaultState(400, true)
    s = openTabInActivePane(s, { id: 'terminal:1', type: 'terminal', title: 'UI Tab' })
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'agent' }])
    expect(tabOpenIn(s, 'terminal:1')).toBe(true)
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
  })

  it('handles an empty server list (removes all agent tabs)', () => {
    let s = makeDefaultState(400, true)
    s = reconcileAgentTerminals(s, [
      { uuid: 'aaa-111', title: 'a' },
      { uuid: 'bbb-222', title: 'b' },
    ])
    s = reconcileAgentTerminals(s, [])
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(false)
    expect(tabOpenIn(s, 'agent:bbb-222')).toBe(false)
  })

  it('lands new agent terminals in the active tree (bottom panel pane)', () => {
    let s = makeDefaultState(400, true)
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = { ...s, activePane: bottomPane }
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'dev server' }])
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
    expect(allLeaves(s.bottomSplits).flatMap(l => l.tabs).some(t => t.id === 'agent:aaa-111')).toBe(true)
    expect(allLeaves(s.splits).flatMap(l => l.tabs).some(t => t.id === 'agent:aaa-111')).toBe(false)
  })
})
