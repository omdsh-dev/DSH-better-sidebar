/**
 * 会话头里的底部工作台开关（`Sidebar.tsx` 的 `BottomDockToggle`）。
 *
 * 钉住一条行为：**宿主右侧面板展开时入口照常渲染**。早先这里在 `useRightPanelOpen()`
 * 为真时早退，结果「先开右栏就再也打不开工作台」——右栏那簇控件
 * （Split / Fullscreen / Collapse right sidebar）在右栏列内，本入口在会话头 utilities
 * （中间列），两列不重叠，没有隐藏的理由。
 *
 * 空白会话的 fixed 兜底入口是另一件事（见 `dock-fallback.spec.tsx`），它在右栏展开时
 * 仍然不渲染：那个入口锚在右栏控件左侧，展开时锚点落在面板内部。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { BottomDockToggle } from '../src/client/Sidebar.tsx'
import { createSidebarStore } from '../src/client/state.ts'

setupReactAct()

function renderToggle(): { unmount: () => void; store: ReturnType<typeof createSidebarStore> } {
  const store = createSidebarStore()
  store.setSession('s1')
  const view = renderRoot(createElement(BottomDockToggle, { store }))
  return { unmount: view.unmount, store }
}

/** 宿主右侧面板**展开**态的控件：可见的 `[data-sidebar-right-toggle]`。 */
function appendExpandedRightPanelControl(): void {
  const element = document.createElement('button')
  element.setAttribute('data-sidebar-right-toggle', 'true')
  element.getBoundingClientRect = () => ({
    x: 900, y: 10, left: 900, top: 10, width: 28, height: 28, right: 928, bottom: 38,
    toJSON: () => ({}),
  }) as DOMRect
  document.body.append(element)
}

afterEach(() => {
  for (const element of document.querySelectorAll('[data-sidebar-right-toggle]')) element.remove()
})

describe('会话头底部开关', () => {
  it('宿主右侧面板展开时仍然渲染入口', () => {
    appendExpandedRightPanelControl()
    const { unmount } = renderToggle()
    try {
      expect(document.querySelector('[data-dsh-bottom-toggle]'), '右栏展开也要有底部入口').not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('点击翻转 store 的 bottomOpen', () => {
    const { unmount, store } = renderToggle()
    try {
      const element = document.querySelector('[data-dsh-bottom-toggle]')
      if (element === null) throw new Error('missing element: bottom toggle')
      expect(store.getSnapshot().state?.bottomOpen).toBe(false)
      act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(store.getSnapshot().state?.bottomOpen).toBe(true)
    } finally {
      unmount()
    }
  })
})
