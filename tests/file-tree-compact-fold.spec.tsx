/**
 * Explorer breadcrumb folding in the real tree (VSCode "compact folders").
 *
 * The host marks a directory row `compact` when its contents are exactly one
 * effective child; this spec drives the CLIENT half against the level cache the
 * batch route fills:
 *   - a chain of singleton dirs renders as ONE `a/b/c` row, and the collapsed
 *     links' levels are PRELOADED (otherwise the label would grow a segment at
 *     a time as the user clicks);
 *   - a plain click toggles the WHOLE chain, so the row opens and closes as one
 *     (only ever toggling the head would strand an earlier-expanded link open);
 *   - the open row descends into the chain TAIL, not the head;
 *   - the exclude list is carried on every `fs.trees` request and a changed list
 *     wipes the level cache (the host filters, so cached rows are stale).
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

const { fsTrees, fsRename } = vi.hoisted(() => ({
  fsTrees: vi.fn(),
  fsRename: vi.fn(async (scope: unknown, path: string, name: string) => ({
    path: `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`,
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: vi.fn(),
    fsTrees: (...args: unknown[]) => fsTrees(...args),
    fsRename: (...args: unknown[]) => fsRename(...(args as [unknown, string, string])),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** A directory row; `compact` is the host's singleton mark. */
function dir(path: string, compact = false): {
  name: string; path: string; isDir: boolean; hidden: boolean; isSymlink: boolean; broken: boolean; compact?: boolean
} {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    name,
    path,
    isDir: true,
    hidden: name.startsWith('.'),
    isSymlink: false,
    broken: false,
    ...(compact ? { compact: true } : {}),
  }
}

/** A file row. */
function file(path: string): {
  name: string; path: string; isDir: boolean; hidden: boolean; isSymlink: boolean; broken: boolean
} {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, isDir: false, hidden: name.startsWith('.'), isSymlink: false, broken: false }
}

/**
 * `/tmp` → `a`, then a/b, then a/b/c, then a real file. Every directory on the
 * chain is a singleton, so `a` folds all the way to `a/b/c`.
 */
function levelOf(path: string): {
  path: string; entries: unknown[]; truncated: boolean
} {
  switch (path) {
    case '/tmp':
      return { path, entries: [dir('/tmp/a', true), file('/tmp/readme.md')], truncated: false }
    case '/tmp/a':
      return { path, entries: [dir('/tmp/a/b', true)], truncated: false }
    case '/tmp/a/b':
      return { path, entries: [dir('/tmp/a/b/c', true)], truncated: false }
    default:
      return { path, entries: [file(`${path}/leaf.txt`)], truncated: false }
  }
}

/** The smallest WebSocket the directory watcher talks to. */
class FakeSocket {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3 }
}

interface Harness {
  container: HTMLDivElement
  toggled: string[]
  rerender: (expanded: string[], exclude?: readonly string[]) => void
  unmount: () => void
}

function mountTree(expanded: string[] = [], exclude?: readonly string[]): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const toggled: string[] = []
  const render = (dirs: string[], patterns: readonly string[] | undefined): void => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: dirs,
      revealed: [],
      onToggle: (path: string) => { toggled.push(path) },
      onOpenFile: () => {},
      onReferenceFile: () => {},
      ...(patterns === undefined ? {} : { exclude: patterns }),
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  }
  act(() => { render(expanded, exclude) })
  return {
    container,
    toggled,
    rerender: (dirs: string[], patterns?: readonly string[]) => {
      act(() => { render(dirs, patterns ?? exclude) })
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
    await Promise.resolve()
  })
}

/** The directory rows' rendered labels, in document order. */
function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .map(row => row.textContent ?? '')
}

/** The row whose label is exactly `label`. */
function rowByLabel(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(candidate => (candidate.textContent ?? '').startsWith(label))
  if (row === undefined) throw new Error(`no row "${label}" in ${JSON.stringify(rowLabels(container))}`)
  return row
}

/** One row by its rendered label (a folded row's label is the whole chain). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(element => element.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`no row "${name}" in ${JSON.stringify(rowLabels(container))}`)
  return row
}

/** Right-click one row (the row menu addresses what the row's label names). */
function openMenu(container: HTMLElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowByName(container, name).dispatchEvent(event) })
}

/** Click one row-menu entry by its (English, locale-pinned) label. */
function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent === label)
  if (item === undefined) throw new Error(`menuitem "${label}" not found`)
  act(() => { item.click() })
}

/** Set a controlled input's value the React way (native setter + input). */
function setNativeValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressKey(element: HTMLElement, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** Every path the tree has asked for, across all batches. */
function requestedPaths(): string[] {
  return fsTrees.mock.calls.flatMap(call => call[1] as string[])
}

let harness: Harness
beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  fsTrees.mockReset()
  fsRename.mockClear()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => levelOf(path)),
  }))
})

afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('FileTree breadcrumb folding', () => {
  it('folds a singleton chain into ONE a/b/c row and preloads the collapsed links', async () => {
    harness = mountTree()
    await flush()

    // The chain renders as one row carrying the full breadcrumb…
    const labels = rowLabels(harness.container)
    expect(labels.some(label => label.startsWith('a/b/c'))).toBe(true)
    // …and NOT as the three nested rows it would be unfolded.
    expect(labels.filter(label => /^a\/?b?\/?c?/.test(label))).toHaveLength(1)
    // The collapsed links' levels were loaded ahead of any expansion: without
    // them the label would grow a segment per click.
    expect(requestedPaths().sort()).toEqual(['/tmp', '/tmp/a', '/tmp/a/b', '/tmp/a/b/c'].sort())
    // The sibling file is untouched by the fold.
    expect(harness.container.textContent).toContain('readme.md')
  })

  it('toggles the WHOLE chain on a plain click, so the row closes as one', async () => {
    // The head was expanded by an earlier interaction (before the fold formed):
    // closing the row must collapse every link, not just the head.
    harness = mountTree(['/tmp/a'])
    await flush()
    act(() => { rowByLabel(harness.container, 'a/b/c').click() })
    expect(harness.toggled).toEqual(['/tmp/a'])
  })

  it('expands every link of the chain when the row is closed', async () => {
    harness = mountTree()
    await flush()
    act(() => { rowByLabel(harness.container, 'a/b/c').click() })
    // Closed → open: every link that is not expanded yet gets toggled, which is
    // what makes the tail's children render.
    expect(harness.toggled.sort()).toEqual(['/tmp/a', '/tmp/a/b', '/tmp/a/b/c'].sort())
  })

  it('descends into the chain TAIL when open, not the head', async () => {
    harness = mountTree(['/tmp/a/b/c'])
    await flush()
    // The folded row shows the tail's contents (the chain's end), never a/b's.
    expect(harness.container.textContent).toContain('leaf.txt')
    expect(rowLabels(harness.container).some(label => label.startsWith('a/b/c'))).toBe(true)
  })

  it('renames the chain TAIL the row shows, not the fold head', async () => {
    // The row renders at `/tmp/a` (the chain head) and its menu addressed the
    // TAIL, so the commit has to land on `/tmp/a/b/c` — the directory the label
    // names. Committing the head renamed the PARENT directory instead.
    harness = mountTree()
    await flush()
    openMenu(harness.container, 'a/b/c')
    clickMenuitem('Rename')
    const input = harness.container.querySelector<HTMLInputElement>('input[class*="explorerRenameInput"]')
    expect(input).not.toBeNull()
    expect(input!.value).toBe('c')
    setNativeValue(input!, 'renamed')
    await act(async () => { pressKey(input!, 'Enter') })
    expect(fsRename).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a/b/c', 'renamed')
  })

  it('carries the exclude list on every request, and a changed list wipes the cache', async () => {
    harness = mountTree([], ['node_modules'])
    await flush()
    // Every batch carries the patterns as its third argument.
    for (const call of fsTrees.mock.calls) {
      expect(call[2]).toEqual(['node_modules'])
    }
    expect(requestedPaths()).toContain('/tmp')
    fsTrees.mockClear()
    // A changed list must re-list the visible set: the HOST filters the rows,
    // so what is cached was filtered by the previous list.
    harness.rerender([], ['.DS_Store', 'node_modules'])
    await flush()
    expect(requestedPaths()).toContain('/tmp')
    for (const call of fsTrees.mock.calls) {
      expect(call[2]).toEqual(['.DS_Store', 'node_modules'])
    }
  })

  it('does not re-list when a value-equal exclude list changes identity', async () => {
    harness = mountTree([], ['node_modules'])
    await flush()
    fsTrees.mockClear()
    // A fresh array with the same content: the cache and the effect key on the
    // VALUE, so a re-render must not cost another listing.
    harness.rerender([], ['node_modules'])
    await flush()
    expect(fsTrees).not.toHaveBeenCalled()
  })
})
