/**
 * FileTree "zip and download" over the host's ASYNC archive route.
 *
 * The menu row starts a job (`api.archiveBuild(scope, paths, stem)` →
 * `{id, name, entries}`), the tree polls `api.archiveStatus` every 250ms while
 * the host's system `zip`/`tar` packs the selection into a temp file, and a
 * `ready` status clicks a plain `<a download href={archiveDownloadUrl}>` on the
 * route URL, which the browser streams straight to disk. The client names a
 * STEM and uses the FINAL name the host returned — the host appends the
 * extension of the tool it actually has (a tar-only host really does produce a
 * `.tar.gz`), so building the name locally would lie. Deliberately NOT
 * `fetch → blob → objectURL` any more: a Blob holds the whole archive in the
 * tab's memory, which is exactly what the host change removed. There is no
 * per-entry progress either (a child process reports none), so the strip shows
 * the plain `loading` line and nothing else.
 *
 * Every failure path lands in the error strip with `zipFailed`: a build
 * rejection, a status `error` state, a status rejection. The ONE exception is a
 * build refused with the wire code `unavailable` — neither `zip` nor `tar` is
 * installed — which renders `archiveToolMissing`, the sentence the user can act
 * on, instead of the host's English wire message. A repeated pick while one job
 * runs never starts a second job.
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
import { t } from '../src/client/locales.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { archiveBuild, archiveStatus, SidebarApiError } = vi.hoisted(() => {
  /** The wire error FileTree narrows on (`code === 'unavailable'`). */
  class SidebarApiError extends Error {
    constructor(readonly code: string, message: string) {
      super(message)
    }
  }
  return { archiveBuild: vi.fn(), archiveStatus: vi.fn(), SidebarApiError }
})

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
  SidebarApiError,
  isOutsideWorkspaceMessage: () => false,
}))

/** The poll cadence the tree uses; advancing less than this must not poll. */
const POLL_MS = 250

interface Harness {
  container: HTMLDivElement
  /** Render — or RE-render in place, as a session swap does. */
  show: (sessionId: string, cwd: string) => Promise<void>
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const show = async (sessionId: string, cwd: string): Promise<void> => {
    await act(async () => {
      root.render(createElement(FileTree, {
        sessionId,
        cwd,
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
  }
  await show('s1', '/tmp')
  return {
    container,
    show,
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

/** The packing line (a `Notice kind="loading"` live region) — the whole
 *  progress UI now: the host's zip/tar reports no per-entry counts. */
function progressLine(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-kind="loading"]')
}

/** Flush the pending promise chain (build / status / hand-off). */
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

/** A `ready` status row (`bytes` only — no `done`/`total` any more). */
function readyStatus(bytes = 128): { state: 'ready'; bytes: number } {
  return { state: 'ready', bytes }
}

let harness: Harness
/** The anchors whose click() ran, as `href|download`. */
const downloads: string[] = []
const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement): void {
  downloads.push(`${this.getAttribute('href') ?? ''}|${this.download}`)
})

beforeEach(() => {
  vi.useFakeTimers()
  archiveBuild.mockReset()
  archiveBuild.mockResolvedValue({ id: 'job-1', name: 'archive.zip', entries: 2 })
  archiveStatus.mockReset()
  archiveStatus.mockResolvedValue(readyStatus())
  downloads.length = 0
  clickSpy.mockClear()
})

afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('FileTree zip and download', () => {
  it('starts a job with a stem, shows the packing line, then downloads the ready archive', async () => {
    // The first status is held open so the packing phase is observable: the
    // poller runs its first tick immediately.
    let releaseStatus: (status: { state: 'building'; bytes: number }) => void = () => {}
    archiveStatus
      .mockImplementationOnce(async () => await new Promise<{ state: 'building'; bytes: number }>(resolve => { releaseStatus = resolve }))
      .mockResolvedValueOnce(readyStatus())
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    rightClick(rowByName(harness.container, 'b.ts'))
    expect(menuLabels()).toContain('Zip and download (2 items)')
    clickMenuitem('Zip and download (2 items)')
    await flush()

    // The job was started for the whole selection, named by a STEM: the host
    // picks the extension of the tool it has and answers with the final name.
    expect(archiveBuild).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp/a.ts', '/tmp/b.ts'], 'archive')
    // …the packing line is up while the job runs…
    expect(progressLine(harness.container)?.textContent).toBe(t('loading'))
    // …a first poll that is still `building` keeps it, with no counts to show…
    await act(async () => {
      releaseStatus({ state: 'building', bytes: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(progressLine(harness.container)?.textContent).toBe(t('loading'))

    // …and the next poll reports ready: the anchor hands the route URL to the
    // browser (which streams it to disk) and the line clears.
    await poll()
    await flush()
    expect(downloads).toEqual(['/sidebar/archive/job-1|archive.zip'])
    expect(progressLine(harness.container)).toBeNull()
    // The poll carries the session scope: the host requires BOTH keys on
    // `archive.status`, so a bare `{ id }` is refused with a 400.
    expect(archiveStatus).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, 'job-1')
  })

  it('archives a lone directory under its own stem, saved under the host name', async () => {
    // A tar-only host: it appends ITS extension, so the anchor's `download`
    // must be the returned name — a client-built `sub.zip` would be a lie.
    archiveBuild.mockResolvedValue({ id: 'job-dir', name: 'sub.tar.gz', entries: 3 })
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    expect(menuLabels()).toContain('Zip and download')
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    await flush()
    expect(archiveBuild).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp/sub'], 'sub')
    expect(downloads).toEqual(['/sidebar/archive/job-dir|sub.tar.gz'])
  })

  it('archives the workspace root row (a lone directory too)', async () => {
    archiveBuild.mockResolvedValue({ id: 'job-root', name: 'tmp.zip', entries: 5 })
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'tmp'))
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    await flush()
    expect(archiveBuild).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp'], 'tmp')
    expect(downloads).toEqual(['/sidebar/archive/job-root|tmp.zip'])
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

  it('explains a host with neither zip nor tar instead of echoing the wire message', async () => {
    // `unavailable` is the ONE code with its own sentence: "no archive command
    // is installed" is something the user can act on.
    archiveBuild.mockRejectedValue(new SidebarApiError('unavailable', 'spawn zip ENOENT'))
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    const alert = harness.container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain(t('archiveToolMissing'))
    expect(alert).not.toContain('spawn zip ENOENT')
    expect(progressLine(harness.container)).toBeNull()
    expect(archiveStatus).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('keeps the wire message for a build failure that is not `unavailable`', async () => {
    archiveBuild.mockRejectedValue(new SidebarApiError('bad-request', 'selection contains a socket'))
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: selection contains a socket')
    expect(progressLine(harness.container)).toBeNull()
    expect(downloads).toEqual([])
  })

  it('reports a status error state with the route message', async () => {
    archiveStatus.mockResolvedValue({ state: 'error', bytes: 0, error: 'archive too large' })
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

  it('hands a ready job to the download exactly once, and stops polling first', async () => {
    // The download route CONSUMES the task, so a second hand-off would either
    // click the anchor twice or read a 404 and paint `zipFailed` beside a file
    // that actually landed. The poller must therefore stop BEFORE the anchor
    // runs — the three extra intervals below are the proof that it has.
    archiveBuild.mockResolvedValue({ id: 'job-1', name: 'sub.zip', entries: 3 })
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await flush()
    await poll()
    await flush()
    expect(archiveStatus).toHaveBeenCalledTimes(1)
    expect(downloads).toEqual(['/sidebar/archive/job-1|sub.zip'])

    // Three more poll intervals: no second poll, no second download, and no
    // bogus failure strip.
    await poll()
    await poll()
    await poll()
    expect(archiveStatus).toHaveBeenCalledTimes(1)
    expect(downloads).toEqual(['/sidebar/archive/job-1|sub.zip'])
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('builds once while a job is in flight (double click guard)', async () => {
    let release: (job: { id: string; name: string; entries: number }) => void = () => {}
    archiveBuild.mockImplementation(async () => await new Promise<{ id: string; name: string; entries: number }>(resolve => { release = resolve }))
    // Stay in the building state until the test says otherwise.
    archiveStatus.mockResolvedValue({ state: 'building', bytes: 0 })
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

    await act(async () => { release({ id: 'job-2', name: 'sub.zip', entries: 1 }) })
    await flush()
    expect(progressLine(harness.container)?.textContent).toBe(t('loading'))
    await poll()
    // Still building: the line stays and the guard still holds.
    expect(progressLine(harness.container)).not.toBeNull()
    pick()
    await flush()
    expect(archiveBuild).toHaveBeenCalledTimes(1)

    // Finish the job: the download runs, the line clears, the guard releases.
    archiveStatus.mockResolvedValue(readyStatus())
    await poll()
    await flush()
    expect(downloads).toEqual(['/sidebar/archive/job-2|sub.zip'])
    archiveBuild.mockResolvedValue({ id: 'job-3', name: 'sub.zip', entries: 1 })
    pick()
    await flush()
    expect(archiveBuild).toHaveBeenCalledTimes(2)
    await poll()
    await flush()
    expect(downloads).toEqual(['/sidebar/archive/job-2|sub.zip', '/sidebar/archive/job-3|sub.zip'])
  })

  it('does not resurrect a build that was still starting when the scope changed', async () => {
    // The swap settles the archive. A build answering only afterwards used to
    // pump its job id back in, restarting the poller in a project that never
    // asked for a zip — and reporting the failure there.
    let resolveBuild!: (value: { id: string; name: string; entries: number }) => void
    archiveBuild.mockImplementationOnce(() => new Promise((resolve) => { resolveBuild = resolve }))

    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    rightClick(rowByName(harness.container, 'b.ts'))
    clickMenuitem('Zip and download (2 items)')
    expect(archiveBuild).toHaveBeenCalledTimes(1)

    // Another session takes over the same mounted instance.
    await harness.show('s2', '/tmp/beta')
    await flush()

    // The build answers only now.
    await act(async () => { resolveBuild({ id: 'job-stale', name: 'archive.zip', entries: 2 }) })
    await flush()
    await poll()

    expect(archiveStatus).not.toHaveBeenCalled()
    expect(progressLine(harness.container)).toBeNull()
  })
})
