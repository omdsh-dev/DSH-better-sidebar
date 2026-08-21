/**
 * Tab-strip middle-click close tests. The press target is recorded on middle
 * mousedown (preventDefaulted to disarm Chrome's middle-click autoscroll)
 * and the close settles on the first middle mouseup OVER that same tab —
 * release-position semantics matching VS Code (microsoft/vscode#101028) and
 * user expectations for Chrome tabs (crbug/40679924): pressing on a tab and
 * releasing elsewhere cancels. The browser dispatches auxclick to the common
 * ancestor of the press/release targets when they differ (or suppresses it
 * entirely), so settling on the recorded press target keeps release
 * semantics without depending on auxclick delivery. Left-button paths
 * (activate / drag) and wheel scrolling are untouched.
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

function mountBar(): {
  tab0: HTMLElement
  tab1: HTMLElement
  onClose: ReturnType<typeof vi.fn>
  onActivate: ReturnType<typeof vi.fn>
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const onClose = vi.fn()
  const onActivate = vi.fn()
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
      onActivate,
      onClose,
      onNewTab: () => {},
      newTabOptions: [],
      onDropTab: () => {},
    }))
  })
  const tabEls = [...container.querySelectorAll('[class*="tabList"] > [class*="tab"]')] as HTMLElement[]
  expect(tabEls.length).toBe(2)
  // noUncheckedIndexedAccess: the length assertion above is the guard, but
  // the compiler still sees `HTMLElement | undefined` through indexing.
  const tab0 = tabEls[0]!
  const tab1 = tabEls[1]!
  return {
    tab0,
    tab1,
    onClose,
    onActivate,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Dispatch a native mouse event; returns the event (to read defaultPrevented). */
function mouse(target: EventTarget, type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('TabBar middle-click close', () => {
  it('closes when the middle mouseup lands on the same tab', () => {
    const { tab0, onClose, unmount } = mountBar()
    try {
      mouse(tab0, 'mousedown', 1)
      mouse(tab0, 'mouseup', 1)
      expect(onClose).toHaveBeenCalledWith('t1')
    } finally {
      unmount()
    }
  })

  it('preventDefaults the middle mousedown (disarms browser autoscroll)', () => {
    const { tab0, unmount } = mountBar()
    try {
      const event = mouse(tab0, 'mousedown', 1)
      expect(event.defaultPrevented).toBe(true)
    } finally {
      unmount()
    }
  })

  it('a release elsewhere (drag-away) cancels the close — one-shot', () => {
    const { tab0, onClose, unmount } = mountBar()
    try {
      // Press on tab 0, release on unrelated element: no close.
      mouse(tab0, 'mousedown', 1)
      mouse(document.body, 'mouseup', 1)
      expect(onClose).not.toHaveBeenCalled()
      // A later middle mouseup over the tab (no new press) must NOT close.
      mouse(tab0, 'mouseup', 1)
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('a release over a DIFFERENT tab does not close', () => {
    const { tab0, tab1, onClose, unmount } = mountBar()
    try {
      mouse(tab0, 'mousedown', 1)
      mouse(tab1, 'mouseup', 1)
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('middle mousedown on the close button closes (release over the tab)', () => {
    const { tab0, onClose, unmount } = mountBar()
    try {
      const button = tab0.querySelector('button') as HTMLButtonElement
      expect(button).not.toBeNull()
      mouse(button, 'mousedown', 1)
      mouse(button, 'mouseup', 1)
      expect(onClose).toHaveBeenCalledWith('t1')
    } finally {
      unmount()
    }
  })

  it('left mousedown does not close; left click activates', () => {
    const { tab0, onClose, onActivate, unmount } = mountBar()
    try {
      mouse(tab0, 'mousedown', 0)
      mouse(tab0, 'mouseup', 0)
      expect(onClose).not.toHaveBeenCalled()
      mouse(tab0, 'click', 0)
      expect(onActivate).toHaveBeenCalledWith('t1')
    } finally {
      unmount()
    }
  })

  it('a middle auxclick alone (no mousedown) does not close', () => {
    // Pins the contract: the close settles on the mouseup of the recorded
    // press, not on auxclick delivery — the browser redirects auxclick to
    // the common ancestor (or suppresses it) when press/release targets
    // differ, which was the failure mode.
    const { tab0, onClose, unmount } = mountBar()
    try {
      mouse(tab0, 'auxclick', 1)
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('a left mouseup after a middle press does not consume the press', () => {
    const { tab0, onClose, unmount } = mountBar()
    try {
      mouse(tab0, 'mousedown', 1)
      mouse(window, 'mouseup', 0)
      expect(onClose).not.toHaveBeenCalled()
      mouse(tab0, 'mouseup', 1)
      expect(onClose).toHaveBeenCalledWith('t1')
    } finally {
      unmount()
    }
  })

  it('stops closing after unmount', () => {
    const { tab0, onClose, unmount } = mountBar()
    mouse(tab0, 'mousedown', 1)
    unmount()
    mouse(tab0, 'mouseup', 1)
    expect(onClose).not.toHaveBeenCalled()
  })
})
