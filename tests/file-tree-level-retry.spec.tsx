/**
 * A directory level whose load FAILED must be fetched again by the next
 * automatic load instead of being cached like a listing (PR #677, ported to
 * the batched `loadLevels` shape).
 *
 * Both failure branches of `loadLevels` store their error in the level cache —
 * a per-level `error` riding a successful batch, and `{ error }` from a failed
 * whole request — and the cache-hit filter treated every entry as "already
 * loaded". One bad read (a host restart, a transient fs error) then stuck for
 * the rest of the mount: re-rendering the tree with the same expansion set
 * re-ran the load effect, which skipped the failed level, and the only ways
 * out were a refresh tick (the force path) or a remount. The load effect
 * re-runs whenever the expanded set's identity changes, which is the retry
 * this guards — while levels that DID list stay cached, and a load that is
 * still in flight is not duplicated.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the copy is English.
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
}))

/** The smallest WebSocket the directory watcher talks to (never opened — no
 *  watch notice is part of this spec; the retry comes from the load effect). */
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

/** One level's listing: the root lists `src`, `src` lists one file. */
function levelOf(path: string): {
  path: string; entries: { name: string; path: string; isDir: boolean }[]; truncated: boolean
} {
  if (path === '/tmp') {
    return { path, entries: [{ name: 'src', path: '/tmp/src', isDir: true }], truncated: false }
  }
  return { path, entries: [{ name: 'inner.ts', path: '/tmp/src/inner.ts', isDir: false }], truncated: false }
}

/** The paths a batch call was asked for (sorted: the cache decides membership,
 *  not the order). */
function batchPaths(index: number): string[] {
  const call = fsTrees.mock.calls[index]
  if (call === undefined) throw new Error(`no fs.trees call #${index}`)
  return (call[1] as string[]).slice().sort()
}

interface Harness {
  container: HTMLDivElement
  /** Re-render with a NEW array holding the same expansion set: the load
   *  effect's `expanded` dependency changes identity, re-running the
   *  automatic (non-forced) load — the retry path this spec guards. */
  rerender: (expanded: string[]) => void
  unmount: () => void
}

function mountTree(expanded: string[]): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (dirs: string[]): void => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: dirs,
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  }
  act(() => { render(expanded) })
  return {
    container,
    rerender: (dirs: string[]) => { act(() => { render(dirs) }) },
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

let harness: Harness
beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  fsTree.mockReset()
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

describe('FileTree directory-level loading retries failures', () => {
  it('re-requests a level that came back with a per-level error', async () => {
    // The first batch fails the child level IN PLACE (the batch itself
    // succeeds — one unreadable directory must not blank the whole tree); the
    // next answer succeeds, as it would once the host recovers.
    fsTrees.mockImplementationOnce(async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => path === '/tmp/src'
        ? { path, entries: [], truncated: false, error: 'cannot read src' }
        : levelOf(path)),
    }))
    harness = mountTree(['/tmp/src'])
    // A re-render while the batch is still in flight must NOT duplicate the
    // request: the `{}` placeholder of the open load is a cache hit too.
    harness.rerender(['/tmp/src'])
    await flush()
    expect(fsTrees).toHaveBeenCalledTimes(1)
    expect(batchPaths(0)).toEqual(['/tmp', '/tmp/src'])
    expect(harness.container.textContent).toContain('cannot read src')
    expect(harness.container.textContent).not.toContain('inner.ts')

    // The parent re-renders with a fresh array holding the same expansion
    // set: the load effect re-runs, and the failed level has to be requested
    // again — while the root that DID list stays cached (batch of 1).
    harness.rerender(['/tmp/src'])
    await flush()
    expect(fsTrees).toHaveBeenCalledTimes(2)
    expect(batchPaths(1)).toEqual(['/tmp/src'])
    expect(harness.container.textContent).toContain('inner.ts')
    // The retry rides the batch route (the N+1 shape stays gone).
    expect(fsTree).not.toHaveBeenCalled()
  })

  it('re-requests levels stored by a failed whole batch request', async () => {
    // The first batch dies wholesale (host restart, network gone): every
    // wanted level — including the root — is stored as a bare failure.
    fsTrees.mockRejectedValueOnce(new Error('listing offline'))
    harness = mountTree(['/tmp/src'])
    await flush()
    expect(harness.container.textContent).toContain('listing offline')
    expect(harness.container.textContent).not.toContain('inner.ts')

    // Same fresh-array re-render: BOTH stored failures are retryable, so the
    // retry batch is the full visible set again.
    harness.rerender(['/tmp/src'])
    await flush()
    expect(fsTrees).toHaveBeenCalledTimes(2)
    expect(batchPaths(1)).toEqual(['/tmp', '/tmp/src'])
    expect(harness.container.textContent).toContain('inner.ts')
  })
})
