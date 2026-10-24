/**
 * Tab-strip right-click context-menu tests. Right-clicking a tab takes over
 * the browser menu (preventDefault) and shows the tab context menu with
 * exactly six items: close / close others / close to the left / close to the
 * right / close all / reveal in the file manager. All close operations are
 * scoped to the CURRENT pane (the render-time tab snapshot) and reuse the
 * per-tab onClose path, so every closed tab keeps its own lifecycle and the
 * pane never empties mid-loop; "close all" is the one that closes the
 * right-clicked tab too. The reveal row hands the tab's associated file
 * (`path`, i.e. an editor window) to the shell's reveal resolver and is
 * disabled for a tab that has none. Menu rows gray out when there is nothing
 * to do (single tab → close others; leftmost → close left; rightmost → close
 * right; no file → reveal). Opening the menu must not activate the
 * right-clicked tab.
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
import { Sidebar } from '../src/client/Sidebar.tsx'
import { Workbench } from '../src/client/split-pane.tsx'
import { createSidebarStore, makeDefaultState, type SidebarState, type SidebarTab } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'

/** Point the browser-language fallback at Chinese so the menu labels assert. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

const MENU_LABELS = [
  '关闭', '关闭其他页签', '关闭左侧页签', '关闭右侧页签', '关闭全部页签', '在资源管理器中定位',
]

function mountBar(tabs: SidebarTab[], opts: {
  /** Omit the reveal resolver (the shell always passes one; this pins the
   *  disabled-without-resolver half of the contract). */
  noRevealResolver?: boolean
} = {}): {
  tabEls: HTMLElement[]
  onClose: ReturnType<typeof vi.fn>
  onActivate: ReturnType<typeof vi.fn>
  /** The reveal resolver the strip was given (undefined when omitted). */
  onRevealInFileManager?: ReturnType<typeof vi.fn>
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const onClose = vi.fn()
  const onActivate = vi.fn()
  const onRevealInFileManager = opts.noRevealResolver === true ? undefined : vi.fn()
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TabBar, {
      paneId: 'pane:1',
      tabs,
      active: tabs[0]?.id ?? null,
      onActivate,
      onClose,
      onNewTab: () => {},
      newTabOptions: [],
      ...(onRevealInFileManager === undefined ? {} : { onRevealInFileManager }),
      onDropTab: () => {},
    }))
  })
  const tabEls = [...container.querySelectorAll('[class*="tabList"] > [class*="tab"]')] as HTMLElement[]
  return {
    tabEls,
    onClose,
    onActivate,
    ...(onRevealInFileManager === undefined ? {} : { onRevealInFileManager }),
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

function fourTabs(): SidebarTab[] {
  return [
    { id: 't1', type: 'editor', title: 'Tab 1' },
    { id: 't2', type: 'git', title: 'Tab 2' },
    { id: 't3', type: 'terminal', title: 'Tab 3' },
    { id: 't4', type: 'browser', title: 'Tab 4' },
  ]
}

/** Two tabs where only the first carries a file (an editor window). */
function fileTabs(): SidebarTab[] {
  return [
    { id: 'f1', type: 'editor', title: 'a.ts', path: '/repo/src/a.ts' },
    { id: 'f2', type: 'git', title: 'Changes' },
  ]
}

/** Dispatch a native right-click (contextmenu) and return the event. */
function rightClick(target: EventTarget): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 40 })
  target.dispatchEvent(event)
  return event
}

/** The portaled menu rows (empty when the menu is closed). */
function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

/** The disabled flags of the portaled rows, in menu order. */
function menuDisabled(): boolean[] {
  return menuItems().map(item => (item as HTMLButtonElement).disabled)
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('TabBar right-click context menu', () => {
  it('opens the six-item menu at the cursor, prevents the browser menu, and does not activate', () => {
    stubZh()
    const { tabEls, onActivate, unmount } = mountBar(fourTabs())
    try {
      let event: MouseEvent | null = null
      act(() => { event = rightClick(tabEls[1]!) })
      expect(event!.defaultPrevented).toBe(true)
      expect(menuItems().map(item => item.textContent)).toEqual(MENU_LABELS)
      expect(onActivate).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('close closes the target tab and dismisses the menu', () => {
    stubZh()
    const { tabEls, onClose, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[1]!) })
      act(() => { menuItems()[0]!.click() })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledWith('t2')
      expect(menuItems()).toHaveLength(0)
    } finally {
      unmount()
    }
  })

  it('close closes only the target tab and closes the menu', () => {
    stubZh()
    const { tabEls, onClose, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[1]!) })
      act(() => { menuItems()[0]!.click() })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledWith('t2')
      expect(menuItems()).toHaveLength(0)
    } finally {
      unmount()
    }
  })

  it('close others closes every tab in the pane except the target, in visual order', () => {
    stubZh()
    const { tabEls, onClose, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[1]!) })
      act(() => { menuItems()[1]!.click() })
      expect(onClose.mock.calls.map(call => call[0])).toEqual(['t1', 't3', 't4'])
      expect(onClose).not.toHaveBeenCalledWith('t2')
      expect(menuItems()).toHaveLength(0)
    } finally {
      unmount()
    }
  })

  it('close left closes only the tabs to the left of the target', () => {
    stubZh()
    const { tabEls, onClose, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[2]!) })
      act(() => { menuItems()[2]!.click() })
      expect(onClose.mock.calls.map(call => call[0])).toEqual(['t1', 't2'])
      expect(menuItems()).toHaveLength(0)
    } finally {
      unmount()
    }
  })

  it('close right closes only the tabs to the right of the target', () => {
    stubZh()
    const { tabEls, onClose, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[1]!) })
      act(() => { menuItems()[3]!.click() })
      expect(onClose.mock.calls.map(call => call[0])).toEqual(['t3', 't4'])
      expect(menuItems()).toHaveLength(0)
    } finally {
      unmount()
    }
  })

  it('close all closes every tab in the pane, the right-clicked one included', () => {
    stubZh()
    const { tabEls, onClose, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[1]!) })
      act(() => { menuItems()[4]!.click() })
      expect(onClose.mock.calls.map(call => call[0])).toEqual(['t1', 't2', 't3', 't4'])
      expect(menuItems()).toHaveLength(0)
    } finally {
      unmount()
    }
  })

  it('reveals the right-clicked tab file through the shell resolver', () => {
    stubZh()
    const { tabEls, onRevealInFileManager, onClose, unmount } = mountBar(fileTabs())
    try {
      act(() => { rightClick(tabEls[0]!) })
      // The file tab's row is live; the pane's other tab has no file.
      expect(menuDisabled()).toEqual([false, false, true, false, false, false])
      act(() => { menuItems()[5]!.click() })
      expect(onRevealInFileManager).toHaveBeenCalledTimes(1)
      expect(onRevealInFileManager).toHaveBeenCalledWith('/repo/src/a.ts')
      // Revealing is not a close: no tab may go away.
      expect(onClose).not.toHaveBeenCalled()
      expect(menuItems()).toHaveLength(0)
    } finally {
      unmount()
    }
  })

  it('grays out close others on a single tab and close left/right at the strip ends', () => {
    stubZh()
    const single = mountBar([
      { id: 'only', type: 'editor', title: 'Only' },
    ])
    try {
      act(() => { rightClick(single.tabEls[0]!) })
      // The Menu renders each row as a disabled <button role="menuitem">.
      // Close all stays live (it always has at least the right-clicked tab).
      expect(menuDisabled()).toEqual([false, true, true, true, false, true])
      // Clicking the disabled row must not close anything.
      act(() => { menuItems()[1]!.click() })
      expect(single.onClose).not.toHaveBeenCalled()
    } finally {
      single.unmount()
    }

    const four = mountBar(fourTabs())
    try {
      act(() => { rightClick(four.tabEls[0]!) })
      expect(menuDisabled()).toEqual([false, false, true, false, false, true])
      act(() => { rightClick(four.tabEls[3]!) })
      expect(menuDisabled()).toEqual([false, false, false, true, false, true])
    } finally {
      four.unmount()
    }
  })

  it('grays out the reveal row for a tab with no associated file', () => {
    stubZh()
    const tabs = fileTabs()
    const { tabEls, onRevealInFileManager, onClose, unmount } = mountBar(tabs)
    try {
      act(() => { rightClick(tabEls[1]!) })
      // The changes tab carries no file of its own (its diff ref is
      // repo-relative, not a path the host could reveal).
      expect(menuDisabled()).toEqual([false, false, false, true, false, true])
      act(() => { menuItems()[5]!.click() })
      expect(onRevealInFileManager).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('grays out the reveal row when the shell passes no resolver', () => {
    stubZh()
    const { tabEls, onRevealInFileManager, unmount } = mountBar(fileTabs(), { noRevealResolver: true })
    try {
      act(() => { rightClick(tabEls[0]!) })
      expect(onRevealInFileManager).toBeUndefined()
      expect(menuDisabled()[5]).toBe(true)
    } finally {
      unmount()
    }
  })
})

describe('Workbench tab context menu', () => {
  /** Two panes side by side, each with one file tab (the recursive render
   *  path a split workbench takes to its strips). */
  function splitState(): SidebarState {
    return {
      ...makeDefaultState(),
      bottomSplits: {
        kind: 'split',
        id: 'split:1',
        dir: 'row',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', id: 'pane:1', tabs: [{ id: 't1', type: 'editor', title: 'a.ts', path: '/repo/a.ts' }], active: 't1' },
          { kind: 'leaf', id: 'pane:2', tabs: [{ id: 't2', type: 'editor', title: 'b.ts', path: '/repo/b.ts' }], active: 't2' },
        ],
      },
    }
  }

  it('hands every pane strip the shell reveal resolver', () => {
    stubZh()
    const state = splitState()
    const onRevealInFileManager = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(createElement(Workbench, {
        state,
        tree: state.bottomSplits,
        newTabOptions: [],
        actions: {
          closeTab: () => {},
          activateTab: () => {},
          focusPane: () => {},
          moveTabToEdge: () => {},
          moveTabBefore: () => {},
          resizeSplit: () => {},
        },
        onNewTab: () => {},
        // The strip is what this spec is about: the panes' bodies stay empty.
        renderTab: () => null,
        onRevealInFileManager,
      }))
    })
    try {
      const paneTabs = [...container.querySelectorAll<HTMLElement>('[class*="tabList"] > [class*="tab"]')]
      expect(paneTabs).toHaveLength(2)
      // Each strip's reveal row must reach the resolver with ITS tab's file.
      act(() => { rightClick(paneTabs[0]!) })
      expect(menuDisabled()[5]).toBe(false)
      act(() => { menuItems()[5]!.click() })
      expect(onRevealInFileManager).toHaveBeenLastCalledWith('/repo/a.ts')

      act(() => { rightClick(paneTabs[1]!) })
      act(() => { menuItems()[5]!.click() })
      expect(onRevealInFileManager).toHaveBeenLastCalledWith('/repo/b.ts')
      expect(onRevealInFileManager).toHaveBeenCalledTimes(2)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})

describe('Sidebar tab context menu reveal', () => {
  /**
   * The whole shell on a fake host: the bottom workbench holds one file tab,
   * and the reveal row must reach the host's open-in-app remote — the same
   * call the explorer's own reveal row makes (`ctx.remote.session.
   * openWorkspacePath({ path, action: 'reveal' })`). This is the only
   * coverage of the shell's own wiring between the strip resolver and the
   * open-in-app adapter; `tests/open-in-app.spec.ts` covers the adapter.
   */
  it('reveals the tab file through the host open-in-app remote', async () => {
    vi.stubGlobal('WebSocket', class { close(): void {} })
    const store = createSidebarStore()
    store.setSession('s1')
    store.reduce(state => ({ ...state, bottomOpen: true }))
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'probe', title: 'Probe', component: () => null })
    service.openTab({ type: 'probe', title: 'probe.ts', path: '/repo/src/probe.ts' })
    const reveal = vi.fn(async () => ({ ok: true }))
    // Both snapshots are stable references (useSyncExternalStore re-reads
    // them on every render: a fresh object here is an infinite loop). The
    // shell follows the host's MOUNTED seat (`ctx.sidebarRight.mounted`) for
    // its per-session state, so the fake column has to report one — without
    // it the shell unbinds the store and renders nothing.
    const localeSnapshot = { active: 'en' }
    const sessionsSnapshot = { byId: { s1: { id: 's1', cwd: '/repo' } } }
    const ctx = {
      locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
      get: (name: string) => ({
        betterSidebar: service,
        remote: { session: { openWorkspacePath: reveal } },
        sidebarRight: { mounted: { subscribe: () => () => {}, getSnapshot: () => 's1' } },
      })[name],
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
    try {
      const tab = container.querySelector<HTMLElement>('[class*="bottomPanel"] [class*="tabList"] > [class*="tab"]')
      expect(tab).not.toBeNull()
      act(() => { rightClick(tab!) })
      // The copy is pinned by the TabBar block above (against zh); here the
      // shape and the row's live state are what matter (the shell runs on the
      // default locale).
      expect(menuItems()).toHaveLength(MENU_LABELS.length)
      expect(menuDisabled()[5]).toBe(false)
      await act(async () => { menuItems()[5]!.click() })
      expect(reveal).toHaveBeenCalledTimes(1)
      expect(reveal).toHaveBeenCalledWith({ path: '/repo/src/probe.ts', action: 'reveal' })
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
