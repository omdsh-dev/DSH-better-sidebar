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
import { api, type GitLogEntry, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
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
      scope.cwd === REPO_B
        ? { isRepo: true, branch: 'b-main', entries: [], root: REPO_B, repositories: [REPO_B] }
        : { isRepo: true, branch: 'a-main', entries: [], root: REPO_A, repositories: [REPO_A, REPO_B] }
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
      expect(status.mock.calls.some(([scope]) => scope.cwd === REPO_B)).toBe(true)
      const worktreeSelect = container.querySelectorAll<HTMLSelectElement>('select')[1]!
      expect(worktreeSelect.value).toBe(REPO_B)
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
      const input = container.querySelector(`input[placeholder="${t('commitPlaceholder')}"]`)
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
    entries: Array<{ path: string; xy: string }>,
  ): Promise<void> {
    const changes = entries.filter(row => row.xy !== '  ').length
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: MAIN, branch: 'main', current: true, changes }])
    vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: true, branch: 'main', entries })
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    mountGit(root)
    await flushEffects()
  }

  function makeRoot(): { container: HTMLDivElement; root: Root } {
    const container = document.createElement('div')
    document.body.append(container)
    return { container, root: createRoot(container) }
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
})
