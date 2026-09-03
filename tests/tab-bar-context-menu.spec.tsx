/**
 * Tab-strip right-click context-menu tests. Right-clicking a tab takes over
 * the browser menu (preventDefault) and shows the tab context menu with
 * exactly five items: move to free window / close / close others / close to
 * the left / close to the right. All bulk operations are scoped to the
 * CURRENT pane (the render time tab snapshot) and reuse the per-tab onClose
 * path, so the target tab is never closed and the pane never empties
 * mid-loop. The menu items gray out when there is nothing to close (single
 * tab → close others; leftmost → close left; rightmost → close right).
 * Opening the menu must not activate the right-clicked tab.
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
import type { SidebarTab } from '../src/client/state.ts'

/** Point the browser-language fallback at Chinese so the menu labels assert. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

const MENU_LABELS = ['移动到自由窗口', '关闭', '关闭其他页签', '关闭左侧页签', '关闭右侧页签']

function mountBar(tabs: SidebarTab[], opts: { onPinTab?: (tabId: string, scope: 'workspace' | 'global' | null) => void } = {}): {
  tabEls: HTMLElement[]
  onClose: ReturnType<typeof vi.fn>
  onActivate: ReturnType<typeof vi.fn>
  onFloatTab: ReturnType<typeof vi.fn>
  onPinTab?: (tabId: string, scope: 'workspace' | 'global' | null) => void
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const onClose = vi.fn()
  const onActivate = vi.fn()
  const onFloatTab = vi.fn()
  const onPinTab = opts.onPinTab
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
      onFloatTab,
      ...(onPinTab !== undefined ? { onPinTab } : {}),
      onDropTab: () => {},
    }))
  })
  const tabEls = [...container.querySelectorAll('[class*="tabList"] > [class*="tab"]')] as HTMLElement[]
  return {
    tabEls,
    onClose,
    onActivate,
    onFloatTab,
    ...(onPinTab !== undefined ? { onPinTab } : {}),
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

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('TabBar right-click context menu', () => {
  it('opens the five-item menu at the cursor, prevents the browser menu, and does not activate', () => {
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

  it('move to free window floats the target tab without closing it', () => {
    stubZh()
    const { tabEls, onClose, onFloatTab, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[1]!) })
      act(() => { menuItems()[0]!.click() })
      expect(onFloatTab).toHaveBeenCalledTimes(1)
      expect(onFloatTab).toHaveBeenCalledWith('t2')
      expect(onClose).not.toHaveBeenCalled()
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
      act(() => { menuItems()[1]!.click() })
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
      act(() => { menuItems()[2]!.click() })
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
      act(() => { menuItems()[3]!.click() })
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
      act(() => { menuItems()[4]!.click() })
      expect(onClose.mock.calls.map(call => call[0])).toEqual(['t3', 't4'])
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
      const items = menuItems()
      // The Menu renders each row as a disabled <button role="menuitem">.
      expect(items.map(item => (item as HTMLButtonElement).disabled)).toEqual([false, false, true, true, true])
      // Clicking the disabled row must not close anything.
      act(() => { items[2]!.click() })
      expect(single.onClose).not.toHaveBeenCalled()
    } finally {
      single.unmount()
    }

    const four = mountBar(fourTabs())
    try {
      act(() => { rightClick(four.tabEls[0]!) })
      expect(menuItems().map(item => (item as HTMLButtonElement).disabled)).toEqual([false, false, false, true, false])
      act(() => { rightClick(four.tabEls[3]!) })
      expect(menuItems().map(item => (item as HTMLButtonElement).disabled)).toEqual([false, false, false, false, true])
    } finally {
      four.unmount()
    }
  })
})

describe('TabBar pin submenu (v0.17.0)', () => {
  /** The portaled submenu rows (aria-expanded parent + nested menuitem rows). */
  function submenuItems(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')]
  }

  it('hides the pin entry when onPinTab is not provided (legacy callers)', () => {
    stubZh()
    const { tabEls, unmount } = mountBar(fourTabs())
    try {
      act(() => { rightClick(tabEls[2]!) }) // t3 = terminal
      // Exactly the legacy 5-item menu, no pin row.
      expect(menuItems().map(item => item.textContent)).toEqual(MENU_LABELS)
    } finally {
      unmount()
    }
  })

  it('adds a "Pin Terminal ▸" submenu for an unpinned UI terminal', () => {
    stubZh()
    const onPinTab = vi.fn<(tabId: string, scope: 'workspace' | 'global' | null) => void>()
    const { tabEls, unmount } = mountBar(fourTabs(), { onPinTab })
    try {
      act(() => { rightClick(tabEls[2]!) }) // t3 = UI terminal
      const labels = menuItems().map(item => item.textContent)
      // float | pin (with submenu indicator) | close | closeOthers | closeLeft | closeRight
      expect(labels[0]).toBe('移动到自由窗口')
      expect(labels[1]).toBe('固定终端')
      expect(labels[2]).toBe('关闭')
      // Hovering the pin row reveals the submenu items. React synthesizes
      // onMouseEnter from the bubbling mouseover event, so dispatch that.
      act(() => { menuItems()[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      const sub = submenuItems().map(item => item.textContent)
      expect(sub).toContain('固定到工作区')
      expect(sub).toContain('固定到全局')
      // Clicking "pin to workspace" fires the callback.
      const wsItem = submenuItems().find(item => item.textContent === '固定到工作区')!
      act(() => { wsItem.click() })
      expect(onPinTab).toHaveBeenCalledWith('t3', 'workspace')
    } finally {
      unmount()
    }
  })

  it('uses the "Pin Agent Terminal" label for an agent terminal tab', () => {
    stubZh()
    const onPinTab = vi.fn<(tabId: string, scope: 'workspace' | 'global' | null) => void>()
    const tabs: SidebarTab[] = [
      { id: 'agent:abc-123', type: 'terminal', title: 'Agent T' },
    ]
    const { tabEls, unmount } = mountBar(tabs, { onPinTab })
    try {
      act(() => { rightClick(tabEls[0]!) })
      const labels = menuItems().map(item => item.textContent)
      expect(labels[1]).toBe('固定 Agent 终端')
    } finally {
      unmount()
    }
  })

  it('shows "Unpin" instead of the submenu for an already-pinned terminal', () => {
    stubZh()
    const onPinTab = vi.fn<(tabId: string, scope: 'workspace' | 'global' | null) => void>()
    const tabs: SidebarTab[] = [
      { id: 'terminal:1', type: 'terminal', title: 'T', pin: { scope: 'global' } },
    ]
    const { tabEls, unmount } = mountBar(tabs, { onPinTab })
    try {
      act(() => { rightClick(tabEls[0]!) })
      const labels = menuItems().map(item => item.textContent)
      expect(labels).toContain('取消固定')
      expect(labels).not.toContain('固定终端')
      const unpinItem = menuItems().find(item => item.textContent === '取消固定')!
      act(() => { unpinItem.click() })
      expect(onPinTab).toHaveBeenCalledWith('terminal:1', null)
    } finally {
      unmount()
    }
  })

  it('does not add a pin entry for non-terminal tabs even with onPinTab provided', () => {
    stubZh()
    const onPinTab = vi.fn<(tabId: string, scope: 'workspace' | 'global' | null) => void>()
    const { tabEls, unmount } = mountBar(fourTabs(), { onPinTab })
    try {
      act(() => { rightClick(tabEls[0]!) }) // t1 = editor
      expect(menuItems().map(item => item.textContent)).toEqual(MENU_LABELS)
      act(() => { rightClick(tabEls[1]!) }) // t2 = git
      expect(menuItems().map(item => item.textContent)).toEqual(MENU_LABELS)
      expect(onPinTab).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })
})
