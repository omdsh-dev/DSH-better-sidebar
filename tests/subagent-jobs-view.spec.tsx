/**
 * Subagent page tests for the background-job section: rows render from the
 * `jobsBySession` mirror, clicking a row peeks its output through
 * `jobs.output` with the OWNER session scope, the kill button needs a
 * two-click confirm, settled rows offer no kill, and the output panel never
 * polls while the page is hidden.
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

/** The client context face SubagentView touches (history stub; everything else inert). */
function makeCtx(store: Store): Context {
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
        subagents: {
          history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
        },
      },
    },
  } as unknown as Context
}

/** Render `node` into a detached body container under React's act(). */
function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, unmount }
}

const outputCalls: Array<{ sessionId: string; id: string }> = []
const killCalls: Array<{ sessionId: string; id: string }> = []

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

function baseSnapshot(): SidebarSessionList {
  return {
    current: 'root',
    byId: {
      root: { id: 'root', displayTitle: '主会话', running: true },
      child: { id: 'child', displayTitle: '子代理', origin: 'subagent', parentId: 'root', running: true },
    },
    subagentsByParent: {},
    jobsBySession: {
      root: [
        { id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 },
      ],
      child: [
        { id: 'bash-2', kind: 'bash', label: 'echo hi', status: 'completed', startedAt: 2_000, finishedAt: 3_000 },
      ],
    },
  }
}

beforeEach(() => {
  outputCalls.length = 0
  killCalls.length = 0
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    const body = JSON.parse(String(init?.body)) as { sessionId?: string; id?: string; rootSessionId?: string }
    if (method === 'subagents.live') {
      return jsonResponse({ ok: true, value: { live: {} } })
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
    throw new Error(`unexpected fetch ${String(url)}`)
  })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('SubagentView background jobs', () => {
  it('renders the tree jobs with status, durations, and owner labels', () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('后台任务')
    expect(text).toContain('2 个后台任务 · 1 运行中')
    // Both rows of the whole tree, owner-labeled (the tree spans two sessions).
    expect(text).toContain('sleep 300')
    expect(text).toContain('echo hi')
    expect(text).toContain('主会话')
    expect(text).toContain('子代理')
    // Only the running row offers a kill button.
    expect(container.querySelectorAll('button[aria-label="终止"]')).toHaveLength(1)
    unmount()
  })

  it('renders nothing job-related when the mirror is empty', () => {
    const store = makeStore({ current: 'root', byId: { root: { id: 'root', displayTitle: '主会话' } }, subagentsByParent: {}, jobsBySession: {} })
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    expect(container.textContent).not.toContain('后台任务')
    unmount()
  })

  it('survives the mirror emptying while mounted (hook-order regression #300)', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    expect(container.textContent).toContain('sleep 300')
    // The mirror empties (all jobs settled and dropped): the section must
    // vanish WITHOUT reordering hooks — a hook below the empty-state return
    // would crash React with "Rendered fewer hooks than expected" (the
    // minified #300 the sidebar boundary surfaces with a retry button).
    await act(async () => { store.set({ ...baseSnapshot(), jobsBySession: {} }) })
    expect(container.textContent).not.toContain('后台任务')
    // And returning jobs must work too, with the same hook order.
    await act(async () => { store.set(baseSnapshot()) })
    expect(container.textContent).toContain('sleep 300')
    unmount()
  })

  it('shows the selected job output in the bottom dock, closeable', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const row = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
    await act(async () => { row.click() })
    // The peek request carries the OWNER session (the fence compares it).
    expect(outputCalls).toEqual([{ sessionId: 'root', id: 'bash-1' }])
    expect(container.textContent).toContain('output-of-bash-1')
    // Exactly one dock region exists (never one per row).
    expect(container.querySelectorAll('[role="region"]')).toHaveLength(1)
    // The selected row is marked, and the close button dismisses the dock.
    expect(row.getAttribute('aria-pressed')).toBe('true')
    const close = container.querySelector('button[aria-label="关闭"]') as HTMLButtonElement
    await act(async () => { close.click() })
    expect(container.textContent).not.toContain('output-of-bash-1')
    expect(container.querySelectorAll('[role="region"]')).toHaveLength(0)
    unmount()
  })

  it('switches the single dock between selected rows', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const first = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
    await act(async () => { first.click() })
    expect(container.textContent).toContain('output-of-bash-1')
    const second = container.querySelector('button[aria-label*="echo hi"]') as HTMLButtonElement
    await act(async () => { second.click() })
    // One dock, now fed by the second job (its owner session scopes the replay).
    expect(outputCalls).toEqual([
      { sessionId: 'root', id: 'bash-1' },
      { sessionId: 'child', id: 'bash-2' },
    ])
    expect(container.querySelectorAll('[role="region"]')).toHaveLength(1)
    expect(container.textContent).not.toContain('output-of-bash-1')
    expect(container.textContent).toContain('output-of-bash-2')
    unmount()
  })

  it('explains when the model has not read the job yet', async () => {
    const snapshot = baseSnapshot()
    snapshot.jobsBySession = {
      root: [
        ...(snapshot.jobsBySession?.root ?? []),
        { id: 'bash-9', kind: 'bash', label: 'unread cmd', status: 'running', startedAt: 9_000 },
      ],
    }
    const store = makeStore(snapshot)
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const row = container.querySelector('button[aria-label*="unread cmd"]') as HTMLButtonElement
    await act(async () => { row.click() })
    // read:false → the pane explains the output awaits the model's job_output
    // (never the model's cursor, so there is nothing to steal yet).
    expect(container.textContent).toContain('等待模型读取该任务的输出')
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
    const store = makeStore({
      current: 'root',
      byId: { root: { id: 'root', displayTitle: '主会话' } },
      subagentsByParent: {},
      jobsBySession: { root: many },
    })
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    expect(container.textContent).toContain('60 个后台任务 · 30 运行中')
    expect(container.querySelectorAll('button[aria-label*="bulk cmd"]')).toHaveLength(60)
    // Clicking a row anywhere in the long list still feeds the single dock.
    const row = container.querySelector('button[aria-label*="bulk cmd 59"]') as HTMLButtonElement
    await act(async () => { row.click() })
    expect(outputCalls).toEqual([{ sessionId: 'root', id: 'bash-69' }])
    expect(container.textContent).toContain('output-of-bash-69')
    unmount()
  })

  it('kills a live job only after the two-click confirm', async () => {
    const store = makeStore(baseSnapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
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

  it('does not poll the output while the page is hidden', async () => {
    vi.useFakeTimers()
    try {
      const store = makeStore(baseSnapshot())
      const { container, unmount } = mount(
        createElement(SubagentView, { sessionId: 'root', active: false, ctx: makeCtx(store) }),
      )
      const row = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
      await act(async () => { row.click() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      // One peek for the initial load; the 2s poll never ran while inactive.
      expect(outputCalls).toHaveLength(1)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
