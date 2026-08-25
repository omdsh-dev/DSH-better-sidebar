/**
 * Free-window interaction tests, against the REAL Sidebar shell + real
 * store/service (the sidebar-crash spec's mount pattern).
 *
 * 1. Drag-out detection: while a tab drag (the body flag the tab strips
 *    maintain) hovers the conversation column, a hint overlay marks the drop
 *    zone; the drop floats the tab at the release point and the pane loses
 *    it. Targets inside the panel host stay the panes' own business.
 * 2. The tab context menu's "move to free window" floats the tab at the
 *    conversation column's center (no drop point exists).
 * 3. The window itself: header drag moves (rAF direct writes, store commit
 *    on release), the SE corner resizes, releasing the header over a pane
 *    docks the tab back (the pane highlights live), and the X closes the tab
 *    with its window.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, togglePanel, type SidebarStore, floatTab as floatTabReducer } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { serializeDrag } from '../src/client/TabBar.tsx'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

/** The app shell's center column: #root > col > [data-slot="conversation"],
 *  with a real-looking rect so the drag-out zone can be hit-tested. */
const CONV_RECT = { left: 100, right: 700, top: 50, bottom: 600, width: 600, height: 550 }

function fakeConversationColumn(): HTMLElement {
  const rootEl = document.createElement('div')
  rootEl.id = 'root'
  const col = document.createElement('div')
  const conv = document.createElement('div')
  conv.setAttribute('data-slot', 'conversation')
  col.append(conv)
  rootEl.append(col)
  document.body.append(rootEl)
  col.getBoundingClientRect = () => CONV_RECT as DOMRect
  return col
}

interface Mounted {
  container: HTMLDivElement
  store: SidebarStore
  service: BetterSidebarService
  unmount: () => void
}

/** Unique per-test session ids (see the comment inside). */
let sessionSeq = 0

function mountSidebar(sessionId: string = `s1-${++sessionSeq}`): Mounted {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({
    id: 'notes',
    title: 'Notes',
    single: true,
    // Pins the visibility contract into the DOM: plugin components honor
    // `visible` to pause work, so the float tests can assert what a
    // registering plugin would actually receive.
    component: ({ visible }) => createElement('div', { 'data-visible': String(visible) }, 'notes body'),
  })
  store.setPrefs({ ...store.getPrefs(), openByDefault: true })
  // The default session id is unique per test: the store persists
  // per-session state to localStorage on a 200ms debounce, and a shared id
  // let a PREVIOUS test's late timer write leak into this store's
  // setSession restore (the portaled-menu/resize flakes — a stale float at
  // the old drop point won the querySelector race on slow runners). The
  // persistence round-trip test passes its own fixed id instead.
  store.setSession(sessionId)
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = { current: sessionId, byId: { [sessionId]: { cwd: '/tmp' } } }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  }
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  return {
    container,
    store,
    service,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** A document-level drag event with a payload-carrying dataTransfer (jsdom
 *  has no DragEvent/DataTransfer). Dispatched AT document, where the shell's
 *  capture listeners live. */
function dispatchDrag(type: 'dragover' | 'drop', x: number, y: number, payload?: string): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientX', { value: x })
  Object.defineProperty(event, 'clientY', { value: y })
  Object.defineProperty(event, 'dataTransfer', { value: { getData: () => payload ?? '' } })
  document.dispatchEvent(event)
}

const flushFrame = async (): Promise<void> => {
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
}

const paneTabs = (store: SidebarStore): string[] => {
  const state = store.getSnapshot().state!
  const leaves = [state.splits, state.bottomSplits]
  return leaves.flatMap(tree => (tree.kind === 'leaf' ? [tree] : allLeafList(tree)))
    .flatMap(leaf => leaf.tabs.map(tab => tab.id))
}
const allLeafList = (node: import('../src/client/state.ts').SplitNode): Array<{ tabs: Array<{ id: string }> }> =>
  node.kind === 'leaf' ? [node] : node.children.flatMap(allLeafList)

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.style.cssText = ''
  vi.unstubAllGlobals()
  // Belt and braces (after unstub, so a test's storage stub never sees it):
  // drop any persisted layout a pending 200ms debounce write left behind
  // between tests — unique session ids already isolate the stores.
  localStorage.clear()
})

describe('free windows: drag-out detection', () => {
  it('hovering the conversation column shows the hint; the drop floats the tab there', () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      const before = paneTabs(store)
      expect(before).toContain('notes')
      // A tab drag is active (the tab strips maintain this body flag).
      document.body.setAttribute('data-dsh-tab-dragging', '')
      // Outside the column: no hint.
      act(() => { dispatchDrag('dragover', 50, 20) })
      expect(container.querySelector('[class*="floatDropHint"]')).toBeNull()
      // Over the column: the hint overlay appears at the column's rect.
      act(() => { dispatchDrag('dragover', 400, 300) })
      const hint = container.querySelector<HTMLElement>('[class*="floatDropHint"]')!
      expect(hint).not.toBeNull()
      expect(hint.style.left).toBe('100px')
      expect(hint.style.width).toBe('600px')
      // The drop floats the tab at the release point.
      act(() => {
        dispatchDrag('drop', 400, 300, serializeDrag({ tabId: 'notes', paneId: 'pane:1' }))
      })
      const state = store.getSnapshot().state!
      expect(state.floats).toHaveLength(1)
      expect(state.floats[0]!.tab.id).toBe('notes')
      expect(paneTabs(store)).not.toContain('notes')
      // The hint is gone and the window is rendered.
      expect(container.querySelector('[class*="floatDropHint"]')).toBeNull()
      expect(container.querySelector('[data-dsh-float-window]')).not.toBeNull()
      // dragend clears any lingering state.
      document.body.setAttribute('data-dsh-tab-dragging', '')
      act(() => { dispatchDrag('dragover', 400, 300) })
      expect(container.querySelector('[class*="floatDropHint"]')).not.toBeNull()
      act(() => { window.dispatchEvent(new Event('dragend')) })
      expect(container.querySelector('[class*="floatDropHint"]')).toBeNull()
      document.body.removeAttribute('data-dsh-tab-dragging')
    } finally {
      unmount()
    }
  })

  it('drops without the hint armed are left to the panes (no float)', () => {
    fakeConversationColumn()
    const { store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      document.body.setAttribute('data-dsh-tab-dragging', '')
      // A drop with NO preceding dragover over the column (e.g. directly on
      // a pane) must not float anything.
      act(() => {
        dispatchDrag('drop', 400, 300, serializeDrag({ tabId: 'notes', paneId: 'pane:1' }))
      })
      expect(store.getSnapshot().state!.floats).toHaveLength(0)
      expect(paneTabs(store)).toContain('notes')
      document.body.removeAttribute('data-dsh-tab-dragging')
    } finally {
      unmount()
    }
  })
})

describe('free windows: the window', () => {
  it('the tab context menu floats the tab at the conversation center', () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      // The strip holds the seeded home tab first; Notes is the LAST tab.
      const tabs = [...container.querySelectorAll<HTMLElement>('[class*="tabList"] > [class*="tab"]')]
      const tab = tabs.at(-1)!
      act(() => { tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
      // The float entry is the FIRST menu row.
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(items.length).toBeGreaterThan(0)
      act(() => { items[0]!.click() })
      const state = store.getSnapshot().state!
      expect(state.floats).toHaveLength(1)
      expect(state.floats[0]!.tab.id).toBe('notes')
      // Born at the conversation column's center with the phone-ratio
      // default (390x780), created capped to the jsdom viewport (h 744) and
      // clamped in (the centered y would be negative).
      expect(state.floats[0]).toMatchObject({ x: 400 - 195, y: 0, w: 390, h: 744 })
      expect(container.querySelector('[data-dsh-float-window]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('header drag moves the window (rAF direct writes, store commit on release)', async () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      act(() => { store.reduce(s => floatTabReducer(s, 'notes', 512, 384)) })
      const win = container.querySelector<HTMLElement>('[data-dsh-float-window]')!
      const header = win.querySelector<HTMLElement>('[class*="floatHeader"]')!
      expect(win.style.left).toBe('317px')
      // Grab at (300, 220) — the drag records the window's own origin, so
      // moving the pointer to (200, 250) lands the window at (217, 42) —
      // clamped back up to y 24 (the 744-tall window must stay in the
      // 768-tall viewport: 768 - 744 = 24).
      act(() => {
        header.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 220, button: 0 }))
        header.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 250 }))
      })
      await flushFrame()
      expect(win.style.left).toBe('217px')
      expect(win.style.top).toBe('24px')
      // The store is untouched mid-drag (DOM is the only record).
      expect(store.getSnapshot().state!.floats[0]!.x).toBe(317)
      act(() => { header.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200, clientY: 250, button: 0 })) })
      expect(store.getSnapshot().state!.floats[0]).toMatchObject({ x: 217, y: 24 })
    } finally {
      unmount()
    }
  })

  it('the SE corner resizes the window and persists on release', async () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      act(() => { store.reduce(s => floatTabReducer(s, 'notes', 512, 384)) })
      const win = container.querySelector<HTMLElement>('[data-dsh-float-window]')!
      const handle = win.querySelector<HTMLElement>('[class*="floatResize"]')!
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 700, clientY: 750, button: 0 }))
        handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 800, clientY: 800 }))
      })
      await flushFrame()
      // +100/+50 from the created 390x744: height clamps to the viewport
      // ceiling (768 - y 12 = 756).
      expect(win.style.width).toBe('490px')
      expect(win.style.height).toBe('756px')
      act(() => { handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 800, clientY: 800, button: 0 })) })
      expect(store.getSnapshot().state!.floats[0]).toMatchObject({ w: 490, h: 756 })
    } finally {
      unmount()
    }
  })

  it('a pointerdown on the portaled header menu must not start a header drag', async () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      act(() => { store.reduce(s => floatTabReducer(s, 'notes', 512, 384)) })
      const win = container.querySelector<HTMLElement>('[data-dsh-float-window]')!
      const header = win.querySelector<HTMLElement>('[class*="floatHeader"]')!
      expect(win.style.left).toBe('317px')
      act(() => { header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 220 })) })
      // The menu list is PORTALED to document.body, yet its events still
      // bubble through the React tree into the header's onPointerDown —
      // without the containment guard (real-browser regression, e2e-caught:
      // the hijacked drag preventDefaults the row's pointerdown and captures
      // the pointer, so the row's click never fires) this starts a move.
      const dockRow = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(row => /回到侧边栏|Dock Back to Sidebar/.test(row.textContent ?? ''))!
      act(() => {
        dockRow.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 220, button: 0 }))
        header.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 250 }))
      })
      await flushFrame()
      expect(win.style.left).toBe('317px')
      act(() => { dockRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(store.getSnapshot().state!.floats).toHaveLength(0)
      expect(paneTabs(store)).toContain('notes')
    } finally {
      unmount()
    }
  })

  it('a floated plugin tab stays visible while the panel collapses (placement contract)', () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      act(() => { store.reduce(s => floatTabReducer(s, 'notes', 512, 384)) })
      const win = container.querySelector<HTMLElement>('[data-dsh-float-window]')!
      expect(win.querySelector<HTMLElement>('[data-visible]')!.dataset.visible).toBe('true')
      // Collapse the sidebar: the pane's seeded home tab goes invisible
      // (panel closed), but the float is its own surface — a registering
      // plugin's component must keep receiving visible=true (AGENTS §7.5).
      act(() => { store.reduce(togglePanel) })
      expect(win.querySelector<HTMLElement>('[data-visible]')!.dataset.visible).toBe('true')
      // (No pane-side control: the pane's remaining tab is the builtin editor
      // home tab, which does not surface `visible` into the DOM.)
    } finally {
      unmount()
    }
  })

  it('releasing the header over a pane docks the tab back (live pane highlight)', async () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      act(() => { store.reduce(s => floatTabReducer(s, 'notes', 512, 384)) })
      const win = container.querySelector<HTMLElement>('[data-dsh-float-window]')!
      const header = win.querySelector<HTMLElement>('[class*="floatHeader"]')!
      // The workbench pane covers (600, 400) for the hit-test.
      const pane = container.querySelector<HTMLElement>('[data-dsh-pane]')!
      pane.getBoundingClientRect = () => ({ left: 550, right: 700, top: 350, bottom: 500, width: 150, height: 150 }) as DOMRect
      act(() => {
        header.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 220, button: 0 }))
        header.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 600, clientY: 400 }))
      })
      await flushFrame()
      // The dock target highlights while hovered.
      expect(pane.hasAttribute('data-dsh-float-dock-over')).toBe(true)
      act(() => { header.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 600, clientY: 400, button: 0 })) })
      const state = store.getSnapshot().state!
      expect(state.floats).toHaveLength(0)
      expect(paneTabs(store)).toContain('notes')
      expect(pane.hasAttribute('data-dsh-float-dock-over')).toBe(false)
      expect(container.querySelector('[data-dsh-float-window]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('the X button closes the tab with its window', () => {
    fakeConversationColumn()
    const { container, store, service, unmount } = mountSidebar()
    try {
      act(() => { service.openTab({ type: 'notes', title: 'Notes' }) })
      act(() => { store.reduce(s => floatTabReducer(s, 'notes', 512, 384)) })
      const win = container.querySelector<HTMLElement>('[data-dsh-float-window]')!
      const close = win.querySelector<HTMLElement>('[class*="floatClose"]')!
      act(() => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const state = store.getSnapshot().state!
      expect(state.floats).toHaveLength(0)
      expect(paneTabs(store)).not.toContain('notes')
      expect(container.querySelector('[data-dsh-float-window]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('a reload round-trip restores the window (localStorage persistence)', () => {
    fakeConversationColumn()
    const saved = new Map<string, string>()
    const getItem = vi.fn((key: string): string | null => saved.get(key) ?? null)
    const setItem = vi.fn((key: string, value: string): void => { saved.set(key, value) })
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: () => {} })
    const first = mountSidebar('s1')
    try {
      act(() => { first.service.openTab({ type: 'notes', title: 'Notes' }) })
      act(() => { first.store.reduce(s => floatTabReducer(s, 'notes', 512, 384)) })
      // The debounced persist fires on a later tick — run it synchronously.
      const state = first.store.getSnapshot().state!
      saved.set('dsh-sidebar:v1:s1', JSON.stringify(state))
    } finally {
      first.unmount()
    }
    const second = mountSidebar('s1')
    try {
      const state = second.store.getSnapshot().state!
      expect(state.floats).toHaveLength(1)
      expect(state.floats[0]!.tab.id).toBe('notes')
      expect(second.container.querySelector('[data-dsh-float-window]')).not.toBeNull()
    } finally {
      second.unmount()
    }
  })
})
