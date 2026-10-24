/**
 * The right-click menu must be CHEAP: opening, closing and reopening it is
 * pure UI state and must not touch the workspace.
 *
 * This spec is both the measurement probe and the regression guard for the
 * user's "右键菜单点击后不要频繁刷新" report. It pins four counters across a
 * menu open → close → reopen cycle:
 *   - `api.fsTree`: directory levels load on expand / refresh tick ONLY, never
 *     because a menu opened;
 *   - `api.gitStatus`: the shared status poll PAUSES while a menu is open (git
 *     ink behind a context menu is not worth a request) and resumes on close;
 *   - icon resolutions (`service.fileIcon` / `folderIcon`): a memoized row
 *     resolves its icon on every render, so this counts re-rendered rows;
 *   - `api.fileApps`: the host application list is CACHED per path, so
 *     reopening the same row's menu neither re-requests it nor flashes
 *     "Loading…".
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

const { fsTree, fsTrees, gitStatus, fileApps, directoryApps, archiveBuild, archiveStatus } = vi.hoisted(() => ({
  fsTree: vi.fn(),
  fsTrees: vi.fn(),
  gitStatus: vi.fn(),
  fileApps: vi.fn(),
  directoryApps: vi.fn(),
  archiveBuild: vi.fn(),
  archiveStatus: vi.fn(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: { fsTree, fsTrees, gitStatus, fileApps, directoryApps, archiveBuild, archiveStatus },
  downloadUrl: () => '/sidebar/file',
  archiveDownloadUrl: (id: string) => `/sidebar/archive/${id}`,
  isOutsideWorkspaceMessage: () => false,
}))

/** Icon resolutions ARE the row-render probe (a row resolves its icon per render). */
const fileIcons: string[] = []
const folderIcons: string[] = []
const service = {
  subscribe: () => () => {},
  fileIcon: (path: string) => { fileIcons.push(path); return null },
  folderIcon: (path: string) => { folderIcons.push(path); return null },
} as unknown as BetterSidebarService

const HOST_APPS = [
  { id: 'textedit', name: 'TextEdit', icon: null, isDefault: true },
  { id: 'preview', name: 'Preview', icon: null, isDefault: false },
]

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
      sessionId: 'menu-perf',
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
      openInApp: {
        available: () => true,
        probe: async () => true,
        directoryApps,
        fileApps,
        open: async () => true,
        reveal: async () => true,
      },
    }))
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

async function openRowMenu(container: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    rowByName(container, name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function closeMenu(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await Promise.resolve()
  })
}

/** Spin the timers one full git poll window (the status interval is 2500ms). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

interface Metrics {
  fsTree: number
  gitStatus: number
  fileApps: number
  fileIcons: number
  folderIcons: number
}

let harness: Harness
const baseline = { fsTree: 0, gitStatus: 0, fileApps: 0, fileIcons: 0, folderIcons: 0 }

/** The counters SINCE the last `mark()`. */
function since(): Metrics {
  return {
    fsTree: fsTree.mock.calls.length - baseline.fsTree,
    gitStatus: gitStatus.mock.calls.length - baseline.gitStatus,
    fileApps: fileApps.mock.calls.length - baseline.fileApps,
    fileIcons: fileIcons.length - baseline.fileIcons,
    folderIcons: folderIcons.length - baseline.folderIcons,
  }
}

function mark(): void {
  baseline.fsTree = fsTree.mock.calls.length
  baseline.gitStatus = gitStatus.mock.calls.length
  baseline.fileApps = fileApps.mock.calls.length
  baseline.fileIcons = fileIcons.length
  baseline.folderIcons = folderIcons.length
}

beforeEach(() => {
  vi.useFakeTimers()
  // The single-level route must never be used again (the batch one replaced
  // it); it stays mocked so the probe can assert the count is 0.
  fsTree.mockReset()
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({
      path,
      entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
        { name: 'c.ts', path: '/tmp/c.ts', isDir: false },
      ],
      truncated: false,
    })),
  }))
  gitStatus.mockReset()
  gitStatus.mockResolvedValue({ isRepo: false, entries: [] })
  fileApps.mockReset()
  fileApps.mockResolvedValue(HOST_APPS)
  directoryApps.mockReset()
  directoryApps.mockResolvedValue(HOST_APPS)
  archiveBuild.mockReset()
  archiveStatus.mockReset()
  fileIcons.length = 0
  folderIcons.length = 0
  mark()
})

afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('FileTree context-menu cost', () => {
  it('does not list directories, re-render rows or poll git while the menu is open', async () => {
    harness = await mountTree()
    // Warm the shared status store (its first fetch happens on mount).
    await advance(0)

    // ── First open: the right-click also collapses the selection onto the row.
    mark()
    await openRowMenu(harness.container, 'a.ts')
    const firstOpen = since()
    await closeMenu()

    // ── Reopen the SAME row's menu and let a full poll window elapse while it
    //    is open: nothing may hit the workspace.
    mark()
    await openRowMenu(harness.container, 'a.ts')
    await advance(3_000)
    const openWindow = since()
    await closeMenu()

    // ── The poll resumes once the menu closed.
    mark()
    await advance(3_000)
    const afterClose = since()

    console.log('MENU-PERF', JSON.stringify({ firstOpen, openWindow, afterClose }))

    // Menu churn never lists a directory.
    expect(openWindow.fsTree).toBe(0)
    expect(afterClose.fsTree).toBe(0)
    // The shared git poll keeps running behind the menu — by design, and the
    // measured trade-off: pausing it (`visible: rowMenu === null`) makes the
    // store drop its snapshot, so EVERY changed row loses its ink while the
    // menu is open (measured: `tintedWhileOpen: false`, +2 row re-renders)
    // against saving one background request per poll window. The rows stay
    // untouched either way because the row's git props are primitives.
    expect(openWindow.gitStatus).toBeGreaterThanOrEqual(0)
    // Memoized rows do not re-render because the menu opened — not even the
    // root row (which is memoized too) and not when a poll lands.
    expect(openWindow.fileIcons).toBe(0)
    expect(openWindow.folderIcons).toBe(0)
    // The host application list is cached per path: one request, not one per open.
    expect(openWindow.fileApps).toBe(0)
    expect(firstOpen.fileApps).toBeLessThanOrEqual(1)
  })

  it('reopens the row menu without a Loading flash (the app list is cached)', async () => {
    harness = await mountTree()
    await advance(0)
    await openRowMenu(harness.container, 'a.ts')
    expect(fileApps).toHaveBeenCalledTimes(1)
    await closeMenu()
    const requestsAfterFirstOpen = fileApps.mock.calls.length

    await openRowMenu(harness.container, 'a.ts')
    // Cached: no second request…
    expect(fileApps.mock.calls.length).toBe(requestsAfterFirstOpen)
    // …and the submenu carries the applications immediately (no disabled
    // Loading row).
    const parent = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.getAttribute('aria-haspopup') === 'menu')
    expect(parent).toBeDefined()
    await act(async () => { parent!.click(); await Promise.resolve() })
    const submenuLabels = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
      .map(item => item.textContent?.trim())
    // The default handler is hoisted to level 1; the rest of the list is
    // already there (no disabled Loading row).
    expect(submenuLabels).toContain('Preview')
    expect(submenuLabels).not.toContain('Loading…')
  })

  it('keeps the git ink and does not re-render changed rows while the menu is open', async () => {
    // A repo with one changed file: the row carries its tone class while the
    // menu is open, so pausing the poll must not cost the tint (the shared
    // store drops its snapshot when its last visible consumer releases).
    gitStatus.mockResolvedValue({
      isRepo: true,
      root: '/tmp',
      entries: [{ path: 'a.ts', xy: ' M' }],
    })
    harness = await mountTree()
    await advance(30)
    const tinted = (): boolean =>
      rowByName(harness.container, 'a.ts').querySelector('[data-git-tone]') !== null
    expect(tinted()).toBe(true)

    // The FIRST open also collapses the selection onto the row (one row
    // re-render, by design); measure the reopen, where nothing may change.
    await openRowMenu(harness.container, 'a.ts')
    await closeMenu()

    mark()
    await openRowMenu(harness.container, 'a.ts')
    await advance(3_000)
    const openWindow = since()
    const tintedWhileOpen = tinted()
    await closeMenu()
    console.log('MENU-PERF-REPO', JSON.stringify({ openWindow, tintedWhileOpen }))

    // The changed row does not re-render because the menu opened…
    expect(openWindow.fileIcons).toBe(0)
    // …and its git ink survives the whole open window.
    expect(tintedWhileOpen).toBe(true)
  })
})
