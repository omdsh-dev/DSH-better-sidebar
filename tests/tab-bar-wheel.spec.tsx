/**
 * Tab-strip wheel-scroll tests: a plain mouse wheel over the tab row emits
 * deltaY, which a horizontal scrollport (`overflow-x: auto`) never consumes —
 * the handler in TabBar translates it into horizontal scrolling. It must
 * consume the event ONLY when the strip actually overflows (else the page
 * scrolls normally), must leave modifier-key gestures to the browser (shift
 * = native horizontal scroll, ctrl/cmd = zoom), and must scale deltaMode
 * lines/pages like the browser would.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { TabBar } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'

function mountBar(overflow: boolean): { list: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const tabs: SidebarTab[] = [
    { id: 't1', type: 'explorer', title: 'Explorer' },
    { id: 't2', type: 'git', title: 'Git' },
  ]
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TabBar, {
      paneId: 'pane:1',
      tabs,
      active: 't1',
      onActivate: () => {},
      onClose: () => {},
      onNewTab: () => {},
      newTabOptions: [],
      onDropTab: () => {},
    }))
  })
  const list = container.querySelector('[class*="tabList"]') as HTMLElement
  expect(list).not.toBeNull()
  // jsdom has no layout: stub the scrollport geometry to simulate overflow.
  Object.defineProperty(list, 'scrollWidth', { value: overflow ? 600 : 200, configurable: true })
  Object.defineProperty(list, 'clientWidth', { value: 200, configurable: true })
  return {
    list,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Dispatch a wheel event on the strip and return whether it was consumed. */
function wheel(list: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init })
  list.dispatchEvent(event)
  return event
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TabBar wheel → horizontal scroll', () => {
  it('translates a vertical wheel delta into scrollLeft when the strip overflows', () => {
    const { list, unmount } = mountBar(true)
    try {
      list.scrollLeft = 0
      const event = wheel(list, { deltaY: 120 })
      expect(event.defaultPrevented).toBe(true)
      expect(list.scrollLeft).toBe(120)
    } finally {
      unmount()
    }
  })

  it('scans left for a negative delta', () => {
    const { list, unmount } = mountBar(true)
    try {
      list.scrollLeft = 500
      const event = wheel(list, { deltaY: -80 })
      expect(event.defaultPrevented).toBe(true)
      expect(list.scrollLeft).toBe(420)
    } finally {
      unmount()
    }
  })

  it('does not consume the event when the strip does not overflow', () => {
    const { list, unmount } = mountBar(false)
    try {
      list.scrollLeft = 0
      const event = wheel(list, { deltaY: 120 })
      expect(event.defaultPrevented).toBe(false)
      expect(list.scrollLeft).toBe(0)
    } finally {
      unmount()
    }
  })

  it('leaves modifier-key gestures to the browser', () => {
    const { list, unmount } = mountBar(true)
    try {
      list.scrollLeft = 0
      const ctrl = wheel(list, { deltaY: 120, ctrlKey: true })
      const shift = wheel(list, { deltaY: 120, shiftKey: true })
      const meta = wheel(list, { deltaY: 120, metaKey: true })
      expect(ctrl.defaultPrevented).toBe(false)
      expect(shift.defaultPrevented).toBe(false)
      expect(meta.defaultPrevented).toBe(false)
      expect(list.scrollLeft).toBe(0)
    } finally {
      unmount()
    }
  })

  it('scales line-mode deltas by 16px per line', () => {
    const { list, unmount } = mountBar(true)
    try {
      list.scrollLeft = 0
      const event = wheel(list, { deltaY: 3, deltaMode: 1 })
      expect(event.defaultPrevented).toBe(true)
      expect(list.scrollLeft).toBe(48)
    } finally {
      unmount()
    }
  })

  it('adds a horizontal trackpad delta to the scroll', () => {
    const { list, unmount } = mountBar(true)
    try {
      list.scrollLeft = 0
      const event = wheel(list, { deltaX: 40 })
      expect(event.defaultPrevented).toBe(true)
      expect(list.scrollLeft).toBe(40)
    } finally {
      unmount()
    }
  })

  it('stops scrolling after unmount', () => {
    const { list, unmount } = mountBar(true)
    list.scrollLeft = 0
    unmount()
    const event = wheel(list, { deltaY: 120 })
    expect(event.defaultPrevented).toBe(false)
    expect(list.scrollLeft).toBe(0)
  })
})
