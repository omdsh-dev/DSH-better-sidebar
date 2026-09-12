/**
 * FileTree refresh invalidation: a refresh tick must not leave cached but
 * collapsed directories stale. Expanding one after a refresh has to refetch
 * the fresh listing instead of reusing the pre-refresh cache.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FsEntry } from '../src/client/api.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const rootEntries: FsEntry[] = [
  { name: 'src', path: '/tmp/src', isDir: true, hidden: false, isSymlink: false, broken: false },
  { name: 'a.ts', path: '/tmp/a.ts', isDir: false, hidden: false, isSymlink: false, broken: false },
]

const calls: string[] = []
const srcListings: FsEntry[][] = [
  [{ name: 'old.ts', path: '/tmp/src/old.ts', isDir: false, hidden: false, isSymlink: false, broken: false }],
  [{ name: 'new.ts', path: '/tmp/src/new.ts', isDir: false, hidden: false, isSymlink: false, broken: false }],
]

vi.mock('../src/client/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/client/api.ts')>('../src/client/api.ts')
  return {
    ...actual,
    api: {
      ...actual.api,
      fsTree: async (_scope: unknown, dir: string) => {
        if (dir === '/tmp') return { entries: rootEntries }
        if (dir === '/tmp/src') {
          const listing = srcListings[Math.min(calls.filter(call => call === '/tmp/src').length, srcListings.length - 1)]!
          calls.push(dir)
          return { entries: listing }
        }
        return { entries: [] }
      },
    },
  }
})

let container: HTMLDivElement
let root: Root
let refreshTick: number
let expanded: string[]

function render(): void {
  root.render(createElement(FileTree, {
    sessionId: 's1',
    cwd: '/tmp',
    store: createSidebarStore(),
    expanded,
    revealed: [],
    onToggle: () => {},
    onOpenFile: () => {},
    onReferenceFile: () => {},
    refreshTick,
    onUploadRequest: () => {},
    busy: false,
  }))
}

beforeEach(async () => {
  calls.length = 0
  refreshTick = 0
  expanded = ['/tmp/src']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    render()
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('FileTree refresh invalidation', () => {
  it('refetches a collapsed cached directory after a refresh tick', async () => {
    expect(container.textContent).toContain('old.ts')
    expect(calls.filter(call => call === '/tmp/src')).toHaveLength(1)

    // Collapse the directory and refresh the visible set (one single bump).
    await act(async () => {
      refreshTick = 1
      expanded = []
      render()
    })

    // Re-expand WITHOUT another refresh tick: the stale cache must be
    // reloaded because the single refresh invalidated it while collapsed.
    await act(async () => {
      expanded = ['/tmp/src']
      render()
    })

    expect(calls.filter(call => call === '/tmp/src')).toHaveLength(2)
    expect(container.textContent).toContain('new.ts')
  })
})
