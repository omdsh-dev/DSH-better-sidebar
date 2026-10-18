/**
 * Side Chat view render tests: tool rows with structured cards render the
 * host's ui-primitives Blocks (terminal surface from a bash call/result
 * pair), the turn-tail usage/duration line renders from the mapped
 * turnSummary row, and the connection banner follows `ctx.connection.state`
 * (shown + reconnect-click while disconnected, hidden once connected, with
 * an immediate transcript pull on recovery).
 *
 * The queue surface (2026-10-12): the unclaimed inbox renders as pending
 * bubbles with a working dequeue, a just-sent message echoes locally before
 * any durable event exists, the thinking spinner appears immediately, and the
 * composer bar's model picker lists the host catalog and pins a route. Every
 * thread function (model / threads / save / archive) must render in that
 * composer bar — below the input — never in a top header.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SideChatView } from '../src/client/SideChatView.tsx'
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
  const snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): SidebarSessionList => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

/**
 * The smallest WebSocket the view's push hook talks to. The view spec never
 * exercises the socket itself (tests/use-sidechat-push.spec.ts does), it only
 * has to keep the hook from opening a REAL connection: jsdom's WebSocket
 * would fail asynchronously and the hook's backoff would leave timers behind.
 */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readonly url: string
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(_frame: string): void {}
  close(): void { this.readyState = 3 }
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

/** The composer-bar archive button (its aria-label is the only such name). */
function archiveButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="归档这条侧边对话（在会话列表的「显示已归档」里可找回）"]')
  if (button === null) throw new Error('the composer-bar archive button is absent')
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

/** The thread's own log BEFORE any model output: a message was sent, nothing
 *  has streamed yet (the immediate thinking-spinner case). */
const EARLY_EVENTS = EVENTS.slice(0, 5)

let eventsPulls = 0
/** The wire values the fetch stub serves; each test overrides what it reads. */
let eventsValue: unknown[] = EVENTS
let pendingValue: unknown[] = []
let infoValue: Record<string, unknown> = { live: false, provider: 'deepseek', preset: 'side' }
let catalogValue: Record<string, unknown> = { available: false, groups: [], failures: [] }
let modelCalls: Record<string, unknown>[] = []
let dequeueCalls: Record<string, unknown>[] = []
/** How many `sidechat.start` requests the current test issued. */
let startCalls = 0
/** Non-null while a test wants `sidechat.prompt` to stay in flight. */
let promptHold: Promise<void> | null = null
/** Non-null to make `sidechat.prompt` answer a failed envelope. */
let promptError: string | null = null

/** EVENTS with the durable user message carrying an identity (dedupe cases). */
function eventsWithUserId(id: string, text?: string): unknown[] {
  return EVENTS.map(event => (event.type === 'user/message'
    ? {
      ...event,
      data: {
        ...event.data,
        id,
        ...(text !== undefined ? { content: [{ type: 'text', text }] } : {}),
      },
    }
    : event))
}

/** Type into the composer the way a user does (React's value tracker must be
 *  bypassed, hence the prototype setter). */
function typeComposer(container: HTMLElement, text: string): void {
  const field = container.querySelector('textarea')
  if (field === null) throw new Error('the composer is missing')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  attachLocale(new FakeLocale())
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  eventsPulls = 0
  eventsValue = EVENTS
  pendingValue = []
  infoValue = { live: false, provider: 'deepseek', preset: 'side' }
  catalogValue = { available: false, groups: [], failures: [] }
  modelCalls = []
  dequeueCalls = []
  startCalls = 0
  promptHold = null
  promptError = null
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    const payload: Record<string, unknown> = init?.body === undefined
      ? {}
      : JSON.parse(String(init.body)) as Record<string, unknown>
    if (method === 'sidechat.events') {
      eventsPulls += 1
      return jsonResponse({ ok: true, value: { events: eventsValue, live: [], pending: pendingValue } })
    }
    if (method === 'sidechat.info') return jsonResponse({ ok: true, value: infoValue })
    if (method === 'sidechat.models') return jsonResponse({ ok: true, value: catalogValue })
    if (method === 'sidechat.start') {
      startCalls += 1
      return jsonResponse({ ok: true, value: { childId: 'session-new' } })
    }
    if (method === 'sidechat.model') {
      modelCalls.push(payload)
      return jsonResponse({ ok: true, value: { accepted: true, selection: payload } })
    }
    if (method === 'sidechat.dequeue') {
      dequeueCalls.push(payload)
      // The host really takes the message out; the follow-up pull must agree.
      pendingValue = pendingValue.filter(item => (item as { id?: unknown }).id !== payload.messageId)
      return jsonResponse({ ok: true, value: { accepted: true, removed: 1 } })
    }
    if (method === 'sidechat.prompt') {
      if (promptError !== null) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ ok: false, error: { code: 'prompt', message: promptError } }),
        } as unknown as Response
      }
      if (promptHold !== null) await promptHold
      return jsonResponse({ ok: true, value: { accepted: true } })
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

describe('SideChatView queue, echo and model picker', () => {
  /** The catalogue the picker cases serve (the host's own shape). */
  const CATALOG = {
    available: true,
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'chat', name: 'Chat', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
        { id: 'reasoner', name: 'Reasoner' },
      ],
    }],
    failures: [],
  }

  /** Open the portalled model menu and return its rows. */
  async function openModelMenu(container: HTMLElement): Promise<HTMLButtonElement[]> {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="模型"]')
    if (trigger === null) throw new Error('the model picker trigger is absent')
    await act(async () => { trigger.click() })
    return [...document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
  }

  it('creates a fresh thread from the leftmost + button', async () => {
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull

    const plus = container.querySelector<HTMLButtonElement>('button[aria-label="新建对话"]')
    if (plus === null) throw new Error('the new-thread button must render')
    await act(async () => { plus.click() })
    await act(async () => { await Promise.resolve() })

    // Same route as the thread menu's "new" row: one sidechat.start, no prompt.
    expect(startCalls).toBe(1)
    unmount()
  })

  it('mirrors the main composer bar: icons left, model selector right', async () => {
    // A thread with no completed turn: save is disabled and its hint shows,
    // so the hint must land in the same band as the controls it explains.
    eventsValue = EARLY_EVENTS
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull

    const input = container.querySelector('textarea')
    expect(input).not.toBeNull()
    // The composer box is the input's own container; every thread action must
    // be INSIDE it. They used to live in a header above the transcript, where
    // the reader never noticed them.
    const composer = input!.parentElement
    expect(composer).not.toBeNull()
    const byLabel = (label: string): HTMLElement => {
      const control = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`)
      expect(control, `${label} must render`).not.toBeNull()
      expect(composer!.contains(control), `${label} must live in the composer box`).toBe(true)
      return control!
    }
    const newThread = byLabel('新建对话')
    const threads = byLabel('切换线程 / 新建')
    const save = byLabel('保存为新会话')
    const archive = byLabel('归档这条侧边对话（在会话列表的「显示已归档」里可找回）')
    const model = byLabel('模型')
    const send = byLabel('发送')

    /** Whether `later` follows `earlier` in document order. */
    const follows = (later: HTMLElement, earlier: HTMLElement): boolean =>
      (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    // Four icon actions on the left — NEW THREAD FIRST, then threads · save ·
    // archive — and the model selector on the right, right before send (the
    // main conversation's own bottom-bar arrangement).
    expect(follows(threads, newThread)).toBe(true)
    expect(follows(save, threads)).toBe(true)
    expect(follows(archive, save)).toBe(true)
    expect(follows(model, archive)).toBe(true)
    expect(follows(send, model)).toBe(true)

    // Every control anchors a hover bubble on an ENABLED span inside the bar
    // (a disabled button fires no pointer events, so save/archive could not
    // explain themselves otherwise), and the native `title` bubble is gone:
    // the styled popup replaced it.
    for (const control of [newThread, threads, save, archive, model, send]) {
      expect(control.getAttribute('title'), 'no native title bubble').toBeNull()
      const anchor = control.parentElement
      expect(anchor?.tagName, 'each control sits in a hover anchor').toBe('SPAN')
      expect(composer!.contains(anchor), 'the anchor must be inside the composer box').toBe(true)
    }

    // No agent badge ("standard · deepseek-flash"): the selector names the
    // route, the preset only lives in its hover bubble.
    expect(composer!.textContent ?? '').not.toMatch(/side · deepseek/)

    // The save hint sits in the same band, immediately above the composer.
    const hint = [...container.querySelectorAll('div')]
      .find(node => node.textContent === '至少完成一轮对话后才能保存')
    expect(hint, 'the disabled-save hint must render').toBeDefined()
    expect(composer!.parentElement!.contains(hint!)).toBe(true)
    expect(hint!.compareDocumentPosition(input!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    unmount()
  })

  it('renders the unclaimed inbox as a pending bubble and drops it on the ✕', async () => {
    pendingValue = [{ id: 'm1', target: 'next-step', text: '排在队里的问题' }]
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull

    expect(container.textContent ?? '').toContain('排在队里的问题')
    expect(container.textContent ?? '').toContain('排队中')

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="从队列移除"]')
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })
    await act(async () => { await Promise.resolve() })

    // The wire call names the child and the message; the row left the view.
    expect(dequeueCalls).toEqual([{ childId: 't1', messageId: 'm1' }])
    expect(container.textContent ?? '').not.toContain('排在队里的问题')
    unmount()
  })

  it('never renders a claimed message twice (pending id already on a durable row)', async () => {
    eventsValue = eventsWithUserId('msg-7', 'claimed-once')
    pendingValue = [{ id: 'msg-7', target: 'next-step', text: 'claimed-once' }]
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull

    expect(container.textContent ?? '').toContain('claimed-once')
    // One bubble, not two: the durable user row is authoritative.
    expect((container.textContent ?? '').match(/claimed-once/g)).toHaveLength(1)
    // …and no dequeue affordance for a message the host already claimed.
    expect(container.querySelector('button[aria-label="从队列移除"]')).toBeNull()
    unmount()
  })

  it('echoes a sent message immediately, with the busy send button and the thinking spinner', async () => {
    // Nothing has been produced yet: the spinner must appear on its own.
    eventsValue = EARLY_EVENTS
    promptHold = new Promise<void>(() => {})  // the send stays in flight
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull

    act(() => { typeComposer(container, 'echo me') })
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')
    expect(send).not.toBeNull()
    await act(async () => { send?.click() })

    // The bubble is on screen before ANY durable event or pending row exists.
    expect(pendingValue).toEqual([])
    expect(container.textContent ?? '').toContain('echo me')
    expect(container.textContent ?? '').toContain('发送中…')
    // The spinner is immediate, not gated on the host's running flag…
    expect(container.textContent ?? '').toContain('正在深入…')
    // …and the send button is busy (the composer is NOT empty yet — only the
    // in-flight state can be what disables it).
    expect(send?.disabled).toBe(true)
    unmount()
  })

  it('retires the echo once the host reports the message pending', async () => {
    pendingValue = [{ id: 'm9', target: 'next-step', text: 'echo me' }]
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull

    act(() => { typeComposer(container, 'echo me') })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')?.click()
    })
    await act(async () => { await Promise.resolve() })

    // The pending bubble took over the echo: exactly one bubble, now queued.
    expect(container.textContent ?? '').toContain('排队中')
    expect(container.textContent ?? '').not.toContain('发送中…')
    expect((container.textContent ?? '').match(/echo me/g)).toHaveLength(1)
    unmount()
  })

  it('drops the echo and reports the failure when the send is rejected', async () => {
    promptError = 'provider rejected the message'
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull

    act(() => { typeComposer(container, 'doomed message') })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')?.click()
    })
    await act(async () => { await Promise.resolve() })

    expect(container.textContent ?? '').toContain('provider rejected the message')
    // The echo is gone (its bubble always carries a state word); the composer
    // keeps the text so the reader can retry.
    expect(container.textContent ?? '').not.toContain('发送中…')
    expect(container.textContent ?? '').not.toContain('排队中')
    expect(container.querySelector('textarea')?.value).toBe('doomed message')
    unmount()
  })

  it('shows the current model and pins the chosen route from the host catalog', async () => {
    infoValue = { live: false, provider: 'deepseek', model: 'chat', preset: 'side' }
    catalogValue = CATALOG
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull
    await act(async () => { await Promise.resolve() })  // flush the catalog read

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="模型"]')
    expect(trigger?.textContent).toContain('chat')

    const items = await openModelMenu(container)
    // The portalled menu renders outside the container: provider heading,
    // every model, and the reasoning submenu for the model in use.
    const menuText = document.body.textContent ?? ''
    expect(menuText).toContain('DeepSeek')
    expect(menuText).toContain('Reasoner')
    expect(menuText).toContain('推理强度')

    const reasoner = items.find(item => item.textContent?.includes('Reasoner'))
    expect(reasoner).toBeDefined()
    await act(async () => { reasoner?.click() })
    await act(async () => { await Promise.resolve() })

    // A plain route carries no reasoning effort (this model declares none).
    expect(modelCalls).toEqual([{ childId: 't1', provider: 'deepseek', model: 'reasoner' }])
    unmount()
  })

  it('pins one reasoning effort of the model in use', async () => {
    infoValue = { live: false, provider: 'deepseek', model: 'chat', reasoningEffort: 'low', preset: 'side' }
    catalogValue = CATALOG
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull
    await act(async () => { await Promise.resolve() })

    const items = await openModelMenu(container)
    // The efforts are flat rows of the same menu, NOT a nested submenu: the
    // host's submenu card opens to the RIGHT, off-screen from a picker pinned
    // to the sidebar's right edge (and it would freeze the panel's scrolling).
    expect(document.body.querySelector('[role="menu"] [aria-haspopup="menu"]')).toBeNull()
    expect(items.some(item => item.textContent?.includes('推理强度'))).toBe(false)
    expect(document.body.textContent ?? '').toContain('推理强度')

    const effort = items.find(item => item.textContent?.includes('High'))
    expect(effort).toBeDefined()
    await act(async () => { effort?.click() })
    await act(async () => { await Promise.resolve() })

    expect(modelCalls).toEqual([{ childId: 't1', provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }])
    unmount()
  })

  it('offers only the inherited conversation when the host has no catalog', async () => {
    const { container, unmount } = renderRoot(createElement(SideChatView, viewProps(makeCtx(threadStore()))))
    await act(async () => {})  // flush the initial transcript pull
    await act(async () => { await Promise.resolve() })

    const items = await openModelMenu(container)
    expect(items).toHaveLength(1)
    expect(items[0]?.disabled).toBe(true)
    expect(items[0]?.textContent).toContain('继承主对话')
    unmount()
  })
})
