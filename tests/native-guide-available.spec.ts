/**
 * The native guide honours a descriptor's `available` (Tracy, 0.21.1-tracy.1).
 *
 * DSH's tab-type registry is static — a type's `guide` is read once per
 * registration — so before this the guide listed every plugin kind whatever
 * `available` said: the three Tracy Build plugins (one per CMS) showed
 * "Build" ×3 and "Live site" ×3 on a single-CMS site (measured 26/09/2026 on
 * the native profile). The adapter now asks `available` for the ON-SCREEN
 * session and re-registers only the TYPE when the answer flips, keeping the
 * body/title slots (an open tab of that kind keeps drawing).
 */
import { describe, expect, it, vi } from 'vitest'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

interface Definition { id: string; kind: string; guide?: readonly { id: string }[] }

/** A registry that, like DSH's, refuses an id still in use. */
function fakeRegistry() {
  const live = new Map<string, Definition>()
  return {
    live,
    register(definition: Definition) {
      if (live.has(definition.id)) throw new Error(`tab type id "${definition.id}" is already registered`)
      live.set(definition.id, definition)
      return () => { live.delete(definition.id) }
    },
    /** The guide rows a reader sees, as kinds (the always-on `files` takeover left out). */
    guideKinds(): string[] {
      return [...live.values()].filter(definition => definition.kind !== 'files' && (definition.guide ?? []).length > 0).map(definition => definition.kind).sort()
    },
  }
}

/** A tiny observable. */
function feed<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of [...listeners]) listener() },
  }
}

function mount() {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const registry = fakeRegistry()
  const mounted = feed<string | undefined>('s1')
  const list = feed<{ byId: Record<string, { cwd?: string }> }>({ byId: { s1: { cwd: '/site/shop' } } })
  let slotRegistrations = 0
  const ctx = {
    inject: (_deps: readonly string[], callback: (injected: { get: () => unknown }) => void) => {
      callback({ get: () => registry })
      return { dispose: () => {} }
    },
    // `sidebarRight` — the controller whose `mounted` feed names the on-screen session.
    get: (name: string) => (name === 'sidebarRight' ? { mounted } : undefined),
    sessions: { list },
    slots: {
      inject: (_key: string, callback: () => () => void) => callback(),
      register: () => { slotRegistrations += 1; return () => {} },
    },
  }
  const reportFailure = vi.fn()
  const records = createNativeTabRecords()
  const dispose = registerNativeSurface({ ctx: ctx as never, store, service, records, reportFailure })
  return { service, registry, mounted, list, reportFailure, dispose, slots: () => slotRegistrations }
}

describe('native guide × available', () => {
  it('keeps a hidden kind registered while omitting its guide entry', () => {
    const { service, registry } = mount()
    service.registerTab({ id: 'changes', title: 'Changes', component: () => null, hidden: true })
    expect(registry.live.has('dsh-better-sidebar:changes')).toBe(true)
    expect(registry.guideKinds()).toEqual([])
  })

  it('lists a kind only while `available` answers true for the on-screen session', () => {
    const { service, registry, list, slots } = mount()
    service.registerTab({ id: 'plain', title: 'Plain', component: () => null })
    service.registerTab({
      id: 'build-wordpress',
      title: 'Build',
      component: () => null,
      available: (_ctx, scope) => scope.cwd === '/site/blog',
    })
    // The on-screen session stands in another CMS's site: registered, not listed.
    expect(registry.live.has('dsh-better-sidebar:build-wordpress')).toBe(true)
    expect(registry.guideKinds()).toEqual(['plain'])
    const slotsBefore = slots()

    // Its cwd changes to the WordPress site: the kind joins the guide…
    list.set({ byId: { s1: { cwd: '/site/blog' } } })
    expect(registry.guideKinds()).toEqual(['build-wordpress', 'plain'])
    // …by re-registering the TYPE only: the body and title slots stay.
    expect(slots()).toBe(slotsBefore)

    list.set({ byId: { s1: { cwd: '/site/shop' } } })
    expect(registry.guideKinds()).toEqual(['plain'])
  })

  it('follows the mounted session, not the first one in the list', () => {
    const { service, registry, list, mounted } = mount()
    list.set({ byId: { s1: { cwd: '/site/shop' }, s2: { cwd: '/site/blog' } } })
    service.registerTab({
      id: 'build-wordpress',
      title: 'Build',
      component: () => null,
      available: (_ctx, scope) => scope.cwd === '/site/blog',
    })
    expect(registry.guideKinds()).toEqual([])
    mounted.set('s2')
    expect(registry.guideKinds()).toEqual(['build-wordpress'])
  })

  it('re-asks on `refreshAvailable` (a registrant whose own lookup finished)', () => {
    const { service, registry } = mount()
    const known = { value: false }
    service.registerTab({ id: 'live', title: 'Live site', component: () => null, available: () => known.value })
    expect(registry.guideKinds()).toEqual([])
    known.value = true
    service.refreshAvailable()
    expect(registry.guideKinds()).toEqual(['live'])
  })

  it('fails open and reports a throwing predicate', () => {
    const { service, registry, reportFailure } = mount()
    service.registerTab({ id: 'broken', title: 'Broken', component: () => null, available: () => { throw new Error('boom') } })
    expect(registry.guideKinds()).toEqual(['broken'])
    expect(reportFailure).toHaveBeenCalledWith('available broken', expect.any(Error))
  })
})
