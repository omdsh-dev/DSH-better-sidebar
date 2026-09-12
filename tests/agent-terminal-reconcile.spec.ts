import { describe, expect, it } from 'vitest'
import {
  allLeaves, makeDefaultState, openTabInBottomPane, reconcileAgentTerminals,
  setTabPin, tabOpenIn, toggleBottomPanel,
} from '../src/client/state.ts'

describe('agent terminal reconciliation', () => {
  it('adds tabs for new agent terminals', () => {
    let s = makeDefaultState()
    s = reconcileAgentTerminals(s, [
      { uuid: 'aaa-111', title: 'dev server' },
      { uuid: 'bbb-222', title: 'python repl' },
    ])
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
    expect(tabOpenIn(s, 'agent:bbb-222')).toBe(true)
    // The titles are preserved.
    const tabs = allLeaves(s.bottomSplits).flatMap(leaf => leaf.tabs)
    const agentTab = tabs.find(t => t.id === 'agent:aaa-111')
    expect(agentTab?.title).toBe('dev server')
    expect(agentTab?.type).toBe('terminal')
  })

  it('removes tabs for agent terminals that vanished from the server list', () => {
    let s = makeDefaultState()
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
    let s = makeDefaultState()
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    const next = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    expect(next).toBe(s)
  })

  it('does not touch non-agent terminal tabs', () => {
    let s = makeDefaultState()
    s = openTabInBottomPane(s, { id: 'terminal:1', type: 'terminal', title: 'UI Tab' })
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'agent' }])
    expect(tabOpenIn(s, 'terminal:1')).toBe(true)
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
  })

  it('handles an empty server list (removes all agent tabs)', () => {
    let s = makeDefaultState()
    s = reconcileAgentTerminals(s, [
      { uuid: 'aaa-111', title: 'a' },
      { uuid: 'bbb-222', title: 'b' },
    ])
    s = reconcileAgentTerminals(s, [])
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(false)
    expect(tabOpenIn(s, 'agent:bbb-222')).toBe(false)
  })

  it('lands new agent terminals in the workbench pane', () => {
    let s = makeDefaultState()
    s = toggleBottomPanel(s)
    const pane = (s.bottomSplits as { id: string }).id
    s = { ...s, activePane: pane }
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'dev server' }])
    expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
    expect(allLeaves(s.bottomSplits).flatMap(l => l.tabs).some(t => t.id === 'agent:aaa-111')).toBe(true)
  })

  describe('pinned agent terminal exemption (v0.17.0)', () => {
    it('keeps a pinned agent tab when its uuid vanishes from the server list', () => {
      let s = makeDefaultState()
      s = reconcileAgentTerminals(s, [
        { uuid: 'aaa-111', title: 'keep' },
        { uuid: 'bbb-222', title: 'pinned' },
      ])
      // Pin bbb-222, then drop it from the server list.
      s = setTabPin(s, 'agent:bbb-222', { scope: 'global' })
      s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'keep' }])
      // aaa-111 (unpinned) survived; bbb-222 (pinned) survived too.
      expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
      expect(tabOpenIn(s, 'agent:bbb-222')).toBe(true)
      // The pin marker is intact.
      const tabs = allLeaves(s.bottomSplits).flatMap(l => l.tabs)
      const pinned = tabs.find(t => t.id === 'agent:bbb-222')!
      expect(pinned.pin).toEqual({ scope: 'global' })
    })

    it('still removes an unpinned agent tab when the uuid vanishes', () => {
      let s = makeDefaultState()
      s = reconcileAgentTerminals(s, [
        { uuid: 'aaa-111', title: 'pinned' },
        { uuid: 'bbb-222', title: 'unpinned' },
      ])
      s = setTabPin(s, 'agent:aaa-111', { scope: 'workspace', homeCwd: '/p' })
      s = reconcileAgentTerminals(s, []) // both vanish
      // Pinned stays, unpinned goes.
      expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
      expect(tabOpenIn(s, 'agent:bbb-222')).toBe(false)
    })

    it('a pinned tab whose uuid RETURNS in a later push is a no-op (already exists)', () => {
      let s = makeDefaultState()
      s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'gone' }])
      s = setTabPin(s, 'agent:aaa-111', { scope: 'global' })
      // First push without it: exempted, stays.
      s = reconcileAgentTerminals(s, [])
      expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true)
      // Later push brings it back: reconcile sees the uuid already exists,
      // does not re-add, does not touch the pin.
      const before = s
      s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'gone' }])
      expect(s).toBe(before)
    })

    it('exemption does not block the toAdd path (new uuids still land)', () => {
      let s = makeDefaultState()
      s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'first' }])
      s = setTabPin(s, 'agent:aaa-111', { scope: 'global' })
      // aaa-111 vanishes (exempted), bbb-222 is brand-new.
      s = reconcileAgentTerminals(s, [{ uuid: 'bbb-222', title: 'second' }])
      expect(tabOpenIn(s, 'agent:aaa-111')).toBe(true) // pinned, kept
      expect(tabOpenIn(s, 'agent:bbb-222')).toBe(true) // new, added
    })
  })

  it('mirrors the pushed waiting state into agentWaits and clears it when it ends', () => {
    let s = makeDefaultState()
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'busy', waiting: { needle: 'READY_1', since: 42 } }])
    expect(s.agentWaits['aaa-111']).toEqual({ needle: 'READY_1', since: 42 })
    // The next push without waiting drops the entry (the push is authoritative).
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    expect(s.agentWaits['aaa-111']).toBeUndefined()
  })

  it('produces a new state when ONLY the wait state changes (no tab add/remove)', () => {
    let s = makeDefaultState()
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    const before = s
    const next = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable', waiting: { needle: 'N', since: 1 } }])
    expect(next).not.toBe(before)
    expect(next.agentWaits['aaa-111']).toBeDefined()
    // Idempotent: the same push again returns the same reference.
    expect(reconcileAgentTerminals(next, [{ uuid: 'aaa-111', title: 'stable', waiting: { needle: 'N', since: 1 } }])).toBe(next)
  })
})
