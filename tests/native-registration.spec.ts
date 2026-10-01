// @vitest-environment jsdom
/**
 * The native tab registration LIFECYCLE (`src/client/native/index.ts`): what a
 * store/service notification may do to the host's tab-type registry, and what
 * a failed registration is allowed to leave behind.
 *
 * The failure this locks is a plugin RELOAD: cordis tears the fiber down, each
 * built-in descriptor is unregistered one by one, every unregistration notifies
 * the plugin's service, and `sync()` therefore runs again on a context that is
 * already inactive. A registration attempted there throws
 * (`ctx.effect` on an inactive context) — and if the host-side type was already
 * registered at that point, its disposer is lost, the id stays taken for the
 * rest of the page's life, and every later attempt is refused with
 * `tab type id "…" is already registered`. The kind then renders the host's
 * "nothing here can view this kind of content" face until a page refresh.
 *
 * Three properties keep that impossible, and all are asserted here:
 *   1. an unrelated notification never re-creates the `files` takeover (the
 *      tear-down/re-register window the reload used to walk into);
 *   2. a registration that fails after its type was registered releases the
 *      type again, so the id stays registrable and one broken descriptor cannot
 *      take the others down with it;
 *   3. slots installed before the failing one are released too (the partial
 *      release inside `registerSlots`).
 *
 * The assertions are written against the fake registry's EVENT LOG, not only
 * against the set of live ids: an orphaned type leaves the key set identical to
 * a healthy one, so a key-set assertion would pass on the unfixed code and pin
 * nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

/**
 * The fake `sidebarRightTabs`, mirroring the host's two hard rules: one
 * registration per id, and the returned disposer is the only way to free it.
 */
function createRegistry() {
  const registered = new Map<string, () => void>()
  const events: string[] = []
  let failReleaseOf: string | undefined
  return {
    registered,
    events,
    failRelease(id: string): void { failReleaseOf = id },
    register(definition: { id: string }): () => void {
      if (registered.has(definition.id)) {
        throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
      }
      events.push(`register ${definition.id}`)
      // The host's disposer is IDEMPOTENT (a cordis effect disposer returns
      // the same task on a second call), so a repeated release must neither
      // log again nor pretend to free something twice.
      let released = false
      const dispose = (): void => {
        if (released) return
        if (failReleaseOf === definition.id) throw new Error(`cannot release ${definition.id}`)
        released = true
        registered.delete(definition.id)
        events.push(`release ${definition.id}`)
      }
      registered.set(definition.id, dispose)
      return dispose
    },
  }
}

/**
 * A fake client context: `slots.inject` runs its callback synchronously (the
 * real one resolves the declaration and calls `ctx.effect`, which throws while
 * `inactive`), a slot listed in `failSlots` throws from `slots.register`, and
 * `inject` hands back the registry while honouring the callback's own teardown.
 *
 * Slot failures are keyed by `name::key` — NOT by `key` alone. Both slots of a
 * descriptor share the same key, so a key-keyed failure can only ever fail the
 * FIRST slot; failing the second one for a single descriptor is the only shape
 * that exercises `registerSlots`' partial release (the first slot is already
 * installed when the second throws).
 */
function createHost() {
  const registry = createRegistry()
  /** Slot registrations and releases, in order (the partial-release witness). */
  const slotEvents: string[] = []
  // One mutable state object the ctx closures read: the test flips it after
  // the host was built.
  const state = {
    /** True while the plugin's context is being torn down (the reload case). */
    inactive: false,
    /** `name::key` slots whose registration throws. */
    failSlots: new Set<string>(),
  }
  const slotId = (options: { name: string; key?: string }): string => `${options.name}::${options.key ?? ''}`
  const ctx = {
    inject: (
      _deps: readonly string[],
      callback: (injected: { get: (name: string) => unknown }) => (() => void) | void,
    ) => {
      const teardown = callback({ get: () => registry })
      return { dispose: () => { if (typeof teardown === 'function') teardown() } }
    },
    get: () => registry,
    slots: {
      inject: (_name: string, callback: () => Array<() => void> | (() => void)) => {
        if (state.inactive) throw new Error('cannot create effect on inactive context')
        return typeof callback === 'function' ? callback() : () => {}
      },
      register: (options: { name: string; key?: string }) => {
        const id = slotId(options)
        if (state.failSlots.has(id)) throw new Error(`slot registration for "${id}" failed`)
        slotEvents.push(`register ${id}`)
        return () => { slotEvents.push(`release ${id}`) }
      },
    },
  }
  return { registry, slotEvents, state, ctx }
}

/** A store + service with two enabled descriptors, plus the record registry. */
function createPlugins() {
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Files', component: () => null, icon: () => null })
  service.registerTab({ id: 'git', title: 'Changes', component: () => null })
  return { store, service, records: createNativeTabRecords() }
}

/** Silence (and count) the failure logs the fixed code reports on purpose. */
function silenceFailures(): { restore: () => void; messages: string[] } {
  const messages: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  })
  return { restore: () => { spy.mockRestore() }, messages }
}

/**
 * The phase labels a surface reports through the client's visible diagnostic
 * channel (`reportFailure` → `fail('native ' + phase, error)`).
 */
function collectReports(): { phases: string[]; report: (phase: string) => void } {
  const phases: string[] = []
  return { phases, report: (phase: string) => { phases.push(phase) } }
}

describe('native tab registration lifecycle', () => {
  it('releases a type whose slot registration failed, and can register it again later', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const reports = collectReports()
    // The reload: the context goes inactive while notifications are still
    // arriving, so every slot registration fails after its type registered.
    host.state.inactive = true
    expect(() => registerNativeSurface({
      ctx: host.ctx as never, store, service, records, reportFailure: reports.report,
    })).not.toThrow()
    expect([...host.registry.registered.keys()], 'a failed registration leaves no type behind').toEqual([])
    // Each of them is reported through the visible channel, not swallowed.
    expect(reports.phases.sort()).toEqual(['register editor', 'register files', 'register git'])

    // The context comes back (the reload's next activation): the same ids must
    // be registrable — no "already registered" from the orphan. The event log
    // is the discriminating assertion: a leaked type would keep the key set
    // looking correct while the retry throws into the same catch.
    host.state.inactive = false
    host.registry.events.length = 0
    store.setPrefs(store.getPrefs())
    expect(host.registry.events.sort()).toEqual([
      'register dsh-better-sidebar:editor',
      'register dsh-better-sidebar:files',
      'register dsh-better-sidebar:git',
    ])
  })

  it('never re-creates the "files" takeover on an unrelated notification', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const dispose = registerNativeSurface({ ctx: host.ctx as never, store, service, records })
    // The takeover is this module's own entry (never a descriptor), so no
    // store/service notification has any business touching it. Before the fix
    // every notification disposed and re-created it.
    host.registry.events.length = 0
    for (let round = 0; round < 3; round++) store.setPrefs(store.getPrefs())
    expect(host.registry.events, 'no notification may tear the "files" takeover down').toEqual([])
    expect(host.registry.registered.has('dsh-better-sidebar:files')).toBe(true)
    dispose()
  })

  it('keeps the other tab types when one descriptor cannot register', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const reports = collectReports()
    // The SECOND slot of ONE descriptor: its type and its body slot are
    // already installed when this one throws.
    host.state.failSlots.add('sidebar.right.pane.tab.title::dsh-better-sidebar:git')
    const log = silenceFailures()
    try {
      expect(() => registerNativeSurface({
        ctx: host.ctx as never, store, service, records, reportFailure: reports.report,
      })).not.toThrow()
      expect([...host.registry.registered.keys()].sort()).toEqual([
        'dsh-better-sidebar:editor',
        'dsh-better-sidebar:files',
      ])
      expect(reports.phases).toEqual(['register git'])
      // The body slot installed before the failure was released; the failing
      // one never registered, so there is nothing to release for it.
      expect(host.slotEvents.filter(event => event === 'release sidebar.right.pane.tab::dsh-better-sidebar:git'))
        .toHaveLength(1)
      expect(host.slotEvents.filter(event => event === 'release sidebar.right.pane.tab.title::dsh-better-sidebar:git'))
        .toEqual([])

      // The broken descriptor is retried on the next sync instead of being
      // written off — and the retry REGISTERS it (event log), rather than
      // merely ending up with a key set a leaked type produces as well.
      host.state.failSlots.clear()
      host.registry.events.length = 0
      store.setPrefs(store.getPrefs())
      expect(host.registry.events).toEqual(['register dsh-better-sidebar:git'])
    } finally {
      log.restore()
    }
  })

  it('releases every registration on teardown even when one release throws', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const log = silenceFailures()
    try {
      const dispose = registerNativeSurface({ ctx: host.ctx as never, store, service, records })
      host.registry.failRelease('dsh-better-sidebar:editor')
      expect(() => dispose()).not.toThrow()
      expect([...host.registry.registered.keys()]).toEqual(['dsh-better-sidebar:editor'])
    } finally {
      log.restore()
    }
  })
})
