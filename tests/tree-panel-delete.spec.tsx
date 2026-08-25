/** File-tree deletion: the context-menu action is destructive, requires a
 * confirmation dialog, refreshes the tree only after success, and notifies
 * the editor host so deleted paths cannot remain open in stale tabs. */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsDelete, fsTree } = vi.hoisted(() => ({
  fsDelete: vi.fn(async (_scope: unknown, path: string) => ({ path })),
  fsTree: vi.fn(async () => ({
    entries: [{
      name: 'delete-me.ts',
      path: '/workspace/delete-me.ts',
      isDir: false,
      hidden: false,
      isSymlink: false,
      broken: false,
    }],
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsDelete,
    fsTree,
    fsSearch: async () => ({ matches: [], truncated: false }),
  },
  downloadUrl: () => '/sidebar/file',
}))

describe('TreePanel file deletion', () => {
  let root: Root | undefined

  afterEach(() => {
    if (root !== undefined) act(() => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
    fsDelete.mockClear()
    fsTree.mockClear()
  })

  it('confirms before deleting, refreshes, and reports the deleted path', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onFileDeleted = vi.fn()
    await act(async () => {
      root!.render(createElement(TreePanel, {
        sessionId: 'delete-session',
        cwd: '/workspace',
        expanded: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        onFileDeleted,
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
    expect(onFileDeleted).toHaveBeenCalledWith('/workspace/delete-me.ts')
    expect(container.textContent).toContain('Deleted delete-me.ts')
    expect(fsTree).toHaveBeenCalledTimes(2)
  })
})
