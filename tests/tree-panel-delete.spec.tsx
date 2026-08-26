/** File-tree deletion: the context-menu action is destructive, requires a
 * confirmation dialog, refreshes the tree only after success, and notifies
 * the editor host so deleted paths cannot remain open in stale tabs. */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const entries = [
  {
    name: 'delete-me.ts', path: '/workspace/delete-me.ts', isDir: false,
    hidden: false, isSymlink: false, broken: false,
  },
  {
    name: 'delete-folder', path: '/workspace/delete-folder', isDir: true,
    hidden: false, isSymlink: false, broken: false,
  },
  {
    name: 'delete-link', path: '/workspace/delete-link', isDir: true,
    hidden: false, isSymlink: true, broken: false,
  },
]

const { fsDelete, fsTree } = vi.hoisted(() => ({
  fsDelete: vi.fn(async (_scope: unknown, path: string) => ({ path })),
  fsTree: vi.fn(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsDelete,
    fsTree,
    fsSearch: async () => ({ matches: [], truncated: false }),
  },
  downloadUrl: () => '/sidebar/file',
}))

describe('TreePanel entry deletion', () => {
  let root: Root | undefined

  beforeEach(() => {
    fsTree.mockReset()
    fsTree.mockResolvedValue({ entries })
  })

  afterEach(() => {
    if (root !== undefined) act(() => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
    fsDelete.mockClear()
    fsTree.mockClear()
  })

  it('confirms before deleting, refreshes, and reports the deleted path', async () => {
    let finishRefresh!: (listing: { entries: typeof entries }) => void
    const refreshed = new Promise<{ entries: typeof entries }>((resolve) => { finishRefresh = resolve })
    fsTree.mockResolvedValueOnce({ entries })
    fsTree.mockReturnValueOnce(refreshed)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onPathDeleted = vi.fn()
    await act(async () => {
      root!.render(createElement(TreePanel, {
        sessionId: 'delete-session',
        cwd: '/workspace',
        expanded: [],
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        onPathDeleted,
        initialScrollTop: 0,
        onScrollTopChange: () => {},
      }))
    })

    const row = container.querySelector<HTMLElement>('[role="button"][title="/workspace/delete-me.ts"]')!
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 30,
      }))
    })
    const menuDelete = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.textContent?.includes('Delete File'))
    expect(menuDelete).toBeDefined()
    act(() => { menuDelete!.click() })
    expect(fsDelete).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('This action cannot be undone')

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Delete File')
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm!.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fsDelete).toHaveBeenCalledWith(
      { sessionId: 'delete-session', cwd: '/workspace' },
      '/workspace/delete-me.ts',
    )
    expect(onPathDeleted).toHaveBeenCalledWith({ path: '/workspace/delete-me.ts', kind: 'file' })
    expect(container.textContent).toContain('Deleted delete-me.ts')
    expect(fsTree).toHaveBeenCalledTimes(2)
    // The old row is gone before the refreshed listing has returned, so it
    // cannot reopen a path that the host has already deleted.
    expect(container.querySelector('[title="/workspace/delete-me.ts"]')).toBeNull()

    await act(async () => {
      finishRefresh({ entries: entries.filter(entry => entry.path !== '/workspace/delete-me.ts') })
      await refreshed
    })
    expect(container.querySelector('[title="/workspace/delete-me.ts"]')).toBeNull()
  })

  it('ignores an obsolete directory response that finishes after refresh', async () => {
    let finishInitial!: (listing: { entries: typeof entries }) => void
    let finishRefresh!: (listing: { entries: typeof entries }) => void
    const initial = new Promise<{ entries: typeof entries }>((resolve) => { finishInitial = resolve })
    const refreshed = new Promise<{ entries: typeof entries }>((resolve) => { finishRefresh = resolve })
    fsTree.mockReset()
    fsTree.mockReturnValueOnce(initial)
    fsTree.mockReturnValueOnce(refreshed)

    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(TreePanel, {
        sessionId: 'refresh-race-session',
        cwd: '/workspace',
        expanded: [],
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        initialScrollTop: 0,
        onScrollTopChange: () => {},
      }))
    })

    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!
    await act(async () => { refresh.click() })
    expect(fsTree).toHaveBeenCalledTimes(2)

    await act(async () => {
      finishRefresh({ entries: [] })
      await refreshed
    })
    await act(async () => {
      finishInitial({ entries })
      await initial
    })
    expect(container.querySelector('[title="/workspace/delete-me.ts"]')).toBeNull()
  })

  it('warns that a folder deletion includes every nested entry', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onPathDeleted = vi.fn()
    await act(async () => {
      root!.render(createElement(TreePanel, {
        sessionId: 'delete-session',
        cwd: '/workspace',
        expanded: [],
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        onPathDeleted,
        initialScrollTop: 0,
        onScrollTopChange: () => {},
      }))
    })

    const folderRow = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find(row => row.querySelector('span')?.textContent === 'delete-folder')
    expect(folderRow).toBeDefined()
    act(() => {
      folderRow!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 30,
      }))
    })
    const menuDelete = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.textContent?.includes('Delete Folder'))
    expect(menuDelete).toBeDefined()
    act(() => { menuDelete!.click() })
    expect(fsDelete).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('and everything inside it')

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Delete Folder')
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm!.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fsDelete).toHaveBeenCalledWith(
      { sessionId: 'delete-session', cwd: '/workspace' },
      '/workspace/delete-folder',
    )
    expect(onPathDeleted).toHaveBeenCalledWith({ path: '/workspace/delete-folder', kind: 'directory' })
  })

  it('explains that deleting a symbolic link preserves its target', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(TreePanel, {
        sessionId: 'delete-session',
        cwd: '/workspace',
        expanded: [],
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        initialScrollTop: 0,
        onScrollTopChange: () => {},
      }))
    })

    const linkRow = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find(row => row.querySelector('span')?.textContent === 'delete-link')
    expect(linkRow).toBeDefined()
    act(() => {
      linkRow!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 30,
      }))
    })
    const menuDelete = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.textContent?.includes('Delete Symbolic Link'))
    expect(menuDelete).toBeDefined()
    act(() => { menuDelete!.click() })
    expect(document.body.textContent).toContain('Its target will not be deleted')
    expect(fsDelete).not.toHaveBeenCalled()
  })

  it('never offers deletion for the workspace root row', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(TreePanel, {
        sessionId: 'delete-session',
        cwd: '/workspace',
        expanded: [],
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        initialScrollTop: 0,
        onScrollTopChange: () => {},
      }))
    })

    const rootName = [...container.querySelectorAll('span')]
      .find(label => label.textContent === 'workspace')
    expect(rootName?.parentElement).not.toBeNull()
    act(() => {
      rootName!.parentElement!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 30,
      }))
    })
    const menuText = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map(item => item.textContent).join(' ')
    expect(menuText).not.toContain('Delete Folder')
    expect(menuText).not.toContain('Delete File')
  })
})
