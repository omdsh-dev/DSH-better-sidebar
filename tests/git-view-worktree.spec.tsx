/**
 * Git worktree selection is an atomic view boundary: status, branch choices
 * and history must always come from the same checkout. A stale history row is
 * especially dangerous because its revert/cherry-pick action targets the
 * currently selected checkout.
 *
 * The status itself now comes from the shared git-status store (one snapshot
 * per session+cwd+worktree, one poller), so these tests observe the selection
 * through the rows it renders and through the scope each git call receives —
 * including the `repoRoot` a container's worktree listing must carry.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitLogEntry, type GitStatusEntry, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import type { BetterSidebarService } from '../src/client/service.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'
const AGENT = 'C:/repo/agent'
/** A second linked checkout some tests introduce on a later inventory pass. */
const AGENT_2 = 'C:/repo/agent-2'

const inventories: GitWorktree[] = [
  { path: MAIN, branch: 'main', current: true, changes: 0 },
  { path: AGENT, branch: 'agent', current: false, changes: 1 },
]

function statusFor(target?: string): GitStatusResult {
  if (target === AGENT_2) return { isRepo: true, branch: 'agent-2', entries: [{ path: 'agent-2-change.ts', xy: ' M' }] }
  return target === AGENT
    ? { isRepo: true, branch: 'agent', entries: [{ path: 'agent-change.ts', xy: ' M' }] }
    : { isRepo: true, branch: 'main', entries: [{ path: 'main-change.ts', xy: ' M' }] }
}

function logFor(target?: string, index = 0): GitLogEntry[] {
  const agent = target === AGENT
  const digit = agent ? 'a' : 'b'
  const suffix = index.toString(16).padStart(8, '0')
  return [{
    hash: `${digit.repeat(6)}${suffix.slice(-1)}`,
    hashFull: `${digit.repeat(32)}${suffix}`,
    subject: agent ? `Agent checkout commit ${index}` : `Main checkout commit ${index}`,
    author: 'Test',
    date: '2026-08-20 00:00:00 +0800',
    refs: agent ? 'HEAD -> agent' : 'HEAD -> main',
  }]
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

async function flushEffects(): Promise<void> {
  // Each round drains one promise hop: the refresh chain (listing → branch/log
  // → state) is several hops deep, and a shallow flush would assert on rows
  // that are still in flight.
  for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve() })
}

/** Mount one GitLens. Visible by default: a hidden tab owns no live git data
 *  — the shared status store only polls/loads while a consumer is on screen. */
function mountGit(
  root: Root,
  options: {
    scope?: { sessionId: string; cwd?: string }
    refreshTick?: number
    visible?: boolean
    ctx?: Context
  } = {},
): void {
  act(() => {
    root.render(createElement(GitLens, {
      scope: options.scope ?? { sessionId: 'session', cwd: MAIN },
      store: createSidebarStore(),
      onOpenFile: () => {},
      onPreview: () => {},
      selectedRef: null,
      visible: options.visible ?? true,
      refreshTick: options.refreshTick ?? 0,
      ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
    }))
  })
}

/** A detached container + root; every case here unmounts it in its own finally. */
function makeRoot(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  return { container, root: createRoot(container) }
}

afterEach(() => { vi.restoreAllMocks() })

describe('GitLens (changes tab, git lens) linked-worktree consistency', () => {
  it('refreshes status, branches and history together on auto and manual selection', async () => {
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue(inventories)
    vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => statusFor(target))
    const branch = vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    const log = vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, _skip, target) => logFor(target))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mountGit(root)
      await flushEffects()

      const selects = container.querySelectorAll<HTMLSelectElement>('select')
      const worktreeSelect = selects[0]!
      // A clean primary + exactly one dirty linked checkout auto-selects the
      // linked checkout and loads every target-derived surface from it.
      expect(worktreeSelect.value).toBe(AGENT)
      expect(container.textContent).toContain('agent-change.ts')
      expect(container.textContent).toContain('Agent checkout commit')
      expect(container.textContent).not.toContain('Main checkout commit')
      expect(branch).toHaveBeenCalledWith(expect.anything(), AGENT)
      expect(log).toHaveBeenCalledWith(expect.anything(), 20, 0, AGENT)

      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(worktreeSelect, MAIN)
        worktreeSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await flushEffects()

      expect(worktreeSelect.value).toBe(MAIN)
      expect(container.textContent).toContain('main-change.ts')
      expect(container.textContent).toContain('Main checkout commit')
      expect(container.textContent).not.toContain('Agent checkout commit')
      expect(branch).toHaveBeenLastCalledWith(expect.anything(), MAIN)
      expect(log).toHaveBeenLastCalledWith(expect.anything(), 20, 0, MAIN)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('drops a late history page when the selected worktree changes', async () => {
    const lateAgentPage = deferred<GitLogEntry[]>()
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue(inventories)
    vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => statusFor(target))
    vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, skip, target) => {
      if (target === AGENT && skip === 20) return lateAgentPage.promise
      if (target === AGENT) return Array.from({ length: 20 }, (_value, index) => logFor(AGENT, index)[0]!)
      return logFor(MAIN)
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mountGit(root)
      await flushEffects()

      const worktreeSelect = container.querySelectorAll<HTMLSelectElement>('select')[0]!
      const loadMore = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => /Load more|加载更多/.test(button.textContent ?? ''))
      expect(loadMore).not.toBeUndefined()
      await act(async () => { loadMore!.click() })

      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(worktreeSelect, MAIN)
        worktreeSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await flushEffects()
      expect(container.textContent).toContain('Main checkout commit 0')

      lateAgentPage.resolve(logFor(AGENT, 99))
      await flushEffects()
      expect(container.textContent).toContain('Main checkout commit 0')
      expect(container.textContent).not.toContain('Agent checkout commit 99')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('lists a selected child repository with its repoRoot, running one full refresh', async () => {
    const WS = 'C:/ws'
    const REPO_A = 'C:/ws/a'
    const REPO_B = 'C:/ws/b'
    const repoBWorktrees: GitWorktree[] = [
      { path: REPO_B, branch: 'b-main', current: true, changes: 0 },
      { path: 'C:/ws/b-agent', branch: 'b-agent', current: false, changes: 2 },
    ]
    const worktrees = vi.spyOn(api, 'gitWorktrees').mockImplementation(async (scope) => (
      scope.repoRoot === REPO_B ? repoBWorktrees : []
    ))
    const status = vi.spyOn(api, 'gitStatus').mockImplementation(async (scope) => (
      // Attached sessions ignore the client's cwd override; repoRoot selects the child.
      scope.repoRoot === REPO_B
        ? { isRepo: true, branch: 'b-main', entries: [{ path: 'b-change.ts', xy: ' M' }], root: REPO_B, repositories: [REPO_B] }
        : { isRepo: true, branch: 'a-main', entries: [{ path: 'a-change.ts', xy: ' M' }], root: REPO_A, repositories: [REPO_A, REPO_B] }
    ))
    vi.spyOn(api, 'gitBranch').mockImplementation(async (scope) => (
      scope.repoRoot === REPO_B ? { current: 'b-main', names: ['b-main'] } : { current: 'a-main', names: ['a-main'] }
    ))
    vi.spyOn(api, 'gitLog').mockResolvedValue([])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mountGit(root, { scope: { sessionId: 'session', cwd: WS } })
      await flushEffects()

      // The workspace container's two child repositories are the repo choices.
      const repoSelect = container.querySelectorAll<HTMLSelectElement>('select')[0]!
      expect([...repoSelect.options].map(option => option.textContent)).toEqual(['a', 'b'])
      const listingsBefore = worktrees.mock.calls.length

      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(repoSelect, REPO_B)
        repoSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await flushEffects()

      // The listing carries the selected repoRoot — a container's own listing
      // is empty, so the child checkout's linked worktrees only appear when the
      // selection rides along.
      expect(worktrees.mock.calls.at(-1)![0]).toMatchObject({ sessionId: 'session', cwd: WS, repoRoot: REPO_B })
      // Exactly ONE full refresh for the switch (not a burst).
      expect(worktrees.mock.calls.length).toBe(listingsBefore + 1)
      // The shared status follows the same selection.
      expect(status.mock.calls.at(-1)![0]).toMatchObject({ sessionId: 'session', cwd: WS, repoRoot: REPO_B })
      expect(container.querySelector(`[title="${t('branch')}: b-main"]`)).not.toBeNull()
      expect(container.querySelector('[data-path="b-change.ts"]')).not.toBeNull()
      expect(container.querySelector('[data-path="a-change.ts"]')).toBeNull()
      const worktreeSelect = container.querySelectorAll<HTMLSelectElement>('select')[1]!
      expect(worktreeSelect.value).toBe(REPO_B)

      await act(async () => {
        repoSelect.value = REPO_A
        repoSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await flushEffects()
      expect(container.querySelector(`[title="${t('branch')}: a-main"]`)).not.toBeNull()
      expect(container.querySelector('[data-path="a-change.ts"]')).not.toBeNull()
      expect(container.querySelector('[data-path="b-change.ts"]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('never yanks the view off the auto-selected checkout on a later re-list', async () => {
    const LATER: GitWorktree[] = [
      { path: MAIN, branch: 'main', current: true, changes: 0 },
      { path: AGENT, branch: 'agent', current: false, changes: 0 },
      { path: AGENT_2, branch: 'agent-2', current: false, changes: 5 },
    ]
    vi.spyOn(api, 'gitWorktrees')
      .mockResolvedValueOnce(inventories)
      .mockResolvedValue(LATER)
    vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => statusFor(target))
    vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, _skip, target) => logFor(target))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mountGit(root)
      await flushEffects()
      const worktreeSelect = container.querySelectorAll<HTMLSelectElement>('select')[0]!
      expect(worktreeSelect.value).toBe(AGENT)

      // A later inventory pass prefers the brand-new dirty checkout; the user
      // never chose a checkout, but the ONE automatic pass already ran.
      mountGit(root, { refreshTick: 1 })
      await flushEffects()

      expect(worktreeSelect.value).toBe(AGENT)
      expect(container.textContent).toContain('agent-change.ts')
      expect(container.textContent).not.toContain('agent-2-change.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('queues a manual refresh that lands while a refresh is in flight', async () => {
    const held = deferred<GitWorktree[]>()
    const worktrees = vi.spyOn(api, 'gitWorktrees')
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(inventories)
    vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => statusFor(target))
    vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, _skip, target) => logFor(target))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mountGit(root)
      await flushEffects()
      expect(worktrees).toHaveBeenCalledTimes(1)

      // The header's refresh action lands while the mount pass is in flight.
      mountGit(root, { refreshTick: 1 })
      await flushEffects()
      // Queued, not dropped and not started in parallel.
      expect(worktrees).toHaveBeenCalledTimes(1)

      held.resolve([])
      await flushEffects()
      // The queued pass ran and its listing landed: the dirty linked checkout
      // is selected and its rows are the ones on screen.
      expect(worktrees).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('agent-change.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('stays quiet while hidden and catches up when the tab becomes visible', async () => {
    const worktrees = vi.spyOn(api, 'gitWorktrees').mockResolvedValue(inventories)
    const status = vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => statusFor(target))
    vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, _skip, target) => logFor(target))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      // Mounted in a background pane: no fetch at all (no git processes for a
      // tab nobody is looking at).
      mountGit(root, { visible: false })
      await flushEffects()
      expect(worktrees).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()

      // Bringing the tab on screen loads the lens through one pass.
      mountGit(root, { visible: true })
      await flushEffects()
      expect(worktrees).toHaveBeenCalledTimes(1)
      expect(status).toHaveBeenCalled()
      expect(container.textContent).toContain('agent-change.ts')
      expect(container.textContent).toContain('Agent checkout commit')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('hands the inventory poll its AbortSignal and stops it when hidden', async () => {
    vi.useFakeTimers()
    const worktrees = vi.spyOn(api, 'gitWorktrees').mockResolvedValue(inventories)
    vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => statusFor(target))
    vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, _skip, target) => logFor(target))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mountGit(root)
      await flushEffects()
      expect(worktrees).toHaveBeenCalledTimes(1)

      // The 30s inventory cadence fires and carries the poller's signal.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      await flushEffects()
      expect(worktrees.mock.calls.length).toBe(2)
      const signal = worktrees.mock.calls[1]![1]
      expect(signal).toBeInstanceOf(AbortSignal)

      // Hiding the tab tears the poll down and aborts its signal: a slow host
      // answer can no longer publish state.
      mountGit(root, { visible: false })
      await flushEffects()
      expect((signal as AbortSignal).aborted).toBe(true)
      const callsWhileHidden = worktrees.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(worktrees.mock.calls.length).toBe(callsWhileHidden)
    } finally {
      act(() => { root.unmount() })
      container.remove()
      vi.useRealTimers()
    }
  })

  it('keeps branch switch and history failures out of the commit bar', async () => {
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
      { path: MAIN, branch: 'main', current: true, changes: 1 },
    ])
    vi.spyOn(api, 'gitStatus').mockResolvedValue({
      isRepo: true, branch: 'main', entries: [{ path: 'src/a.ts', xy: ' M' }],
    })
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main', 'feature'] })
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    vi.spyOn(api, 'gitCheckout').mockRejectedValue(new Error('dirty worktree'))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mountGit(root)
      await flushEffects()

      const branchSelect = container.querySelectorAll<HTMLSelectElement>('select')[0]!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(branchSelect, 'feature')
        branchSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await flushEffects()

      const banner = [...container.querySelectorAll<HTMLElement>('[role="alert"]')]
        .find(node => (node.textContent ?? '').includes(`${t('checkoutError')}: dirty worktree`))
      expect(banner).toBeDefined()
      const input = container.querySelector(`textarea[placeholder="${t('commitPlaceholder')}"]`)
      expect(input).not.toBeNull()
      // The commit bar owns only its own status line: the branch failure is
      // rendered ABOVE it, never under the commit input.
      expect(banner!.compareDocumentPosition(input!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})

describe('GitLens (changes tab, git lens) change tree', () => {
  /** Mount with one changed-file inventory; every test picks its own entries. */
  async function mountTree(
    container: HTMLElement,
    root: Root,
    entries: Array<{ path: string; xy: string; counts?: GitStatusEntry['counts'] }>,
  ): Promise<void> {
    const changes = entries.filter(row => row.xy !== '  ').length
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: MAIN, branch: 'main', current: true, changes }])
    vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: true, branch: 'main', entries })
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    mountGit(root)
    await flushEffects()
  }

  it('folds a directory row per group, independently of the same path on the other side', async () => {
    const { container, root } = makeRoot()
    try {
      await mountTree(container, root, [
        { path: 'src/a.ts', xy: ' M' }, // unstaged side
        { path: 'src/b.ts', xy: 'M ' }, // staged side
      ])

      const dirs = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-dir="src"]')]
      // One 'src' row per group: a path with changes on both sides appears in
      // both trees.
      expect(dirs()).toHaveLength(2)
      expect(dirs()[0]!.getAttribute('aria-expanded')).toBe('true')
      expect(dirs()[0]!.querySelector('svg')).not.toBeNull()
      expect(container.querySelector('button[data-path="src/a.ts"]')).not.toBeNull()
      expect(container.querySelector('button[data-path="src/a.ts"]')!.querySelector('svg')).not.toBeNull()

      await act(async () => { dirs()[0]!.click() })
      // Folded: the unstaged subtree is gone...
      expect(dirs()[0]!.getAttribute('aria-expanded')).toBe('false')
      expect(container.querySelector('button[data-path="src/a.ts"]')).toBeNull()
      // ...while the staged group's own 'src' row stays open and keeps its file.
      expect(dirs()[1]!.getAttribute('aria-expanded')).toBe('true')
      expect(container.querySelector('button[data-path="src/b.ts"]')).not.toBeNull()

      await act(async () => { dirs()[0]!.click() })
      expect(container.querySelector('button[data-path="src/a.ts"]')).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('compresses a single-child directory chain into one labelled row', async () => {
    const { container, root } = makeRoot()
    try {
      await mountTree(container, root, [
        { path: 'src/client/changes/a.ts', xy: ' M' },
        { path: 'src/client/changes/b.ts', xy: ' M' },
      ])

      // Three levels, one child each: one row, one label, two changes.
      const row = container.querySelector<HTMLButtonElement>('button[data-dir="src/client/changes"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('src/client/changes')
      expect(container.querySelector('[data-group="unstaged"] [data-count]')?.textContent).toBe('2')
      // Both files hang under that one row.
      expect(container.querySelector('button[data-path="src/client/changes/a.ts"]')).not.toBeNull()
      expect(container.querySelector('button[data-path="src/client/changes/b.ts"]')).not.toBeNull()
      // Nothing on the staged side: only the empty band, no tree rows.
      expect(container.querySelectorAll('[data-group="staged"] [data-path]')).toHaveLength(0)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('stages a file from a nested tree row and re-reads the shared status', async () => {
    const { container, root } = makeRoot()
    try {
      await mountTree(container, root, [{ path: 'src/deep/a.ts', xy: ' M' }])
      const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true })
      const statusSpy = vi.mocked(api.gitStatus)
      const statusCallsBefore = statusSpy.mock.calls.length

      const action = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('stage')}"]`)
      expect(action).not.toBeNull()
      await act(async () => { action!.click() })
      await flushEffects()

      // The auto-selected primary checkout rides along as the worktree target.
      expect(stage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), 'src/deep/a.ts', MAIN)
      expect(statusSpy.mock.calls.length).toBeGreaterThan(statusCallsBefore)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('bands each group with its count and a labelled stage-all action', async () => {
    const { container, root } = makeRoot()
    try {
      await mountTree(container, root, [
        { path: 'src/a.ts', xy: ' M' },
        { path: 'docs/b.md', xy: ' M' },
        { path: 'src/c.ts', xy: 'M ' },
      ])

      const unstaged = container.querySelector<HTMLElement>('[data-group="unstaged"]')!
      const staged = container.querySelector<HTMLElement>('[data-group="staged"]')!
      expect(unstaged.textContent).toContain(t('unstaged'))
      expect(unstaged.querySelector('[data-count]')?.textContent).toBe('2')
      expect(staged.querySelector('[data-count]')?.textContent).toBe('1')

      // The band's own action is the one that is NOT inside a row (directory
      // rows carry the same "Stage all" label for their own subtree).
      const stageAll = [...unstaged.querySelectorAll<HTMLButtonElement>(`button[aria-label="${t('stageAll')}"]`)]
        .find(button => button.closest('[data-row]') === null)
      const unstageAll = [...staged.querySelectorAll<HTMLButtonElement>(`button[aria-label="${t('unstageAll')}"]`)]
        .find(button => button.closest('[data-row]') === null)
      expect(stageAll).not.toBeUndefined()
      expect(unstageAll).not.toBeUndefined()

      const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true })
      await act(async () => { stageAll!.click() })
      await flushEffects()
      // "Stage all" stages the whole worktree: no path argument.
      expect(stage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), undefined, MAIN)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('stages and unstages a whole directory from its row action', async () => {
    const { container, root } = makeRoot()
    try {
      await mountTree(container, root, [
        { path: 'src/deep/a.ts', xy: ' M' }, // unstaged → the 'src/deep' row
        { path: 'docs/b.md', xy: 'M ' }, // staged → the 'docs' row
      ])
      const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true })
      const unstage = vi.spyOn(api, 'gitUnstage').mockResolvedValue({ ok: true })

      const dirAction = (path: string, label: string): HTMLButtonElement => {
        const row = container.querySelector<HTMLElement>(`[data-row="${path}"]`)
        expect(row).not.toBeNull()
        const button = row!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        expect(button).not.toBeNull()
        return button!
      }

      const unstagedDir = dirAction('src/deep', t('stageAll'))
      await act(async () => { unstagedDir.click() })
      await flushEffects()
      // The directory path stages the whole subtree (`git add -A -- <dir>`).
      expect(stage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), 'src/deep', MAIN)

      const stagedDir = dirAction('docs', t('unstageAll'))
      await act(async () => { stagedDir.click() })
      await flushEffects()
      expect(unstage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), 'docs', MAIN)

      // Neither click folded its row: the action is a sibling of the
      // disclosure button (and stops propagation anyway).
      expect(container.querySelector('button[data-dir="src/deep"]')!.getAttribute('aria-expanded')).toBe('true')
      expect(container.querySelector('button[data-path="src/deep/a.ts"]')).not.toBeNull()
      expect(container.querySelector('button[data-dir="docs"]')!.getAttribute('aria-expanded')).toBe('true')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('resolves no icon for a status poll whose change list did not change', async () => {
    vi.useFakeTimers()
    const fileIcons: string[] = []
    const folderIcons: string[] = []
    /** The icon resolvers are the re-render probe: they run inside the rows,
     *  so one entry per call means one row actually re-rendered. */
    const service = {
      subscribe: () => () => {},
      fileIcon: (path: string) => { fileIcons.push(path); return null },
      folderIcon: (path: string, open: boolean) => { folderIcons.push(`${path}:${String(open)}`); return null },
    } as unknown as BetterSidebarService
    const ctx = { get: (name: string) => (name === 'betterSidebar' ? service : undefined) } as unknown as Context

    const { container, root } = makeRoot()
    try {
      vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: MAIN, branch: 'main', current: true, changes: 2 }])
      // Every poll answers with a fresh object and a fresh entries array (the
      // store's real shape). The FIRST answer carries no repository list and
      // the later ones do — a field OUTSIDE the change list moves, so the store
      // cannot preserve the snapshot identity and hands the lens a new array
      // whose content is equal. Only the CONTENT key plus the memoized rows
      // hold there; identity alone would rebuild the tree and re-render rows.
      let poll = 0
      vi.spyOn(api, 'gitStatus').mockImplementation(async () => {
        poll += 1
        return {
          isRepo: true,
          branch: 'main',
          ...(poll === 1 ? {} : { repositories: [MAIN] }),
          // One compressed directory row (folder icon) + its two file rows.
          entries: [{ path: 'src/deep/a.ts', xy: ' M' }, { path: 'src/deep/b.ts', xy: ' M' }],
        }
      })
      vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
      vi.spyOn(api, 'gitLog').mockResolvedValue([])

      mountGit(root, { ctx })
      await flushEffects()
      expect(fileIcons).toEqual(['src/deep/a.ts', 'src/deep/b.ts'])
      expect(folderIcons).toEqual(['src/deep:true'])

      fileIcons.length = 0
      folderIcons.length = 0
      // Tick 1: a NEW snapshot object with an equal-content change list.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_600) })
      await flushEffects()
      expect(fileIcons).toEqual([])
      expect(folderIcons).toEqual([])

      fileIcons.length = 0
      folderIcons.length = 0
      // Tick 2: a byte-identical answer (the store reuses the snapshot object).
      await act(async () => { await vi.advanceTimersByTimeAsync(2_600) })
      await flushEffects()
      expect(fileIcons).toEqual([])
      expect(folderIcons).toEqual([])
      // The probe measured stability, not loss: every row is still there.
      expect(container.querySelectorAll('[data-path]')).toHaveLength(2)
      expect(container.querySelectorAll('button[data-dir="src/deep"]')).toHaveLength(1)
    } finally {
      act(() => { root.unmount() })
      container.remove()
      vi.useRealTimers()
    }
  })

  /**
   * Issue #131: the added/deleted line counts the status answer carries are
   * what the file rows and the group headers print. The header's number is the
   * sum of the numbers under it, and a row git has no numstat for (an untracked
   * file, a binary blob) says so instead of printing an invented `+0 −0`.
   */
  describe('line counts (#131)', () => {
    /** One rendered row's/band's count cluster, as its data attributes. */
    function counted(container: HTMLElement, selector: string): { added: string | null; deleted: string | null; text: string } {
      const node = container.querySelector<HTMLElement>(selector)
      expect(node, selector).not.toBeNull()
      return {
        added: node!.getAttribute('data-added'),
        deleted: node!.getAttribute('data-deleted'),
        text: node!.textContent ?? '',
      }
    }

    it('prints each row its own counts and each band the sum of its members', async () => {
      const { container, root } = makeRoot()
      try {
        await mountTree(container, root, [
          { path: 'src/a.ts', xy: ' M', counts: { additions: 4, deletions: 2 } },
          { path: 'src/b.ts', xy: ' M', counts: { additions: 1, deletions: 0 } },
          { path: 'docs/c.md', xy: 'M ', counts: { additions: 3, deletions: 3 } },
        ])

        expect(counted(container, '[data-path="src/a.ts"] [data-lines="count"]'))
          .toEqual({ added: '4', deleted: '2', text: '+4−2' })
        expect(counted(container, '[data-path="src/b.ts"] [data-lines="count"]'))
          .toEqual({ added: '1', deleted: '0', text: '+1' })
        expect(counted(container, '[data-path="docs/c.md"] [data-lines="count"]'))
          .toEqual({ added: '3', deleted: '3', text: '+3−3' })

        // Each band's total IS the sum of the rows under it (4+1 / 2+0 and
        // 3 / 3) — and each group only counts its own members.
        expect(counted(container, '[data-group="unstaged"] [data-lines="group"]'))
          .toEqual({ added: '5', deleted: '2', text: '+5−2' })
        expect(counted(container, '[data-group="staged"] [data-lines="group"]'))
          .toEqual({ added: '3', deleted: '3', text: '+3−3' })

        // The same numbers, read back off the DOM: band = Σ members.
        const sumOf = (group: string, side: 'added' | 'deleted'): number =>
          [...container.querySelectorAll<HTMLElement>(`[data-group="${group}"] [data-path] [data-lines="count"]`)]
            .reduce((total, node) => total + Number(node.getAttribute(`data-${side}`)), 0)
        expect(sumOf('unstaged', 'added')).toBe(5)
        expect(sumOf('unstaged', 'deleted')).toBe(2)
      } finally {
        act(() => { root.unmount() })
        container.remove()
      }
    })

    it('says "new file" for an untracked entry and "binary" for a blob, inventing no numbers', async () => {
      const { container, root } = makeRoot()
      try {
        await mountTree(container, root, [
          { path: 'new.txt', xy: '??' },
          { path: 'blob.bin', xy: ' M', counts: { binary: true } },
        ])

        expect(container.querySelector('[data-path="new.txt"] [data-lines="new"]')?.textContent)
          .toBe(t('changesNewFile'))
        expect(container.querySelector('[data-path="blob.bin"] [data-lines="binary"]')?.textContent)
          .toBe(t('diffBinary'))
        // Neither row claims a count...
        expect(container.querySelector('[data-path="new.txt"] [data-lines="count"]')).toBeNull()
        expect(container.querySelector('[data-path="blob.bin"] [data-lines="count"]')).toBeNull()
        // ...and with nothing to sum, the band shows no total at all.
        expect(container.querySelector('[data-group="unstaged"] [data-lines="group"]')).toBeNull()
        // The count pill still reports how many files changed.
        expect(container.querySelector('[data-group="unstaged"] [data-count]')?.textContent).toBe('2')
      } finally {
        act(() => { root.unmount() })
        container.remove()
      }
    })

    it('republishes the numbers when only the counts moved (same paths, same porcelain)', async () => {
      vi.useFakeTimers()
      const { container, root } = makeRoot()
      try {
        vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: MAIN, branch: 'main', current: true, changes: 1 }])
        // Two answers with the SAME path and the SAME porcelain code: only the
        // line counts moved (more lines appended to an already-modified file).
        vi.spyOn(api, 'gitStatus')
          .mockResolvedValueOnce({
            isRepo: true, branch: 'main', entries: [{ path: 'src/a.ts', xy: ' M', counts: { additions: 1, deletions: 0 } }],
          })
          .mockResolvedValue({
            isRepo: true, branch: 'main', entries: [{ path: 'src/a.ts', xy: ' M', counts: { additions: 7, deletions: 0 } }],
          })
        vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
        vi.spyOn(api, 'gitLog').mockResolvedValue([])

        mountGit(root)
        await flushEffects()
        expect(counted(container, '[data-path="src/a.ts"] [data-lines="count"]').added).toBe('1')

        await act(async () => { await vi.advanceTimersByTimeAsync(2_600) })
        await flushEffects()
        // Both caches had to notice: the store's field-by-field snapshot
        // compare AND the lens's content key. Either one ignoring the counts
        // leaves the row printing its first reading forever.
        expect(counted(container, '[data-path="src/a.ts"] [data-lines="count"]').added).toBe('7')
        expect(counted(container, '[data-group="unstaged"] [data-lines="group"]').added).toBe('7')
      } finally {
        act(() => { root.unmount() })
        container.remove()
        vi.useRealTimers()
      }
    })
  })
})

/**
 * The lens lives in a REUSED tab instance (the workbench keeps one mounted
 * component per tab id and swaps `scope`), so a destructive confirmation armed
 * for a row of the previous project must not survive the swap: its `onConfirm`
 * closure carries that row's path while `gitScopeNow()` already reads the new
 * scope — the discard would land in the project that took over the pane.
 */
describe('GitLens (changes tab, git lens) scope swap', () => {
  it('drops a pending discard confirmation when the scope changes', async () => {
    // One primary checkout, so the view stays on MAIN's changed row.
    const onlyMain: GitWorktree[] = [{ path: MAIN, branch: 'main', current: true, changes: 1 }]
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue(onlyMain)
    vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => statusFor(target))
    vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, _skip, target) => logFor(target))
    const discard = vi.spyOn(api, 'gitDiscard')

    const { container, root } = makeRoot()
    try {
      mountGit(root, { scope: { sessionId: 's1', cwd: MAIN } })
      await flushEffects()

      const row = container.querySelector<HTMLElement>('[data-path="main-change.ts"]')
      if (row === null) throw new Error('changed row not found')
      act(() => {
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
      })
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(el => el.textContent === t('discard'))
      if (item === undefined) throw new Error('discard menu item not found')
      act(() => { item.click() })
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()

      // Another session takes over the same mounted instance.
      mountGit(root, { scope: { sessionId: 's2', cwd: AGENT } })
      await flushEffects()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(discard).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('does not carry a half-typed commit message into the next scope', async () => {
    // The Commit button asks only for a non-empty message and a staged row, so
    // a draft typed against the previous project would submit verbatim under
    // the new one — no confirmation in between. Driven through the submit
    // itself rather than the button's disabled state: what has to hold is that
    // the message is ABSENT, not merely that a gate is shut.
    const commit = vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: MAIN, branch: 'main', current: true, changes: 1 }])
    vi.spyOn(api, 'gitStatus').mockResolvedValue({
      isRepo: true,
      branch: 'main',
      // 'M ' is a STAGED row: the commit path needs one to be reachable at all.
      entries: [{ path: 'staged.ts', xy: 'M ' }],
    })
    vi.spyOn(api, 'gitBranch').mockImplementation(async (_scope, target) => ({
      current: target === AGENT ? 'agent' : 'main',
      names: target === AGENT ? ['agent'] : ['main'],
    }))
    vi.spyOn(api, 'gitLog').mockImplementation(async (_scope, _count, _skip, target) => logFor(target))

    const { container, root } = makeRoot()
    // Re-queried on every use: a re-render may hand back a different node, and
    // a detached one keeps whatever its last render set.
    const box = (): HTMLTextAreaElement | null =>
      container.querySelector(`textarea[placeholder="${t('commitPlaceholder')}"]`)
    const typeInto = async (text: string): Promise<void> => {
      await act(async () => {
        const node = box()
        if (node === null) throw new Error('commit box not found')
        // Native setter: a plain `node.value =` leaves React's tracker behind.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, text)
        node.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const submit = async (): Promise<void> => {
      await act(async () => {
        box()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })
    }
    try {
      mountGit(root, { scope: { sessionId: 's1', cwd: MAIN } })
      await flushEffects()
      await typeInto('fix: half typed in A')

      // Another session takes over the same mounted instance. The draft stays
      // behind with the project it was written for, so this submit finds no
      // message to send.
      mountGit(root, { scope: { sessionId: 's2', cwd: AGENT } })
      await flushEffects()
      await submit()
      expect(commit).not.toHaveBeenCalled()

      // Coming back to that project brings its own message back: the draft is
      // the state a kept-mounted tab holds on #712's behalf.
      mountGit(root, { scope: { sessionId: 's1', cwd: MAIN } })
      await flushEffects()
      await submit()
      expect(commit).toHaveBeenCalledTimes(1)
      expect(commit.mock.calls[0]?.[0]?.sessionId).toBe('s1')
      expect(commit.mock.calls[0]?.[1]).toBe('fix: half typed in A')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
