/**
 * Auto-activation regressions for issue #162: background activity (a new
 * subagent, a new background job) activates the Tasks page in DSH's NATIVE
 * right Sidebar — the column the two auto-open switches and the README promise
 * ("wide viewports also expand the sidebar, while narrow full-screen drawers
 * are not forced open"). The plugin's own bottom workbench is NOT that
 * surface: it serves only its own flows (its + menu, the first-expansion
 * auto-terminal), so a background activation must leave it exactly as it was.
 *
 * The narrow half of that promise is a PARK: the host draws the native column
 * fullscreen below 768px and expands it on every open, so the activation places
 * the tab and puts the column back to collapsed (src/client/sidebar/
 * use-host-feeds.ts `activateTasksPage`). The topology jump-back is an explicit
 * user gesture and always takes the host's expansion.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { allLeaves, createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import {
  createBetterSidebarService,
  type BetterSidebarService,
  type SidebarSurface,
  type TabComponentProps,
} from '../src/client/service.ts'
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

/** One recorded native-surface open. */
interface NativeOpen {
  sessionId: string
  kind: string
  params: unknown
  revealIfOpened: boolean
}

/** The native right Sidebar, replaced by a recording stand-in: the shell's
 *  opens must reach THIS surface, not the plugin's own layout. */
interface NativeSurfaceSpy {
  surface: SidebarSurface
  opens: NativeOpen[]
}

function makeNativeSurfaceSpy(): NativeSurfaceSpy {
  const opens: NativeOpen[] = []
  return {
    opens,
    surface: {
      openTab: input => { opens.push({ ...input }) },
      openResource: () => {},
      fileAddress: (sessionId, cwd, path) => `addr://${sessionId}${cwd ?? ''}${path}`,
      close: () => undefined,
      update: () => false,
      activate: () => false,
      has: () => false,
    },
  }
}

/** `ctx.sidebarRight`, replaced by a stand-in column: `isExpanded` reports the
 *  current state, `toggleExpanded` flips it and counts the calls. `expandHost`
 *  models the host's OWN expansion — `openContent` plans `setExpanded(true)` on
 *  every open — which is deliberately NOT counted as a toggle: only the park
 *  and the opt-in auto-collapse move this column from the plugin's side. */
interface NativeColumnSpy {
  face: { isExpanded: () => boolean; toggleExpanded: () => void }
  toggles: number
  expanded: boolean
  expandHost: () => void
}

function makeNativeColumnSpy(expanded: boolean): NativeColumnSpy {
  let isExpanded = expanded
  let toggles = 0
  return {
    face: {
      isExpanded: () => isExpanded,
      toggleExpanded: () => {
        toggles += 1
        isExpanded = !isExpanded
      },
    },
    get toggles() { return toggles },
    get expanded() { return isExpanded },
    expandHost: () => { isExpanded = true },
  }
}

/** Stands in for the Tasks page: its node click is the jump gesture that arms
 *  the shell's jump-back (fired once, like a real click). */
function JumpHarness({ onSubagentJump }: TabComponentProps): ReactNode {
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    onSubagentJump?.('child')
  }, [onSubagentJump])
  return null
}

interface MountedSidebar {
  store: SidebarStore
  service: BetterSidebarService
  feed: SessionFeed
  surface: NativeSurfaceSpy
  column: NativeColumnSpy
  sessionId: string
  unmount: () => void
}

let sessionSeq = 0
const mounted: MountedSidebar[] = []

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

function mountSidebar(
  width: number,
  bottomOpen = false,
  options: { columnExpanded?: boolean; autoCollapse?: boolean } = {},
): MountedSidebar {
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
  store.setPrefs({
    ...store.getPrefs(),
    autoOpenSubagent: true,
    autoOpenJobs: true,
    autoCollapseAfterIdle: options.autoCollapse ?? false,
  })
  store.setSession(sessionId)
  store.reduce(state => ({ ...state, bottomOpen }))
  const service = createBetterSidebarService(store)
  const surface = makeNativeSurfaceSpy()
  const column = makeNativeColumnSpy(options.columnExpanded ?? false)
  // Placing a tab IS the host's expand: mirror that here (uncounted), so the
  // park and the auto-collapse see the same column state a real host gives.
  service.setSurface({
    ...surface.surface,
    openTab: input => {
      surface.opens.push({ ...input })
      column.expandHost()
    },
  })
  service.registerTab({ id: 'subagent', title: 'Subagent', component: JumpHarness })
  const localeSnapshot = { active: 'en' }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: feed },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar'
      ? service
      : name === 'sidebarRight' ? column.face : undefined,
  } as unknown as Context
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx, store })) })
  const result = {
    store,
    service,
    feed,
    surface,
    column,
    sessionId,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
  mounted.push(result)
  return result
}

type ActivitySource = 'subagent' | 'job'

/** Deliver one piece of background activity through the host's own feeds. */
function publishActivity(sidebar: MountedSidebar, source: ActivitySource): void {
  if (source === 'job') {
    publishJob(sidebar)
    return
  }
  publishSubagent(sidebar)
  flushSubagentDebounce()
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

/** The running job from {@link publishJob} settles (the host's next push). */
function settleJob(sidebar: MountedSidebar): void {
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
          status: 'completed',
          detail: 'exit code: 0',
          startedAt: 1_000,
          finishedAt: 2_000,
        }],
      },
    })
  })
}

/** The subagent from {@link publishSubagent} finishes its turn. */
function settleSubagent(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  act(() => {
    sidebar.feed.set({
      ...before,
      byId: {
        ...before.byId,
        child: { ...before.byId.child!, running: false },
      },
    })
  })
}

/** Switch the conversation to the child session the Tasks page jumped to. */
function switchToChild(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  const parent = before.current!
  act(() => {
    sidebar.feed.set({
      ...before,
      current: 'child',
      byId: {
        ...before.byId,
        child: {
          id: 'child',
          displayTitle: 'Worker',
          origin: 'subagent',
          parentId: parent,
          running: true,
        },
      },
    })
  })
}

/** The Tasks page landed in the native right Sidebar (the default open). */
function expectNativeTasksOpen(sidebar: MountedSidebar, sessionId: string): void {
  expect(sidebar.surface.opens).toEqual([{
    sessionId,
    kind: 'subagent',
    params: expect.objectContaining({ title: expect.any(String) }),
    revealIfOpened: true,
  }])
}

/** The plugin's own bottom workbench kept its own state and gained no tab. */
function expectWorkbenchUntouched(sidebar: MountedSidebar, open = false): void {
  const state = sidebar.store.getSnapshot().state!
  expect(state.bottomOpen).toBe(open)
  expect(allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'subagent')).toHaveLength(0)
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
    { source: 'subagent', width: 390 },
    { source: 'job', width: 390 },
    { source: 'subagent', width: 1024 },
    { source: 'job', width: 1024 },
  ] as const)('$source activation at $width px activates the Tasks page in the native Sidebar', ({ source, width }) => {
    const sidebar = mountSidebar(width)
    publishActivity(sidebar, source)
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expectWorkbenchUntouched(sidebar)
    // Parking is the narrow-viewport half of the same promise.
    expect(sidebar.column.toggles).toBe(width < 768 ? 1 : 0)
  })

  it.each(['subagent', 'job'] as const)('%s activation leaves a narrow fullscreen column to the park', (source) => {
    const sidebar = mountSidebar(390)
    publishActivity(sidebar, source)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('a narrow column the user already expanded is not closed under them', () => {
    const sidebar = mountSidebar(390, false, { columnExpanded: true })
    publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(0)
  })

  it('reads the viewport when the debounced activation fires, not when it arms', () => {
    const sidebar = mountSidebar(1024)
    publishSubagent(sidebar)
    setViewport(390)
    flushSubagentDebounce()
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('leaves an already-open bottom workbench open and untouched', () => {
    const sidebar = mountSidebar(1024, true)
    publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expectWorkbenchUntouched(sidebar, true)
  })

  it('the topology jump-back opens the Tasks page for the child session and never parks it', () => {
    const sidebar = mountSidebar(390)
    // The Tasks page the user opened in the workbench (its own + menu) is what
    // arms the jump: its node click records the child session.
    act(() => {
      sidebar.service.openTab(
        { type: 'subagent', title: 'Tasks', target: 'bottom' },
        { sessionId: sidebar.sessionId },
      )
    })
    expect(sidebar.store.getSnapshot().state!.bottomOpen).toBe(true)
    switchToChild(sidebar)
    expectNativeTasksOpen(sidebar, 'child')
    expect(sidebar.column.toggles).toBe(0)
  })
})

/**
 * The opt-in `autoCollapseAfterIdle` half of the same promise: a column the
 * auto-activation pulled OPEN is handed back once the activity settles, while a
 * column the user opened themselves is never touched. The lead-in to every case
 * is a real background feed (job / subagent), so the arm only exists where a
 * real auto-open created one.
 */
describe('Tasks page auto-collapse (autoCollapseAfterIdle)', () => {
  const grace = 3_000

  it('hands a wide column it opened back once the activity settles', () => {
    const sidebar = mountSidebar(1024, false, { autoCollapse: true })
    publishActivity(sidebar, 'job')
    expect(sidebar.column.expanded).toBe(true)
    expect(sidebar.column.toggles).toBe(0)
    // Still running well past the grace period: nothing is taken away.
    act(() => { vi.advanceTimersByTime(grace * 3) })
    expect(sidebar.column.toggles).toBe(0)
    settleJob(sidebar)
    act(() => { vi.advanceTimersByTime(grace) })
    expect(sidebar.column.toggles).toBe(1)
    expect(sidebar.column.expanded).toBe(false)
    // Only the PANEL is given back: the Tasks tab is still placed.
    expect(sidebar.surface.opens).toHaveLength(1)
  })

  it('stays put when the switch is off (the default)', () => {
    const sidebar = mountSidebar(1024)
    publishActivity(sidebar, 'job')
    settleJob(sidebar)
    act(() => { vi.advanceTimersByTime(grace * 3) })
    expect(sidebar.column.toggles).toBe(0)
    expect(sidebar.column.expanded).toBe(true)
  })

  it('never closes a column the user had already expanded', () => {
    const sidebar = mountSidebar(1024, false, { autoCollapse: true, columnExpanded: true })
    publishActivity(sidebar, 'subagent')
    settleSubagent(sidebar)
    act(() => { vi.advanceTimersByTime(grace * 3) })
    expect(sidebar.column.toggles).toBe(0)
    expect(sidebar.column.expanded).toBe(true)
  })

  it('holds the column open while a direct subagent is still running', () => {
    const sidebar = mountSidebar(1024, false, { autoCollapse: true })
    publishActivity(sidebar, 'subagent')
    act(() => { vi.advanceTimersByTime(grace * 3) })
    expect(sidebar.column.toggles).toBe(0)
    settleSubagent(sidebar)
    act(() => { vi.advanceTimersByTime(grace) })
    expect(sidebar.column.toggles).toBe(1)
  })

  it('leaves the narrow park alone — there is nothing to hand back', () => {
    const sidebar = mountSidebar(390, false, { autoCollapse: true })
    publishActivity(sidebar, 'job')
    expect(sidebar.column.toggles).toBe(1)
    settleJob(sidebar)
    act(() => { vi.advanceTimersByTime(grace * 3) })
    expect(sidebar.column.toggles).toBe(1)
  })

  it('re-arms the grace window when the next job starts', () => {
    const sidebar = mountSidebar(1024, false, { autoCollapse: true })
    publishActivity(sidebar, 'job')
    settleJob(sidebar)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(sidebar.column.toggles).toBe(0)
    publishJob(sidebar)
    act(() => { vi.advanceTimersByTime(grace * 3) })
    expect(sidebar.column.toggles).toBe(0)
    settleJob(sidebar)
    act(() => { vi.advanceTimersByTime(grace) })
    expect(sidebar.column.toggles).toBe(1)
  })

  it('does not undo a column the user closed during the grace window', () => {
    const sidebar = mountSidebar(1024, false, { autoCollapse: true })
    publishActivity(sidebar, 'job')
    settleJob(sidebar)
    act(() => { vi.advanceTimersByTime(1_000) })
    act(() => { sidebar.column.face.toggleExpanded() })
    expect(sidebar.column.toggles).toBe(1)
    act(() => { vi.advanceTimersByTime(grace) })
    expect(sidebar.column.toggles).toBe(1)
    expect(sidebar.column.expanded).toBe(false)
  })

  it('is voided by a session switch', () => {
    const sidebar = mountSidebar(1024, false, { autoCollapse: true })
    publishActivity(sidebar, 'job')
    settleJob(sidebar)
    switchToChild(sidebar)
    act(() => { vi.advanceTimersByTime(grace * 3) })
    expect(sidebar.column.toggles).toBe(0)
  })
})
