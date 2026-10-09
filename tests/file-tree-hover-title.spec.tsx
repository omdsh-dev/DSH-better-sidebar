/**
 * Explorer row hover titles (#186): a deep path must stay readable.
 *
 * The tree body never scrolls horizontally on purpose (`.explorerBody` is
 * `overflow-x: hidden`) and every label is ellipsised, so a row's `title` is
 * the ONLY way to read where it really points. File rows always had one; the
 * directory rows did not — the ordinary (single-segment) directory row and the
 * workspace root row rendered no `title` at all, and the folded breadcrumb row
 * only got one when it had more than one link. This spec drives the real tree
 * through the jsdom harness the other file-tree specs use and pins the tooltip
 * of EVERY render path, so no row can silently regress to `undefined`.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import css from '../src/client/sidebar.module.css'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const ROOT = '/tmp/ws'

const fsTrees = vi.hoisted(() => vi.fn())

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: vi.fn(),
    fsTrees: (...args: unknown[]) => fsTrees(...args),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Row {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  isSymlink: boolean
  broken: boolean
  compact?: boolean
}

/** A directory row; `compact` is the host's singleton mark (fold chains). */
function dir(path: string, compact = false): Row {
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
function file(path: string, broken = false): Row {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, isDir: false, hidden: name.startsWith('.'), isSymlink: broken, broken }
}

/**
 * `ws/` holds a PLAIN directory (chain of one — the row that used to render no
 * title), a singleton chain `a` → `a/b` (folded into one breadcrumb row), a
 * regular file and a broken symlink (the file row's conditional wording).
 *
 * The rows arrive in the order a host really lists them (directories first,
 * then case-insensitive by name): the tree re-sorts each level for display
 * (file-tree-sort.ts), so a fixture in any other order describes a listing no
 * host ever produces.
 */
function levelOf(path: string): { path: string; entries: Row[]; truncated: boolean } {
  switch (path) {
    case ROOT:
      return { path, entries: [
        dir('/tmp/ws/a', true),
        dir('/tmp/ws/plain'),
        file('/tmp/ws/dangling', true),
        file('/tmp/ws/readme.md'),
      ], truncated: false }
    case '/tmp/ws/a':
      return { path, entries: [dir('/tmp/ws/a/b', true)], truncated: false }
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
  unmount: () => void
}

function mountTree(): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: ROOT,
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

/** Flush the batch promise chain (the level cache fill + fold preload). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Every tree row in document order — root row first, then the level's rows. */
function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`.${css.explorerRow}`)]
}

/** A row's own LABEL (the name span), never the trailing "Reference file" button. */
function labelOf(row: HTMLElement): string {
  return row.querySelector(`.${css.explorerName}`)?.textContent ?? ''
}

/** The row rendering `label` (labels are unique in this fixture). */
function rowByLabel(container: HTMLElement, label: string): HTMLElement {
  const row = rows(container).find(candidate => labelOf(candidate) === label)
  if (row === undefined) throw new Error(`no row "${label}" in ${JSON.stringify(rows(container).map(labelOf))}`)
  return row
}

/** One row's tooltip (`null` when the row carries none — the old bug). */
function titleOf(container: HTMLElement, label: string): string | null {
  return rowByLabel(container, label).getAttribute('title')
}

let harness: Harness
beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
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

describe('FileTree row hover titles', () => {
  it('titles a plain directory row with its full path, not the truncated label', async () => {
    harness = mountTree()
    await flush()

    // The row only PRINTS the basename (ellipsised when long)…
    expect(labelOf(rowByLabel(harness.container, 'plain'))).toBe('plain')
    // …so the tooltip carries the whole path (this was `undefined`).
    expect(titleOf(harness.container, 'plain')).toBe('/tmp/ws/plain')
  })

  it('titles a folded breadcrumb row with the chain tail it renders', async () => {
    harness = mountTree()
    await flush()

    // `a` folds through its singleton dir child: one `a/b` row.
    expect(labelOf(rowByLabel(harness.container, 'a/b'))).toBe('a/b')
    expect(titleOf(harness.container, 'a/b')).toBe('/tmp/ws/a/b')
  })

  it('titles the workspace root row with the full workspace path', async () => {
    harness = mountTree()
    await flush()

    // The root row prints only the folder's basename (`ws`)…
    expect(labelOf(rowByLabel(harness.container, 'ws'))).toBe('ws')
    // …and now names the whole path like every other row.
    expect(titleOf(harness.container, 'ws')).toBe(ROOT)
  })

  it('leaves file rows as they were: full path, broken symlink wording kept', async () => {
    harness = mountTree()
    await flush()

    expect(titleOf(harness.container, 'readme.md')).toBe('/tmp/ws/readme.md')
    // The file row's existing conditional wording survives untouched.
    expect(titleOf(harness.container, 'dangling')).toBe('/tmp/ws/dangling — Broken symlink')
  })

  it('leaves no rendered row without a title', async () => {
    harness = mountTree()
    await flush()

    const titled = rows(harness.container)
      .map(row => `${labelOf(row)} → ${row.getAttribute('title') ?? '<none>'}`)
    expect(titled).toEqual([
      'ws → /tmp/ws',
      'a/b → /tmp/ws/a/b',
      'plain → /tmp/ws/plain',
      'dangling → /tmp/ws/dangling — Broken symlink',
      'readme.md → /tmp/ws/readme.md',
    ])
  })
})
