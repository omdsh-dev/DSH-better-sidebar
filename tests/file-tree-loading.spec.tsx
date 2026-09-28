/**
 * FileTree in-flight level rendering: the `{}` marker `loadDir` stores while a
 * listing request is running must draw the LOADING row, not an empty level.
 * Regression guard for the "expand a fresh folder flashes loading → collapsed
 * → entries" flicker: the marker used to fall into `entries ?? []` and render
 * zero rows for the whole request, so the folder looked collapsed again until
 * the response landed.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

interface Listing {
  entries: Array<{ name: string; path: string; isDir: boolean }>
}

/** One gate per requested directory: the test decides when each resolves. */
const gates = vi.hoisted(() => {
  const pending = new Map<string, { promise: Promise<Listing>; resolve: (listing: Listing) => void; reject: (error: Error) => void }>()
  const gate = (dir: string): Promise<Listing> => {
    const existing = pending.get(dir)
    if (existing !== undefined) return existing.promise
    let resolve!: (listing: Listing) => void
    let reject!: (error: Error) => void
    const promise = new Promise<Listing>((res, rej) => { resolve = res; reject = rej })
    pending.set(dir, { promise, resolve, reject })
    return promise
  }
  return { gate, pending }
})

vi.mock('../src/client/api.ts', async () => {
  // Keep every real export (FileTree also imports `isOutsideWorkspaceMessage`,
  // whose error branch this suite exercises); replace only `fsTree` so each
  // directory's listing resolves when the test decides.
  const actual = await vi.importActual<typeof import('../src/client/api.ts')>('../src/client/api.ts')
  return {
    ...actual,
    api: { ...actual.api, fsTree: (_scope: unknown, dir: string) => gates.gate(dir) },
  }
})

const DIR_ENTRY = (name: string): { name: string; path: string; isDir: boolean } =>
  ({ name, path: `/tmp/${name}`, isDir: true })

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(expanded: string[]): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
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
  })
  return { container, unmount: () => { act(() => { root.unmount() }) } }
}

/** Every rendered row (entry rows and the plain loading/error rows). */
function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
}

/** The row whose name span matches (entry rows carry `.explorerName`). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = rows(container).find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** Plain rows render no name span; the loading one shows exactly `t('loading')`. */
const loadingRows = (container: HTMLElement): HTMLElement[] =>
  rows(container)
    .filter(row => row.querySelector('[class*="explorerName"]') === null)
    .filter(row => row.textContent === t('loading'))

/** Resolve one directory's listing and let React flush the store. */
async function release(dir: string, listing: Listing): Promise<void> {
  await act(async () => { gates.pending.get(dir)!.resolve(listing) })
}

afterEach(() => {
  gates.pending.clear()
  document.body.innerHTML = ''
})

describe('FileTree in-flight level rendering', () => {
  it('keeps the loading row under a freshly expanded folder until its listing lands', async () => {
    const { container, unmount } = await mountTree(['/tmp/src'])
    // Root listing in flight: exactly one loading row under the root row
    // (the root row itself is drawn from cwd, not from the listing).
    expect(loadingRows(container)).toHaveLength(1)

    // Root lands; /tmp/src (expanded, still in flight) keeps ONE loading row
    // nested under the src row. Before the fix this frame rendered ZERO rows
    // under src — the "folder collapsed again" flash.
    await release('/tmp', { entries: [DIR_ENTRY('src'), { name: 'a.ts', path: '/tmp/a.ts', isDir: false }] })
    const loading = loadingRows(container)
    expect(loading).toHaveLength(1)
    expect(loading[0]!.parentElement).toBe(rowByName(container, 'src').parentElement)

    // The listing lands: rows swap in, no loading row remains.
    await release('/tmp/src', { entries: [{ name: 'inner.ts', path: '/tmp/src/inner.ts', isDir: false }] })
    expect(loadingRows(container)).toHaveLength(0)
    expect(() => rowByName(container, 'inner.ts')).not.toThrow()
    unmount()
  })

  it('renders a truly empty directory as zero rows, not a stuck loading row', async () => {
    const { container, unmount } = await mountTree(['/tmp/empty'])
    await release('/tmp', { entries: [DIR_ENTRY('empty')] })
    // In flight: the empty folder still shows its loading row.
    expect(loadingRows(container)).toHaveLength(1)
    // Landed as an empty listing: no loading row, and no child row below the
    // folder — it is the tree's last row.
    await release('/tmp/empty', { entries: [] })
    expect(loadingRows(container)).toHaveLength(0)
    const all = rows(container)
    expect(all[all.length - 1]).toBe(rowByName(container, 'empty'))
    unmount()
  })

  it('shows the error row when a listing fails', async () => {
    const { container, unmount } = await mountTree(['/tmp/boom'])
    await release('/tmp', { entries: [DIR_ENTRY('boom')] })
    await act(async () => { gates.pending.get('/tmp/boom')!.reject(new Error('boom')) })
    expect(loadingRows(container)).toHaveLength(0)
    const errorRow = rows(container)
      .filter(row => row.querySelector('[class*="explorerName"]') === null)
      .find(row => row.textContent === 'boom')
    expect(errorRow).toBeDefined()
    unmount()
  })
})
