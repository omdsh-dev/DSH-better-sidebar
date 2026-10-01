/**
 * A host-supplied tab policy (Tracy, 0.21.1-tracy.13, feature `setTabPolicy`).
 *
 * The host decides, per tab type, whether it EXISTS for this deployment's viewers and whether it is
 * LISTED in the + menu and the native guide. Tracy feeds it from the operator's switches at
 * `/ops` › User Interface; the side card knows no Tracy id. "Not allowed" behaves like the viewer's
 * own disable switch (no entry, `openTab` refuses) except the viewer cannot switch it back on;
 * "not listed" only drops the menu and guide entry — deep links and derived flows still open it.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { buildNewTabOptions } from '../src/client/sidebar/TabContent.tsx'
import { createSidebarStore, makeDefaultState } from '../src/client/state.ts'

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


const menuIds = (service: ReturnType<typeof createBetterSidebarService>): string[] =>
  buildNewTabOptions(makeDefaultState(), { get: () => service } as never, { sessionId: 's1' }).map(o => o.id).sort()

describe('host tab policy', () => {
  it('a type that is not allowed has no entry anywhere and refuses to open', () => {
    const { service, registry } = mount()
    service.registerTab({ id: 'git', title: 'Git', component: () => null })
    service.registerTab({ id: 'team', title: 'Team', component: () => null })
    service.setTabPolicy({ isAllowed: id => id !== 'git', isListed: () => true })

    expect(service.isTabEnabled('git')).toBe(false)
    expect(registry.live.has('dsh-better-sidebar:git')).toBe(false)
    expect(registry.guideKinds()).toEqual(['team'])
    expect(menuIds(service)).toEqual(['team'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    service.openTab({ type: 'git' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a type that is not listed stays registered and openable, with no menu or guide entry', () => {
    const { service, registry } = mount()
    service.registerTab({ id: 'build', title: 'Build', component: () => null })
    service.registerTab({ id: 'add-site', title: 'Add site', component: () => null })
    service.setTabPolicy({ isAllowed: () => true, isListed: id => id === 'add-site' })

    expect(service.isTabEnabled('build')).toBe(true)
    expect(registry.live.has('dsh-better-sidebar:build')).toBe(true)
    expect(registry.guideKinds()).toEqual(['add-site'])
    expect(menuIds(service)).toEqual(['add-site'])
  })

  it('the Files guide row follows the editor type being listed', () => {
    const { service, registry } = mount()
    service.registerTab({ id: 'editor', title: 'Files', component: () => null })
    const filesListed = () => (registry.live.get('dsh-better-sidebar:files')?.guide ?? []).length > 0
    expect(filesListed()).toBe(true)
    service.setTabPolicy({ isAllowed: () => true, isListed: id => id !== 'editor' })
    expect(registry.live.has('dsh-better-sidebar:files')).toBe(true)
    expect(filesListed()).toBe(false)
  })

  it('relisting Files re-registers only its type: its slots stay and nothing fails', () => {
    const { service, registry, reportFailure, slots } = mount()
    service.registerTab({ id: 'editor', title: 'Files', component: () => null })
    const slotsBefore = slots()
    const filesListed = () => (registry.live.get('dsh-better-sidebar:files')?.guide ?? []).length > 0
    service.setTabPolicy({ isAllowed: () => true, isListed: id => id !== 'editor' })
    expect(filesListed()).toBe(false)
    service.setTabPolicy({ isAllowed: () => true, isListed: () => true })
    expect(filesListed()).toBe(true)
    service.setTabPolicy({ isAllowed: () => true, isListed: id => id !== 'editor' })
    expect(filesListed()).toBe(false)
    // The body and title slots of the Files page were registered once, not per flip: a
    // re-registration of slots is what failed on the stand ("cannot create effect on inactive
    // context"), leaving the type behind so every later sync reported it "already registered".
    expect(slots()).toBe(slotsBefore)
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it('a new policy re-syncs the surface, and its disposer restores the default', () => {
    const { service, registry } = mount()
    service.registerTab({ id: 'git', title: 'Git', component: () => null })
    const dispose = service.setTabPolicy({ isAllowed: () => true, isListed: () => false })
    expect(registry.guideKinds()).toEqual([])
    service.setTabPolicy({ isAllowed: () => true, isListed: () => true })
    expect(registry.guideKinds()).toEqual(['git'])
    dispose()
    expect(registry.guideKinds()).toEqual(['git'])
    expect(service.isTabEnabled('git')).toBe(true)
  })
})
