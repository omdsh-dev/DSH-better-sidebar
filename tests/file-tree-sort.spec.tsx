/**
 * Explorer sort control: the pure ordering (`sortEntries` / `typeOf`) plus the
 * two surfaces that consume it — FileTree's rows and the tree header's menu in
 * TreePanel.
 *
 * The contract under test: the DEFAULT choice (name + folders first) reproduces
 * the server's own order EXACTLY (`fs-tree.ts`'s `compareEntries` drives the
 * expectation, so a divergence on either side fails here), "by type" groups by
 * extension, and the folders-first switch is independent of the key (it really
 * mixes directories into the key's order when off).
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { compareEntries, type SidebarFsEntry } from '../src/fs-tree.ts'
import { FileTree } from '../src/client/FileTree.tsx'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { DEFAULT_FILE_TREE_SORT, sortEntries, typeOf } from '../src/client/file-tree-sort.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** One host-shaped row (only the fields ordering reads). */
function row(name: string, isDir: boolean): SidebarFsEntry {
  return { name, path: `/tmp/${name}`, isDir, hidden: false, isSymlink: false, broken: false }
}

/**
 * A level whose HOST order (directories first, then name) is deliberately not
 * the type order: `zdir` is a directory that sorts after two of the files by
 * name, so only the folders-first switch can move it.
 */
const HOST_ORDER: SidebarFsEntry[] = [
  row('zdir', true),
  row('alpha.ts', false),
  row('beta', false),
  row('Gamma.MD', false),
]

const names = (entries: readonly { name: string }[]): string[] => entries.map(entry => entry.name)

describe('file tree sort (pure ordering)', () => {
  it('defaults to the server order: same key, folders first', () => {
    expect(DEFAULT_FILE_TREE_SORT).toEqual({ key: 'name', dirsFirst: true })
  })

  it('reproduces compareEntries EXACTLY for the default choice', () => {
    // The host comparator is the reference: the default client order must be
    // the same listing order, element for element (the control ON with its
    // initial value changes nothing).
    expect(names(sortEntries(HOST_ORDER, DEFAULT_FILE_TREE_SORT)))
      .toEqual(names([...HOST_ORDER].sort(compareEntries)))
    // …and it is not a no-op by accident: an unsorted level comes out ordered.
    const shuffled = [HOST_ORDER[2]!, HOST_ORDER[0]!, HOST_ORDER[3]!, HOST_ORDER[1]!]
    expect(names(sortEntries(shuffled, DEFAULT_FILE_TREE_SORT))).toEqual(['zdir', 'alpha.ts', 'beta', 'Gamma.MD'])
  })

  it('orders by name case-insensitively with the host tie-break when folders are first', () => {
    const entries = [row('b.txt', false), row('A.txt', false), row('a.txt', false), row('Dir', true)]
    expect(names(sortEntries(entries, { key: 'name', dirsFirst: true }))).toEqual(['Dir', 'A.txt', 'a.txt', 'b.txt'])
  })

  it('mixes directories into the name order when folders first is off', () => {
    expect(names(sortEntries(HOST_ORDER, { key: 'name', dirsFirst: false })))
      .toEqual(['alpha.ts', 'beta', 'Gamma.MD', 'zdir'])
  })

  it('orders by type (extension) with folders first', () => {
    expect(names(sortEntries(HOST_ORDER, { key: 'type', dirsFirst: true })))
      // zdir first (a directory), then extension-less `beta`, then md, then ts.
      .toEqual(['zdir', 'beta', 'Gamma.MD', 'alpha.ts'])
  })

  it('mixes directories into the type order when folders first is off', () => {
    expect(names(sortEntries(HOST_ORDER, { key: 'type', dirsFirst: false })))
      // `zdir` has no extension, so it groups with `beta` and the name order
      // decides between them — the switch really moved the directory.
      .toEqual(['beta', 'zdir', 'Gamma.MD', 'alpha.ts'])
  })

  it('sorts a copy: the cached level array is never reordered in place', () => {
    const before = names(HOST_ORDER)
    const sorted = sortEntries(HOST_ORDER, { key: 'type', dirsFirst: false })
    expect(sorted).not.toBe(HOST_ORDER)
    expect(names(HOST_ORDER)).toEqual(before)
  })

  it('typeOf reads the LAST extension, nothing for dirs, dotfiles or dot-less names', () => {
    expect(typeOf('a.tar.gz', false)).toBe('gz')
    expect(typeOf('A.TS', false)).toBe('ts')
    expect(typeOf('.gitignore', false)).toBe('')
    expect(typeOf('Makefile', false)).toBe('')
    expect(typeOf('weird.', false)).toBe('')
    expect(typeOf('a.tar.gz', true)).toBe('')
  })
})

const { fsTrees, fsSearch, gitStatus } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({ path, entries: path === '/tmp' ? HOST_ORDER_ROWS : [], truncated: false })),
  })),
  fsSearch: vi.fn(async () => ({ matches: [], dirs: [], truncated: false })),
  gitStatus: vi.fn(async () => ({ isRepo: false, entries: [] })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: { fsTrees, fsSearch, gitStatus },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** The fixture as the level cache stores it (plain rows, host order). */
const HOST_ORDER_ROWS = [
  { name: 'zdir', path: '/tmp/zdir', isDir: true },
  { name: 'alpha.ts', path: '/tmp/alpha.ts', isDir: false },
  { name: 'beta', path: '/tmp/beta', isDir: false },
  { name: 'Gamma.MD', path: '/tmp/Gamma.MD', isDir: false },
]

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

/** Child row labels of the workspace root, in render order. */
function rowNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .filter(el => (el.style.paddingLeft === '28px'))
    .map(el => el.querySelector('[class*="explorerName"]')?.textContent ?? '')
}

let harness: Harness | undefined

afterEach(() => {
  harness?.unmount()
  harness = undefined
  document.body.innerHTML = ''
  fsTrees.mockClear()
  fsSearch.mockClear()
  gitStatus.mockClear()
})

describe('FileTree sort prop', () => {
  function mountTree(sort?: { key: 'name' | 'type'; dirsFirst: boolean }): Harness {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(createElement(FileTree, {
        sessionId: 's1',
        cwd: '/tmp',
        expanded: [],
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        refreshTick: 0,
        onUploadRequest: () => {},
        busy: false,
        ...(sort !== undefined ? { sort } : {}),
      }))
    })
    return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
  }

  it('renders the host order by default (the control is invisible until used)', async () => {
    harness = mountTree()
    await act(async () => {})
    expect(rowNames(harness.container)).toEqual(['zdir', 'alpha.ts', 'beta', 'Gamma.MD'])
  })

  it('renders the type order when the caller asks for it', async () => {
    harness = mountTree({ key: 'type', dirsFirst: true })
    await act(async () => {})
    expect(rowNames(harness.container)).toEqual(['zdir', 'beta', 'Gamma.MD', 'alpha.ts'])
  })

  it('interleaves directories with files once folders first is off', async () => {
    harness = mountTree({ key: 'name', dirsFirst: false })
    await act(async () => {})
    expect(rowNames(harness.container)).toEqual(['alpha.ts', 'beta', 'Gamma.MD', 'zdir'])
  })
})

describe('TreePanel sort control', () => {
  function mountPanel(): Harness {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    function Host(): ReactNode {
      const [expanded, setExpanded] = useState<string[]>([])
      return createElement(TreePanel, {
        sessionId: 's1',
        cwd: '/tmp',
        expanded,
        revealed: [],
        onToggle: (path: string) => { setExpanded(current => current.includes(path) ? current : [...current, path]) },
        onOpenFile: () => {},
        onReferenceFile: () => {},
      })
    }
    act(() => { root.render(createElement(Host)) })
    return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
  }

  function click(el: HTMLElement): void {
    act(() => { el.click() })
  }

  function sortButton(container: HTMLElement): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Sort"]')
    if (button === null) throw new Error('sort button not found')
    return button
  }

  function menuItem(label: string): HTMLElement {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent === label)
    if (item === undefined) throw new Error(`menuitem not found: ${label}`)
    return item
  }

  it('offers both keys and the folders-first switch, and applies them to the tree', async () => {
    harness = mountPanel()
    await act(async () => {})
    expect(rowNames(harness.container)).toEqual(['zdir', 'alpha.ts', 'beta', 'Gamma.MD'])

    // The control lives in the tree header's tool row, next to refresh/upload.
    click(sortButton(harness.container))
    expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(el => el.textContent))
      .toEqual(['Sort by name', 'Sort by type', 'Folders first'])

    click(menuItem('Sort by type'))
    expect(rowNames(harness.container)).toEqual(['zdir', 'beta', 'Gamma.MD', 'alpha.ts'])

    // The switch is independent of the key: turning folders first off keeps
    // the type grouping and lets the directory fall into its own group.
    click(sortButton(harness.container))
    click(menuItem('Folders first'))
    expect(rowNames(harness.container)).toEqual(['beta', 'zdir', 'Gamma.MD', 'alpha.ts'])

    // …and back to the default pair.
    click(sortButton(harness.container))
    click(menuItem('Folders first'))
    click(sortButton(harness.container))
    click(menuItem('Sort by name'))
    expect(rowNames(harness.container)).toEqual(['zdir', 'alpha.ts', 'beta', 'Gamma.MD'])
  })
})
