/**
 * Component-level regression for the Subagent page live preview polling:
 * one shared `subagents.live` request per refresh, never a per-child
 * `subagents.history` call, never a second in-flight request while a slow host
 * is still answering, and never a re-render for a tick that changed nothing.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler, createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

setupReactAct()

/**
 * The tasks model is observed through a spy: it is the derived structure the
 * polled data feeds (it builds the whole agent tree, and the graph layout is
 * memoized on its result), so "the model was not recomputed" is exactly "the
 * polled objects kept their identity".
 */
const { modelSpy } = vi.hoisted(() => ({ modelSpy: vi.fn() }))

vi.mock('../src/client/tasks-model.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/tasks-model.ts')>()
  return {
    ...actual,
    buildTasksModel: (...args: Parameters<typeof actual.buildTasksModel>) => {
      modelSpy(...args)
      return actual.buildTasksModel(...args)
    },
  }
})

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

/** The client context face SubagentView touches; history is spied for the
 *  regression assertion (the new page must never call it). */
function makeCtx(store: Store, historySpy: ReturnType<typeof vi.fn>): Context {
  return {
    sessions: {
      list: store,
      openSubagent: () => {},
      open: () => {},
    },
    connection: {
      api: {
        sessions: { history: historySpy },
        subagents: { history: historySpy },
      },
    },
    // No host jobs service in this harness: the page renders no jobs surface
    // (and therefore issues no jobs request).
    get: () => undefined,
  } as unknown as Context
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** One `subagentCatalog` projection row (DSH 0.1.7 shape). */
function entry(
  id: string,
  mode: 'one-shot' | 'continuable' | 'unknown',
  label?: string,
): { id: string; createdAt: number; mode: 'one-shot' | 'continuable' | 'unknown'; label?: string } {
  return { id, createdAt: 1_000, mode, ...(label === undefined ? {} : { label }) }
}

/** One session's loaded projection snapshot. */
function ready(entries: ReturnType<typeof entry>[]) {
  return { values: { subagentCatalog: entries }, state: 'ready' as const, error: null }
}

/**
 * A topology snapshot with two direct subagents and their catalogs. The rows
 * carry no activity of their own any more: the live channel below is what
 * marks a child running.
 */
function runningSnapshot(): SidebarSessionList {
  return {
    byId: {
      root: { id: 'root', displayTitle: '主会话' },
      a: { id: 'a', displayTitle: 'A', origin: 'subagent', parentId: 'root', running: true },
      b: { id: 'b', displayTitle: 'B', origin: 'subagent', parentId: 'root', running: true },
    },
    projectionsBySession: {
      root: ready([entry('a', 'one-shot', 'A'), entry('b', 'one-shot', 'B')]),
      a: ready([]),
      b: ready([]),
    },
  }
}

/** The same tree re-rooted under a new ancestor ('grand' becomes the root). */
function reRootedSnapshot(): SidebarSessionList {
  return {
    byId: {
      grand: { id: 'grand', displayTitle: '主会话' },
      root: { id: 'root', displayTitle: 'R', origin: 'subagent', parentId: 'grand', running: true },
      a: { id: 'a', displayTitle: 'A', origin: 'subagent', parentId: 'root', running: true },
      b: { id: 'b', displayTitle: 'B', origin: 'subagent', parentId: 'root', running: true },
    },
    projectionsBySession: {
      grand: ready([entry('root', 'continuable', 'R')]),
      root: ready([entry('a', 'one-shot', 'A'), entry('b', 'one-shot', 'B')]),
      a: ready([]),
      b: ready([]),
    },
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('SubagentView live polling', () => {
  it('sends one subagents.live per poll and never calls per-child history', async () => {
    vi.useFakeTimers()
    const historySpy = vi.fn()
    const liveCalls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()
      if (method === 'subagents.live') {
        const body = JSON.parse(String(init?.body)) as { rootSessionId?: string }
        liveCalls.push(body.rootSessionId ?? '')
        return jsonResponse({
          ok: true,
          value: {
            live: {
              a: { running: true, summary: { counts: [{ kind: 'read', count: 1 }], runningDetail: '' } },
              b: { running: true },
            },
          },
        })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const store = makeStore(runningSnapshot())
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store, historySpy) }),
    )
    // Initial load plus the first scheduled tick.
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root'])
    expect(historySpy).not.toHaveBeenCalled()
    // The live map reached the cards: a running node's bar carries the sweep
    // hook, and its merged activity line renders on the bar.
    const bar = container.querySelector('[data-graph-node="a"] [data-running="true"]')
    expect(bar).not.toBeNull()
    expect(bar?.textContent).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(liveCalls).toEqual(['root', 'root'])
    expect(historySpy).not.toHaveBeenCalled()
    unmount()
  })

  it('never starts a second request while one is in flight', async () => {
    vi.useFakeTimers()
    const historySpy = vi.fn()
    const liveCalls: string[] = []
    let resolveFirst: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()
      if (method === 'subagents.live') {
        const body = JSON.parse(String(init?.body)) as { rootSessionId?: string }
        liveCalls.push(body.rootSessionId ?? '')
        return new Promise<Response>((resolve) => { resolveFirst = resolve })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const store = makeStore(runningSnapshot())
    const { unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store, historySpy) }),
    )
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root'])
    expect(resolveFirst).toBeTypeOf('function')

    // While the first request is pending, no timer can fire a second one.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(liveCalls).toEqual(['root'])

    // Settle the first request; only then does the next 3s tick fire.
    await act(async () => {
      resolveFirst?.(jsonResponse({ ok: true, value: { live: { a: { running: true }, b: { running: true } } } }))
      await Promise.resolve()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(liveCalls).toEqual(['root', 'root'])
    expect(historySpy).not.toHaveBeenCalled()
    unmount()
  })

  it('stops polling and drops the in-flight request when the page hides', async () => {
    vi.useFakeTimers()
    const historySpy = vi.fn()
    const liveCalls: string[] = []
    let resolveFirst: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()
      if (method === 'subagents.live') {
        const body = JSON.parse(String(init?.body)) as { rootSessionId?: string }
        liveCalls.push(body.rootSessionId ?? '')
        return new Promise<Response>((resolve) => { resolveFirst = resolve })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const store = makeStore(runningSnapshot())
    const { rerender, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store, historySpy) }),
    )
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root'])

    // Hide the page: the effect cleanup aborts the in-flight request and no
    // timer may fire afterwards.
    rerender(createElement(SubagentView, { sessionId: 'root', active: false, ctx: makeCtx(store, historySpy) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(liveCalls).toEqual(['root'])

    // Settling the stale response must neither render nor schedule a poll.
    await act(async () => {
      resolveFirst?.(jsonResponse({ ok: true, value: { live: { a: { running: true, text: 'stale' } } } }))
      await Promise.resolve()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(liveCalls).toEqual(['root'])
    expect(historySpy).not.toHaveBeenCalled()
    unmount()
  })

  it('clears the live map and re-polls when the topology root changes', async () => {
    vi.useFakeTimers()
    const historySpy = vi.fn()
    const liveCalls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()
      if (method === 'subagents.live') {
        const body = JSON.parse(String(init?.body)) as { rootSessionId?: string }
        liveCalls.push(body.rootSessionId ?? '')
        // `text` is the child's newest assistant line, which the card shows in
        // its detail POPOVER; the bar shows the merged activity summary.
        const live = body.rootSessionId === 'root'
          ? { a: { running: true, summary: { counts: [{ kind: 'read', count: 1 }], runningDetail: 'hello' } } }
          : {}
        return jsonResponse({ ok: true, value: { live } })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const store = makeStore(runningSnapshot())
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store, historySpy) }),
    )
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root'])
    const bar = container.querySelector('[data-graph-node="a"] [data-running="true"]')
    expect(bar?.textContent).toContain('hello')

    // The tree is re-rooted under a new ancestor: old rows must not leak. The
    // store notification is an update like any other, so it is flushed inside
    // act() (this spec declares the act environment).
    await act(async () => { store.set(reRootedSnapshot()) })
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root', 'grand'])
    expect(container.textContent).not.toContain('hello')
    expect(historySpy).not.toHaveBeenCalled()
    unmount()
  })

  it('re-renders nothing when a poll returns the same data', async () => {
    vi.useFakeTimers()
    const historySpy = vi.fn()
    const liveCalls: string[] = []
    // The route answers with FRESH objects every tick (that is the wire shape);
    // the page must publish them only when they say something new.
    let answer: Record<string, unknown> = {
      a: { running: true, summary: { counts: [{ kind: 'read', count: 1 }], runningDetail: 'hello' } },
    }
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()
      if (method === 'subagents.live') {
        const body = JSON.parse(String(init?.body)) as { rootSessionId?: string }
        liveCalls.push(body.rootSessionId ?? '')
        return jsonResponse({ ok: true, value: { live: answer } })
      }
      if (method === 'workflows.list') return jsonResponse({ ok: true, value: { runs: [] } })
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    // Every Profiler commit inside the page's subtree IS one re-render of the
    // page — there is no cheaper observable for "nothing was published".
    const commits: string[] = []
    const store = makeStore(runningSnapshot())
    const { unmount } = renderRoot(
      createElement(
        Profiler,
        { id: 'tasks', onRender: (_id: string, phase: string) => { commits.push(phase) } },
        createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store, historySpy) }),
      ),
    )
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root'])
    // Let the mount settle completely — the graph's own entrance tween runs on
    // rAFs after the live answer lands, and that motion is not what this case
    // is about. Both poll cadences are untouched by this (3 s / 5 s).
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    const settledCommits = commits.length
    const settledModel = modelSpy.mock.calls.length
    expect(settledCommits).toBeGreaterThan(0)

    // One full round of BOTH cadences (3 s live, 5 s telemetry) with identical
    // answers: the fresh objects must keep the previous identities, so React
    // bails out (no commit at all) and the derived model is not rebuilt.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(liveCalls.length).toBeGreaterThanOrEqual(2)
    expect(commits.length).toBe(settledCommits)
    expect(modelSpy.mock.calls.length).toBe(settledModel)

    // A REAL change still lands — and re-derives the model exactly once.
    answer = {
      a: { running: true, summary: { counts: [{ kind: 'read', count: 1 }], runningDetail: 'hello again' } },
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(commits.length).toBeGreaterThan(settledCommits)
    expect(modelSpy.mock.calls.length).toBe(settledModel + 1)
    unmount()
  })
})
