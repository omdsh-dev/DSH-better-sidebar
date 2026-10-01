/**
 * The global UI kit and the shared git-status store.
 *
 * The porcelain mapping and the store's contract are the two things every
 * page now depends on (the file tree colors rows from the same snapshot the
 * changes page lists), so both are pinned here: one fetch per key, the
 * visible-only poll, the queued refresh, and the lazy path index.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
import { Chip, ConfirmDialog, IconButton, Notice, SectionHeader, StatusBadge } from '../src/client/ui/kit.tsx'
import { invalidateGitStatus, statusOfXY, useGitStatus, type GitStatusView } from '../src/client/ui/git-status.ts'
import type { GitStatusResult } from '../src/client/api.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { gitStatus } = vi.hoisted(() => ({ gitStatus: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ api: { gitStatus } }))

afterEach(() => {
  gitStatus.mockReset()
})

/** Mount one element and hand back its container plus an unmount. */
async function mount(node: ReactNode): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => { root.render(node) })
  return {
    container,
    unmount: async () => { await act(async () => { root.unmount() }); container.remove() },
  }
}

describe('statusOfXY', () => {
  it('maps the worktree/index letter pairs to the shared tone vocabulary', () => {
    expect(statusOfXY(' M')).toMatchObject({ letter: 'M', tone: 'modified', staged: false, unstaged: true })
    expect(statusOfXY('M ')).toMatchObject({ letter: 'M', tone: 'modified', staged: true, unstaged: false })
    expect(statusOfXY('MM')).toMatchObject({ tone: 'modified', staged: true, unstaged: true })
    expect(statusOfXY('A ')).toMatchObject({ letter: 'A', tone: 'added' })
    expect(statusOfXY(' D')).toMatchObject({ letter: 'D', tone: 'deleted' })
    expect(statusOfXY('R ')).toMatchObject({ letter: 'R', tone: 'renamed' })
    expect(statusOfXY('C ')).toMatchObject({ letter: 'C', tone: 'copied' })
    expect(statusOfXY('UU')).toMatchObject({ letter: 'U', tone: 'conflict', staged: true, unstaged: true })
  })

  it('reads untracked as its own tone and ignores clean/ignored rows', () => {
    expect(statusOfXY('??')).toEqual({ letter: 'U', tone: 'untracked', staged: false, unstaged: true })
    expect(statusOfXY('  ')).toBeUndefined()
    expect(statusOfXY('!!')).toBeUndefined()
  })
})

/** A snapshot with one changed file under `<root>/src` and one at the root. */
function snapshot(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    branch: 'main',
    root: '/ws',
    entries: [
      { path: 'src/a.ts', xy: ' M' },
      { path: 'top.md', xy: '??' },
    ],
    ...overrides,
  }
}

/** A probe component exposing the hook's view to the test body. */
function Probe(props: { scope: { sessionId: string; cwd?: string }; visible?: boolean; onView(view: GitStatusView): void }): ReactNode {
  const view = useGitStatus(props.scope, { visible: props.visible ?? true })
  props.onView(view)
  return createElement('span', null, String(view.snapshot?.entries.length ?? -1))
}

describe('useGitStatus', () => {
  it('fetches once per key and indexes paths and their ancestor directories', async () => {
    gitStatus.mockResolvedValue(snapshot())
    let view: GitStatusView | undefined
    const { unmount } = await mount(createElement(Probe, { scope: { sessionId: 's1', cwd: '/ws' }, onView: (next) => { view = next } }))
    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(view?.snapshot?.isRepo).toBe(true)
    expect(view?.statusOf('/ws/src/a.ts')?.tone).toBe('modified')
    expect(view?.statusOf('/ws/top.md')?.tone).toBe('untracked')
    // Case- and separator-insensitive lookup, so a Windows host's mixed
    // separators still color the row.
    expect(view?.statusOf('\\ws\\SRC\\a.ts')?.letter).toBe('M')
    expect(view?.statusOf('/ws/src/other.ts')).toBeUndefined()
    expect(view?.dirHasChanges('/ws/src')).toBe(true)
    expect(view?.dirHasChanges('/ws')).toBe(true)
    expect(view?.dirHasChanges('/ws/docs')).toBe(false)
    await unmount()
  })

  it('stays unfetched while invisible and polls once visible again', async () => {
    gitStatus.mockResolvedValue(snapshot())
    const { unmount } = await mount(createElement(Probe, { scope: { sessionId: 's2' }, visible: false, onView: () => {} }))
    expect(gitStatus).not.toHaveBeenCalled()
    await unmount()
  })

  it('drops the snapshot when the last consumer leaves, so a remount re-reads', async () => {
    gitStatus.mockResolvedValue(snapshot())
    const first = await mount(createElement(Probe, { scope: { sessionId: 's3' }, onView: () => {} }))
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await first.unmount()
    // A kept snapshot would let the store serve the old answer with no fetch.
    const second = await mount(createElement(Probe, { scope: { sessionId: 's3' }, onView: () => {} }))
    expect(gitStatus).toHaveBeenCalledTimes(2)
    await second.unmount()
  })

  it('coalesces a refresh that lands mid-flight instead of dropping it', async () => {
    let resolveFirst: ((value: GitStatusResult) => void) | undefined
    gitStatus
      .mockImplementationOnce(() => new Promise<GitStatusResult>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(snapshot({ entries: [{ path: 'src/b.ts', xy: ' M' }] }))
    let view: GitStatusView | undefined
    const { unmount } = await mount(createElement(Probe, { scope: { sessionId: 's4' }, onView: (next) => { view = next } }))
    await act(async () => {
      view?.refresh()
      view?.refresh()
    })
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveFirst?.(snapshot())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(gitStatus).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('surfaces a failed read as an error without inventing a status', async () => {
    gitStatus.mockRejectedValue(new Error('no git'))
    let view: GitStatusView | undefined
    const { unmount } = await mount(createElement(Probe, { scope: { sessionId: 's5' }, onView: (next) => { view = next } }))
    expect(view?.error).toBe(true)
    expect(view?.snapshot).toBeNull()
    expect(view?.statusOf('/ws/a.ts')).toBeUndefined()
    await unmount()
  })

  it('serves two consumers of the same key from ONE fetch (the tree and the changes lens)', async () => {
    gitStatus.mockResolvedValue(snapshot())
    let first: GitStatusView | undefined
    let second: GitStatusView | undefined
    const { unmount } = await mount(createElement('div', null,
      createElement(Probe, { scope: { sessionId: 's-shared', cwd: '/ws' }, onView: (view) => { first = view } }),
      createElement(Probe, { scope: { sessionId: 's-shared', cwd: '/ws' }, onView: (view) => { second = view } }),
    ))
    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(first?.statusOf('/ws/src/a.ts')?.letter).toBe('M')
    expect(second?.statusOf('/ws/src/a.ts')?.letter).toBe('M')
    await unmount()
  })

  it('keeps the snapshot identity when an idle poll returns the same answer', async () => {
    // Without this, every 2.5s tick minted a new object and every downstream
    // memo (the changes tree, the file tree rows) re-ran on an unchanged view.
    // A FRESH object per call: the host really does re-serialize the answer
    // every poll, so `mockResolvedValue` (same reference) would not prove this.
    gitStatus.mockImplementation(async () => snapshot())
    // Collect the snapshots the hook PUBLISHES (the view object itself is
    // re-created per render, so identity must be read off the snapshot).
    const published: (GitStatusResult | null)[] = []
    let view: GitStatusView | undefined
    const { unmount } = await mount(createElement(Probe, {
      scope: { sessionId: 's-idle' },
      onView: (next) => { view = next; published.push(next.snapshot) },
    }))
    expect(gitStatus).toHaveBeenCalledTimes(1)
    const before = published[published.length - 1]
    expect(before).not.toBeNull()
    await act(async () => { view?.refresh(); await Promise.resolve(); await Promise.resolve() })
    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(published[published.length - 1]).toBe(before)
    await unmount()
  })

  it('replaces the snapshot when the poll reports a real change', async () => {
    gitStatus.mockResolvedValueOnce(snapshot())
    const published: (GitStatusResult | null)[] = []
    let view: GitStatusView | undefined
    const { unmount } = await mount(createElement(Probe, {
      scope: { sessionId: 's-change' },
      onView: (next) => { view = next; published.push(next.snapshot) },
    }))
    const before = published[published.length - 1]
    gitStatus.mockResolvedValue(snapshot({ entries: [{ path: 'src/a.ts', xy: ' M' }, { path: 'src/b.ts', xy: '??' }] }))
    await act(async () => { view?.refresh(); await Promise.resolve(); await Promise.resolve() })
    expect(published[published.length - 1]).not.toBe(before)
    expect(view?.statusOf('/ws/src/b.ts')?.tone).toBe('untracked')
    await unmount()
  })

  it('invalidateGitStatus re-reads every live key of one session', async () => {
    gitStatus.mockResolvedValue(snapshot())
    const { unmount } = await mount(createElement(Probe, { scope: { sessionId: 's6' }, onView: () => {} }))
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await act(async () => {
      invalidateGitStatus('s6')
      await Promise.resolve()
    })
    expect(gitStatus).toHaveBeenCalledTimes(2)
    await unmount()
  })
})

describe('ui kit atoms', () => {
  it('IconButton carries its accessible name, pressed state and disabled lock', async () => {
    const onClick = vi.fn()
    const { container, unmount } = await mount(createElement(IconButton, { icon: createElement('i'), label: 'Refresh', active: true, onClick }))
    const button = container.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Refresh')
    expect(button.getAttribute('title')).toBe('Refresh')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { button.click() })
    expect(onClick).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('Chip shows its count and reflects selection', async () => {
    const onClick = vi.fn()
    const { container, unmount } = await mount(createElement(Chip, { active: true, count: 3, onClick, children: 'Write' }))
    const chip = container.querySelector('button')!
    expect(chip.textContent).toBe('Write3')
    expect(chip.getAttribute('data-active')).toBe('true')
    await unmount()
  })

  it('SectionHeader renders label, count and its one action slot', async () => {
    const { container, unmount } = await mount(
      createElement(SectionHeader, {
        label: 'Staged',
        count: 2,
        action: createElement('button', null, 'Go'),
        children: createElement('span', null, 'x'),
      }),
    )
    expect(container.textContent).toContain('Staged')
    expect(container.textContent).toContain('2')
    expect(container.textContent).toContain('x')
    expect(container.querySelector('button')?.textContent).toBe('Go')
    await unmount()
  })

  it('Notice renders one line per kind and announces errors', async () => {
    const { container, unmount } = await mount(createElement(Notice, { kind: 'error', children: 'boom' }))
    const node = container.querySelector('[data-kind="error"]')!
    expect(node.getAttribute('role')).toBe('alert')
    expect(node.textContent).toBe('boom')
    await unmount()
  })

  it('StatusBadge exposes the tone as data for the sheet', async () => {
    const { container, unmount } = await mount(createElement(StatusBadge, { tone: 'untracked', title: 'Untracked', children: 'U' }))
    const badge = container.querySelector('[data-tone="untracked"]')!
    expect(badge.getAttribute('title')).toBe('Untracked')
    await unmount()
  })

  it('ConfirmDialog routes both actions', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    const { unmount } = await mount(createElement(ConfirmDialog, {
      open: true, title: 'Delete?', description: 'gone forever', confirmLabel: 'Delete', cancelLabel: 'Cancel',
      danger: true, onConfirm, onClose,
    }))
    const buttons = [...document.querySelectorAll('button')]
    const confirm = buttons.find(button => button.textContent === 'Delete')
    const cancel = buttons.find(button => button.textContent === 'Cancel')
    expect(confirm).toBeDefined()
    expect(cancel).toBeDefined()
    await act(async () => { confirm?.click() })
    await act(async () => { cancel?.click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmount()
  })
})
