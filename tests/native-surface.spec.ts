// @vitest-environment jsdom
/**
 * Unit tests for the native-surface adapter: the per-tab record registry
 * (src/client/native/tab-adapter.tsx) and the service's routing into it
 * (src/client/service.ts `setSurface`).
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createNativeTabRecords, NativeTabBody, NativeTabTitle } from '../src/client/native/tab-adapter.tsx'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createBetterSidebarService, type SidebarSurface } from '../src/client/service.ts'
import { createSidebarStore, toggleExpanded, type SidebarTab } from '../src/client/state.ts'

const scope = { sessionId: 's1', cwd: '/work' }

describe('createNativeTabRecords', () => {
  it('mints a synthetic tab from the native record + params', () => {
    const records = createNativeTabRecords()
    const view = records.ensure({
      sessionId: 's1',
      id: 'tab-1', kind: 'browser', title: 'Browser', params: { url: 'https://a.test', meta: { k: 1 } }, scope,
    })
    expect(view.tab).toMatchObject({ id: 'tab-1', type: 'browser', title: 'Browser', meta: { k: 1 } })
    expect(view.scope).toBe(scope)
    expect(view.expanded).toEqual([])
  })

  it('calls the descriptor factory once for a record that arrives without seed fields', () => {
    const records = createNativeTabRecords()
    const mint = vi.fn(() => ({ title: 'Side chat', meta: { autoCreate: true } }))
    const view = records.ensure({ sessionId: 's1', id: 'tab-2', kind: 'sidechat', title: 'Side Chat', params: undefined, scope, mint })
    expect(mint).toHaveBeenCalledTimes(1)
    expect(view.tab).toMatchObject({ title: 'Side chat', meta: { autoCreate: true } })
    // A second render of the same record does not re-mint.
    records.ensure({ sessionId: 's1', id: 'tab-2', kind: 'sidechat', title: 'Side Chat', params: undefined, scope, mint })
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('refreshes the seed fields on navigation but keeps the record identity', () => {
    const records = createNativeTabRecords()
    records.ensure({ sessionId: 's1', id: 'tab-3', kind: 'editor', title: 'a.ts', params: { path: '/work/a.ts' }, scope })
    records.update('s1', 'tab-3', { title: 'renamed.ts' })
    const view = records.ensure({ sessionId: 's1', id: 'tab-3', kind: 'editor', title: 'b.ts', params: { path: '/work/b.ts' }, scope })
    expect(view.tab).toMatchObject({ id: 'tab-3', path: '/work/b.ts', title: 'renamed.ts' })
  })

  it('tracks expansion in the SESSION state and bumps the record version', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const records = createNativeTabRecords()
    records.attachStore(store)
    records.ensure({ sessionId: 's1', id: 'tab-4', kind: 'editor', title: 'Files', params: undefined, scope })
    const before = records.versionOf('s1', 'tab-4')
    records.toggleExpanded('s1', 'tab-4', '/work/src')
    expect(records.get('s1', 'tab-4')?.expanded).toEqual(['/work/src'])
    expect(store.getSessionStates().get('s1')?.expanded).toEqual(['/work/src'])
    expect(records.versionOf('s1', 'tab-4')).toBeGreaterThan(before)
    records.toggleExpanded('s1', 'tab-4', '/work/src')
    expect(records.get('s1', 'tab-4')?.expanded).toEqual([])
  })

  it('keeps the expansion after a tab record is DROPPED and rebuilt (the reported bug)', () => {
    // The user's flow: open a file preview (the files tab unmounts and its
    // native record is dropped), close it, return to the files page — a NEW
    // record for the SAME session must show the set the user had.
    const store = createSidebarStore()
    store.setSession('s1')
    const records = createNativeTabRecords()
    records.attachStore(store)
    records.ensure({ sessionId: 's1', id: 'files-1', kind: 'files', title: 'Files', params: undefined, scope })
    records.toggleExpanded('s1', 'files-1', '/work/src')
    records.toggleExpanded('s1', 'files-1', '/work/src/components')
    expect(records.get('s1', 'files-1')?.expanded).toEqual(['/work/src', '/work/src/components'])

    records.drop('s1', 'files-1')
    const rebuilt = records.ensure({ sessionId: 's1', id: 'files-2', kind: 'files', title: 'Files', params: undefined, scope })
    expect(rebuilt.expanded).toEqual(['/work/src', '/work/src/components'])
  })

  it('shares one expansion set between two native tabs of the same session', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const records = createNativeTabRecords()
    records.attachStore(store)
    records.ensure({ sessionId: 's1', id: 'files-a', kind: 'files', title: 'Files', params: undefined, scope })
    records.ensure({ sessionId: 's1', id: 'files-b', kind: 'files', title: 'Files', params: undefined, scope })

    records.toggleExpanded('s1', 'files-a', '/work/src')
    expect(records.get('s1', 'files-b')?.expanded).toEqual(['/work/src'])

    // The WORKBENCH's own toggle (the per-session reducer) is the same state.
    store.reduce(state => toggleExpanded(state, '/work/lib'))
    expect(records.get('s1', 'files-a')?.expanded).toEqual(['/work/src', '/work/lib'])
    expect(records.get('s1', 'files-b')?.expanded).toEqual(['/work/src', '/work/lib'])

    // …and a toggle from the native side is visible to the workbench reducer's
    // state (one authority, two surfaces).
    records.toggleExpanded('s1', 'files-b', '/work/src')
    expect(store.getSessionStates().get('s1')?.expanded).toEqual(['/work/lib'])
  })

  it('keeps two sessions apart (a native tab in each)', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const records = createNativeTabRecords()
    records.attachStore(store)
    records.ensure({ sessionId: 's1', id: 's1-files', kind: 'files', title: 'Files', params: undefined, scope })
    records.ensure({ sessionId: 's2', id: 's2-files', kind: 'files', title: 'Files', params: undefined, scope: { sessionId: 's2', cwd: '/other' } })

    // The ACTIVE session goes through `reduce`; the background one through
    // `reduceFor` — both must land in their own session only.
    records.toggleExpanded('s1', 's1-files', '/work/src')
    records.toggleExpanded('s2', 's2-files', '/other/lib')
    expect(records.get('s1', 's1-files')?.expanded).toEqual(['/work/src'])
    expect(records.get('s2', 's2-files')?.expanded).toEqual(['/other/lib'])
    expect(store.getSessionStates().get('s1')?.expanded).toEqual(['/work/src'])
    expect(store.getSessionStates().get('s2')?.expanded).toEqual(['/other/lib'])
  })

  it('reflects a store change made while no view is subscribed yet', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    store.reduce(state => toggleExpanded(state, '/work/src'))
    const records = createNativeTabRecords()
    records.attachStore(store)
    const view = records.ensure({ sessionId: 's1', id: 'late', kind: 'files', title: 'Files', params: undefined, scope })
    expect(view.expanded).toEqual(['/work/src'])
  })

  it('notifies subscribers and forgets a dropped record', () => {
    const records = createNativeTabRecords()
    records.ensure({ sessionId: 's1', id: 'tab-5', kind: 'terminal', title: 'Terminal', params: undefined, scope })
    const listener = vi.fn()
    const off = records.subscribe(listener)
    records.update('s1', 'tab-5', { title: 'zsh' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(records.get('s1', 'tab-5')?.tab.title).toBe('zsh')
    records.drop('s1', 'tab-5')
    expect(records.has('s1', 'tab-5')).toBe(false)
    off()
    records.ensure({ sessionId: 's1', id: 'tab-6', kind: 'terminal', title: 'Terminal', params: undefined, scope })
    records.update('s1', 'tab-6', { title: 'x' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('service routing into the native surface', () => {
  const mount = (): { surface: SidebarSurface; calls: unknown[]; service: ReturnType<typeof createBetterSidebarService> } => {
    const calls: unknown[] = []
    const surface: SidebarSurface = {
      openTab: input => { calls.push({ op: 'openTab', ...input }) },
      openResource: input => { calls.push({ op: 'openResource', ...input }) },
      fileAddress: (sessionId, cwd, path) => `addr://${sessionId}${cwd === undefined ? '' : cwd}${path}`,
      close: (sessionId, tabId) => ({ type: 'terminal', title: `closed ${tabId} in ${sessionId}` }),
      update: tabId => tabId === 'native-1',
      activate: tabId => tabId === 'native-1',
      has: tabId => tabId === 'native-1',
    }
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.setSurface(surface)
    service.registerTab({
      id: 'my-plugin:term',
      title: 'Terminal',
      component: () => null,
      createTab: state => ({
        // A `terminal`-shaped tab id (the plugin no longer ships that type,
        // but the service treats the descriptor id as an open string) keeps
        // this fixture's native routing identical.
        tab: { id: `terminal:${state.nextBrowser}`, type: 'terminal', title: 'Terminal', meta: { n: state.nextBrowser } },
        patch: { nextBrowser: state.nextBrowser + 1 },
      }),
    })
    service.registerTab({ id: 'git', title: 'Changes', component: () => null })
    service.registerTab({ id: 'editor', title: 'Files', component: () => null, icon: () => null })
    return { surface, calls, service }
  }

  it('opens a page type natively, carrying the descriptor factory seed', () => {
    const { service, calls } = mount()
    service.openTab({ type: 'my-plugin:term' }, scope)
    expect(calls).toEqual([{
      op: 'openTab',
      sessionId: 's1',
      kind: 'my-plugin:term',
      params: { title: 'Terminal', meta: { n: 1 } },
      revealIfOpened: false,
    }])
  })

  it('opens a file path as a resource address', () => {
    const { service, calls } = mount()
    service.openTab({ type: 'editor', path: '/work/a.ts', title: 'a.ts' }, scope)
    expect(calls).toEqual([{ op: 'openResource', sessionId: 's1', address: 'addr://s1/work/work/a.ts', revealIfOpened: true }])
  })

  it('maps a path-less editor open to the files page kind', () => {
    const { service, calls } = mount()
    service.openTab({ type: 'editor' }, scope)
    expect(calls).toEqual([{ op: 'openTab', sessionId: 's1', kind: 'files', params: {}, revealIfOpened: true }])
  })

  it('keeps a component type path seed on the page open (no resource reroute)', () => {
    // Regression #632: a path seed on a component type was rerouted into
    // openResource, so the editor (the dsh-resource://file/** claimant)
    // received the open and the registered component never mounted.
    const { service, calls } = mount()
    service.registerTab({ id: 'my-plugin:doc', title: 'Doc', component: () => null })
    service.openTab({ type: 'my-plugin:doc', path: '/work/spec.md', title: 'Spec' }, scope)
    expect(calls).toEqual([{
      op: 'openTab',
      sessionId: 's1',
      kind: 'my-plugin:doc',
      params: { title: 'Spec', path: '/work/spec.md' },
      revealIfOpened: true,
    }])
  })

  it('carries the path seed and meta on a multi-instance component open', () => {
    const { service, calls } = mount()
    service.registerTab({
      id: 'my-plugin:console',
      title: 'Console',
      createTab: (state) => ({
        tab: { id: `console:${state.nextBrowser}`, type: 'my-plugin:console', title: 'Console' },
        patch: { nextBrowser: state.nextBrowser + 1 },
      }),
      component: () => null,
    })
    service.openTab({ type: 'my-plugin:console', path: '/work/x.md', meta: { k: 1 } }, scope)
    expect(calls).toEqual([{
      op: 'openTab',
      sessionId: 's1',
      kind: 'my-plugin:console',
      params: { title: 'Console', path: '/work/x.md', meta: { k: 1 } },
      // Multi-instance kinds mint a fresh tab per open: no forced reveal.
      revealIfOpened: false,
    }])
  })

  it('reports a component path seed to onOpen on the synthetic tab', () => {
    const { service } = mount()
    const seen: Array<SidebarTab | undefined> = []
    service.registerTab({ id: 'my-plugin:doc', title: 'Doc', onOpen: (tab) => { seen.push(tab) }, component: () => null })
    service.openTab({ type: 'my-plugin:doc', path: '/work/spec.md' }, scope)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'my-plugin:doc', path: '/work/spec.md' })
  })

  it('keeps a bottom-targeted open in the plugin layout', () => {
    const { service, calls } = mount()
    service.openTab({ type: 'terminal', target: 'bottom' }, scope)
    expect(calls).toEqual([])
  })

  it('routes record operations to the native surface when the id is native', () => {
    const { service } = mount()
    expect(() => service.updateTab('native-1', { title: 'x' })).not.toThrow()
    expect(() => service.activateTab('native-1')).not.toThrow()
    expect(() => service.closeTab('native-1', scope)).not.toThrow()
    // A non-native id keeps the plugin's own layout path (a strict no-op here).
    expect(() => service.updateTab('other', { title: 'x' })).not.toThrow()
    expect(() => service.closeTab('other', scope)).not.toThrow()
  })

  it('refuses a disabled type before touching the surface', () => {
    const { service, calls } = mount()
    service.setSurface(undefined)
    const store = createSidebarStore()
    void store
    service.setSurface({
      openTab: input => { calls.push({ op: 'openTab', ...input }) },
      openResource: () => { calls.push({ op: 'openResource' }) },
      fileAddress: () => 'addr',
      close: () => undefined,
      update: () => false,
      activate: () => false,
      has: () => false,
    })
    service.openTab({ type: 'missing' }, scope)
    expect(calls).toEqual([])
  })
})

describe('registerNativeSurface lifecycle (service-driven registration)', () => {
  it('keeps the files takeover registered across a Session switch pulse', () => {
    // Regression: `sync()`'s cleanup loop compared the live registrations with
    // the DESCRIPTOR list, which never contains the `files` takeover — so every
    // store/service pulse (a Session switch is one) disposed and rebuilt it.
    // That remounts the explorer body, and a body remount loses the tree's own
    // component state (its scroll offset) even though the record survives.
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', component: () => null, icon: () => null })
    const records = createNativeTabRecords()

    const registered: string[] = []
    const disposed: string[] = []
    const registry = {
      current: {
        register: (definition: { id: string; kind: string }) => {
          registered.push(definition.kind)
          return () => { disposed.push(definition.kind) }
        },
      },
    }
    let runInjected: (() => void) | undefined
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: (name: string) => unknown }) => void) => {
        runInjected = () => { callback({ get: () => registry.current }) }
        return { dispose: () => { runInjected = undefined } }
      },
      get: () => registry.current,
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: () => () => {},
      },
    }
    const dispose = registerNativeSurface({ ctx: ctx as never, store, service, records })
    runInjected?.()
    const filesCount = (): number => registered.filter(kind => kind === 'files').length
    expect(filesCount(), 'the takeover registers once').toBe(1)

    // A Session switch is a store pulse: it must not tear the takeover down.
    store.setSession('s2')
    expect(filesCount(), 'a Session switch must not rebuild the takeover').toBe(1)
    expect(disposed, 'and nothing was disposed on the way').toEqual([])

    // Disabling the editor type DOES retire it — the lifetime it really owns.
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { editor: false } })
    expect(disposed, 'the editor switch retired the takeover (with the editor type)').toContain('files')
    expect(filesCount(), 'and it was not rebuilt while disabled').toBe(1)
    dispose()
  })

  it('registers the native tab types when the tab-type registry ARRIVES after the slot declaration', () => {
    // Regression: the native seat declares `sidebar.right.pane.tab` before it
    // provides `sidebarRightTabs`, so a registration driven by the slot
    // declaration reads the service as missing and registers nothing —
    // observed on a real DSH profile (the guide page stayed empty while the
    // same build worked in the scratch mount lane, where activation order
    // happened to differ). The registration must follow the SERVICE.
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'terminal', title: 'Terminal', component: () => null, description: () => 'Runs a shell' })
    service.registerTab({ id: 'editor', title: 'Files', component: () => null, icon: () => null, description: () => 'Browse the tree' })
    service.registerTab({ id: 'browser', title: 'Browser', component: () => null })
    const records = createNativeTabRecords()

    const registered: Array<{ id: string; kind: string; title: (address: string) => string; guide: unknown }> = []
    const slotKeys: string[] = []
    // The registry is ABSENT while the slot callback fires and appears later
    // (that ordering is the regression): a holder keeps the timing honest
    // without a reassigned binding.
    const registry: { current: { register: (definition: { id: string; kind: string; title: (address: string) => string; guide?: unknown }) => () => void } | undefined } = { current: undefined }
    let runInjected: (() => void) | undefined

    const ctx = {
      inject: (deps: readonly string[], callback: (injected: { get: (name: string) => unknown }) => void) => {
        expect(deps).toEqual(['sidebarRightTabs'])
        runInjected = () => { callback({ get: () => registry.current }) }
        return { dispose: () => { runInjected = undefined } }
      },
      get: () => registry.current,
      slots: {
        // The slot is already declared when this plugin activates: the
        // callback runs immediately, with no service in sight.
        inject: (_key: string, callback: () => () => void) => callback(),
        register: (options: { name: string; key?: string }) => {
          slotKeys.push(options.key ?? options.name)
          return () => {}
        },
      },
    }
    const dispose = registerNativeSurface({ ctx: ctx as never, store, service, records })

    // Nothing may register while the registry is absent…
    expect(registered).toHaveLength(0)
    expect(slotKeys).toHaveLength(0)

    // …and everything registers once it appears.
    registry.current = {
      register: (definition) => {
        registered.push({ id: definition.id, kind: definition.kind, title: definition.title, guide: definition.guide })
        return () => {}
      },
    }
    runInjected?.()
    expect(registered.map(entry => entry.kind).sort()).toEqual(['browser', 'editor', 'files', 'terminal'])
    expect(registered.map(entry => entry.id)).toContain('dsh-better-sidebar:files')
    expect(slotKeys).toContain('dsh-better-sidebar:terminal')
    expect(slotKeys).toContain('dsh-better-sidebar:files')

    // A resource tab is titled by the FILE it shows (the descriptor's own
    // title would make every open file look identical in the strip), while a
    // page tab keeps the descriptor's title.
    const editorType = registered.find(entry => entry.kind === 'editor')
    expect(editorType?.title('dsh-resource://file/session/s1/src/main.ts')).toBe('main.ts')
    expect(editorType?.title('dsh-resource://file/absolute/work/pkg/a/b.txt')).toBe('b.txt')
    expect(editorType?.title('sidebar://editor')).toBe('Files')
    // The new-tab/guide list must offer ONE "Files" row: the `files` kind
    // takeover draws the same explorer the editor page would, so the editor
    // type contributes no guide entry of its own.
    expect(editorType?.guide).toBeUndefined()
    const filesType = registered.find(entry => entry.kind === 'files')
    expect(filesType?.guide).toBeDefined()
    // The takeover carries the editor's glyph, so the "Files" guide row is
    // not the only one with a blank icon slot.
    const filesGuide = filesType?.guide as Array<{ icon?: unknown; title: () => string; description?: () => string }> | undefined
    expect(filesGuide?.[0]?.icon).toBeDefined()
    // DSH 0.1.5-rc.1+ restored the guide `description` as an optional
    // `() => string` (rendered only while the guide lists at most 4
    // entries). The takeover IS the editor's page, so its guide line is the
    // EDITOR descriptor's description (the takeover reuses it, exactly as it
    // reuses the glyph), evaluated fresh per call so a thunk follows the
    // active locale.
    expect(filesGuide?.[0]?.description?.()).toBe('Browse the tree')
    const terminalGuide = registered.find(entry => entry.kind === 'terminal')?.guide as
      Array<{ description?: () => string }> | undefined
    expect(terminalGuide?.[0]?.description?.()).toBe('Runs a shell')
    // A descriptor that declares NO description must reach the host with no
    // `description` field at all — the host has no fallback of its own, so
    // an empty thunk would render a blank second line instead of a clean
    // title-only capsule.
    const browserGuide = registered.find(entry => entry.kind === 'browser')?.guide as
      Array<{ title: () => string; description?: unknown }> | undefined
    expect(browserGuide?.[0]?.description).toBeUndefined()
    expect('description' in (browserGuide?.[0] ?? {})).toBe(false)
    expect(browserGuide?.[0]?.title?.()).toBe('Browser')
    // DSH 0.1.6-alpha.2 made `SidebarRightGuideEntry.id` REQUIRED and unique
    // per provider: a registration whose guide entries carry no id collides
    // on `undefined` and `SidebarRightTabRegistry.register` throws
    // `duplicate guide entry id`, which cordis swallows — leaving the whole
    // native surface silently empty (no guide row, no plugin tab types).
    const guideIds: string[] = []
    for (const entry of registered) {
      const guide = entry.guide as Array<{ id?: unknown }> | undefined
      for (const item of guide ?? []) {
        expect(typeof item.id, `guide id of ${entry.kind}`).toBe('string')
        guideIds.push(item.id as string)
      }
    }
    expect(guideIds.length).toBeGreaterThan(0)
    expect(new Set(guideIds).size).toBe(guideIds.length)

    dispose()
  })

  it('re-registers NOTHING on a store change (a folder toggle must not replace the explorer body)', () => {
    // Regression (reported as "expanding a folder makes the whole tree
    // refresh"): the surface kept its registrations in step by diffing them on
    // every service AND store notification, and the built-in `files` takeover
    // is keyed by its KIND — never by a descriptor id — so the "drop what is
    // no longer wanted" loop read it as a stray registration and disposed it on
    // EVERY state write. Disposing and re-creating a slot registration replaces
    // the host's slot entry, which unmounts the tab body it draws: toggling a
    // folder tore down the explorer (level cache, scroll position and the
    // directory watcher all live in that component) and remounted it, so the
    // tree blanked, re-requested [root, ...expanded] and rebuilt every row.
    // The store notifies on each toggle, so this churned on every click.
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: () => 'Files', component: () => null })
    service.registerTab({ id: 'git', title: () => 'Changes', component: () => null })
    const records = createNativeTabRecords()

    /** Every slot registration, in order (the unregister keys land in `disposed`). */
    const registered: string[] = []
    const disposed: string[] = []
    const registry = {
      register: (definition: { id: string; kind: string; title: (address: string) => string }) =>
        () => { disposed.push(definition.id) },
    }
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: (name: string) => unknown }) => void) => {
        callback({ get: () => registry })
        return { dispose: () => { /* the surface owns the rest */ } }
      },
      get: () => registry,
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: (options: { name: string; key?: string }) => {
          const key = options.key ?? options.name
          registered.push(key)
          return () => { disposed.push(key) }
        },
      },
    }
    const dispose = registerNativeSurface({ ctx: ctx as never, store, service, records })
    const mounted = [...registered]
    /** The takeover's slot registrations: its body + its chip title, one pair. */
    const filesSlots = (): number => registered.filter(key => key === 'dsh-better-sidebar:files').length
    expect(filesSlots(), 'the takeover registers its body + chip slots').toBe(2)
    expect(disposed).toEqual([])

    // A folder toggle: only state, no registry and no settings change. The
    // native surface must not touch a single registration.
    store.reduce(state => toggleExpanded(state, '/work/big'))
    store.reduce(state => toggleExpanded(state, '/work/big/child'))
    // Any other state write behaves the same (the workbench height, a tab
    // switch, the selection — all of them notify the same subscribers).
    store.update(state => { state.bottomOpen = !state.bottomOpen })
    expect({ registered, disposed }).toEqual({ registered: mounted, disposed: [] })

    // The takeover still follows the editor type's own switch: disabling the
    // editor releases it, re-enabling brings it back exactly once.
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { editor: false } })
    expect(disposed).toContain('dsh-better-sidebar:files')
    expect(registered).toEqual(mounted)
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { editor: true } })
    expect(filesSlots(), 'the re-enabled takeover registers again — exactly one pair').toBe(4)
    dispose()
  })

  it('claims exactly the extensions DSH has no preview for (the nine restored formats included)', () => {
    // DSH 0.1.7 handed every read-only preview to `ui-sidebar-documentpreview`,
    // and `canOpen` returning false is what gives the address away. The host's
    // renderer tables cover xlsx/xls/csv/tsv, pdf, the eight common image
    // formats, doc/docx/ppt/pptx and the flat-ODS text fallback — nine
    // extensions that were refused here as well have NO host renderer at all,
    // and refusing them swapped the plugin's binary-download pane for the
    // host's "Preview is not available for this file type yet" dead end. This
    // pins both directions so the refusal list can never drift wider than the
    // host again; the host files behind the boundary are named in
    // src/client/native/index.ts.
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', component: () => null })
    const records = createNativeTabRecords()
    let canOpen: ((address: string) => boolean) | undefined
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: () => unknown }) => void) => {
        callback({
          get: () => ({
            register: (definition: { kind: string; canOpen?: (address: string) => boolean }) => {
              if (definition.kind === 'editor') canOpen = definition.canOpen
              return () => {}
            },
          }),
        })
        return { dispose: () => {} }
      },
      get: () => undefined,
      slots: { inject: (_key: string, callback: () => () => void) => callback(), register: () => () => {} },
    }
    registerNativeSurface({ ctx: ctx as never, store, service, records })
    expect(canOpen, 'the editor type registered no canOpen').toBeTypeOf('function')
    const open = canOpen as (address: string) => boolean

    /** One session-scoped file address, the shape the chat hands the sidebar. */
    const file = (name: string) => `dsh-resource://file/session/s1/${name}`

    // Formats the host renders: DSH's own preview must own them.
    for (const name of [
      'book.xlsx', 'legacy.xls', 'data.csv', 'data.tsv', 'flat.fods',
      'paper.pdf', 'photo.png', 'photo.jpg', 'anim.gif', 'photo.webp', 'art.svg',
      'tile.bmp', 'favicon.ico', 'report.docx', 'report.doc', 'deck.pptx', 'deck.ppt',
    ]) {
      expect(open(file(name)), name).toBe(false)
    }

    // Formats the host has NO renderer for: the plugin claims them, so the
    // `code` catch-all reaches the binary-download pane instead of a dead end.
    for (const name of [
      'macro.xlsb', 'sheet.xlt', 'template.xltx', 'macro.xltm',
      'flat.ods', 'flat.ots', 'notes.dot', 'notes.dotx', 'next.avif',
    ]) {
      expect(open(file(name)), name).toBe(true)
    }

    // The three viewers the plugin keeps on purpose, and a non-file address.
    for (const name of ['README.md', 'page.html', 'main.ts']) {
      expect(open(file(name)), name).toBe(true)
    }
    expect(open('sidebar://editor')).toBe(false)
  })
})

describe('NativeTabBody full-height host wrapper', () => {
  it('renders the descriptor component inside the [data-dsh-native-tab-host] wrapper', () => {
    // DSH's native tab body host (`.paneBody`) is a BLOCK scroller with a
    // definite height, not a flex container — our tab roots (`flex: 1;
    // min-height: 0`) collapse there without a column-flex wrapper of
    // height:100%. The stable `data-dsh-native-tab-host` marker (mirroring
    // `data-dsh-better-sidebar`) lets the e2e lane assert the fill; this
    // unit check pins the structure: the marker wrapper exists and the
    // descriptor's output is INSIDE it (before the fix the component was
    // rendered bare, with no wrapper at all).
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'stub',
      title: 'Stub',
      component: () => createElement('div', { 'data-stub-body': '' }, 'stub body'),
    })
    const records = createNativeTabRecords()
    const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) } }
    const ctx = { sessions } as never
    const info = {
      tab: {
        id: 'native-9',
        kind: 'stub',
        title: 'Stub',
        contentId: 'sidebar://stub',
        visible: true,
        navigation: { address: 'sidebar://stub', params: undefined, revision: 0 },
        signal: new AbortController().signal,
      },
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    let root: Root | undefined
    act(() => {
      root = createRoot(host)
      root.render(createElement(NativeTabBody, {
        sessionId: 's1',
        ctx,
        store,
        service,
        records,
        descriptorId: 'stub',
        useTabInfo: () => info,
      }))
    })
    const wrapper = host.querySelector('[data-dsh-native-tab-host=""]')
    expect(wrapper, 'the full-height host wrapper must exist').not.toBeNull()
    expect(wrapper!.querySelector('[data-stub-body]'), 'the descriptor component renders inside the wrapper').not.toBeNull()
    expect(wrapper!.childElementCount).toBe(1)
    act(() => { root?.unmount() })
    host.remove()
  })
})

/**
 * The native tab CHIP: the host's tab definition carries no icon field, so
 * the plugin draws the glyph itself inside the `sidebar.right.pane.tab.title`
 * slot (which IS the chip's content). These cases pin the placement rule —
 * an editor tab with a path shows the FILE's glyph, every other tab shows its
 * descriptor's glyph — and the accessible-name boundary: the glyph is
 * decorative, so the chip's name stays exactly the title the e2e lane matches
 * with `getByRole('tab', { name })`.
 */
describe('NativeTabTitle (the chip glyph)', () => {
  const renderTitle = (
    records: ReturnType<typeof createNativeTabRecords>,
    service: ReturnType<typeof createBetterSidebarService>,
    info: unknown,
    descriptorId: string,
    sessionId = 's1',
  ): { host: HTMLDivElement; unmount: () => void } => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let root: Root | undefined
    act(() => {
      root = createRoot(host)
      root.render(createElement(NativeTabTitle, {
        records,
        service,
        descriptorId,
        sessionId,
        useTabInfo: () => info as never,
      }))
    })
    return {
      host,
      unmount: () => {
        act(() => { root?.unmount() })
        host.remove()
      },
    }
  }

  const nativeInfo = (id: string, kind: string, title: string) => ({
    tab: {
      id,
      kind,
      title,
      contentId: `sidebar://${id}`,
      visible: true,
      navigation: { address: `sidebar://${id}`, params: undefined, revision: 0 },
      signal: new AbortController().signal,
    },
  })

  it('draws the descriptor glyph before the live title', () => {
    const records = createNativeTabRecords()
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTab({
      id: 'stub-tab',
      title: () => 'Stub',
      icon: (size: number) => createElement('i', { 'data-stub-icon': size }),
      component: () => createElement('div'),
    })
    records.ensure({ sessionId: 's1', id: 'chip-1', kind: 'stub-tab', title: 'Stub', params: undefined, scope })

    const { host, unmount } = renderTitle(records, service, nativeInfo('chip-1', 'stub-tab', 'Stub'), 'stub-tab')
    const chip = host.querySelector('[aria-hidden="true"]')
    expect(chip, 'the chip must carry a decorative glyph').not.toBeNull()
    expect(chip!.querySelector('[data-stub-icon="14"]'), 'the descriptor icon renders at the chip scale').not.toBeNull()
    expect(host.textContent, 'the title follows the glyph').toBe('Stub')
    expect(host.querySelector('[role="tab"]'), 'the chip itself is the host’s element, not the plugin’s').toBeNull()
    unmount()
  })

  it('an editor tab with a path shows the FILE glyph instead of the type glyph', () => {
    const records = createNativeTabRecords()
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTab({
      id: 'editor',
      title: () => 'Files',
      icon: (size: number) => createElement('i', { 'data-type-icon': size }),
      component: () => createElement('div'),
    })
    records.ensure({
      sessionId: 's1',
      id: 'chip-2',
      kind: 'editor',
      title: 'notes.md',
      params: { path: '/work/notes.md' },
      scope,
    })

    const { host, unmount } = renderTitle(records, service, nativeInfo('chip-2', 'editor', 'notes.md'), 'editor')
    expect(host.querySelector('[data-type-icon]'), 'the type glyph must NOT be used for a file tab').toBeNull()
    // The file glyph is the host's own FileTypeIcon (its component identity is
    // asserted through the resolver tests); here the point is that a glyph is
    // drawn and the title is intact.
    expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(host.textContent).toBe('notes.md')
    unmount()
  })

  it('falls back to the title alone when the type is gone (unregistered descriptor)', () => {
    const records = createNativeTabRecords()
    const service = createBetterSidebarService(createSidebarStore())
    records.ensure({ sessionId: 's1', id: 'chip-3', kind: 'ghost', title: 'Ghost', params: undefined, scope })

    const { host, unmount } = renderTitle(records, service, nativeInfo('chip-3', 'ghost', 'Ghost'), 'ghost')
    expect(host.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(host.textContent).toBe('Ghost')
    unmount()
  })
})

/**
 * ONE NATIVE ID, ONE RECORD PER SESSION.
 *
 * The host's tab counter restarts in every session (`tab1`, `tab2`, …) and
 * 0.1.7 keeps visited bodies MOUNTED through hiding, tab selection and Session
 * switches (`SidebarTabDefinition.keepMounted`). Two sessions' `tab1` are
 * therefore alive at the same time, and a registry keyed by the bare id hands
 * one session's tree/edit state to the other — the chain #636/#661 reported.
 * These cases pin the per-session identity and the reclaim of dead sessions.
 */
describe('createNativeTabRecords — per-seat-session identity', () => {
  it('keeps two sessions\' same-named tab apart', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const records = createNativeTabRecords()
    // Expansion lives in the SESSION state (the one authority), so the registry
    // has to be bound to a store for a toggle to land anywhere.
    records.attachStore(store)
    const first = records.ensure({ sessionId: 's1', id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope })
    records.toggleExpanded('s1', 'tab1', '/work/src')
    const second = records.ensure({
      sessionId: 's2', id: 'tab1', kind: 'editor', title: 'Files', params: undefined,
      scope: { sessionId: 's2', cwd: '/other' },
    })
    expect(second).not.toBe(first)
    expect(records.get('s1', 'tab1')?.expanded).toEqual(['/work/src'])
    expect(records.get('s2', 'tab1')?.expanded, 'the entering session must not inherit').toEqual([])
    expect(records.get('s2', 'tab1')?.scope.sessionId).toBe('s2')
  })

  it('patches and drops exactly one session\'s record', () => {
    const records = createNativeTabRecords()
    records.ensure({ sessionId: 's1', id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope })
    records.ensure({ sessionId: 's2', id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope })
    records.update('s2', 'tab1', { title: 'renamed in B' })
    expect(records.get('s1', 'tab1')?.tab.title).toBe('Files')
    expect(records.get('s2', 'tab1')?.tab.title).toBe('renamed in B')
    records.drop('s1', 'tab1')
    expect(records.has('s1', 'tab1')).toBe(false)
    expect(records.has('s2', 'tab1')).toBe(true)
  })

  it('retain() reclaims the records of sessions that are gone', () => {
    const records = createNativeTabRecords()
    records.ensure({ sessionId: 's1', id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope })
    records.ensure({ sessionId: 's2', id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope })
    const versions = new Map<string, number>()
    records.subscribe(() => { versions.set('seen', (versions.get('seen') ?? 0) + 1) })
    records.retain(new Set(['s1']))
    expect(records.has('s2', 'tab1')).toBe(false)
    expect(records.has('s1', 'tab1'), 'a live session keeps its state').toBe(true)
    expect(versions.get('seen'), 'a reclaim notifies the mounted bodies').toBe(1)
    // An unchanged live set is not a change: no notify, no work.
    records.retain(new Set(['s1']))
    expect(versions.get('seen')).toBe(1)
  })
})

/**
 * The surface resolves a BARE tab id (the consumer contract) against a seat
 * session: the mounted one when there is one, a unique match otherwise, and
 * NOTHING when the id names a tab in several sessions — guessing would write
 * into another conversation. A session that disappears takes its records with
 * it, because a `keepMounted` body of a deleted session never unmounts.
 */
describe('createNativeSurface — session-scoped ids and reclaim', () => {
  const fixture = (sessionIds: string[], mounted?: string) => {
    const listListeners = new Set<() => void>()
    const byId: Record<string, { cwd: string }> = {}
    for (const id of sessionIds) byId[id] = { cwd: `/work/${id}` }
    const calls: unknown[] = []
    let mountedId = mounted
    const controller = {
      openTab: (kind: string, options?: unknown) => { calls.push({ op: 'openTab', kind, options }) },
      openResource: (address: string, options?: unknown) => { calls.push({ op: 'openResource', address, options }) },
      close: (tabId: string) => { calls.push({ op: 'close', tabId }) },
      closeIn: (sessionId: string, tabId: string) => { calls.push({ op: 'closeIn', sessionId, tabId }) },
      mounted: { getSnapshot: () => mountedId, subscribe: () => () => {} },
    }
    const ctx = {
      sessions: {
        list: {
          subscribe: (listener: () => void) => { listListeners.add(listener); return () => { listListeners.delete(listener) } },
          getSnapshot: () => ({ byId }),
        },
      },
      get: (name: string) => (name === 'sidebarRight' ? controller : undefined),
    } as never
    return {
      ctx,
      calls,
      setMounted: (id: string | undefined) => { mountedId = id },
      removeSession: (id: string) => { delete byId[id]; for (const listener of [...listListeners]) listener() },
    }
  }

  const seed = (records: ReturnType<typeof createNativeTabRecords>, sessionId: string, id: string) =>
    records.ensure({ sessionId, id, kind: 'editor', title: 'Files', params: undefined, scope: { sessionId, cwd: '/work' } })

  it('targets the session the caller names, never the same id in another one', () => {
    const { ctx } = fixture(['s1', 's2'], 's1')
    const records = createNativeTabRecords()
    seed(records, 's1', 'tab1')
    seed(records, 's2', 'tab1')
    const surface = createNativeSurface(ctx, records)
    expect(surface.update('tab1', { title: 'renamed in B' }, 's2')).toBe(true)
    expect(records.get('s2', 'tab1')?.tab.title).toBe('renamed in B')
    expect(records.get('s1', 'tab1')?.tab.title, 'the mounted seat is untouched').toBe('Files')
  })

  it('falls back to the mounted seat when no session is named', () => {
    const { ctx } = fixture(['s1', 's2'], 's2')
    const records = createNativeTabRecords()
    seed(records, 's1', 'tab1')
    seed(records, 's2', 'tab1')
    const surface = createNativeSurface(ctx, records)
    expect(surface.update('tab1', { title: 'on screen' })).toBe(true)
    expect(records.get('s2', 'tab1')?.tab.title).toBe('on screen')
    expect(records.get('s1', 'tab1')?.tab.title).toBe('Files')
  })

  it('refuses an ambiguous bare id instead of guessing a conversation', () => {
    const { ctx } = fixture(['s1', 's2'], undefined)
    const records = createNativeTabRecords()
    seed(records, 's1', 'tab1')
    seed(records, 's2', 'tab1')
    const surface = createNativeSurface(ctx, records)
    expect(surface.update('tab1', { title: 'nope' })).toBe(false)
    expect(surface.has('tab1')).toBe(false)
    // A unique match still resolves without a mounted seat.
    seed(records, 's2', 'tab9')
    expect(surface.has('tab9')).toBe(true)
  })

  it('closes one session\'s tab and reclaims a deleted session\'s records', () => {
    // `s3` is the mounted seat; `s2` is a background session that will be
    // deleted — the case no React unmount ever reports.
    const { ctx, calls, removeSession } = fixture(['s1', 's2', 's3'], 's3')
    const records = createNativeTabRecords()
    seed(records, 's1', 'tab1')
    seed(records, 's2', 'tab1')
    const surface = createNativeSurface(ctx, records)
    expect(surface.close('s1', 'tab1')).toEqual({ type: 'editor', title: 'Files' })
    expect(calls, 'a background session closes through the per-session face').toEqual([{ op: 'closeIn', sessionId: 's1', tabId: 'tab1' }])
    expect(records.has('s1', 'tab1')).toBe(false)
    expect(records.has('s2', 'tab1')).toBe(true)
    removeSession('s2')
    expect(records.has('s2', 'tab1'), 'a gone session leaves no record behind').toBe(false)
  })
})

/**
 * CO-RESIDENT SEATS. With `keepMounted` the host keeps every visited body
 * mounted, so two sessions draw the SAME native id at the same time and one
 * unmounting no longer means its record is dead. These cases mount both seats
 * together: neither inherits the other's exploration state, and one going away
 * does not delete the other's record (the #636 chain).
 */
describe('NativeTabBody — co-resident seats', () => {
  const mountSeat = (
    records: ReturnType<typeof createNativeTabRecords>,
    service: ReturnType<typeof createBetterSidebarService>,
    store: ReturnType<typeof createSidebarStore>,
    sessionId: string,
    id: string,
  ) => {
    store.setSession(sessionId)
    const sessions = {
      list: {
        subscribe: () => () => {},
        getSnapshot: () => ({ byId: { [sessionId]: { cwd: `/work/${sessionId}` } } }),
      },
    }
    const ctx = { sessions } as never
    const host = document.createElement('div')
    document.body.appendChild(host)
    const info = {
      tab: {
        id,
        kind: 'explorer',
        title: 'Files',
        contentId: `sidebar://${id}`,
        visible: true,
        navigation: { address: `sidebar://${id}`, params: undefined, revision: 0 },
        signal: new AbortController().signal,
      },
    }
    let root: Root | undefined
    act(() => {
      root = createRoot(host)
      root.render(createElement(NativeTabBody, {
        sessionId,
        ctx,
        store,
        service,
        records,
        descriptorId: 'explorer',
        useTabInfo: () => info,
      }))
    })
    return {
      host,
      unmount: () => { act(() => { root?.unmount() }); host.remove() },
    }
  }

  it('keeps each seat\'s exploration, and an unmount only drops its own', async () => {
    // ONE store for the whole page (as in the app): the exploration sets are
    // per SESSION inside it, which is what lets both seats stay mounted.
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const records = createNativeTabRecords()
    records.attachStore(store)
    service.registerTab({
      id: 'explorer',
      title: 'Files',
      component: props => createElement('div', { 'data-seat': props.scope.sessionId },
        createElement('span', { 'data-expanded': (props.expanded ?? []).join(',') }),
        createElement('button', { 'data-toggle': props.scope.sessionId, onClick: () => props.onToggleDir?.('/work/src') })),
    })
    // BOTH seats name `tab1` — the host's counter restarts per session.
    const first = mountSeat(records, service, store, 's1', 'tab1')
    const second = mountSeat(records, service, store, 's2', 'tab1')

    act(() => { first.host.querySelector<HTMLButtonElement>('[data-toggle="s1"]')!.click() })
    expect(first.host.querySelector('[data-expanded]')?.getAttribute('data-expanded')).toBe('/work/src')
    expect(second.host.querySelector('[data-expanded]')?.getAttribute('data-expanded'), 'the second seat must not inherit').toBe('')

    act(() => { second.host.querySelector<HTMLButtonElement>('[data-toggle="s2"]')!.click() })
    expect(first.host.querySelector('[data-expanded]')?.getAttribute('data-expanded'), 'and it must not overwrite the first').toBe('/work/src')
    expect(second.host.querySelector('[data-expanded]')?.getAttribute('data-expanded')).toBe('/work/src')

    // A Session switch remounts the body on a REAL host (measured), so an
    // unmount is NOT a close: the record has to wait for the remount that
    // brings the reader's exploration back.
    second.unmount()
    expect(records.has('s1', 'tab1'), 'the other seat keeps its record').toBe(true)
    expect(records.get('s1', 'tab1')?.expanded).toEqual(['/work/src'])
    expect(records.has('s2', 'tab1'), 'an unmount must not forget the state').toBe(true)

    const again = mountSeat(records, service, store, 's2', 'tab1')
    expect(
      again.host.querySelector('[data-expanded]')?.getAttribute('data-expanded'),
      'the remounted seat finds its own exploration again',
    ).toBe('/work/src')
    expect(
      first.host.querySelector('[data-expanded]')?.getAttribute('data-expanded'),
      'and the other seat is still untouched',
    ).toBe('/work/src')

    // Only a real close forgets a record.
    records.drop('s2', 'tab1')
    expect(records.has('s2', 'tab1')).toBe(false)
    first.unmount()
    expect(records.has('s1', 'tab1'), 'an unmount is not a close either').toBe(true)
    records.drop('s1', 'tab1')
    expect(records.has('s1', 'tab1')).toBe(false)
    again.unmount()
  })
})
