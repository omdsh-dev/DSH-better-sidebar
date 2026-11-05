/**
 * External file actions (feature `fileActions`): the registry half and the
 * tree half.
 *
 * REGISTRY — `registerFileAction` follows the other registries exactly: a
 * duplicate id throws, the disposer removes only its own descriptor (a later
 * re-registration must not be torn down by an older disposer), and
 * `getFileActions()` answers in RENDER order — `order` ascending, registration
 * order for equal orders (the tree renders the array as it arrives, so the
 * getter is the only place this can be decided).
 *
 * TREE — an applicable action is a row-menu entry: it runs with the row's
 * ABSOLUTE path plus the tree's root and session (never a display path, that
 * is what a caller would upload/move with), and it sits between the tree's
 * open/download rows and its own copy/mutation block. `row: true` adds a hover
 * button, but only when the descriptor brought a glyph. Directories are out
 * unless the descriptor says `dirs: true`. A `when()` that says no hides the
 * row, and one that THROWS hides it too instead of breaking the tree. A
 * rejecting `run` lands its own message in the tree's error strip — the same
 * strip a failed rename uses — and a resolved one says nothing (the owner
 * reports its own outcome).
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import css from '../src/client/sidebar.module.css'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const ROOT = '/tmp/ws'

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: levelOf(path).entries, truncated: false })),
    }),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** Directories first, then case-insensitive by name — what a host lists. */
function levelOf(path: string): { entries: { name: string; path: string; isDir: boolean; hidden: boolean; isSymlink: boolean; broken: boolean }[] } {
  const entries = path === ROOT
    ? [
        { name: 'sub', path: `${ROOT}/sub`, isDir: true },
        { name: 'notes.md', path: `${ROOT}/notes.md`, isDir: false },
      ]
    : []
  return {
    entries: entries.map(entry => ({ ...entry, hidden: false, isSymlink: false, broken: false })),
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
  service: ReturnType<typeof createBetterSidebarService>
  unmount: () => void
}

function mountTree(): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const service = createBetterSidebarService(createSidebarStore())
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
      service,
    }))
  })
  return { container, service, unmount: () => { act(() => { root.unmount() }); container.remove() } }
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

/** The row rendering `label` (labels are unique in this fixture). */
function rowByLabel(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(`.${css.explorerRow}`)]
    .find(candidate => candidate.querySelector(`.${css.explorerName}`)?.textContent === label)
  if (row === undefined) throw new Error(`no row "${label}"`)
  return row
}

function rightClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  })
}

/** Every open menu row's label, in DOM order. */
function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent ?? '')
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent === label)
  if (item === undefined) throw new Error(`no menu row "${label}" in ${JSON.stringify(menuLabels())}`)
  act(() => { item.click() })
}

/** One external action with test-friendly defaults. */
function action(id: string, overrides: Partial<Parameters<ReturnType<typeof createBetterSidebarService>['registerFileAction']>[0]> = {}) {
  return {
    id,
    label: id.toUpperCase(),
    icon: createElement('span', { 'data-testid': `glyph-${id}` }),
    run: () => {},
    ...overrides,
  }
}

describe('fileActions registry', () => {
  it('declares the feature and starts empty', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(service.features).toContain('fileActions')
    expect(service.getFileActions()).toEqual([])
  })

  it('answers in render order: order ascending, then registration order', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileAction(action('late', { order: 5 }))
    service.registerFileAction(action('early', { order: -5 }))
    service.registerFileAction(action('default'))
    service.registerFileAction(action('default-second'))
    expect(service.getFileActions().map(entry => entry.id)).toEqual(
      ['early', 'default', 'default-second', 'late'],
    )
  })

  it('refuses a duplicate id', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileAction(action('same'))
    expect(() => service.registerFileAction(action('same'))).toThrow(/already registered/u)
  })

  it('a stale disposer cannot remove a newer registration', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const disposeFirst = service.registerFileAction(action('same'))
    disposeFirst()
    const replacement = action('same')
    service.registerFileAction(replacement)
    disposeFirst()
    expect(service.getFileActions()).toEqual([replacement])
  })

  it('disposal empties the registry for the tree', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const dispose = service.registerFileAction(action('gone'))
    expect(service.getFileActions()).toHaveLength(1)
    dispose()
    expect(service.getFileActions()).toEqual([])
  })
})

describe('fileActions in the tree', () => {
  let harness: Harness

  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket)
  })

  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('is a menu row for files, between the open rows and the copy block', async () => {
    harness = mountTree()
    act(() => { harness.service.registerFileAction(action('upload')) })
    await flush()

    rightClick(rowByLabel(harness.container, 'notes.md'))
    const labels = menuLabels()
    expect(labels).toContain('UPLOAD')
    // After the built-in download row, before the copy rows the tree owns.
    expect(labels.indexOf('UPLOAD')).toBeGreaterThan(labels.indexOf('Download'))
    expect(labels.indexOf('UPLOAD')).toBeLessThan(labels.indexOf('Copy relative path'))
  })

  it('runs with the ABSOLUTE path, the tree root and the session', async () => {
    harness = mountTree()
    const run = vi.fn()
    act(() => { harness.service.registerFileAction(action('upload', { run })) })
    await flush()

    rightClick(rowByLabel(harness.container, 'notes.md'))
    clickMenuitem('UPLOAD')

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      path: `${ROOT}/notes.md`,
      root: ROOT,
      sessionId: 's1',
      isDir: false,
      fail: expect.any(Function),
    })
  })

  it('hides itself from directory rows unless the descriptor claims them', async () => {
    harness = mountTree()
    act(() => { harness.service.registerFileAction(action('upload')) })
    act(() => { harness.service.registerFileAction(action('dir-only', { dirs: true })) })
    await flush()

    rightClick(rowByLabel(harness.container, 'sub'))
    const labels = menuLabels()
    expect(labels).not.toContain('UPLOAD')
    expect(labels).toContain('DIR-ONLY')
  })

  it('honours when(), and a throwing when() only hides its own row', async () => {
    harness = mountTree()
    act(() => { harness.service.registerFileAction(action('sql-only', { when: row => row.path.endsWith('.sql') })) })
    act(() => { harness.service.registerFileAction(action('boom', { when: () => { throw new Error('nope') } })) })
    await flush()

    rightClick(rowByLabel(harness.container, 'notes.md'))
    const labels = menuLabels()
    expect(labels).not.toContain('SQL-ONLY')
    expect(labels).not.toContain('BOOM')
  })

  it('puts a hover button on the row when asked for one', async () => {
    harness = mountTree()
    const run = vi.fn()
    act(() => { harness.service.registerFileAction(action('pin', { row: true, label: 'Send to cloud', run })) })
    await flush()

    const button = rowByLabel(harness.container, 'notes.md')
      .querySelector<HTMLButtonElement>(`.${css.explorerAction}`)
    expect(button).not.toBeNull()
    expect(button?.getAttribute('title')).toBe('Send to cloud')
    expect(button?.getAttribute('aria-label')).toBe('Send to cloud')
    act(() => { button?.click() })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ path: `${ROOT}/notes.md`, isDir: false }))
  })

  it('keeps a glyph-less registration menu-only', async () => {
    harness = mountTree()
    act(() => { harness.service.registerFileAction({ id: 'textual', label: 'Textual', row: true, run: () => {} }) })
    await flush()

    expect(rowByLabel(harness.container, 'notes.md').querySelector(`.${css.explorerAction}`)).toBeNull()
    rightClick(rowByLabel(harness.container, 'notes.md'))
    expect(menuLabels()).toContain('Textual')
  })

  it('reports a rejection in the error strip and stays quiet on success', async () => {
    harness = mountTree()
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('upload refused'))
      .mockResolvedValueOnce(undefined)
    act(() => { harness.service.registerFileAction(action('upload', { run })) })
    await flush()

    rightClick(rowByLabel(harness.container, 'notes.md'))
    clickMenuitem('UPLOAD')
    await flush()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('upload refused')

    rightClick(rowByLabel(harness.container, 'notes.md'))
    clickMenuitem('UPLOAD')
    await flush()
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })
})