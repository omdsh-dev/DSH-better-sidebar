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
import { createBetterSidebarService, type SidebarSurface, type TabComponentProps } from '../src/client/service.ts'
import { createSidebarStore, type SidebarTab } from '../src/client/state.ts'

const scope = { sessionId: 's1', cwd: '/work' }

describe('createNativeTabRecords', () => {
  it('mints a synthetic tab from the native record + params', () => {
    const records = createNativeTabRecords()
    const view = records.ensure({
      id: 'tab-1', kind: 'browser', title: 'Browser', params: { url: 'https://a.test', meta: { k: 1 } }, scope,
    })
    expect(view.tab).toMatchObject({ id: 'tab-1', type: 'browser', title: 'Browser', meta: { k: 1 } })
    expect(view.scope).toBe(scope)
    expect(view.expanded).toEqual([])
  })

  it('calls the descriptor factory once for a record that arrives without seed fields', () => {
    const records = createNativeTabRecords()
    const mint = vi.fn(() => ({ title: 'Side chat', meta: { autoCreate: true } }))
    const view = records.ensure({ id: 'tab-2', kind: 'sidechat', title: 'Side Chat', params: undefined, scope, mint })
    expect(mint).toHaveBeenCalledTimes(1)
    expect(view.tab).toMatchObject({ title: 'Side chat', meta: { autoCreate: true } })
    // A second render of the same record does not re-mint.
    records.ensure({ id: 'tab-2', kind: 'sidechat', title: 'Side Chat', params: undefined, scope, mint })
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('refreshes the seed fields on navigation but keeps the record identity', () => {
    const records = createNativeTabRecords()
    records.ensure({ id: 'tab-3', kind: 'editor', title: 'a.ts', params: { path: '/work/a.ts' }, scope })
    records.update('tab-3', { title: 'renamed.ts' })
    const view = records.ensure({ id: 'tab-3', kind: 'editor', title: 'b.ts', params: { path: '/work/b.ts' }, scope })
    expect(view.tab).toMatchObject({ id: 'tab-3', path: '/work/b.ts', title: 'renamed.ts' })
  })

  it('tracks expansion per record and bumps its version', () => {
    const records = createNativeTabRecords()
    records.ensure({ id: 'tab-4', kind: 'editor', title: 'Files', params: undefined, scope })
    const before = records.versionOf('tab-4')
    records.toggleExpanded('tab-4', '/work/src')
    expect(records.get('tab-4')?.expanded).toEqual(['/work/src'])
    expect(records.versionOf('tab-4')).toBeGreaterThan(before)
    records.toggleExpanded('tab-4', '/work/src')
    expect(records.get('tab-4')?.expanded).toEqual([])
  })

  it('notifies subscribers and forgets a dropped record', () => {
    const records = createNativeTabRecords()
    records.ensure({ id: 'tab-5', kind: 'terminal', title: 'Terminal', params: undefined, scope })
    const listener = vi.fn()
    const off = records.subscribe(listener)
    records.update('tab-5', { title: 'zsh' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(records.get('tab-5')?.tab.title).toBe('zsh')
    records.drop('tab-5')
    expect(records.has('tab-5')).toBe(false)
    off()
    records.ensure({ id: 'tab-6', kind: 'terminal', title: 'Terminal', params: undefined, scope })
    records.update('tab-6', { title: 'x' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  /**
   * The host mounts ONE tab body per pane, and native tab ids restart in every
   * session (`tab1`, `tab2`, …). A conversation switch therefore renders the
   * entering session's body over the SAME id while the leaving session's body
   * unmounts — so a registry keeping one record per id hands the leaving
   * session's state to the entering one, and the reader's tree expansion and
   * in-place opened file are gone on the way back.
   */
  it('keeps each session’s own state across an A → B → A round trip', () => {
    const records = createNativeTabRecords()
    const a = { sessionId: 'A', cwd: '/work' }
    const b = { sessionId: 'B', cwd: '/work' }

    // Session A: expand a directory and open a file in place.
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: a })
    records.toggleExpanded('tab1', '/work/src')
    records.update('tab1', { path: '/work/notes.md', title: 'notes.md' })

    // Switch to B: its own tab1, its own (empty) state.
    const inB = records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: b })
    expect(inB.expanded, 'B does not inherit A’s tree state').toEqual([])
    expect(inB.tab.path, 'B does not inherit A’s in-place file').toBeUndefined()
    records.toggleExpanded('tab1', '/work/other')

    // Switch BACK to A: A’s own state must be there, untouched.
    const backInA = records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: a })
    expect(backInA.expanded, 'A’s tree expansion survives the round trip').toEqual(['/work/src'])
    expect(backInA.tab.path, 'A’s in-place file survives the round trip').toBe('/work/notes.md')
    expect(backInA.tab.title, 'A’s retitled chip survives the round trip').toBe('notes.md')

    // …and B’s state was parked, not lost either.
    const backInB = records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: b })
    expect(backInB.expanded, 'B’s own state survives its own return').toEqual(['/work/other'])
    expect(backInB.tab.path, 'B still has no in-place file').toBeUndefined()
  })

  it('peeks a session’s parked record while another session owns the live slot', () => {
    const records = createNativeTabRecords()
    const a = { sessionId: 'A', cwd: '/work' }
    const b = { sessionId: 'B', cwd: '/work' }
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: { path: '/work/a.md' }, scope: a })
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: b })

    // The live slot is B's; A's record must still be readable by session.
    expect(records.get('tab1')?.scope.sessionId).toBe('B')
    expect(records.peek('A', 'tab1')?.tab.path, 'A’s parked path is still readable').toBe('/work/a.md')
    expect(records.peek('B', 'tab1')?.tab.path, 'B has no path').toBeUndefined()
    // An unknown session has nothing.
    expect(records.peek('C', 'tab1')).toBeUndefined()
  })

  it('drops only the session whose tab the host closed', () => {
    const records = createNativeTabRecords()
    const a = { sessionId: 'A', cwd: '/work' }
    const b = { sessionId: 'B', cwd: '/work' }
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: a })
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: b })

    records.drop('tab1', 'B')
    expect(records.get('tab1'), 'B’s tab was the live one and is gone').toBeUndefined()
    // A’s parked record must be untouched — closing B’s tab cannot close A’s.
    expect(records.peek('A', 'tab1'), 'A’s parked record survives B’s close').toBeDefined()
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: a })
    expect(records.get('tab1')?.scope.sessionId).toBe('A')
  })

  /**
   * A parked record is otherwise released only by switching back to its
   * session or by the host closing that tab. A session the user DELETED has
   * neither, so its archive would be retained for the life of the page —
   * bounded per session, but linear in the number of sessions ever opened.
   */
  it('retain() evicts the archives of sessions that no longer exist', () => {
    const records = createNativeTabRecords()
    const scopeOf = (sessionId: string) => ({ sessionId, cwd: '/work' })

    // Three sessions use the same native id; two end up parked.
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: scopeOf('keep') })
    records.toggleExpanded('tab1', '/work/keep')
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: scopeOf('deleted') })
    records.toggleExpanded('tab1', '/work/deleted')
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: scopeOf('live') })
    records.toggleExpanded('tab1', '/work/live')
    // Now: 'live' owns the slot, 'keep' and 'deleted' are parked.
    expect(records.peek('keep', 'tab1')).toBeDefined()

    records.retain(new Set(['keep', 'live']))

    expect(records.peek('keep', 'tab1'), 'a live session keeps its archive').toBeDefined()
    expect(records.peek('deleted', 'tab1'), 'a deleted session’s archive is dropped').toBeUndefined()
    // The live slot is never touched by eviction.
    expect(records.get('tab1')?.scope.sessionId).toBe('live')
    expect(records.get('tab1')?.expanded).toEqual(['/work/live'])

    // Coming back to a kept session still restores its state.
    const back = records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: scopeOf('keep') })
    expect(back.expanded).toEqual(['/work/keep'])
  })

  it('retain() ignores an empty list (a not-yet-loaded session list must not wipe state)', () => {
    const records = createNativeTabRecords()
    const a = { sessionId: 'A', cwd: '/work' }
    const b = { sessionId: 'B', cwd: '/work' }
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: a })
    records.toggleExpanded('tab1', '/work/a')
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: b })

    records.retain(new Set())
    expect(records.peek('A', 'tab1'), 'an empty list is not evidence that A is gone').toBeDefined()

    // A list that omits a parked session DOES evict it (real data).
    records.retain(new Set(['B']))
    expect(records.peek('A', 'tab1')).toBeUndefined()
    expect(records.get('tab1')?.scope.sessionId, 'the live slot is untouched').toBe('B')
  })

  /**
   * The wiring, not just the method: `createNativeSurface` subscribes to the
   * session list, so a deletion reported there has to reach the registry.
   * Without this the eviction could exist and never run.
   */
  it('a session-list change drives the eviction (the wiring)', () => {
    const held: Array<{ byId: Record<string, unknown>; current?: string }> = [{ byId: { A: {}, B: {} }, current: 'B' }]
    const listeners = new Set<() => void>()
    const ctx = {
      sessions: {
        list: {
          subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
          getSnapshot: () => held[held.length - 1]!,
        },
      },
      get: () => undefined,
    } as never
    const records = createNativeTabRecords()
    const scopeOf = (sessionId: string) => ({ sessionId, cwd: '/work' })
    // A is parked (B owns the live slot).
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: scopeOf('A') })
    records.toggleExpanded('tab1', '/work/a')
    records.ensure({ id: 'tab1', kind: 'editor', title: 'Files', params: undefined, scope: scopeOf('B') })

    const surface = createNativeSurface(ctx, records)
    expect(records.peek('A', 'tab1'), 'A survives while it is in the list').toBeDefined()

    // The user deletes A and the list notifies.
    held.push({ byId: { B: {} }, current: 'B' })
    for (const listener of [...listeners]) listener()

    expect(records.peek('A', 'tab1'), 'the deletion reached the registry').toBeUndefined()
    surface.dispose()
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
    service.registerTab({ id: 'terminal', title: 'Terminal', component: () => null, createTab: state => ({ tab: { id: `terminal:${state.nextTerminal}`, type: 'terminal', title: 'Terminal', meta: { n: state.nextTerminal } } }) })
    service.registerTab({ id: 'git', title: 'Changes', component: () => null })
    service.registerTab({ id: 'editor', title: 'Files', component: () => null, icon: () => null })
    return { surface, calls, service }
  }

  it('opens a page type natively, carrying the descriptor factory seed', () => {
    const { service, calls } = mount()
    service.openTab({ type: 'terminal' }, scope)
    expect(calls).toEqual([{
      op: 'openTab',
      sessionId: 's1',
      kind: 'terminal',
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
        tab: { id: `console:${state.nextTerminal}`, type: 'my-plugin:console', title: 'Console' },
        patch: { nextTerminal: state.nextTerminal + 1 },
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

    dispose()
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
 * #636, at the level the bug actually lives: the host mounts ONE tab body per
 * pane and the session-scoped seat is keyed by sessionId (upstream
 * `StrictSessionEntry` closes with `}, binding.key)`), so a conversation switch
 * renders the entering session's body and unmounts the leaving one in the SAME
 * commit. Native ids restart per session, so both bodies carry the same id.
 *
 * The regression this pins: the entering body's `ensure` ran during render and
 * ADOPTED the leaving session's record; that same commit's passive cleanup then
 * deleted it. The record was minted at version 0, so `versionOf` went 0 → 0 —
 * no snapshot change, no re-render, `ensure` never rebuilt — and every later
 * click through the registry was a silent no-op (the folder never expanded, the
 * file never opened, no request on the wire). The reported shape is exactly
 * this: switch conversations twice and the tree is dead, in BOTH directions.
 */
describe('conversation switch keeps the entered session’s explorer responsive (#636)', () => {
  const mountSwitchable = (): {
    records: ReturnType<typeof createNativeTabRecords>
    show: (sessionId: string) => void
    clickFolder: () => void
    expanded: () => string
    unmount: () => void
  } => {
    const store = createSidebarStore()
    store.setSession('session-A')
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'explorer',
      title: 'Files',
      component: (props: TabComponentProps) => createElement(
        'div',
        { 'data-body': props.tab.id },
        createElement('button', { 'data-toggle': '', onClick: () => { props.onToggleDir?.('/work/dir') } }, 'toggle'),
        createElement('span', { 'data-expanded': '' }, (props.expanded ?? []).join('|')),
      ),
    })
    const records = createNativeTabRecords()
    const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) } }
    const ctx = { sessions } as never
    // The SAME native id in both sessions — the host's per-session counter.
    const info = {
      tab: {
        id: 'tab2',
        kind: 'explorer',
        title: 'Files',
        contentId: 'sidebar://files',
        visible: true,
        navigation: { address: 'sidebar://files', params: undefined, revision: 0 },
        signal: new AbortController().signal,
      },
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const show = (sessionId: string): void => {
      root.render(createElement(
        // The session-scoped seat's key (upstream StrictSessionEntry).
        'div',
        { key: sessionId, 'data-session': sessionId },
        createElement(NativeTabBody, {
          key: 'tab2',
          sessionId,
          ctx,
          store,
          service,
          records,
          descriptorId: 'explorer',
          useTabInfo: () => info,
        }),
      ))
    }
    return {
      records,
      show,
      expanded: () => host.querySelector('[data-expanded]')?.textContent ?? '<none>',
      clickFolder: () => {
        const button = host.querySelector<HTMLButtonElement>('[data-toggle]')
        expect(button, 'the explorer body must be mounted').not.toBeNull()
        act(() => { button!.click() })
      },
      unmount: () => { act(() => { root.unmount() }); host.remove() },
    }
  }

  it('a folder click still responds after switching away and back twice', () => {
    const t = mountSwitchable()
    act(() => { t.show('session-A') })
    expect(t.records.has('tab2')).toBe(true)

    // ONE commit: B renders (same native tab id) while A unmounts. Then back.
    for (const sessionId of ['session-B', 'session-A', 'session-B', 'session-A']) {
      act(() => { t.show(sessionId) })
      expect(t.records.has('tab2'), `${sessionId}: the entered session keeps a live record`).toBe(true)
      t.clickFolder()
      expect(t.expanded(), `${sessionId}: a folder click must still respond`).toBe('/work/dir')
      t.clickFolder()
      expect(t.expanded(), `${sessionId}: and toggle back`).toBe('')
    }
    t.unmount()
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
    records.ensure({ id: 'chip-1', kind: 'stub-tab', title: 'Stub', params: undefined, scope })

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
    records.ensure({ id: 'chip-3', kind: 'ghost', title: 'Ghost', params: undefined, scope })

    const { host, unmount } = renderTitle(records, service, nativeInfo('chip-3', 'ghost', 'Ghost'), 'ghost')
    expect(host.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(host.textContent).toBe('Ghost')
    unmount()
  })
})
