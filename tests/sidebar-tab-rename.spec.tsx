/**
 * Shell-level guard for the terminal-tab inline rename.
 *
 * tests/tabbar-rename.spec.tsx mounts TabBar DIRECTLY, so it cannot see the
 * wiring between the shell and the strip — a `canRenameTab` that never
 * reaches Workbench (no editor opens) or a `renameTab` action that never
 * reaches the store (the typed name is dropped) passes there untouched.
 * This suite drives the REAL Sidebar shell instead:
 *
 * - double-click → type → Enter lands the new title in the session layout
 *   (store state, which is what persistence writes), and
 * - a pinned VIRTUAL tab (a projection of another session's tab) routes its
 *   rename to the HOME session rather than no-op'ing against the viewer's
 *   own tree.
 *
 * Harness mirrors tests/agent-wait-badge.spec.tsx (real shell + fake context
 * + stubbed WebSocket).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import {
  createSidebarStore, openTabInBottomPane, setTabPin, type SidebarTab,
} from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'

/** jsdom has no WebSocket; the host-feed effects construct them on mount. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
}

/** Unique per-test session ids (the store persists per session to localStorage). */
let sessionSeq = 0

const mounted: Array<() => void> = []

function mountSidebar(sessionId: string): { container: HTMLDivElement; store: ReturnType<typeof createSidebarStore>; service: BetterSidebarService } {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.instances = []
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Stub the terminal descriptor: the real one lazy-loads the xterm chunk,
  // which jsdom cannot fetch. The rename lives in the TAB STRIP, so the view
  // component is irrelevant here.
  service.registerTab({
    id: 'terminal',
    title: () => 'Terminal',
    component: () => null,
  })
  store.setSession(sessionId)
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = {
    current: sessionId,
    byId: { [sessionId]: { cwd: '/tmp' } },
  }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  }
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  mounted.push(() => {
    act(() => { root.unmount() })
    container.remove()
  })
  return { container, store, service }
}

afterEach(() => {
  // Unmount BEFORE wiping the DOM so the shell's effect cleanups (store
  // subscription, host-feed sockets, persistence debounce) actually run.
  for (const unmount of mounted.splice(0).reverse()) unmount()
  document.body.innerHTML = ''
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear()
  } catch {
    // Opaque origin / no storage: nothing persisted to clear.
  }
  vi.unstubAllGlobals()
})

/** Type into the React-controlled rename input one character at a time. */
function typeText(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  for (const ch of text) {
    setter.call(input, input.value + ch)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

/** Double-click the tab label carrying `title` and return the rename editor. */
function openRenameEditor(container: HTMLElement, title: string): HTMLInputElement {
  const label = [...container.querySelectorAll('span')].find(el => el.textContent === title)
  expect(label).toBeDefined()
  act(() => { label!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
  const input = container.querySelector('input')
  expect(input).not.toBeNull()
  return input as HTMLInputElement
}

/** Commit `title` through the open editor (Enter). */
function commitRename(input: HTMLInputElement, title: string): void {
  act(() => { typeText(input, title) })
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
}

/** The title of one tab in a session's bottom workbench (undefined when the
 *  tab is not open there). Id-keyed: the shell auto-opens a default terminal
 *  tab of its own, so whole-list assertions would be brittle. */
function tabTitle(store: ReturnType<typeof createSidebarStore>, sessionId: string, tabId: string): string | undefined {
  const state = store.getSessionStates().get(sessionId)
  if (state === undefined) return undefined
  const walk = (node: typeof state.bottomSplits): string | undefined => {
    if (node.kind === 'leaf') return node.tabs.find(tab => tab.id === tabId)?.title
    for (const child of node.children) {
      const found = walk(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(state.bottomSplits)
}

describe('Sidebar terminal-tab rename (shell wiring)', () => {
  it('commits a renamed terminal tab into the session layout', () => {
    const sessionId = `rename-${++sessionSeq}`
    const { container, store } = mountSidebar(sessionId)
    const tab: SidebarTab = { id: 'terminal:manual-1', type: 'terminal', title: 'Terminal 1' }
    act(() => { store.reduce(s => openTabInBottomPane(s, tab)) })

    commitRename(openRenameEditor(container, 'Terminal 1'), ' dev server')

    // patchTab persisted the label with the layout (the store is what the
    // 200 ms debounce writes to localStorage).
    expect(tabTitle(store, sessionId, tab.id)).toBe('Terminal 1 dev server')
    expect(container.querySelector('input')).toBeNull()
  })

  it('does not open the editor for tabs that own their label', () => {
    const sessionId = `rename-skip-${++sessionSeq}`
    const { container, store } = mountSidebar(sessionId)
    act(() => {
      store.reduce(s => openTabInBottomPane(s, { id: 'editor:/tmp/a.ts', type: 'editor', title: 'a.ts' }))
    })

    const label = [...container.querySelectorAll('span')].find(el => el.textContent === 'a.ts')
    expect(label).toBeDefined()
    act(() => { label!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(container.querySelector('input')).toBeNull()
  })

  it('routes a pinned virtual tab rename to its HOME session', () => {
    // One store, two sessions: `home` owns a globally pinned terminal, and
    // the viewer sees it as a virtual tab in its own strip.
    const homeSessionId = `rename-home-${++sessionSeq}`
    const viewerSessionId = `rename-viewer-${++sessionSeq}`
    const { container, store } = mountSidebar(viewerSessionId)
    const homeTab: SidebarTab = { id: 'terminal:home-1', type: 'terminal', title: 'Deploy shell' }
    // reduceFor loads the target session's state on demand; the viewer was
    // never switched to `home`, exactly like a pinned tab opened elsewhere.
    store.reduceFor(homeSessionId, s => setTabPin(openTabInBottomPane(s, homeTab), homeTab.id, { scope: 'global' }))
    // reduceFor deliberately does NOT notify (a targeted open must not move
    // the active session), so bounce through the home session and back to
    // make the shell re-derive its pinned projection.
    act(() => { store.setSession(homeSessionId) })
    act(() => { store.setSession(viewerSessionId) })
    expect(container.textContent).toContain('Deploy shell')

    commitRename(openRenameEditor(container, 'Deploy shell'), ' prod')

    // The rename landed in the HOME session's layout, not the viewer's.
    expect(tabTitle(store, homeSessionId, homeTab.id)).toBe('Deploy shell prod')
    expect(tabTitle(store, viewerSessionId, homeTab.id)).toBeUndefined()
    expect(tabTitle(store, viewerSessionId, `pinned:${homeSessionId}:${homeTab.id}`)).toBeUndefined()
  })
})
