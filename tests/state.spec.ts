import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activateTab, allLeaves, BOTTOM_DEFAULT, BOTTOM_MIN, closeFloatByTab, closeTab, createSidebarStore,
  dockFloat, FLOAT_MIN_H, FLOAT_MIN_W, floatTab, floatWithTab, insertLeafAt, makeDefaultState,
  migrateBottomTabs, moveFloat, moveTab, moveTabToEdge, openDiffTab,
  openTabInActivePane, patchTab, raiseFloat, reconcileAgentTerminals, resizeFloat, resizeSplit,
  resizeSplitIn, revealPaths, sanitizeState, setBottomHeight,
  splitPane, tabOpenIn, toggleBottomPanel, toggleExpanded, togglePanel,
  type SidebarLeaf, type SidebarState, type SidebarTab, type SplitNode,
} from '../src/client/state.ts'

describe('sidebar state', () => {
  const state = (): SidebarState => makeDefaultState()

  it('makeDefaultState seeds per the seed enum (editor-home / none)', () => {
    // Default and explicit 'editor-home' seed an EMPTY editor tab (the files
    // window) with the tree panel pinned open.
    for (const s of [makeDefaultState(), makeDefaultState(400, true, 'editor-home')]) {
      const leaf = s.splits as { tabs: SidebarTab[]; active: string | null }
      expect(leaf.tabs).toHaveLength(1)
      expect(leaf.tabs[0]!.type).toBe('editor')
      expect(leaf.tabs[0]!.title).toBe('Files')
      expect(leaf.tabs[0]!.path).toBeUndefined()
      expect(leaf.tabs[0]!.meta).toEqual({ treeOpen: true })
      expect(leaf.active).toBe(leaf.tabs[0]!.id)
    }
    // The seeded home tab survives the persist round-trip (meta intact).
    const restored = sanitizeState(JSON.parse(JSON.stringify(makeDefaultState())))
    const restoredLeaf = restored!.splits as { tabs: SidebarTab[] }
    expect(restoredLeaf.tabs[0]!.meta).toEqual({ treeOpen: true })
    // 'none' seeds an empty pane.
    const bare = makeDefaultState(400, true, 'none')
    const bareLeaf = bare.splits as { tabs: SidebarTab[]; active: string | null }
    expect(bareLeaf.tabs).toHaveLength(0)
    expect(bareLeaf.active).toBeNull()
  })

  it('sanitizeState migrates persisted explorer tabs to editor home tabs (both trees)', () => {
    const valid = sanitizeState({
      panelOpen: true,
      width: 400,
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      splits: {
        kind: 'leaf',
        id: 'pane:1',
        active: 'ex-right',
        tabs: [{ id: 'ex-right', type: 'explorer', title: 'Explorer', meta: { treeWidth: 300 } }],
      },
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:b',
        active: 'ex-bottom',
        tabs: [{ id: 'ex-bottom', type: 'explorer', title: 'Explorer' }],
      },
    })
    const right = (valid?.splits as { tabs: SidebarTab[] }).tabs
    expect(right).toHaveLength(1)
    // Migrated: editor home tab (no path), tree pinned open, prior meta kept.
    expect(right[0]).toMatchObject({ id: 'ex-right', type: 'editor', title: 'Files', meta: { treeOpen: true, treeWidth: 300 } })
    expect(right[0]!.path).toBeUndefined()
    const bottom = (valid?.bottomSplits as { tabs: SidebarTab[] }).tabs
    expect(bottom).toHaveLength(1)
    expect(bottom[0]).toMatchObject({ id: 'ex-bottom', type: 'editor', title: 'Files', meta: { treeOpen: true } })
  })

  it('opens tabs into the active pane and dedupes by id (safety net)', () => {
    let s = state()
    const gitTab = { id: 'git', type: 'git' as const, title: 'Git' }
    s = openTabInActivePane(s, gitTab)
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { tabs: unknown[] }).tabs).toHaveLength(2)
    // Reopening with the SAME id focuses the existing tab instead of duplicating.
    const after = openTabInActivePane(s, { id: 'git', type: 'git' as const, title: 'Git' })
    expect((after.splits as { tabs: unknown[] }).tabs).toHaveLength(2)
    // A different id opens a new tab (type-level dedupe is the service's job).
    const after2 = openTabInActivePane(s, { id: 'git2', type: 'git' as const, title: 'Git' })
    expect((after2.splits as { tabs: unknown[] }).tabs).toHaveLength(3)
  })

  it('opens multiple editors with distinct ids (path-level dedupe is the service descriptor\'s job)', () => {
    let s = state()
    const firstId = (s.splits as { tabs: { id: string }[] }).tabs[0]!.id
    s = openTabInActivePane(s, { id: 'e1', type: 'editor', title: 'a.ts', path: '/p/a.ts' })
    const after = openTabInActivePane(s, { id: 'e2', type: 'editor', title: 'a.ts', path: '/p/a.ts' })
    expect((after.splits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual([firstId, 'e1', 'e2'])
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
    const withGit = openTabInActivePane(s, gitTab)
    const sourcePane = (withGit.splits as { kind: 'leaf'; id: string }).id
    const after = openDiffTab(withGit, sourcePane, diffTab('diff:w:u:src/a.ts'))
    expect(after.splits.kind).toBe('split')
    const split = after.splits as { dir: string; children: { kind: string; tabs?: SidebarTab[]; id: string }[] }
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
    const withGit = openTabInActivePane(s, gitTab)
    const sourcePane = (withGit.splits as { kind: 'leaf'; id: string }).id
    const first = openDiffTab(withGit, sourcePane, diffTab('diff:w:u:src/a.ts'))
    const second = openDiffTab(first, sourcePane, diffTab('diff:w:u:src/a.ts'))
    // No new panes, no duplicate tabs.
    expect(second.splits.kind).toBe('split')
    const split = second.splits as { children: { kind: string; tabs?: SidebarTab[] }[] }
    const allTabs = split.children.flatMap(child => child.tabs ?? [])
    expect(allTabs.filter(tab => tab.type === 'diff')).toHaveLength(1)
  })

  it('subsequent diffs stack into the existing diff pane', () => {
    const s = state()
    const gitTab = { id: 'git', type: 'git' as const, title: 'Git' }
    const withGit = openTabInActivePane(s, gitTab)
    const sourcePane = (withGit.splits as { kind: 'leaf'; id: string }).id
    const first = openDiffTab(withGit, sourcePane, diffTab('diff:w:u:src/a.ts'))
    const second = openDiffTab(first, sourcePane, diffTab('diff:c:abc1234def5678abc1234def5678abc1234def5678'))
    // Still one split: the second diff joins the bottom leaf instead of splitting again.
    expect(second.splits.kind).toBe('split')
    const split = second.splits as { children: { kind: string; tabs?: SidebarTab[] }[] }
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
    expect(after.splits.kind).toBe('leaf')
    expect((after.splits as { tabs: SidebarTab[] }).tabs.map(tab => tab.id)).toContain('diff:w:u:src/a.ts')
  })

  it('sanitize drops diff tabs (ephemeral, like VSCode diff editors)', () => {
    const valid = sanitizeState({
      panelOpen: true,
      width: 400,
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      splits: {
        kind: 'leaf',
        id: 'pane:1',
        active: 'd1',
        tabs: [
          { id: 'explorer-tab', type: 'explorer', title: 'Explorer' },
          { id: 'd1', type: 'diff', title: 'a.ts', diff: { kind: 'worktree', path: 'src/a.ts', staged: false } },
        ],
      },
    })
    expect(valid?.splits.kind).toBe('leaf')
    const tabs = (valid?.splits as { tabs: SidebarTab[] }).tabs
    expect(tabs.map(tab => tab.id)).toEqual(['explorer-tab'])
    // The dropped diff tab was the active one: the leaf falls back to a null
    // active instead of resetting the whole state.
    expect((valid?.splits as { active: string | null }).active).toBeNull()
    // A leaf of ONLY diff tabs survives as an empty pane (welcome cards).
    const onlyDiff = sanitizeState({
      panelOpen: true,
      width: 400,
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      splits: {
        kind: 'leaf',
        id: 'pane:1',
        active: 'd1',
        tabs: [{ id: 'd1', type: 'diff', title: 'a.ts' }],
      },
    })
    expect(onlyDiff?.splits.kind).toBe('leaf')
    expect((onlyDiff?.splits as { tabs: SidebarTab[] }).tabs).toEqual([])
  })

  it('sanitize removes a pane emptied by ephemeral diff tabs', () => {
    const valid = sanitizeState({
      panelOpen: true,
      width: 400,
      nextTerminal: 1,
      activePane: 'pane:diff',
      expanded: [],
      splits: {
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
    expect(valid?.splits.kind).toBe('leaf')
    expect((valid?.splits as { id: string; tabs: SidebarTab[] }).id).toBe('pane:git')
    expect(valid?.activePane).toBe('pane:git')
  })

  it('dedupes the single-instance subagent tab (focuses instead of duplicating)', () => {
    let s = state()
    s = openTabInActivePane(s, { id: 'subagent', type: 'subagent', title: 'Subagents' })
    expect((s.splits as { tabs: unknown[] }).tabs).toHaveLength(2)
    // Reopening (e.g. the auto-activation effect) focuses the existing tab.
    const after = openTabInActivePane(s, { id: 'subagent', type: 'subagent', title: 'Subagents' })
    expect((after.splits as { tabs: unknown[] }).tabs).toHaveLength(2)
    const tabs = (after.splits as { tabs: { type: string; id: string }[] }).tabs
    expect(tabs.filter(tab => tab.type === 'subagent')).toHaveLength(1)
  })

  it('splits panes and moves tabs between them', () => {
    let s = state()
    s = splitPane(s, 'row')
    expect(s.splits.kind).toBe('split')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    expect(split.children).toHaveLength(2)
    const explorerId = (split.children[0] as { id: string }).id
    const otherId = (split.children[1] as { id: string }).id
    expect((split.children[1] as { tabs: unknown[] }).tabs).toHaveLength(0)
    const explorerTab = ((split.children[0] as { tabs: { id: string }[] }).tabs[0]!).id
    s = moveTab(s, explorerId, explorerTab, otherId)
    // The source pane emptied and was removed; the target leaf is promoted.
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { id: string }).id).toBe(otherId)
    expect((s.splits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual([explorerTab])
  })

  it('dragging a tab to a pane edge splits the pane with the tab in a fresh leaf', () => {
    let s = state()
    s = splitPane(s, 'row')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string; tabs: { id: string }[] }
    const tabId = paneA.tabs[0]!.id
    // 先给 paneB 一个 tab，然后拖 paneA 的 tab 到 paneB 的 right 边缘。
    s = openTabInActivePane(s, { id: 't2', type: 'terminal', title: 'T2' })
    s = moveTabToEdge(s, paneA.id, tabId, paneB.id, 'right')
    const after = s.splits as Extract<SplitNode, { kind: 'split' }>
    // paneB 现在是 split(row) [旧leaf, 新leaf(tabId)]；其父 split 仍存在。
    const bSplit = after.children.find(child => child.kind === 'split') as Extract<SplitNode, { kind: 'split' }> | undefined
    expect(bSplit).toBeDefined()
    expect(bSplit!.dir).toBe('row')
    const newLeaf = bSplit!.children[1] as { tabs: { id: string }[] }
    expect(newLeaf.tabs.map(t => t.id)).toContain(tabId)
  })

  it('dragging a tab to a pane center merges it into the pane', () => {
    let s = state()
    s = splitPane(s, 'col')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string; tabs: { id: string }[] }
    const tabId = paneA.tabs[0]!.id
    s = moveTabToEdge(s, paneA.id, tabId, paneB.id, 'center')
    // paneA 空了被移除，树退化为 paneB（含 tab）。
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { tabs: { id: string }[] }).tabs.map(t => t.id)).toEqual([tabId])
  })

  it('dragging a tab back onto its own pane center reorders it', () => {
    let s = state()
    s = openTabInActivePane(s, { id: 't2', type: 'terminal', title: 'T2' })
    const leaf = s.splits as { id: string; tabs: { id: string }[] }
    const first = leaf.tabs[0]!.id
    s = moveTabToEdge(s, leaf.id, first, leaf.id, 'center')
    const after = s.splits as { tabs: { id: string }[] }
    expect(after.tabs[after.tabs.length - 1]!.id).toBe(first)
    expect(after.tabs).toHaveLength(2)
  })

  it('closing the last tab removes the pane (promotes the sibling)', () => {
    let s = state()
    s = splitPane(s, 'col')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string }
    const explorerId = paneA.tabs[0]!.id
    // paneA gets a terminal; the explorer moves to paneB; closing the
    // terminal empties paneA, which is removed, promoting paneB.
    s = openTabInActivePane(s, { id: 't', type: 'terminal', title: 'Terminal 1' })
    s = moveTab(s, paneA.id, explorerId, paneB.id)
    s = activateTab(s, paneA.id, 't')
    s = closeTab(s, paneA.id, 't')
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { id: string }).id).toBe(paneB.id)
  })

  it('resizes splits within the clamp range', () => {
    let s = state()
    s = splitPane(s, 'row')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const id = split.id
    s = { ...s, splits: resizeSplit(s.splits, id, 0, 0.2) }
    const after = s.splits as Extract<SplitNode, { kind: 'split' }>
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
    const leaf = s.splits as { id: string; tabs: { id: string }[]; active: string | null }
    const tabId = leaf.tabs[0]!.id
    const after = activateTab(s, leaf.id, tabId)
    expect((after.splits as { active: string | null }).active).toBe(tabId)
  })

  it('patchTab updates the title and path of one open tab (browser persistence)', () => {
    let s = state()
    const leaf = s.splits as { id: string; tabs: { id: string; type: string; title: string; path?: string }[] }
    s = openTabInActivePane(s, { id: 'browser:1', type: 'browser', title: 'Browser' })
    const browserId = 'browser:1'
    s = patchTab(s, browserId, { path: 'https://example.com/', title: 'example.com' })
    const tab = (s.splits as { tabs: { id: string; title: string; path?: string }[] }).tabs.find(t => t.id === browserId)
    expect(tab).toMatchObject({ title: 'example.com', path: 'https://example.com/' })
    // A partial patch leaves the other field untouched.
    s = patchTab(s, browserId, { title: 'example.org' })
    const again = (s.splits as { tabs: { id: string; title: string; path?: string }[] }).tabs.find(t => t.id === browserId)
    expect(again).toMatchObject({ title: 'example.org', path: 'https://example.com/' })
    // Other tabs are untouched.
    expect(leaf.tabs[0]).toBeDefined()
  })

  it('patchTab is a no-op for a missing tab id', () => {
    const s = state()
    const after = patchTab(s, 'nope', { title: 'X', path: 'https://x/' })
    expect(after).toBe(s)
  })

  it('sanitize accepts nextBrowser (defaulting a missing/malformed one to 1)', () => {
    const base = {
      panelOpen: true,
      width: 400,
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      splits: {
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

  it('tabOpenIn: a tab is open until it is truly closed, wherever it lives', () => {
    let s = state()
    const leaf = s.splits as { id: string; tabs: { id: string }[] }
    const explorerId = leaf.tabs[0]!.id
    expect(tabOpenIn(s, explorerId)).toBe(true)
    // Moving the tab to another pane keeps it open.
    s = splitPane(s, 'row')
    const split = s.splits as Extract<SplitNode, { kind: 'split' }>
    const paneA = split.children[0] as { id: string; tabs: { id: string }[] }
    const paneB = split.children[1] as { id: string }
    s = moveTab(s, paneA.id, explorerId, paneB.id)
    expect(tabOpenIn(s, explorerId)).toBe(true)
    // Closing it removes it from the whole tree.
    const target = s.splits as { id: string; tabs: { id: string }[] }
    s = closeTab(s, target.id, explorerId)
    expect(tabOpenIn(s, explorerId)).toBe(false)
    // A terminal tab added later is open too.
    s = openTabInActivePane(s, { id: 'terminal:9', type: 'terminal', title: 'Terminal 9' })
    expect(tabOpenIn(s, 'terminal:9')).toBe(true)
  })

  // ── Bottom panel (the second, independent workbench) ───────────────────

  it('toggleBottomPanel flips the bottom panel independently of the right panel', () => {
    let s = state()
    expect(s.bottomOpen).toBe(false)
    s = toggleBottomPanel(s)
    expect(s.bottomOpen).toBe(true)
    // Collapsing the right panel leaves the bottom panel open (independent toggles).
    s = togglePanel(s)
    expect(s.panelOpen).toBe(false)
    expect(s.bottomOpen).toBe(true)
  })

  it('setBottomHeight clamps to the contract range', () => {
    expect(setBottomHeight(state(), 50).bottomHeight).toBe(BOTTOM_MIN)
    const g = globalThis as Record<string, unknown>
    const previous = g.window
    g.window = { innerHeight: 800 }
    try {
      // The bottom panel must leave the center column at least PANEL_MIN
      // tall (800 - 280), regardless of the right panel's open state.
      expect(setBottomHeight(state(), 9999).bottomHeight).toBe(800 - 280)
      expect(setBottomHeight({ ...state(), panelOpen: false }, 9999).bottomHeight).toBe(800 - 280)
    } finally {
      if (previous === undefined) delete g.window
      else g.window = previous
    }
  })

  // ── Narrow-viewport merge (bottom tabs thrown into the right sidebar) ──

  it('migrateBottomTabs throws the bottom tree tabs into the right tree’s FIRST leaf', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    // Two bottom tabs in their own pane; the right pane holds explorer.
    s = openTabInActivePane({ ...s, activePane: bottomPane }, { id: 'terminal:1', type: 'terminal', title: 'T1' })
    s = openTabInActivePane(s, { id: 'terminal:2', type: 'terminal', title: 'T2' })
    const migrated = migrateBottomTabs(s)
    // All tabs now live in the right tree's first leaf, bottom tabs appended.
    expect((migrated.splits as { tabs: SidebarTab[] }).tabs.map(t => t.id))
      .toEqual([expect.stringMatching(/^tab:/), 'terminal:1', 'terminal:2'])
    // The bottom tree is emptied (structure stays), the panel closes, and
    // new tabs land in the right tree.
    expect((migrated.bottomSplits as { tabs: SidebarTab[] }).tabs).toHaveLength(0)
    expect(migrated.bottomOpen).toBe(false)
    expect(migrated.activePane).toBe((migrated.splits as { id: string }).id)
    // The migrated tabs are fully functional: closing one works through the
    // right tree.
    expect(tabOpenIn(migrated, 'terminal:1')).toBe(true)
    expect(tabOpenIn(closeTab(migrated, migrated.activePane!, 'terminal:1'), 'terminal:1')).toBe(false)
  })

  it('migrateBottomTabs appends into the FIRST leaf when the right tree is a split', () => {
    let s = state()
    s = splitPane(s, 'row') // splits the active pane into two leaves
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = openTabInActivePane({ ...s, activePane: bottomPane }, { id: 'terminal:9', type: 'terminal', title: 'T9' })
    const migrated = migrateBottomTabs(s)
    // The first (leftmost) leaf carries the bottom tab; the second leaf
    // keeps its own tabs untouched.
    const leaves = allLeaves(migrated.splits)
    expect(leaves[0]!.tabs.map(t => t.id)).toContain('terminal:9')
    expect(allLeaves(migrated.bottomSplits).flatMap(l => l.tabs)).toHaveLength(0)
  })

  it('migrateBottomTabs is idempotent (same reference) once the bottom tree is empty and closed', () => {
    const s = state()
    expect(migrateBottomTabs(s)).toBe(s)
    // With the panel open but no tabs, the migration only closes the panel.
    const open = toggleBottomPanel(s)
    const migrated = migrateBottomTabs(open)
    expect(migrated).not.toBe(open)
    expect(migrated.bottomOpen).toBe(false)
    expect(migrateBottomTabs(migrated)).toBe(migrated)
  })

  it('migrateBottomTabs repoints an active pane that lives in the bottom tree', () => {
    let s = state()
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = { ...s, activePane: bottomPane } // empty bottom pane, panel closed
    const migrated = migrateBottomTabs(s)
    expect(migrated.activePane).toBe((migrated.splits as { id: string }).id)
    // A tab opened after the migration lands in the VISIBLE right tree.
    const landed = openTabInActivePane(migrated, { id: 'git', type: 'git' as const, title: 'Git' })
    expect((landed.splits as { tabs: SidebarTab[] }).tabs.map(t => t.type)).toContain('git')
  })

  it('openTabInActivePane lands in the bottom tree when the active pane lives there', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = { ...s, activePane: bottomPane }
    const tab = { id: 'git', type: 'git' as const, title: 'Git' }
    s = openTabInActivePane(s, tab)
    expect((s.bottomSplits as { tabs: SidebarTab[] }).tabs.map(t => t.id)).toContain('git')
    // The right tree is untouched (its seeded files-window home tab stays).
    expect((s.splits as { tabs: SidebarTab[] }).tabs.map(t => t.type)).toEqual(['editor'])
    expect(s.activePane).toBe(bottomPane)
    // The id safety net works across trees: reopening the same id focuses it.
    const after = openTabInActivePane(s, tab)
    expect((after.bottomSplits as { tabs: SidebarTab[] }).tabs.map(t => t.id)).toEqual(['git'])
  })

  it('openTabInActivePane falls back to the right tree when the active pane is stale', () => {
    let s = state()
    s = toggleBottomPanel(s)
    s = { ...s, activePane: 'pane:gone' }
    const after = openTabInActivePane(s, { id: 'git', type: 'git' as const, title: 'Git' })
    expect((after.splits as { tabs: SidebarTab[] }).tabs.map(t => t.type)).toContain('git')
  })

  it('closeTab routes to the bottom tree', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = openTabInActivePane({ ...s, activePane: bottomPane }, { id: 'terminal:1', type: 'terminal', title: 'T1' })
    expect(tabOpenIn(s, 'terminal:1')).toBe(true)
    s = closeTab(s, bottomPane, 'terminal:1')
    expect(tabOpenIn(s, 'terminal:1')).toBe(false)
    // The right tree is untouched.
    expect(tabOpenIn(s, (s.splits as { tabs: { id: string }[] }).tabs[0]!.id)).toBe(true)
  })

  it('moveTabToEdge splits within the bottom tree', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = openTabInActivePane({ ...s, activePane: bottomPane }, { id: 'terminal:1', type: 'terminal', title: 'T1' })
    s = moveTabToEdge(s, bottomPane, 'terminal:1', bottomPane, 'right')
    expect(s.bottomSplits.kind).toBe('split')
    expect(s.splits.kind).toBe('leaf')
    expect(tabOpenIn(s, 'terminal:1')).toBe(true)
    // The fresh leaf (the drop's active pane) differs from the source pane.
    expect(s.activePane).not.toBe(bottomPane)
  })

  it('resizeSplitIn routes a divider to its own tree', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = splitPane({ ...s, activePane: bottomPane }, 'row')
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    s = resizeSplitIn(s, split.id, 0, 0.1)
    const next = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    expect(next.sizes[0]).toBeCloseTo(0.6)
    expect(s.splits.kind).toBe('leaf')
  })

  it('sanitize defaults the bottom fields for older persisted states and repairs a broken bottom tree', () => {
    const base = {
      panelOpen: true,
      width: 400,
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      splits: {
        kind: 'leaf',
        id: 'pane:1',
        active: null,
        tabs: [{ id: 't', type: 'explorer', title: 'Explorer' }],
      },
    }
    // Older persisted states lack the bottom fields: defaults, state kept.
    const s = sanitizeState(base)
    expect(s?.bottomOpen).toBe(false)
    expect(s?.bottomHeight).toBe(BOTTOM_DEFAULT)
    expect(s?.bottomSplits.kind).toBe('leaf')
    expect((s?.bottomSplits as { tabs: SidebarTab[] }).tabs).toHaveLength(0)
    // A malformed bottom tree is replaced with a fresh empty pane.
    const broken = sanitizeState({ ...base, bottomSplits: 'junk' })
    expect(broken?.splits).toBeDefined()
    expect(broken?.bottomSplits.kind).toBe('leaf')
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
    // A stale full-height bottom panel must not squeeze the center column
    // (the agent output area) to zero: the cap leaves it at least PANEL_MIN
    // tall, regardless of the right panel's open state.
    const g = globalThis as Record<string, unknown>
    const previous = g.window
    g.window = { innerHeight: 800 }
    try {
      expect(sanitizeState({ ...base, panelOpen: true, bottomHeight: 9999 })?.bottomHeight).toBe(800 - 280)
      expect(sanitizeState({ ...base, panelOpen: false, bottomHeight: 9999 })?.bottomHeight).toBe(800 - 280)
    } finally {
      if (previous === undefined) delete g.window
      else g.window = previous
    }
  })

  it('tabOpenIn and patchTab see tabs in the bottom tree', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const bottomPane = (s.bottomSplits as { id: string }).id
    s = openTabInActivePane(
      { ...s, activePane: bottomPane },
      { id: 'browser:1', type: 'browser', title: 'example.com', path: 'https://example.com' },
    )
    expect(tabOpenIn(s, 'browser:1')).toBe(true)
    s = patchTab(s, 'browser:1', { title: 'other.com', path: 'https://other.com' })
    const tab = allLeaves(s.bottomSplits).flatMap(leaf => leaf.tabs).find(t => t.id === 'browser:1')
    expect(tab?.title).toBe('other.com')
  })

  it('moves a tab across panels (center merge into the other tree)', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const rightPane = (s.splits as { id: string }).id
    const bottomPane = (s.bottomSplits as { id: string }).id
    const explorerId = (s.splits as { tabs: { id: string }[] }).tabs[0]!.id
    // Drag the explorer tab from the right panel into the bottom panel (center).
    s = moveTabToEdge(s, rightPane, explorerId, bottomPane, 'center')
    expect((s.bottomSplits as { tabs: SidebarTab[] }).tabs.map(t => t.id)).toContain(explorerId)
    expect((s.splits as { tabs: SidebarTab[] }).tabs).toHaveLength(0)
    expect(s.activePane).toBe(bottomPane)
    // And back, inserted at an index.
    s = moveTab(s, bottomPane, explorerId, rightPane, 0)
    expect((s.splits as { tabs: SidebarTab[] }).tabs[0]!.id).toBe(explorerId)
    expect((s.bottomSplits as { tabs: SidebarTab[] }).tabs).toHaveLength(0)
  })

  it('moves a tab across panels by splitting the target pane (edge drop)', () => {
    let s = state()
    s = toggleBottomPanel(s)
    const rightPane = (s.splits as { id: string }).id
    const bottomPane = (s.bottomSplits as { id: string }).id
    const explorerId = (s.splits as { tabs: { id: string }[] }).tabs[0]!.id
    s = moveTabToEdge(s, rightPane, explorerId, bottomPane, 'right')
    // The source tree empties back to a leaf; the target tree splits.
    expect(s.splits.kind).toBe('leaf')
    expect((s.splits as { tabs: SidebarTab[] }).tabs).toHaveLength(0)
    expect(s.bottomSplits.kind).toBe('split')
    expect(tabOpenIn(s, explorerId)).toBe(true)
    const split = s.bottomSplits as Extract<SplitNode, { kind: 'split' }>
    expect(split.children.some(
      child => child.kind === 'leaf' && (child as { tabs: SidebarTab[] }).tabs.some(t => t.id === explorerId),
    )).toBe(true)
    // The fresh leaf (the drop's active pane) differs from the source pane.
    expect(s.activePane).not.toBe(rightPane)
  })

  it('moveTab with a non-existent source or target pane is safe', () => {
    const s = state()
    const pane = (s.splits as { id: string }).id
    // Missing source: returns unchanged state
    expect(moveTab(s, 'pane:ghost', 'tab:1', pane)).toBe(s)
    // Missing target: returns unchanged state
    expect(moveTab(s, pane, 'tab:1', 'pane:ghost')).toBe(s)
  })

  it('closeTab with non-existent tab or pane returns equivalent state without throwing', () => {
    const s = state()
    const pane = (s.splits as { id: string }).id
    expect(closeTab(s, 'pane:ghost', 'tab:1')).toEqual(s)
    expect(closeTab(s, pane, 'tab:ghost')).toEqual(s)
  })

  it('moveTabToEdge with non-existent pane returns unchanged state', () => {
    const s = state()
    const pane = (s.splits as { id: string }).id
    expect(moveTabToEdge(s, 'pane:ghost', 'tab:1', pane, 'right')).toBe(s)
    expect(moveTabToEdge(s, pane, 'tab:1', 'pane:ghost', 'right')).toBe(s)
  })
})

describe('persisted state sanitization', () => {
  it('accepts a well-formed state unchanged (node environment: no width clamp)', () => {
    const state = makeDefaultState(400)
    const clean = sanitizeState(JSON.parse(JSON.stringify(state)))
    expect(clean).toEqual(state)
  })

  it('accepts a subagent tab as a known type', () => {
    const raw = JSON.parse(JSON.stringify(makeDefaultState(400)))
    raw.splits.tabs.push({ id: 'tab:9', type: 'subagent', title: 'Subagents' })
    raw.splits.active = 'tab:9'
    const clean = sanitizeState(raw)
    expect(clean).toBeDefined()
    const tabs = (clean!.splits as { tabs: { type: string }[] }).tabs
    expect(tabs.some(tab => tab.type === 'subagent')).toBe(true)
  })

  it('clamps undersized widths to the panel minimum', () => {
    const state = { ...makeDefaultState(400), width: 10 }
    const clean = sanitizeState(JSON.parse(JSON.stringify(state)))
    expect(clean?.width).toBe(280)
  })

  it('rejects malformed shapes instead of crashing the panel', () => {
    expect(sanitizeState(null)).toBeUndefined()
    expect(sanitizeState('nope')).toBeUndefined()
    expect(sanitizeState({})).toBeUndefined()
    expect(sanitizeState({ ...makeDefaultState(400), width: 'wide' })).toBeUndefined()
    expect(sanitizeState({ ...makeDefaultState(400), panelOpen: 1 })).toBeUndefined()
    // A split whose sizes do not match its children is rejected.
    const withSplit = JSON.parse(JSON.stringify(makeDefaultState(400)))
    withSplit.splits = { kind: 'split', id: 's1', dir: 'row', sizes: [0.5], children: [] }
    expect(sanitizeState(withSplit)).toBeUndefined()
    // Unknown tab types (external plugins not yet loaded) are accepted —
    // they render as <OrphanedTab/> at view time and recover if the plugin
    // loads later. Only diff tabs are dropped (ephemeral).
    const withExternalTab = JSON.parse(JSON.stringify(makeDefaultState(400)))
    withExternalTab.splits.tabs[0].type = 'my-plugin:db'
    const externalClean = sanitizeState(withExternalTab)
    expect(externalClean).toBeDefined()
    if (externalClean !== undefined && externalClean.splits.kind === 'leaf') {
      expect(externalClean.splits.tabs[0]!.type).toBe('my-plugin:db')
    }
    // An active id that no tab carries is rejected.
    const withBadActive = JSON.parse(JSON.stringify(makeDefaultState(400)))
    withBadActive.splits.active = 'ghost-tab'
    expect(sanitizeState(withBadActive)).toBeUndefined()
  })

  it('re-ids stale duplicate pane/split ids and follows the activePane rename', () => {
    // The pre-seeding counter reset could mint a fresh "pane:1" beside the
    // persisted "pane:1": mapLeaf then hit BOTH leaves and every open landed
    // in both panes. Sanitize must give the repeat a fresh id.
    const corrupted = JSON.parse(JSON.stringify(makeDefaultState(400)))
    corrupted.activePane = 'pane:1'
    corrupted.splits = {
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
    const leaves = allLeaves(clean!.splits)
    // The empty first occurrence is pruned; the populated repeat keeps its
    // fresh unique id and becomes active.
    expect(leaves).toHaveLength(1)
    expect(leaves[0]!.id).not.toBe('pane:1')
    expect(clean!.activePane).toBe(leaves[0]!.id)
    // And an open must land in exactly one pane of the healed tree.
    const opened = openTabInActivePane(clean!, { id: 'editor:/a.ts', type: 'editor', title: 'a.ts', path: '/a.ts' })
    const owners = allLeaves(opened.splits).filter(leaf => leaf.tabs.some(tab => tab.path === '/a.ts'))
    expect(owners).toHaveLength(1)
  })

  it('falls back from a stale active pane instead of dropping the open', () => {
    let s = makeDefaultState()
    const paneA = allLeaves(s.splits)[0]!.id
    const seededTab = allLeaves(s.splits)[0]!.tabs.find(tab => tab.type === 'editor')!.id
    s = closeTab(s, paneA, seededTab)
    s = openTabInActivePane(s, { id: 'editor:/a.ts', type: 'editor', title: 'a.ts', path: '/a.ts' })
    const split = insertLeafAt(s.splits, paneA, 'col', { id: 'terminal:1', type: 'terminal', title: 'Terminal 1' }, false)
    s = { ...s, splits: split.node, activePane: paneA }
    // Closing the editor empties paneA; the pane is removed but activePane
    // still points at it. The next open must land in the surviving pane.
    s = closeTab(s, paneA, 'editor:/a.ts')
    s = openTabInActivePane(s, { id: 'editor:/b.ts', type: 'editor', title: 'b.ts', path: '/b.ts' })
    const owners = allLeaves(s.splits).filter(leaf => leaf.tabs.some(tab => tab.path === '/b.ts'))
    expect(owners).toHaveLength(1)
    expect(owners[0]!.tabs.some(tab => tab.type === 'terminal')).toBe(true)
  })

  it('handles state with deeply corrupted split children gracefully', () => {
    const corrupted = {
      ...makeDefaultState(400),
      splits: {
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
    expect(sanitizeState(corrupted)).toBeUndefined()
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
      store.reduceFor('brand-new', (state) => ({ ...state, panelOpen: false }))
      store.setSession('brand-new')
      expect(store.getSnapshot().state?.panelOpen).toBe(false)
      expect(store.getSnapshot().state?.splits).toBeDefined()
    })

    it('reduceFor never lowers the shared uid counter below the active session needs (no pane-id collision)', () => {
      const store = createSidebarStore()
      // Session 'b' is cached FIRST with a LOW id range (pane:1 / tab:2).
      store.setSession('b')
      // Session 'a' then loads and its operations raise the shared counter
      // well above b's max (default pane, plus fresh pane ids from splits).
      store.setSession('a')
      store.reduce(s => splitPane(s, 'row'))
      const before = allLeaves(store.getSnapshot().state!.splits).map(leaf => leaf.id).sort()
      // A targeted reduce into the OLD, low-id session must not lower the
      // counter: the next split in the ACTIVE session would otherwise mint
      // an id that already exists (mapLeaf visits both leaves → corruption).
      store.reduceFor('b', (state) => state)
      store.reduce(s => splitPane(s, 'row'))
      const after = allLeaves(store.getSnapshot().state!.splits).map(leaf => leaf.id)
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
        // Each persist also syncs the shared cross-session width key (PR #36).
        expect(writes.filter(key => key !== 'dsh-sidebar:v1:width'))
          .toEqual(['dsh-sidebar:v1:a', 'dsh-sidebar:v1:b'])
        expect(writes).toContain('dsh-sidebar:v1:width')
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
        splits: {
          kind: 'leaf' as const,
          id: 'pane:1',
          tabs: [{ id: 'tab:1', type: 'db', title: 'DB', meta: { q: [1, 2], n: 0 } }],
          active: 'tab:1',
        },
      }))
      const sanitized = sanitizeState(JSON.parse(JSON.stringify(store.getSnapshot().state!)))
      const tabs = allLeaves(sanitized!.splits).flatMap(leaf => leaf.tabs)
      expect(tabs[0]?.meta).toEqual({ q: [1, 2], n: 0 })
    })
  })
})

describe('free windows (v0.16.0)', () => {
  // Node environment: no window → the viewport clamps are Infinity and only
  // the size floors apply; the geometry tests stub a window where clamping
  // is the point under test.
  const state = (): SidebarState => makeDefaultState()

  it('floatTab moves a docked tab into floats (pane keeps its other tabs)', () => {
    let s = state()
    const git = { id: 'git', type: 'git' as const, title: 'Git' }
    const term = { id: 'term:1', type: 'terminal' as const, title: 'Term' }
    s = openTabInActivePane(s, git)
    s = openTabInActivePane(s, term)
    const floated = floatTab(s, git.id, 300, 200)
    const leaf = floated.splits as SidebarLeaf
    expect(leaf.tabs).toHaveLength(2)
    expect(leaf.tabs.some(tab => tab.id === 'git')).toBe(false)
    // The pane's active pointer fell to the last remaining tab.
    expect(leaf.active).toBe('term:1')
    expect(floated.floats).toHaveLength(1)
    expect(floated.floats[0]!.tab).toEqual(git)
    // Phone-ratio default (390x780) centered on the drop point (no viewport
    // → size cap never bites; only the negative y clamps to 0).
    expect(floated.floats[0]).toMatchObject({ x: 300 - 195, y: 0, w: 390, h: 780 })
    expect(floated.activePane).toBe(leaf.id)
  })

  it('floatTab collapses a pane it empties and repoints the active pane', () => {
    let s = state()
    const paneId = (s.splits as SidebarLeaf).id
    s = splitPane(s, 'row')
    const fresh = allLeaves(s.splits).find(leaf => leaf.id !== paneId)!
    s = { ...s, activePane: fresh.id }
    s = openTabInActivePane(s, { id: 'term:1', type: 'terminal', title: 'T' })
    expect(allLeaves(s.splits).find(leaf => leaf.id === fresh.id)!.tabs).toHaveLength(1)
    const floated = floatTab(s, 'term:1', 100, 100)
    expect(floated.floats).toHaveLength(1)
    expect(allLeaves(floated.splits).some(leaf => leaf.id === fresh.id)).toBe(false)
    expect(floated.activePane).toBe(paneId)
  })

  it('floatTab with an unknown or already-floating tab id is a strict no-op', () => {
    let s = state()
    const git = { id: 'git', type: 'git' as const, title: 'Git' }
    s = openTabInActivePane(s, git)
    expect(floatTab(s, 'nope', 0, 0)).toBe(s)
    const floated = floatTab(s, 'git', 50, 50)
    expect(floatTab(floated, 'git', 60, 60)).toBe(floated)
  })

  it('moveFloat / resizeFloat clamp to the viewport (floors always)', () => {
    const g = globalThis as Record<string, unknown>
    const previous = g.window
    g.window = { innerWidth: 1024, innerHeight: 768 }
    try {
      let s = state()
      const git = { id: 'git', type: 'git' as const, title: 'Git' }
      s = floatTab(openTabInActivePane(s, git), 'git', 512, 384)
      const id = s.floats[0]!.id
      // Negative position clamps to 0; the window stays fully inside.
      let moved = moveFloat(s, id, -50, -50)
      expect(moved.floats[0]).toMatchObject({ x: 0, y: 0 })
      // Beyond the right/bottom edge clamps the top-left so the window fits.
      moved = moveFloat(moved, id, 5000, 5000)
      // The float was CREATED capped to the viewport: w 390, h 768-24=744.
      expect(moved.floats[0]!.x).toBe(1024 - 390)
      expect(moved.floats[0]!.y).toBe(768 - 744)
      // No-op move returns the same reference (no persist churn).
      expect(moveFloat(moved, id, moved.floats[0]!.x, moved.floats[0]!.y)).toBe(moved)
      // Resize: floors, viewport ceiling, and the SE-corner anchor (x/y keep).
      let resized = resizeFloat(moved, id, 10, 10)
      expect(resized.floats[0]).toMatchObject({ w: FLOAT_MIN_W, h: FLOAT_MIN_H })
      resized = resizeFloat(resized, id, 5000, 5000)
      expect(resized.floats[0]!.w).toBe(1024 - resized.floats[0]!.x)
      expect(resized.floats[0]!.h).toBe(768 - resized.floats[0]!.y)
      // No-op resize and unknown ids return the same reference.
      expect(resizeFloat(resized, id, resized.floats[0]!.w, resized.floats[0]!.h)).toBe(resized)
      expect(resizeFloat(resized, 'nope', 400, 400)).toBe(resized)
    } finally {
      if (previous === undefined) delete g.window
      else g.window = previous
    }
  })

  it('raiseFloat moves a window to the top and is idempotent at the top', () => {
    let s = state()
    s = floatTab(openTabInActivePane(s, { id: 'a', type: 'db', title: 'a' }), 'a', 100, 100)
    s = floatTab(openTabInActivePane(s, { id: 'b', type: 'db', title: 'b' }), 'b', 100, 100)
    s = floatTab(openTabInActivePane(s, { id: 'c', type: 'db', title: 'c' }), 'c', 100, 100)
    expect(s.floats.map(f => f.tab.id)).toEqual(['a', 'b', 'c'])
    const raised = raiseFloat(s, s.floats[0]!.id)
    expect(raised.floats.map(f => f.tab.id)).toEqual(['b', 'c', 'a'])
    // Already topmost / unknown id → same reference (no notify churn).
    expect(raiseFloat(raised, raised.floats[2]!.id)).toBe(raised)
    expect(raiseFloat(raised, 'float:none')).toBe(raised)
    // A single window has nothing to raise: same reference.
    let single = state()
    single = floatTab(single, (single.splits as SidebarLeaf).tabs[0]!.id, 0, 0)
    expect(single.floats).toHaveLength(1)
    expect(raiseFloat(single, single.floats[0]!.id)).toBe(single)
  })

  it('dockFloat lands the tab in the target pane (or the active pane) and activates it', () => {
    let s = state()
    const git = { id: 'git', type: 'git' as const, title: 'Git' }
    s = floatTab(openTabInActivePane(s, git), 'git', 100, 100)
    const floatId = s.floats[0]!.id
    // Explicit target pane.
    s = splitPane(s, 'row')
    const target = allLeaves(s.splits).find(leaf => leaf.tabs.length === 0)!
    const docked = dockFloat(s, floatId, target.id)
    expect(docked.floats).toHaveLength(0)
    expect(allLeaves(docked.splits).find(leaf => leaf.id === target.id)!.tabs.map(tab => tab.id)).toEqual(['git'])
    expect(docked.activePane).toBe(target.id)
    // Default target: the active pane.
    let s2 = state()
    const home = (s2.splits as SidebarLeaf).tabs[0]!
    s2 = splitPane(s2, 'row')
    s2 = floatTab(s2, home.id, 100, 100)
    const active = s2.activePane!
    const docked2 = dockFloat(s2, s2.floats[0]!.id)
    expect(docked2.floats).toHaveLength(0)
    expect(allLeaves(docked2.splits).find(leaf => leaf.id === active)!.tabs.some(tab => tab.id === home.id)).toBe(true)
    expect(docked2.activePane).toBe(active)
    // Stale target falls back to the right tree's first leaf.
    let s3 = state()
    const home3 = (s3.splits as SidebarLeaf).tabs[0]!
    s3 = floatTab(s3, home3.id, 0, 0)
    const docked3 = dockFloat(s3, s3.floats[0]!.id, 'pane:gone')
    expect(docked3.floats).toHaveLength(0)
    expect(allLeaves(docked3.splits).some(leaf => leaf.tabs.some(tab => tab.id === home3.id))).toBe(true)
    // Unknown float id is a strict no-op.
    expect(dockFloat(docked3, 'float:gone')).toBe(docked3)
  })

  it('tabOpenIn / patchTab / floatWithTab see floating tabs', () => {
    let s = state()
    const git = { id: 'git', type: 'git' as const, title: 'Git' }
    s = floatTab(openTabInActivePane(s, git), 'git', 100, 100)
    expect(tabOpenIn(s, 'git')).toBe(true)
    expect(floatWithTab(s, 'git')!.id).toBe(s.floats[0]!.id)
    const patched = patchTab(s, 'git', { title: 'Git 2', path: '/x' })
    expect(patched.floats[0]!.tab).toMatchObject({ title: 'Git 2', path: '/x' })
    expect(allLeaves(patched.splits).some(leaf => leaf.tabs.some(tab => tab.id === 'git'))).toBe(false)
  })

  it('closeFloatByTab removes exactly the window holding the tab', () => {
    let s = state()
    const git = { id: 'git', type: 'git' as const, title: 'Git' }
    const term = { id: 'term:1', type: 'terminal' as const, title: 'T' }
    s = openTabInActivePane(s, git)
    s = openTabInActivePane(s, term)
    s = floatTab(s, 'git', 50, 50)
    s = floatTab(s, 'term:1', 60, 60)
    expect(s.floats).toHaveLength(2)
    const after = closeFloatByTab(s, 'git')
    expect(after.floats.map(f => f.tab.id)).toEqual(['term:1'])
    expect(closeFloatByTab(after, 'git')).toBe(after)
  })

  it('openTabInActivePane focuses a floating tab by raising (id safety net)', () => {
    let s = state()
    const git = { id: 'git', type: 'git' as const, title: 'Git' }
    const term = { id: 'term:1', type: 'terminal' as const, title: 'T' }
    s = floatTab(openTabInActivePane(s, git), 'git', 50, 50)
    s = floatTab(openTabInActivePane(s, term), 'term:1', 60, 60)
    // Reopening the floated id must NOT duplicate: it raises the window.
    const after = openTabInActivePane(s, { id: 'git', type: 'git', title: 'Git' })
    expect(after.floats.map(f => f.tab.id)).toEqual(['term:1', 'git'])
    expect(allLeaves(after.splits).some(leaf => leaf.tabs.some(tab => tab.id === 'git'))).toBe(false)
  })

  it('reconcileAgentTerminals removes a vanished FLOATED agent terminal with its window', () => {
    let s = state()
    s = openTabInActivePane(s, { id: 'agent:u1', type: 'terminal', title: 'A1' })
    s = floatTab(s, 'agent:u1', 50, 50)
    s = openTabInActivePane(s, { id: 'agent:u2', type: 'terminal', title: 'A2' })
    expect(s.floats).toHaveLength(1)
    const after = reconcileAgentTerminals(s, [{ uuid: 'u2', title: 'A2' }])
    expect(after.floats).toHaveLength(0)
    expect(allLeaves(after.splits).flatMap(leaf => leaf.tabs).some(tab => tab.id === 'agent:u2')).toBe(true)
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

  describe('sanitizeState (floats)', () => {
    const g = globalThis as Record<string, unknown>
    beforeEach(() => {
      g.window = { clearTimeout: () => {}, setTimeout: () => 0, innerWidth: 1024, innerHeight: 768 }
      g.localStorage = { getItem: () => null, setItem: () => {} }
    })
    afterEach(() => {
      delete g.window
      delete g.localStorage
    })

    const base = (): Record<string, unknown> => ({
      panelOpen: true,
      width: 400,
      nextTerminal: 1,
      activePane: 'pane:1',
      expanded: [],
      splits: { kind: 'leaf', id: 'pane:1', active: null, tabs: [] },
    })

    it('a missing floats field defaults to none (older persisted states load)', () => {
      const restored = sanitizeState(base())!
      expect(restored.floats).toEqual([])
    })

    it('drops malformed entries individually and keeps the layout (unlike tree corruption)', () => {
      const parsed = base()
      parsed.floats = [
        'garbage',
        { id: 'float:1' }, // no tab
        { id: 'float:2', tab: { id: 't', type: 'git', title: 'G' }, x: 10, y: 10 }, // no w/h
        { id: 'float:3', tab: { id: 't3', type: 'git', title: 'G3' }, x: 10, y: 10, w: 500, h: 400 },
        { id: 'float:3', tab: { id: 't3b', type: 'git', title: 'G3b' }, x: 0, y: 0, w: 400, h: 300 }, // duplicate id
      ]
      const restored = sanitizeState(parsed)!
      expect(restored.floats).toHaveLength(1)
      expect(restored.floats[0]).toMatchObject({ id: 'float:3', tab: { id: 't3' }, x: 10, y: 10 })
      expect(restored.splits).toBeDefined()
    })

    it('drops ephemeral diff tabs and migrates explorer tabs inside floats', () => {
      const parsed = base()
      parsed.floats = [
        { id: 'float:1', tab: { id: 'd', type: 'diff', title: 'D' }, x: 0, y: 0, w: 400, h: 300 },
        { id: 'float:2', tab: { id: 'ex', type: 'explorer', title: 'Explorer' }, x: 0, y: 0, w: 400, h: 300 },
      ]
      const restored = sanitizeState(parsed)!
      expect(restored.floats.map(f => f.tab.type)).toEqual(['editor'])
      expect(restored.floats[0]!.tab).toMatchObject({ title: 'Files', meta: { treeOpen: true } })
    })

    it('clamps stale off-screen geometry into the current viewport', () => {
      const parsed = base()
      parsed.floats = [
        { id: 'float:1', tab: { id: 't', type: 'git', title: 'G' }, x: -200, y: 900, w: 5000, h: 5000 },
      ]
      const restored = sanitizeState(parsed)!
      // Sizes cap at the viewport, and the capped window lands at 0,0 (the
      // position clamp sees no room beyond it).
      expect(restored.floats[0]).toMatchObject({ x: 0, y: 0, w: 1024, h: 768 })
    })

    it('the uid counter seeds past persisted float ids (no collision on re-float)', () => {
      // Persisted: the pane max is 1, but floats reach float:2 — the counter
      // must seed to 2 so a fresh float mints float:3+, never a duplicate
      // float:2. (Intermediate mints during sanitize may raise it further;
      // the guarantee under test is uniqueness, not an exact value.)
      const parsed = base()
      parsed.floats = [
        { id: 'float:2', tab: { id: 't2', type: 'git', title: 'G2' }, x: 0, y: 0, w: 400, h: 300 },
      ]
      const saved = new Map<string, string>()
      saved.set('dsh-sidebar:v1:seedtest', JSON.stringify(parsed))
      g.localStorage = {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => { saved.set(key, value) },
      }
      const store = createSidebarStore()
      store.setSession('seedtest')
      const s = store.getSnapshot().state!
      expect(s.floats[0]!.id).toBe('float:2')
      store.reduce(cur => openTabInActivePane(cur, { id: 'tab:9', type: 'git', title: 'G9' }))
      store.reduce(cur => floatTab(cur, 'tab:9', 30, 30))
      const next = store.getSnapshot().state!
      expect(next.floats).toHaveLength(2)
      expect(new Set(next.floats.map(f => f.id)).size).toBe(2)
      const freshId = next.floats.map(f => f.id).find(id => id !== 'float:2')!
      expect(freshId).toMatch(/^float:\d+$/)
      expect(Number(freshId.slice('float:'.length))).toBeGreaterThan(2)
    })

    it('floats survive a full persist round-trip (geometry verbatim when in-viewport)', () => {
      const parsed = base()
      parsed.floats = [
        { id: 'float:1', tab: { id: 't', type: 'git', title: 'G', meta: { k: 1 } }, x: 12, y: 34, w: 480, h: 360 },
      ]
      const restored = sanitizeState(parsed)!
      const again = sanitizeState(JSON.parse(JSON.stringify(restored)))!
      expect(again.floats).toEqual(restored.floats)
    })
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
    panelOpen: true,
    width: 400,
    nextTerminal: 1,
    activePane: 'pane:1',
    expanded: [],
    splits: { kind: 'leaf', id: 'pane:1', active: 'g1', tabs: [{ id: 'g1', type: 'git', title: 'Git' }] },
    bottomSplits: { kind: 'leaf', id: 'pane:b', active: null, tabs: [] },
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
    const leaf = store.getSnapshot().state!.splits as { tabs: { type: string }[] }
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
    // The default layout (editor home tab) — NOT the frozen git-only state.
    const leaf = store.getSnapshot().state!.splits as { tabs: { type: string }[] }
    expect(leaf.tabs.map(tab => tab.type)).toEqual(['editor'])
    // The stored copy is gone, so reloading without the param cannot restore
    // the hanging layout either.
    expect(removed).toContain('dsh-sidebar:v1:s1')
    expect(removed).toContain('dsh-sidebar:v1:width')
  })

  it('the reset param tolerates a value (?dsh-sidebar-reset=1)', () => {
    searchOf().search = '?foo=bar&dsh-sidebar-reset=1'
    const store = createSidebarStore()
    store.setSession('s1')
    const leaf = store.getSnapshot().state!.splits as { tabs: { type: string }[] }
    expect(leaf.tabs.map(tab => tab.type)).toEqual(['editor'])
  })
})
