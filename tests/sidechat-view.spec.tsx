/**
 * Side Chat view render tests: tool rows with structured cards render the
 * host's ui-primitives Blocks (terminal surface from a bash call/result
 * pair), the turn-tail usage/duration line renders from the mapped
 * turnSummary row, and the connection banner follows `ctx.connection.state`
 * (shown + reconnect-click while disconnected, hidden once connected, with
 * an immediate transcript pull on recovery).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SideChatView } from '../src/client/SideChatView.tsx'
import { attachLocale } from '../src/client/locales.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'zh'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): () => void {
    return () => {}
  }
}

/** The thread's own (seed-cut) event log the sidechat.events stub serves. */
const EVENTS = [
  { type: 'session/end-seed', seq: 0, time: 0, data: {} },
  { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
  { type: 'tool/call', seq: 3, time: 3_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo sidechat-ok-42"}' } },
  {
    type: 'tool/result',
    seq: 4,
    time: 4_000,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'sidechat-ok-42\n[exit code: 0]' }] }],
      },
    },
  },
  {
    type: 'assistant/message',
    seq: 5,
    time: 5_000,
    surfaceOp: 'append',
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 1_200, outputTokens: 345 } },
  },
  { type: 'turn/end', seq: 6, time: 6_000, data: { turn: 1, reason: 'completed' } },
]

/** A subscribable sessions-list snapshot (mirror of the runtime list feed). */
function makeStore(initial: SidebarSessionList) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): SidebarSessionList => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

/** A settable connection-state snapshot (the alpha.2 ConnectionHandle face). */
function makeConnection(initial: 'connected' | 'disconnected' | 'connecting') {
  let snapshot: 'connected' | 'disconnected' | 'connecting' = initial
  const listeners = new Set<() => void>()
  return {
    state: {
      getSnapshot: () => snapshot,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    },
    reconnect: vi.fn(),
    set(next: 'connected' | 'disconnected' | 'connecting'): void {
      snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}

type Connection = ReturnType<typeof makeConnection>

/** The client context face SideChatView touches (everything inert but list). */
function makeCtx(store: ReturnType<typeof makeStore>, connection?: Connection): Context {
  return {
    sessions: { list: store },
    ...(connection !== undefined ? { connection } : {}),
    get: (key: string) => (key === 'betterSidebar' ? { updateTab: vi.fn(), openTab: vi.fn() } : undefined),
  } as unknown as Context
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
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

let eventsPulls = 0

beforeEach(() => {
  attachLocale(new FakeLocale())
  eventsPulls = 0
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const method = String(url).split('/').pop()
    if (method === 'sidechat.events') {
      eventsPulls += 1
      return jsonResponse({ ok: true, value: { events: EVENTS } })
    }
    if (method === 'sidechat.info') {
      return jsonResponse({ ok: true, value: { live: false, provider: 'deepseek', preset: 'side' } })
    }
    return jsonResponse({ ok: true, value: {} })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  attachLocale(undefined)
})

/** The bound-thread view props (tab meta pins threadId 't1'). */
function viewProps(ctx: Context) {
  const tab: SidebarTab = { id: 'tab1', type: 'sidechat', title: '线程一', meta: { threadId: 't1' } }
  return { ctx, scope: { sessionId: 'root', cwd: '/p' }, tab, visible: true }
}

/** The sessions-list snapshot with one idle side thread bound to 'root'. */
function threadStore(): ReturnType<typeof makeStore> {
  return makeStore({
    current: 'root',
    byId: {
      root: { id: 'root', displayTitle: '主会话', running: false },
      t1: { id: 't1', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
    },
    subagentsByParent: {},
    jobsBySession: {},
  })
}

describe('SideChatView rendering', () => {
  it('renders the bash pair as a TerminalBlock and the turn tail with usage + duration', async () => {
    const props = viewProps(makeCtx(threadStore()))
    const { container, unmount } = mount(createElement(SideChatView, props))
    await act(async () => {})  // flush the initial transcript pull
    const text = container.textContent ?? ''
    // Terminal surface: the command line and the marker-stripped output body.
    expect(text).toContain('echo sidechat-ok-42')
    expect(text).toContain('sidechat-ok-42')
    // Turn tail: 1.2K/345 compaction + 4s envelope-time duration.
    expect(text).toContain('输入 1.2K tok · 输出 345 tok · 4s')
    unmount()
  })

  it('shows the disconnect banner, reconnects on click, and pulls immediately on recovery', async () => {
    const connection = makeConnection('disconnected')
    const props = viewProps(makeCtx(threadStore(), connection))
    const { container, unmount } = mount(createElement(SideChatView, props))
    await act(async () => {})  // flush the initial transcript pull
    expect(container.textContent ?? '').toContain('连接已断开')

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="立即重连"]')
    expect(button).not.toBeNull()
    act(() => { button?.click() })
    expect(connection.reconnect).toHaveBeenCalledTimes(1)

    // Recovery hides the banner and triggers an immediate transcript pull.
    const pullsBefore = eventsPulls
    act(() => { connection.set('connected') })
    expect(container.textContent ?? '').not.toContain('连接已断开')
    expect(eventsPulls).toBeGreaterThan(pullsBefore)
    unmount()
  })

  it('renders no banner without a connection service or while connected', async () => {
    const absent = mount(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    expect(absent.container.textContent ?? '').not.toContain('连接已断开')
    absent.unmount()

    const connection = makeConnection('connected')
    const connected = mount(createElement(SideChatView, viewProps(makeCtx(threadStore(), connection))))
    expect(connected.container.textContent ?? '').not.toContain('连接已断开')
    connected.unmount()
  })
})
