/**
 * Bottom-panel first-expand auto-terminal tests — the TRIGGER CHAIN behind
 * issue #42 (bottom panel first expand + auto terminal → whole panel blank).
 *
 * #42's crash itself was the zero-size xterm open (the same root cause as
 * #25, fixed by openWhenSized — see tests/open-when-sized.spec.ts), and the
 * "whole panel blank" amplification is covered by the per-tab containment
 * tests (tests/sidebar-crash.spec.tsx). What no test pinned was the trigger:
 * the Sidebar effect that opens a terminal tab the FIRST time the bottom
 * panel expands (`bottomOpenedOnce`), its pref / enable-switch gates, and
 * the once-per-session semantics. These tests render the REAL Sidebar shell
 * against a minimal fake context (the repo's jsdom pattern) and drive the
 * bottom panel through the store, asserting the tab lands in the bottom
 * workbench, renders, and the panel itself survives.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { Sidebar } from '../src/client/Sidebar.tsx'
import { allLeaves, createSidebarStore, toggleBottomPanel, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { t } from '../src/client/locales.ts'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

interface MountedSidebar {
  container: HTMLDivElement
  store: SidebarStore
  service: BetterSidebarService
  unmount: () => void
}

/** Mount the real Sidebar shell against a minimal context (real store + service). */
function mountSidebar(): MountedSidebar {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Fresh-session seed: the right panel starts OPEN, the bottom panel closed
  // (bottomOpen false → the first expansion is a false→true TRANSITION).
  store.setSession('s1')
  // useSyncExternalStore requires STABLE snapshots across calls (the real DSH
  // services return stable objects) — a fresh object per call loops forever.
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = {
    current: 's1',
    // cwd present → api.sessionCwd is never called in these tests.
    byId: { s1: { cwd: '/tmp' } },
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

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** Every tab currently living in the bottom workbench. */
function bottomTabs(store: SidebarStore): Array<{ type: string; title: string }> {
  const state = store.getSnapshot().state
  if (state === undefined) return []
  return allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
}

/** The stub terminal tab: counts renders so the test can see it actually mount. */
function registerStubTerminal(service: BetterSidebarService, renders: { count: number }): void {
  service.registerTab({
    id: 'terminal',
    title: () => 'Terminal',
    component: () => {
      renders.count += 1
      return createElement('div', null, 'terminal-stub-content')
    },
  })
}

describe('bottom-panel first-expand auto terminal (issue #42 trigger chain)', () => {
  it('auto-opens exactly one terminal tab in the bottom workbench on the FIRST expansion', () => {
    const { container, store, service } = mountSidebar()
    const renders = { count: 0 }
    registerStubTerminal(service, renders)

    act(() => { store.reduce(toggleBottomPanel) })

    const state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    // The once-flag is set atomically with the first fire.
    expect(state.bottomOpenedOnce).toBe(true)
    // The terminal tab landed in the BOTTOM workbench (the effect pins the
    // active pane to the bottom tree's first leaf before opening).
    expect(bottomTabs(store).map(tab => tab.type)).toEqual(['terminal'])
    // The tab actually mounted and rendered — the chain is live end to end.
    expect(renders.count).toBeGreaterThanOrEqual(1)
    expect(container.textContent).toContain('terminal-stub-content')
    // The panel itself survived (the #42 symptom was a WHOLE blank panel):
    // the close control is present and the layout push for the bottom panel
    // height is live.
    expect(container.querySelector(`[aria-label="${t('collapseBottomPanel')}"]`)).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--dsh-sidebar-height')).toBe(
      `${state.bottomHeight}px`,
    )
  })

  it('never repeats the auto-open on later expansions (once per session)', () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })

    act(() => { store.reduce(toggleBottomPanel) })
    expect(bottomTabs(store)).toHaveLength(1)

    // Collapse → expand again: the once-flag suppresses any second terminal.
    act(() => { store.reduce(toggleBottomPanel) })
    expect(store.getSnapshot().state!.bottomOpen).toBe(false)
    act(() => { store.reduce(toggleBottomPanel) })
    expect(bottomTabs(store)).toHaveLength(1)
  })

  it('does not auto-open when the bottomPanelAutoTerminal pref is off', () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    // setPrefs REPLACES the prefs record — spread the current one so only
    // the toggle moves.
    act(() => { store.setPrefs({ ...store.getPrefs(), bottomPanelAutoTerminal: false }) })

    act(() => { store.reduce(toggleBottomPanel) })
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
    expect(bottomTabs(store)).toHaveLength(0)
  })

  it('does not auto-open when the terminal tab type is disabled in settings', () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    act(() => { store.setPrefs({ ...store.getPrefs(), tabsEnabled: { terminal: false } }) })

    act(() => { store.reduce(toggleBottomPanel) })
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
    expect(bottomTabs(store)).toHaveLength(0)
  })
})
