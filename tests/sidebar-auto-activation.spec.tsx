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
 *
 * "The current conversation" is the native surface's MOUNTED seat
 * (`ctx.sidebarRight.mounted`): the session-list snapshot never carried a
 * current-session field, so the park gate used to read a phantom one and was
 * permanently false. Background jobs are likewise no longer mirrored into that
 * snapshot — the trigger polls the plugin's `jobs.list` route, so a job is
 * delivered by mutating the stubbed registry and advancing the poll.
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
import type { Context, SidebarJobView, SidebarSessionList } from '../src/context-types.ts'

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

/** A subscribable seat observable (mirror of `ISidebarRight.mounted`). */
function makeMountedStore(initial: string | undefined) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: string | undefined): void {
      if (next === snapshot) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

type MountedStore = ReturnType<typeof makeMountedStore>

/** `ctx.sidebarRight`, replaced by a stand-in column: `isExpanded` reports the
 *  current state, `toggleExpanded` flips it and counts the calls, and `mounted`
 *  is the seat observation the shell binds its per-session state to. */
interface NativeColumnFaceSpy {
  isExpanded: () => boolean
  toggleExpanded: () => void
  mounted: MountedStore
  /** The active tab of the active pane (`ISidebarRight.active`). */
  active: () => { id: string; kind: string } | undefined
}

interface NativeColumnSpy {
  face: NativeColumnFaceSpy
  toggles: number
  mounted: MountedStore
  /** The kind of the tab the stand-in column reports as active (mutable). */
  activeKind: string | undefined
}

function makeNativeColumnSpy(expanded: boolean, mounted: string | undefined, activeKind?: string): NativeColumnSpy {
  const spy = {
    toggles: 0,
    expanded,
    activeKind,
    mounted: makeMountedStore(mounted),
    face: {} as NativeColumnFaceSpy,
  }
  spy.face = {
    active: () => spy.activeKind === undefined ? undefined : { id: `tab-${spy.activeKind}`, kind: spy.activeKind },
    isExpanded: () => spy.expanded,
    toggleExpanded: () => {
      spy.toggles += 1
      spy.expanded = !spy.expanded
    },
    mounted: spy.mounted,
  }
  return spy
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
  /** The stubbed `jobs.list` registry, keyed by OWNER session (mutable). */
  jobs: Record<string, SidebarJobView[]>
  /** Per OWNER session: answer `jobs.list` with this failure instead (mutable). */
  failures: Record<string, JobListFailure>
  unmount: () => void
}

/**
 * A refused or failed `jobs.list`: an HTTP status with a raw body (a gateway's
 * HTML refusal page, a JSON envelope, nothing, garbage), a transport failure,
 * or a response the test releases itself (`deferred`).
 */
type JobListFailure =
  | { status: number; body: string }
  | 'network'
  | { deferred: Promise<{ status: number; body: string }> }

let sessionSeq = 0
const mounted: MountedSidebar[] = []
/** Owner sessions the stubbed `jobs.list` route was read for. */
const jobListReads: string[] = []

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

function mountSidebar(
  width: number,
  bottomOpen = false,
  options: { columnExpanded?: boolean; activeKind?: string } = {},
): MountedSidebar {
  setViewport(width)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const sessionId = `auto-activation-${++sessionSeq}`
  const initial: SidebarSessionList = {
    byId: {
      [sessionId]: { id: sessionId, cwd: '/tmp', displayTitle: 'Root' },
    },
  }
  const feed = makeSessionFeed(initial)
  const jobs: Record<string, SidebarJobView[]> = {}
  const failures: Record<string, JobListFailure> = {}
  // The jobs feed is polled through the plugin's own route (0.1.7 removed the
  // snapshot's jobs mirror): the registry below is what a test mutates.
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    if (method !== 'jobs.list') throw new Error(`unexpected fetch ${String(url)}`)
    const body = JSON.parse(String(init?.body)) as { sessionId?: string }
    const owner = body.sessionId ?? ''
    jobListReads.push(owner)
    const failure = failures[owner]
    if (failure === 'network') throw new TypeError('Failed to fetch')
    if (failure !== undefined) {
      const { status, body: raw } = 'deferred' in failure ? await failure.deferred : failure
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(raw) as unknown,
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { jobs: jobs[owner] ?? [] } }),
    } as unknown as Response
  })
  const store = createSidebarStore()
  store.setPrefs({ ...store.getPrefs(), autoOpenSubagent: true, autoOpenJobs: true })
  store.setSession(sessionId)
  store.reduce(state => ({ ...state, bottomOpen }))
  const service = createBetterSidebarService(store)
  const surface = makeNativeSurfaceSpy()
  service.setSurface(surface.surface)
  service.registerTab({ id: 'subagent', title: 'Subagent', component: JumpHarness })
  const column = makeNativeColumnSpy(options.columnExpanded ?? false, sessionId, options.activeKind)
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
    jobs,
    failures,
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
async function publishActivity(sidebar: MountedSidebar, source: ActivitySource): Promise<void> {
  if (source === 'job') {
    await publishJob(sidebar)
    return
  }
  publishSubagent(sidebar)
  flushSubagentDebounce()
}

function publishSubagent(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  act(() => {
    sidebar.feed.set({
      ...before,
      byId: {
        ...before.byId,
        child: {
          id: 'child',
          displayTitle: 'Worker',
          origin: 'subagent',
          parentId: sidebar.sessionId,
          running: true,
        },
      },
    })
  })
}

function flushSubagentDebounce(): void {
  act(() => { vi.advanceTimersByTime(500) })
}

/**
 * Deliver one new job through the polled jobs route: let the mount-time
 * baseline read land, register the job, then advance one poll interval.
 */
async function publishJob(sidebar: MountedSidebar): Promise<void> {
  await flushFeeds()
  sidebar.jobs[sessionIdOf(sidebar)] = [{
    id: 'bash-1',
    kind: 'bash',
    label: 'sleep 30',
    status: 'running',
    startedAt: 1_000,
  }]
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
}

/** The conversation the sidebar is bound to (its own store's session). */
function sessionIdOf(sidebar: MountedSidebar): string {
  return sidebar.store.getSnapshot().sessionId ?? sidebar.sessionId
}

/** Let pending microtasks settle (the polled reads resolve outside timers). */
async function flushFeeds(): Promise<void> {
  for (let tick = 0; tick < 4; tick++) {
    await act(async () => { await Promise.resolve() })
  }
}

/** Switch the conversation to the child session the Tasks page jumped to. */
function switchToChild(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  act(() => {
    sidebar.feed.set({
      ...before,
      byId: {
        ...before.byId,
        child: {
          id: 'child',
          displayTitle: 'Worker',
          origin: 'subagent',
          parentId: sidebar.sessionId,
          running: true,
        },
      },
    })
    // The mounted seat is what moves the conversations: the shell binds its
    // per-session state to it (the session list has no current-session field).
    sidebar.column.mounted.set('child')
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
  ] as const)('$source activation at $width px activates the Tasks page in the native Sidebar', async ({ source, width }) => {
    const sidebar = mountSidebar(width)
    await publishActivity(sidebar, source)
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expectWorkbenchUntouched(sidebar)
    // Parking is the narrow-viewport half of the same promise.
    expect(sidebar.column.toggles).toBe(width < 768 ? 1 : 0)
  })

  it.each(['subagent', 'job'] as const)('%s activation leaves a narrow fullscreen column to the park', async (source) => {
    const sidebar = mountSidebar(390)
    await publishActivity(sidebar, source)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('a narrow column the user already expanded is not closed under them', async () => {
    const sidebar = mountSidebar(390, false, { columnExpanded: true })
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(0)
  })

  it('a page that loads with jobs already running never triggers; the next NEW job does', async () => {
    const sidebar = mountSidebar(1024)
    // The conversation is already running work when the sidebar mounts: the
    // first successful read only ARMS the baseline, it is never "new work".
    sidebar.jobs[sidebar.sessionId] = [{
      id: 'bash-0',
      kind: 'bash',
      label: 'already running',
      status: 'running',
      startedAt: 500,
    }]
    await flushFeeds()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(sidebar.surface.opens).toEqual([])
    // A second, genuinely new job id is what surfaces the Tasks page.
    sidebar.jobs[sidebar.sessionId] = [
      ...sidebar.jobs[sidebar.sessionId] ?? [],
      { id: 'bash-1', kind: 'bash', label: 'sleep 30', status: 'running', startedAt: 1_000 },
    ]
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
  })

  it('a session switch re-arms the job baseline instead of firing on the new session\'s jobs', async () => {
    const sidebar = mountSidebar(1024)
    sidebar.jobs['child'] = [{ id: 'bash-9', kind: 'bash', label: 'child work', status: 'running', startedAt: 10 }]
    switchToChild(sidebar)
    await flushFeeds()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    // The child's pre-existing job belongs to the NEW baseline, not to "new
    // work in the session I am looking at" (the baseline resets on session).
    expect(sidebar.surface.opens).toEqual([])
  })

  it('reads the viewport when the debounced activation fires, not when it arms', () => {
    const sidebar = mountSidebar(1024)
    publishSubagent(sidebar)
    setViewport(390)
    flushSubagentDebounce()
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('leaves an already-open bottom workbench open and untouched', async () => {
    const sidebar = mountSidebar(1024, true)
    await publishActivity(sidebar, 'subagent')
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

/** How many times the stubbed `jobs.list` was read for one owner session. */
function readsFor(sessionId: string): number {
  return jobListReads.filter(owner => owner === sessionId).length
}

/** The refusal page dsh-passwords answers a seat account with (TCH #515). */
const GATEWAY_403_HTML = '<!doctype html><html><body>This feature is only available to the owner account</body></html>'

/**
 * Tracy (TCH e2e v3 X08, 30/09/2026): background activity never takes the column away from the
 * site preview. While `tracy:browser` is the active tab of the on-screen session, a new subagent
 * or job opens nothing (the Tasks page stays one click away in the guide); the topology jump-back
 * is the user's own click and still opens.
 */
describe('a background activation never takes over an active site preview (X08)', () => {
  it.each([
    { source: 'subagent', width: 1024 },
    { source: 'job', width: 1024 },
    { source: 'subagent', width: 390 },
    { source: 'job', width: 390 },
  ] as const)('$source at $width px leaves an active Browser tab in place', async ({ source, width }) => {
    const sidebar = mountSidebar(width, false, { columnExpanded: true, activeKind: 'tracy:browser' })
    await publishActivity(sidebar, source)
    expect(sidebar.surface.opens).toEqual([])
    expect(sidebar.column.toggles).toBe(0)
  })

  it('another active tab still gets the Tasks page', async () => {
    const sidebar = mountSidebar(1024, false, { columnExpanded: true, activeKind: 'files' })
    await publishActivity(sidebar, 'job')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
  })
})

describe('the job poll stops on a 403 (TCH #515)', () => {
  it.each([
    { label: 'gateway HTML page', body: GATEWAY_403_HTML },
    { label: 'JSON error envelope', body: '{"ok":false,"error":{"code":"forbidden","message":"forbidden"}}' },
    { label: 'empty body', body: '' },
    { label: 'malformed JSON', body: '{"ok":' },
  ])('a 403 with a $label is asked once, not every tick for a minute', async ({ body }) => {
    const sidebar = mountSidebar(1024)
    sidebar.failures[sidebar.sessionId] = { status: 403, body }
    const before = readsFor(sidebar.sessionId)
    await flushFeeds()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    // At most the one read already in flight when the failure was installed.
    expect(readsFor(sidebar.sessionId) - before).toBeLessThanOrEqual(1)
    const settled = readsFor(sidebar.sessionId)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(readsFor(sidebar.sessionId)).toBe(settled)
    expect(sidebar.surface.opens).toEqual([])
  })

  it.each([
    { label: '503 (no jobs service)', failure: { status: 503, body: '{"ok":false,"error":{"code":"job-error","message":"not mounted"}}' } },
    { label: '500 HTML', failure: { status: 500, body: '<html>boom</html>' } },
    { label: 'network failure', failure: 'network' as const },
  ])('a $label keeps the poll retrying, and is never read as an empty list', async ({ failure }) => {
    const sidebar = mountSidebar(1024)
    // A job already running when the page loads: the baseline holds it.
    sidebar.jobs[sidebar.sessionId] = [{ id: 'bash-0', kind: 'bash', label: 'x', status: 'running', startedAt: 1 }]
    await flushFeeds()
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    sidebar.failures[sidebar.sessionId] = failure
    const before = readsFor(sidebar.sessionId)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(readsFor(sidebar.sessionId) - before).toBeGreaterThanOrEqual(4)
    // Recovery with the same list: had a failure been read as an empty list,
    // the old job would now look new and open the Tasks page.
    delete sidebar.failures[sidebar.sessionId]
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(sidebar.surface.opens).toEqual([])
    sidebar.jobs[sidebar.sessionId] = [
      ...sidebar.jobs[sidebar.sessionId]!,
      { id: 'bash-1', kind: 'bash', label: 'y', status: 'running', startedAt: 2 },
    ]
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
  })

  it('a refusal for one session does not stop the poll of the session switched to', async () => {
    const sidebar = mountSidebar(1024)
    sidebar.failures[sidebar.sessionId] = { status: 403, body: GATEWAY_403_HTML }
    await flushFeeds()
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    const refusedReads = readsFor(sidebar.sessionId)
    switchToChild(sidebar)
    await flushFeeds()
    const before = readsFor('child')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(readsFor('child') - before).toBeGreaterThanOrEqual(4)
    expect(readsFor(sidebar.sessionId)).toBe(refusedReads)
  })

  it('a refusal that lands after the switch neither stops the new session nor marks the old one', async () => {
    const sidebar = mountSidebar(1024)
    await flushFeeds()
    let release: (answer: { status: number; body: string }) => void = () => {}
    sidebar.failures[sidebar.sessionId] = { deferred: new Promise(resolve => { release = resolve }) }
    // The next tick's read of the first session hangs on the deferred answer.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    switchToChild(sidebar)
    await act(async () => { release({ status: 403, body: GATEWAY_403_HTML }) })
    await flushFeeds()
    const before = readsFor('child')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(readsFor('child') - before).toBeGreaterThanOrEqual(4)
    // Back on the first session its poll resumes: the stale refusal marked nothing.
    delete sidebar.failures[sidebar.sessionId]
    act(() => { sidebar.column.mounted.set(sidebar.sessionId) })
    await flushFeeds()
    const parentBefore = readsFor(sidebar.sessionId)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(readsFor(sidebar.sessionId) - parentBefore).toBeGreaterThanOrEqual(4)
  })

  it('unmounting leaves no poll behind', async () => {
    const sidebar = mountSidebar(1024)
    await flushFeeds()
    sidebar.unmount()
    mounted.splice(mounted.indexOf(sidebar), 1)
    const before = readsFor(sidebar.sessionId)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(readsFor(sidebar.sessionId)).toBe(before)
  })
})
