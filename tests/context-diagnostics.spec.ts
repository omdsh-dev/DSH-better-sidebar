/**
 * Context diagnostics must remain optional, session-correct and cancellable.
 * Includes real Cordis child-fiber lifetimes, not only structural service mocks.
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContextDiagnostics, type ContextDiagnostics } from '../src/client/context-diagnostics.ts'
import type { Context, SidebarSubagentAddress } from '../src/context-types.ts'

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
    count: () => listeners.size,
  }
}

const child: SidebarSubagentAddress = { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }
const target = { sessionId: 'child', label: 'Child agent', address: child }
const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.useRealTimers()
})

function harness() {
  const mounted = observable<string | undefined>('parent')
  const tabs = observable<Array<{ sessionId: string; tabId: string; kind: string }>>([])
  const registry = observable(true)
  const bodies = observable(true)
  const calls: string[] = []
  let selectedTab: string | undefined
  let navigation = new AbortController()
  const state = {
    ready: true, autoSwitch: true, expanded: false, openError: undefined as Error | undefined,
    typeId: 'dsh-context', bodyId: 'dsh-context',
  }
  const right = {
    mounted,
    openTabs: tabs,
    openTab: vi.fn((kind: string) => {
      calls.push(`open:${mounted.getSnapshot()}:${kind}`)
      if (!state.ready) throw new Error('sidebarRight: no session surface is mounted')
      if (state.openError !== undefined) throw state.openError
      const sessionId = mounted.getSnapshot()
      if (sessionId === undefined) throw new Error('sidebarRight: no session surface is mounted')
      const tabId = `tab${tabs.getSnapshot().length + 1}`
      tabs.set([...tabs.getSnapshot(), { sessionId, tabId, kind }])
      selectedTab = tabId
      state.expanded = true
    }),
    active: () => state.ready && selectedTab !== undefined ? { id: selectedTab } : undefined,
    focus: vi.fn((tabId: string) => { if (state.ready) selectedTab = tabId }),
    isExpanded: () => state.expanded,
    toggleExpanded: vi.fn(() => { if (state.ready) state.expanded = !state.expanded }),
  }
  const workspace = {
    openSession: vi.fn((address: string | SidebarSubagentAddress) => {
      const id = typeof address === 'string' ? address : address.childSessionId
      calls.push(`switch:${id}`)
      // The real workspace selects the conversation panel and aborts older navigation.
      navigation.abort()
      if (state.autoSwitch) mounted.set(id)
    }),
  }
  const services: Record<string, unknown> = {
    sidebarRight: right,
    sidebarRightTabs: {
      get: (kind: string) => kind === 'dsh-context' && registry.getSnapshot() ? { id: state.typeId, kind } : undefined,
      subscribe: registry.subscribe,
    },
    slots: {
      entriesOfSlot: (key: string) => key === 'sidebar.right.pane.tab' && bodies.getSnapshot() ? [{ options: { key: state.bodyId } }] : [],
      subscribe: (_key: string, listener: () => void) => bodies.subscribe(listener),
    },
    uiWorkspace: workspace,
    layout: {
      beginNavigation: () => { navigation.abort(); navigation = new AbortController(); return navigation.signal },
    },
  }
  let detach: (() => void) | undefined
  let attach: (() => void) | undefined
  const ctx = {
    get: (name: string) => services[name],
    inject: (_deps: string[], callback: (ctx: Context) => (() => void) | undefined) => {
      attach = () => { detach = callback(ctx as unknown as Context) }
      attach()
      return { dispose: () => { detach?.(); detach = undefined } }
    },
  } as unknown as Context
  const controller = createContextDiagnostics(ctx)
  disposers.push(() => { controller.dispose() })
  return {
    controller, services, right, workspace, mounted, tabs, registry, bodies, calls, state,
    leave: (id?: string) => { navigation.abort(); mounted.set(id) },
    disconnect: () => { detach?.(); detach = undefined },
    reconnect: () => { attach?.() },
  }
}

describe('Context diagnostics navigation', () => {
  it('reacts to both type and body registration without idle work or redundant notifications', () => {
    vi.useFakeTimers()
    const h = harness()
    const notify = vi.fn()
    h.controller.subscribe(notify)
    expect(h.controller.getSnapshot()).toEqual({ available: true, busy: false })
    h.registry.set(true)
    h.bodies.set(true)
    expect(notify).not.toHaveBeenCalled()
    h.bodies.set(false)
    expect(h.controller.getSnapshot().available).toBe(false)
    h.registry.set(false)
    h.bodies.set(true)
    expect(h.controller.getSnapshot().available).toBe(false)
    h.registry.set(true)
    expect(h.controller.getSnapshot().available).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(h.mounted.count()).toBe(0)
    expect(h.tabs.count()).toBe(0)
  })

  it('matches the active type implementation to its body, not id to kind', () => {
    const h = harness()
    h.state.typeId = 'context-implementation'
    h.registry.set(true)
    expect(h.controller.getSnapshot().available).toBe(false)
    h.state.bodyId = 'context-implementation'
    h.bodies.set(true)
    expect(h.controller.getSnapshot().available).toBe(true)
  })

  it('does not issue a second creation while successful open inventory publication is delayed', () => {
    vi.useFakeTimers()
    const h = harness()
    h.right.openTab.mockImplementation(() => {})
    h.controller.open(target)
    vi.advanceTimersByTime(500)
    expect(h.right.openTab).toHaveBeenCalledTimes(1)
    h.tabs.set([{ sessionId: 'child', tabId: 'late-context', kind: 'dsh-context' }])
    expect(h.controller.getSnapshot().busy).toBe(false)
    expect(h.right.active()?.id).toBe('late-context')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a rejected navigation and releases the request without opening a tab', () => {
    vi.useFakeTimers()
    const h = harness()
    h.workspace.openSession.mockImplementation(() => { throw new Error('unknown session') })
    h.controller.open(target)
    expect(h.controller.getSnapshot().error?.reason).toBe('navigation')
    expect(h.right.openTab).not.toHaveBeenCalled()
    expect(h.mounted.count()).toBe(0)
    expect(h.tabs.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('switches using the complete child address, then opens the child, without self-cancelling', () => {
    vi.useFakeTimers()
    const h = harness()
    h.controller.open(target)
    expect(h.workspace.openSession).toHaveBeenCalledWith(child)
    expect(h.calls).toEqual(['switch:child', 'open:child:dsh-context'])
    expect(h.right.active()?.id).toBe('tab1')
    expect(h.controller.getSnapshot()).toEqual({ available: true, busy: false })
    expect(vi.getTimerCount()).toBe(0)
    expect(h.mounted.count()).toBe(0)
    expect(h.tabs.count()).toBe(0)
  })

  it('does not navigate when the exact target is already mounted', () => {
    const h = harness()
    h.mounted.set('child')
    h.controller.open(target)
    expect(h.workspace.openSession).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['open:child:dsh-context'])
  })

  it('does not open in the parent while a delayed child selection is pending', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.autoSwitch = false
    h.controller.open(target)
    expect(h.right.openTab).not.toHaveBeenCalled()
    h.mounted.set(undefined)
    expect(h.controller.getSnapshot().busy).toBe(true)
    h.mounted.set('child')
    expect(h.calls).toEqual(['switch:child', 'open:child:dsh-context'])
    expect(h.controller.getSnapshot().busy).toBe(false)
  })

  it('waits for the arriving sidebar store and cleans up the bounded retry', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.ready = false
    h.controller.open(target)
    expect(h.controller.getSnapshot().busy).toBe(true)
    vi.advanceTimersByTime(100)
    h.state.ready = true
    vi.advanceTimersByTime(50)
    expect(h.controller.getSnapshot()).toEqual({ available: true, busy: false })
    expect(h.tabs.getSnapshot()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reuses a Context in another pane and expands its collapsed sidebar', () => {
    const h = harness()
    h.tabs.set([
      { sessionId: 'parent', tabId: 'parent-context', kind: 'dsh-context' },
      { sessionId: 'child', tabId: 'child-context', kind: 'dsh-context' },
    ])
    h.controller.open(target)
    expect(h.right.openTab).not.toHaveBeenCalled()
    expect(h.right.focus).toHaveBeenCalledWith('child-context')
    expect(h.right.toggleExpanded).toHaveBeenCalledTimes(1)
    expect(h.right.active()?.id).toBe('child-context')
  })

  it('does not treat a saved tab as a ready surface when focus is still a no-op', () => {
    vi.useFakeTimers()
    const h = harness()
    h.tabs.set([{ sessionId: 'child', tabId: 'saved-context', kind: 'dsh-context' }])
    h.state.ready = false
    h.controller.open(target)
    expect(h.controller.getSnapshot().busy).toBe(true)
    h.state.ready = true
    vi.advanceTimersByTime(50)
    expect(h.controller.getSnapshot().busy).toBe(false)
    expect(h.right.active()?.id).toBe('saved-context')
    expect(h.right.openTab).not.toHaveBeenCalled()
  })

  it('deduplicates simultaneous entry clicks and releases source subscriptions independently', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.autoSwitch = false
    const unmountSource = h.controller.subscribe(() => {})
    h.controller.open(target)
    h.controller.open({ sessionId: 'other' })
    unmountSource()
    h.mounted.set('child')
    expect(h.workspace.openSession).toHaveBeenCalledTimes(1)
    expect(h.calls).toEqual(['switch:child', 'open:child:dsh-context'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['other', undefined])('cancels when the user navigates to %s and never replays later', (id) => {
    vi.useFakeTimers()
    const h = harness()
    h.state.autoSwitch = false
    h.controller.open(target)
    h.leave(id)
    h.mounted.set('child')
    vi.advanceTimersByTime(20_000)
    expect(h.right.openTab).not.toHaveBeenCalled()
    expect(h.controller.getSnapshot()).toEqual({ available: true, busy: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out after ten seconds without opening a late-arriving target', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.autoSwitch = false
    h.controller.open(target)
    vi.advanceTimersByTime(9_999)
    expect(h.controller.getSnapshot().busy).toBe(true)
    vi.advanceTimersByTime(1)
    expect(h.controller.getSnapshot().error).toEqual({ reason: 'timeout', targetLabel: 'Child agent' })
    h.mounted.set('child')
    expect(h.right.openTab).not.toHaveBeenCalled()
    h.controller.dismissError()
    expect(h.controller.getSnapshot().error).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports capability loss mid-flight and does not resume when it returns', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.ready = false
    h.controller.open(target)
    h.bodies.set(false)
    expect(h.controller.getSnapshot()).toEqual({ available: false, busy: false, error: { reason: 'unavailable', targetLabel: 'Child agent' } })
    h.bodies.set(true)
    h.state.ready = true
    const count = h.right.openTab.mock.calls.length
    vi.advanceTimersByTime(20_000)
    expect(h.right.openTab).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports non-readiness errors once instead of retrying arbitrary failures', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.openError = new Error('broken registration')
    h.controller.open(target)
    expect(h.controller.getSnapshot().error?.reason).toBe('open')
    expect(h.right.openTab).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a mismatched child identity before changing the current session', () => {
    const h = harness()
    h.controller.open({ sessionId: 'other', address: child })
    expect(h.workspace.openSession).not.toHaveBeenCalled()
    expect(h.controller.getSnapshot().error?.reason).toBe('navigation')
  })

  it('never navigates after a busy-state listener disposes the plugin synchronously', () => {
    vi.useFakeTimers()
    const h = harness()
    h.controller.subscribe(() => {
      if (h.controller.getSnapshot().busy) h.controller.dispose()
    })
    h.controller.open(target)
    expect(h.workspace.openSession).not.toHaveBeenCalled()
    expect(h.right.openTab).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('prevents a final-state listener from opening a new request during disposal', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.autoSwitch = false
    h.controller.open(target)
    let reopened = false
    h.controller.subscribe(() => {
      if (!h.controller.getSnapshot().busy && !reopened) {
        reopened = true
        h.controller.open({ sessionId: 'other' })
      }
    })
    h.controller.dispose()
    expect(h.workspace.openSession).toHaveBeenCalledTimes(1)
    expect(h.mounted.count()).toBe(0)
    expect(h.tabs.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unwinds all event resources on service replacement and plugin disposal', () => {
    vi.useFakeTimers()
    const h = harness()
    h.state.autoSwitch = false
    h.controller.open(target)
    h.disconnect()
    expect(h.registry.count()).toBe(0)
    expect(h.bodies.count()).toBe(0)
    expect(h.mounted.count()).toBe(0)
    expect(h.tabs.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    h.reconnect()
    expect(h.registry.count()).toBe(1)
    expect(h.bodies.count()).toBe(1)
    h.controller.open(target)
    h.controller.dispose()
    expect(h.registry.count()).toBe(0)
    expect(h.bodies.count()).toBe(0)
    expect(h.mounted.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    h.mounted.set('child')
    expect(h.right.openTab).not.toHaveBeenCalled()
  })
})

it('uses real Cordis optional child fibers for late services and replacement', async () => {
  const runtime = new CordisContext()
  const h = harness()
  let controller: ContextDiagnostics | undefined
  const owner = await runtime.plugin((ctx) => {
    controller = createContextDiagnostics(ctx as Context)
    return () => { controller?.dispose() }
  })
  expect(controller?.getSnapshot().available).toBe(false)
  const install = () => runtime.plugin((ctx) => {
    for (const [name, service] of Object.entries(h.services)) ctx.provide(name as never, service as never)
  })
  let host = await install()
  try {
    await vi.waitFor(() => { expect(controller?.getSnapshot().available).toBe(true) })
    await host.dispose()
    await vi.waitFor(() => { expect(controller?.getSnapshot().available).toBe(false) })
    host = await install()
    await vi.waitFor(() => { expect(controller?.getSnapshot().available).toBe(true) })
    controller?.open(target)
    expect(h.calls).toEqual(['switch:child', 'open:child:dsh-context'])
  } finally {
    await owner.dispose()
    await host.dispose()
  }
  // Only the independent structural harness remains subscribed.
  expect(h.registry.count()).toBe(1)
  expect(h.bodies.count()).toBe(1)
})
