/**
 * The unified changes tab shell: the 36px header's lens switcher swaps the
 * Git lens for the session lens, a Git-lens file row opens the shared preview
 * pane (loaded through the mocked git API, rendered by the shared DiffFiles
 * stack), and the session ops ride the mocked `changes.ops` poll — the event
 * poll, the op fold and the badge cache all live in the tab. The Git Graph's
 * commit selection turns that SAME pane into the tabbed bottom region (the
 * `details` card + the diff), which the last describe covers.
 *
 * The copy assertions below pin the zh strings (the test environment's
 * navigator may be a real Node one with an en locale), so a bare substring
 * check cannot accidentally pass on a different message.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act, Simulate } from 'react-dom/test-utils'
import { ChangesTab, opCountOf } from '../src/client/changes/ChangesTab.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitGraphEntry, type GitStatusEntry, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'

/** The unstage artwork the SCM rows draw (the horizontal half of the host's Plus). */
const MINUS_GLYPH = 'M2 8H14'

/** One synthetic tool/call + tool/result pair (write of one file). */
function writeEvents(seq: number, path: string): Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }> {
  return [
    { type: 'tool/call', seq, time: seq, data: { name: 'write', callId: `w${seq}`, arguments: JSON.stringify({ file_path: path, content: 'body' }) } },
    { type: 'tool/result', seq: seq + 1, time: seq + 1, data: { message: { source: { kind: 'tool', callId: `w${seq}` }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
  ]
}

function fakeContext(): Context {
  return {
    get: () => undefined,
  } as unknown as Context
}

function mount(root: Root, tab: SidebarTab = { id: 'git', type: 'git', title: 'Changes' }, ctx: Context = fakeContext()): void {
  act(() => {
    root.render(createElement(ChangesTab, {
      ctx,
      store: createSidebarStore(),
      scope: { sessionId: 'session', cwd: MAIN },
      tab,
      visible: true,
      onOpenFile: () => {},
      onOpenDiff: () => {},
    }))
  })
}

/** A tab context whose `betterSidebar.updateTab` is observable: the pane tab
 *  choice is persisted through it, exactly like `lens` / `previewH`. */
function metaContext(updateTab: (id: string, patch: unknown, sessionId?: string) => void): Context {
  return { get: (name: string) => (name === 'betterSidebar' ? { updateTab } : undefined) } as unknown as Context
}

function mockGit(entries: GitStatusEntry[]): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: entries.length },
  ] as GitWorktree[])
  vi.spyOn(api, 'gitStatus').mockResolvedValue({
    isRepo: true, branch: 'main', entries,
  } as GitStatusResult)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
}

/** One lens tab of the header's official conversation Tabs. */
function lensTab(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(tab => tab.textContent === label)
}

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

// ── The Git Graph fixtures driving the tabbed bottom region ───────────────
/** A real 40-char SHA-1: the details card's chip renders the full hash while
 *  the row and the commit badge carry 7 chars, so the length itself is the
 *  evidence the card is the one on screen. */
const GRAPH_HASH = 'a1'.repeat(20)
const GRAPH_SUBJECT = 'graph commit subject'
const GRAPH_MESSAGE = 'graph commit subject\n\n## Retry loop\n\n- bullet'
const COMMIT_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old line',
  '+graph-only-diff-line',
  '',
].join('\n')
const WORKTREE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old line',
  '+worktree-only-diff-line',
  '',
].join('\n')

function graphEntry(): GitGraphEntry {
  return {
    hash: GRAPH_HASH.slice(0, 7),
    hashFull: GRAPH_HASH,
    parents: [],
    subject: GRAPH_SUBJECT,
    author: 'Ada',
    date: '2026-01-01',
    refs: ['HEAD', 'origin/main', 'topic'],
    message: GRAPH_MESSAGE,
  }
}

/** The graph page the graph lens loads, plus the commit patch its diff tab
 *  renders. `branches` carries the remote ref so the card's pill tones are
 *  observable end to end (the set is derived from this inventory). */
function mockGraph(): void {
  vi.spyOn(api, 'gitGraph').mockResolvedValue({
    isRepo: true,
    root: MAIN,
    entries: [graphEntry()],
    branches: [
      { ref: 'refs/heads/main', name: 'main', hashFull: GRAPH_HASH },
      { ref: 'refs/remotes/origin/main', name: 'origin/main', hashFull: GRAPH_HASH },
    ],
    hasMore: false,
    snapshot: 'one',
  })
  vi.spyOn(api, 'gitCommitDiff').mockResolvedValue({ diff: COMMIT_DIFF })
}

/** A repository with history: the Graph section renders its own empty state. */
function mockGraphEmpty(): void {
  vi.spyOn(api, 'gitGraph').mockResolvedValue({
    isRepo: true, root: MAIN, entries: [], branches: [], hasMore: false, snapshot: 'one',
  })
}

/** The open bottom pane's frame: the drag handle's parent (the pane root). */
function paneOf(container: HTMLElement): HTMLElement {
  const handle = container.querySelector<HTMLElement>('[role="separator"]')
  expect(handle, 'the bottom pane frame is open').not.toBeNull()
  return handle!.parentElement as HTMLElement
}

/** The pane's OWN strip tabs. Scoped through the frame on purpose: the
 *  header's lens SegmentedControl is also a `role="tablist"`, so an unscoped
 *  query would let it satisfy the assertion. */
function paneTabs(container: HTMLElement): HTMLButtonElement[] {
  return [...paneOf(container).querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}

/** The graph section reports its selection one effect after the row click, so
 *  a commit needs a couple of flushes to settle. */
async function settle(): Promise<void> {
  await flushEffects()
  await flushEffects()
}

/** Select the one commit the graph SECTION renders: the Graph area lives inside
 *  the Git lens (unfolded by default), so the row is on screen after mount. */
async function openGraphCommit(container: HTMLElement): Promise<void> {
  const row = container.querySelector<HTMLButtonElement>(`[data-graph-commit="${GRAPH_HASH}"]`)
  expect(row, 'the mocked graph page rendered its commit row').not.toBeNull()
  await act(async () => { row!.click() })
  await settle()
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ChangesTab', () => {
  it('uses the official underline Tabs with keyboard navigation, persisted lens and refresh', async () => {
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps').mockResolvedValue({ events: [], lastSeq: 0 })
    const updateTab = vi.fn()
    const ctx = { get: () => ({ updateTab }) } as unknown as Context
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root, { id: 'git', type: 'git', title: 'Changes', meta: { lens: 'session', previewH: 240 } }, ctx)
      await flushEffects()

      const tabs = container.querySelector<HTMLElement>('[role="tablist"]')!
      const git = lensTab(container, t('changesGitLens'))!
      const session = lensTab(container, t('changesSessionLens'))!
      expect(tabs.classList.contains('wSkVaW_tabs')).toBe(true)
      expect(tabs.getAttribute('aria-label')).toBe(t('changes'))
      expect(git.classList.contains('wSkVaW_tab')).toBe(true)
      const panels = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
      const selected = (button: HTMLButtonElement): void => {
        expect(button.classList.contains('wSkVaW_tabActive')).toBe(true)
        expect(button.getAttribute('aria-selected')).toBe('true')
        expect(button.tabIndex).toBe(0)
        // Both lenses own a panel (they stay mounted and swap `hidden`), so the
        // tab points at ITS panel, that panel points back, and exactly one of
        // them is on screen.
        const own = panels().find(node => node.id === button.getAttribute('aria-controls'))!
        expect(own, 'the tab points at a panel that exists').toBeDefined()
        expect(own.getAttribute('aria-labelledby')).toBe(button.id)
        expect(panels().filter(node => !node.hidden)).toEqual([own])
      }
      selected(session)
      expect(git.tabIndex).toBe(-1)
      session.focus()
      const key = async (button: HTMLButtonElement, name: string): Promise<void> => {
        const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
        await act(async () => { button.dispatchEvent(event) })
        expect(event.defaultPrevented).toBe(true)
      }
      await key(session, 'ArrowRight') // wraps to the first tab
      selected(git)
      expect(document.activeElement).toBe(git)
      expect(session.classList.contains('wSkVaW_tabActive')).toBe(false)
      expect(session.getAttribute('aria-selected')).toBe('false')
      expect(updateTab).toHaveBeenLastCalledWith('git', { meta: { lens: 'git', previewH: 240 } }, 'session')
      await key(git, 'ArrowLeft') // wraps to the last tab
      selected(session)
      await key(session, 'Home')
      selected(git)
      await key(git, 'End')
      selected(session)
      expect(updateTab).toHaveBeenLastCalledWith('git', { meta: { lens: 'session', previewH: 240 } }, 'session')

      const calls = ops.mock.calls.length
      await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${t('refresh')}"]`)!.click() })
      await flushEffects()
      expect(ops).toHaveBeenCalledTimes(calls + 1)
      const sheet = readFileSync('src/client/changes/changes.module.css', 'utf8')
      expect(sheet).toMatch(/\.head :global\(\.wSkVaW_tabs\) \{ gap: 24px; \}/)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders the git lens by default and previews a file row in the pane', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitDiff').mockResolvedValue({
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // Git lens: the change reads as a TREE — the directory row owns the
      // path segment, the file row its own name, its porcelain letter and the
      // host's file artwork.
      const dir = container.querySelector<HTMLButtonElement>('button[data-dir="src"]')
      expect(dir).not.toBeNull()
      expect(dir!.getAttribute('aria-expanded')).toBe('true')
      const row = container.querySelector<HTMLButtonElement>('button[data-path="src/a.ts"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('a.ts')
      expect(row!.textContent).toContain('M')
      expect(row!.querySelector('svg')).not.toBeNull()

      // Clicking the row previews inline (no diff tab minted): the shared
      // renderer draws the added row.
      await act(async () => { row!.click() })
      await flushEffects()
      expect(container.textContent).toContain('new')

      // The preview survives a lens switch (it is a dock, not lens state).
      const sessionTab = lensTab(container, t('changesSessionLens'))
      expect(sessionTab).toBeDefined()
      await act(async () => { sessionTab!.click() })
      expect(container.textContent).toContain('src/a.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  /**
   * Issue #131, appearance half: a pure rename is `0 0` in numstat, so its row
   * prints no numbers — and a group whose ONLY changes are renames used to
   * render an empty `+N −M` cluster in its header, because the total counted
   * the (numberless) rename row as a contributor. The contrast case is the
   * other half of the gate: with one row that really has numbers, the cluster
   * is back and carries exactly those numbers.
   */
  it('renders no count cluster for a group whose only changes are pure renames (#131)', async () => {
    mockGit([
      { path: 'renamed.ts', xy: 'R ', staged: { additions: 0, deletions: 0 } },
      { path: 'moved.md', xy: ' R', unstaged: { additions: 0, deletions: 0 } },
    ])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const staged = container.querySelector<HTMLElement>('[data-group="staged"]')
      const unstaged = container.querySelector<HTMLElement>('[data-group="unstaged"]')
      // Both groups really rendered their rename row, so the absence asserted
      // below is the counts cluster's, not the whole group's.
      expect(staged!.querySelectorAll('button[data-path]')).toHaveLength(1)
      expect(unstaged!.querySelectorAll('button[data-path]')).toHaveLength(1)
      expect(staged!.querySelector('[data-lines="group"]')).toBeNull()
      expect(unstaged!.querySelector('[data-lines="group"]')).toBeNull()
      // The renames are still listed with their count pill (the FILE count).
      expect(staged!.querySelector('[data-count]')!.textContent).toBe('1')
      expect(unstaged!.querySelector('[data-count]')!.textContent).toBe('1')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps the group total when a row in the group really has numbers (#131)', async () => {
    mockGit([
      { path: 'mode-only.ts', xy: ' M', unstaged: { additions: 0, deletions: 0 } },
      { path: 'edited.ts', xy: ' M', unstaged: { additions: 3, deletions: 1 } },
    ])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const unstaged = container.querySelector<HTMLElement>('[data-group="unstaged"]')
      const cluster = unstaged!.querySelector<HTMLElement>('[data-lines="group"]')
      expect(cluster).not.toBeNull()
      expect(cluster!.getAttribute('data-added')).toBe('3')
      expect(cluster!.getAttribute('data-deleted')).toBe('1')
      expect(cluster!.textContent).toContain('+3')
      // The cluster is not merely present — it carries text (an EMPTY cluster
      // is exactly the artifact this pair of cases is about).
      expect(cluster!.textContent).not.toBe('')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('sizes the count cluster from a font token, never from a bare px (#131)', () => {
    // Skin contract (guide §12): visual values ride `--dsw-font-*` / `--ds-*`
    // tokens. The row/band cluster is the one place in this sheet that used a
    // literal `font-size: 10px`, two pixels off the smallest host token.
    const sheet = readFileSync('src/client/changes/changes.module.css', 'utf8')
    const block = sheet.match(/\n\.lineCounts \{([\s\S]*?)\n\}/)?.[1]
    expect(block, 'the .lineCounts rule must exist in changes.module.css').toBeDefined()
    expect(block!).toContain('font: var(--dsw-font-')
    expect(block!).toContain('font-family: var(--ds-font-family-code')
    expect(block!).not.toMatch(/font-size:\s*[\d.]+px/)
  })

  it('folds the polled session events into session-lens rows and the badge cache', async () => {
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps')
      .mockResolvedValue({ events: [...writeEvents(1, 'src/a.ts'), ...writeEvents(3, 'src/b.ts')], lastSeq: 4 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // Opening the tab pulls once and publishes the op count (the tab-strip
      // badge reads this cache).
      expect(ops).toHaveBeenCalled()
      expect(opCountOf('session')).toBe(2)

      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      // Two operation rows, newest first; the write chip carries its count.
      expect(container.textContent).toContain('src/b.ts')
      expect(container.textContent).toContain('src/a.ts')
      const chips = [...container.querySelectorAll('button[aria-pressed]')]
      expect(chips.some(chip => /写入\s*2|Write\s*2/.test(chip.textContent ?? ''))).toBe(true)
      // The Git lens (including its footer branch menu) is RETAINED behind the
      // switch: hidden, state intact, and no longer fetching.
      const gitRoot = container.querySelector<HTMLElement>('[data-git-root]')!
      expect(gitRoot).not.toBeNull()
      expect((gitRoot.closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(true)
      expect(gitRoot.querySelector('[data-git-footer]')).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('lists interleaved operations without file groups and keeps filtering and previews', async () => {
    mockGit([])
    const path = 'D:\\projects\\cc-switch\\test-01.txt'
    vi.spyOn(api, 'changesOps').mockResolvedValue({
      events: [
        { type: 'tool/call', seq: 1, time: 1, data: { name: 'read', callId: 'r1', arguments: JSON.stringify({ file_path: path }) } },
        { type: 'tool/result', seq: 2, time: 2, data: { message: { source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'text', text: '<content>1: earlier read</content>' }] } } },
        ...writeEvents(3, 'src/other.txt'),
        { type: 'tool/call', seq: 5, time: 5, data: { name: 'edit', callId: 'e5', arguments: JSON.stringify({ file_path: path, old_string: 'old', new_string: 'x'.repeat(103) }) } },
        { type: 'tool/result', seq: 6, time: 6, data: { message: { source: { kind: 'tool', callId: 'e5' }, content: [{ type: 'text', text: 'ok' }] } } },
        { type: 'tool/call', seq: 7, time: 7, data: { name: 'read', callId: 'r7', arguments: JSON.stringify({ file_path: path }) } },
      ],
      lastSeq: 7,
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root, { id: 'git', type: 'git', title: 'Changes', meta: { lens: 'session' } })
      await flushEffects()
      const rows = [...container.querySelectorAll<HTMLButtonElement>('button[data-op-kind]')]
      expect(rows.map(row => row.dataset.opKind)).toEqual(['read', 'edit', 'write', 'read'])
      // A relative tool path reaches the row resolved against the session cwd
      // (#875); an absolute one keeps its own spelling.
      expect(rows.map(row => row.querySelector('[title]')?.getAttribute('title')))
        .toEqual([path, path, 'C:/repo/main/src/other.txt', path])
      expect(rows[0]!.textContent).toContain(t('changesRunning'))
      for (const row of rows) {
        // Rows are direct siblings, not nested inside per-file wrappers.
        expect(row.parentElement).toBe(rows[0]!.parentElement)
        const label = row.querySelector('[data-tone]')!
        const filePath = row.querySelector('[title]')!
        expect(filePath.textContent).toBe(filePath.getAttribute('title'))
        expect(label.compareDocumentPosition(filePath) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(row.lastElementChild).toBe(filePath.nextElementSibling)
      }
      expect([...rows[0]!.parentElement!.children]).toEqual(rows)
      expect(rows[1]!.lastElementChild!.firstElementChild!.textContent).toBe('103 B')

      await act(async () => { rows[1]!.click() })
      await flushEffects()
      expect(rows[1]!.dataset.selected).toBe('true')
      expect(container.textContent).toContain('x'.repeat(103))

      const readChip = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
        .find(chip => chip.textContent === t('changesRead') + '2')
      expect(readChip).toBeDefined()
      await act(async () => { readChip!.click() })
      const reads = [...container.querySelectorAll<HTMLButtonElement>('button[data-op-kind]')]
      expect(reads.map(row => row.dataset.opKind)).toEqual(['read', 'read'])
      expect(reads.map(row => row.querySelector('[title]')?.textContent)).toEqual([path, path])
      await act(async () => { reads[1]!.click() })
      await flushEffects()
      expect(reads[1]!.dataset.selected).toBe('true')
      expect(container.textContent).toContain('earlier read')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps operation paths and metadata on one line under width pressure', () => {
    const sheet = readFileSync('src/client/changes/changes.module.css', 'utf8')
    const pathRule = sheet.match(/\n\.filePath \{([^}]+)\}/)?.[1]
    expect(pathRule).toContain('flex: 1')
    expect(pathRule).toContain('min-width: 0')
    expect(pathRule).toContain('overflow: hidden')
    expect(pathRule).toContain('text-overflow: ellipsis')
    expect(pathRule).toContain('white-space: nowrap')
    expect(sheet.match(/\n\.opMeta \{([^}]+)\}/)?.[1]).toContain('white-space: nowrap')
  })

  it('renders a .md read op in reading mode through the shared MarkdownText', async () => {
    mockGit([])
    const md = ['# Title', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '![pic](./img.png)', ''].join('\n')
    const numbered = md.split('\n').map((line, i) => String(i + 1) + ': ' + line).join('\n')
    const envelope = '<content>\n' + numbered + '\n</content>'
    vi.spyOn(api, 'changesOps').mockResolvedValue({
      events: [
        { type: 'tool/call', seq: 1, time: 1, data: { name: 'read', callId: 'r1', arguments: JSON.stringify({ file_path: 'C:/repo/main/notes.md' }) } },
        { type: 'tool/result', seq: 2, time: 2, data: { message: { source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: envelope }] }] } } },
      ],
      lastSeq: 2,
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // Session lens: open the read op's preview. A read has no diff, so the
      // pane's only view is `content` — no strip, no mixing into a diff view.
      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      const row = container.querySelector<HTMLButtonElement>('button[data-op-kind="read"]')
      expect(row).toBeDefined()
      expect(container.textContent).toContain('notes.md')
      await act(async () => { row!.click() })
      await flushEffects()

      // Rendered GFM immediately (the plugin's renderer is the point of the
      // content tab) — no raw detour first.
      expect(container.querySelector('h1')?.textContent).toContain('Title')
      expect(container.querySelector('table')).not.toBeNull()
      // The local image destination was rewritten to the media route.
      const img = container.querySelector('img')
      expect(img?.getAttribute('src')).toContain('/sidebar/file?')
      // The source toggle lives on the content view; flipping it shows the
      // line-numbered source, flipping back re-renders.
      const rawToggle = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => (button.textContent ?? '').match(/原文|Raw/))
      expect(rawToggle).toBeDefined()
      await act(async () => { rawToggle!.click() })
      await flushEffects()
      expect(container.querySelector('h1')).toBeNull()
      const readingToggle = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => (button.textContent ?? '').match(/阅读|Reading/))
      await act(async () => { readingToggle!.click() })
      await flushEffects()
      expect(container.querySelector('h1')?.textContent).toContain('Title')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders exactly one clean empty state, and the graph has its own', async () => {
    mockGit([])
    mockGraphEmpty()
    vi.spyOn(api, 'changesOps').mockResolvedValue({ events: [], lastSeq: 0 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      // Two passes: the Graph section answers on its OWN route, so its empty
      // state lands one flush after the status store's.
      await settle()

      // A clean repository says it ONCE: both sections (unstaged/staged) used
      // to print their own "no changes" line under the same message. The Graph
      // area says its own (it is a separate section, with its own route).
      const gitLens = container.querySelector<HTMLElement>('[data-git-root]')!
      const empties = [...gitLens.querySelectorAll<HTMLElement>('[data-kind="empty"]')]
        .map(node => node.textContent)
      expect(empties).toEqual([t('changesClean')])
      expect(container.querySelector('[aria-labelledby$="-session"]')!.textContent).toContain(t('changesSessionEmpty'))
      expect(container.querySelector('[data-scm-section="graph"]')!.textContent).toContain(t('graphEmpty'))
      // No resource group or tree row is rendered when nothing changed.
      expect(container.querySelectorAll('[data-group]')).toHaveLength(0)
      expect(container.querySelectorAll('[data-path]')).toHaveLength(0)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('reports a failed stage action in the footer and catches it (no unhandled rejection)', async () => {
    mockGraphEmpty()
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitStage').mockRejectedValue(new Error('index.lock exists'))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const stage = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('stage')}"]`)
      expect(stage).not.toBeNull()
      await act(async () => { stage!.click() })
      await flushEffects()

      const alerts = [...container.querySelectorAll<HTMLElement>('[role="alert"]')]
      const alert = alerts.find(node => (node.textContent ?? '').includes(t('changesStageFailed', { message: 'index.lock exists' })))
      expect(alert).toBeDefined()
      // Exactly ONE alert reports the stage failure (the graph area has its own
      // channel and is quiet here).
      expect(alerts.filter(node => (node.textContent ?? '').includes(t('changesStageFailed', { message: 'index.lock exists' }))))
        .toHaveLength(1)
      // The ONE action status line stays visible with the checkout/sync footer.
      const footer = container.querySelector('[data-git-footer]')
      const input = container.querySelector('[data-message-box] textarea')
      expect(input).not.toBeNull()
      expect(alert!.parentElement).toBe(footer)
      expect(alert!.nextElementSibling).toBe(footer!.querySelector('[data-footer-row]'))
      expect(container.querySelector('[data-git-scroll]')!.contains(alert!)).toBe(false)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('draws stage as a plus and unstage as a minus, like the Source Control view', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }, { path: 'src/b.ts', xy: 'M ' }])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const iconOf = (label: string): string => {
        const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        expect(button, label).not.toBeNull()
        return button!.querySelector('svg')!.innerHTML
      }
      // A stage affordance that drew the unstage glyph is the #941 regression:
      // the two directions must not share artwork (vscode: $(add) vs $(remove)).
      // Unstage is the horizontal half alone; staging adds the vertical stroke
      // (the host's Plus) — the two directions must not share one glyph.
      const stage = iconOf(t('stage'))
      const unstage = iconOf(t('unstage'))
      expect(unstage).toContain(MINUS_GLYPH)
      expect(unstage).not.toContain('M8 2V14')
      expect(stage).toContain('M8 2V14')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('hangs every tree row on the Source Control indent guides', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const guides = (row: string): string[] => [...container.querySelector(`[data-row="${row}"]`)!
        .querySelectorAll<HTMLElement>('[data-guide]')].map(node => node.style.left)
      // A group's own column carries no line; each level below adds one, in the
      // column the pre-SCM nested tree drew it (17px, +12 per level).
      expect(guides('src')).toEqual([])
      expect(guides('src/a.ts')).toEqual(['17px'])
      // The guides are decoration: the row's own indent is untouched.
      expect(container.querySelector<HTMLElement>('[data-row="src/a.ts"]')!.style.paddingLeft).toBe('20px')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps Git refresh in Changes and re-derives the session preview on manual refresh', async () => {
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps')
      // The call starts running: no result yet, so the write has no payload.
      .mockResolvedValueOnce({
        events: [{ type: 'tool/call', seq: 1, time: 1, data: { name: 'write', callId: 'w1', arguments: JSON.stringify({ file_path: 'notes.txt' }) } }],
        lastSeq: 1,
      })
      // The result lands in a later delta and settles the same callId.
      .mockResolvedValueOnce({
        events: [{ type: 'tool/result', seq: 2, time: 2, data: { message: { source: { kind: 'tool', callId: 'w1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'settled-body' }] }] } } }],
        lastSeq: 2,
      })
      .mockResolvedValue({ events: [], lastSeq: 2 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      const refreshSelector = `button[aria-label="${t('refresh')}"]`
      const head = container.querySelector('[role="tablist"]')!.parentElement!
      const gitPanel = (): HTMLElement => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
        .find(node => node.id.endsWith('-git-panel'))!
      // Git has one refresh, inside Changes rather than beside the lens tabs;
      // the session lens's own action lives in the header instead.
      expect(head.querySelector(refreshSelector)).toBeNull()
      expect(gitPanel().querySelectorAll(refreshSelector)).toHaveLength(1)
      expect(container.querySelector(`[data-scm-section="changes"] ${refreshSelector}`)).not.toBeNull()
      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })

      const row = container.querySelector<HTMLButtonElement>('button[data-op-kind="write"]')
      expect(row).toBeDefined()
      await act(async () => { row!.click() })
      await flushEffects()
      expect(container.textContent).toContain(t('changesPriorUnknown'))
      expect(container.textContent).not.toContain('settled-body')

      // The header's refresh pulls the delta; the SAME preview must pick the
      // settled payload up without the user re-clicking the row.
      const refresh = head.querySelector<HTMLButtonElement>(refreshSelector)
      expect(refresh).not.toBeNull()
      // The header carries the session lens's action, and only one of it (the
      // Git lens keeps its own inside the retained panel above).
      expect(head.querySelectorAll(refreshSelector)).toHaveLength(1)
      expect(ops).toHaveBeenCalledTimes(1)
      await act(async () => { refresh!.click() })
      await flushEffects()
      expect(ops).toHaveBeenLastCalledWith({ sessionId: 'session', cwd: MAIN }, 1, undefined, true)
      expect(container.textContent).toContain('settled-body')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('shows a graph failure instead of claiming there are no commits', async () => {
    mockGit([])
    vi.spyOn(api, 'gitGraph').mockRejectedValue(new Error('bad object'))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      expect(container.textContent).toContain(t('graphLoadError'))
      expect(container.textContent).not.toContain(t('graphEmpty'))
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps the preview redaction toggle working (a secret file masks by default)', async () => {
    mockGit([])
    localStorage.removeItem('dsh-sidebar:v1:redaction')
    vi.spyOn(api, 'changesOps').mockResolvedValue({
      events: [
        { type: 'tool/call', seq: 1, time: 1, data: { name: 'read', callId: 'r1', arguments: JSON.stringify({ file_path: 'C:/repo/main/.env' }) } },
        { type: 'tool/result', seq: 2, time: 2, data: { message: { source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '<content>1: OPENAI_API_KEY=sk-abcdefghijklmnop</content>' }] }] } } },
      ],
      lastSeq: 2,
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      const row = container.querySelector<HTMLButtonElement>('button[data-op-kind="read"]')
      await act(async () => { row!.click() })
      await flushEffects()

      // Redaction is on by default: the secret never reaches the DOM.
      expect(container.textContent).toContain('[REDACTED]')
      expect(container.textContent).not.toContain('sk-abcdefghijklmnop')

      // The kit toggle (a Chip) turns it off, and only then does the raw value
      // render; toggling back masks it again.
      const byLabel = (label: string): HTMLButtonElement | undefined =>
        [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find(button => (button.textContent ?? '') === label)
      const on = byLabel(t('changesRedactOnLabel'))
      expect(on).toBeDefined()
      await act(async () => { on!.click() })
      await flushEffects()
      expect(container.textContent).toContain('sk-abcdefghijklmnop')
      const off = byLabel(t('changesRedactOffLabel'))
      expect(off).toBeDefined()
      await act(async () => { off!.click() })
      await flushEffects()
      expect(container.textContent).not.toContain('sk-abcdefghijklmnop')
    } finally {
      act(() => { root.unmount() })
      container.remove()
      localStorage.removeItem('dsh-sidebar:v1:redaction')
    }
  })

  it('clamps the restored preview height to the pane bounds', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitDiff').mockResolvedValue({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    })

    /** Open the pane with one persisted height and read back the rendered one. */
    const paneHeightFor = async (previewH: number): Promise<string | undefined> => {
      const container = document.createElement('div')
      document.body.append(container)
      const root: Root = createRoot(container)
      try {
        mount(root, { id: 'git', type: 'git', title: 'Changes', meta: { previewH } })
        await flushEffects()
        const row = container.querySelector<HTMLButtonElement>('button[data-path="src/a.ts"]')
        expect(row).not.toBeNull()
        await act(async () => { row!.click() })
        await flushEffects()
        return container.querySelector<HTMLElement>('[role="separator"]')?.parentElement?.style.height
      } finally {
        act(() => { root.unmount() })
        container.remove()
      }
    }

    // A height saved under a taller window cannot open past the pane's cap...
    expect(await paneHeightFor(5000)).toBe(`${String(Math.round(window.innerHeight * 0.7))}px`)
    // ...and an unusably small one is raised to the content minimum.
    expect(await paneHeightFor(50)).toBe('140px')
  })

  /**
   * Issue #194's single-scroller frame survives #941: Message, groups and Graph
   * now scroll together, while the checkout/sync footer stays docked outside.
   * The old selector band and bottom commit bar are intentionally gone.
   */
  it('scrolls Message, change groups and Graph together with the footer outside (#194, #941)', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    // The Graph section reads its own bounded route (#969): one commit page.
    mockGraph()

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const frame = container.querySelector<HTMLElement>('[data-git-root]')
      const scroller = container.querySelector<HTMLElement>('[data-git-scroll]')
      const footer = container.querySelector<HTMLElement>('[data-git-footer]')
      expect(frame).not.toBeNull()
      expect(scroller).not.toBeNull()
      expect(footer).not.toBeNull()
      expect(frame!.hasAttribute('data-git-scroll')).toBe(false)
      expect(container.querySelectorAll('[data-git-scroll]')).toHaveLength(1)
      expect(scroller!.parentElement).toBe(frame)
      expect(footer!.parentElement).toBe(frame)
      expect(scroller!.contains(footer!)).toBe(false)
      expect(scroller!.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(footer!.querySelector('[data-footer-row] button[aria-haspopup="menu"]')).not.toBeNull()
      expect(container.querySelector('[data-git-head]')).toBeNull()
      expect(container.querySelector('[data-commit-bar]')).toBeNull()

      const changes = scroller!.querySelector('[data-scm-section="changes"]')
      const graph = scroller!.querySelector('[data-scm-section="graph"]')
      // The repo / worktree pickers moved into More Actions (#944), so the
      // Graph section's branch filter is the only select left in the lens.
      const selects = [...container.querySelectorAll('select')]
      expect(selects).toHaveLength(1)
      expect(graph!.contains(selects[0]!)).toBe(true)
      const message = changes!.querySelector('[data-message-box]')
      const unstaged = changes!.querySelector('[data-group="unstaged"]')
      expect(message!.querySelector('textarea')).not.toBeNull()
      expect(unstaged!.querySelector('[data-path="src/a.ts"]')).not.toBeNull()
      expect(changes!.querySelector('[data-group="staged"]')).toBeNull()
      expect(message!.compareDocumentPosition(unstaged!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(changes!.compareDocumentPosition(graph!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const graphRow = graph!.querySelector<HTMLElement>('[data-graph-commit]')
      expect(graphRow).not.toBeNull()
      expect(graphRow!.textContent).toContain(GRAPH_SUBJECT)
      expect(footer!.querySelector('textarea')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps one inner scroller and pins the footer to the bottom (#194, #941)', () => {
    // jsdom has no layout engine, so the sheet itself is the docking evidence.
    const sheet = readFileSync('src/client/changes/changes.module.css', 'utf8')
    const rule = (selector: string): string => {
      const block = sheet.match(new RegExp(`\\n\\${selector} \\{([^}]+)\\}`))?.[1]
      expect(block, `the ${selector} rule must exist in changes.module.css`).toBeDefined()
      return block!
    }

    expect(rule('.git')).not.toContain('overflow')
    expect(rule('.git')).toContain('display: flex')
    expect(rule('.gitScroll')).toContain('overflow-y: auto')
    expect(rule('.gitScroll')).toContain('overflow-x: hidden')
    expect(rule('.gitScroll')).toContain('flex: 1')
    expect(rule('.gitScroll')).toContain('flex-direction: column')
    expect(rule('.changesSection')).toContain('flex: none')
    expect(rule('.graphSection')).toContain('flex: 1')
    expect(rule('.graphArea')).toContain('flex: 1')
    expect(rule('.graphArea')).not.toContain('height: min(')
    // Docked by flex, and sticky so a host-scrolled tab body cannot carry the
    // branch control off the bottom of the pane either.
    expect(rule('.gitFooter')).toContain('flex: none')
    expect(rule('.gitFooter')).toContain('position: sticky')
    expect(rule('.gitFooter')).toContain('bottom: 0')
    expect(rule('.gitFooter')).not.toContain('overflow')
    expect(rule('.messageBox')).not.toMatch(/position|sticky|overflow/)
    expect(sheet).not.toMatch(/\.(?:selectors|select|branchLabel|commitBar|commitRow)\s*\{/)
    // The retained group headers still park on the inner body's top edge.
    const groupHeader = rule('.group .groupHeader')
    expect(groupHeader).toContain('position: sticky')
    expect(groupHeader).toContain('top: 0')
  })

  it('polls the session events only while the session lens is on screen', async () => {
    vi.useFakeTimers()
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps').mockResolvedValue({ events: [], lastSeq: 0 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      // Opening the tab is one catch-up pull (the badge count follows it).
      expect(ops).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      // The git lens has no use for the session event log: no cadence at all.
      expect(ops).toHaveBeenCalledTimes(1)

      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      // On screen: the 2.5s delta cadence runs.
      expect(ops.mock.calls.length).toBeGreaterThan(1)
    } finally {
      act(() => { root.unmount() })
      container.remove()
      vi.useRealTimers()
    }
  })
})

/**
 * The bottom region's tab strip. The set is PINNED to the same three views for
 * every preview and every lens — `details` (the selected commit), `content`
 * (the file itself, rendered for md/html/pdf) and `diff` (the patch) — so the
 * panel above which lens is active is always the same one; a view with nothing
 * to show renders its empty state rather than vanishing. The choice persists
 * as `meta.paneTab` beside `lens` / `previewH`.
 */
describe('ChangesTab bottom pane tabs', () => {
  it('opens ONE pane whose tablist is the same [details, content, diff] everywhere, details active by default', async () => {
    mockGit([])
    mockGraph()

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      await openGraphCommit(container)

      // ONE region: a single drag handle, and the strip is its sibling INSIDE
      // that same frame (the header's lens control is outside it).
      expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1)
      const pane = paneOf(container)
      expect(pane.children[0]!.getAttribute('role')).toBe('separator')
      expect(pane.children[1]!.getAttribute('role')).toBe('tablist')
      const tabs = paneTabs(container)
      expect(tabs.map(tab => tab.textContent)).toEqual([t('graphDetails'), t('changesContentTab'), t('changesDiffTab')])
      // Details is the default for the FIRST graph selection; roving tabIndex
      // makes it the only tab stop.
      expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
      expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1])

      // The card lives inside the pane frame, NOT inside the graph lens.
      const details = pane.querySelector<HTMLElement>(`section[aria-label="${t('graphDetails')}"]`)
      expect(details).not.toBeNull()
      expect(container.querySelector('[data-git-graph]')!.contains(details!)).toBe(false)
      expect(details!.querySelector('strong')!.textContent).toBe(GRAPH_SUBJECT)
      // Full 40-char hash chip, and the message as MARKDOWN in its own block:
      // the raw body's first line (the subject) was split off, so the body
      // carries only the heading + the list — and never a duplicated title.
      expect(details!.querySelector('code')!.textContent).toBe(GRAPH_HASH)
      const body = details!.querySelector<HTMLElement>('[class*="messageBody"]')!
      expect(body).not.toBeNull()
      expect(body.querySelector('h2')!.textContent).toContain('Retry loop')
      expect(body.querySelector('li')!.textContent).toContain('bullet')
      expect(body.textContent).not.toContain(GRAPH_SUBJECT)
      expect(details!.querySelector('pre')).toBeNull()
      // The lens's remote inventory reached the card, so origin/main reads muted
      // rather than local, and HEAD folded into the current branch's pill (the
      // emphasised tone + the current marker) instead of a pill of its own.
      const tones = [...details!.querySelectorAll<HTMLElement>('[data-tone]')]
      expect(tones.map(pill => [pill.textContent, pill.getAttribute('data-tone'), pill.getAttribute('data-current')])).toEqual([
        ['origin/main', 'remote', null],
        ['topic', 'head', 'true'],
      ])
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('swaps the pane head/body for the active tab and restores the card on the way back', async () => {
    mockGit([])
    mockGraph()

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const detailsSelector = `section[aria-label="${t('graphDetails')}"]`
    try {
      mount(root)
      await flushEffects()
      await openGraphCommit(container)
      expect(paneOf(container).querySelector(detailsSelector)).not.toBeNull()

      // The CONTENT tab of a commit target has no file to show: its empty
      // state stands in rather than the tab disappearing.
      await act(async () => { paneTabs(container)[1]!.click() })
      await settle()
      expect(paneOf(container).querySelector(detailsSelector)).toBeNull()
      expect(paneOf(container).textContent).toContain(t('changesNoContent'))

      // The diff tab renders the pane's OWN head and body for the commit.
      await act(async () => { paneTabs(container)[2]!.click() })
      await settle()
      const pane = paneOf(container)
      expect(paneTabs(container).map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
      expect(pane.querySelector(detailsSelector)).toBeNull()
      // The head carries the short hash + subject, the body the loaded patch.
      expect(pane.textContent).toContain(GRAPH_SUBJECT)
      expect(pane.textContent).toContain('graph-only-diff-line')
      // The full hash is the details card's chip only.
      expect(pane.textContent).not.toContain(GRAPH_HASH)

      // Back to details: the card returns, the diff body is gone.
      await act(async () => { paneTabs(container)[0]!.click() })
      await settle()
      expect(paneOf(container).querySelector(detailsSelector)).not.toBeNull()
      expect(paneOf(container).textContent).not.toContain('graph-only-diff-line')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('shows the SAME pinned strip for a Git-lens file preview (content + diff, no commit selected)', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitDiff').mockResolvedValue({ diff: WORKTREE_DIFF })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      const row = container.querySelector<HTMLButtonElement>('button[data-path="src/a.ts"]')!
      await act(async () => { row.click() })
      await flushEffects()

      expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1)
      const pane = paneOf(container)
      // Same strip as everywhere else — the lens above does not change it.
      expect(paneTabs(container).map(tab => tab.textContent)).toEqual([t('graphDetails'), t('changesContentTab'), t('changesDiffTab')])
      // …landing on the diff, because that is what clicking a file means.
      expect(paneTabs(container).map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
      expect(pane.textContent).toContain('src/a.ts')
      expect(pane.textContent).toContain('worktree-only-diff-line')
      // With no commit selected the details view explains itself.
      await act(async () => { paneTabs(container)[0]!.click() })
      await settle()
      expect(paneOf(container).textContent).toContain(t('changesNoCommit'))
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders the FILE ITSELF on the content tab of a git worktree target (fs.read, no diff)', async () => {
    mockGit([{ path: 'src/notes.md', xy: ' M' }])
    vi.spyOn(api, 'gitDiff').mockResolvedValue({ diff: WORKTREE_DIFF })
    const read = vi.spyOn(api, 'fsRead').mockResolvedValue({
      kind: 'text', content: '# Live file\n\nbody line\n', size: 26,
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      const row = container.querySelector<HTMLButtonElement>('button[data-path="src/notes.md"]')!
      await act(async () => { row.click() })
      await flushEffects()

      // Opening the file for its DIFF must not pull the document: the content
      // loader is deferred until that view is the one on screen.
      expect(read).not.toHaveBeenCalled()
      expect(paneOf(container).textContent).toContain('worktree-only-diff-line')

      // The content view reads the live file and renders markdown (the plugin
      // renderer), not a diff and not a <pre>.
      await act(async () => { paneTabs(container)[1]!.click() })
      await settle()
      expect(read).toHaveBeenCalledTimes(1)
      await settle()
      const pane = paneOf(container)
      expect(pane.querySelector('h1')?.textContent).toContain('Live file')
      expect(pane.textContent).toContain('body line')
      expect(pane.textContent).not.toContain('worktree-only-diff-line')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('restores a persisted diff tab and writes the chosen tab back through the meta', async () => {
    mockGit([])
    mockGraph()
    const updateTab = vi.fn()

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const detailsSelector = `section[aria-label="${t('graphDetails')}"]`
    try {
      mount(root, { id: 'git', type: 'git', title: 'Changes', meta: { paneTab: 'diff' } }, metaContext(updateTab))
      await flushEffects()
      await openGraphCommit(container)

      // Restored, not re-defaulted to details.
      expect(paneTabs(container).map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
      expect(paneOf(container).querySelector(detailsSelector)).toBeNull()
      expect(paneOf(container).textContent).toContain('graph-only-diff-line')
      // The only meta write so far is the lens switch, and it carried the
      // restored `diff` — nothing re-defaulted the pane tab to `details`.
      expect(updateTab.mock.calls.every(call =>
        (call[1] as { meta: { paneTab?: string } }).meta.paneTab === 'diff')).toBe(true)

      // Choosing a tab persists it beside lens / previewH, on the tab meta.
      await act(async () => { paneTabs(container)[0]!.click() })
      await settle()
      expect(paneOf(container).querySelector(detailsSelector)).not.toBeNull()
      expect(updateTab).toHaveBeenLastCalledWith('git', { meta: { paneTab: 'details' } }, 'session')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps the details tab when the lens switches — the bottom pane is ONE shared region', async () => {
    mockGit([])
    mockGraph()

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const detailsSelector = `section[aria-label="${t('graphDetails')}"]`
    try {
      mount(root)
      await flushEffects()
      await openGraphCommit(container)
      expect(paneTabs(container)).toHaveLength(3)
      expect(paneOf(container).querySelector(detailsSelector)).not.toBeNull()

      // The pane below is independent of the lens above: switching to the
      // session lens must NOT disarm the strip or drop the commit card — the
      // selection lives until the graph itself loses the commit (or the tab
      // goes away), not until the lens hides.
      await act(async () => { lensTab(container, t('changesSessionLens'))!.click() })
      await settle()
      const pane = paneOf(container)
      expect(pane.querySelector('[role="tablist"]')).not.toBeNull()
      expect(paneTabs(container).map(tab => tab.textContent)).toEqual([t('graphDetails'), t('changesContentTab'), t('changesDiffTab')])
      expect(pane.querySelector(detailsSelector)).not.toBeNull()
      // The graph's own diff preview is still the diff tab's body.
      await act(async () => { paneTabs(container)[2]!.click() })
      await flushEffects()
      expect(pane.textContent).toContain('graph-only-diff-line')
      // … and the details card comes back without any graph round-trip.
      await act(async () => { paneTabs(container)[0]!.click() })
      await flushEffects()
      expect(pane.querySelector(detailsSelector)).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('moves the active tab with ArrowLeft / ArrowRight / Home / End', async () => {
    mockGit([])
    mockGraph()

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      await openGraphCommit(container)
      const selected = (): (string | null)[] =>
        paneTabs(container).map(tab => tab.getAttribute('aria-selected'))
      const press = async (index: number, key: string): Promise<void> => {
        await act(async () => { Simulate.keyDown(paneTabs(container)[index]!, { key }) })
      }
      expect(selected()).toEqual(['true', 'false', 'false'])
      await press(0, 'ArrowRight')
      expect(selected()).toEqual(['false', 'true', 'false'])
      await press(1, 'ArrowRight')
      expect(selected()).toEqual(['false', 'false', 'true'])
      await press(2, 'ArrowLeft')
      expect(selected()).toEqual(['false', 'true', 'false'])
      // End / Home jump to the last / first tab.
      await press(1, 'End')
      expect(selected()).toEqual(['false', 'false', 'true'])
      await press(2, 'Home')
      expect(selected()).toEqual(['true', 'false', 'false'])
      // The roving tabIndex followed the selection all the way back.
      expect(paneTabs(container).map(tab => tab.tabIndex)).toEqual([0, -1, -1])
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
