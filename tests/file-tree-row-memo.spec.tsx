/**
 * FileTree row memoization (the tree's performance contract): rows are
 * `React.memo` components fed stable callbacks and per-row booleans, so an
 * interaction that touches ONE row must re-render that row only — not the
 * whole tree. The evidence is the icon resolver: it runs inside the row
 * component, so counting its calls counts the rows that re-rendered.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import type { BetterSidebarService } from '../src/client/service.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so any copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
        { name: 'c.ts', path: '/tmp/c.ts', isDir: false },
      ], truncated: false })),
    }),
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (its arrival must not defeat the memo bail-out either).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** The icon resolutions per render: one per row that actually re-rendered. */
const fileIcons: string[] = []
const folderIcons: string[] = []

/** A minimal registry service: the counters ARE the re-render probe. */
const service = {
  subscribe: () => () => {},
  fileIcon: (path: string) => { fileIcons.push(path); return null },
  folderIcon: (path: string) => { folderIcons.push(path); return null },
} as unknown as BetterSidebarService

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 'memo-spec',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
      service,
    }))
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One tree row by its displayed name. */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function fireDragOver(el: Element): void {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], dropEffect: '' } })
  act(() => { el.dispatchEvent(event) })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fileIcons.length = 0
  folderIcons.length = 0
})

describe('FileTree row memoization', () => {
  it('re-renders only the toggled row on a Ctrl+click selection change', async () => {
    harness = await mountTree()
    fileIcons.length = 0
    act(() => {
      rowByName(harness.container, 'a.ts')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    })
    // The other three file rows kept their last render (memo bailed out).
    expect(fileIcons).toEqual(['/tmp/a.ts'])
  })

  it('re-renders only the hovered directory row while a drag retargets', async () => {
    harness = await mountTree()
    folderIcons.length = 0
    fileIcons.length = 0
    fireDragOver(rowByName(harness.container, 'sub'))
    // Every parent render resolves the ROOT row's icon; the memoized dir row
    // resolves its own exactly once (its unhovered render was cached), and
    // the file rows (whose drop target is the untouched /tmp) never re-render.
    expect(folderIcons.filter(path => path === '/tmp/sub')).toEqual(['/tmp/sub'])
    expect(fileIcons).toEqual([])
  })
})
