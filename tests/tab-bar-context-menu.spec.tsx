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
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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

function mountBar(tabs: SidebarTab[]): {
  tabEls: HTMLElement[]
  onClose: ReturnType<typeof vi.fn>
  onActivate: ReturnType<typeof vi.fn>
  onFloatTab: ReturnType<typeof vi.fn>
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const onClose = vi.fn()
  const onActivate = vi.fn()
  const onFloatTab = vi.fn()
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
      onDropTab: () => {},
    }))
  })
  const tabEls = [...container.querySelectorAll('[class*="tabList"] > [class*="tab"]')] as HTMLElement[]
  return {
    tabEls,
    onClose,
    onActivate,
    onFloatTab,
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
