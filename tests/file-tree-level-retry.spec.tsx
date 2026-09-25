/**
 * A directory level that FAILED to load must be fetched again by the next
 * automatic load instead of being cached like a listing.
 *
 * `loadDir` treated every entry in the level cache as "already loaded", and the
 * error branch stored its failure in that same cache — so a single 403 (the
 * trust fence, a host restart, a transient read error) stuck for the whole
 * mount: expanding, switching sessions or re-rendering re-ran the loader for
 * that level and it returned early, leaving the directory unusable until the
 * fence notice's retry button or a remount. The loader is re-driven whenever
 * the expanded set's identity changes, which is the retry this guards.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTreeCalls } = vi.hoisted(() => ({ fsTreeCalls: [] as string[] }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async (_scope: unknown, dir: string) => {
      fsTreeCalls.push(dir)
      if (dir === '/tmp') return { entries: [{ name: 'src', path: '/tmp/src', isDir: true }] }
      // The first attempt at the child directory fails (a fence 403); the next
      // one succeeds, as it would once the metadata or the host recovers.
      if (fsTreeCalls.filter(call => call === '/tmp/src').length === 1) throw new Error('forbidden')
      return { entries: [{ name: 'inner.ts', path: '/tmp/src/inner.ts', isDir: false }] }
    },
  },
  downloadUrl: () => '/sidebar/file',
  // The error row asks this to tell a workspace-boundary failure (which gets
  // the fence notice) from an ordinary one; a plain failure is not a fence one.
  isOutsideWorkspaceMessage: () => false,
}))

describe('FileTree directory-level loading', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    fsTreeCalls.length = 0
  })

  it('retries a failed level instead of treating its error as a cached listing', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = (expanded: string[]): void => {
      root.render(createElement(FileTree, {
        sessionId: 's1',
        cwd: '/tmp',
        store: createSidebarStore(),
        expanded,
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        refreshTick: 0,
        onUploadRequest: () => {},
        busy: false,
      }))
    }

    await act(async () => { render(['/tmp/src']) })
    expect(fsTreeCalls).toEqual(['/tmp', '/tmp/src'])
    expect(container.textContent).toContain('forbidden')
    expect(container.textContent).not.toContain('inner.ts')

    // The parent re-renders with a fresh array holding the same expansion set:
    // the load effect re-runs for the expanded levels, and the failed one has
    // to be requested again rather than skipped as cached.
    await act(async () => { render(['/tmp/src']) })
    expect(fsTreeCalls).toEqual(['/tmp', '/tmp/src', '/tmp/src'])
    expect(container.textContent).toContain('inner.ts')
  })
})
