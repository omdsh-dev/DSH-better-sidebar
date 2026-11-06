/**
 * External tab actions (feature `tabActions`): the registry half, and the
 * editor header that draws the buttons — placement, `when` filtering, the
 * run context, and a failure landing in the error strip instead of the
 * console.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService, type TabActionDescriptor } from '../src/client/service.ts'
import { createSidebarStore, type SidebarTab } from '../src/client/state.ts'

// The tree dock subscribes to the git-status poll and the editor reads files
// through these seams; a path-less tab fetches neither, but the module-level
// imports still resolve, so the answer shape stays honest.
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async () => ({ levels: [] }),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
    fsRead: async () => ({ content: 'const a = 1\n', size: 12 }),
    openExternal: async () => ({ started: true }),
  },
  archiveDownloadUrl: () => '/sidebar/archive?id=ar-1',
  downloadUrl: () => '/sidebar/file',
  mediaUrl: () => '/sidebar/file',
  archiveUrl: () => '/sidebar/archive',
  isOutsideWorkspaceMessage: () => false,
}))

import { setupReactAct } from './test-utils.ts'
setupReactAct()

let sessionSeq = 0
let sessionId: string
beforeEach(() => {
  localStorage.clear()
  sessionId = `tab-actions-session-${++sessionSeq}`
})

/** One external tab action with test-friendly defaults. */
function action(id: string, overrides: Partial<TabActionDescriptor> = {}): TabActionDescriptor {
  return { id, label: id.toUpperCase(), run: () => {}, ...overrides }
}

describe('tabActions registry', () => {
  it('declares the feature and starts empty', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(service.features).toContain('tabActions')
    expect(service.getTabActions()).toEqual([])
  })

  it('answers in render order: order ascending, then registration order', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTabAction(action('late', { order: 5 }))
    service.registerTabAction(action('early', { order: -5 }))
    service.registerTabAction(action('default'))
    service.registerTabAction(action('default-second'))
    expect(service.getTabActions().map(entry => entry.id)).toEqual(
      ['early', 'default', 'default-second', 'late'],
    )
  })

  it('refuses a duplicate id', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTabAction(action('same'))
    expect(() => service.registerTabAction(action('same'))).toThrow(/already registered/u)
  })

  it('a stale disposer cannot remove a newer registration', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const disposeFirst = service.registerTabAction(action('same'))
    disposeFirst()
    const replacement = action('same')
    service.registerTabAction(replacement)
    disposeFirst()
    expect(service.getTabActions()).toEqual([replacement])
  })

  it('disposal empties the registry for the header', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const dispose = service.registerTabAction(action('gone'))
    expect(service.getTabActions()).toHaveLength(1)
    dispose()
    expect(service.getTabActions()).toEqual([])
  })
})

/** A service + ctx over a path-less files window (no tree, no file read). */
function harness(): {
  service: ReturnType<typeof createBetterSidebarService>
  ctx: Context
  store: ReturnType<typeof createSidebarStore>
  tab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: tab => tab.path, component: () => null })
  store.setSession(sessionId)
  service.openTab({ type: 'editor', title: 'Files', meta: { treeOpen: false } })
  // A FILE tab (not the path-less window): split mode turns a path-less
  // window into the standalone explorer, which draws no editor header.
  const tab = (): SidebarTab => ({ id: 'tab-file', type: 'editor', title: 'a.ts', path: '/tmp/a.ts' })
  const ctx = {
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/tmp' } }, current: sessionId }) } },
  } as unknown as Context
  return { service, ctx, store, tab }
}

/** Mount the editor header for the harness' tab; returns the container. */
function mount(ctx: Context, store: ReturnType<typeof createSidebarStore>, tab: () => SidebarTab): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId },
      tab: tab(),
      expanded: [],
      revealed: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
  })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

describe('tabActions in the editor header', () => {
  it('draws a registered action and hands it the tab context', () => {
    const { service, ctx, store, tab } = harness()
    const run = vi.fn()
    service.registerTabAction(action('upload', { label: '上传到云端', run }))
    const page = mount(ctx, store, tab)
    try {
      const button = [...page.container.querySelectorAll('button')]
        .find(el => el.textContent === '上传到云端')
      expect(button).toBeDefined()
      act(() => { button!.click() })
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0]![0]).toMatchObject({ sessionId, path: '/tmp/a.ts', isDir: false, tabType: 'editor' })
    }
    finally {
      page.unmount()
    }
  })

  it('an action registered AFTER the mount still appears', () => {
    const { service, ctx, store, tab } = harness()
    const page = mount(ctx, store, tab)
    try {
      act(() => { service.registerTabAction(action('late', { label: '后到' })) })
      expect([...page.container.querySelectorAll('button')].some(el => el.textContent === '后到')).toBe(true)
    }
    finally {
      page.unmount()
    }
  })

  it('`when: false` hides the button and a throwing predicate drops only itself', () => {
    const { service, ctx, store, tab } = harness()
    service.registerTabAction(action('never', { label: 'NEVER', when: () => false }))
    service.registerTabAction(action('boom', { label: 'BOOM', when: () => { throw new Error('predicate') } }))
    service.registerTabAction(action('always', { label: 'ALWAYS' }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = mount(ctx, store, tab)
    try {
      const labels = [...page.container.querySelectorAll('button')].map(el => el.textContent)
      expect(labels).not.toContain('NEVER')
      expect(labels).not.toContain('BOOM')
      expect(labels).toContain('ALWAYS')
      expect(consoleError).toHaveBeenCalled()
    }
    finally {
      page.unmount()
      consoleError.mockRestore()
    }
  })

  it('a failed run reports in the error strip, not the console', async () => {
    const { service, ctx, store, tab } = harness()
    service.registerTabAction(action('fail', {
      label: 'FAIL',
      run: () => { throw new Error('上传失败：磁盘满了') },
    }))
    const page = mount(ctx, store, tab)
    try {
      const button = [...page.container.querySelectorAll('button')].find(el => el.textContent === 'FAIL')
      act(() => { button!.click() })
      expect(page.container.textContent).toContain('上传失败：磁盘满了')
    }
    finally {
      page.unmount()
    }
  })
})
