/**
 * Level loading is BATCHED: the visible set (the workspace root plus every
 * expanded directory) is listed with ONE `fs.trees` request on mount, on every
 * refresh tick and when a directory expands — instead of one `fs.tree` POST
 * per level (the N+1 the user's "频繁刷新" report pointed at).
 *
 * This spec is the probe AND the guard. It counts both routes, so running it
 * before the batch change shows the N+1 shape and after it the single request:
 *   - 8 expanded directories: 9 × `fs.tree`  →  1 × `fs.trees` (9 paths);
 *   - expanding one more directory lists ONLY that level (batch of 1);
 *   - a refresh tick re-lists the whole visible set in ONE request;
 *   - a watch notice still re-lists ONLY the stale level;
 *   - one level's `error` stays on that level; a whole-request failure keeps
 *     the cached levels and marks only the ones that had nothing.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { FS_TREES_MAX_PATHS } from '../src/fs-batch.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the error copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const fsTree = vi.hoisted(() => vi.fn())
const fsTrees = vi.hoisted(() => vi.fn())

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: (...args: unknown[]) => fsTree(...args),
    fsTrees: (...args: unknown[]) => fsTrees(...args),
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

const DIRS = ['/tmp/d1', '/tmp/d2', '/tmp/d3', '/tmp/d4', '/tmp/d5', '/tmp/d6', '/tmp/d7', '/tmp/d8']

/** One level's listing: the root lists the eight directories (so the expanded
 *  levels actually render) and every directory lists one file named after it. */
function levelOf(path: string): {
  path: string; entries: { name: string; path: string; isDir: boolean }[]; truncated: boolean
} {
  if (path === '/tmp') {
    return {
      path,
      entries: DIRS.map(dir => ({ name: dir.slice('/tmp/'.length), path: dir, isDir: true })),
      truncated: false,
    }
  }
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { path, entries: [{ name: `${name}-file.ts`, path: `${path}/${name}-file.ts`, isDir: false }], truncated: false }
}

/** The smallest WebSocket the directory watcher talks to (see its spec). */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeSocket.CONNECTING
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(): void {}
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

interface Harness {
  container: HTMLDivElement
  /** Re-render with a new expansion set; `refreshTick` only when bumping it. */
  rerender: (expanded: string[], refreshTick?: number) => void
  unmount: () => void
}

function mountTree(expanded: string[] = DIRS, refreshTick = 0): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (dirs: string[], tick: number): void => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: dirs,
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: tick,
      onUploadRequest: () => {},
      busy: false,
    }))
  }
  let tick = refreshTick
  act(() => { render(expanded, tick) })
  return {
    container,
    rerender: (dirs: string[], nextTick?: number) => {
      if (nextTick !== undefined) tick = nextTick
      act(() => { render(dirs, tick) })
    },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Flush the batch promise chain. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The paths a batch call was asked for. */
function batchPaths(index: number): string[] {
  const call = fsTrees.mock.calls[index]
  if (call === undefined) throw new Error(`no fs.trees call #${index}`)
  return (call[1] as string[]).slice().sort()
}

let harness: Harness
beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  fsTree.mockReset()
  fsTree.mockImplementation(async (_scope: unknown, path: string) => levelOf(path))
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => levelOf(path)),
  }))
})

afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('FileTree level loading is batched', () => {
  it('lists the root plus 8 expanded directories with ONE fs.trees request', async () => {
    harness = mountTree()
    await flush()
    console.log('BATCH-PERF', JSON.stringify({ fsTree: fsTree.mock.calls.length, fsTrees: fsTrees.mock.calls.length }))

    // The N+1 shape is gone: one batch for the whole visible set.
    expect(fsTree).not.toHaveBeenCalled()
    expect(fsTrees).toHaveBeenCalledTimes(1)
    expect(batchPaths(0)).toEqual(['/tmp', ...DIRS].sort())
    // Every level rendered (root + the 8 directories' children).
    expect(harness.container.textContent).toContain('d1-file.ts')
    expect(harness.container.textContent).toContain('d8-file.ts')
  })

  it('splits a visible set larger than the host cap into cap-sized batches', async () => {
    // The expansion set persists per session, so a heavy session can cross the
    // host's row bound. ONE oversized request used to be refused outright
    // (`too many paths (max 64)`) and every level fell back to an error row;
    // the tree now splits on the same number the host enforces.
    const many = Array.from({ length: FS_TREES_MAX_PATHS + 6 }, (_, index) => `/tmp/d${index + 1}`)
    harness = mountTree(many)
    await flush()

    expect(fsTrees).toHaveBeenCalledTimes(2)
    const sizes = fsTrees.mock.calls.map(call => (call[1] as string[]).length).sort((a, b) => a - b)
    expect(sizes).toEqual([6 + 1, FS_TREES_MAX_PATHS])
    // Every visible path is asked for exactly once across the batches.
    expect(fsTrees.mock.calls.flatMap(call => call[1] as string[]).sort()).toEqual(['/tmp', ...many].sort())
    // …and the tree renders instead of collapsing into error rows.
    expect(harness.container.textContent).toContain('d1-file.ts')
    expect(harness.container.textContent).not.toContain('too many paths')
  })

  it('keeps one failed batch from blanking the levels another batch carried', async () => {
    // Batching must not cost the route's per-level error identity: a batch that
    // fails marks only ITS paths, never the whole visible set.
    const many = Array.from({ length: FS_TREES_MAX_PATHS + 6 }, (_, index) => `/tmp/d${index + 1}`)
    fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => {
      // The trailing (small) batch fails; the leading one keeps working.
      if (paths.length < 32) throw new Error('too many paths (max 64)')
      return {
        levels: paths.map(path => path === '/tmp'
          ? {
              path,
              entries: many.map(dir => ({ name: dir.slice('/tmp/'.length), path: dir, isDir: true })),
              truncated: false,
            }
          : levelOf(path)),
      }
    })
    harness = mountTree(many)
    await flush()
    // The levels the leading batch carried are NOT marked as failed…
    expect(harness.container.textContent).toContain('d1-file.ts')
    // …while the failed batch's own levels say why they are missing.
    expect(harness.container.textContent).toContain('too many paths')
  })

  it('lists only the newly expanded directory (batch of 1)', async () => {
    harness = mountTree(DIRS)
    await flush()
    fsTrees.mockClear()
    harness.rerender([...DIRS, '/tmp/d9'])
    await flush()
    expect(fsTrees).toHaveBeenCalledTimes(1)
    expect(batchPaths(0)).toEqual(['/tmp/d9'])
  })

  it('re-lists the whole visible set in ONE request on a refresh tick', async () => {
    harness = mountTree(DIRS)
    await flush()
    fsTrees.mockClear()
    harness.rerender(DIRS, 1)
    await flush()
    expect(fsTrees).toHaveBeenCalledTimes(1)
    expect(batchPaths(0)).toEqual(['/tmp', ...DIRS].sort())
  })

  it('re-lists ONLY the stale level when the directory watcher reports one', async () => {
    harness = mountTree(DIRS)
    await flush()
    const socket = FakeSocket.instances[0]
    if (socket === undefined) throw new Error('no watch socket opened')
    act(() => { socket.open() })
    fsTrees.mockClear()
    act(() => { socket.frame({ dir: '/tmp/d3' }) })
    await flush()
    // A stale notice drops exactly that level and re-lists it — never the
    // whole visible set (the batch path is for mount/expand/refresh only).
    expect(fsTrees).toHaveBeenCalledTimes(1)
    expect(batchPaths(0)).toEqual(['/tmp/d3'])
  })

  it('keeps the stale level on screen until the fresh listing lands (no blank frame)', async () => {
    harness = mountTree(DIRS)
    await flush()
    const socket = FakeSocket.instances[0]
    if (socket === undefined) throw new Error('no watch socket opened')
    act(() => { socket.open() })
    // Hold the re-list open and answer with DIFFERENT content, so the swap is
    // observable in both directions.
    let release: (() => void) | undefined
    fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => {
      await new Promise<void>((resolve) => { release = resolve })
      return {
        levels: paths.map(path => path === '/tmp/d3'
          ? { path, entries: [{ name: 'd3-fresh.ts', path: `${path}/d3-fresh.ts`, isDir: false }], truncated: false }
          : levelOf(path)),
      }
    })
    act(() => { socket.frame({ dir: '/tmp/d3' }) })
    await flush()
    // While the answer is in flight the level keeps the rows it had: dropping
    // the cached level first replaced the whole folder with a loading row and
    // rebuilt it — the "the tree blinks on every disk change" report.
    expect(harness.container.textContent, 'the stale rows stay up during the re-list').toContain('d3-file.ts')
    expect(harness.container.textContent, 'no placeholder replaces the level').not.toContain('Loading…')
    release?.()
    await flush()
    // …and the fresh listing still lands.
    expect(harness.container.textContent).toContain('d3-fresh.ts')
    expect(harness.container.textContent).not.toContain('d3-file.ts')
  })

  it('keeps one level error on that level only', async () => {
    fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => path === '/tmp/d3'
        ? { path, entries: [], truncated: false, error: 'cannot read d3' }
        : levelOf(path)),
    }))
    harness = mountTree(DIRS)
    await flush()
    // The failing level shows its raw message; the others still render.
    expect(harness.container.textContent).toContain('cannot read d3')
    expect(harness.container.textContent).toContain('d1-file.ts')
    expect(harness.container.textContent).toContain('d8-file.ts')
  })

  it('keeps the cached levels (plus a hint) when the whole batch request fails', async () => {
    harness = mountTree(DIRS)
    await flush()
    // Everything is cached now: a failed refresh must not blank the tree — it
    // keeps the previous listing and explains itself in a hint line.
    fsTrees.mockRejectedValue(new Error('listing offline'))
    harness.rerender(DIRS, 1)
    await flush()
    expect(harness.container.textContent).toContain('d1-file.ts')
    expect(harness.container.textContent).toContain('d8-file.ts')
    const hint = harness.container.querySelector<HTMLElement>('[data-kind="warn"]')
    expect(hint?.textContent).toBe('listing offline')
    // The stale rows are NOT replaced by per-level error rows.
    expect(harness.container.querySelectorAll('[class*="explorerError"]')).toHaveLength(0)
  })

  it('shows the failure for levels that had nothing cached', async () => {
    fsTrees.mockRejectedValue(new Error('listing offline'))
    harness = mountTree(DIRS)
    await flush()
    // First load, nothing cached: the one request failed, so the root and the
    // expanded levels carry the message.
    expect(harness.container.textContent).toContain('listing offline')
  })
})
