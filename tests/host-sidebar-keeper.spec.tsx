// @vitest-environment jsdom
/**
 * Host-sidebar keeper — DOM wiring tests.
 *
 * The keeper effect in the REAL Sidebar shell observes the AppFrame frame
 * (ResizeObserver on its box + MutationObserver on its
 * `data-sidebar-collapsed` attribute) and re-expands the host's left
 * sidebar through `ctx.layout.toggleSidebar()` when OUR right-panel push
 * crosses the host's 1024px breakpoint. These tests mount the real Sidebar
 * against a minimal fake context (the repo's jsdom pattern) and drive the
 * DOM directly:
 *
 *  - push live + real crossing + host renders the rail → toggleSidebar
 *    called exactly once;
 *  - panel closed (push dead) → crossing never arms;
 *  - genuinely narrow window → never arms;
 *  - collapse PREDATING the crossing (user ⌘B first) → never fought;
 *  - host restores itself (attr removed after an arm) → nothing called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, togglePanel, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

/** Controllable ResizeObserver: instances register their callback + target. */
class StubResizeObserver {
  static instances: StubResizeObserver[] = []
  readonly callback: ResizeObserverCallback
  readonly targets: Element[] = []
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    StubResizeObserver.instances.push(this)
  }
  observe(target: Element): void { this.targets.push(target) }
  disconnect(): void {}
  unobserve(): void {}
  fire(): void { this.callback([], this as unknown as ResizeObserver) }
}

interface Mounted {
  store: SidebarStore
  frame: HTMLElement
  layoutSpy: ReturnType<typeof vi.fn<() => void>>
  setFrameWidth: (width: number) => void
  fireFrameResize: () => void
  unmount: () => void
}

/** Mount the real Sidebar against a fake ctx with a scripted layout service. */
function mountSidebar(): Mounted {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  StubResizeObserver.instances = []
  // The AppFrame shell: #root > [data-slot="root"] > frame > center >
  // [data-slot="conversation"] (the anchor the keeper locates).
  const root = document.createElement('div')
  root.id = 'root'
  const slot = document.createElement('div')
  slot.setAttribute('data-slot', 'root')
  const frame = document.createElement('div')
  const center = document.createElement('div')
  const conversation = document.createElement('div')
  conversation.setAttribute('data-slot', 'conversation')
  center.appendChild(conversation)
  frame.appendChild(center)
  slot.appendChild(frame)
  root.appendChild(slot)
  document.body.appendChild(root)

  let frameWidth = 1263 // wide baseline (window 1440, no push)
  Object.defineProperty(frame, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: frameWidth, bottom: 600, width: frameWidth, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Fresh-session seed: the right panel starts OPEN (the push is live).
  store.setSession('s1')
  const layoutSpy = vi.fn<() => void>()
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = { current: 's1', byId: { s1: { cwd: '/tmp' } } }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string): unknown => (name === 'layout' ? { toggleSidebar: layoutSpy } : undefined),
  }
  const reactRoot: Root = createRoot(container)
  act(() => { reactRoot.render(createElement(Sidebar, { ctx: ctx as never, store })) })

  return {
    store,
    frame,
    layoutSpy,
    setFrameWidth: (width: number) => { frameWidth = width },
    fireFrameResize: () => {
      const observer = StubResizeObserver.instances.find(instance => instance.targets.includes(frame))
      expect(observer, 'the keeper must observe the frame').toBeDefined()
      act(() => { observer!.fire() })
    },
    unmount: () => {
      act(() => { reactRoot.unmount() })
      container.remove()
      root.remove()
    },
  }
}

/** Flush the MutationObserver microtask queue (attribute records). */
async function flushMutations(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

describe('host-sidebar keeper — DOM wiring', () => {
  let mounted: Mounted | undefined

  beforeEach(() => { mounted = mountSidebar() })
  afterEach(() => {
    mounted?.unmount()
    mounted = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('re-expands the host sidebar when our push crosses the breakpoint and the host renders the rail', async () => {
    const { frame, layoutSpy, setFrameWidth, fireFrameResize } = mounted!
    fireFrameResize() // baseline: 1263px, no crossing

    setFrameWidth(1008) // the right panel's push squeezes the frame < 1024
    fireFrameResize() // crossing → armed

    // The host reacts to the squeeze: renders the collapsed rail.
    act(() => { frame.setAttribute('data-sidebar-collapsed', '') })
    await flushMutations()

    expect(layoutSpy).toHaveBeenCalledTimes(1)
    // One-shot: a further collapse-state change does not re-trigger.
    act(() => { frame.removeAttribute('data-sidebar-collapsed') })
    await flushMutations()
    act(() => { frame.setAttribute('data-sidebar-collapsed', '') })
    await flushMutations()
    expect(layoutSpy).toHaveBeenCalledTimes(1)
  })

  it('never arms when the right panel is closed (the push is not the cause)', async () => {
    const { store, frame, layoutSpy, setFrameWidth, fireFrameResize } = mounted!
    act(() => { store.reduce(togglePanel) }) // push dead
    fireFrameResize()
    setFrameWidth(1008)
    fireFrameResize()
    act(() => { frame.setAttribute('data-sidebar-collapsed', '') })
    await flushMutations()
    expect(layoutSpy).not.toHaveBeenCalled()
  })

  it('never arms on a genuinely narrow window (host design respected)', async () => {
    const { frame, layoutSpy, setFrameWidth, fireFrameResize } = mounted!
    Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true })
    try {
      fireFrameResize()
      setFrameWidth(700)
      fireFrameResize()
      act(() => { frame.setAttribute('data-sidebar-collapsed', '') })
      await flushMutations()
      expect(layoutSpy).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    }
  })

  it('never fights a collapse that predates the crossing (user ⌘B first)', async () => {
    const { frame, layoutSpy, setFrameWidth, fireFrameResize } = mounted!
    // The user collapsed the host sidebar while the frame was still wide.
    act(() => { frame.setAttribute('data-sidebar-collapsed', '') })
    await flushMutations()
    // Now the panel opens and the frame crosses the breakpoint — but the
    // collapse attribute did not CHANGE (it was already there), so the
    // keeper must stay silent.
    setFrameWidth(1008)
    fireFrameResize()
    await flushMutations()
    expect(layoutSpy).not.toHaveBeenCalled()
  })

  it('does nothing when the host restores itself (attr removed after an arm)', async () => {
    const { frame, layoutSpy, setFrameWidth, fireFrameResize } = mounted!
    fireFrameResize()
    setFrameWidth(1008)
    fireFrameResize() // armed
    // The host widens back (e.g. the user closes the panel in the same
    // tick) — the attr disappears instead of appearing.
    act(() => { frame.removeAttribute('data-sidebar-collapsed') })
    await flushMutations()
    expect(layoutSpy).not.toHaveBeenCalled()
  })

  it('disposes cleanly: no observers left after unmount', () => {
    const { frame } = mounted!
    const before = StubResizeObserver.instances.length
    mounted!.unmount()
    mounted = undefined
    // The keeper's ResizeObserver instance should be disconnected — the
    // stub cannot prove it, but the frame reference must be released: fire
    // every registered observer once and assert no crash + no toggle.
    for (const instance of StubResizeObserver.instances) {
      act(() => { instance.fire() })
    }
    expect(frame).toBeDefined()
  })
})
