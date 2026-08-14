import { describe, expect, it } from 'vitest'
import { compareEntries, isWithin, parentOf, rootLabel, requireAbsolute } from '../src/fs-tree.ts'
import { parseLogLines, parsePorcelainZ } from '../src/git.ts'
import { parseUnifiedDiff } from '../src/client/DiffView.tsx'
import {
  activateTab, allLeaves, BOTTOM_DEFAULT, BOTTOM_MIN, closeTab, createSidebarStore, defaultWidthFor, insertLeafAt, makeDefaultState,
  migrateBottomTabs, moveTab, moveTabToEdge, openDiffTab, openTabInActivePane, patchTab, reconcileAgentTerminals, resizeSplit, resizeSplitIn, sanitizeState, setBottomHeight, setWidth, splitPane, tabOpenIn, toggleBottomPanel, toggleExpanded, togglePanel,
  type SidebarState, type SidebarTab, type SplitNode,
} from '../src/client/state.ts'
import { loadPrefs, type SidebarSettingsClient } from '../src/client/prefs.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { extOf, languageKeyForExt } from '../src/client/lang.ts'
import { officeKindForExt } from '../src/client/office-types.ts'
import { isPdfExt } from '../src/client/pdf-types.ts'
import { isImageExt } from '../src/client/image-types.ts'
import { relativeTo } from '../src/client/paths.ts'
import { producedForClosing, resolveSidebarPath, selectProducedFiles } from '../src/client/produced-files.ts'
import { wrapOpenPath, type OpenPathInterceptDeps, type OpenPathService } from '../src/client/openpath-intercept.ts'
import { registerOpenPathInterception } from '../src/client/intercept.tsx'
import type { Context } from '../src/context-types.ts'
import { defaultShell, ensureSpawnHelper } from '../src/pty-manager.ts'
import {
  collectBranchIds, countSubagentDescendants, detectNewDirectSubagent, directSubagentCount, rootAncestor,
} from '../src/client/subagent-detect.ts'
import { contentText, lastActivity } from '../src/client/subagent-activity.ts'
import type { SidebarHistoryEntry, SidebarSessionList, SidebarSubagentCatalog } from '../src/context-types.ts'

describe('fs-tree', () => {
  it('sorts directories first, then names case-insensitively', () => {
    const rows = [
      { name: 'b.txt', path: '/x/b.txt', isDir: false, hidden: false },
      { name: 'A', path: '/x/A', isDir: true, hidden: false },
      { name: 'a.txt', path: '/x/a.txt', isDir: false, hidden: false },
      { name: '.hidden', path: '/x/.hidden', isDir: false, hidden: true },
    ]
    expect(rows.sort(compareEntries).map(row => row.name)).toEqual(['A', '.hidden', 'a.txt', 'b.txt'])
  })

  it('derives root labels and parents', () => {
    // POSIX-style inputs behave identically on both platforms (win32 parses '/'
    // as a separator), so these assertions are platform-independent.
    expect(rootLabel('/Users/me/code')).toBe('code')
    expect(rootLabel('/')).toBe('/')
    expect(parentOf('/Users/me/code')).toBe('/Users/me')
    expect(parentOf('/')).toBeUndefined()
    // Windows-drive roots and segments, asserted only where win32 semantics apply.
    if (process.platform === 'win32') {
      expect(rootLabel('C:\\')).toBe('C:\\')
      expect(parentOf('C:\\')).toBeUndefined()
      expect(rootLabel('C:\\Users\\me')).toBe('me')
      expect(parentOf('C:\\Users\\me')).toBe('C:\\Users')
    }
  })

  it('accepts absolute paths and rejects relative ones', () => {
    // resolve() is platform-native: '/a/b' roots to the current drive on win32.
    expect(requireAbsolute('/a/b')).toBe(process.platform === 'win32' ? '\\a\\b' : '/a/b')
    if (process.platform === 'win32') {
      expect(requireAbsolute('C:/proj')).toBe('C:\\proj')
    }
    expect(() => requireAbsolute('a/b')).toThrow(/not an absolute path/)
    expect(() => requireAbsolute('../a')).toThrow(/not an absolute path/)
  })

  it('isWithin tolerates separators and (on win32) letter case', () => {
    expect(isWithin('/work/proj', '/work/proj/src/a.ts')).toBe(true)
    expect(isWithin('/work/proj', '/work/proj')).toBe(true)
    expect(isWithin('/work/proj', '/work/proj2/a.ts')).toBe(false)
    expect(isWithin('/work/proj', '/other/a.ts')).toBe(false)
    // Mixed separators normalize on every platform.
    expect(isWithin('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe(true)
    // Case sensitivity follows the platform's filesystem semantics (the
    // platform parameter makes both branches assertable on any host).
    expect(isWithin('C:\\Users\\Me', 'c:/users/me/file.png', 'win32')).toBe(true)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'win32')).toBe(true)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'linux')).toBe(false)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'darwin')).toBe(false)
    // Windows drive-root containment.
    expect(isWithin('C:\\', 'C:\\Users\\me\\a.png', 'win32')).toBe(true)
    expect(isWithin('c:\\users', 'C:/USERS/me/b.png', 'win32')).toBe(true)
  })
})

describe('git parsing', () => {
  it('parses porcelain -z entries including renames', () => {
    const output = ['M  src/a.ts', ' M src/b.ts', '?? src/c.ts', 'R  src/new.ts', 'src/old.ts', ''].join('\0')
    const entries = parsePorcelainZ(output)
    expect(entries).toEqual([
      { path: 'src/a.ts', xy: 'M ' },
      { path: 'src/b.ts', xy: ' M' },
      { path: 'src/c.ts', xy: '??' },
      { path: 'src/new.ts', xy: 'R ' },
    ])
  })

  it('parses log rows with unit separators (full hash + refs)', () => {
    const rows = parseLogLines(
      'abc1234\x1fFirst subject\x1fAlice\x1f2024-01-01 10:00:00 +0800\x1fabc1234def5678abc1234def5678abc1234def5678\x1fHEAD -> main, origin/main\n'
      + 'def5678\x1fSecond subject\x1fBob\x1f2024-01-02 10:00:00 +0800\x1fdef5678abc1234def5678abc1234def5678abc1234\x1f\n',
    )
    expect(rows).toEqual([
      {
        hash: 'abc1234',
        subject: 'First subject',
        author: 'Alice',
        date: '2024-01-01 10:00:00 +0800',
        hashFull: 'abc1234def5678abc1234def5678abc1234def5678',
        refs: 'HEAD -> main, origin/main',
      },
      {
        hash: 'def5678',
        subject: 'Second subject',
        author: 'Bob',
        date: '2024-01-02 10:00:00 +0800',
        hashFull: 'def5678abc1234def5678abc1234def5678abc1234',
        refs: '',
      },
    ])
  })

  it('parses a multi-file unified diff with aligned line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,5 @@ section with @@ inside',
      ' line1',
      '-line2',
      '+line2b',
      ' context',
      '+trailing',
      'diff --git a/README.md b/README.md',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/README.md',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.files).toHaveLength(2)
    const first = parsed.files[0]!
    expect(first.oldPath).toBe('a/src/a.ts')
    expect(first.newPath).toBe('b/src/a.ts')
    expect(first.binary).toBe(false)
    expect(first.hunks).toHaveLength(1)
    expect(first.hunks[0]!.oldStart).toBe(1)
    expect(first.hunks[0]!.newStart).toBe(1)
    expect(first.hunks[0]!.header).toBe(' section with @@ inside')
    expect(first.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: 'line1', oldNum: 1, newNum: 1 },
      { kind: 'del', text: 'line2', oldNum: 2, newNum: null },
      { kind: 'add', text: 'line2b', oldNum: null, newNum: 2 },
      { kind: 'ctx', text: 'context', oldNum: 3, newNum: 3 },
      { kind: 'add', text: 'trailing', oldNum: null, newNum: 4 },
    ])
    const second = parsed.files[1]!
    expect(second.oldPath).toBe('/dev/null')
    expect(second.hunks[0]!.lines[0]).toEqual({ kind: 'add', text: 'hello', oldNum: null, newNum: 1 })
    expect(second.hunks[0]!.lines[1]).toEqual({ kind: 'add', text: 'world', oldNum: null, newNum: 2 })
  })

  it('parses binary, deletion and no-newline markers', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'index 111..222 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]!.binary).toBe(true)
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    const gone = parsed.files[1]!
    expect(gone.newPath).toBe('/dev/null')
    expect(gone.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'one', oldNum: 1, newNum: null },
      { kind: 'del', text: 'two', oldNum: 2, newNum: null },
      { kind: 'meta', text: ' No newline at end of file', oldNum: null, newNum: null },
    ])
  })

  it('keeps mode/rename-only sections hunkless', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '',
    ].join('\n'))
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]!.oldPath).toBe('')
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    expect(parsed.files[1]!.hunks).toHaveLength(0)
  })

  it('parses an empty or junk diff into no files', () => {
    expect(parseUnifiedDiff('').files).toEqual([])
    expect(parseUnifiedDiff('no diff here\n').files).toEqual([])
  })
})

describe('sidebar state', () => {
  const state = (): SidebarState => makeDefaultState()

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
    // The right tree is untouched.
    expect((s.splits as { tabs: SidebarTab[] }).tabs.map(t => t.type)).toEqual(['explorer'])
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
})

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

describe('pty helpers', () => {
  it('falls back from an empty SHELL to a usable shell', () => {
    const previous = process.env.SHELL
    try {
      process.env.SHELL = ''
      expect(defaultShell()).toBe('/bin/bash')
      delete process.env.SHELL
      expect(defaultShell()).toBe('/bin/bash')
    } finally {
      if (previous === undefined) delete process.env.SHELL
      else process.env.SHELL = previous
    }
  })

  it('restores the spawn-helper executable bit idempotently', () => {
    // On non-Windows the helper must exist and be executable after the fix.
    if (process.platform === 'win32') return
    ensureSpawnHelper()
    ensureSpawnHelper()
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    const { dirname, join } = require('node:path') as typeof import('node:path')
    const { createRequire } = require('node:module') as typeof import('node:module')
    const entry = createRequire(import.meta.url).resolve('node-pty')
    const root = dirname(dirname(entry))
    const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    expect(existsSync(helper)).toBe(true)
    const { statSync } = require('node:fs') as typeof import('node:fs')
    expect((statSync(helper).mode & 0o111) !== 0).toBe(true)
  })
})

describe('produced-files derivation', () => {
  const diffResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'diff', locations: [{ path }] },
  })
  const editResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'edit', locations: [{ path }] },
  })

  it('collects diff/edit locations of the closing turn, first-seen order', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      diffResult('a.ts'),
      editResult('b.ts'),
      diffResult('a.ts'),
      { kind: 'assistant', seq: 2, turn: 1 },
    ]
    expect(producedForClosing(nodes, 2)).toEqual(['a.ts', 'b.ts'])
  })

  it('resets on user messages and turn changes', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      diffResult('old.ts'),
      { kind: 'user' },
      { kind: 'assistant', seq: 2, turn: 2 },
      diffResult('new.ts'),
      { kind: 'assistant', seq: 3, turn: 2 },
    ]
    expect(producedForClosing(nodes, 3)).toEqual(['new.ts'])
  })

  it('ignores reads, deletes, errors, and unknown cards', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      { kind: 'tool-result', isError: true, callView: { card: 'diff', locations: [{ path: 'x.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'read', locations: [{ path: 'r.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'delete', locations: [{ path: 'd.ts' }] } },
    ]
    expect(producedForClosing(nodes, 1)).toEqual([])
  })

  it('selector claims only when files exist', () => {
    expect(selectProducedFiles({ nodes: [{ kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })).toBeNull()
    expect(selectProducedFiles({ nodes: [diffResult('a.ts'), { kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })).toEqual(['a.ts'])
    expect(selectProducedFiles(null)).toBeNull()
  })

  it('resolves relative paths against the session cwd', () => {
    expect(resolveSidebarPath('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts')
    expect(resolveSidebarPath('/work/proj', '/abs/x.ts')).toBe('/abs/x.ts')
    expect(resolveSidebarPath(undefined, 'a.ts')).toBe('a.ts')
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
    // The first occurrence keeps its id; the repeat gets a fresh unique one
    // (exact suffix depends on the module-level uid counter, so assert shape).
    expect(leaves[0]!.id).toBe('pane:1')
    expect(new Set(leaves.map(leaf => leaf.id)).size).toBe(2)
    expect(clean!.activePane).toBe(leaves[1]!.id)
    // And an open must land in exactly one pane of the healed tree.
    const opened = openTabInActivePane(clean!, { id: 'editor:/a.ts', type: 'editor', title: 'a.ts', path: '/a.ts' })
    const owners = allLeaves(opened.splits).filter(leaf => leaf.tabs.some(tab => tab.path === '/a.ts'))
    expect(owners).toHaveLength(1)
  })

  it('falls back from a stale active pane instead of dropping the open', () => {
    let s = makeDefaultState()
    const paneA = allLeaves(s.splits)[0]!.id
    const explorerTab = allLeaves(s.splits)[0]!.tabs.find(tab => tab.type === 'explorer')!.id
    s = closeTab(s, paneA, explorerTab)
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
})

describe('path helpers', () => {
  it('derives relative paths under the cwd (and "." for the cwd itself)', () => {
    expect(relativeTo('/Users/me/code', '/Users/me/code/src/main.ts')).toBe('src/main.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/code')).toBe('.')
    expect(relativeTo('/Users/me/code/', '/Users/me/code/src/a/b.ts')).toBe('src/a/b.ts')
  })

  it('falls back to the path unchanged when it lies outside the cwd', () => {
    expect(relativeTo('/Users/me/code', '/Users/other/x.ts')).toBe('/Users/other/x.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/codex/y.ts')).toBe('/Users/me/codex/y.ts')
  })

  it('handles windows roots and mixed separators', () => {
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\me\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me\\', 'C:\\Users\\me')).toBe('.')
  })

  it('containment is case-insensitive (windows/macOS case-insensitive volumes)', () => {
    expect(relativeTo('C:\\Users\\Me', 'c:/users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/Users/Me/code', '/users/me/code/src/main.ts')).toBe('src/main.ts')
    // The returned relative text keeps the caller's own casing.
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\Me\\SRC\\a.ts')).toBe('SRC/a.ts')
  })

  it('resolves produced paths against windows cwds', () => {
    expect(resolveSidebarPath('C:\\work\\proj', 'src/a.ts')).toBe('C:\\work\\proj\\src/a.ts')
    expect(resolveSidebarPath('C:\\work\\proj', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
    expect(resolveSidebarPath('C:\\work\\proj\\', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
  })
})

describe('editor language mapping', () => {
  it('derives extensions from paths', () => {
    expect(extOf('/a/b/main.tsx')).toBe('tsx')
    expect(extOf('README.MD')).toBe('md')
    expect(extOf('/a/b/.gitignore')).toBe('gitignore')
    expect(extOf('noext')).toBe('')
  })

  it('maps common extensions to languages and falls back to plain text', () => {
    expect(languageKeyForExt('tsx')).toBe('tsx')
    expect(languageKeyForExt('js')).toBe('js')
    expect(languageKeyForExt('py')).toBe('python')
    expect(languageKeyForExt('yaml')).toBe('yaml')
    expect(languageKeyForExt('sh')).toBe('shell')
    expect(languageKeyForExt('md')).toBe('md')
    expect(languageKeyForExt('txt')).toBeNull()
    expect(languageKeyForExt('log')).toBeNull()
    expect(languageKeyForExt('')).toBeNull()
  })
})

describe('office preview kind', () => {
  it('routes docx/xlsx to their renderers', () => {
    expect(officeKindForExt('.docx')).toBe('docx')
    expect(officeKindForExt('.xlsx')).toBe('xlsx')
  })

  it('routes pptx to its renderer and legacy OLE formats to download-only', () => {
    expect(officeKindForExt('.pptx')).toBe('pptx')
    expect(officeKindForExt('.doc')).toBe('download-only')
    expect(officeKindForExt('.xls')).toBe('download-only')
    expect(officeKindForExt('.ppt')).toBe('download-only')
  })

  it('returns null for non-Office extensions and empty input', () => {
    expect(officeKindForExt('.txt')).toBeNull()
    expect(officeKindForExt('.md')).toBeNull()
    expect(officeKindForExt('.png')).toBeNull()
    expect(officeKindForExt('.pdf')).toBeNull()
    expect(officeKindForExt('')).toBeNull()
  })
})

describe('pdf preview kind', () => {
  it('routes only .pdf to the browser-native preview', () => {
    expect(isPdfExt('.pdf')).toBe(true)
    expect(isPdfExt('.PDF')).toBe(false)
    expect(isPdfExt('.docx')).toBe(false)
    expect(isPdfExt('')).toBe(false)
  })
})

describe('image preview kind', () => {
  it('routes supported image extensions before binary probing', () => {
    expect(isImageExt('.png')).toBe(true)
    expect(isImageExt('.jpg')).toBe(true)
    expect(isImageExt('.svg')).toBe(true)
    expect(isImageExt('.avif')).toBe(true)
    expect(isImageExt('.pdf')).toBe(false)
    expect(isImageExt('')).toBe(false)
  })
})

describe('side card preferences', () => {
  /** A fake settings wire face whose settingsGet resolves to one raw value. */
  const wire = (value: unknown): SidebarSettingsClient => ({
    settingsGet: async () => ({ value, revision: 1 }),
    settingsUpdate: async () => ({ value, revision: 2 }),
  })

  const rejecting = (): SidebarSettingsClient => ({
    settingsGet: async () => { throw new Error('route rejected') },
    settingsUpdate: async () => { throw new Error('route rejected') },
  })

  it('falls back to the defaults when the settings route rejects', async () => {
    expect(await loadPrefs(rejecting())).toEqual(SIDEBAR_PREFS_DEFAULTS)
  })

  it('falls back to the defaults when the value is absent or malformed', async () => {
    expect(await loadPrefs(wire(undefined))).toEqual(SIDEBAR_PREFS_DEFAULTS)
    expect(await loadPrefs(wire('garbage'))).toEqual(SIDEBAR_PREFS_DEFAULTS)
  })

  it('parses a valid value and clamps the percent into the contract range', async () => {
    expect(await loadPrefs(wire({ openByDefault: false, defaultWidthPercent: 80, autoOpenSubagent: false, agentTerminalTools: true })))
      .toEqual({
        openByDefault: false,
        defaultWidthPercent: 60,
        autoOpenSubagent: false,
        autoOpenJobs: true,
        agentTerminalTools: true,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        interceptOpenPath: true,
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        browserNoSandbox: false,
        browserInterceptLinks: true,
        tabsEnabled: {},
        viewersEnabled: {},
      })
  })

  it('falls back per-field when a stored field is malformed', async () => {
    expect(await loadPrefs(wire({ openByDefault: 'yes', defaultWidthPercent: 33, autoOpenSubagent: 'no', agentTerminalTools: 'yes' })))
      .toEqual({
        openByDefault: true,
        defaultWidthPercent: 33,
        autoOpenSubagent: true,
        autoOpenJobs: true,
        agentTerminalTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        interceptOpenPath: true,
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        browserNoSandbox: false,
        browserInterceptLinks: true,
        tabsEnabled: {},
        viewersEnabled: {},
      })
  })

  it('defaults autoOpenSubagent to true and agentTerminalTools to false when the stored value is absent or malformed', async () => {
    expect(await loadPrefs(wire({ openByDefault: false, defaultWidthPercent: 40 })))
      .toEqual({
        openByDefault: false,
        defaultWidthPercent: 40,
        autoOpenSubagent: true,
        autoOpenJobs: true,
        agentTerminalTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        interceptOpenPath: true,
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        browserNoSandbox: false,
        browserInterceptLinks: true,
        tabsEnabled: {},
        viewersEnabled: {},
      })
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, autoOpenSubagent: 1 }))).autoOpenSubagent)
      .toBe(true)
    // The terminal-tools feature is OFF by default; only an explicit true turns it on.
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40 }))).agentTerminalTools)
      .toBe(false)
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, agentTerminalTools: 1 }))).agentTerminalTools)
      .toBe(false)
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, agentTerminalTools: true }))).agentTerminalTools)
      .toBe(true)
    // The job auto-open is ON by default; only an explicit false turns it off.
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, autoOpenJobs: 1 }))).autoOpenJobs)
      .toBe(true)
    expect((await loadPrefs(wire({ openByDefault: true, defaultWidthPercent: 40, autoOpenJobs: false }))).autoOpenJobs)
      .toBe(false)
  })

  it('defaults interceptOpenPath to true; only an explicit false turns the takeover off', async () => {
    // Absent or malformed → on (the takeover is the safe default).
    expect((await loadPrefs(wire({}))).interceptOpenPath).toBe(true)
    expect((await loadPrefs(wire({ interceptOpenPath: 'yes' }))).interceptOpenPath).toBe(true)
    expect((await loadPrefs(wire({ interceptOpenPath: 0 }))).interceptOpenPath).toBe(true)
    // Explicit booleans survive verbatim.
    expect((await loadPrefs(wire({ interceptOpenPath: false }))).interceptOpenPath).toBe(false)
    expect((await loadPrefs(wire({ interceptOpenPath: true }))).interceptOpenPath).toBe(true)
  })

  it('resolves the terminal font prefs (family passthrough, size clamp)', async () => {
    // Absent → theme default (empty family) + default size.
    expect((await loadPrefs(wire({}))).terminalFontFamily).toBe('')
    expect((await loadPrefs(wire({}))).terminalFontSize).toBe(13)
    // A custom family survives verbatim; a malformed one falls back.
    expect((await loadPrefs(wire({ terminalFontFamily: '"JetBrains Mono", monospace' }))).terminalFontFamily)
      .toBe('"JetBrains Mono", monospace')
    expect((await loadPrefs(wire({ terminalFontFamily: 42 }))).terminalFontFamily).toBe('')
    // The size clamps into 9–32 (rounded); non-numbers fall back.
    expect((await loadPrefs(wire({ terminalFontSize: 5 }))).terminalFontSize).toBe(9)
    expect((await loadPrefs(wire({ terminalFontSize: 40 }))).terminalFontSize).toBe(32)
    expect((await loadPrefs(wire({ terminalFontSize: 15.6 }))).terminalFontSize).toBe(16)
    expect((await loadPrefs(wire({ terminalFontSize: 'big' }))).terminalFontSize).toBe(13)
    expect((await loadPrefs(wire({ terminalFontSize: 18 }))).terminalFontSize).toBe(18)
  })

  it('validates the per-tab / per-viewer enable maps (absent keys mean enabled)', async () => {
    // A non-object map falls back to {} (everything enabled).
    expect((await loadPrefs(wire({ tabsEnabled: 'nope' }))).tabsEnabled).toEqual({})
    expect((await loadPrefs(wire({ viewersEnabled: [1, 2] }))).viewersEnabled).toEqual({})
    // Non-boolean entries are dropped; boolean entries survive verbatim.
    const parsed = await loadPrefs(wire({
      tabsEnabled: { git: false, explorer: true, bad: 'yes' },
      viewersEnabled: { image: false, code: 1 },
    }))
    expect(parsed.tabsEnabled).toEqual({ git: false, explorer: true })
    expect(parsed.viewersEnabled).toEqual({ image: false })
  })

  it('seeds new-session defaults from the store prefs (open flag + width)', () => {
    const store = createSidebarStore()
    // Node environment: no window → the width falls back to PANEL_DEFAULT,
    // while the open flag still follows the preference.
    store.setPrefs({ openByDefault: false, defaultWidthPercent: 45, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, tabsEnabled: {}, viewersEnabled: {} })
    store.setSession('fresh-session')
    expect(store.getPrefs()).toEqual({ openByDefault: false, defaultWidthPercent: 45, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, tabsEnabled: {}, viewersEnabled: {} })
    const snapshot = store.getSnapshot()
    expect(snapshot.sessionId).toBe('fresh-session')
    expect(snapshot.state?.panelOpen).toBe(false)
    expect(snapshot.state?.width).toBe(400)
    // The default prefs keep the panel open.
    const openStore = createSidebarStore()
    openStore.setSession('another-fresh')
    expect(openStore.getSnapshot().state?.panelOpen).toBe(true)
  })

  it('shares the panel width across sessions (last drag wins)', () => {
    // A real localStorage stub so the cross-session width actually persists
    // (the default no-op mock would silently drop the write).
    const storage = new Map<string, string>()
    const savedWindow = (globalThis as Record<string, unknown>).window
    const savedStorage = (globalThis as Record<string, unknown>).localStorage
    ;(globalThis as Record<string, unknown>).window = {
      innerWidth: 1280,
      clearTimeout: () => {},
      setTimeout: () => 0,
    }
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, String(v)) },
      removeItem: (k: string) => { storage.delete(k) },
      key: () => null,
      get length() { return storage.size },
    }
    try {
      const store = createSidebarStore()
      store.setSession('A')
      store.reduce(s => setWidth(s, 500))
      // A fresh session adopts the width dragged in A, not its own default.
      store.setSession('B')
      expect(store.getSnapshot().state?.width).toBe(500)
      // A later drag in B carries back to the cached session A.
      store.reduce(s => setWidth(s, 600))
      store.setSession('A')
      expect(store.getSnapshot().state?.width).toBe(600)
    } finally {
      ;(globalThis as Record<string, unknown>).window = savedWindow
      ;(globalThis as Record<string, unknown>).localStorage = savedStorage
    }
  })

  it('seeds a brand-new session COLLAPSED on narrow viewports (the panel is a full-screen drawer there)', () => {
    // Stub a narrow window (the file otherwise runs without one): only
    // innerWidth is read while seeding a fresh session.
    const original = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = {
      innerWidth: 390,
      clearTimeout: () => {},
      setTimeout: (_fn: () => void) => 0,
    }
    try {
      const store = createSidebarStore()
      // Default prefs say openByDefault: true — the narrow viewport overrides
      // it for the FIRST seeding only (a later user expansion persists).
      store.setSession('narrow-fresh')
      expect(store.getSnapshot().state?.panelOpen).toBe(false)
      // The width seeding still follows the window (clamped to the floor).
      expect(store.getSnapshot().state?.width).toBe(280)
    } finally {
      if (original === undefined) delete (globalThis as Record<string, unknown>).window
      else (globalThis as Record<string, unknown>).window = original
    }
  })

  it('skips the default explorer tab when the explorer type is disabled', () => {
    const store = createSidebarStore()
    store.setPrefs({ openByDefault: true, defaultWidthPercent: 30, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, tabsEnabled: { explorer: false }, viewersEnabled: {} })
    store.setSession('no-explorer')
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(leaf => leaf.tabs)
    expect(tabs).toHaveLength(0)
    expect(state.splits.kind).toBe('leaf')
    // Re-enabling seeds the explorer tab again.
    const openStore = createSidebarStore()
    openStore.setPrefs({ openByDefault: true, defaultWidthPercent: 30, autoOpenSubagent: true, autoOpenJobs: true, agentTerminalTools: false, bottomPanelAutoTerminal: true, terminalFontFamily: '', terminalFontSize: 13, interceptOpenPath: true, htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false, browserNoSandbox: false, browserInterceptLinks: true, tabsEnabled: {}, viewersEnabled: {} })
    openStore.setSession('with-explorer')
    const openTabs = allLeaves(openStore.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
    expect(openTabs.map(tab => tab.type)).toEqual(['explorer'])
  })

  it('derives the default width from the window percent with clamps', () => {
    expect(defaultWidthFor(1440, 30)).toBe(432)
    expect(defaultWidthFor(800, 30)).toBe(280) // the panel floor
    expect(defaultWidthFor(1440, 100)).toBe(1440) // the viewport cap
  })

  it('makeDefaultState honors the open flag', () => {
    expect(makeDefaultState().panelOpen).toBe(true)
    expect(makeDefaultState(400, false).panelOpen).toBe(false)
    expect(makeDefaultState(400, false).width).toBe(400)
    // The seedExplorer flag controls the default explorer tab.
    expect(makeDefaultState(400, true, false).splits.kind).toBe('leaf')
    expect((makeDefaultState(400, true, false).splits as { tabs: unknown[] }).tabs).toHaveLength(0)
  })
})

describe('subagent detection over the sessions list feed', () => {
  /** A list snapshot carrying the given direct subagent children of `parent`. */
  const list = (
    parent: string,
    childIds: string[],
    running: string[] = [],
  ): SidebarSessionList => {
    const byId: SidebarSessionList['byId'] = { [parent]: { id: parent, displayTitle: 'Parent' } }
    for (const id of childIds) {
      byId[id] = {
        id,
        displayTitle: `Child ${id}`,
        origin: 'subagent',
        parentId: parent,
        running: running.includes(id),
      }
    }
    return { current: parent, byId }
  }

  it('counts only the direct subagent children of the given session', () => {
    const snapshot = list('p1', ['c1', 'c2'])
    snapshot.byId['other'] = { id: 'other', displayTitle: 'Other', origin: 'subagent', parentId: 'p2' }
    expect(directSubagentCount(snapshot.byId, 'p1')).toBe(2)
    expect(directSubagentCount(snapshot.byId, 'p2')).toBe(1)
    expect(directSubagentCount(snapshot.byId, 'p1-nobody')).toBe(0)
  })

  it('fires only on the 0 → N transition of the current session', () => {
    const empty = list('p1', [])
    const one = list('p1', ['c1'])
    const two = list('p1', ['c1', 'c2'])
    expect(detectNewDirectSubagent(empty, empty, 'p1')).toBe(false)
    expect(detectNewDirectSubagent(empty, one, 'p1')).toBe(true)
    // Already-present children never re-trigger (session switch, reload).
    expect(detectNewDirectSubagent(one, two, 'p1')).toBe(false)
    expect(detectNewDirectSubagent(two, one, 'p1')).toBe(false)
    // A child arriving under ANOTHER session does not trigger this one.
    expect(detectNewDirectSubagent(empty, list('p2', ['x']), 'p1')).toBe(false)
  })

  it('indexes descendants through uninterrupted subagent lineage', () => {
    // p1 → c1 (subagent) → g1 (subagent child of c1).
    const byId: SidebarSessionList['byId'] = {
      p1: { id: 'p1', displayTitle: 'P1' },
      c1: { id: 'c1', displayTitle: 'C1', origin: 'subagent', parentId: 'p1', running: true },
      g1: { id: 'g1', displayTitle: 'G1', origin: 'subagent', parentId: 'c1' },
    }
    expect(countSubagentDescendants(byId, 'p1')).toEqual({ count: 2, runningCount: 1 })
    expect(countSubagentDescendants(byId, 'c1')).toEqual({ count: 1, runningCount: 0 })
    expect(countSubagentDescendants(byId, 'g1')).toEqual({ count: 0, runningCount: 0 })
    // An ordinary fork between the parent and the subagent cuts that lineage:
    // c2 is c1's sibling in origin but its parent `fork` is not a subagent,
    // so it never reaches p1 (only c1 and g1 count under p1).
    const forked: SidebarSessionList['byId'] = {
      ...byId,
      fork: { id: 'fork', displayTitle: 'Fork', parentId: 'p1' },
      c2: { id: 'c2', displayTitle: 'C2', origin: 'subagent', parentId: 'fork' },
    }
    expect(countSubagentDescendants(forked, 'p1')).toEqual({ count: 2, runningCount: 1 })
    expect(countSubagentDescendants(forked, 'fork')).toEqual({ count: 1, runningCount: 0 })
    // Cycles terminate (fail soft, never hang); both rows in a 2-cycle reach
    // the queried node once each.
    const cyclic: SidebarSessionList['byId'] = {
      a: { id: 'a', displayTitle: 'A', origin: 'subagent', parentId: 'b' },
      b: { id: 'b', displayTitle: 'B', origin: 'subagent', parentId: 'a' },
    }
    expect(countSubagentDescendants(cyclic, 'a')).toEqual({ count: 2, runningCount: 0 })
  })

  it('resolves the main-agent root of the current session tree', () => {
    const byId: SidebarSessionList['byId'] = {
      main: { id: 'main', displayTitle: 'Main' },
      child: { id: 'child', displayTitle: 'Child', origin: 'subagent', parentId: 'main' },
      grand: { id: 'grand', displayTitle: 'Grand', origin: 'subagent', parentId: 'child' },
    }
    // An ordinary session is its own root; a deep subagent walks up to the main agent.
    expect(rootAncestor(byId, 'main')).toBe('main')
    expect(rootAncestor(byId, 'child')).toBe('main')
    expect(rootAncestor(byId, 'grand')).toBe('main')
    // A broken chain (parent not in the mirror) degrades to the session itself.
    expect(rootAncestor(byId, 'orphan')).toBe('orphan')
    // A hydrating session row degrades to the session itself.
    expect(rootAncestor(byId, 'not-listed')).toBe('not-listed')
    expect(rootAncestor(byId, undefined)).toBeUndefined()
  })

  it('collects every catalog branch of the topology, cycle-safe', () => {
    const child = (id: string, hasChildren: boolean): SidebarSubagentCatalog['entries'][number] => ({
      kind: 'child', id, activity: 'inactive', hasChildren, mode: 'one-shot',
    })
    const catalogs: Record<string, SidebarSubagentCatalog> = {
      root: { entries: [child('a', true), child('b', false)], parentAvailable: true, state: 'ready', error: null },
      a: { entries: [child('c', false)], parentAvailable: true, state: 'ready', error: null },
    }
    expect(collectBranchIds(catalogs, 'root')).toEqual(['a'])
    expect(collectBranchIds(catalogs, undefined)).toEqual([])
    // A cycle terminates (each branch id collected at most once, no hang).
    const cyclic: Record<string, SidebarSubagentCatalog> = {
      root: { entries: [child('a', true)], parentAvailable: true, state: 'ready', error: null },
      a: { entries: [child('root', true)], parentAvailable: true, state: 'ready', error: null },
    }
    expect(collectBranchIds(cyclic, 'root')).toEqual(['a', 'root'])
  })
})

describe('subagent activity summary parser', () => {
  /** One history entry from raw event fields. */
  const entry = (type: string, data: Record<string, unknown>): SidebarHistoryEntry => ({
    event: { type, seq: 0, time: 0, data },
  })

  it('extracts text blocks and skips non-text content', () => {
    // Text blocks join as paragraphs (newline-separated).
    expect(contentText([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])).toBe('hello\n world')
    expect(contentText([{ type: 'tool_use', name: 'bash' }])).toBeUndefined()
    expect(contentText(undefined)).toBeUndefined()
    expect(contentText('nope')).toBeUndefined()
  })

  it('lastActivity returns the LAST text output and the LAST tool call', () => {
    const live = lastActivity([
      entry('turn/start', { turn: 1 }),
      entry('user/message', { content: [{ type: 'text', text: '请检查代码' }] }),
      entry('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' }),
      entry('assistant/message', {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: '检查完毕' }] },
      }),
      entry('tool/call', { callId: 'c2', name: 'read', arguments: '{"path":"a.ts"}' }),
      entry('assistant/message', {
        turn: 1, step: 2,
        message: { content: [{ type: 'text', text: '再看一眼' }] },
      }),
    ])
    expect(live).toEqual({
      text: '再看一眼',
      tool: { name: 'read', args: '{"path":"a.ts"}' },
    })
  })

  it('lastActivity keeps only the fields the tail actually has', () => {
    expect(lastActivity([
      entry('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
    ])).toEqual({ tool: { name: 'bash', args: '{"command":"ls"}' } })
    expect(lastActivity([
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }),
    ])).toEqual({ text: 'ok' })
  })

  it('lastActivity ignores lifecycle events, chunks, and text-less messages', () => {
    const live = lastActivity([
      entry('turn/end', { turn: 1, reason: 'success' }),
      entry('step/start', { turn: 1, step: 1 }),
      entry('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', delta: 'x' } }),
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'tool_use', name: 'bash' }] } }),
    ])
    expect(live).toEqual({})
    expect(lastActivity([])).toEqual({})
  })

  it('lastActivity defaults a missing tool name and tolerates non-string arguments', () => {
    const live = lastActivity([
      entry('tool/call', { callId: 'c1' }),
      entry('tool/call', { callId: 'c2', name: 'web', arguments: { url: 'x' } }),
    ])
    expect(live.tool).toEqual({ name: 'web', args: '' })
  })
})

describe('open-path interception', () => {
  /** A minimal fake of the workspaces.openPath service method. */
  const service = (): OpenPathService & { calls: string[]; opened: string[] } => {
    const fake = {
      calls: [] as string[],
      opened: [] as string[],
      async openPath(path: string): Promise<void> {
        this.calls.push(path)
        this.opened.push(path)
      },
    }
    return fake
  }

  const deps = (overrides: Partial<OpenPathInterceptDeps> = {}): OpenPathInterceptDeps & {
    sidebar: string[]
  } => {
    const sidebar: string[] = []
    return {
      sidebar,
      takeoverEnabled: () => true,
      currentSessionId: () => 's1',
      openInSidebar: (path, sessionId) => { sidebar.push(`${sessionId}:${path}`) },
      ...overrides,
    }
  }

  it('routes an intercepted open into the sidebar and resolves without the original call', async () => {
    const ws = service()
    const d = deps()
    const restore = wrapOpenPath(ws, d)
    await expect(ws.openPath('/abs/a.ts')).resolves.toBeUndefined()
    expect(ws.calls).toEqual([])
    expect(d.sidebar).toEqual(['s1:/abs/a.ts'])
    restore()
  })

  it('falls through to the original when the takeover is disabled', async () => {
    const ws = service()
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenPath(ws, d)
    await ws.openPath('/abs/a.ts')
    expect(ws.opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('falls through when no session is current (nothing to scope the editor load to)', async () => {
    const ws = service()
    const d = deps({ currentSessionId: () => undefined })
    const restore = wrapOpenPath(ws, d)
    await ws.openPath('/abs/a.ts')
    expect(ws.opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('passes the current session into the sidebar opener', async () => {
    const ws = service()
    let current = 's1'
    const d = deps({ currentSessionId: () => current })
    const restore = wrapOpenPath(ws, d)
    await ws.openPath('/abs/a.ts')
    current = 's2'
    await ws.openPath('/abs/b.ts')
    expect(d.sidebar).toEqual(['s1:/abs/a.ts', 's2:/abs/b.ts'])
    restore()
  })

  it('restores the original method on dispose (HMR-safe)', async () => {
    const ws = service()
    const d = deps()
    const original = ws.openPath
    const restore = wrapOpenPath(ws, d)
    expect(ws.openPath).not.toBe(original)
    restore()
    expect(ws.openPath).toBe(original)
    await ws.openPath('/abs/a.ts')
    expect(ws.opened).toEqual(['/abs/a.ts'])
  })

  it('treats a rejected promise like the original would (no swallowing)', async () => {
    const failing: OpenPathService = {
      async openPath() { throw new Error('host refused') },
    }
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenPath(failing, d)
    await expect(failing.openPath('/abs/a.ts')).rejects.toThrow('host refused')
    restore()
  })
})

describe('open-path interception wiring', () => {
  it('registerOpenPathInterception routes chat opens into the editor tab and restores on dispose', async () => {
    // A realistic client-context fake: the sessions list feed (current + cwd),
    // the workspaces funnel, and the sidebar service the editor goes through.
    const opened: Array<Record<string, unknown>> = []
    const funnel = { openPath: async (): Promise<void> => {} }
    const ctx = {
      sessions: {
        list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }) },
      },
      workspaces: funnel,
      betterSidebar: { openTab: (seed: unknown) => { opened.push(seed as Record<string, unknown>) } },
    } as unknown as Context
    const store = createSidebarStore()
    const original = ctx.workspaces.openPath
    const restore = registerOpenPathInterception(ctx, store)

    // Default prefs: the takeover routes the open into the sidebar editor
    // with the session-scoped absolute path (chat already resolved it).
    await ctx.workspaces.openPath('/w/src/a.ts')
    expect(opened).toEqual([{
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    }])

    // The interceptOpenPath pref off → the original funnel runs untouched.
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: false })
    const calls: string[] = []
    ctx.workspaces.openPath = async (path: string) => { calls.push(path) }
    await ctx.workspaces.openPath('/w/src/b.ts')
    expect(calls).toEqual(['/w/src/b.ts'])
    expect(opened).toHaveLength(1)

    // The editor tab disabled → falls through too (an editor that cannot
    // open must not swallow opens).
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: true, tabsEnabled: { editor: false } })
    await ctx.workspaces.openPath('/w/src/c.ts')
    expect(calls).toEqual(['/w/src/b.ts', '/w/src/c.ts'])

    // Disposal restores the raw original method (HMR-safe).
    restore()
    expect(ctx.workspaces.openPath).toBe(original)
  })
})
