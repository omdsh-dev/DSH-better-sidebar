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
import { createElement, type ComponentProps } from 'react'
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
  fsSearch: vi.fn(async (): Promise<{ matches: string[]; dirs: string[]; truncated: boolean }> =>
    ({ matches: ['a.ts'], dirs: [], truncated: false })),
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

function mountPanel(overrides: Partial<ComponentProps<typeof TreePanel>> = {}): Harness {
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
      ...overrides,
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
  fsSearch.mockReset()
  fsSearch.mockImplementation(async () => ({ matches: ['a.ts'], dirs: [], truncated: false }))
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

describe('TreePanel directory hits navigate instead of opening', () => {
  /** The search rows, in list order (the tree's own rows are not buttons here). */
  function resultRows(container: HTMLElement): HTMLButtonElement[] {
    return [...resultsBody(container).querySelectorAll<HTMLButtonElement>('button[class*="editorSearchResult"]')]
  }

  it('expands a directory hit in the tree and never asks to open it as a file', async () => {
    fsSearch.mockResolvedValue({ matches: ['src', 'src/a.ts'], dirs: ['src'], truncated: false })
    const onToggle = vi.fn()
    const onOpenFile = vi.fn()
    harness = mountPanel({ onToggle, onOpenFile })
    await act(async () => {})
    await search(harness.container, 'src')

    const dirRow = resultRows(harness.container).find(row => row.textContent === 'src')!
    expect(dirRow.getAttribute('data-dsh-search-dir')).toBe('true')
    expect(resultRows(harness.container).find(row => row.textContent === 'src/a.ts')!
      .getAttribute('data-dsh-search-dir')).toBeNull()

    await act(async () => { dirRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // `fs.read` refuses a directory, so this row navigates instead of opening.
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(onToggle).toHaveBeenCalledWith('/tmp/src')
    // The query is cleared, so the tree (expanded at src) is what shows next.
    expect(harness.container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!.value).toBe('')
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(true)
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(false)
  })

  it('expands every ancestor of a nested hit, but only collapsed ones', async () => {
    fsSearch.mockResolvedValue({ matches: ['src/deep', 'src/deep/a.ts'], dirs: ['src/deep'], truncated: false })
    const onToggle = vi.fn()
    harness = mountPanel({ cwd: '/w/app', expanded: ['/w/app/src'], onToggle })
    await act(async () => {})
    await search(harness.container, 'deep')

    const dirRow = resultRows(harness.container).find(row => row.textContent === 'src/deep')!
    await act(async () => { dirRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // /w/app is the explorer root and /w/app/src is already open: only the hit
    // itself is toggled (a repeat toggle would COLLAPSE an open ancestor).
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('/w/app/src/deep')
  })

  it('still opens a file hit, leaving the expansion state untouched', async () => {
    fsSearch.mockResolvedValue({ matches: ['src', 'src/a.ts'], dirs: ['src'], truncated: false })
    const onToggle = vi.fn()
    const onOpenFile = vi.fn()
    harness = mountPanel({ onToggle, onOpenFile })
    await act(async () => {})
    await search(harness.container, 'src')

    const fileRow = resultRows(harness.container).find(row => row.textContent === 'src/a.ts')!
    await act(async () => { fileRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/src/a.ts')
    expect(onToggle).not.toHaveBeenCalled()
    // A file open keeps the results list up (only a navigation clears it).
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(false)
  })
})
