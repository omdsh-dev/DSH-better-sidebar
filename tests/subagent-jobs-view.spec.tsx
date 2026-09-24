/**
 * Tasks page tests: the projection-backed topology (branch expansion inferred
 * from the child's OWN catalog, the `mode: 'unknown'` row, navigation through
 * the workspace face, catalog retry through the 0.1.7 refresh name) and the
 * background-jobs DRAWER — rows read through the plugin's `jobs.list` route
 * one session at a time (the registry's access fence admits a job to its OWNER
 * only), clicking a row peeks its output in an anchored popover (portaled to
 * document.body) through `jobs.output` with the owner scope, the kill button
 * needs a two-click confirm, settled rows offer no kill, and nothing polls
 * while the page is hidden.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import type {
  Context,
  SidebarJobView,
  SidebarSessionList,
  SidebarSubagentAddress,
  SidebarSubagentCatalogEntry,
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
 * The client context face SubagentView touches. Navigation rides the
 * workspace face: 0.1.6 moved main-view selection off `ISessions`, so a spy
 * left on `sessions.openSubagent` would never fire.
 */
function makeCtx(store: Store, navigation?: NavigationSpy): Context {
  return {
    sessions: { list: store },
    get: (name: string) => (name === 'uiWorkspace' && navigation !== undefined
      ? { openSession: (target: SidebarSubagentAddress | string) => { navigation.opened.push(target) } }
      : undefined),
  } as unknown as Context
}

const outputCalls: Array<{ sessionId: string; id: string }> = []
const killCalls: Array<{ sessionId: string; id: string }> = []
/** Job lists the stubbed `jobs.list` route answers with, keyed by OWNER session. */
let jobsByOwner: Record<string, SidebarJobView[]> = {}
/** The owner sessions the page actually read (the fence's unit of access). */
let jobListCalls: string[] = []

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** One `subagentCatalog` projection row (DSH 0.1.7 shape). */
function entry(
  id: string,
  mode: SidebarSubagentCatalogEntry['mode'],
  label?: string,
): SidebarSubagentCatalogEntry {
  return { id, createdAt: 1_000, mode, ...(label === undefined ? {} : { label }) }
}

/** One session's loaded projection snapshot. */
function ready(entries: SidebarSubagentCatalogEntry[]) {
  return { values: { subagentCatalog: entries }, state: 'ready' as const, error: null }
}

function baseSnapshot(): SidebarSessionList {
  return {
    byId: {
      root: { id: 'root', displayTitle: '主会话', running: true },
      child: { id: 'child', displayTitle: '子代理', origin: 'subagent', parentId: 'root', running: true },
    },
    projectionsBySession: {
      root: ready([entry('child', 'continuable')]),
      child: ready([]),
    },
  }
}

beforeEach(() => {
  outputCalls.length = 0
  killCalls.length = 0
  jobListCalls = []
  jobsByOwner = {
    root: [{ id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 }],
    child: [{ id: 'bash-2', kind: 'bash', label: 'echo hi', status: 'completed', startedAt: 2_000, finishedAt: 3_000 }],
  }
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    const body = JSON.parse(String(init?.body)) as { sessionId?: string; id?: string; rootSessionId?: string }
    if (method === 'subagents.live') {
      return jsonResponse({ ok: true, value: { live: {} } })
    }
    if (method === 'jobs.list') {
      const owner = body.sessionId ?? ''
      jobListCalls.push(owner)
      return jsonResponse({ ok: true, value: { jobs: jobsByOwner[owner] ?? [] } })
    }
    if (method === 'jobs.output') {
      outputCalls.push({ sessionId: body.sessionId ?? '', id: body.id ?? '' })
      // bash-9 stands for a job the model never read (read:false).
      return jsonResponse({
        ok: true,
        value: {
          text: body.id === 'bash-9' ? '' : `output-of-${body.id ?? ''}`,
          truncated: false,
          read: body.id !== 'bash-9',
        },
      })
    }
    if (method === 'jobs.kill') {
      killCalls.push({ sessionId: body.sessionId ?? '', id: body.id ?? '' })
      return jsonResponse({ ok: true, value: { ok: true, outcome: 'requested' } })
    }
    if (method === 'workflows.list') {
      return jsonResponse({ ok: true, value: { runs: [] } })
    }
    if (method === 'teams.view') {
      return jsonResponse({ ok: true, value: { available: false } })
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

/**
 * Flush the mount-time job reads: the poll fires immediately, and the request
 * → envelope → json → Promise.all chain settles over several microtask ticks.
 */
async function flushJobs(): Promise<void> {
  for (let tick = 0; tick < 4; tick++) {
    await act(async () => { await Promise.resolve() })
  }
}

/** Render the page and wait for its first job read to land. */
async function renderPage(store: Store, active = true, navigation?: NavigationSpy) {
  const rendered = renderRoot(
    createElement(SubagentView, { sessionId: 'root', active, ctx: makeCtx(store, navigation) }),
  )
  await flushJobs()
  return rendered
}

describe('SubagentView topology (projectionsBySession)', () => {
  it("expands a branch inferred from the child's own catalog", async () => {
    const store = makeStore({
      byId: {
        root: { id: 'root', displayTitle: '主会话' },
        child: { id: 'child', displayTitle: 'Worker', origin: 'subagent', parentId: 'root' },
        grand: { id: 'grand', displayTitle: 'Grandchild', origin: 'subagent', parentId: 'child' },
        great: { id: 'great', displayTitle: 'Great', origin: 'subagent', parentId: 'grand' },
      },
      projectionsBySession: {
        root: ready([entry('child', 'continuable', 'Worker')]),
        // The child carries a child of its own: 0.1.7 rows have no
        // `hasChildren`, it is the child's own catalog that says so.
        child: ready([entry('grand', 'one-shot', 'Grandchild')]),
        grand: ready([entry('great', 'one-shot', 'Great')]),
        great: ready([]),
      },
    })
    const { container, unmount } = await renderPage(store)
    expect(container.textContent).toContain('Worker')
    expect(container.textContent).toContain('Grandchild')
    expect(container.textContent).toContain('可续接')
    expect(container.textContent).toContain('一次性')
    unmount()
  })

  it('never claims a mode for an unknown row', async () => {
    const store = makeStore({
      byId: { root: { id: 'root', displayTitle: '主会话' } },
      projectionsBySession: {
        // 0.1.7's third mode: a child the host kept without a readable
        // descriptor. It claims neither mode, so the card states neither.
        root: ready([entry('opaque', 'unknown', 'Opaque child')]),
        opaque: ready([]),
      },
    })
    const { container, unmount } = await renderPage(store)
    expect(container.textContent).toContain('Opaque child')
    expect(container.textContent).not.toContain('一次性')
    expect(container.textContent).not.toContain('可续接')
    unmount()
  })

  it('opens a child through the workspace face (the sessions face is gone since 0.1.6)', async () => {
    const navigation: NavigationSpy = { opened: [] }
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store, true, navigation)
    // Unfold so the settled child is reachable, open its detail window and
    // use the jump button (the card itself is the detail affordance).
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const node = container.querySelector('[data-graph-node="child"]') as HTMLElement
    await act(async () => { node.click() })
    const jump = [...document.querySelectorAll('[role="dialog"] button')]
      .find(button => button.textContent?.includes('查看转录')) as HTMLButtonElement | undefined
    await act(async () => { jump?.click() })
    expect(navigation.opened).toEqual([
      { parentSessionId: 'root', childSessionId: 'child', mode: 'continuable' },
    ])
    unmount()
  })

  it('retries a failed catalog through the 0.1.7 refresh name', async () => {
    const refreshed: string[] = []
    const store = makeStore({
      byId: { root: { id: 'root', displayTitle: '主会话' } },
      projectionsBySession: {
        root: { values: {}, state: 'error', error: { code: 'boom', message: '目录读取失败' } },
      },
    })
    const rendered = renderRoot(createElement(SubagentView, {
      sessionId: 'root',
      active: true,
      ctx: {
        sessions: {
          list: store,
          refreshProjections: async (sessionId: string) => { refreshed.push(sessionId) },
        },
        get: () => undefined,
      } as unknown as Context,
    }))
    await flushJobs()
    // The banner names the failed branch count; the per-row message lives in
    // the catalog view the page folds (see `subagent-catalog.ts`).
    expect(rendered.container.textContent).toContain('1 个分支加载失败')
    const retry = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('重试'))
    expect(retry).toBeDefined()
    await act(async () => { retry?.click() })
    expect(refreshed).toEqual(['root'])
    rendered.unmount()
  })
})

describe('SubagentView background jobs', () => {
  it('renders the tree jobs with status, durations, and owner labels', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    const text = container.textContent ?? ''
    expect(text).toContain('后台任务')
    expect(text).toContain('2 个后台任务 · 1 运行中')
    // Both rows of the whole tree, owner-labeled (the tree spans two sessions).
    expect(text).toContain('sleep 300')
    expect(text).toContain('echo hi')
    expect(text).toContain('主会话')
    expect(text).toContain('子代理')
    // The fence admits a job to its owner only, so the tree costs one read per
    // tree session (and never a read of a session outside the tree).
    expect([...jobListCalls].sort()).toEqual(['child', 'root'])
    // Only the running row offers a kill button.
    expect(container.querySelectorAll('button[aria-label="终止"]')).toHaveLength(1)
    unmount()
  })

  it('renders nothing job-related when the tree has no jobs', async () => {
    jobsByOwner = {}
    const store = makeStore({ byId: { root: { id: 'root', displayTitle: '主会话' } } })
    const { container, unmount } = await renderPage(store)
    expect(container.textContent).not.toContain('后台任务')
    unmount()
  })

  it('survives the job list emptying while mounted (hook-order regression #300)', async () => {
    vi.useFakeTimers()
    try {
      const store = makeStore(baseSnapshot())
      const { container, unmount } = await renderPage(store)
      expect(container.textContent).toContain('sleep 300')
      // Every job settles and drops: the section must vanish WITHOUT reordering
      // hooks — a hook below the empty-state return would crash React with
      // "Rendered fewer hooks than expected" (the minified #300 the sidebar
      // boundary surfaces with a retry button).
      jobsByOwner = {}
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(container.textContent).not.toContain('后台任务')
      // And returning jobs must work too, with the same hook order.
      jobsByOwner = {
        root: [{ id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 }],
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(container.textContent).toContain('sleep 300')
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the selected job output in an anchored popover, dismissable', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    const row = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
    await act(async () => { row.click() })
    // The peek request carries the OWNER session (the fence compares it).
    expect(outputCalls).toEqual([{ sessionId: 'root', id: 'bash-1' }])
    // The popover is portaled to document.body (outside the tab container).
    expect(document.body.textContent).toContain('output-of-bash-1')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    // Escape dismisses the popover.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.body.textContent).not.toContain('output-of-bash-1')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    unmount()
  })

  it('switches the single output popover between rows', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    const first = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
    await act(async () => { first.click() })
    expect(document.body.textContent).toContain('output-of-bash-1')
    const second = container.querySelector('button[aria-label*="echo hi"]') as HTMLButtonElement
    await act(async () => { second.click() })
    // One popover, now fed by the second job (its owner session scopes the replay).
    expect(outputCalls).toEqual([
      { sessionId: 'root', id: 'bash-1' },
      { sessionId: 'child', id: 'bash-2' },
    ])
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('output-of-bash-1')
    expect(document.body.textContent).toContain('output-of-bash-2')
    unmount()
  })

  it('explains when the model has not read the job yet', async () => {
    jobsByOwner = {
      root: [
        ...jobsByOwner.root ?? [],
        { id: 'bash-9', kind: 'bash', label: 'unread cmd', status: 'running', startedAt: 9_000 },
      ],
    }
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    const row = container.querySelector('button[aria-label*="unread cmd"]') as HTMLButtonElement
    await act(async () => { row.click() })
    // read:false → the popover explains the output awaits the model's job_output
    // (never the model's cursor, so there is nothing to steal yet).
    expect(document.body.textContent).toContain('等待模型读取该任务的输出')
    unmount()
  })

  it('stays compact and functional with many jobs', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `bash-${index + 10}`,
      kind: 'bash' as const,
      label: `bulk cmd ${index}`,
      status: index % 2 === 0 ? ('running' as const) : ('completed' as const),
      startedAt: 1_000 + index,
      ...(index % 2 === 0 ? {} : { finishedAt: 2_000 + index, detail: 'exit code: 1' }),
    }))
    jobsByOwner = { root: many }
    const store = makeStore({ byId: { root: { id: 'root', displayTitle: '主会话' } } })
    const { container, unmount } = await renderPage(store)
    expect(container.textContent).toContain('60 个后台任务 · 30 运行中')
    expect(container.querySelectorAll('button[aria-label*="bulk cmd"]')).toHaveLength(60)
    // Clicking a row anywhere in the long list still feeds the single popover.
    const row = container.querySelector('button[aria-label*="bulk cmd 59"]') as HTMLButtonElement
    await act(async () => { row.click() })
    expect(outputCalls).toEqual([{ sessionId: 'root', id: 'bash-69' }])
    expect(document.body.textContent).toContain('output-of-bash-69')
    unmount()
  })

  it('kills a live job only after the two-click confirm', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    const kill = container.querySelector('button[aria-label="终止"]') as HTMLButtonElement
    await act(async () => { kill.click() })
    // First click only arms the confirm — no request leaves the page.
    expect(killCalls).toEqual([])
    const confirm = container.querySelector('button[aria-label="再次点击确认终止"]')
    expect(confirm).not.toBeNull()
    await act(async () => { (confirm as HTMLButtonElement).click() })
    expect(killCalls).toEqual([{ sessionId: 'root', id: 'bash-1' }])
    unmount()
  })

  it('does not read jobs or poll output while the page is hidden', async () => {
    vi.useFakeTimers()
    try {
      const store = makeStore(baseSnapshot())
      const { container, unmount } = await renderPage(store, false)
      // A hidden page issues no job read at all (it also has no rows to show).
      expect(jobListCalls).toEqual([])
      expect(container.textContent).not.toContain('后台任务')
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(jobListCalls).toEqual([])
      expect(outputCalls).toEqual([])
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
