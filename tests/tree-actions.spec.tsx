/**
 * External file-tree actions (features `treeToolbarActions` / `treeDocks`):
 * the registry half, and the panel that draws the buttons and mounts the
 * docks — placement, `when` filtering, the shared context, the one-at-a-time
 * run guard, and a failure landing in the tree's error strip.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import {
  createBetterSidebarService,
  type TreeDockDescriptor,
  type TreeToolbarActionDescriptor,
} from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

// The panel's tree mounts through the host seams; a one-file answer keeps the
// rows plain and the git-status store non-repo.
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({
        path,
        entries: [{ name: 'a.ts', path: `${path}/a.ts`, isDir: false }],
        truncated: false,
      })),
    }),
    fsSearch: async () => ({ matches: ['a.ts'], dirs: [], truncated: false }),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the panel's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** One external toolbar action with test-friendly defaults. */
function action(id: string, overrides: Partial<TreeToolbarActionDescriptor> = {}): TreeToolbarActionDescriptor {
  return { id, label: id.toUpperCase(), onAction: () => {}, ...overrides }
}

/** One external dock with test-friendly defaults. */
function dock(id: string, overrides: Partial<TreeDockDescriptor> = {}): TreeDockDescriptor {
  return { id, component: () => null, ...overrides }
}

describe('tree action registries', () => {
  it('declare the features and start empty', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(service.features).toContain('treeToolbarActions')
    expect(service.features).toContain('treeDocks')
    expect(service.getTreeToolbarActions()).toEqual([])
    expect(service.getTreeDocks()).toEqual([])
  })

  it('answer in render order: order ascending, then registration order', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeToolbarAction(action('late', { order: 5 }))
    service.registerTreeToolbarAction(action('early', { order: -5 }))
    service.registerTreeToolbarAction(action('default'))
    service.registerTreeToolbarAction(action('default-second'))
    expect(service.getTreeToolbarActions().map(entry => entry.id)).toEqual(
      ['early', 'default', 'default-second', 'late'],
    )
    service.registerTreeDock(dock('second', { order: 2 }))
    service.registerTreeDock(dock('first', { order: -2 }))
    expect(service.getTreeDocks().map(entry => entry.id)).toEqual(['first', 'second'])
  })

  it('refuse a duplicate id', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeToolbarAction(action('same'))
    expect(() => service.registerTreeToolbarAction(action('same')))
      .toThrow(/tree toolbar action "same" already registered/u)
    service.registerTreeDock(dock('same'))
    expect(() => service.registerTreeDock(dock('same')))
      .toThrow(/tree dock "same" already registered/u)
  })

  it('a stale disposer cannot remove a newer registration', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const disposeFirst = service.registerTreeToolbarAction(action('same'))
    disposeFirst()
    const replacement = action('same')
    service.registerTreeToolbarAction(replacement)
    disposeFirst()
    expect(service.getTreeToolbarActions()).toEqual([replacement])
    const disposeDock = service.registerTreeDock(dock('same'))
    disposeDock()
    const dockReplacement = dock('same')
    service.registerTreeDock(dockReplacement)
    disposeDock()
    expect(service.getTreeDocks()).toEqual([dockReplacement])
  })

  it('disposal empties the registries for the panel', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const disposeAction = service.registerTreeToolbarAction(action('gone'))
    const disposeDock = service.registerTreeDock(dock('gone'))
    expect(service.getTreeToolbarActions()).toHaveLength(1)
    expect(service.getTreeDocks()).toHaveLength(1)
    disposeAction()
    disposeDock()
    expect(service.getTreeToolbarActions()).toEqual([])
    expect(service.getTreeDocks()).toEqual([])
  })
})

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

function mountPanel(
  service: ReturnType<typeof createBetterSidebarService>,
  overrides: Partial<ComponentProps<typeof TreePanel>> = {},
): Harness {
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
      service,
      ...overrides,
    }))
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The external buttons in the search row, in DOM order. */
function treeActionButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[data-dsh-tree-action]')]
}

function treeActionButton(container: HTMLElement, id: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[data-dsh-tree-action="${id}"]`)
  if (button === null) throw new Error(`tree action ${id} not rendered`)
  return button
}

describe('treeToolbarActions in the file tree', () => {
  it('draws actions right of the upload controls, in order, and hands over the context', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const run = vi.fn()
    service.registerTreeToolbarAction(action('late', { label: 'LATE', order: 5 }))
    service.registerTreeToolbarAction(action('early', {
      label: () => 'EARLY',
      title: () => 'Early tooltip',
      onAction: run,
      order: -5,
    }))
    const page = mountPanel(service)
    try {
      await act(async () => {})
      const buttons = treeActionButtons(page.container)
      expect(buttons.map(button => button.getAttribute('data-dsh-tree-action'))).toEqual(['early', 'late'])
      expect(buttons[0]!.getAttribute('aria-label')).toBe('EARLY')
      expect(buttons[0]!.getAttribute('title')).toBe('Early tooltip')
      // The row order is search → refresh → sort → upload files → upload
      // folder → external actions; the external cells are the last buttons.
      const rowButtons = [...page.container.querySelectorAll<HTMLButtonElement>('[class*="editorTreeSearch"] button')]
      expect(rowButtons.slice(-2).map(button => button.getAttribute('data-dsh-tree-action'))).toEqual(['early', 'late'])
      act(() => { treeActionButton(page.container, 'early').click() })
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0]![0]).toMatchObject({ sessionId: 's1', root: '/tmp', visible: true })
      expect(typeof (run.mock.calls[0]![0] as { now: () => number }).now()).toBe('number')
    }
    finally {
      page.unmount()
    }
  })

  it('an action registered AFTER the mount still appears', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const page = mountPanel(service)
    try {
      await act(async () => {})
      act(() => { service.registerTreeToolbarAction(action('late', { label: '后到' })) })
      expect(treeActionButton(page.container, 'late').getAttribute('aria-label')).toBe('后到')
    }
    finally {
      page.unmount()
    }
  })

  it('`when: false` hides the button and a throwing predicate drops only itself', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeToolbarAction(action('never', { label: 'NEVER', when: () => false }))
    service.registerTreeToolbarAction(action('boom', {
      label: 'BOOM',
      when: () => { throw new Error('predicate') },
    }))
    service.registerTreeToolbarAction(action('always', { label: 'ALWAYS' }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = mountPanel(service)
    try {
      await act(async () => {})
      expect(treeActionButtons(page.container).map(button => button.getAttribute('aria-label'))).toEqual(['ALWAYS'])
      expect(consoleError).toHaveBeenCalledWith(
        '[dsh-better-sidebar] tree toolbar predicate error:',
        expect.any(Error),
      )
    }
    finally {
      page.unmount()
      consoleError.mockRestore()
    }
  })

  it('`pressed` / `disabled` are asked per render and reach the button', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeToolbarAction(action('toggle', {
      label: 'TOGGLE',
      pressed: context => context.sessionId === 's1',
      disabled: () => true,
    }))
    const page = mountPanel(service)
    try {
      await act(async () => {})
      const button = treeActionButton(page.container, 'toggle')
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(button.disabled).toBe(true)
      expect(button.className).toContain('editorTreeToggleActive')
    }
    finally {
      page.unmount()
    }
  })

  it('renders a returned glyph component at 14px', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeToolbarAction(action('glyph', {
      label: 'GLYPH',
      icon: () => (props: { size: number }) => createElement('svg', { 'data-glyph-size': props.size }),
    }))
    const page = mountPanel(service)
    try {
      await act(async () => {})
      expect(page.container.querySelector('[data-glyph-size="14"]')).not.toBeNull()
    }
    finally {
      page.unmount()
    }
  })

  it('ignores a second press while the first async action is still in flight', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    let release: (() => void) | undefined
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    service.registerTreeToolbarAction(action('async', { label: 'ASYNC', onAction: run }))
    service.registerTreeToolbarAction(action('other', { label: 'OTHER' }))
    const page = mountPanel(service)
    try {
      await act(async () => {})
      act(() => { treeActionButton(page.container, 'async').click() })
      act(() => { treeActionButton(page.container, 'async').click() })
      expect(run).toHaveBeenCalledTimes(1)
      // One action runs at a time: the sibling cell is disabled meanwhile.
      expect(treeActionButton(page.container, 'other').disabled).toBe(true)
      await act(async () => { release?.(); await Promise.resolve() })
      expect(treeActionButton(page.container, 'other').disabled).toBe(false)
      act(() => { treeActionButton(page.container, 'async').click() })
      expect(run).toHaveBeenCalledTimes(2)
    }
    finally {
      page.unmount()
    }
  })

  it('a failed run reports in the error strip, not the console', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeToolbarAction(action('fail', {
      label: 'FAIL',
      onAction: () => { throw new Error('启动失败：端口被占用') },
    }))
    service.registerTreeToolbarAction(action('reject', {
      label: 'REJECT',
      onAction: () => Promise.reject(new Error('still running')),
    }))
    const page = mountPanel(service)
    try {
      await act(async () => {})
      act(() => { treeActionButton(page.container, 'fail').click() })
      expect(page.container.querySelector('[data-dsh-tree-action-error]')?.textContent)
        .toBe('启动失败：端口被占用')
      await act(async () => {
        treeActionButton(page.container, 'reject').click()
        await Promise.resolve()
      })
      expect(page.container.querySelector('[data-dsh-tree-action-error]')?.textContent).toBe('still running')
    }
    finally {
      page.unmount()
    }
  })

  it('does not run while the owning tab is parked (`visible: false`)', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const run = vi.fn()
    service.registerTreeToolbarAction(action('hidden', { label: 'HIDDEN', onAction: run }))
    const page = mountPanel(service, { visible: false })
    try {
      await act(async () => {})
      const button = treeActionButton(page.container, 'hidden')
      expect(button.getAttribute('aria-label')).toBe('HIDDEN')
      act(() => { button.click() })
      expect(run).not.toHaveBeenCalled()
    }
    finally {
      page.unmount()
    }
  })
})

describe('treeDocks under the file list', () => {
  it('mounts docks in order under the tree with the shared context', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeDock(dock('second', {
      order: 2,
      component: props => createElement('div', {
        'data-testid': 'dock',
        'data-id': 'second',
        'data-session': props.sessionId,
        'data-root': props.root,
        'data-visible': String(props.visible),
      }),
    }))
    service.registerTreeDock(dock('first', {
      order: -2,
      component: () => createElement('div', { 'data-testid': 'dock', 'data-id': 'first' }),
    }))
    const page = mountPanel(service)
    try {
      await act(async () => {})
      const wrapper = page.container.querySelector<HTMLElement>('[data-dsh-tree-dock]')
      expect(wrapper).not.toBeNull()
      const docks = [...wrapper!.querySelectorAll<HTMLElement>('[data-testid="dock"]')]
      expect(docks.map(element => element.getAttribute('data-id'))).toEqual(['first', 'second'])
      expect(docks[1]!.getAttribute('data-session')).toBe('s1')
      expect(docks[1]!.getAttribute('data-root')).toBe('/tmp')
      expect(docks[1]!.getAttribute('data-visible')).toBe('true')
    }
    finally {
      page.unmount()
    }
  })

  it('a dock registered AFTER the mount still appears; disposal removes it', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const page = mountPanel(service)
    try {
      await act(async () => {})
      expect(page.container.querySelector('[data-dsh-tree-dock]')).toBeNull()
      let dispose: () => void
      act(() => {
        dispose = service.registerTreeDock(dock('late', {
          component: () => createElement('div', { 'data-testid': 'dock' }),
        }))
      })
      expect(page.container.querySelector('[data-dsh-tree-dock] [data-testid="dock"]')).not.toBeNull()
      act(() => { dispose() })
      expect(page.container.querySelector('[data-dsh-tree-dock]')).toBeNull()
    }
    finally {
      page.unmount()
    }
  })

  it('`when: false` skips a dock and a throwing predicate drops only itself', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeDock(dock('never', {
      when: () => false,
      component: () => createElement('div', { 'data-id': 'never' }),
    }))
    service.registerTreeDock(dock('boom', {
      when: () => { throw new Error('dock predicate') },
      component: () => createElement('div', { 'data-id': 'boom' }),
    }))
    service.registerTreeDock(dock('always', {
      component: () => createElement('div', { 'data-testid': 'dock', 'data-id': 'always' }),
    }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = mountPanel(service)
    try {
      await act(async () => {})
      expect([...page.container.querySelectorAll('[data-testid="dock"]')].map(el => el.getAttribute('data-id')))
        .toEqual(['always'])
      expect(consoleError).toHaveBeenCalledWith(
        '[dsh-better-sidebar] tree dock predicate error:',
        expect.any(Error),
      )
    }
    finally {
      page.unmount()
      consoleError.mockRestore()
    }
  })

  it('docks under the tree stay above the upload overlay slot', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTreeDock(dock('console', {
      component: () => createElement('div', { 'data-testid': 'dock' }),
    }))
    const page = mountPanel(service)
    try {
      await act(async () => {})
      const wrapper = page.container.querySelector('[data-dsh-tree-dock]')!
      const tree = page.container.querySelector('[class*="editorTree"]')
      expect(tree).not.toBeNull()
      // The dock wrapper follows the tree's body in document order.
      expect(tree!.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    finally {
      page.unmount()
    }
  })
})