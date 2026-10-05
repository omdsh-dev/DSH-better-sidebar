/**
 * The files panel's search surface and level-cache life-cycle:
 *
 * - Typing a query parks the tree (`hidden`) instead of unmounting it, so
 *   clearing the box restores the SAME level cache — `fs.tree` is not called
 *   again (the old conditional render dropped the tree and refetched the
 *   whole visible set on every query change).
 * - The refresh affordance wipes the cache and reloads concurrently, and a
 *   response from the previous generation is DROPPED even when it lands last.
 * - A level the host truncated says so instead of silently showing a partial
 *   directory.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the panel's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

interface Listing {
  path: string
  entries: { name: string; path: string; isDir: boolean }[]
  truncated: boolean
}

/** The default host answer: one file at /tmp. */
function defaultListing(path: string): Listing {
  return { path, entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }], truncated: false }
}

const { fsTrees, fsSearch } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => defaultListing(path)) })),
  fsSearch: vi.fn(async () => ({ matches: ['a.ts'], truncated: false })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsSearch,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

function mountPanel(): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TreePanel, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
    }))
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/**
 * The tree surface: the body that carries row-name spans (the search results
 * panel is a body too, but its rows are plain buttons with no name span).
 * Finding it while parked is itself the "still mounted" probe.
 */
function treeBody(container: HTMLElement): HTMLElement {
  const body = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el.querySelector('[class*="explorerName"]') !== null)
  if (body === undefined) throw new Error('tree body not mounted')
  return body
}

function resultsBody(container: HTMLElement): HTMLElement {
  const tree = treeBody(container)
  const body = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el !== tree)
  if (body === undefined) throw new Error('results body not mounted')
  return body
}

/** Type a query the React way and let the 300ms debounce elapse. */
async function search(container: HTMLElement, query: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await new Promise<void>(resolve => { window.setTimeout(resolve, 350) }) })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => defaultListing(path)) }))
  fsSearch.mockClear()
})

describe('TreePanel search keeps the tree mounted', () => {
  it('parks the tree instead of unmounting it, so clearing the query keeps the level cache', async () => {
    harness = mountPanel()
    await act(async () => {})
    expect(fsTrees).toHaveBeenCalledTimes(1)
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(false)
    expect(harness.container.textContent).toContain('a.ts')

    await search(harness.container, 'a')
    expect(fsSearch).toHaveBeenCalledTimes(1)
    // The tree is still in the document — just parked.
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(true)
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(false)
    expect(resultsBody(harness.container).textContent).toContain('a.ts')

    await search(harness.container, '')
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(false)
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(true)
    // No second listing: the cache (and the expansion state) survived.
    expect(fsTrees).toHaveBeenCalledTimes(1)
  })
})

describe('TreePanel refresh and truncated levels', () => {
  it('drops a level response that lands after the cache was wiped', async () => {
    // The FIRST listing never settles until the test resolves it; the refresh
    // click starts the second one, which answers immediately.
    let resolveStale: (result: { levels: Listing[] }) => void = () => {}
    fsTrees.mockImplementationOnce(async () => await new Promise<{ levels: Listing[] }>(resolve => { resolveStale = resolve }))
    harness = mountPanel()
    await act(async () => {})
    // The pending level shows nothing yet (its rows are not known).
    expect(harness.container.textContent).not.toContain('a.ts')

    // Manual refresh: cache wiped, new generation, concurrent re-list.
    const refresh = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!
    await act(async () => {
      refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fsTrees).toHaveBeenCalledTimes(2)
    expect(harness.container.textContent).toContain('a.ts')

    // The stale first answer arrives LAST and must be discarded.
    await act(async () => {
      resolveStale({ levels: [{ path: '/tmp', entries: [{ name: 'stale.ts', path: '/tmp/stale.ts', isDir: false }], truncated: false }] })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.container.textContent).not.toContain('stale.ts')
    expect(harness.container.textContent).toContain('a.ts')
  })

  it('surfaces a truncated level instead of hiding it', async () => {
    fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }], truncated: true })),
    }))
    harness = mountPanel()
    await act(async () => {})
    const notice = [...harness.container.querySelectorAll<HTMLElement>('[data-kind="hint"]')]
      .find(el => el.textContent?.includes('too many entries'))
    expect(notice).toBeDefined()
  })
})
