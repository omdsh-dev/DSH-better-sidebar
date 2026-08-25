/** Deleted paths are removed from the editor workbench immediately, before
 * any missing-file read can replace the viewer with an ENOENT error. */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/client/TreePanel.tsx', async () => {
  const { createElement } = await import('react')
  return {
    TreePanel: (props: {
      onPathDeleted?: (target: { path: string; kind: 'file' | 'directory' | 'symlink' }) => void
    }) => createElement('button', {
      type: 'button',
      'data-testid': 'report-delete',
      onClick: () => {
        props.onPathDeleted?.({ path: '/tmp/deleted', kind: 'directory' })
      },
    }, 'report deletion'),
  }
})

describe('EditorHost deleted-path cleanup', () => {
  it('resets the hosting tab and closes other descendant tabs immediately', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: tab => tab.path, component: () => null })
    store.setSession('delete-session')
    service.openTab({
      type: 'editor', id: 'current-file', title: 'current.ts',
      path: '/tmp/deleted/current.ts', meta: { treeOpen: true },
    })
    service.openTab({ type: 'editor', id: 'other-file', title: 'other.ts', path: '/tmp/deleted/other.ts' })
    service.openTab({ type: 'editor', id: 'kept-file', title: 'kept.ts', path: '/tmp/kept.ts' })
    const currentTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === 'current-file')!
    const sessionsSnapshot = { byId: { 'delete-session': { cwd: '/tmp' } }, current: 'delete-session' }
    const ctx = {
      betterSidebar: service,
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    } as unknown as Context
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(EditorHost, {
        ctx,
        store,
        scope: { sessionId: 'delete-session', cwd: '/tmp' },
        tab: currentTab(),
        expanded: ['/tmp/deleted'],
        onToggleDir: () => {},
        onReferenceFile: () => {},
      }))
    })

    try {
      act(() => { container.querySelector<HTMLButtonElement>('[data-testid="report-delete"]')!.click() })
      const state = store.getSnapshot().state!
      const tabs = [...allLeaves(state.splits), ...allLeaves(state.bottomSplits)]
        .flatMap(leaf => leaf.tabs)
      expect(tabs.find(tab => tab.id === 'current-file')).toMatchObject({ title: 'Files', path: '' })
      expect(tabs.some(tab => tab.id === 'other-file')).toBe(false)
      expect(tabs.find(tab => tab.id === 'kept-file')?.path).toBe('/tmp/kept.ts')
      expect(store.getSnapshot().state!.expanded).not.toContain('/tmp/deleted')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
