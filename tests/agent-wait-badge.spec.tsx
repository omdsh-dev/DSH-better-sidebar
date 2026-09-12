/**
 * The agent-terminal wait badge chain, end to end in jsdom: the host's
 * agent-terminals push (mirroring the real /sidebar/ws/agent-terminals
 * frames) reconciles tabs AND the wait map; the shell's tabBadgeOf renders
 * the hourglass pill on the agent tab while a wait is live and drops it
 * when the push clears. Harness mirrors tests/bottom-auto-terminal.spec.tsx
 * (real Sidebar shell + fake context + stubbed WebSocket).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, openTabInBottomPane } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
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

/** Unique per-test session ids (see the comment inside mountSidebar). */
let sessionSeq = 0

/** Roots mounted by the current test; afterEach unmounts them (reverse
 *  order) so React effect cleanup (store subscription, host-feed sockets,
 *  debounced persistence) actually runs between tests. */
const mounted: Array<() => void> = []

function mountSidebar(): { container: HTMLDivElement; store: ReturnType<typeof createSidebarStore>; service: BetterSidebarService; unmount: () => void } {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.instances = []
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Replace the terminal descriptor with a stub: the real one lazy-loads the
  // xterm chunk, which jsdom cannot fetch — the badge under test renders in
  // the TAB STRIP, independent of the view component.
  service.registerTab({
    id: 'terminal',
    title: () => 'Terminal',
    component: () => null,
  })
  // Unique session per test — the store persists per-session state to
  // localStorage (200ms debounce); a shared id lets a previous test's late
  // write leak into this store's setSession restore.
  const sessionId = `s1-${++sessionSeq}`
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
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  mounted.push(unmount)
  return { container, store, service, unmount }
}

afterEach(() => {
  // Unmount BEFORE wiping the DOM: root.unmount() must run the shell's
  // effect cleanups (store subscription, WS close, persistence debounce);
  // document.body.innerHTML = '' alone leaves them alive into later tests.
  for (const unmount of mounted.splice(0).reverse()) unmount()
  document.body.innerHTML = ''
  // Belt and braces (same as bottom-auto-terminal): drop any persisted layout
  // a pending 200ms debounce write left behind between tests. Fully guarded —
  // some node/jsdom combos expose no working localStorage, and an opaque
  // origin can define it as a THROWING accessor, so even `typeof` can throw;
  // the try/catch keeps the cleanup hook itself failure-proof.
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear()
  } catch {
    // Opaque origin / no storage: nothing persisted to clear.
  }
  vi.unstubAllGlobals()
})

/** The agent-terminals push socket the shell opened for the current session. */
function feedsSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find(candidate => candidate.url.includes('/sidebar/ws/agent-terminals'))
  if (socket === undefined) throw new Error('agent-terminals socket not connected')
  return socket
}

describe('agent terminal wait badge (push → state → tab pill)', () => {
  it('shows ⏳ on the agent tab while a wait is active and drops it when it ends', () => {
    const { container } = mountSidebar()
    const terminal = { uuid: 'u1', title: 'dev server', command: '', exited: false }
    // First push: the agent tab lands in the active pane.
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([terminal]) }) })
    expect(container.textContent).toContain('dev server')
    expect(container.textContent).not.toContain('⏳')
    // Second push carries a live wait → the hourglass pill appears.
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([{ ...terminal, waiting: { needle: 'READY_1', since: 1 } }]) }) })
    expect(container.textContent).toContain('⏳')
    // The wait resolved (skip/exit/abort all converge to a waiting-less push).
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([terminal]) }) })
    expect(container.textContent).not.toContain('⏳')
  })

  it('shows ⏳ only on agent tabs, never on UI-owned terminal tabs', () => {
    const { container, store } = mountSidebar()
    // A UI-owned terminal tab (id NOT agent:) lives in the strip too; the
    // badge lookup keys on the agent uuid, so it never badges.
    act(() => { store.reduce(s => openTabInBottomPane(s, { id: 'terminal:manual-1', type: 'terminal', title: 'UI terminal' })) })
    const terminal = { uuid: 'u1', title: 'dev server', command: '', exited: false }
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([{ ...terminal, waiting: { needle: 'READY_1', since: 1 } }]) }) })
    // Exactly ONE hourglass: the agent tab. (Counted from textContent — CSS
    // module class names are not stable under the test transform.)
    expect((container.textContent?.match(/⏳/g) ?? []).length).toBe(1)
    // The wait resolved → the pill disappears entirely.
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([terminal]) }) })
    expect(container.textContent).not.toContain('⏳')
  })
})
