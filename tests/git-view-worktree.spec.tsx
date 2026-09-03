/**
 * Git worktree selection is an atomic view boundary: status, branch choices
 * and history must always come from the same checkout. A stale history row is
 * especially dangerous because its revert/cherry-pick action targets the
 * currently selected checkout.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitLogEntry, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'
const AGENT = 'C:/repo/agent'

const inventories: GitWorktree[] = [
  { path: MAIN, branch: 'main', current: true, changes: 0 },
  { path: AGENT, branch: 'agent', current: false, changes: 1 },
]

function statusFor(target?: string): GitStatusResult {
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
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
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
      await act(async () => {
        root.render(createElement(GitLens, {
          scope: { sessionId: 'session', cwd: MAIN },
          store: createSidebarStore(),
          onOpenFile: () => {},
          onPreview: () => {},
          selectedRef: null,
          visible: false,
        }))
      })
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
      await act(async () => {
        root.render(createElement(GitLens, {
          scope: { sessionId: 'session', cwd: MAIN },
          store: createSidebarStore(),
          onOpenFile: () => {},
          onPreview: () => {},
          selectedRef: null,
          visible: false,
        }))
      })
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
})
