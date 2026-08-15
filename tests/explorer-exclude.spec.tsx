/**
 * Explorer exclude-pattern rendering specs (issue #18): rows whose NAME
 * matches an exclude pattern are hidden from the tree, live re-render when
 * the shared store prefs change, and the root row is never hidden by name
 * matching. The host fs.tree call is stubbed (the client reads entries
 * through the api object, swapped per test).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { api, type FsEntry } from '../src/client/api.ts'
import { ExplorerView } from '../src/client/ExplorerView.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import css from '../src/client/sidebar.module.css'

function listing(entries: FsEntry[]): { path: string; entries: FsEntry[]; truncated: boolean } {
  return { path: '/cwd', entries, truncated: false }
}

/** Mount `node` into a detached body container under React's act(). */
function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, unmount }
}

/** The rendered explorer row names (file/folder names, root row included). */
function rowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(`.${css.explorerName}`)).map(el => el.textContent ?? '')
}

const SAMPLE: FsEntry[] = [
  { name: 'Assets', path: '/cwd/Assets', isDir: true, hidden: false },
  { name: 'Player.meta', path: '/cwd/Player.meta', isDir: false, hidden: false },
  { name: 'Player.cs', path: '/cwd/Player.cs', isDir: false, hidden: false },
  { name: 'node_modules', path: '/cwd/node_modules', isDir: true, hidden: false },
  { name: 'README.md', path: '/cwd/README.md', isDir: false, hidden: false },
]

describe('ExplorerView exclude patterns', () => {
  const originalFsTree = api.fsTree
  afterEach(() => {
    api.fsTree = originalFsTree
    for (const el of document.querySelectorAll('body > div')) el.remove()
  })

  /** Render an explorer seeded with `exclude` prefs and the sample listing. */
  function renderWithExclude(exclude: string[], store?: SidebarStore): { container: HTMLDivElement; unmount: () => void; store: SidebarStore } {
    api.fsTree = vi.fn(async () => listing(SAMPLE))
    const s = store ?? createSidebarStore()
    s.setPrefs({ ...s.getPrefs(), explorerExclude: exclude })
    const { container, unmount } = mount(createElement(ExplorerView, {
      sessionId: 's1',
      cwd: '/cwd',
      store: s,
      expanded: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
    }))
    return { container, unmount, store: s }
  }

  it('shows every entry without exclude patterns', async () => {
    const { container, unmount } = renderWithExclude([])
    await act(async () => {})
    // The root row ('cwd') plus all five sample entries.
    expect(rowNames(container)).toEqual(['cwd', 'Assets', 'Player.meta', 'Player.cs', 'node_modules', 'README.md'])
    unmount()
  })

  it('hides file entries matching an exclude pattern', async () => {
    const { container, unmount } = renderWithExclude(['*.meta'])
    await act(async () => {})
    const names = rowNames(container)
    expect(names).not.toContain('Player.meta')
    expect(names).toContain('Player.cs')
    expect(names).toContain('Assets')
    unmount()
  })

  it('hides directories by exact name too', async () => {
    const { container, unmount } = renderWithExclude(['node_modules'])
    await act(async () => {})
    const names = rowNames(container)
    expect(names).not.toContain('node_modules')
    expect(names).toContain('Assets')
    unmount()
  })

  it('matches case-insensitively (README.MD vs *.md)', async () => {
    const { container, unmount } = renderWithExclude(['*.md'])
    await act(async () => {})
    const names = rowNames(container)
    expect(names).not.toContain('README.md')
    unmount()
  })

  it('re-renders live when the store prefs change', async () => {
    const store = createSidebarStore()
    const { container, unmount } = renderWithExclude([], store)
    await act(async () => {})
    expect(rowNames(container)).toContain('Player.meta')
    // A settings-page write lands in the store → the tree hides the row
    // without reopening or manual refresh.
    act(() => {
      store.setPrefs({ ...store.getPrefs(), explorerExclude: ['*.meta'] })
    })
    expect(rowNames(container)).not.toContain('Player.meta')
    expect(rowNames(container)).toContain('Player.cs')
    unmount()
  })
})
