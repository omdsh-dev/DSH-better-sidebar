/**
 * Tasks page interaction tests (jsdom): the jobs drawer's auto-collapse at
 * the agent-count threshold, the graph/tree view toggle visible in BOTH
 * modes, node click → transcript jump, ⓘ → anchored popover, and the
 * settled-leaf fold aggregate expanding on click.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type {
  Context,
  SidebarClientJobsService,
  SidebarJobsSnapshot,
  SidebarProjectionSnapshot,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentAddress,
  SidebarSubagentCatalogEntry,
  SidebarTeamMemberProjection,
  SidebarTeamProjection,
  SidebarTeamTaskView,
} from '../src/context-types.ts'

/** A subscribable sessions-list snapshot (mirror of the runtime list feed). */
function makeStore(initial: SidebarSessionList) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next: SidebarSessionList) {
      snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}

type Store = ReturnType<typeof makeStore>

/** The navigation spy the page must reach (DSH 0.1.7 `ctx.uiWorkspace`). */
interface NavigationSpy {
  opened: Array<SidebarSubagentAddress | string>
}

/**
 * A structurally faithful double of the host's client jobs service: a
 * subscribable snapshot, a reference-counted `watchRows`, an `observe` that
 * records its calls, and a `kill` that records its arguments.
 */
function makeJobsService() {
  let snapshot: SidebarJobsSnapshot = { rows: {}, observed: {} }
  const listeners = new Set<() => void>()
  const observations: Array<{ sessionId: string | undefined; jobId: string }> = []
  const kills: Array<{ sessionId: string; jobId: string }> = []
  const service: SidebarClientJobsService = {
    state: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    watchRows: () => () => {},
    observe: (sessionId: string | undefined, jobId: string) => {
      observations.push({ sessionId, jobId })
      return () => {}
    },
    kill: async (sessionId: string, jobId: string) => { kills.push({ sessionId, jobId }) },
  }
  const emit = (next: Partial<SidebarJobsSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }
  return { service, emit, observations, kills }
}

/** The jobs service the page reads (rebuilt per test in beforeEach). */
let jobsFake: ReturnType<typeof makeJobsService>

/** The client context face SubagentView touches. */
function makeCtx(store: Store, navigation?: NavigationSpy): Context {
  return {
    sessions: {
      list: store,
      refreshProjections: async () => {},
    },
    get: (name: string) => {
      if (name === 'jobs') return jobsFake.service
      if (name === 'uiWorkspace' && navigation !== undefined) {
        return { openSession: (target: SidebarSubagentAddress | string) => { navigation.opened.push(target) } }
      }
      return undefined
    },
  } as unknown as Context
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** A failed `/sidebar/api` envelope (the wire shape `readEnvelope` parses). */
function jsonError(status: number, code: string, message: string): Response {
  return {
    ok: false, status, json: async () => ({ ok: false, error: { code, message } }),
  } as unknown as Response
}

/** The Lead Session's `agentTeam` projection the board reads (undefined = none). */
let teamProjection: SidebarTeamProjection | undefined
const teamMutations: Array<{ method: string; body: Record<string, unknown> }> = []
const fetchedMethods: string[] = []
/** The `subagents.live` payload the stub answers with (session id → live view). */
let livePayload: Record<string, unknown> = {}
/** The folded workflow runs the stub answers `workflows.list` with. */
let runsPayload: unknown[] = []
/** A write rejection the stub answers `teams.taskUpdate` with (undefined = ok). */
let writeRejection: { status: number; code: string; message: string } | undefined

beforeEach(() => {
  teamProjection = undefined
  livePayload = {}
  runsPayload = []
  writeRejection = undefined
  teamMutations.length = 0
  fetchedMethods.length = 0
  jobsFake = makeJobsService()
  jobsFake.emit({
    rows: {
      root: [{ id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 }],
    },
  })
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    fetchedMethods.push(method ?? '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (method === 'subagents.live') return jsonResponse({ ok: true, value: { live: livePayload } })
    if (method === 'workflows.list') return jsonResponse({ ok: true, value: { runs: runsPayload } })
    if (method === 'teams.taskCreate' || method === 'teams.taskUpdate') {
      teamMutations.push({ method: method ?? '', body })
      if (writeRejection !== undefined) {
        return jsonError(writeRejection.status, writeRejection.code, writeRejection.message)
      }
      // 0.1.7 hands back the COMMITTED view (no result union any more).
      return jsonResponse({
        ok: true,
        value: {
          id: 't9', revision: 9, subject: body.subject ?? 'x', description: body.description ?? '',
          status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
        },
      })
    }
    if (method === 'jobs.output') return jsonResponse({ ok: true, value: { text: 'out', truncated: false, read: true } })
    throw new Error(`unexpected fetch ${String(url)}`)
  })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

/**
 * A snapshot with N direct children of root (all settled one-shots). The rows
 * come from the host's `subagentCatalog` projection and each child carries a
 * loaded EMPTY catalog of its own — DSH 0.1.7 rows have no `hasChildren`, so
 * that is what makes them known leaves (and therefore fold candidates).
 */
function snapshotWithChildren(count: number): SidebarSessionList {
  const byId: Record<string, SidebarSessionSummary> = {
    root: { id: 'root', displayTitle: '主会话', running: true },
  }
  const projectionsBySession: Record<string, SidebarProjectionSnapshot> = {}
  const entries: SidebarSubagentCatalogEntry[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `child-${index}`
    byId[id] = { id, displayTitle: id, origin: 'subagent', parentId: 'root', running: false }
    entries.push({ id, createdAt: 1_000 + index, mode: 'one-shot', label: `子代理 ${index}` })
    projectionsBySession[id] = { values: { subagentCatalog: [] }, state: 'ready', error: null }
  }
  projectionsBySession.root = {
    values: { subagentCatalog: entries, ...(teamProjection === undefined ? {} : { agentTeam: teamProjection }) },
    state: 'ready',
    error: null,
  }
  return { byId, projectionsBySession }
}

/**
 * A snapshot whose root ran one workflow with TWO phases (the experiments the
 * status badge and the phase badge read). The members are ordinary catalog
 * children, which the model re-parents under the run node.
 */
function snapshotWithRun(): SidebarSessionList {
  const byId: Record<string, SidebarSessionSummary> = {
    root: { id: 'root', displayTitle: '主会话', running: true },
  }
  const projectionsBySession: Record<string, SidebarProjectionSnapshot> = {}
  const entries: SidebarSubagentCatalogEntry[] = [
    { id: 'm1', createdAt: 1, mode: 'one-shot', label: '审计 A' },
    { id: 'm2', createdAt: 2, mode: 'one-shot', label: '审计 B' },
  ]
  for (const entry of entries) {
    byId[entry.id] = { id: entry.id, displayTitle: entry.id, origin: 'subagent', parentId: 'root', running: false }
    projectionsBySession[entry.id] = { values: { subagentCatalog: [] }, state: 'ready', error: null }
  }
  projectionsBySession.root = {
    values: { subagentCatalog: entries, ...(teamProjection === undefined ? {} : { agentTeam: teamProjection }) },
    state: 'ready',
    error: null,
  }
  return { byId, projectionsBySession }
}


async function flushJobs(): Promise<void> {
  for (let tick = 0; tick < 4; tick++) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('Tasks page interactions', () => {
  it('keeps the jobs drawer open below the agent threshold', async () => {
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // 3 agents (root + 2 children) < 8: the drawer renders its rows open.
    expect(container.textContent).toContain('sleep 300')
    expect(container.textContent).not.toContain('已自动折叠')
    unmount()
  })

  it('auto-collapses the jobs drawer at 8+ agents, expandable by the bar', async () => {
    const store = makeStore(snapshotWithChildren(8))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // 9 agents ≥ 8: collapsed, the auto note explains, no rows rendered.
    expect(container.textContent).not.toContain('sleep 300')
    expect(container.textContent).toContain('已自动折叠')
    const bar = container.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(bar.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { bar.click() })
    expect(container.textContent).toContain('sleep 300')
    unmount()
  })

  it('opens in the TREE by default on a narrow viewport when the mobile switch is on', async () => {
    // jsdom's window is the plugin's mobile bracket here (767 < 768).
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420 })
    try {
      const store = makeStore(snapshotWithChildren(2))
      const sidebar = createSidebarStore()
      sidebar.setPrefs({ ...sidebar.getPrefs(), tasksViewMode: 'graph' })
      const first = renderRoot(
        createElement(SubagentView, {
          sessionId: 'root', active: true, ctx: makeCtx(store), store: sidebar,
        }),
      )
      await flushJobs()
      // The mobile adaptation wins over the wide-viewport default…
      expect(first.container.querySelector('[role="tree"]')).not.toBeNull()
      expect(first.container.querySelector('[role="group"]')).toBeNull()
      // …but the in-page toggle still switches this session's page ad hoc.
      const toGraph = first.container.querySelector('button[aria-label="切换为工作流图"]') as HTMLButtonElement
      await act(async () => { toGraph.click() })
      expect(first.container.querySelector('[role="group"]')).not.toBeNull()
      first.unmount()

      // Disarming the switch restores the settings default (graph) on the same
      // narrow viewport.
      const off = makeStore(snapshotWithChildren(2))
      const offSidebar = createSidebarStore()
      offSidebar.setPrefs({ ...offSidebar.getPrefs(), tasksViewMode: 'graph', mobileDefaultTree: false })
      const second = renderRoot(
        createElement(SubagentView, {
          sessionId: 'root', active: true, ctx: makeCtx(off), store: offSidebar,
        }),
      )
      await flushJobs()
      expect(second.container.querySelector('[role="group"]')).not.toBeNull()
      second.unmount()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    }
  })

  it('toggles between graph and tree with the cluster visible in BOTH modes', async () => {
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    // Default graph: the toggle offers the tree switch.
    const toTree = container.querySelector('button[aria-label="切换为树状图"]') as HTMLButtonElement
    expect(toTree).not.toBeNull()
    expect(container.querySelector('[role="group"]')).not.toBeNull()
    await act(async () => { toTree.click() })
    // Tree mode: the toggle stays (the mockup's hidden-toggle bug is guarded).
    const toGraph = container.querySelector('button[aria-label="切换为工作流图"]') as HTMLButtonElement
    expect(toGraph).not.toBeNull()
    expect(container.querySelector('[role="tree"]')).not.toBeNull()
    await act(async () => { toGraph.click() })
    expect(container.querySelector('[role="group"]')).not.toBeNull()
    unmount()
  })

  it('opens the node detail window on card click; the jump button goes to the transcript', async () => {
    const navigation: NavigationSpy = { opened: [] }
    const store = makeStore(snapshotWithChildren(1))
    const ctx = makeCtx(store, navigation)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx }),
    )
    // Folded by default: unfold so the settled child is visible.
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    await act(async () => { node.click() })
    // The card no longer jumps directly: it IS the detail affordance.
    expect(navigation.opened).toEqual([])
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('节点详情')
    const jump = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('查看转录'))
    expect(jump).toBeDefined()
    await act(async () => { jump?.click() })
    // The workspace face owns main-view selection since 0.1.6; ISessions.openSubagent
    // is gone from the runtime, so that is the call the page must make.
    expect(navigation.opened).toEqual([{ parentSessionId: 'root', childSessionId: 'child-0', mode: 'one-shot' }])
    unmount()
  })

  it('folds settled leaves into an aggregate that expands on click', async () => {
    const store = makeStore(snapshotWithChildren(3))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    // Folded: one aggregate node, no individual children.
    expect(container.textContent).toContain('✓ 3 已完成')
    expect(container.querySelector('[aria-label*="子代理 0"]')).toBeNull()
    const fold = container.querySelector('[aria-label*="✓ 3 已完成"]') as HTMLElement
    await act(async () => { fold.click() })
    expect(container.textContent).toContain('子代理 0')
    expect(container.textContent).toContain('子代理 2')
    unmount()
  })

  it('ships no per-card detail button any more (the card itself is the affordance)', async () => {
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const root = container.querySelector('[data-graph-node="root"]') as HTMLElement
    expect(root).not.toBeNull()
    // A card is a single click target: no nested control inside it.
    expect(root.querySelectorAll('button')).toHaveLength(0)
    await act(async () => { root.click() })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('查看转录')
    unmount()
  })
})

/**
 * The Lead Session's projection for one test run: members + tasks, or absent
 * (`withTeam(null)`) when the tree leads no team. A task omitted from `tasks`
 * is not on the board at all.
 */
function withTeam(input: {
  members?: SidebarTeamMemberProjection[]
  tasks?: SidebarTeamTaskView[]
} | null = {}): void {
  if (input === null) {
    teamProjection = undefined
    return
  }
  teamProjection = {
    members: input.members ?? [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'child-0', name: 'writer', role: 'teammate', phase: 'active' },
    ],
    tasks: input.tasks ?? [],
  }
}

/** One shared task row. */
function teamTask(over: Partial<SidebarTeamTaskView> = {}): SidebarTeamTaskView {
  return {
    id: 't1', revision: 1, subject: '收窄卡片', description: '细节', status: 'in_progress',
    blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...over,
  }
}

describe('Tasks page graph interactions and team board', () => {
  it('activates a graph node after a background pointerdown (no click theft)', async () => {
    const navigation: NavigationSpy = { opened: [] }
    const store = makeStore(snapshotWithChildren(1))
    const ctx = makeCtx(store, navigation)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx }),
    )
    // Unfold so the settled child is visible, then simulate the real gesture
    // order on the canvas background before clicking the node.
    const foldToggle = container.querySelector('[data-graph-controls] button:nth-child(2)') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const canvas = container.querySelector('[role="group"]') as HTMLElement
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    expect(node).not.toBeNull()
    await act(async () => { node.click() })
    // The click is not stolen: the card's own action (its detail window) ran.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(navigation.opened).toEqual([])
    unmount()
  })

  it('never starts a pan from a node (the gesture belongs to the node)', async () => {
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const foldToggle = container.querySelector('[data-graph-controls] button:nth-child(2)') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    const inner = node.parentElement as HTMLElement
    const before = inner.style.transform
    await act(async () => {
      node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 90 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect(inner.style.transform).toBe(before)
    unmount()
  })

  it('shows the team board without any click when the root leads a team', async () => {
    withTeam({ tasks: [teamTask()] })
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    // Visible by default: header, members and the task row (no chip to click).
    expect(container.querySelector('[data-team-board]')).not.toBeNull()
    expect(container.textContent).toContain('团队任务板')
    expect(container.textContent).toContain('lead')
    expect(container.textContent).toContain('writer')
    expect(container.textContent).toContain('收窄卡片')
    unmount()
  })

  it('draws no team surface at all when the root leads no team', async () => {
    withTeam(null)
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-team-board]')).toBeNull()
    expect(container.textContent).not.toContain('团队任务板')
    unmount()
  })
})

describe('Tasks page: owned tasks, host-primitive controls, draggable output', () => {
  /** A board whose two tasks are both owned by the child agent. */
  function teamWithOwnedTask(): void {
    withTeam({
      tasks: [
        teamTask({ subject: '收窄卡片与图标化', ownerName: 'writer' }),
        teamTask({
          id: 't2', revision: 2, subject: '补点击回归', description: '', status: 'pending',
          ownerName: 'writer', blockedBy: ['t1'], ready: false,
        }),
      ],
    })
  }

  it('renders the owned task on its agent node', async () => {
    teamWithOwnedTask()
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    expect(node).not.toBeNull()
    // The node carries the task subject + its status word + the +N tail.
    expect(node.textContent).toContain('收窄卡片与图标化')
    expect(node.textContent).toContain('进行中')
    expect(node.textContent).toContain('+1')
    unmount()
  })

  it('opens the shared task window from a board row (markdown first, no native select)', async () => {
    teamWithOwnedTask()
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    expect(container.querySelectorAll('select')).toHaveLength(0)
    const row = container.querySelector('button[aria-label^="任务详情"]') as HTMLButtonElement
    expect(row).not.toBeNull()
    await act(async () => { row.click() })
    const dialog = document.querySelector('[data-floating-window]') as HTMLElement
    expect(dialog).not.toBeNull()
    // View mode first: the description renders as markdown, edited only on demand.
    expect(dialog.textContent).toContain('细节')
    expect(dialog.querySelector('textarea')).toBeNull()
    const edit = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('编辑'))
    expect(edit).toBeDefined()
    await act(async () => { edit?.click() })
    // Editing turns the SAME window into the multi-line editor.
    const textarea = dialog.querySelector('textarea')
    expect(textarea).not.toBeNull()
    expect(textarea?.getAttribute('aria-label')).toBe('描述')
    unmount()
  })

  it('creates a task through the dialog (host Input + modal) and posts the CAS-free create', async () => {
    teamWithOwnedTask()
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const create = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建任务'))
    expect(create).toBeDefined()
    await act(async () => { create?.click() })
    // The dialog's field is a host Input (rendered as a real <input> inside the modal).
    const field = document.querySelector('input[aria-label="标题"]') as HTMLInputElement
    expect(field).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(field, '新任务标题')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const dialog = document.querySelector('[data-floating-window]') as HTMLElement
    expect(dialog).not.toBeNull()
    const save = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('新建任务'))
    expect(save).toBeDefined()
    expect(field.value).toBe('新任务标题')
    expect((save as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { save?.click() })
    await act(async () => { await Promise.resolve() })
    expect(fetchedMethods).toContain('teams.taskCreate')
    expect(teamMutations[0]?.body.subject).toBe('新任务标题')
    unmount()
  })

  it('opens the job output in the persistent floating window and drags it by its title bar', async () => {
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    const row = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
    await act(async () => { row.click() })
    // The job output is a WINDOW, not the 280px anchored popover: it carries
    // the plugin's frame (a title bar to drag, a scrolling body).
    const frame = document.querySelector('[data-floating-window]') as HTMLElement
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('aria-label')).toBe('sleep 300')
    expect(frame.querySelector('[data-window-body]')).not.toBeNull()
    // An outside click must NOT dismiss it (the window is persistent); Escape does.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()

    const before = { left: frame.style.left, top: frame.style.top }
    const handle = frame.querySelector('[data-window-handle]') as HTMLElement
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40 }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 120 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect({ left: frame.style.left, top: frame.style.top }).not.toEqual(before)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-floating-window]')).toBeNull()
    await act(async () => { unmount() })
  })
})

describe('Tasks page: the shared task window', () => {
  it('opens from an agent node task line and saves a multi-line edit', async () => {
    withTeam({
      tasks: [teamTask({
        revision: 4, description: '第一行\n\n- 第二行', ownerName: 'writer',
      })],
    })
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    const taskLine = node.querySelector('[role="button"]') as HTMLElement
    expect(taskLine).not.toBeNull()
    await act(async () => { taskLine.click() })
    const dialog = document.querySelector('[data-floating-window]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('收窄卡片')
    // Markdown view renders the multi-line body before any editing.
    expect(dialog.querySelector('textarea')).toBeNull()
    const edit = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('编辑'))
    await act(async () => { edit?.click() })
    const area = dialog.querySelector('textarea') as HTMLTextAreaElement
    expect(area.value).toBe('第一行\n\n- 第二行')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(area, '改过的描述')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('保存'))
    await act(async () => { save?.click() })
    await act(async () => { await Promise.resolve() })
    const update = teamMutations.find(entry => entry.method === 'teams.taskUpdate')
    expect(update?.body.action).toBe('edit')
    expect(update?.body.expectedRevision).toBe(4)
    expect(update?.body.description).toBe('改过的描述')
    unmount()
  })

  it('reassigns the owner straight from the window (CAS on the current revision)', async () => {
    withTeam({
      members: [
        { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'child-0', name: 'writer', role: 'teammate', phase: 'active' },
        { id: 'child-1', name: 'reviewer', role: 'teammate', phase: 'active' },
      ],
      tasks: [teamTask({ revision: 7, description: '', status: 'pending', ownerName: 'writer' })],
    })
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('button[aria-label^="任务详情"]') as HTMLButtonElement
    await act(async () => { row.click() })
    const dialog = document.querySelector('[data-floating-window]') as HTMLElement
    const reviewer = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'reviewer')
    expect(reviewer).toBeDefined()
    await act(async () => { reviewer?.click() })
    await act(async () => { await Promise.resolve() })
    const update = teamMutations.find(entry => entry.method === 'teams.taskUpdate')
    expect(update?.body).toMatchObject({ action: 'reassign', owner: 'reviewer', expectedRevision: 7 })
    unmount()
  })

  it('follows the board state machine: claim a queued task, complete a claimed one', async () => {
    withTeam({ tasks: [teamTask({ revision: 4, subject: '收窄卡片', description: '', status: 'pending' })] })
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('button[aria-label^="任务详情"]') as HTMLButtonElement
    await act(async () => { row.click() })
    const dialog = document.querySelector('[data-floating-window]') as HTMLElement
    // The action row is the shell's FOOTER (outside the scrolling body), so it
    // stays put while a long description scrolls.
    const footer = dialog.querySelector('[data-window-footer]') as HTMLElement
    expect(footer).not.toBeNull()
    const button = (label: string): HTMLButtonElement =>
      [...footer.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(label)) as HTMLButtonElement

    // A QUEUED task cannot be completed — the service enforces
    // pending → claim → in_progress → complete, so the window offers claim.
    expect(button('完成')).toBeUndefined()
    const claim = button('认领')
    expect(claim).toBeDefined()

    // A stale revision is a REAL failure the reader must see: 0.1.7 throws a
    // typed rejection, the host maps it to `team-conflict` (409).
    writeRejection = { status: 409, code: 'team-conflict', message: 'stale team task "t1" revision 4' }
    await act(async () => { claim.click() })
    await act(async () => { await Promise.resolve() })
    expect(teamMutations.at(-1)?.body).toMatchObject({ action: 'claim', expectedRevision: 4 })
    expect(dialog.textContent).toContain('已被他人修改')
    // The window stays open on the failed write: nothing was committed.
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()

    // A clean write clears the note.
    writeRejection = undefined
    await act(async () => { claim.click() })
    await act(async () => { await Promise.resolve() })
    expect(dialog.textContent).not.toContain('已被他人修改')
    await act(async () => { unmount() })
  })

  it('refuses to claim a task whose blockers are still open', async () => {
    withTeam({ tasks: [teamTask({ revision: 2, ready: false, status: 'pending' })] })
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('button[aria-label^="任务详情"]') as HTMLButtonElement
    await act(async () => { row.click() })
    const dialog = document.querySelector('[data-floating-window]') as HTMLElement
    const claim = [...dialog.querySelectorAll('[data-window-footer] button')]
      .find(candidate => candidate.textContent?.includes('认领')) as HTMLButtonElement
    // `claim` would be refused with TEAM_TASK_BLOCKED, so it never leaves.
    expect(claim.disabled).toBe(true)
    await act(async () => { unmount() })
  })

  it('hands the window slack to the description instead of leaving it empty', async () => {
    withTeam({ tasks: [teamTask({ subject: '长描述', description: '第一行\n\n第二行' })] })
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('button[aria-label^="任务详情"]') as HTMLButtonElement
    await act(async () => { row.click() })
    const body = document.querySelector('[data-window-body]') as HTMLElement
    // The body declares the FILL layout, so its child column (and the prose in
    // it) grows with the window instead of stacking under a 160px box.
    expect(body.getAttribute('data-window-body-layout')).toBe('fill')
    const described = body.querySelector('[data-task-description]') as HTMLElement
    expect(described).not.toBeNull()
    expect(described.textContent).toContain('第一行')
    expect(body.querySelector('textarea')).toBeNull()
    // Editing swaps in the multi-line field INSIDE the same growing body (the
    // action that switches modes lives in the shell's FOOTER, not the body).
    const frame = document.querySelector('[data-floating-window]') as HTMLElement
    const edit = [...frame.querySelectorAll('button')].find(button => button.textContent?.includes('编辑'))
    await act(async () => { edit?.click() })
    const area = body.querySelector('textarea') as HTMLTextAreaElement
    expect(area).not.toBeNull()
    expect(area.value).toBe('第一行\n\n第二行')
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()
    await act(async () => { unmount() })
  })

  it('closes the task window on Escape, never on an outside click', async () => {
    withTeam({ tasks: [teamTask()] })
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('button[aria-label^="任务详情"]') as HTMLButtonElement
    await act(async () => { row.click() })
    // The window portals to the body: query the DOCUMENT, not the page root.
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-floating-window]')).toBeNull()
    await act(async () => { unmount() })
  })

  it('draws the two-segment card: kind badge + name on top, state bar below', async () => {
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // The tree is folded by default: unfold so the settled children are cards.
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })

    const root = container.querySelector('[data-graph-node="root"]') as HTMLElement
    expect(root.getAttribute('data-depth')).toBe('0')
    // The root is the main agent, a child is a subagent — the page's own words.
    expect(root.textContent).toContain('主代理')
    const child = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    expect(child.getAttribute('data-depth')).toBe('1')
    expect(child.textContent).toContain('子代理')
    // Both segments are present: the identity block and the state bar.
    const bar = child.querySelector('[data-card-bar]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.textContent).toContain('已完成')
    unmount()
  })

  it('marks a running card with data-running (the sweep hook) and never a settled one', async () => {
    livePayload = {
      'child-0': {
        running: true,
        summary: { counts: [{ kind: 'read', count: 2 }], runningDetail: '' },
      },
    }
    // A running child says so in BOTH channels: the live flag is the catalog's
    // session RESIDENCY, the summary's `running` is the authoritative run bit
    // (see the #800 case below for what residency alone means after a restart).
    const snapshot = snapshotWithChildren(2)
    snapshot.byId['child-0']!.running = true
    const store = makeStore(snapshot)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // The global fold is ON by default: unfold so the settled sibling is a card
    // too (the running one is never a fold candidate).
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const child = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    const bar = child.querySelector('[data-card-bar]') as HTMLElement
    expect(bar.getAttribute('data-running')).toBe('true')
    // The merged activity wording comes from the plugin's own copy when the
    // host's chat namespace is absent (this harness attaches no locale).
    expect(bar.textContent).toBeTruthy()
    const settled = container.querySelector('[data-graph-node="child-1"]') as HTMLElement
    expect(settled.querySelector('[data-card-bar]')?.getAttribute('data-running')).toBeNull()
    unmount()
  })

  it('a retained-but-not-running child is NOT a running card (issue #800)', async () => {
    // After a crash-restart, opening an interrupted child's history RETAINS its
    // session without starting an agent: the catalog's `activity` — which the
    // live channel reports as `running` — flips to running while the
    // authoritative summary still says `running: false`. The card must follow
    // the summary; the old reading showed 运行中 (with a live preview line) for a
    // subagent nothing was driving.
    livePayload = { 'child-0': { running: true, text: 'half-finished line' } }
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // Both children are settled now, so the global fold holds them: unfold.
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const child = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    expect(child).not.toBeNull()
    const bar = child.querySelector('[data-card-bar]') as HTMLElement
    expect(bar.getAttribute('data-running')).toBeNull()
    expect(bar.textContent).toContain('已完成')
    unmount()
  })

  it('falls back to the catalog flag when the host carries no summary running bit', async () => {
    // Older hosts: the summary has no `running` field, so the live channel's
    // flag is all there is — the pre-#800 reading must survive.
    livePayload = { 'child-0': { running: true, summary: { counts: [], runningDetail: '' } } }
    const snapshot = snapshotWithChildren(2)
    delete snapshot.byId['child-0']!.running
    const store = makeStore(snapshot)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    const bar = container.querySelector('[data-graph-node="child-0"] [data-card-bar]') as HTMLElement
    expect(bar.getAttribute('data-running')).toBe('true')
    unmount()
  })

  it('folds one settled card into the aggregate from its bar, and expands it back', async () => {
    const store = makeStore(snapshotWithChildren(3))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // The global fold is ON by default, so the settled children are already
    // aggregated; unfolding reveals them as individual cards again.
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    expect(container.querySelector('[data-graph-node="child-0"]')).not.toBeNull()

    const chevron = container.querySelector(
      '[data-graph-node="child-0"] button[aria-label="收进已完成聚合"]',
    ) as HTMLButtonElement
    expect(chevron).not.toBeNull()
    await act(async () => { chevron.click() })
    // The node left the canvas…
    expect(container.querySelector('[data-graph-node="child-0"]')).toBeNull()
    // …and the aggregate says how many it holds.
    const aggregate = container.querySelector('[data-graph-node="fold:root"]') as HTMLElement
    expect(aggregate).not.toBeNull()
    expect(aggregate.textContent).toContain('1')

    // Clicking the aggregate expands EVERYTHING (manual + global folds).
    await act(async () => { aggregate.click() })
    expect(container.querySelector('[data-graph-node="child-0"]')).not.toBeNull()
    expect(container.querySelector('[data-graph-node="fold:root"]')).toBeNull()
    unmount()
  })

  it('gives the waiting members their own aggregate row, and folds one by its chevron', async () => {
    // Three idle teammates meet the idle head count, so they fold — into a row
    // of their OWN: the finished work keeps its "✓ N 已完成" badge and the
    // waiting members say "N 个待命" instead of hiding inside a ✓ count.
    const mate = (index: number): SidebarTeamMemberProjection => ({
      id: `child-${index}`, name: `mate-${index}`, role: 'teammate', phase: 'active',
    })
    withTeam({ members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }, ...[0, 1, 2].map(mate)] })
    const store = makeStore(snapshotWithChildren(3))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    const aggregate = container.querySelector('[data-graph-node="fold:root:idle"]') as HTMLElement
    expect(aggregate).not.toBeNull()
    expect(aggregate.textContent).toContain('3 待命')
    expect(aggregate.textContent).not.toContain('已完成')
    // The finished group is a DIFFERENT row (empty here: nothing is done).
    expect(container.querySelector('[data-graph-node="fold:root"]')).toBeNull()
    unmount()
  })

  it('offers a WAITING card its own fold chevron (idle is foldable by hand)', async () => {
    // Below the idle head count nothing folds automatically; each waiting card
    // still carries the chevron, which is what "点击没反应" was about.
    const mate = (index: number): SidebarTeamMemberProjection => ({
      id: `child-${index}`, name: `mate-${index}`, role: 'teammate', phase: 'active',
    })
    withTeam({ members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }, ...[0, 1].map(mate)] })
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    expect(container.querySelector('[data-graph-node="fold:root:idle"]')).toBeNull()
    const chevron = container.querySelector(
      '[data-graph-node="child-0"] button[aria-label="收进已完成聚合"]',
    ) as HTMLButtonElement
    expect(chevron).not.toBeNull()
    await act(async () => { chevron.click() })
    const aggregate = container.querySelector('[data-graph-node="fold:root:idle"]') as HTMLElement
    expect(aggregate).not.toBeNull()
    expect(aggregate.textContent).toContain('1 待命')
    // The aggregate's badge says 待命 too, so the row never reads as finished.
    expect(aggregate.querySelector('[data-card-kind="fold"]')?.textContent).toBe('N 个待命')
    expect(container.querySelector('[data-graph-node="child-0"]')).toBeNull()
    unmount()
  })

  it('draws COLLAPSE and EXPAND with different glyphs (cluster, card, aggregate)', async () => {
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    /** The icon markup of one control (the glyph is what the reader compares). */
    const glyph = (selector: string): string =>
      container.querySelector(selector)?.querySelector('svg')?.innerHTML ?? ''

    // Folded by default: the cluster's switch offers EXPAND, and it wears the
    // same expand glyph the aggregate card's bar does.
    const expandGlyph = glyph('button[aria-label="展开已完成的节点"]')
    expect(expandGlyph).not.toBe('')
    expect(glyph('[data-graph-node^="fold:"] [data-card-bar]')).toBe(expandGlyph)

    // Unfold: the cards' own control COLLAPSES one node, and it must not share
    // the expand glyph (the reader's report was that both looked identical).
    await act(async () => {
      (container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement).click()
    })
    const collapseGlyph = glyph('[data-graph-node] button[aria-label="收进已完成聚合"]')
    expect(collapseGlyph).not.toBe('')
    expect(collapseGlyph).not.toBe(expandGlyph)
    // The cluster switch flips to the collapse direction with the same glyph.
    expect(glyph('button[aria-label="折叠已完成的节点"]')).toBe(collapseGlyph)
    unmount()
  })

  it('offers no fold chevron on a running card or on the current session', async () => {
    livePayload = { 'child-0': { running: true, summary: { counts: [], runningDetail: '' } } }
    const snapshot = snapshotWithChildren(2)
    snapshot.byId['child-0']!.running = true
    const store = makeStore(snapshot)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    const running = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    expect(running.querySelector('button[aria-label="收进已完成聚合"]')).toBeNull()
    // The root IS the current session: never foldable.
    const root = container.querySelector('[data-graph-node="root"]') as HTMLElement
    expect(root.querySelector('button[aria-label="收进已完成聚合"]')).toBeNull()
    unmount()
  })

  it('never draws the ROOT card its own fold chevron (issue #784)', async () => {
    // The model pushes the root card unconditionally and never consults
    // `foldedIds` for it, so a chevron there can only be a dead control — and
    // it used to appear as soon as the reader stepped INTO a child session
    // (the root is no longer `current`, and a settled root is `foldable`).
    const snapshot = snapshotWithChildren(2)
    snapshot.byId['root']!.running = false
    const store = makeStore(snapshot)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'child-0', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    const root = container.querySelector('[data-graph-node="root"]') as HTMLElement
    expect(root).not.toBeNull()
    expect(root.querySelector('button[aria-label="收进已完成聚合"]')).toBeNull()
    unmount()
  })

  it('never auto-folds a RE-PARENTED run member that is a real branch (issue #784)', async () => {
    // A run member is usually a real catalog node re-parented under the run —
    // not the synthetic leaf the old rule assumed — so the page-level fold used
    // to take its whole subtree with it.
    runsPayload = [{
      runId: 'run-1',
      name: 'audit',
      originSessionId: 'root',
      status: 'running',
      startedSeq: 1,
      startedAt: 0,
      phases: [{
        title: '扫描',
        members: [
          { childId: 'm1', label: '审计 A', seq: 2, phase: '扫描' },
          { childId: 'm2', label: '审计 B', seq: 3, phase: '扫描' },
        ],
      }],
    }]
    const snapshot = snapshotWithRun()
    // m1 keeps a loaded, NON-EMPTY catalog: it is a branching node. The
    // projection map is a Readonly record, so replace it rather than mutate.
    snapshot.projectionsBySession = {
      ...(snapshot.projectionsBySession ?? {}),
      m1: {
        values: { subagentCatalog: [{ id: 'm1c', createdAt: 9, mode: 'one-shot', label: '子任务' }] },
        state: 'ready',
        error: null,
      },
      m1c: { values: { subagentCatalog: [] }, state: 'ready', error: null },
    }
    snapshot.byId['m1c'] = { id: 'm1c', displayTitle: 'm1c', origin: 'subagent', parentId: 'm1', running: false }
    const store = makeStore(snapshot)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // The branching member keeps its card; its settled LEAF sibling still folds
    // into the run's aggregate.
    expect(container.querySelector('[data-graph-node="m1"]')).not.toBeNull()
    expect(container.querySelector('[data-graph-node="m2"]')).toBeNull()
    unmount()
  })

  it('badges a workflow run and its members with the phase they belong to', async () => {
    runsPayload = [{
      runId: 'run-1',
      name: 'audit',
      originSessionId: 'root',
      status: 'running',
      startedSeq: 1,
      startedAt: 0,
      phases: [
        { title: '扫描', members: [{ childId: 'm1', label: '审计 A', seq: 2, phase: '扫描' }] },
        { title: '复核', members: [{ childId: 'm2', label: '审计 B', seq: 3, phase: '复核' }] },
      ],
    }]
    const store = makeStore(snapshotWithRun())
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await flushJobs()
    // The run's members are settled, so the global fold has already gathered
    // them: unfold to see the member cards themselves.
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    // The run node is a card of its own: kind badge 工作流 + its status bar.
    const runNode = container.querySelector('[data-graph-node="run:run-1"]') as HTMLElement
    expect(runNode).not.toBeNull()
    expect(runNode.textContent).toContain('工作流')
    expect(runNode.querySelector('[data-card-bar]')).not.toBeNull()
    // Each member card carries ITS phase badge (the second grouping axis).
    const first = container.querySelector('[data-graph-node="m1"]') as HTMLElement
    const second = container.querySelector('[data-graph-node="m2"]') as HTMLElement
    expect(first.textContent).toContain('扫描')
    expect(second.textContent).toContain('复核')
    expect(first.getAttribute('data-depth')).toBe('2')
    unmount()
  })
})
