/**
 * Component-level regression for the Subagent page live preview polling:
 * one shared `subagents.live` request per refresh, never a per-child
 * `subagents.history` call, and never a second in-flight request while a
 * slow host is still answering.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

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

    // The tree is re-rooted under a new ancestor: old rows must not leak.
    store.set(reRootedSnapshot())
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root', 'grand'])
    expect(container.textContent).not.toContain('hello')
    expect(historySpy).not.toHaveBeenCalled()
    unmount()
  })
})
