/**
 * Tab-strip right-click context menu tests: right-clicking a tab opens a
 * menu with the close group (this / right / left / others) and — for local
 * file tabs — the path group (copy absolute / copy relative / open with the
 * default app). Range entries disable at the strip edges; tabs without a
 * local file path (terminals, browsers holding URLs) never see path entries.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { TabBar, type TabPathPayload } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'

const FILE_TABS: SidebarTab[] = [
  { id: 't1', type: 'editor', title: 'A.ts', path: '/w/a.ts' },
  { id: 't2', type: 'terminal', title: 'Terminal' },
  { id: 't3', type: 'editor', title: 'B.ts', path: '/w/b.ts' },
]

/** Path payload for local file tabs (mirror of the Sidebar shell's resolver). */
const pathOf = (tab: SidebarTab): TabPathPayload | null => {
  const path = tab.path
  if (path === undefined || path === '') return null
  if (/^https?:\/\//i.test(path)) return null
  return { absolute: path, relative: 'rel/' + tab.title }
}

interface BarCalls {
  close: string[]
  right: string[]
  left: string[]
  others: string[]
  open: string[]
}

function mountBar(tabs: SidebarTab[]): { calls: BarCalls; tab: (title: string) => HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const calls: BarCalls = { close: [], right: [], left: [], others: [], open: [] }
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TabBar, {
      paneId: 'pane:1',
      tabs,
      active: 't1',
      onActivate: () => {},
      onClose: (id) => { calls.close.push(id) },
      onNewTab: () => {},
      newTabOptions: [],
      onDropTab: () => {},
      onCloseRight: (id) => { calls.right.push(id) },
      onCloseLeft: (id) => { calls.left.push(id) },
      onCloseOthers: (id) => { calls.others.push(id) },
      getTabPath: pathOf,
      onOpenFileSystem: (path) => { calls.open.push(path) },
    }))
  })
  return {
    calls,
    tab: (title: string): HTMLElement => {
      const el = Array.from(container.querySelectorAll('[title]')).find(node => node.getAttribute('title') === title)
      expect(el, 'tab titled ' + title).toBeTruthy()
      return el as HTMLElement
    },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Right-click a tab: opens its context menu at the cursor. */
function rightClick(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 60,
    }))
  })
}

/** The open menu's items (portal lands them on document.body). */
function menuButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[]
}

function labels(): string[] {
  return menuButtons().map(button => (button.textContent ?? '').trim())
}

function item(labelText: string): HTMLButtonElement {
  const button = menuButtons().find(candidate => (candidate.textContent ?? '').includes(labelText))
  expect(button, 'menu item "' + labelText + '"').toBeTruthy()
  return button!
}

/** Click one menu item (the selection closes the menu). */
function clickItem(labelText: string): void {
  const button = item(labelText)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

let written: string[]
beforeEach(() => {
  written = []
  // Stub the clipboard so the copy-path entries are observable.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text) } },
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  delete (navigator as unknown as Record<string, unknown>).clipboard
})

describe('TabBar right-click context menu', () => {
  it('opens the full menu on a local file tab with edge-aware disabled states', () => {
    const bar = mountBar(FILE_TABS)
    try {
      rightClick(bar.tab('A.ts'))
      expect(labels()).toEqual([
        t('closeThisTab'),
        t('closeRightTabs'),
        t('closeLeftTabs'),
        t('closeOtherTabs'),
        t('copyAbsolute'),
        t('copyRelative'),
        t('openWithDefault'),
      ])
      // First tab: nothing to the left; two tabs to the right.
      expect(item(t('closeLeftTabs')).disabled).toBe(true)
      expect(item(t('closeRightTabs')).disabled).toBe(false)
      expect(item(t('closeOtherTabs')).disabled).toBe(false)
      expect(item(t('closeThisTab')).disabled).toBe(false)
    } finally {
      bar.unmount()
    }
  })

  it('disables close-right on the last tab', () => {
    const bar = mountBar(FILE_TABS)
    try {
      rightClick(bar.tab('B.ts'))
      expect(item(t('closeRightTabs')).disabled).toBe(true)
      expect(item(t('closeLeftTabs')).disabled).toBe(false)
    } finally {
      bar.unmount()
    }
  })

  it('hides the path entries for tabs without a local file path', () => {
    const bar = mountBar(FILE_TABS)
    try {
      rightClick(bar.tab('Terminal'))
      const shown = labels()
      expect(shown).toContain(t('closeThisTab'))
      expect(shown).not.toContain(t('copyAbsolute'))
      expect(shown).not.toContain(t('copyRelative'))
      expect(shown).not.toContain(t('openWithDefault'))
    } finally {
      bar.unmount()
    }
  })

  it('routes the close entries to the matching callbacks', () => {
    const bar = mountBar(FILE_TABS)
    try {
      rightClick(bar.tab('A.ts'))
      clickItem(t('closeThisTab'))
      expect(bar.calls.close).toEqual(['t1'])

      rightClick(bar.tab('A.ts'))
      clickItem(t('closeRightTabs'))
      expect(bar.calls.right).toEqual(['t1'])

      rightClick(bar.tab('B.ts'))
      clickItem(t('closeLeftTabs'))
      expect(bar.calls.left).toEqual(['t3'])

      rightClick(bar.tab('A.ts'))
      clickItem(t('closeOtherTabs'))
      expect(bar.calls.others).toEqual(['t1'])
    } finally {
      bar.unmount()
    }
  })

  it('copies the absolute and relative paths', async () => {
    const bar = mountBar(FILE_TABS)
    try {
      rightClick(bar.tab('A.ts'))
      clickItem(t('copyAbsolute'))
      await Promise.resolve()
      await Promise.resolve()
      expect(written).toContain('/w/a.ts')

      rightClick(bar.tab('A.ts'))
      clickItem(t('copyRelative'))
      await Promise.resolve()
      await Promise.resolve()
      expect(written).toContain('rel/A.ts')
    } finally {
      bar.unmount()
    }
  })

  it('opens the file with the default app through the callback', () => {
    const bar = mountBar(FILE_TABS)
    try {
      rightClick(bar.tab('A.ts'))
      clickItem(t('openWithDefault'))
      expect(bar.calls.open).toEqual(['/w/a.ts'])
    } finally {
      bar.unmount()
    }
  })

  it('closes the menu on an outside pointerdown', () => {
    const bar = mountBar(FILE_TABS)
    try {
      rightClick(bar.tab('A.ts'))
      expect(menuButtons().length).toBeGreaterThan(0)
      act(() => {
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      })
      expect(menuButtons()).toEqual([])
    } finally {
      bar.unmount()
    }
  })
})
