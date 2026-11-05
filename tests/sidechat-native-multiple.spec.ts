// @vitest-environment jsdom
/** Regression: host pages are singleton unless multiple:true. Navigation params
 * are NOT persisted by DSH; stable contentId is. Model both contracts rather
 * than trusting the plugin's factory UUID or revealIfOpened:false. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { SIDECHAT_BINDINGS_KEY } from '../src/client/native/sidechat-bindings.ts'

type OpenTab = { sessionId: string; tabId: string; kind: string; contentId: string }
function harness() {
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store)
  const records = createNativeTabRecords()
  let mounted = 's1'
  let rows: OpenTab[] = []
  const mountedListeners = new Set<() => void>()
  const definitions = new Map<string, { kind: string; multiple?: boolean }>()
  let closed: ((sessionId: string, tab: { id: string; kind: string; contentId: string }) => void) | undefined
  const onClose = vi.fn()
  const controller = {
    openTabs: { getSnapshot: () => rows, subscribe: () => () => {} },
    mounted: { getSnapshot: () => mounted, subscribe: (fn: () => void) => { mountedListeners.add(fn); return () => { mountedListeners.delete(fn) } } },
    focus: vi.fn(),
    openTab: vi.fn((kind: string) => {
      // Mirrors DSH's page identity, including its singleton dedupe.
      const contentId = definitions.get(kind)?.multiple ? `sidebar://${kind}/${crypto.randomUUID()}` : `sidebar://${kind}`
      const held = rows.find(row => row.sessionId === mounted && row.contentId === contentId)
      if (held) { controller.focus(held.tabId); return }
      rows = [...rows, { sessionId: mounted, tabId: `tab${rows.length + 1}`, kind, contentId }]
    }),
    registerCloseHandler: (_kind: string, callback: typeof closed) => { closed = callback; return () => { closed = undefined } },
    close: (tabId: string) => {
      const row = rows.find(tab => tab.sessionId === mounted && tab.tabId === tabId)!
      closed?.(mounted, { id: row.tabId, kind: row.kind, contentId: row.contentId })
      rows = rows.filter(tab => tab !== row)
    },
  }
  const registry = { register: (definition: { kind: string; multiple?: boolean }) => { definitions.set(definition.kind, definition); return () => { definitions.delete(definition.kind) } } }
  const ctx = {
    get: (key: string) => key === 'sidebarRight' ? controller : key === 'sidebarRightTabs' ? registry : undefined,
    sessions: { list: { getSnapshot: () => ({ byId: { s1: {}, s2: {} } }), subscribe: () => () => {} } },
    inject: (_deps: readonly string[], callback: (ctx: unknown) => (() => void) | undefined) => {
      const cleanup = callback(ctx)
      return { dispose: () => cleanup?.() }
    },
    slots: { inject: (_key: string, callback: () => () => void) => callback(), register: () => () => {} },
  }
  service.registerTab({ ...builtinTabs(ctx as never).find(tab => tab.id === 'sidechat')!, onClose })
  const disposeRegistration = registerNativeSurface({ ctx: ctx as never, store, service, records })
  const surface = createNativeSurface(ctx as never, records, onClose)
  service.setSurface(surface)
  const mount = (row: OpenTab, threadId: string) => records.ensure({
    sessionId: row.sessionId, id: row.tabId, kind: row.kind, contentId: row.contentId,
    title: threadId, params: { meta: { threadId } }, revision: 1, scope: { sessionId: row.sessionId },
  })
  return { ctx, store, service, records, controller, surface, onClose, mount, rows: () => rows,
    switchSession: (sid: string) => { mounted = sid; mountedListeners.forEach(fn => fn()) },
    dispose: () => { surface.dispose(); disposeRegistration() },
  }
}

beforeEach(() => localStorage.clear())

describe('independent native side chats', () => {
  it('two guide opens get two host occurrences, not one singleton page', () => {
    const h = harness()
    h.controller.openTab('sidechat')
    h.controller.openTab('sidechat')
    expect(h.rows()).toHaveLength(2)
    expect(h.rows()[0]!.contentId).not.toBe(h.rows()[1]!.contentId)
    h.dispose()
  })

  it('new service opens stay separate, while an existing thread focuses even before body mount', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } })
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'b' } })
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } })
    expect(h.rows()).toHaveLength(2)
    expect(h.controller.focus).toHaveBeenLastCalledWith(h.rows()[0]!.tabId)
    h.dispose()
  })

  it('a background reveal:false request dedupes without stealing focus', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } })
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' }, reveal: false })
    expect(h.rows()).toHaveLength(1)
    expect(h.controller.focus).not.toHaveBeenCalled()
    h.dispose()
  })

  it('plain service opens are always fresh, not deduped to the last thread', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat' })
    h.service.openTab({ type: 'sidechat' })
    expect(h.rows()).toHaveLength(2)
    h.dispose()
  })

  it('restores each occurrence from its own binding after registry reload', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } })
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'b' } })
    const reloaded = createNativeTabRecords()
    const restored = h.rows().map(row => reloaded.ensure({ sessionId: 's1', id: row.tabId, kind: 'sidechat',
      contentId: row.contentId, title: '', params: undefined, revision: 0, scope: { sessionId: 's1' },
      mint: () => { throw new Error('restore must not mint') },
    }).tab.meta)
    expect(restored).toEqual([{ threadId: 'a' }, { threadId: 'b' }])
    h.dispose()
  })

  it('a new occurrence ignores old bindings, while remount preserves the exact binding', () => {
    const records = createNativeTabRecords()
    records.sidechatBindings.set('s1', 'sidebar://sidechat/old', 'a', 'A')
    const base = { sessionId: 's1', id: 'tab1', kind: 'sidechat', title: '', params: undefined, scope: { sessionId: 's1' } }
    const mint = vi.fn(() => ({ meta: { autoCreate: true } }))
    expect(records.ensure({ ...base, contentId: 'sidebar://sidechat/new', revision: 1, mint }).tab.meta).toEqual({ autoCreate: true })
    expect(records.ensure({ ...base, contentId: 'sidebar://sidechat/old', revision: 1, params: { meta: { autoCreate: true } }, mint }).tab.meta).toEqual({ threadId: 'a' })
    expect(records.ensure({ ...base, contentId: 'sidebar://sidechat/reset', revision: 0, mint }).tab.meta).toEqual({})
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('separates identical tab ids and content ids belonging to different sessions', () => {
    const records = createNativeTabRecords()
    for (const sessionId of ['s1', 's2']) {
      records.ensure({ sessionId, id: 'tab1', contentId: 'sidebar://sidechat/shared', kind: 'sidechat', title: sessionId,
        scope: { sessionId }, revision: 1, params: { meta: { threadId: sessionId } } })
    }
    const restored = createNativeTabRecords()
    expect(restored.sidechatBindings.get('s1', 'sidebar://sidechat/shared')?.threadId).toBe('s1')
    expect(restored.sidechatBindings.get('s2', 'sidebar://sidechat/shared')?.threadId).toBe('s2')
  })

  it('host close releases just that thread, while teardown keeps durable bindings', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } })
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'b' } })
    const [a, b] = h.rows()
    h.mount(a!, 'a')
    h.mount(b!, 'b')
    h.controller.close(a!.tabId)
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(h.onClose.mock.calls[0]?.[0].meta).toEqual({ threadId: 'a' })
    expect(h.records.sidechatBindings.get('s1', a!.contentId)).toBeUndefined()
    expect(h.records.get('s1', b!.tabId)?.tab.meta).toEqual({ threadId: 'b' })
    h.dispose()
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(createNativeTabRecords().sidechatBindings.get('s1', b!.contentId)?.threadId).toBe('b')
  })

  it('background dedupe waits for the correct session rather than focusing another seat', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } })
    h.switchSession('s2')
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } }, { sessionId: 's1' })
    expect(h.controller.focus).not.toHaveBeenCalled()
    h.switchSession('s1')
    h.surface.flushPending()
    expect(h.rows()).toHaveLength(1)
    expect(h.controller.focus).toHaveBeenCalledWith(h.rows()[0]!.tabId)
    h.dispose()
  })

  it('history opens dedupe across bottom and native carriers, in either direction', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat', target: 'bottom', meta: { threadId: 'bottom-a' } })
    h.store.reduce(state => ({ ...state, bottomOpen: false }))
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'bottom-a' } })
    expect(h.rows()).toHaveLength(0)
    expect(h.store.getSnapshot().state?.bottomOpen).toBe(true)
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'native-b' } })
    h.service.openTab({ type: 'sidechat', target: 'bottom', meta: { threadId: 'native-b' } })
    expect(h.rows()).toHaveLength(1)
    expect(h.controller.focus).toHaveBeenCalledWith(h.rows()[0]!.tabId)
    expect(h.onClose).not.toHaveBeenCalled()
    h.dispose()
  })

  it('rechecks bottom ownership when a queued native open is replayed', () => {
    const h = harness()
    h.switchSession('s2')
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } }, { sessionId: 's1' })
    h.service.openTab({ type: 'sidechat', target: 'bottom', meta: { threadId: 'a' } }, { sessionId: 's1' })
    h.switchSession('s1')
    h.surface.flushPending()
    expect(h.rows()).toHaveLength(0)
    expect(h.onClose).not.toHaveBeenCalled()
    h.dispose()
  })

  it('programmatic close handles a restored occurrence before its body is visited', () => {
    const h = harness()
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'a' } })
    h.service.openTab({ type: 'sidechat', meta: { threadId: 'b' } })
    const [a, b] = h.rows()
    h.surface.dispose()
    const restored = createNativeTabRecords()
    const surface = createNativeSurface(h.ctx as never, restored, h.onClose)
    h.service.setSurface(surface)
    h.service.closeTab(a!.tabId, { sessionId: 's1' })
    expect(h.rows()).toEqual([b])
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(h.onClose.mock.calls[0]?.[0].meta).toEqual({ threadId: 'a' })
    surface.dispose(); h.dispose()
  })

  it('binds close cleanup when the host service arrives without a session-list pulse', () => {
    let available: unknown = undefined
    let arrive: (() => void) | undefined
    let cleanup: (() => void) | undefined
    const unregister = vi.fn()
    const controller = { registerCloseHandler: vi.fn(() => unregister) }
    const ctx = {
      get: () => available,
      inject: (_deps: readonly string[], callback: () => (() => void)) => {
        arrive = () => { cleanup = callback() }
        return { dispose: () => cleanup?.() }
      },
      sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    }
    const surface = createNativeSurface(ctx as never, createNativeTabRecords())
    expect(controller.registerCloseHandler).not.toHaveBeenCalled()
    available = controller
    arrive!()
    expect(controller.registerCloseHandler).toHaveBeenCalledWith('sidechat', expect.any(Function))
    surface.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('corrupt storage cannot bind a thread or prevent an explicit new tab', () => {
    localStorage.setItem(SIDECHAT_BINDINGS_KEY, '{broken')
    const records = createNativeTabRecords()
    expect(records.sidechatBindings.get('s1', 'sidebar://sidechat/a')).toBeUndefined()
    records.sidechatBindings.set('s1', 'sidebar://sidechat/a', 'a', 'A')
    expect(createNativeTabRecords().sidechatBindings.get('s1', 'sidebar://sidechat/a')?.threadId).toBe('a')
  })
})
