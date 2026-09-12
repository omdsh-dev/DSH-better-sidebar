import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activateTab, allLeaves, BOTTOM_DEFAULT, BOTTOM_MIN, closeTab, CONVERSATION_MIN, createSidebarStore,
  insertLeafAt, makeDefaultState, moveTab, moveTabToEdge, openDiffTab,
  openTabInBottomPane, patchTab, resizeSplit,
  resizeSplitIn, revealPaths, sanitizeState, setBottomHeight, setTabPin,
  splitPane, tabOpenIn, toggleBottomPanel, toggleExpanded,
  type SidebarState, type SidebarTab, type SplitNode,
} from '../src/client/state.ts'

describe('sidebar state', () => {
  const state = (): SidebarState => makeDefaultState()

  it('sanitizeState migrates persisted explorer tabs to editor home tabs', () => {
    const valid = sanitizeState({
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:1',
        active: 'ex-bottom',
        tabs: [{ id: 'ex-bottom', type: 'explorer', title: 'Explorer', meta: { treeWidth: 300 } }],
      },
    })
    const tabs = (valid?.bottomSplits as { tabs: SidebarTab[] }).tabs
    expect(tabs).toHaveLength(1)
    // Migrated: editor home tab (no path), tree pinned open, prior meta kept.
    expect(tabs[0]).toMatchObject({ id: 'ex-bottom', type: 'editor', title: 'Files', meta: { treeOpen: true, treeWidth: 300 } })
    expect(tabs[0]!.path).toBeUndefined()
  })

  it('opens tabs into the workbench pane and dedupes by id (safety net)', () => {
    let s = state()
    const gitTab = { id: 'git', type: 'git' as const, title: 'Git' }
    s = openTabInBottomPane(s, gitTab)
    expect(s.bottomSplits.kind).toBe('leaf')
    expect((s.bottomSplits as { tabs: unknown[] }).tabs).toHaveLength(1)
    // Landing a tab opens the bottom workbench.
    expect(s.bottomOpen).toBe(true)
    // Reopening with the SAME id focuses the existing tab instead of duplicating.
    const after = openTabInBottomPane(s, { id: 'git', type: 'git' as const, title: 'Git' })
    expect((after.bottomSplits as { tabs: unknown[] }).tabs).toHaveLength(1)
    // A different id opens a new tab (type-level dedupe is the service's job).
    const after2 = openTabInBottomPane(s, { id: 'git2', type: 'git' as const, title: 'Git' })
    expect((after2.bottomSplits as { tabs: unknown[] }).tabs).toHaveLength(2)
  })

  it('opens multiple editors with distinct ids (path-level dedupe is the service descriptor\'s job)', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'e1', type: 'editor', title: 'a.ts', path: '/p/a.ts' })
    const after = openTabInBottomPane(s, { id: 'e2', type: 'editor', title: 'a.ts', path: '/p/a.ts' })
    expect((after.bottomSplits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual(['e1', 'e2'])
  })

  const diffTab = (id: string): SidebarTab => ({
    id,
    type: 'diff',
    title: id,
    diff: { kind: 'worktree', path: 'src/a.ts', staged: false },
  })

  it('first diff splits the source pane vertically (diff below)', () => {
    const s = state()
    const gitTab = { id: 'git', type: 'git' as const, title: 'Git' }
    const withGit = openTabInBottomPane(s, gitTab)
    const sourcePane = (withGit.bottomSplits as { kind: 'leaf'; id: string }).id
    const after = openDiffTab(withGit, sourcePane, diffTab('diff:w:u:src/a.ts'))
    expect(after.bottomSplits.kind).toBe('split')
    const split = after.bottomSplits as { dir: string; children: { kind: string; tabs?: SidebarTab[]; id: string }[] }
    expect(split.dir).toBe('col')
    expect(split.children).toHaveLength(2)
    // The source stays on TOP (first child), the diff lands in the new bottom leaf.
    expect(split.children[0]!.id).toBe(sourcePane)
    expect(split.children[1]!.tabs?.map(tab => tab.id)).toEqual(['diff:w:u:src/a.ts'])
    expect(after.activePane).toBe(split.children[1]!.id)
  })

  it('reopening the same diff focuses its existing tab', () => {
    const s = state()
    const gitTab = { id: 'git', type: 'git' as const, title: 'Git' }
    const withGit = openTabInBottomPane(s, gitTab)
    const sourcePane = (withGit.bottomSplits as { kind: 'leaf'; id: string }).id
    const first = openDiffTab(withGit, sourcePane, diffTab('diff:w:u:src/a.ts'))
    const second = openDiffTab(first, sourcePane, diffTab('diff:w:u:src/a.ts'))
    // No new panes, no duplicate tabs.
    expect(second.bottomSplits.kind).toBe('split')
    const split = second.bottomSplits as { children: { kind: string; tabs?: SidebarTab[] }[] }
    const allTabs = split.children.flatMap(child => child.tabs ?? [])
    expect(allTabs.filter(tab => tab.type === 'diff')).toHaveLength(1)
  })

  it('subsequent diffs stack into the existing diff pane', () => {
    const s = state()
    const gitTab = { id: 'git', type: 'git' as const, title: 'Git' }
    const withGit = openTabInBottomPane(s, gitTab)
    const sourcePane = (withGit.bottomSplits as { kind: 'leaf'; id: string }).id
    const first = openDiffTab(withGit, sourcePane, diffTab('diff:w:u:src/a.ts'))
    const second = openDiffTab(first, sourcePane, diffTab('diff:c:abc1234def5678abc1234def5678abc1234def5678'))
    // Still one split: the second diff joins the bottom leaf instead of splitting again.
    expect(second.bottomSplits.kind).toBe('split')
    const split = second.bottomSplits as { children: { kind: string; tabs?: SidebarTab[] }[] }
    const diffLeaves = split.children.filter(child => child.tabs?.some(tab => tab.type === 'diff'))
    expect(diffLeaves).toHaveLength(1)
    expect(diffLeaves[0]!.tabs?.map(tab => tab.id)).toEqual([
      'diff:w:u:src/a.ts',
      'diff:c:abc1234def5678abc1234def5678abc1234def5678',
    ])
  })

  it('openDiffTab degrades to a regular open when the source pane is gone', () => {
    const s = state()
    const after = openDiffTab(s, 'pane:gone', diffTab('diff:w:u:src/a.ts'))
    expect(after.bottomSplits.kind).toBe('leaf')
    expect((after.bottomSplits as { tabs: SidebarTab[] }).tabs.map(tab => tab.id)).toContain('diff:w:u:src/a.ts')
  })

  it('sanitize drops diff tabs (ephemeral, like VSCode diff editors)', () => {
    const valid = sanitizeState({
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:1',
        active: 'd1',
        tabs: [
          { id: 'explorer-tab', type: 'explorer', title: 'Explorer' },
          { id: 'd1', type: 'diff', title: 'a.ts', diff: { kind: 'worktree', path: 'src/a.ts', staged: false } },
        ],
      },
    })
    expect(valid?.bottomSplits.kind).toBe('leaf')
    const tabs = (valid?.bottomSplits as { tabs: SidebarTab[] }).tabs
    expect(tabs.map(tab => tab.id)).toEqual(['explorer-tab'])
    // The dropped diff tab was the active one: the leaf falls back to a null
    // active instead of resetting the whole state.
    expect((valid?.bottomSplits as { active: string | null }).active).toBeNull()
    // A leaf of ONLY diff tabs survives as an empty pane (welcome cards).
    const onlyDiff = sanitizeState({
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:1',
        active: 'd1',
        tabs: [{ id: 'd1', type: 'diff', title: 'a.ts' }],
      },
    })
    expect(onlyDiff?.bottomSplits.kind).toBe('leaf')
    expect((onlyDiff?.bottomSplits as { tabs: SidebarTab[] }).tabs).toEqual([])
  })

  it('sanitize removes a pane emptied by ephemeral diff tabs', () => {
    const valid = sanitizeState({
      nextTerminal: 1,
      activePane: 'pane:diff',
      expanded: [],
      bottomSplits: {
        kind: 'split',
        id: 'split:1',
        dir: 'col',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', id: 'pane:git', active: 'git', tabs: [{ id: 'git', type: 'git', title: 'Git' }] },
          { kind: 'leaf', id: 'pane:diff', active: 'd1', tabs: [{ id: 'd1', type: 'diff', title: 'a.ts' }] },
        ],
      },
    })
    expect(valid?.bottomSplits.kind).toBe('leaf')
    expect((valid?.bottomSplits as { id: string; tabs: SidebarTab[] }).id).toBe('pane:git')
    expect(valid?.activePane).toBe('pane:git')
  })

  it('dedupes the single-instance subagent tab (focuses instead of duplicating)', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'subagent', type: 'subagent', title: 'Subagents' })
    expect((s.bottomSplits as { tabs: unknown[] }).tabs).toHaveLength(1)
    // Reopening (e.g. the auto-activation effect) focuses the existing tab.
    const after = openTabInBottomPane(s, { id: 'subagent', type: 'subagent', title: 'Subagents' })
    expect((after.bottomSplits as { tabs: unknown[] }).tabs).toHaveLength(1)
    const tabs = (after.bottomSplits as { tabs: { type: string; id: string }[] }).tabs
    expect(tabs.filter(tab => tab.type === 'subagent')).toHaveLength(1)
  })

  it('splits panes and moves tabs between them', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    s = splitPane(s, 'row')
    expect(s.bottomSplits.kind).toBe('split')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    expect(split.children).toHaveLength(2)
    const sourceId = (split.children[0] as { id: string }).id
    const otherId = (split.children[1] as { id: string }).id
    expect((split.children[1] as { tabs: unknown[] }).tabs).toHaveLength(0)
    s = moveTab(s, sourceId, 'git', otherId)
    // The source pane emptied and was removed; the target leaf is promoted.
    expect(s.bottomSplits.kind).toBe('leaf')
    expect((s.bottomSplits as { id: string }).id).toBe(otherId)
    expect((s.bottomSplits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual(['git'])
  })

  it('dragging a tab to a pane edge splits the pane with the tab in a fresh leaf', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    s = splitPane(s, 'row')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string; tabs: { id: string }[] }
    const tabId = paneA.tabs[0]!.id
    // 先给 paneB 一个 tab，然后拖 paneA 的 tab 到 paneB 的 right 边缘。
    s = openTabInBottomPane(s, { id: 't2', type: 'terminal', title: 'T2' })
    s = moveTabToEdge(s, paneA.id, tabId, paneB.id, 'right')
    const after = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    // paneB 现在是 split(row) [旧leaf, 新leaf(tabId)]；其父 split 仍存在。
    const bSplit = after.children.find(child => child.kind === 'split') as Extract<SplitNode, { kind: 'split' }> | undefined
    expect(bSplit).toBeDefined()
    expect(bSplit!.dir).toBe('row')
    const newLeaf = bSplit!.children[1] as { tabs: { id: string }[] }
    expect(newLeaf.tabs.map(t => t.id)).toContain(tabId)
  })

  it('dragging a tab to a pane center merges it into the pane', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    s = splitPane(s, 'col')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string; tabs: { id: string }[] }
    const tabId = paneA.tabs[0]!.id
    s = moveTabToEdge(s, paneA.id, tabId, paneB.id, 'center')
    // paneA 空了被移除，树退化为 paneB（含 tab）。
    expect(s.bottomSplits.kind).toBe('leaf')
    expect((s.bottomSplits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual([tabId])
  })

  it('dragging a tab back onto its own pane center reorders it', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    s = openTabInBottomPane(s, { id: 't2', type: 'terminal', title: 'T2' })
    const leaf = s.bottomSplits as { id: string; tabs: { id: string }[] }
    const first = leaf.tabs[0]!.id
    s = moveTabToEdge(s, leaf.id, first, leaf.id, 'center')
    const after = s.bottomSplits as { tabs: { id: string }[] }
    expect(after.tabs[after.tabs.length - 1]!.id).toBe(first)
    expect(after.tabs).toHaveLength(2)
  })

  it('closing the last tab removes the pane (promotes the sibling)', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    s = splitPane(s, 'col')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string }
    // paneA gets a terminal; the git tab moves to paneB; closing the
    // terminal empties paneA, which is removed, promoting paneB.
    s = openTabInBottomPane(s, { id: 't', type: 'terminal', title: 'Terminal 1' })
    s = moveTab(s, paneA.id, 'git', paneB.id)
    s = activateTab(s, paneA.id, 't')
    s = closeTab(s, paneA.id, 't')
    expect(s.bottomSplits.kind).toBe('leaf')
    expect((s.bottomSplits as { id: string }).id).toBe(paneB.id)
  })

  it('resizes splits within the clamp range', () => {
    let s = state()
    s = splitPane(s, 'row')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    const id = split.id
    s = { ...s, bottomSplits: resizeSplit(s.bottomSplits, id, 0, 0.2) }
    const after = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    expect(after.sizes[0]).toBeCloseTo(0.7)
    expect(after.sizes[1]).toBeCloseTo(0.3)
  })

  it('tracks explorer expansion and tab activation', () => {
    let s = state()
    s = toggleExpanded(s, '/p/a')
    s = toggleExpanded(s, '/p/b')
    expect(s.expanded).toEqual(['/p/a', '/p/b'])
    s = toggleExpanded(s, '/p/a')
    expect(s.expanded).toEqual(['/p/b'])
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    const leaf = s.bottomSplits as { id: string; tabs: { id: string }[]; active: string | null }
    const tabId = leaf.tabs[0]!.id
    const after = activateTab(s, leaf.id, tabId)
    expect((after.bottomSplits as { active: string | null }).active).toBe(tabId)
  })

  it('patchTab updates the title and path of one open tab (browser persistence)', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    s = openTabInBottomPane(s, { id: 'browser:1', type: 'browser', title: 'Browser' })
    const browserId = 'browser:1'
    s = patchTab(s, browserId, { path: 'https://example.com/', title: 'example.com' })
    const tab = (s.bottomSplits as { tabs: { id: string; title: string; path?: string }[] }).tabs.find(t => t.id === browserId)
    expect(tab).toMatchObject({ title: 'example.com', path: 'https://example.com/' })
    // A partial patch leaves the other field untouched.
    s = patchTab(s, browserId, { title: 'example.org' })
    const again = (s.bottomSplits as { tabs: { id: string; title: string; path?: string }[] }).tabs.find(t => t.id === browserId)
    expect(again).toMatchObject({ title: 'example.org', path: 'https://example.com/' })
    // Other tabs are untouched.
    const git = (s.bottomSplits as { tabs: { id: string; title: string }[] }).tabs.find(t => t.id === 'git')
    expect(git?.title).toBe('Git')
  })

  it('patchTab is a no-op for a missing tab id', () => {
    const s = state()
    const after = patchTab(s, 'nope', { title: 'X', path: 'https://x/' })
    expect(after).toBe(s)
  })

  it('sanitize accepts nextBrowser (defaulting a missing/malformed one to 1)', () => {
    const base = {
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:1',
        active: null,
        tabs: [{ id: 't', type: 'explorer', title: 'Explorer' }],
      },
    }
    // Older persisted states lack the field: they must keep loading.
    expect(sanitizeState(base)?.nextBrowser).toBe(1)
    // A present valid value survives; a malformed one falls back to 1.
    expect(sanitizeState({ ...base, nextBrowser: 7 })?.nextBrowser).toBe(7)
    expect(sanitizeState({ ...base, nextBrowser: 'x' })?.nextBrowser).toBe(1)
    expect(sanitizeState({ ...base, nextBrowser: 0 })?.nextBrowser).toBe(1)
    // The default state seeds 1.
    expect(makeDefaultState().nextBrowser).toBe(1)
  })

  it('tabOpenIn: a tab is open until it is truly closed, in any pane', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'git', type: 'git', title: 'Git' })
    expect(tabOpenIn(s, 'git')).toBe(true)
    // Moving the tab to another pane keeps it open.
    s = splitPane(s, 'row')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string }
    s = moveTab(s, paneA.id, 'git', paneB.id)
    expect(tabOpenIn(s, 'git')).toBe(true)
    // Closing it removes it from the whole tree.
    const target = s.bottomSplits as { id: string; tabs: { id: string }[] }
    s = closeTab(s, target.id, 'git')
    expect(tabOpenIn(s, 'git')).toBe(false)
    // A terminal tab added later is open too.
    s = openTabInBottomPane(s, { id: 'terminal:9', type: 'terminal', title: 'Terminal 9' })
    expect(tabOpenIn(s, 'terminal:9')).toBe(true)
  })

  // ── Bottom workbench (the plugin's only surface) ───────────────────────

  it('toggleBottomPanel flips the bottom workbench', () => {
    let s = state()
    expect(s.bottomOpen).toBe(false)
    s = toggleBottomPanel(s)
    expect(s.bottomOpen).toBe(true)
    s = toggleBottomPanel(s)
    expect(s.bottomOpen).toBe(false)
  })

  it('setBottomHeight clamps to the contract range', () => {
    expect(setBottomHeight(state(), 50).bottomHeight).toBe(BOTTOM_MIN)
    const g = globalThis as Record<string, unknown>
    const previous = g.window
    g.window = { innerHeight: 800 }
    try {
      // The bottom panel must leave the conversation column at least
      // CONVERSATION_MIN tall (800 - 280).
      expect(setBottomHeight(state(), 9999).bottomHeight).toBe(800 - 280)
    } finally {
      if (previous === undefined) delete g.window
      else g.window = previous
    }
  })

  it('resizeSplitIn resizes a divider in the bottom workbench tree', () => {
    let s = state()
    s = splitPane(s, 'row')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    s = resizeSplitIn(s, split.id, 0, 0.1)
    const next = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    expect(next.sizes[0]).toBeCloseTo(0.6)
  })

  it('sanitize defaults the bottom fields for older persisted states and repairs a broken bottom tree', () => {
    const base = {
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
    }
    // Older persisted states lack the bottom fields: defaults, state kept.
    const s = sanitizeState(base)
    expect(s?.bottomOpen).toBe(false)
    expect(s?.bottomHeight).toBe(BOTTOM_DEFAULT)
    expect(s?.bottomSplits.kind).toBe('leaf')
    expect((s?.bottomSplits as { tabs: SidebarTab[] }).tabs).toHaveLength(0)
    // A malformed bottom tree is replaced with a fresh empty pane.
    const broken = sanitizeState({ ...base, bottomSplits: 'junk' })
    expect(broken?.bottomSplits.kind).toBe('leaf')
    expect((broken?.bottomSplits as { tabs: SidebarTab[] }).tabs).toHaveLength(0)
    // A valid persisted bottom tree survives.
    const withBottom = sanitizeState({
      ...base,
      bottomOpen: true,
      bottomHeight: 300,
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:9',
        active: 'b1',
        tabs: [{ id: 'b1', type: 'terminal', title: 'T' }],
      },
    })
    expect(withBottom?.bottomOpen).toBe(true)
    expect(withBottom?.bottomHeight).toBe(300)
    expect((withBottom?.bottomSplits as { tabs: SidebarTab[] }).tabs.map(t => t.id)).toEqual(['b1'])
    // Heights are clamped to the contract range.
    expect(sanitizeState({ ...base, bottomHeight: 10 })?.bottomHeight).toBe(BOTTOM_MIN)
    // A stale full-height bottom panel must not squeeze the conversation
    // column to zero: sanitizeState applies setBottomHeight's own cap
    // (viewport - CONVERSATION_MIN), so a restored height never snaps on
    // the first drag.
    const g = globalThis as Record<string, unknown>
    const previous = g.window
    g.window = { innerHeight: 800 }
    try {
      expect(sanitizeState({ ...base, bottomHeight: 9999 })?.bottomHeight).toBe(800 - CONVERSATION_MIN)
    } finally {
      if (previous === undefined) delete g.window
      else g.window = previous
    }
  })

  it('tabOpenIn and patchTab see tabs in the bottom workbench', () => {
    let s = state()
    s = openTabInBottomPane(
      s,
      { id: 'browser:1', type: 'browser', title: 'example.com', path: 'https://example.com' },
    )
    expect(tabOpenIn(s, 'browser:1')).toBe(true)
    s = patchTab(s, 'browser:1', { title: 'other.com', path: 'https://other.com' })
    const tab = allLeaves(s.bottomSplits).flatMap(leaf => leaf.tabs).find(t => t.id === 'browser:1')
    expect(tab?.title).toBe('other.com')
  })

  it('moveTab with a non-existent source or target pane is safe', () => {
    const s = state()
    const pane = (s.bottomSplits as { id: string }).id
    // Missing source: returns unchanged state
    expect(moveTab(s, 'pane:ghost', 'tab:1', pane)).toBe(s)
    // Missing target: returns unchanged state
    expect(moveTab(s, pane, 'tab:1', 'pane:ghost')).toBe(s)
  })

  it('closeTab with non-existent tab or pane returns equivalent state without throwing', () => {
    const s = state()
    const pane = (s.bottomSplits as { id: string }).id
    expect(closeTab(s, 'pane:ghost', 'tab:1')).toEqual(s)
    expect(closeTab(s, pane, 'tab:ghost')).toEqual(s)
  })

  it('moveTabToEdge with non-existent pane returns unchanged state', () => {
    const s = state()
    const pane = (s.bottomSplits as { id: string }).id
    expect(moveTabToEdge(s, 'pane:ghost', 'tab:1', pane, 'right')).toBe(s)
    expect(moveTabToEdge(s, pane, 'tab:1', 'pane:ghost', 'right')).toBe(s)
  })
})

describe('persisted state sanitization', () => {
  it('accepts a well-formed state unchanged (node environment: no geometry clamp)', () => {
    const state = makeDefaultState()
    const clean = sanitizeState(JSON.parse(JSON.stringify(state)))
    expect(clean).toEqual(state)
  })

  it('accepts a subagent tab as a known type', () => {
    const raw = JSON.parse(JSON.stringify(makeDefaultState()))
    raw.bottomSplits.tabs.push({ id: 'tab:9', type: 'subagent', title: 'Subagents' })
    raw.bottomSplits.active = 'tab:9'
    const clean = sanitizeState(raw)
    expect(clean).toBeDefined()
    const tabs = (clean!.bottomSplits as { tabs: { type: string }[] }).tabs
    expect(tabs.some(tab => tab.type === 'subagent')).toBe(true)
  })

  it('rejects malformed top-level shapes and repairs a malformed bottom tree', () => {
    expect(sanitizeState(null)).toBeUndefined()
    expect(sanitizeState('nope')).toBeUndefined()
    expect(sanitizeState({})).toBeUndefined()
    // A split whose sizes do not match its children is repaired into a fresh
    // empty pane (workbench fields degrade instead of resetting the state).
    const withSplit = JSON.parse(JSON.stringify(makeDefaultState()))
    withSplit.bottomSplits = { kind: 'split', id: 's1', dir: 'row', sizes: [0.5], children: [] }
    expect(sanitizeState(withSplit)?.bottomSplits.kind).toBe('leaf')
    // Unknown tab types (external plugins not yet loaded) are accepted —
    // they render as <OrphanedTab/> at view time and recover if the plugin
    // loads later. Only diff tabs are dropped (ephemeral).
    const withExternalTab = JSON.parse(JSON.stringify(makeDefaultState()))
    withExternalTab.bottomSplits.tabs.push({ id: 'tab:9', type: 'my-plugin:db', title: 'DB' })
    withExternalTab.bottomSplits.active = 'tab:9'
    const externalClean = sanitizeState(withExternalTab)
    expect(externalClean).toBeDefined()
    if (externalClean !== undefined && externalClean.bottomSplits.kind === 'leaf') {
      expect(externalClean.bottomSplits.tabs[0]!.type).toBe('my-plugin:db')
    }
    // An active id that no tab carries is structural corruption: the tree is
    // repaired into a fresh empty pane.
    const withBadActive = JSON.parse(JSON.stringify(makeDefaultState()))
    withBadActive.bottomSplits.active = 'ghost-tab'
    const repaired = sanitizeState(withBadActive)
    expect(repaired).toBeDefined()
    expect((repaired!.bottomSplits as { tabs: unknown[] }).tabs).toEqual([])
  })

  it('re-ids stale duplicate pane/split ids and follows the activePane rename', () => {
    // The pre-seeding counter reset could mint a fresh "pane:1" beside the
    // persisted "pane:1": mapLeaf then hit BOTH leaves and every open landed
    // in both panes. Sanitize must give the repeat a fresh id.
    const corrupted = JSON.parse(JSON.stringify(makeDefaultState()))
    corrupted.activePane = 'pane:1'
    corrupted.bottomSplits = {
      kind: 'split',
      id: 'split:1',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'pane:1', tabs: [], active: null },
        { kind: 'leaf', id: 'pane:1', tabs: [{ id: 'tab:1', type: 'explorer', title: 'Explorer' }], active: 'tab:1' },
      ],
    }
    const clean = sanitizeState(corrupted)
    expect(clean).toBeDefined()
    const leaves = allLeaves(clean!.bottomSplits)
    // The empty first occurrence is pruned; the populated repeat keeps its
    // fresh unique id and becomes active.
    expect(leaves).toHaveLength(1)
    expect(leaves[0]!.id).not.toBe('pane:1')
    expect(clean!.activePane).toBe(leaves[0]!.id)
    // And an open must land in exactly one pane of the healed tree.
    const opened = openTabInBottomPane(clean!, { id: 'editor:/a.ts', type: 'editor', title: 'a.ts', path: '/a.ts' })
    const owners = allLeaves(opened.bottomSplits).filter(leaf => leaf.tabs.some(tab => tab.path === '/a.ts'))
    expect(owners).toHaveLength(1)
  })

  it('falls back from a stale active pane instead of dropping the open', () => {
    let s = makeDefaultState()
    const paneA = allLeaves(s.bottomSplits)[0]!.id
    s = openTabInBottomPane(s, { id: 'editor:/a.ts', type: 'editor', title: 'a.ts', path: '/a.ts' })
    const split = insertLeafAt(s.bottomSplits, paneA, 'col', { id: 'terminal:1', type: 'terminal', title: 'Terminal 1' }, false)
    s = { ...s, bottomSplits: split.node, activePane: paneA }
    // Closing the editor empties paneA; the pane is removed but activePane
    // still points at it. The next open must land in the surviving pane.
    s = closeTab(s, paneA, 'editor:/a.ts')
    s = openTabInBottomPane(s, { id: 'editor:/b.ts', type: 'editor', title: 'b.ts', path: '/b.ts' })
    const owners = allLeaves(s.bottomSplits).filter(leaf => leaf.tabs.some(tab => tab.path === '/b.ts'))
    expect(owners).toHaveLength(1)
    expect(owners[0]!.tabs.some(tab => tab.type === 'terminal')).toBe(true)
  })

  it('handles state with deeply corrupted split children gracefully', () => {
    const corrupted = {
      ...makeDefaultState(),
      bottomSplits: {
        kind: 'split',
        id: 's1',
        dir: 'row',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', id: 'pane:1', tabs: null, active: null },
          { kind: 'leaf', id: 'pane:2', tabs: [{ id: 'tab:1', type: 'explorer', title: 'Explorer' }], active: 'tab:1' },
        ],
      },
    }
    // The whole tree is malformed: it is replaced with a fresh empty pane
    // instead of crashing the workbench on mount.
    const repaired = sanitizeState(corrupted)
    expect(repaired).toBeDefined()
    expect(repaired!.bottomSplits.kind).toBe('leaf')
    expect((repaired!.bottomSplits as { tabs: unknown[] }).tabs).toEqual([])
  })
})

describe('v0.12.0 store additions', () => {
  // These blocks exercise store reduce/reduceFor (which schedule the
  // localStorage persist through window timers) and sanitizeState (which
  // reads window.innerHeight). Stub the browser globals ONLY inside this
  // scope so the earlier describes keep their window-less environment.
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>
    g.window = { clearTimeout: () => {}, setTimeout: () => 0, innerWidth: 1024, innerHeight: 800 }
    g.localStorage = { getItem: () => null, setItem: () => {} }
  })
  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    delete g.window
    delete g.localStorage
  })

  describe('store.reduceFor (targeted opens, v0.12.0)', () => {
    it('mutates the target session, persists it, and leaves the active snapshot untouched', () => {
      const store = createSidebarStore()
      store.setSession('s1')
      let calls = 0
      store.subscribe(() => { calls++ })
      store.reduceFor('s2', (state) => ({ ...state, expanded: ['/x'] }))
      // No notify, no snapshot switch.
      expect(calls).toBe(0)
      expect(store.getSnapshot().sessionId).toBe('s1')
      // The target session's state updated and loads back on switch.
      store.setSession('s2')
      expect(store.getSnapshot().state?.expanded).toEqual(['/x'])
    })

    it('loads a fresh state for a never-visited target session', () => {
      const store = createSidebarStore()
      store.setSession('s1')
      store.reduceFor('brand-new', (state) => ({ ...state, bottomOpen: true }))
      store.setSession('brand-new')
      expect(store.getSnapshot().state?.bottomOpen).toBe(true)
      expect(store.getSnapshot().state?.bottomSplits).toBeDefined()
    })

    it('reduceFor never lowers the shared uid counter below the active session needs (no pane-id collision)', () => {
      const store = createSidebarStore()
      // Session 'b' is cached FIRST with a LOW id range (pane:1 / tab:2).
      store.setSession('b')
      // Session 'a' then loads and its operations raise the shared counter
      // well above b's max (default pane, plus fresh pane ids from splits).
      store.setSession('a')
      store.reduce(s => splitPane(s, 'row'))
      const before = allLeaves(store.getSnapshot().state!.bottomSplits).map(leaf => leaf.id).sort()
      // A targeted reduce into the OLD, low-id session must not lower the
      // counter: the next split in the ACTIVE session would otherwise mint
      // an id that already exists (mapLeaf visits both leaves → corruption).
      store.reduceFor('b', (state) => state)
      store.reduce(s => splitPane(s, 'row'))
      const after = allLeaves(store.getSnapshot().state!.bottomSplits).map(leaf => leaf.id)
      expect(new Set(after).size).toBe(after.length)
      // The active session's pre-existing pane ids all survived untouched.
      for (const id of before) expect(after).toContain(id)
    })

    it('persists each session independently (per-session debounce timers)', () => {
      const g = globalThis as Record<string, unknown>
      let seq = 0
      const timers = new Map<number, () => void>()
      const writes: string[] = []
      g.window = {
        clearTimeout: (id: number) => { timers.delete(id) },
        setTimeout: (fn: () => void) => { const id = ++seq; timers.set(id, fn); return id },
        innerWidth: 1024,
        innerHeight: 800,
      }
      g.localStorage = {
        getItem: () => null,
        setItem: (key: string) => { writes.push(key) },
      }
      try {
        const store = createSidebarStore()
        store.setSession('a')
        store.reduce(s => ({ ...s, expanded: ['/a'] })) // schedules persist(a)
        store.reduceFor('b', s => ({ ...s, expanded: ['/b'] })) // schedules persist(b)
        // A shared timer would have cancelled persist(a) — with per-session
        // timers BOTH writes are pending and both land when they fire.
        expect(timers.size).toBe(2)
        for (const [, fn] of [...timers]) fn()
        expect(writes).toEqual(['dsh-sidebar:v1:a', 'dsh-sidebar:v1:b'])
      } finally {
        delete g.window
        delete g.localStorage
      }
    })
  })

  describe('tab meta persistence (v0.12.0)', () => {
    it('sanitizeState carries plugin meta through a reload round-trip', () => {
      const store = createSidebarStore()
      store.setSession('s1')
      store.reduce(s => ({
        ...s,
        bottomSplits: {
          kind: 'leaf' as const,
          id: 'pane:1',
          tabs: [{ id: 'tab:1', type: 'db', title: 'DB', meta: { q: [1, 2], n: 0 } }],
          active: 'tab:1',
        },
      }))
      const sanitized = sanitizeState(JSON.parse(JSON.stringify(store.getSnapshot().state!)))
      const tabs = allLeaves(sanitized!.bottomSplits).flatMap(leaf => leaf.tabs)
      expect(tabs[0]?.meta).toEqual({ q: [1, 2], n: 0 })
    })
  })
})

describe('revealPaths (show in folder)', () => {
  it('expands ancestors with their ABSOLUTE path (leading separator preserved)', () => {
    // POSIX: the root (/w/src) is not itself expanded, but the subdirs
    // below it must be recorded as ABSOLUTE paths so FileTree's
    // `expanded.includes(entry.path)` matches.
    const base = makeDefaultState()
    const next = revealPaths(base, '/w/src', ['/w/src/sub/deep/a.ts'])
    expect(next.revealed).toEqual(['/w/src/sub/deep/a.ts'])
    expect(next.expanded).toContain('/w/src/sub')
    expect(next.expanded).toContain('/w/src/sub/deep')
    expect(next.expanded).not.toContain('w/src/sub')
    expect(next.expanded).not.toContain('/w/src')
  })

  it('keeps a Windows drive-letter root and a UNC prefix', () => {
    const drive = revealPaths(makeDefaultState(), 'C:\\work', ['C:\\work\\src\\a.ts'])
    expect(drive.expanded).toContain('C:\\work\\src')
    const unc = revealPaths(makeDefaultState(), '\\\\server\\share', ['\\\\server\\share\\sub\\a.ts'])
    expect(unc.expanded).toContain('\\\\server\\share\\sub')
  })

  it('resolves nothing to the same reference (no churn)', () => {
    const base = makeDefaultState()
    expect(revealPaths(base, '/w', [])).toBe(base)
  })
})

describe('pinned terminals (v0.17.0)', () => {
  // setTabPin reads neither window nor localStorage directly, but the
  // pinnedTab-aware sanitize round-trip below uses JSON.parse/stringify
  // only — keep this block window-less for parity with the main describe.
  const state = (): SidebarState => makeDefaultState()

  it('setTabPin marks a terminal in the workbench', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'terminal:1', type: 'terminal', title: 'T' })
    s = setTabPin(s, 'terminal:1', { scope: 'workspace', homeCwd: '/proj' })
    const tab = allLeaves(s.bottomSplits).flatMap(l => l.tabs).find(t => t.id === 'terminal:1')!
    expect(tab.pin).toEqual({ scope: 'workspace', homeCwd: '/proj' })
  })

  it('setTabPin with null clears the pin marker but keeps the tab', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'terminal:1', type: 'terminal', title: 'T' })
    s = setTabPin(s, 'terminal:1', { scope: 'global' })
    s = setTabPin(s, 'terminal:1', null)
    const tab = allLeaves(s.bottomSplits).flatMap(l => l.tabs).find(t => t.id === 'terminal:1')!
    expect(tab.pin).toBeUndefined()
    expect(tabOpenIn(s, 'terminal:1')).toBe(true)
  })

  it('setTabPin on an unknown tab id is a strict same-reference no-op', () => {
    const s = state()
    expect(setTabPin(s, 'ghost', { scope: 'global' })).toBe(s)
    expect(setTabPin(s, 'ghost', null)).toBe(s)
  })

  it('setTabPin is idempotent: setting the same pin twice returns the same reference', () => {
    let s = state()
    s = openTabInBottomPane(s, { id: 'terminal:1', type: 'terminal', title: 'T' })
    s = setTabPin(s, 'terminal:1', { scope: 'workspace', homeCwd: '/p' })
    const once = s
    s = setTabPin(s, 'terminal:1', { scope: 'workspace', homeCwd: '/p' })
    expect(s).toBe(once)
  })

  it('sanitizeState preserves a legal pin and strips an illegal scope (keeps the tab)', () => {
    const g = globalThis as Record<string, unknown>
    g.window = { clearTimeout: () => {}, setTimeout: () => 0, innerWidth: 1024, innerHeight: 768 }
    g.localStorage = { getItem: () => null, setItem: () => {} }
    try {
      const legal = JSON.parse(JSON.stringify(makeDefaultState())) as {
        bottomSplits: { kind: 'leaf'; id: string; tabs: SidebarTab[]; active: string | null }
      }
      legal.bottomSplits.tabs.push({
        id: 'terminal:1', type: 'terminal', title: 'T',
        pin: { scope: 'workspace', homeCwd: '/proj' },
      } as SidebarTab)
      legal.bottomSplits.active = 'terminal:1'
      const restored = sanitizeState(legal)!
      const tab = (restored.bottomSplits as { tabs: SidebarTab[] }).tabs.find(t => t.id === 'terminal:1')!
      expect(tab.pin).toEqual({ scope: 'workspace', homeCwd: '/proj' })

      // Illegal scope drops the pin, keeps the tab.
      const illegal = JSON.parse(JSON.stringify(makeDefaultState())) as {
        bottomSplits: { kind: 'leaf'; id: string; tabs: SidebarTab[]; active: string | null }
      }
      illegal.bottomSplits.tabs.push({
        id: 'terminal:2', type: 'terminal', title: 'T2',
        pin: { scope: 'bogus', homeCwd: '/x' },
      } as unknown as SidebarTab)
      illegal.bottomSplits.active = 'terminal:2'
      const cleaned = sanitizeState(illegal)!
      const tab2 = (cleaned.bottomSplits as { tabs: SidebarTab[] }).tabs.find(t => t.id === 'terminal:2')!
      expect(tab2.pin).toBeUndefined()
      expect(tab2.id).toBe('terminal:2')

      // Non-string homeCwd drops homeCwd but keeps a global pin.
      const weirdHome = JSON.parse(JSON.stringify(makeDefaultState())) as {
        bottomSplits: { kind: 'leaf'; id: string; tabs: SidebarTab[]; active: string | null }
      }
      weirdHome.bottomSplits.tabs.push({
        id: 'terminal:3', type: 'terminal', title: 'T3',
        pin: { scope: 'global', homeCwd: 42 },
      } as unknown as SidebarTab)
      weirdHome.bottomSplits.active = 'terminal:3'
      const weird = sanitizeState(weirdHome)!
      const tab3 = (weird.bottomSplits as { tabs: SidebarTab[] }).tabs.find(t => t.id === 'terminal:3')!
      expect(tab3.pin).toEqual({ scope: 'global' })

      // Older state without pin loads unchanged.
      const legacy = JSON.parse(JSON.stringify(makeDefaultState())) as {
        bottomSplits: { kind: 'leaf'; id: string; tabs: SidebarTab[]; active: string | null }
      }
      legacy.bottomSplits.tabs.push({ id: 'terminal:4', type: 'terminal', title: 'T4' } as SidebarTab)
      legacy.bottomSplits.active = 'terminal:4'
      const legacyRestored = sanitizeState(legacy)!
      const tab4 = (legacyRestored.bottomSplits as { tabs: SidebarTab[] }).tabs.find(t => t.id === 'terminal:4')!
      expect(tab4.pin).toBeUndefined()
    } finally {
      delete g.window
      delete g.localStorage
    }
  })
})


describe('URL reset escape hatch (issue #369)', () => {
  // Same browser-global stubs as the v0.12.0 block above; loadState reads
  // window.location.search (reset param) and localStorage (persisted state).
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>
    g.window = { clearTimeout: () => {}, setTimeout: () => 0, innerWidth: 1024, innerHeight: 800, location: { search: '' } }
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  })
  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    delete g.window
    delete g.localStorage
  })

  /** A persisted layout whose restored git tab would re-hang the page. */
  const frozenState = JSON.stringify({
    nextTerminal: 1,
    activePane: 'pane:1',
    expanded: [],
    bottomSplits: { kind: 'leaf', id: 'pane:1', active: 'g1', tabs: [{ id: 'g1', type: 'git', title: 'Git' }] },
  })

  const searchOf = (): { search: string } =>
    (globalThis as unknown as { window: { location: { search: string } } }).window.location

  it('restores the persisted layout when the param is absent', () => {
    const g = globalThis as Record<string, unknown>
    g.localStorage = {
      getItem: (key: string) => (key === 'dsh-sidebar:v1:s1' ? frozenState : null),
      setItem: () => {},
      removeItem: () => {},
    }
    const store = createSidebarStore()
    store.setSession('s1')
    const leaf = store.getSnapshot().state!.bottomSplits as { tabs: { type: string }[] }
    expect(leaf.tabs.map(tab => tab.type)).toEqual(['git'])
  })

  it('?dsh-sidebar-reset drops the persisted layout and clears the stored copy', () => {
    const g = globalThis as Record<string, unknown>
    const removed: string[] = []
    g.localStorage = {
      getItem: (key: string) => (key === 'dsh-sidebar:v1:s1' ? frozenState : null),
      setItem: () => {},
      removeItem: (key: string) => { removed.push(key) },
    }
    searchOf().search = '?dsh-sidebar-reset'
    const store = createSidebarStore()
    store.setSession('s1')
    // The default layout (an empty workbench) — NOT the frozen git-only state.
    const leaf = store.getSnapshot().state!.bottomSplits as { tabs: { type: string }[] }
    expect(leaf.tabs.map(tab => tab.type)).toEqual([])
    // The stored copy is gone, so reloading without the param cannot restore
    // the hanging layout either.
    expect(removed).toContain('dsh-sidebar:v1:s1')
  })

  it('the reset param tolerates a value (?dsh-sidebar-reset=1)', () => {
    searchOf().search = '?foo=bar&dsh-sidebar-reset=1'
    const store = createSidebarStore()
    store.setSession('s1')
    const leaf = store.getSnapshot().state!.bottomSplits as { tabs: { type: string }[] }
    expect(leaf.tabs.map(tab => tab.type)).toEqual([])
  })
})
