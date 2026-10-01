/**
 * Tasks page tests: the projection-backed topology (branch expansion inferred
 * from the child's OWN catalog, the `mode: 'unknown'` row, navigation through
 * the workspace face, catalog retry through the 0.1.7 refresh name) and the
 * background-jobs DRAWER — rows pushed by the HOST's client jobs service
 * (`ctx.jobs`, structurally faked here), output streamed for the one OPEN row
 * through `observe` (never the model's consuming cursor), the kill button
 * needing a two-click confirm and going through the service, and the watch
 * released while the page is hidden.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import type {
  Context,
  SidebarClientJobsService,
  SidebarJobsSnapshot,
  SidebarSessionList,
  SidebarSubagentAddress,
  SidebarSubagentCatalogEntry,
} from '../src/context-types.ts'

/**
 * A structurally faithful double of the host's client jobs service: a
 * subscribable snapshot (roster by watched session + observations), a
 * reference-counted `watchRows`, an `observe` that records its calls, and a
 * `kill` that records its arguments.
 */
function makeJobsService() {
  let snapshot: SidebarJobsSnapshot = { rows: {}, observed: {} }
  const listeners = new Set<() => void>()
  const watches: string[] = []
  const releases: string[] = []
  const observations: Array<{ sessionId: string | undefined; jobId: string }> = []
  const released: string[] = []
  const kills: Array<{ sessionId: string; jobId: string }> = []
  const service: SidebarClientJobsService = {
    state: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    watchRows: (sessionId: string) => {
      watches.push(sessionId)
      return () => { releases.push(sessionId) }
    },
    observe: (sessionId: string | undefined, jobId: string) => {
      observations.push({ sessionId, jobId })
      return () => { released.push(jobId) }
    },
    kill: async (sessionId: string, jobId: string) => {
      kills.push({ sessionId, jobId })
    },
  }
  const emit = (next: Partial<SidebarJobsSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }
  return { service, emit, watches, releases, observations, released, kills }
}

type JobsFake = ReturnType<typeof makeJobsService>

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
function makeCtx(store: Store, navigation?: NavigationSpy, jobs?: JobsFake): Context {
  return {
    sessions: { list: store },
    get: (name: string) => {
      if (name === 'jobs') return jobs?.service
      if (name === 'uiWorkspace' && navigation !== undefined) {
        return { openSession: (target: SidebarSubagentAddress | string) => { navigation.opened.push(target) } }
      }
      return undefined
    },
  } as unknown as Context
}

/** The jobs service the page reads (rebuilt per test in beforeEach). */
let jobsFake: JobsFake

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
  jobsFake = makeJobsService()
  jobsFake.emit({
    rows: {
      root: [{ id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 }],
      child: [{
        id: 'bash-2', kind: 'bash', label: 'echo hi', status: 'completed',
        startedAt: 2_000, finishedAt: 3_000, owner: 'child',
      }],
    },
  })
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    const method = String(url).split('/').pop()
    if (method === 'subagents.live') {
      return jsonResponse({ ok: true, value: { live: {} } })
    }
    if (method === 'workflows.list') {
      return jsonResponse({ ok: true, value: { runs: [] } })
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

/** Flush the mount-time requests (routes + the service snapshot). */
async function flushJobs(): Promise<void> {
  for (let tick = 0; tick < 4; tick++) {
    await act(async () => { await Promise.resolve() })
  }
}

/** Render the page with the jobs service wired in. */
async function renderPage(
  store: Store,
  active = true,
  navigation?: NavigationSpy,
  jobs: JobsFake = jobsFake,
) {
  const rendered = renderRoot(
    createElement(SubagentView, { sessionId: 'root', active, ctx: makeCtx(store, navigation, jobs) }),
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
    // The host shares one roster stream per session: the page watches every
    // session of the tree while it is on screen.
    expect([...jobsFake.watches].sort()).toEqual(['child', 'root'])
    // Only the running row offers a kill button.
    expect(container.querySelectorAll('button[aria-label="终止"]')).toHaveLength(1)
    unmount()
  })

  it('renders nothing job-related on a deployment without the jobs service', async () => {
    const store = makeStore(baseSnapshot())
    const bare = makeCtx(store)
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: bare }),
    )
    await flushJobs()
    expect(container.textContent).not.toContain('后台任务')
    unmount()
  })

  it('releases every watch when the page goes away', async () => {
    const store = makeStore(baseSnapshot())
    const { unmount } = await renderPage(store)
    expect(jobsFake.releases).toEqual([])
    unmount()
    expect([...jobsFake.releases].sort()).toEqual(['child', 'root'])
  })

  it('watches nothing while the page is hidden', async () => {
    const store = makeStore(baseSnapshot())
    // A mounted-but-hidden page renders from the last snapshot it holds; what
    // it must NOT do is hold a roster stream open.
    const { unmount } = await renderPage(store, false)
    expect(jobsFake.watches).toEqual([])
    unmount()
  })

  it('survives the roster emptying while mounted (hook-order regression #300)', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    expect(container.textContent).toContain('sleep 300')
    // Every job settles and drops: the drawer must vanish WITHOUT reordering
    // hooks — a hook below the empty-state return would crash React with
    // "Rendered fewer hooks than expected" (the minified #300 the sidebar
    // boundary surfaces with a retry button).
    await act(async () => { jobsFake.emit({ rows: {} }) })
    expect(container.textContent).not.toContain('后台任务')
    // And returning jobs must work too, with the same hook order.
    await act(async () => {
      jobsFake.emit({
        rows: { root: [{ id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 }] },
      })
    })
    expect(container.textContent).toContain('sleep 300')
    unmount()
  })

  it('observes only the OPEN row and streams its output into the popover', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    // Nothing is observed until a row opens: the host streams per observer.
    expect(jobsFake.observations).toEqual([])
    const row = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
    await act(async () => { row.click() })
    expect(jobsFake.observations).toEqual([{ sessionId: 'root', jobId: 'bash-1' }])
    // The observed frames land in the portalled popover.
    await act(async () => {
      jobsFake.emit({
        observed: { 'bash-1': { text: 'building…\ndone', gapBefore: false, streaming: true } },
      })
    })
    expect(document.body.textContent).toContain('building…')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)

    // Switching rows releases the first observation and opens the second (its
    // owner session rides along — the kill and the stream both need it).
    const second = container.querySelector('button[aria-label*="echo hi"]') as HTMLButtonElement
    await act(async () => { second.click() })
    expect(jobsFake.released).toEqual(['bash-1'])
    expect(jobsFake.observations).toEqual([
      { sessionId: 'root', jobId: 'bash-1' },
      { sessionId: 'child', jobId: 'bash-2' },
    ])
    expect(document.body.textContent).not.toContain('building…')

    // Escape dismisses the popover AND releases the observation.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    expect(jobsFake.released).toContain('bash-2')
    unmount()
  })

  it('flags a gap and a producer error in the observed stream', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    await act(async () => {
      (container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      jobsFake.emit({
        observed: {
          'bash-1': { text: 'tail only', gapBefore: true, streaming: false, error: 'writer died' },
        },
      })
    })
    const body = document.body.textContent ?? ''
    // The dropped-frame notice and the producer error both surface (the
    // plugin's own copy for each).
    expect(body).toContain('输出过长，已截断显示')
    expect(body).toContain('输出读取失败')
    expect(body).toContain('tail only')
    unmount()
  })

  it('kills a live job through the service only after the two-click confirm', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = await renderPage(store)
    const kill = container.querySelector('button[aria-label="终止"]') as HTMLButtonElement
    await act(async () => { kill.click() })
    // First click only arms the confirm — nothing reaches the registry.
    expect(jobsFake.kills).toEqual([])
    const confirm = container.querySelector('button[aria-label="再次点击确认终止"]')
    expect(confirm).not.toBeNull()
    await act(async () => { (confirm as HTMLButtonElement).click() })
    expect(jobsFake.kills).toEqual([{ sessionId: 'root', jobId: 'bash-1' }])
    unmount()
  })

  it('drops rows owned by a session outside the tree', async () => {
    const store = makeStore(baseSnapshot())
    // An unowned job is visible to every watcher, so it stays; a job owned by
    // a session this tree does not contain must not appear.
    await act(async () => {
      jobsFake.emit({
        rows: {
          root: [
            { id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 },
            { id: 'bash-7', kind: 'bash', label: 'foreign cmd', status: 'running', startedAt: 1_100, owner: 'elsewhere' },
            { id: 'bash-8', kind: 'bash', label: 'unowned cmd', status: 'running', startedAt: 1_200 },
          ],
        },
      })
    })
    const { container, unmount } = await renderPage(store)
    const text = container.textContent ?? ''
    expect(text).toContain('sleep 300')
    expect(text).toContain('unowned cmd')
    expect(text).not.toContain('foreign cmd')
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
    const store = makeStore({ byId: { root: { id: 'root', displayTitle: '主会话' } } })
    await act(async () => { jobsFake.emit({ rows: { root: many } }) })
    const { container, unmount } = await renderPage(store)
    // One agent: the drawer is open by default (the auto-collapse rule counts
    // AGENTS, not jobs — see the 8-child case in tasks-page.spec.tsx).
    expect(container.textContent).toContain('后台任务')
    expect(container.querySelectorAll('button[aria-label*="bulk cmd"]')).toHaveLength(60)
    // Clicking a row anywhere in the long list still feeds the single popover.
    const row = container.querySelector('button[aria-label*="bulk cmd 59"]') as HTMLButtonElement
    await act(async () => { row.click() })
    expect(jobsFake.observations).toEqual([{ sessionId: 'root', jobId: 'bash-69' }])
    unmount()
  })
})
