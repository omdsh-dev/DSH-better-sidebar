/**
 * Component-level regression for the Subagent page live preview polling:
 * one shared `subagents.live` request per refresh, never a per-child
 * `subagents.history` call, and never a second in-flight request while a
 * slow host is still answering.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
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
      setSubagentCatalogOpen: () => {},
      openSubagent: () => {},
      open: () => {},
      refreshSubagents: async () => {},
    },
    connection: {
      api: {
        sessions: { history: historySpy },
        subagents: { history: historySpy },
      },
    },
  } as unknown as Context
}

/** Render `node` into a detached body container under React's act(). */
function mount(node: ReactNode): {
  container: HTMLDivElement
  rerender: (next: ReactNode) => void
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const rerender = (next: ReactNode): void => { act(() => { root.render(next) }) }
  act(() => { root.render(node) })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, rerender, unmount }
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** A topology snapshot with two running direct subagents and a ready catalog. */
function runningSnapshot(): SidebarSessionList {
  return {
    current: 'root',
    byId: {
      root: { id: 'root', displayTitle: '主会话' },
      a: { id: 'a', displayTitle: 'A', origin: 'subagent', parentId: 'root', running: true },
      b: { id: 'b', displayTitle: 'B', origin: 'subagent', parentId: 'root', running: true },
    },
    subagentsByParent: {
      root: {
        entries: [
          { kind: 'child', id: 'a', activity: 'running', hasChildren: false, mode: 'one-shot', label: 'A' },
          { kind: 'child', id: 'b', activity: 'running', hasChildren: false, mode: 'one-shot', label: 'B' },
        ],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    },
    jobsBySession: {},
  }
}

/** The same tree re-rooted under a new ancestor ('grand' becomes the root). */
function reRootedSnapshot(): SidebarSessionList {
  return {
    current: 'root',
    byId: {
      grand: { id: 'grand', displayTitle: '主会话' },
      root: { id: 'root', displayTitle: 'R', origin: 'subagent', parentId: 'grand', running: true },
      a: { id: 'a', displayTitle: 'A', origin: 'subagent', parentId: 'root', running: true },
      b: { id: 'b', displayTitle: 'B', origin: 'subagent', parentId: 'root', running: true },
    },
    subagentsByParent: {
      grand: {
        entries: [
          { kind: 'child', id: 'root', activity: 'running', hasChildren: true, mode: 'continuable', label: 'R' },
        ],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
      root: {
        entries: [
          { kind: 'child', id: 'a', activity: 'running', hasChildren: false, mode: 'one-shot', label: 'A' },
          { kind: 'child', id: 'b', activity: 'running', hasChildren: false, mode: 'one-shot', label: 'B' },
        ],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    },
    jobsBySession: {},
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
        return jsonResponse({ ok: true, value: { live: {} } })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const store = makeStore(runningSnapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store, historySpy) }),
    )
    // Initial load plus the first scheduled tick.
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root'])
    expect(historySpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('思考中…')

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
    const { unmount } = mount(
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
      resolveFirst?.(jsonResponse({ ok: true, value: { live: {} } }))
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
    const { rerender, unmount } = mount(
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
      resolveFirst?.(jsonResponse({ ok: true, value: { live: { a: { text: 'stale' } } } }))
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
        const live = body.rootSessionId === 'root' ? { a: { text: 'hello' } } : {}
        return jsonResponse({ ok: true, value: { live } })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const store = makeStore(runningSnapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store, historySpy) }),
    )
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root'])
    expect(container.textContent).toContain('hello')

    // The tree is re-rooted under a new ancestor: old rows must not leak.
    store.set(reRootedSnapshot())
    await act(async () => { await Promise.resolve() })
    expect(liveCalls).toEqual(['root', 'grand'])
    expect(container.textContent).not.toContain('hello')
    expect(historySpy).not.toHaveBeenCalled()
    unmount()
  })
})
