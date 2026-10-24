/**
 * Shared real-`SideChatView` harness for the rendering-parity specs
 * (tests/sidechat-markdown-labels.spec.tsx, tests/sidechat-markdown-images.spec.tsx,
 * tests/sidechat-present-card.spec.tsx).
 *
 * Mirrors the inline harness in tests/sidechat-view.spec.tsx: the same
 * FakeLocale / sessions-list store / FakeSocket / fetch stub, plus two things
 * those specs need — a `live` channel on the wire (the host's
 * `assistant/live-chunk` rows, which the transcript route serves separately
 * from the durable log) and an observable `betterSidebar` host face so a file
 * open can be asserted without touching a real host.
 *
 * The specs mutate `harness.wire` BEFORE `harness.mount()` — the fetch stub
 * closes over the same object, so every route reads the test's current wire.
 *
 * Import this from a DOM spec (the importing file carries
 * `// @vitest-environment jsdom`): it mounts a React root into document.body.
 */
import { vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from '../test-utils.ts'
import { SideChatView } from '../../src/client/SideChatView.tsx'
import { attachLocale } from '../../src/client/locales.ts'
import type { Context, SidebarSessionList } from '../../src/context-types.ts'
import type { SidebarTab } from '../../src/client/state.ts'

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
 * The smallest WebSocket the view's push hook talks to: it only has to keep
 * the hook from opening a REAL connection (jsdom's WebSocket would fail
 * asynchronously and leave backoff timers behind).
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

/** What the plugin's `sidechat.events` / `sidechat.info` / `sidechat.models`
 *  routes answer for the thread under test. */
export interface SidechatWire {
  /** The thread's own (seed-cut) durable log. */
  events: unknown[]
  /** The in-flight attempt's client-only rows (replaced on every pull). */
  live: unknown[]
  /** The unclaimed inbox snapshot. */
  pending: unknown[]
  info: Record<string, unknown>
  catalog: Record<string, unknown>
}

/** The host faces the view reaches through `ctx.get('betterSidebar')`. */
export interface SidechatHost {
  openTab: ReturnType<typeof vi.fn>
  updateTab: ReturnType<typeof vi.fn>
}

export interface SidechatHarness {
  /** Mutable wire values; set them before mount(). */
  wire: SidechatWire
  host: SidechatHost
  /** Render the real SideChatView bound to thread 't1' under session 'root'. */
  mount: () => RenderedRoot
  /** Flush React work + the stub's resolved promises (default two rounds). */
  flush: (rounds?: number) => Promise<void>
  /** Type into the composer the way a user does (React's value tracker must
   *  be bypassed, hence the prototype setter). */
  typeComposer: (text: string) => void
  composerValue: () => string
  /** Detach the locale/globals this harness installed. */
  cleanup: () => void
}

/** One JSON envelope the fetch stub answers. */
function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/**
 * Install the fake locale, WebSocket and fetch routing, and return the mount /
 * event-poking surface. Call it from `beforeEach`, and `cleanup()` from
 * `afterEach`.
 */
export function installSidechatHarness(overrides: Partial<SidechatWire> = {}): SidechatHarness {
  const wire: SidechatWire = {
    events: [],
    live: [],
    pending: [],
    info: { live: false, provider: 'deepseek', preset: 'side' },
    catalog: { available: false, groups: [], failures: [] },
    ...overrides,
  }

  attachLocale(new FakeLocale())
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)

  vi.stubGlobal('fetch', async (url: string | URL) => {
    const method = String(url).split('/').pop()
    if (method === 'sidechat.events') {
      return jsonResponse({ ok: true, value: { events: wire.events, live: wire.live, pending: wire.pending } })
    }
    if (method === 'sidechat.info') return jsonResponse({ ok: true, value: wire.info })
    if (method === 'sidechat.models') return jsonResponse({ ok: true, value: wire.catalog })
    if (method === 'sidechat.start') return jsonResponse({ ok: true, value: { childId: 'session-new' } })
    return jsonResponse({ ok: true, value: {} })
  })

  const host: SidechatHost = { openTab: vi.fn(), updateTab: vi.fn() }

  const store = makeStore({
    byId: {
      root: { id: 'root', cwd: '/p', displayTitle: '主会话', running: false },
      t1: { id: 't1', cwd: '/p', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
    },
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

  const ctx = {
    sessions: { list: store },
    get: (key: string) => (key === 'betterSidebar' ? host : undefined),
  } as unknown as Context

  const tab: SidebarTab = { id: 'tab1', type: 'sidechat', title: '线程一', meta: { threadId: 't1' } }
  const props = { ctx, scope: { sessionId: 'root', cwd: '/p' }, tab, visible: true }

  let mounted: RenderedRoot | null = null
  const composer = (): HTMLTextAreaElement => {
    const field = mounted?.container.querySelector('textarea') ?? null
    if (field === null) throw new Error('the composer is missing')
    return field
  }

  return {
    wire,
    host,
    mount: () => {
      mounted = renderRoot(createElement(SideChatView, props))
      return mounted
    },
    flush: async (rounds = 2) => {
      for (let round = 0; round < rounds; round += 1) await act(async () => {})
    },
    typeComposer: (text: string) => {
      const field = composer()
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      act(() => {
        setter?.call(field, text)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    composerValue: () => composer().value,
    cleanup: () => {
      vi.unstubAllGlobals()
      attachLocale(undefined)
    },
  }
}
