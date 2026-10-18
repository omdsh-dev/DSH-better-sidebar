/**
 * TabBar / Workbench right-actions tests (TabDescriptor.rightActions, the
 * 'rightActions' capability):
 *
 * - The resolver's node renders inside the strip's right-actions area, which
 *   is the LAST child of the tab bar (after the + button; the panel's close
 *   control is reserved by the strip's padding, not a DOM sibling).
 * - The resolver receives the ACTIVE tab and the strip's paneId — with
 *   `single: false` and split panes, several instances of one type are open
 *   at once and every pane renders its own strip, so the toolbar must be
 *   able to target the right instance.
 * - A resolver that returns null/undefined (or an absent resolver) must not
 *   mount the wrapper AT ALL: the wrapper is a flex item, and an empty one
 *   would still change every existing tab strip's layout.
 * - The split tree forwards the resolver through NESTED splits: a split
 *   inside a split must still render each pane's own actions (regression:
 *   the recursive NodeView call once dropped getTabRightActions, so any
 *   pane below the first split level silently lost its toolbar).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { TabBar } from '../src/client/TabBar.tsx'
import { Workbench, type WorkbenchActions } from '../src/client/split-pane.tsx'
import type { SidebarState, SidebarTab, SplitNode } from '../src/client/state.ts'

/** The strip's right-actions wrappers (empty when nothing renders). */
function rightActionsEls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[class*="tabBarRightActions"]')]
}

function twoTabs(): SidebarTab[] {
  return [
    { id: 't1', type: 'demo:tool', title: 'Tool 1' },
    { id: 't2', type: 'demo:tool', title: 'Tool 2' },
  ]
}

function mountBar(opts: {
  tabs: SidebarTab[]
  active: string | null
  getTabRightActions?: (tab: SidebarTab, paneId: string) => React.ReactNode
}): { container: HTMLDivElement; rerender: (active: string | null) => void; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (active: string | null): void => {
    act(() => {
      root.render(createElement(TabBar, {
        paneId: 'pane:1',
        tabs: opts.tabs,
        active,
        onActivate: () => {},
        onClose: () => {},
        onNewTab: () => {},
        newTabOptions: [],
        onDropTab: () => {},
        ...(opts.getTabRightActions !== undefined ? { getTabRightActions: opts.getTabRightActions } : {}),
      }))
    })
  }
  render(opts.active)
  return {
    container,
    rerender: render,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('TabBar right-actions area', () => {
  it('renders the resolved node as the tab bar’s last child and passes the active tab + paneId', () => {
    const resolver = vi.fn((tab: SidebarTab, _paneId: string) =>
      createElement('button', { type: 'button', 'data-testid': 'restart' }, `restart ${tab.id}`))
    const { container, unmount } = mountBar({ tabs: twoTabs(), active: 't2', getTabRightActions: resolver })
    try {
      // The resolver saw the ACTIVE tab and this strip's pane id.
      expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ id: 't2' }), 'pane:1')
      const areas = rightActionsEls(container)
      expect(areas).toHaveLength(1)
      expect(areas[0]!.textContent).toBe('restart t2')
      // The area sits at the strip's right end: the last child of the bar.
      const bar = container.querySelector<HTMLElement>('[class*="tabBar"]')!
      expect(bar.lastElementChild).toBe(areas[0])
    } finally {
      unmount()
    }
  })

  it('follows the active tab across re-renders', () => {
    const resolver = vi.fn((tab: SidebarTab) => createElement('span', null, `actions:${tab.id}`))
    const { container, rerender, unmount } = mountBar({ tabs: twoTabs(), active: 't1', getTabRightActions: resolver })
    try {
      expect(rightActionsEls(container)[0]!.textContent).toBe('actions:t1')
      rerender('t2')
      expect(rightActionsEls(container)[0]!.textContent).toBe('actions:t2')
      // One call per render, always for the then-active tab.
      expect(resolver.mock.calls.map(call => call[0].id)).toEqual(['t1', 't2'])
    } finally {
      unmount()
    }
  })

  it('mounts no wrapper when the resolver returns null/undefined', () => {
    const { container, unmount } = mountBar({
      tabs: twoTabs(),
      active: 't1',
      getTabRightActions: () => null,
    })
    try {
      expect(rightActionsEls(container)).toHaveLength(0)
    } finally {
      unmount()
    }

    const undef = mountBar({ tabs: twoTabs(), active: 't1', getTabRightActions: () => undefined })
    try {
      expect(rightActionsEls(undef.container)).toHaveLength(0)
    } finally {
      undef.unmount()
    }
  })

  it('mounts nothing when no resolver is supplied (every pre-rightActions strip)', () => {
    const { container, unmount } = mountBar({ tabs: twoTabs(), active: 't1' })
    try {
      expect(rightActionsEls(container)).toHaveLength(0)
    } finally {
      unmount()
    }
  })
})

/** No-op workbench actions: these tests never interact with the panes. */
function stubActions(): WorkbenchActions {
  return {
    closeTab: () => {},
    activateTab: () => {},
    focusPane: () => {},
    moveTabToEdge: () => {},
    moveTabBefore: () => {},
    resizeSplit: () => {},
  }
}

/** A split-inside-a-split tree: p1 | (p2 / p3) — the nested split is the
 *  regression path (the recursive NodeView call once dropped the resolver). */
function nestedSplitTree(): SplitNode {
  return {
    kind: 'split',
    id: 's1',
    dir: 'row',
    sizes: [0.5, 0.5],
    children: [
      { kind: 'leaf', id: 'p1', tabs: [{ id: 'a1', type: 'demo:tool', title: 'A' }], active: 'a1' },
      {
        kind: 'split',
        id: 's2',
        dir: 'col',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', id: 'p2', tabs: [{ id: 'b1', type: 'demo:tool', title: 'B' }], active: 'b1' },
          { kind: 'leaf', id: 'p3', tabs: [{ id: 'c1', type: 'demo:tool', title: 'C' }], active: 'c1' },
        ],
      },
    ],
  }
}

describe('Workbench right-actions forwarding', () => {
  it('renders each pane’s own actions with its own active tab and paneId, through nested splits', () => {
    const state: SidebarState = {
      activePane: 'p1',
      nextBrowser: 1,
      expanded: [],
      revealed: [],
      unread: [],
      bottomOpen: true,
      bottomHeight: 220,
      bottomSplits: nestedSplitTree(),
    }
    const resolver = vi.fn((tab: SidebarTab, paneId: string) =>
      createElement('span', { 'data-pane': paneId }, `${paneId}:${tab.id}`))
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(createElement(Workbench, {
        state,
        newTabOptions: [],
        actions: stubActions(),
        onNewTab: () => {},
        renderTab: (tab: SidebarTab) => createElement('div', null, tab.title),
        getTabRightActions: resolver,
      }))
    })
    try {
      // One strip per pane — p2/p3 sit BELOW a nested split, so this fails
      // if the recursive NodeView call drops the resolver.
      const areas = rightActionsEls(container)
      expect(areas.map(area => area.textContent)).toEqual(['p1:a1', 'p2:b1', 'p3:c1'])
      expect(resolver.mock.calls.map(([tab, paneId]) => [paneId, tab.id])).toEqual([
        ['p1', 'a1'],
        ['p2', 'b1'],
        ['p3', 'c1'],
      ])
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
