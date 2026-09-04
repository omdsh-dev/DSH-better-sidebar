/**
 * Real-Sidebar regressions for issue #162: background activity should activate
 * the Tasks page on every viewport, but must not force a narrow full-screen
 * drawer open over the chat.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { allLeaves, createSidebarStore, firstLeaf, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

function makeSessionFeed(initial: SidebarSessionList) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: SidebarSessionList): void {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

type SessionFeed = ReturnType<typeof makeSessionFeed>

interface MountedSidebar {
  store: SidebarStore
  service: BetterSidebarService
  feed: SessionFeed
  unmount: () => void
}

let sessionSeq = 0
const mounted: MountedSidebar[] = []

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

function mountSidebar(width: number, panelOpen = false): MountedSidebar {
  setViewport(width)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const sessionId = `auto-activation-${++sessionSeq}`
  const initial: SidebarSessionList = {
    current: sessionId,
    byId: {
      [sessionId]: { id: sessionId, cwd: '/tmp', displayTitle: 'Root' },
    },
    jobsBySession: { [sessionId]: [] },
  }
  const feed = makeSessionFeed(initial)
  const store = createSidebarStore()
  store.setPrefs({ ...store.getPrefs(), autoOpenSubagent: true, autoOpenJobs: true })
  store.setSession(sessionId)
  store.reduce(state => ({ ...state, panelOpen }))
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'subagent', title: 'Subagent', component: () => null })
  const localeSnapshot = { active: 'en' }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: feed },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx, store })) })
  const result = {
    store,
    service,
    feed,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
  mounted.push(result)
  return result
}

function publishSubagent(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  const sessionId = before.current!
  act(() => {
    sidebar.feed.set({
      ...before,
      byId: {
        ...before.byId,
        child: {
          id: 'child',
          displayTitle: 'Worker',
          origin: 'subagent',
          parentId: sessionId,
          running: true,
        },
      },
    })
  })
}

function flushSubagentDebounce(): void {
  act(() => { vi.advanceTimersByTime(500) })
}

function publishJob(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  const sessionId = before.current!
  act(() => {
    sidebar.feed.set({
      ...before,
      jobsBySession: {
        ...before.jobsBySession,
        [sessionId]: [{
          id: 'bash-1',
          kind: 'bash',
          label: 'sleep 30',
          status: 'running',
          startedAt: 1_000,
        }],
      },
    })
  })
}

function expectSubagentFocused(sidebar: MountedSidebar, panelOpen: boolean): void {
  const state = sidebar.store.getSnapshot().state!
  const right = firstLeaf(state.splits)
  expect(state.panelOpen).toBe(panelOpen)
  expect(state.activePane).toBe(right.id)
  expect(allLeaves(state.splits).flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'subagent')).toHaveLength(1)
  expect(right.tabs.find(tab => tab.id === right.active)?.type).toBe('subagent')
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
  setViewport(1024)
})

describe('Sidebar background-activity auto-activation (#162)', () => {
  it.each([
    { source: 'subagent', width: 390, opens: false },
    { source: 'job', width: 390, opens: false },
    { source: 'subagent', width: 1024, opens: true },
    { source: 'job', width: 1024, opens: true },
  ] as const)('$source activation at $width px sets panelOpen=$opens', ({ source, width, opens }) => {
    const sidebar = mountSidebar(width)
    if (source === 'subagent') {
      publishSubagent(sidebar)
      flushSubagentDebounce()
    } else {
      publishJob(sidebar)
    }
    expectSubagentFocused(sidebar, opens)
  })

  it.each(['subagent', 'job'] as const)('%s activation preserves an already-open narrow drawer', (source) => {
    const sidebar = mountSidebar(390, true)
    if (source === 'subagent') {
      publishSubagent(sidebar)
      flushSubagentDebounce()
    } else {
      publishJob(sidebar)
    }
    expectSubagentFocused(sidebar, true)
  })

  it('uses the current viewport when the delayed subagent activation fires', () => {
    const sidebar = mountSidebar(1024)
    publishSubagent(sidebar)
    setViewport(390)
    flushSubagentDebounce()
    expectSubagentFocused(sidebar, false)
  })
})
