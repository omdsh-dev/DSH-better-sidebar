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
 * snapshot — they arrive as whole-set rosters PUSHED by the host's client jobs
 * service, so a job is delivered by publishing a frame.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { allLeaves, createSidebarStore, type SidebarStore, type SidebarTab } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'
import {
  createBetterSidebarService,
  type BetterSidebarService,
  type SidebarSurface,
  type TabComponentProps,
} from '../src/client/service.ts'
import type {
  Context,
  SidebarClientJobsService,
  SidebarJobsSnapshot,
  SidebarJobView,
  SidebarSessionList,
} from '../src/context-types.ts'

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
 *  current state, `toggleExpanded` flips it and counts the calls, `active`
 *  reports the page the reader is looking at, and `mounted` is the seat
 *  observation the shell binds its per-session state to. */
interface NativeColumnSpy {
  face: {
    isExpanded: () => boolean
    toggleExpanded: () => void
    active: () => { kind: string } | undefined
    mounted: MountedStore
  }
  toggles: number
  mounted: MountedStore
}

/**
 * `activeKind` is the kind of the tab on screen: 'editor' stands for anything
 * the reader opened themselves (a file, a diff, a side chat). `mountSidebar`
 * defaults it to the Tasks page itself, so the lanes that pin the
 * activate-and-park promise keep reading a column whose open page the
 * activation is allowed to re-focus.
 */
function makeNativeColumnSpy(
  expanded: boolean,
  mounted: string | undefined,
  activeKind: string | undefined,
): NativeColumnSpy {
  const spy = {
    toggles: 0,
    expanded,
    mounted: makeMountedStore(mounted),
    face: {} as NativeColumnSpy['face'],
  }
  spy.face = {
    isExpanded: () => spy.expanded,
    toggleExpanded: () => {
      spy.toggles += 1
      spy.expanded = !spy.expanded
    },
    active: () => (activeKind === undefined ? undefined : { kind: activeKind }),
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
  /** The client jobs feed the auto-open trigger watches (push rosters). */
  jobs: JobsFeed
  /** The shell's own DOM: the bottom workbench strip renders inside it. */
  container: HTMLDivElement
  unmount: () => void
}

/**
 * The host client jobs service double: `watchRows` opens a reference-counted
 * roster stream and `publish` pushes a whole-set frame through the same
 * subscribe/getSnapshot pair the trigger reads.
 */
interface JobsFeed {
  service: SidebarClientJobsService
  watched: string[]
  released: string[]
  publish(sessionId: string, jobs: readonly SidebarJobView[]): void
}

function makeJobsFeed(): JobsFeed {
  let snapshot: SidebarJobsSnapshot = { rows: {}, observed: {} }
  const listeners = new Set<() => void>()
  const feed: JobsFeed = {
    watched: [],
    released: [],
    service: {
      state: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      watchRows(sessionId: string) {
        feed.watched.push(sessionId)
        return () => { feed.released.push(sessionId) }
      },
      observe: () => () => {},
      kill: async () => {},
    },
    publish(sessionId, jobs) {
      snapshot = { rows: { ...snapshot.rows, ...(jobs.length === 0 ? {} : { [sessionId]: [...jobs] }) }, observed: {} }
      if (jobs.length === 0) {
        const { [sessionId]: _dropped, ...rest } = snapshot.rows
        snapshot = { rows: rest, observed: {} }
      }
      for (const listener of [...listeners]) listener()
    },
  }
  return feed
}

let sessionSeq = 0
const mounted: MountedSidebar[] = []

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

function mountSidebar(
  width: number,
  bottomOpen = false,
  options: { columnExpanded?: boolean; activeKind?: string; prefs?: Record<string, unknown> } = {},
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
  // Background jobs arrive through the host's own client jobs service
  // (`ctx.jobs`): the feed below is what a test pushes rosters into.
  const jobs = makeJobsFeed()
  const store = createSidebarStore()
  store.setPrefs({
    ...store.getPrefs(),
    autoOpenSubagent: true,
    autoOpenJobs: true,
    ...options.prefs,
  })
  store.setSession(sessionId)
  store.reduce(state => ({ ...state, bottomOpen }))
  const service = createBetterSidebarService(store)
  const surface = makeNativeSurfaceSpy()
  service.setSurface(surface.surface)
  service.registerTab({ id: 'subagent', title: 'Subagent', component: JumpHarness })
  const column = makeNativeColumnSpy(
    options.columnExpanded ?? false,
    sessionId,
    options.activeKind ?? 'subagent',
  )
  const localeSnapshot = { active: 'en' }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: feed },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar'
      ? service
      : name === 'sidebarRight' ? column.face : name === 'jobs' ? jobs.service : undefined,
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
    container,
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
 * Deliver one new job: the roster frame the host's client service pushes. The
 * job's start stamp is AFTER the watch began, which is what makes it "new
 * work" rather than a job that was already running when the page mounted.
 */
async function publishJob(sidebar: MountedSidebar): Promise<void> {
  await flushFeeds()
  sidebar.jobs.publish(sessionIdOf(sidebar), [{
    id: 'bash-1',
    kind: 'bash',
    label: 'sleep 30',
    status: 'running',
    startedAt: Date.now() + 1,
  }])
  await flushFeeds()
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

/**
 * The unread dot, wherever it is drawn. The native chip lives in the HOST's
 * tree (the plugin only contributes the `sidebar.right.pane.tab.title`
 * content), so inside this shell the readable carrier is the bottom
 * workbench's own strip; `tests/native-tab-unread.spec.tsx` renders the chip
 * itself and pins that side.
 */
function unreadDots(sidebar: MountedSidebar): Element[] {
  return [...sidebar.container.querySelectorAll(`[aria-label="${t('tabUnread')}"]`)]
}

/** The workbench tab holding one type, or undefined when it is not open there. */
function workbenchTab(sidebar: MountedSidebar, type: string): SidebarTab | undefined {
  return allLeaves(sidebar.store.getSnapshot().state!.bottomSplits)
    .flatMap(leaf => leaf.tabs).find(tab => tab.type === type)
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
    // The NARROW rows disarm the mobile adaptation on purpose: this lane pins
    // the activate-and-park promise, while the suppression the mobile switch
    // adds on narrow viewports has its own test below.
    const sidebar = mountSidebar(width, false, { prefs: { mobileNoAutoOpen: false } })
    await publishActivity(sidebar, source)
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expectWorkbenchUntouched(sidebar)
    // Parking is the narrow-viewport half of the same promise.
    expect(sidebar.column.toggles).toBe(width < 768 ? 1 : 0)
  })

  it.each(['subagent', 'job'] as const)('%s activation leaves a narrow fullscreen column to the park', async (source) => {
    const sidebar = mountSidebar(390, false, { prefs: { mobileNoAutoOpen: false } })
    await publishActivity(sidebar, source)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('a narrow column the user already expanded is not closed under them', async () => {
    const sidebar = mountSidebar(390, false, {
      columnExpanded: true,
      activeKind: 'subagent',
      prefs: { mobileNoAutoOpen: false },
    })
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(0)
  })

  it.each(['subagent', 'job'] as const)(
    'a WIDE column open on another page keeps it: %s activation does not take the column over',
    async (source) => {
      // The takeover gate. The reader is in a document (here: whatever kind the
      // plugin opened for a `.md`) and the agent starts background work — the
      // host's open would focus the Tasks page and throw that document out of
      // view, which is exactly what must not happen.
      const sidebar = mountSidebar(1024, false, { columnExpanded: true, activeKind: 'editor' })
      await publishActivity(sidebar, source)
      // The page is still CREATED — the event is never dropped — but without
      // the focus op (`revealIfOpened: false` is exactly the host's "place it,
      // do not focus it"): that pair is what the takeover gate used to buy by
      // returning early, at the price of losing the page.
      expect(sidebar.surface.opens).toEqual([{
        sessionId: sidebar.sessionId,
        kind: 'subagent',
        params: expect.objectContaining({ title: expect.any(String) }),
        revealIfOpened: false,
      }])
      // No park either: the column stays as the reader left it.
      expect(sidebar.column.toggles).toBe(0)
      // …and the page is announced instead of silently created. (The two
      // CARRIERS of that announcement are pinned by the lanes below and by
      // tests/native-tab-unread.spec.tsx; this lane is the mark itself.)
      expect(sidebar.store.getSnapshot().state!.unread).toEqual(['subagent'])
    },
  )

  it('a gated activation marks the page unread on the bottom strip, and activating it clears the mark', async () => {
    // Both carriers read the same per-session mark, so the workbench strip is
    // where this shell can see it: the Tasks page is open there and the reader
    // is looking at a document in the native column instead.
    const sidebar = mountSidebar(1024, true, { columnExpanded: true, activeKind: 'editor' })
    act(() => {
      sidebar.service.openTab(
        { type: 'subagent', title: 'Tasks', target: 'bottom' },
        { sessionId: sidebar.sessionId },
      )
    })
    const tab = workbenchTab(sidebar, 'subagent')
    expect(tab).toBeDefined()
    expect(unreadDots(sidebar)).toHaveLength(0)

    await publishActivity(sidebar, 'subagent')
    expect(sidebar.store.getSnapshot().state!.unread).toEqual(['subagent'])
    const dots = unreadDots(sidebar)
    expect(dots).toHaveLength(1)
    // Reached through the workbench its own activation path: the click IS the
    // reader looking at the page.
    act(() => { sidebar.service.activateTab(tab!.id, { sessionId: sidebar.sessionId }) })
    expect(sidebar.store.getSnapshot().state!.unread).toEqual([])
    expect(unreadDots(sidebar)).toHaveLength(0)
  })

  it('a column the reader is ALREADY on the Tasks page of raises no dot', async () => {
    // The mark means "there is a page you have not looked at"; the re-focus
    // path below is the reader already looking at it.
    const sidebar = mountSidebar(1024, false, { columnExpanded: true, activeKind: 'subagent' })
    await publishActivity(sidebar, 'subagent')
    expect(sidebar.store.getSnapshot().state!.unread).toEqual([])
    expect(unreadDots(sidebar)).toHaveLength(0)
  })

  it('a normal (revealed) activation raises no dot', async () => {
    // Only the gated open is unread: an activation that really takes the
    // column over has shown the reader the page already.
    const sidebar = mountSidebar(1024, false, { columnExpanded: false, activeKind: 'editor' })
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.store.getSnapshot().state!.unread).toEqual([])
  })

  it('a WIDE column already showing the Tasks page is still re-focused in place', async () => {
    const sidebar = mountSidebar(1024, false, { columnExpanded: true, activeKind: 'subagent' })
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(0)
  })

  it('a COLLAPSED column is not "in use": the page behind it does not block the activation', async () => {
    // Nothing of the reader's is on screen while the column is collapsed, so
    // the switches keep their promise there (the host expands it on open).
    const sidebar = mountSidebar(1024, false, { activeKind: 'editor' })
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
  })

  it('a host without the active-tab face keeps the plain activation', async () => {
    const sidebar = mountSidebar(1024, false, { columnExpanded: true, activeKind: 'editor' })
    // Nothing to compare against is not "the reader is elsewhere".
    delete (sidebar.column.face as { active?: unknown }).active
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
  })

  it('the topology jump-back still takes over a column the reader is using', () => {
    // The node click IS the user asking for the Tasks page, so the takeover
    // gate applies to background activity only.
    const sidebar = mountSidebar(1024, false, { columnExpanded: true, activeKind: 'editor' })
    act(() => {
      sidebar.service.openTab(
        { type: 'subagent', title: 'Tasks', target: 'bottom' },
        { sessionId: sidebar.sessionId },
      )
    })
    switchToChild(sidebar)
    expectNativeTasksOpen(sidebar, 'child')
    expect(sidebar.column.toggles).toBe(0)
  })

  it('a page that loads with jobs already running never triggers; the next NEW job does', async () => {
    const sidebar = mountSidebar(1024)
    // The conversation is already running work when the sidebar mounts: the
    // first frame only ARMS the baseline (and the watch clock filters a job
    // whose start stamp predates it), so it is never "new work".
    sidebar.jobs.publish(sidebar.sessionId, [{
      id: 'bash-0',
      kind: 'bash',
      label: 'already running',
      status: 'running',
      startedAt: Date.now() - 5_000,
    }])
    await flushFeeds()
    expect(sidebar.surface.opens).toEqual([])
    // A second, genuinely new job id is what surfaces the Tasks page.
    sidebar.jobs.publish(sidebar.sessionId, [
      {
        id: 'bash-0',
        kind: 'bash',
        label: 'already running',
        status: 'running',
        startedAt: Date.now() - 5_000,
      },
      { id: 'bash-1', kind: 'bash', label: 'sleep 30', status: 'running', startedAt: Date.now() + 1 },
    ])
    await flushFeeds()
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
  })

  it('a session switch re-arms the job baseline instead of firing on the new session\'s jobs', async () => {
    const sidebar = mountSidebar(1024)
    sidebar.jobs.publish('child', [
      { id: 'bash-9', kind: 'bash', label: 'child work', status: 'running', startedAt: Date.now() + 1 },
    ])
    switchToChild(sidebar)
    await flushFeeds()
    // The child's pre-existing job belongs to the NEW baseline, not to "new
    // work in the session I am looking at" (the baseline resets on session).
    expect(sidebar.surface.opens).toEqual([])
  })

  it('reads the viewport when the debounced activation fires, not when it arms', () => {
    const sidebar = mountSidebar(1024, false, { prefs: { mobileNoAutoOpen: false } })
    publishSubagent(sidebar)
    setViewport(390)
    flushSubagentDebounce()
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('a NARROW viewport suppresses both triggers while the mobile switch is on', async () => {
    // The mobile adaptation defaults to ON: on a phone the Tasks page costs
    // the whole screen, so neither kind of background work may take it over.
    const subagents = mountSidebar(390)
    await publishActivity(subagents, 'subagent')
    expect(subagents.surface.opens).toEqual([])
    await publishActivity(subagents, 'job')
    expect(subagents.surface.opens).toEqual([])

    // Turning the switch off restores the old narrow behaviour: activate, then
    // park the fullscreen column (the existing narrow promise).
    const jobs = mountSidebar(390)
    jobs.store.setPrefs({ ...jobs.store.getPrefs(), mobileNoAutoOpen: false })
    await publishActivity(jobs, 'job')
    expectNativeTasksOpen(jobs, jobs.sessionId)
    expect(jobs.column.toggles).toBe(1)
  })

  it('the mobile switch never touches a WIDE viewport', async () => {
    const sidebar = mountSidebar(1024)
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    // Nothing was parked (there is no fullscreen column to park).
    expect(sidebar.column.toggles).toBe(0)
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
