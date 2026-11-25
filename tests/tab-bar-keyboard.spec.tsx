/**
 * Workbench tabs expose one roving Tab stop, select through arrow/Home/End
 * navigation, and identify their own content panels. Switching keeps an
 * inactive panel mounted so unsaved input survives a return to it.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement, useState } from 'react'
import { act } from 'react-dom/test-utils'
import { Workbench } from '../src/client/split-pane.tsx'
import type { SidebarState, SidebarTab } from '../src/client/state.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

const tabs: SidebarTab[] = [
  { id: 't1', type: 'editor', title: 'First' },
  { id: 't2', type: 'editor', title: 'Second' },
]

function Harness({ close }: { close: (paneId: string, tabId: string) => void }) {
  const [active, setActive] = useState('t1')
  const state: SidebarState = {
    activePane: 'p1', nextBrowser: 1, expanded: [], revealed: [], unread: [],
    bottomOpen: true, bottomHeight: 220,
    bottomSplits: { kind: 'leaf', id: 'p1', tabs, active },
  }
  return createElement(Workbench, {
    state, newTabOptions: [], onNewTab: () => {},
    actions: {
      activateTab: (_paneId: string, id: string) => { setActive(id) },
      closeTab: close, focusPane: () => {}, moveTabToEdge: () => {},
      moveTabBefore: () => {}, resizeSplit: () => {},
    },
    renderTab: tab => createElement('input', { defaultValue: tab.title, 'aria-label': tab.title }),
  })
}

function press(target: HTMLElement, key: string): void {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

describe('Workbench tab keyboard and panel contracts', () => {
  it('moves focus and selection with arrows, Home and End, including wrapping and RTL', () => {
    const view = renderRoot(createElement(Harness, { close: () => {} }))
    try {
      const [first, second] = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(first!.tabIndex).toBe(0)
      expect(second!.tabIndex).toBe(-1)
      press(first!, 'ArrowRight')
      expect(document.activeElement).toBe(second)
      expect(second!.getAttribute('aria-selected')).toBe('true')
      expect(first!.tabIndex).toBe(-1)
      expect(second!.tabIndex).toBe(0)
      press(second!, 'ArrowRight')
      expect(document.activeElement).toBe(first)
      press(first!, 'End')
      expect(document.activeElement).toBe(second)
      press(second!, 'Home')
      expect(document.activeElement).toBe(first)
      first!.style.direction = 'rtl'
      press(first!, 'ArrowLeft')
      expect(document.activeElement).toBe(second)
    } finally { view.unmount() }
  })

  it('connects each tab to a persistent panel and preserves its input when hidden', () => {
    const view = renderRoot(createElement(Harness, { close: () => {} }))
    try {
      const [first, second] = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const firstPanel = document.getElementById(first!.getAttribute('aria-controls')!)!
      const secondPanel = document.getElementById(second!.getAttribute('aria-controls')!)!
      expect(firstPanel.getAttribute('role')).toBe('tabpanel')
      expect(firstPanel.getAttribute('aria-labelledby')).toBe(first!.id)
      expect(firstPanel.hidden).toBe(false)
      expect(secondPanel.hidden).toBe(true)
      const input = firstPanel.querySelector('input')!
      input.value = 'unsaved draft'
      act(() => { second!.click() })
      expect(firstPanel.hidden).toBe(true)
      expect(secondPanel.hidden).toBe(false)
      act(() => { first!.click() })
      expect(firstPanel.hidden).toBe(false)
      expect(firstPanel.querySelector('input')).toBe(input)
      expect(input.value).toBe('unsaved draft')
    } finally { view.unmount() }
  })

  it('closes an inactive tab without activating it', () => {
    const close = vi.fn()
    const view = renderRoot(createElement(Harness, { close }))
    try {
      const second = view.container.querySelectorAll('[role="tab"]')[1]!
      const closeButton = second.parentElement!.querySelector<HTMLButtonElement>('button:not([role="tab"])')!
      act(() => { closeButton.click() })
      expect(close).toHaveBeenCalledWith('p1', 't2')
      expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('First')
    } finally { view.unmount() }
  })
})
