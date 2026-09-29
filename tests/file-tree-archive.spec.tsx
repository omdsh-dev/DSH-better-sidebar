/**
 * FileTree "zip and download" over the host's ASYNC archive route.
 *
 * The menu row starts a job (`api.archiveBuild`), the tree polls
 * `api.archiveStatus` while it builds and shows the `zipProgress` line
 * (`done/total` + percentage), then a `ready` status downloads
 * `api.archiveDownloadUrl(id)` as a blob and saves it through a hidden
 * `<a download={name}>`. Every failure path — build rejection, a status
 * `error` state, a status rejection, the download's HTTP envelope — lands in
 * the error strip with `zipFailed`, and a repeated pick while one job runs
 * never starts a second job.
 *
 * Appearance gates stay as they were: ≥2 selected rows archive together, a
 * LONE directory archives its own subtree, a lone FILE shows no archive row
 * (the plain download row already covers it).
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { archiveBuild, archiveStatus, fetchMock } = vi.hoisted(() => ({
  archiveBuild: vi.fn(),
  archiveStatus: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
      ], truncated: false })),
    }),
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about the archive row).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  // The archive API is a set of standalone module exports (like downloadUrl),
  // not methods on the `api` object.
  archiveBuild,
  archiveStatus,
  archiveDownloadUrl: (_scope: unknown, id: string) => `/sidebar/archive/${id}`,
  isOutsideWorkspaceMessage: () => false,
}))

/** jsdom implements neither object-URL helper; these ARE the download probe. */
const createdUrls: Blob[] = []
const revokedUrls: string[] = []
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      createdUrls.push(blob)
      return `blob:mock-${createdUrls.length}`
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => { revokedUrls.push(url) },
  })
})

/** The poll cadence the tree uses; advancing less than this must not poll. */
const POLL_MS = 250

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
    }))
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function click(el: Element, init: MouseEventInit = {}): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
}

function rightClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  })
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent ?? '')
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem not found: ${label}`)
  act(() => { item.click() })
}

/** The progress line (a `Notice kind="loading"` live region). */
function progressLine(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-kind="loading"]')
}

/** Flush the pending promise chain (build / status / download). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Let the poll timer fire and its promise chain settle. */
async function poll(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(POLL_MS)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** A `ready` status row. */
function readyStatus(done: number, total: number): {
  state: 'ready'; done: number; total: number; bytes: number
} {
  return { state: 'ready', done, total, bytes: 128 }
}

let harness: Harness
/** The anchors whose click() ran, as `href|download`. */
const downloads: string[] = []
const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement): void {
  downloads.push(`${this.getAttribute('href') ?? ''}|${this.download}`)
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    blob: async () => new Blob(['zip-bytes'], { type: 'application/zip' }),
  } as unknown as Response)
  archiveBuild.mockReset()
  archiveBuild.mockResolvedValue({ id: 'job-1', entries: 2 })
  archiveStatus.mockReset()
  archiveStatus.mockResolvedValue(readyStatus(2, 2))
  downloads.length = 0
  createdUrls.length = 0
  revokedUrls.length = 0
  clickSpy.mockClear()
})

afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('FileTree zip and download', () => {
  it('starts a job, shows done/total progress, then downloads the ready archive', async () => {
    // The first status is held open so the "build phase" (total known, no
    // progress yet) is observable: the poller runs its first tick immediately.
    let releaseStatus: (status: { state: 'building'; done: number; total: number; bytes: number }) => void = () => {}
    archiveStatus
      .mockImplementationOnce(async () => await new Promise<{ state: 'building'; done: number; total: number; bytes: number }>(resolve => { releaseStatus = resolve }))
      .mockResolvedValueOnce(readyStatus(2, 2))
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    rightClick(rowByName(harness.container, 'b.ts'))
    expect(menuLabels()).toContain('Zip and download (2 items)')
    clickMenuitem('Zip and download (2 items)')
    await flush()

    // The job was started for the whole selection…
    expect(archiveBuild).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp/a.ts', '/tmp/b.ts'], 'archive.zip')
    // …the build phase shows the total it already knows…
    expect(progressLine(harness.container)?.textContent).toBe('Archiving 0/2 · 0%')
    // …the first poll advances the line…
    await act(async () => {
      releaseStatus({ state: 'building', done: 1, total: 2, bytes: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(progressLine(harness.container)?.textContent).toBe('Archiving 1/2 · 50%')

    // …and the next poll reports ready: the download runs and the line clears.
    await poll()
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/sidebar/archive/job-1')
    expect(downloads).toEqual(['blob:mock-1|archive.zip'])
    expect(progressLine(harness.container)).toBeNull()
    // The object URL is released on the next task.
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(revokedUrls).toEqual(['blob:mock-1'])
  })

  it('archives a lone directory under its own name', async () => {
    archiveBuild.mockResolvedValue({ id: 'job-dir', entries: 3 })
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    expect(menuLabels()).toContain('Zip and download')
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    await flush()
    expect(archiveBuild).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp/sub'], 'sub.zip')
    expect(downloads).toEqual(['blob:mock-1|sub.zip'])
  })

  it('archives the workspace root row (a lone directory too)', async () => {
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'tmp'))
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    await flush()
    expect(archiveBuild).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp'], 'tmp.zip')
  })

  it('offers nothing for a lone FILE (the download row already covers it)', async () => {
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'a.ts'))
    expect(menuLabels()).toContain('Download')
    expect(menuLabels().some(label => label.startsWith('Zip and download'))).toBe(false)
    expect(archiveBuild).not.toHaveBeenCalled()
  })

  it('reports a build failure in the error strip', async () => {
    archiveBuild.mockRejectedValue(new Error('build refused'))
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: build refused')
    expect(progressLine(harness.container)).toBeNull()
    expect(archiveStatus).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('reports a status error state with the route message', async () => {
    archiveStatus.mockResolvedValue({ state: 'error', done: 1, total: 2, bytes: 0, error: 'archive too large' })
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: archive too large')
    expect(progressLine(harness.container)).toBeNull()
    expect(downloads).toEqual([])
  })

  it('reports a status request that rejects', async () => {
    archiveStatus.mockRejectedValue(new Error('status offline'))
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: status offline')
    expect(downloads).toEqual([])
  })

  it('reports a download refused by the route envelope', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ ok: false, error: { code: 'bad-request', message: 'archive would exceed 64 MB' } }),
    } as unknown as Response)
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    await flush()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: archive would exceed 64 MB')
    expect(downloads).toEqual([])
    expect(createdUrls).toEqual([])
  })

  it('falls back to the status when the download carries no JSON body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    await flush()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: HTTP 500')
    expect(downloads).toEqual([])
  })

  it('builds once while a job is in flight (double click guard)', async () => {
    let release: (job: { id: string; entries: number }) => void = () => {}
    archiveBuild.mockImplementation(async () => await new Promise<{ id: string; entries: number }>(resolve => { release = resolve }))
    // Stay in the building state until the test says otherwise.
    archiveStatus.mockResolvedValue({ state: 'building', done: 0, total: 1, bytes: 0 })
    harness = await mountTree()
    const pick = (): void => {
      rightClick(rowByName(harness.container, 'sub'))
      clickMenuitem('Zip and download')
    }
    pick()
    await flush()
    expect(archiveBuild).toHaveBeenCalledTimes(1)
    // The row is still reachable and a second pick must not start a second job.
    pick()
    await flush()
    expect(archiveBuild).toHaveBeenCalledTimes(1)
    expect(archiveStatus).not.toHaveBeenCalled()

    await act(async () => { release({ id: 'job-2', entries: 1 }) })
    await flush()
    expect(progressLine(harness.container)?.textContent).toBe('Archiving 0/1 · 0%')
    await poll()
    // Still building: the line stays and the guard still holds.
    expect(progressLine(harness.container)).not.toBeNull()
    pick()
    await flush()
    expect(archiveBuild).toHaveBeenCalledTimes(1)

    // Finish the job: the download runs, the line clears, the guard releases.
    archiveStatus.mockResolvedValue(readyStatus(1, 1))
    await poll()
    await flush()
    expect(downloads).toEqual(['blob:mock-1|sub.zip'])
    archiveBuild.mockResolvedValue({ id: 'job-3', entries: 1 })
    pick()
    await flush()
    expect(archiveBuild).toHaveBeenCalledTimes(2)
    await poll()
    await flush()
  })
})
