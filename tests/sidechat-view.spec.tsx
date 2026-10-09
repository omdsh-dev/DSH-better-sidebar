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
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SideChatView } from '../src/client/SideChatView.tsx'
import { api } from '../src/client/api.ts'
import { attachLocale } from '../src/client/locales.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

setupReactAct()

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
    setSnapshot(next: SidebarSessionList): void {
      snapshot = next
      for (const fn of [...listeners]) fn()
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

/** 构造 SideChatView 使用的客户端上下文与会话选择投影。 */
function makeCtx(store: ReturnType<typeof makeStore>, connection?: Connection): Context & {
  modelSelectionProjection: SnapshotStore<unknown>
  setBindingReady(ready: boolean): void
} {
  let bindingReady = true
  const modelSelectionProjection = createSnapshotStore<unknown>({ lastUsed: null, next: null })
  return {
    sessions: {
      list: store,
      binding: () => bindingReady
        ? { session: { rename: async () => {}, projections: { faceOf: () => modelSelectionProjection } } }
        : undefined,
    },
    ...(connection !== undefined ? { connection } : {}),
    modelSelectionProjection,
    setBindingReady(ready: boolean): void { bindingReady = ready },
    get: (key: string) => {
      if (key === 'betterSidebar') return { updateTab: vi.fn(), openTab: vi.fn() }
      return undefined
    },
  } as unknown as Context & {
    modelSelectionProjection: SnapshotStore<unknown>
    setBindingReady(ready: boolean): void
  }
}

/** The archive set feed + the archiving service — the two host faces the
 *  header's archive button reaches for, neither of them on the plugin's own
 *  context type (`workspaces` is the session list, `uiWorkspace` the session
 *  surface), so both ride the same `get` probe the view uses. */
interface ArchiveHost {
  archivedIds: string[]
  archiveSession: ReturnType<typeof vi.fn>
  betterSidebar: { updateTab: ReturnType<typeof vi.fn>; openTab: ReturnType<typeof vi.fn> }
}

function makeArchiveHost(archivedIds: string[] = []): ArchiveHost {
  return {
    archivedIds,
    archiveSession: vi.fn(async () => {}),
    betterSidebar: { updateTab: vi.fn(), openTab: vi.fn() },
  }
}

/** makeCtx plus the archive host faces (the archive cases' whole subject). */
function makeArchiveCtx(store: ReturnType<typeof makeStore>, host: ArchiveHost): Context {
  return {
    sessions: { list: store },
    on: () => () => {},
    get: (key: string) => {
      if (key === 'betterSidebar') return host.betterSidebar
      if (key === 'workspaces') {
        return { list: { getSnapshot: () => ({ archivedSessionIds: host.archivedIds }), subscribe: vi.fn(() => () => {}) } }
      }
      if (key === 'uiWorkspace') return { archiveSession: host.archiveSession }
      return undefined
    },
  } as unknown as Context
}

/** The header archive button (its aria-label is the only such name in the view). */
function archiveButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="归档这条侧边对话（在会话列表的「显示已归档」里可找回）"]')
  if (button === null) throw new Error('the header archive button is absent')
  return button
}

/** Flush the click's promise chain (the archive request and the rebind). */
async function clickArchive(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
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
      return jsonResponse({ ok: true, value: { live: false, provider: 'deepseek', model: 'chat', preset: 'side' } })
    }
    return jsonResponse({ ok: true, value: {} })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
    byId: {
      root: { id: 'root', displayTitle: '主会话', running: false },
      t1: { id: 't1', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
    },
    // The side thread's parent catalog (DSH 0.1.7 projection shape); the view
    // below reads the summary row, not the catalog, but the fixture is the
    // real snapshot shape so a future reader cannot copy a phantom field.
    projectionsBySession: {
      root: {
        values: {
          subagentCatalog: [{ id: 't1', createdAt: 1_000, mode: 'continuable', label: 'Side: 线程一' }],
        },
        state: 'ready',
        error: null,
      },
    },
  })
}

describe('SideChatView rendering', () => {
  it('renders the bash pair as a TerminalBlock and the turn tail with usage + duration', async () => {
    const props = viewProps(makeCtx(threadStore()))
    const { container, unmount } = renderRoot(createElement(SideChatView, props))
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
    const { container, unmount } = renderRoot(createElement(SideChatView, props))
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
    const absent = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    expect(absent.container.textContent ?? '').not.toContain('连接已断开')
    absent.unmount()

    const connection = makeConnection('connected')
    const connected = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore(), connection))))
    expect(connected.container.textContent ?? '').not.toContain('连接已断开')
    connected.unmount()
  })

  it('refreshes an idle thread model after parent selection changes and when shown again', async () => {
    let model = 'model-a'
    vi.spyOn(api, 'sidechatInfo').mockImplementation(async () => ({
      live: false,
      provider: 'provider',
      model,
    }))
    const ctx = makeCtx(threadStore())
    const props = viewProps(ctx)
    const view = renderRoot(createElement(SideChatView, props))
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('provider/model-a')

    model = 'model-b'
    await act(async () => {
      ctx.modelSelectionProjection.set({ lastUsed: null, next: { provider: 'provider', model } })
      await Promise.resolve()
    })
    expect(view.container.textContent).toContain('provider/model-b')

    view.rerender(createElement(SideChatView, { ...props, visible: false }))
    model = 'model-c'
    view.rerender(createElement(SideChatView, { ...props, visible: true }))
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('provider/model-c')
    view.unmount()
  })

  it('shows the executing model followed by the next parent model', async () => {
    vi.spyOn(api, 'sidechatInfo').mockResolvedValue({
      live: true,
      status: 'running',
      provider: 'provider-b',
      model: 'model-b',
      activeProvider: 'provider-a',
      activeModel: 'model-a',
    })
    const view = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => { await Promise.resolve() })

    expect(view.container.textContent).toContain('provider-a/model-a → provider-b/model-b')
    view.unmount()
  })

  it('subscribes to the parent model projection after its binding becomes ready', async () => {
    let model = 'model-a'
    vi.spyOn(api, 'sidechatInfo').mockImplementation(async () => ({
      live: false,
      provider: 'provider',
      model,
    }))
    const store = threadStore()
    const ctx = makeCtx(store)
    ctx.setBindingReady(false)
    const view = renderRoot(createElement(SideChatView, viewProps(ctx)))
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('provider/model-a')

    ctx.setBindingReady(true)
    await act(async () => {
      store.setSnapshot({ ...store.getSnapshot() })
      await Promise.resolve()
    })
    model = 'model-b'
    await act(async () => {
      ctx.modelSelectionProjection.set({ lastUsed: null, next: { provider: 'provider', model } })
      await Promise.resolve()
    })

    expect(view.container.textContent).toContain('provider/model-b')
    expect(view.container.textContent).not.toContain('provider/model-a')
    view.unmount()
  })

  it('invalidates an info request when the bound thread changes', async () => {
    let finishOldInfo!: (info: Awaited<ReturnType<typeof api.sidechatInfo>>) => void
    const oldInfo = new Promise<Awaited<ReturnType<typeof api.sidechatInfo>>>(resolve => {
      finishOldInfo = resolve
    })
    vi.spyOn(api, 'sidechatInfo').mockImplementation(childId => childId === 't1'
      ? oldInfo
      : Promise.resolve({ live: false, provider: 'provider', model: 'model-b' }))
    const props = viewProps(makeCtx(threadStore()))
    const view = renderRoot(createElement(SideChatView, props))
    await act(async () => { await Promise.resolve() })
    view.rerender(createElement(SideChatView, {
      ...props,
      tab: { ...props.tab, meta: { threadId: 't2' } },
    }))
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('provider/model-b')

    await act(async () => {
      finishOldInfo({ live: true, provider: 'provider', model: 'model-a' })
      await oldInfo
    })
    expect(view.container.textContent).toContain('provider/model-b')
    view.unmount()
  })

})

describe('SideChatView archive', () => {
  it('archives the bound thread with stopActivity and rebinds the tab to the newest remaining thread', async () => {
    const host = makeArchiveHost()
    const store = makeStore({
      byId: {
        root: { id: 'root', displayTitle: '主会话', running: false },
        t1: { id: 't1', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
        t2: { id: 't2', displayTitle: 'Side: 线程二', origin: 'subagent', parentId: 'root', running: false },
      },
      // The host's own catalog carries the creation order the fallback ranks by.
      projectionsBySession: {
        root: {
          values: {
            subagentCatalog: [
              { id: 't1', createdAt: 1_000, mode: 'continuable', label: 'Side: 线程一' },
              { id: 't2', createdAt: 2_000, mode: 'continuable', label: 'Side: 线程二' },
            ],
          },
          state: 'ready',
          error: null,
        },
      },
    })
    const props = viewProps(makeArchiveCtx(store, host))
    const { container, unmount } = renderRoot(createElement(SideChatView, props))
    await act(async () => {})  // flush the initial transcript pull

    await clickArchive(archiveButton(container))

    // The host's own archive capability, once, with a running agent settled.
    expect(host.archiveSession).toHaveBeenCalledTimes(1)
    expect(host.archiveSession).toHaveBeenCalledWith('t1', { stopActivity: true })
    // The tab moves to the newest remaining thread (t2 outranks t1 in the catalog).
    expect(host.betterSidebar.updateTab).toHaveBeenCalledTimes(1)
    expect(host.betterSidebar.updateTab).toHaveBeenCalledWith('tab1', { meta: { threadId: 't2' } })
    unmount()
  })

  it('disables the archive button while the thread runs and archives nothing on click', async () => {
    const host = makeArchiveHost()
    const store = makeStore({
      byId: {
        root: { id: 'root', displayTitle: '主会话', running: false },
        t1: { id: 't1', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: true },
      },
    })
    const props = viewProps(makeArchiveCtx(store, host))
    const { container, unmount } = renderRoot(createElement(SideChatView, props))
    await act(async () => {})  // flush the initial transcript pull

    const button = archiveButton(container)
    expect(button.disabled).toBe(true)
    // A disabled button swallows the click: no request, no rebind.
    await clickArchive(button)
    expect(host.archiveSession).not.toHaveBeenCalled()
    expect(host.betterSidebar.updateTab).not.toHaveBeenCalled()
    unmount()
  })

  it('unbinds the tab to the empty state once no thread is left to switch to', async () => {
    const host = makeArchiveHost()
    const store = threadStore()  // the bound thread t1 is the only one under 'root'
    const props = viewProps(makeArchiveCtx(store, host))
    const { container, unmount } = renderRoot(createElement(SideChatView, props))
    await act(async () => {})  // flush the initial transcript pull

    await clickArchive(archiveButton(container))

    expect(host.archiveSession).toHaveBeenCalledWith('t1', { stopActivity: true })
    // `{}` rather than a dangling threadId: the panel unbinds instead of
    // staying bound to the session the host just archived.
    expect(host.betterSidebar.updateTab).toHaveBeenCalledTimes(1)
    expect(host.betterSidebar.updateTab).toHaveBeenCalledWith('tab1', { meta: {} })
    unmount()
  })
})
