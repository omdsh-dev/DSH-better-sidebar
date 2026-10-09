/**
 * The shared git-diff loader (`diff/use-git-diff.ts`) sits behind BOTH diff
 * surfaces: the changes tab's inline preview pane and the dedicated diff tab.
 * These tests drive each surface through the hook — the staged-side fallback,
 * the untracked full-addition fallback, and the per-file fold cache two
 * sibling folds share — so a future change to one surface cannot silently
 * change the other.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffPane } from '../src/client/changes/DiffPane.tsx'
import { DiffTab } from '../src/client/DiffTab.tsx'
import { api } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import type { SessionScope } from '../src/client/api.ts'
import type { SidebarDiffRef } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const SCOPE: SessionScope = { sessionId: 's1', cwd: '/p' }

const STAGED_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+staged-side',
].join('\n')

/** A three-hunk patch of one file: two gap folds (lines 2..11 and 13..29). */
const TWO_GAP_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '@@ -12 +12 @@',
  '-tail',
  '+tail2',
  '@@ -30 +30 @@',
  '-end',
  '+end2',
].join('\n')

const CONTENT = Array.from({ length: 40 }, (_value, index) => `line-${String(index + 1)}`).join('\n')

async function flushEffects(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await act(async () => { await Promise.resolve() })
}

afterEach(() => { vi.restoreAllMocks() })

describe('useGitDiffTarget through the inline preview pane (DiffPane)', () => {
  it('falls back to the other side when the requested side has no diff', async () => {
    const worktree: SidebarDiffRef = { kind: 'worktree', path: 'src/a.ts', staged: false }
    const gitDiff = vi.spyOn(api, 'gitDiff').mockImplementation(async (_scope, _path, staged) => ({
      diff: staged ? STAGED_PATCH : '',
    }))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(DiffPane, {
          target: { kind: 'git', ref: worktree },
          ctx: {} as Context,
          scope: SCOPE,
          height: 300,
          onHeightCommit: () => {},
          onClose: () => {},
          onExpand: () => {},
        }))
      })
      await flushEffects()

      // The requested (unstaged) side came back empty, so the pane retried the
      // staged side and rendered THAT patch.
      expect(gitDiff).toHaveBeenNthCalledWith(1, expect.anything(), 'src/a.ts', false, undefined)
      expect(gitDiff).toHaveBeenNthCalledWith(2, expect.anything(), 'src/a.ts', true, undefined)
      expect(container.textContent).toContain('staged-side')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders an untracked file as a full-file addition from its content', async () => {
    const worktree: SidebarDiffRef = { kind: 'worktree', path: 'src/new.ts', staged: false, untracked: true }
    vi.spyOn(api, 'gitDiff').mockResolvedValue({ diff: '' })
    const read = vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: 'brand-new-line', truncated: false })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(DiffPane, {
          target: { kind: 'git', ref: worktree },
          ctx: {} as Context,
          scope: SCOPE,
          height: 300,
          onHeightCommit: () => {},
          onClose: () => {},
          onExpand: () => {},
        }))
      })
      await flushEffects()

      expect(read).toHaveBeenCalledWith(expect.anything(), '/p/src/new.ts')
      expect(container.textContent).toContain('brand-new-line')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})

describe('useGitDiffTarget through the dedicated diff tab (DiffTab)', () => {
  it('loads a commit patch into the shared renderer', async () => {
    vi.spyOn(api, 'gitCommitDiff').mockResolvedValue({ diff: STAGED_PATCH })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(DiffTab, {
          sessionId: 's1',
          cwd: '/p',
          diff: { kind: 'commit', hash: 'abc1234', hashFull: 'a'.repeat(40), subject: 'subject' },
        }))
      })
      await flushEffects()
      expect(container.textContent).toContain('staged-side')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('fetches each side of a file ONCE for two sibling fold expansions', async () => {
    vi.spyOn(api, 'gitDiff').mockResolvedValue({ diff: TWO_GAP_PATCH })
    const show = vi.spyOn(api, 'gitShow').mockResolvedValue({ content: CONTENT })
    const read = vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: CONTENT, truncated: false })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(DiffTab, {
          sessionId: 's1',
          cwd: '/p',
          diff: { kind: 'worktree', path: 'src/a.ts', staged: false },
        }))
      })
      await flushEffects()

      const firstFold = container.querySelector<HTMLElement>('[data-expandable="true"]')
      expect(firstFold).not.toBeNull()
      await act(async () => { firstFold!.click() })
      expect(show).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('line-5')

      // The second gap is the SAME file: the cache serves it without a fetch.
      // (An expanded fold keeps its marker in the DOM, so the second one is
      // the second marker in document order.)
      const folds = container.querySelectorAll<HTMLElement>('[data-expandable="true"]')
      expect(folds).toHaveLength(2)
      await act(async () => { folds[1]!.click() })
      expect(show).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('line-20')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
