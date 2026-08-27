/**
 * Pinned-terminal resolver (v0.17.0) — pure functions over cached session
 * states. Covers the visibility matrix (global / workspace × cwd match /
 * mismatch / both undefined / viewer-only undefined) and the cross-session
 * collection (multi-session, exclusion of the viewer's own session, stable
 * tree order, floats).
 */
import { describe, expect, it } from 'vitest'
import {
  floatTab, makeDefaultState, openTabInActivePane, setTabPin, toggleBottomPanel,
  type SidebarState,
} from '../src/client/state.ts'
import { collectPinnedTabs, pinnedVisibleTo, type PinnedViewer,
  isPinnedVirtualId, parsePinnedVirtualId, isPinnedVirtualTab, getPinnedHomeScope,
  createPinnedVirtualTab, injectPinnedIntoTree,
} from '../src/client/pinned.ts'

/** A pinned terminal tab in a fresh state, opened and pinned in one go. */
function stateWithPinnedTerminal(
  id: string,
  pin: { scope: 'workspace' | 'global'; homeCwd?: string },
): SidebarState {
  let s = makeDefaultState()
  s = openTabInActivePane(s, { id, type: 'terminal', title: id })
  return setTabPin(s, id, pin)
}

const viewer = (sessionId: string, cwd?: string): PinnedViewer => ({ sessionId, cwd })

describe('pinnedVisibleTo', () => {
  it('returns false for an unpinned tab', () => {
    const tab = { id: 't', type: 'terminal', title: 'T' }
    expect(pinnedVisibleTo(tab, viewer('s', '/p'))).toBe(false)
  })

  it('global pin is visible to any session regardless of cwd', () => {
    const tab = { id: 't', type: 'terminal', title: 'T', pin: { scope: 'global' as const } }
    expect(pinnedVisibleTo(tab, viewer('s', '/other'))).toBe(true)
    expect(pinnedVisibleTo(tab, viewer('s', undefined))).toBe(true)
  })

  it('workspace pin matches when cwds are equal', () => {
    const tab = { id: 't', type: 'terminal', title: 'T', pin: { scope: 'workspace' as const, homeCwd: '/p' } }
    expect(pinnedVisibleTo(tab, viewer('s', '/p'))).toBe(true)
    expect(pinnedVisibleTo(tab, viewer('s', '/q'))).toBe(false)
  })

  it('workspace pin without homeCwd is visible everywhere (pin set before cwd resolved)', () => {
    const tab = { id: 't', type: 'terminal', title: 'T', pin: { scope: 'workspace' as const } }
    expect(pinnedVisibleTo(tab, viewer('s', '/anywhere'))).toBe(true)
    expect(pinnedVisibleTo(tab, viewer('s', undefined))).toBe(true)
  })

  it('workspace pin is conservatively visible when viewer.cwd is unknown (no hydration flash)', () => {
    const tab = { id: 't', type: 'terminal', title: 'T', pin: { scope: 'workspace' as const, homeCwd: '/p' } }
    expect(pinnedVisibleTo(tab, viewer('s', undefined))).toBe(true)
  })

  it('both undefined cwds match (legacy pin + unhydrated viewer)', () => {
    const tab = { id: 't', type: 'terminal', title: 'T', pin: { scope: 'workspace' as const, homeCwd: undefined } }
    expect(pinnedVisibleTo(tab, viewer('s', undefined))).toBe(true)
  })
})

describe('collectPinnedTabs', () => {
  it('returns an empty array when no other session has pinned terminals', () => {
    const bySession = new Map<string, SidebarState>([
      ['s1', stateWithPinnedTerminal('terminal:1', { scope: 'global' })],
    ])
    expect(collectPinnedTabs(bySession, viewer('s1', '/p'))).toEqual([])
  })

  it('returns an empty array for an empty session cache', () => {
    expect(collectPinnedTabs(new Map(), viewer('s1', '/p'))).toEqual([])
  })

  it('collects a global pin from another session', () => {
    const bySession = new Map<string, SidebarState>([
      ['home', stateWithPinnedTerminal('terminal:1', { scope: 'global' })],
    ])
    const entries = collectPinnedTabs(bySession, viewer('viewer', '/anywhere'))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.tab.id).toBe('terminal:1')
    expect(entries[0]!.homeSessionId).toBe('home')
  })

  it('collects a workspace pin only when the viewer cwd matches homeCwd', () => {
    const home = stateWithPinnedTerminal('terminal:1', { scope: 'workspace', homeCwd: '/proj' })
    const bySession = new Map<string, SidebarState>([['home', home]])
    expect(collectPinnedTabs(bySession, viewer('viewer', '/proj'))).toHaveLength(1)
    expect(collectPinnedTabs(bySession, viewer('viewer', '/elsewhere'))).toHaveLength(0)
  })

  it('excludes the viewer\'s own session (its pinned tabs are on its own strip)', () => {
    const bySession = new Map<string, SidebarState>([
      ['viewer', stateWithPinnedTerminal('terminal:1', { scope: 'global' })],
      ['home', stateWithPinnedTerminal('terminal:2', { scope: 'global' })],
    ])
    const entries = collectPinnedTabs(bySession, viewer('viewer', '/p'))
    expect(entries.map(e => e.tab.id)).toEqual(['terminal:2'])
  })

  it('collects in stable tree order: splits → bottomSplits → floats', () => {
    let home = makeDefaultState()
    // Right tree tab first.
    home = openTabInActivePane(home, { id: 'terminal:right', type: 'terminal', title: 'R' })
    home = setTabPin(home, 'terminal:right', { scope: 'global' })
    // Bottom tree tab second.
    home = toggleBottomPanel(home)
    const bottomPane = (home.bottomSplits as { id: string }).id
    home = { ...home, activePane: bottomPane }
    home = openTabInActivePane(home, { id: 'terminal:bottom', type: 'terminal', title: 'B' })
    home = setTabPin(home, 'terminal:bottom', { scope: 'global' })
    // Float last.
    home = openTabInActivePane(home, { id: 'terminal:float', type: 'terminal', title: 'F' })
    home = setTabPin(home, 'terminal:float', { scope: 'global' })
    home = floatTab(home, 'terminal:float', 50, 50)

    const bySession = new Map<string, SidebarState>([['home', home]])
    const entries = collectPinnedTabs(bySession, viewer('viewer', '/p'))
    expect(entries.map(e => e.tab.id)).toEqual(['terminal:right', 'terminal:bottom', 'terminal:float'])
  })

  it('keeps stable insertion order across multiple home sessions', () => {
    const bySession = new Map<string, SidebarState>([
      ['homeA', stateWithPinnedTerminal('terminal:a', { scope: 'global' })],
      ['homeB', stateWithPinnedTerminal('terminal:b', { scope: 'global' })],
    ])
    const entries = collectPinnedTabs(bySession, viewer('viewer', '/p'))
    expect(entries.map(e => e.tab.id)).toEqual(['terminal:a', 'terminal:b'])
    expect(entries.map(e => e.homeSessionId)).toEqual(['homeA', 'homeB'])
  })

  it('ignores unpinned terminals and non-terminal tabs in other sessions', () => {
    let home = makeDefaultState()
    home = openTabInActivePane(home, { id: 'terminal:unpinned', type: 'terminal', title: 'U' })
    home = openTabInActivePane(home, { id: 'editor:1', type: 'editor', title: 'E', path: '/e' })
    home = setTabPin(home, 'editor:1', { scope: 'global' }) // defensive: pin only targets terminals
    home = openTabInActivePane(home, { id: 'terminal:pinned', type: 'terminal', title: 'P' })
    home = setTabPin(home, 'terminal:pinned', { scope: 'global' })
    const bySession = new Map<string, SidebarState>([['home', home]])
    const entries = collectPinnedTabs(bySession, viewer('viewer', '/p'))
    expect(entries.map(e => e.tab.id)).toEqual(['terminal:pinned'])
  })
})

describe('isPinnedVirtualId / parsePinnedVirtualId', () => {
  it('detects a pinned virtual id by prefix', () => {
    expect(isPinnedVirtualId('pinned:home:terminal:3')).toBe(true)
    expect(isPinnedVirtualId('pinned:abc-123:agent:def-456')).toBe(true)
    expect(isPinnedVirtualId('terminal:3')).toBe(false)
    expect(isPinnedVirtualId('agent:uuid')).toBe(false)
  })

  it('parses home session id and original tab id (terminal)', () => {
    const { homeSessionId, tabId } = parsePinnedVirtualId('pinned:home-sess:terminal:3')
    expect(homeSessionId).toBe('home-sess')
    expect(tabId).toBe('terminal:3')
  })

  it('parses home session id and original tab id (agent)', () => {
    const { homeSessionId, tabId } = parsePinnedVirtualId('pinned:abc-123:agent:def-456')
    expect(homeSessionId).toBe('abc-123')
    expect(tabId).toBe('agent:def-456')
  })
})

describe('createPinnedVirtualTab', () => {
  it('creates a virtual tab with a prefixed id and home scope in meta', () => {
    const tab = { id: 'terminal:3', type: 'terminal' as const, title: 'T3', pin: { scope: 'global' as const, homeCwd: '/p' } }
    const vtab = createPinnedVirtualTab({ tab, homeSessionId: 'home' })
    expect(vtab.id).toBe('pinned:home:terminal:3')
    expect(vtab.type).toBe('terminal')
    expect(vtab.title).toBe('T3')
    expect(vtab.pin).toEqual({ scope: 'global', homeCwd: '/p' })
  })

  it('stores the home scope (sessionId, cwd, original tabId) in meta', () => {
    const tab = { id: 'terminal:3', type: 'terminal' as const, title: 'T3', pin: { scope: 'workspace' as const, homeCwd: '/proj' } }
    const vtab = createPinnedVirtualTab({ tab, homeSessionId: 'home-sess' })
    const home = getPinnedHomeScope(vtab)
    expect(home).toBeDefined()
    expect(home!.sessionId).toBe('home-sess')
    expect(home!.cwd).toBe('/proj')
    expect(home!.tabId).toBe('terminal:3')
  })

  it('preserves existing meta fields alongside the pinned home scope', () => {
    const tab = { id: 'terminal:3', type: 'terminal' as const, title: 'T3', pin: { scope: 'global' as const }, meta: { custom: 42 } }
    const vtab = createPinnedVirtualTab({ tab, homeSessionId: 'home' })
    expect((vtab.meta as Record<string, unknown>).custom).toBe(42)
    expect(isPinnedVirtualTab(vtab)).toBe(true)
  })

  it('cwd is undefined for a global pin without homeCwd', () => {
    const tab = { id: 'terminal:3', type: 'terminal' as const, title: 'T3', pin: { scope: 'global' as const } }
    const vtab = createPinnedVirtualTab({ tab, homeSessionId: 'home' })
    expect(getPinnedHomeScope(vtab)!.cwd).toBeUndefined()
  })

  it('isPinnedVirtualTab returns false for a regular tab', () => {
    const tab = { id: 'terminal:3', type: 'terminal' as const, title: 'T3' }
    expect(isPinnedVirtualTab(tab)).toBe(false)
  })
})

describe('injectPinnedIntoTree', () => {
  it('returns the original tree when no pinned tabs and no active override', () => {
    const tree = makeDefaultState().splits
    expect(injectPinnedIntoTree(tree, [], null)).toBe(tree)
  })

  it('appends pinned virtual tabs to the first leaf', () => {
    const s = makeDefaultState()
    const vtab = createPinnedVirtualTab({
      tab: { id: 'terminal:3', type: 'terminal', title: 'T3', pin: { scope: 'global' } },
      homeSessionId: 'home',
    })
    const result = injectPinnedIntoTree(s.splits, [vtab], null)
    expect(result.kind).toBe('leaf')
    if (result.kind === 'leaf') {
      expect(result.tabs[result.tabs.length - 1]!.id).toBe('pinned:home:terminal:3')
    }
  })

  it('overrides the first leaf active when activePinnedId is set', () => {
    const s = openTabInActivePane(makeDefaultState(), { id: 'terminal:1', type: 'terminal', title: 'T1' })
    const vtab = createPinnedVirtualTab({
      tab: { id: 'terminal:2', type: 'terminal', title: 'T2', pin: { scope: 'global' } },
      homeSessionId: 'home',
    })
    const result = injectPinnedIntoTree(s.splits, [vtab], vtab.id)
    if (result.kind === 'leaf') {
      expect(result.active).toBe(vtab.id)
      expect(result.tabs.map(t => t.id)).toContain(vtab.id)
      expect(result.tabs.map(t => t.id)).toContain('terminal:1')
    }
  })

  it('injects into the first child of a split tree', () => {
    let s = makeDefaultState()
    s = openTabInActivePane(s, { id: 'terminal:1', type: 'terminal', title: 'T1' })
    // Create a split (splits the active pane into two)
    const leafId = s.splits.kind === 'leaf' ? s.splits.id : ''
    s = { ...s, splits: { kind: 'split', id: 'split:1', dir: 'row', sizes: [0.5, 0.5], children: [
      { kind: 'leaf', id: leafId, tabs: s.splits.kind === 'leaf' ? s.splits.tabs : [], active: 'terminal:1' },
      { kind: 'leaf', id: 'pane:2', tabs: [], active: null },
    ] } }
    const vtab = createPinnedVirtualTab({
      tab: { id: 'terminal:2', type: 'terminal', title: 'T2', pin: { scope: 'global' } },
      homeSessionId: 'home',
    })
    const result = injectPinnedIntoTree(s.splits, [vtab], null)
    expect(result.kind).toBe('split')
    if (result.kind === 'split') {
      const first = result.children[0]!
      if (first.kind === 'leaf') {
        expect(first.tabs.map(t => t.id)).toContain(vtab.id)
      }
      const second = result.children[1]!
      if (second.kind === 'leaf') {
        expect(second.tabs.map(t => t.id)).not.toContain(vtab.id)
      }
    }
  })
})
