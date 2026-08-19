/**
 * Sidebar interrupted-drag persistence: an aborted width drag (pointercancel /
 * lostpointercapture) must still push the clamped width into the shared
 * `defaultWidthPercent` setting when cross-session width is enabled.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const settingsUpdateMock = vi.hoisted(() => vi.fn(async () => ({ value: {}, revision: 2 })))

vi.mock('../src/client/api.ts', () => ({
  api: {
    settingsUpdate: settingsUpdateMock,
    sessionCwd: async () => ({ cwd: '/tmp' }),
    agentPtyClose: async () => {},
    ptyClose: async () => {},
  },
  downloadUrl: () => '/sidebar/file',
}))

if (HTMLElement.prototype.setPointerCapture === undefined) {
  HTMLElement.prototype.setPointerCapture = () => {}
}
if (HTMLElement.prototype.hasPointerCapture === undefined) {
  HTMLElement.prototype.hasPointerCapture = () => true
}
if (HTMLElement.prototype.releasePointerCapture === undefined) {
  HTMLElement.prototype.releasePointerCapture = () => {}
}

class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

interface Mounted {
  container: HTMLDivElement
  store: SidebarStore
  service: BetterSidebarService
  unmount: () => void
}

function mountSidebar(): Mounted {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS, openByDefault: true, sidebarWidthPersistent: true })
  store.setSession('drag-persist')
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = {
    current: 'drag-persist',
    byId: { 'drag-persist': { cwd: '/tmp' } },
  }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
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

function firePointer(element: Element, type: string, clientX: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientX', { value: clientX })
  Object.defineProperty(event, 'clientY', { value: 0 })
  act(() => { element.dispatchEvent(event) })
}

beforeEach(() => {
  settingsUpdateMock.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('sidebar interrupted drag persistence', () => {
  it('persists the clamped width when a width drag is cancelled', async () => {
    const { container, store, unmount } = mountSidebar()
    const handle = container.querySelector<HTMLElement>('[data-dsh-panel] [class*="panelResize"]')
    expect(handle).not.toBeNull()

    const initialPercent = store.getPrefs().defaultWidthPercent
    firePointer(handle!, 'pointerdown', 500)
    // Cancel the stream; the only usable coordinate is the cancel position.
    firePointer(handle!, 'pointercancel', 700)
    await act(async () => { await Promise.resolve() })

    const nextPercent = store.getPrefs().defaultWidthPercent
    expect(nextPercent).not.toBe(initialPercent)
    // The store's session width follows the same clamped value.
    const stateWidth = store.getSnapshot().state?.width
    expect(stateWidth).toBeGreaterThan(0)
    expect(settingsUpdateMock).toHaveBeenCalledWith(
      { defaultWidthPercent: nextPercent },
      undefined,
    )

    unmount()
  })
})
