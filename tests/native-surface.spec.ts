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
import { createNativeTabRecords, NativeTabBody } from '../src/client/native/tab-adapter.tsx'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createBetterSidebarService, type SidebarSurface } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

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
    // DSH 0.1.5-rc.1 restored the guide `description` as an optional
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

describe('browser tab open seed reaches the view', () => {
  it('maps a native open\'s `params.url` onto the tab `path` the view reads', () => {
    // Regression: an open performed with `openTab({ type: 'browser', url })`
    // (the chat link takeover, and the model-facing `sidebar_open` tool) rides
    // the native record as `navigation.params.url`, while `BrowserView` mounts
    // from `tab.path`. Without the descriptor's `paramsOf` the seed stopped at
    // `meta.url` and the tab opened with an EMPTY address bar and no iframe —
    // the tab was simply titled with the hostname and showed nothing. Verified
    // against a real profile: filling the address bar by hand loaded the page,
    // the open itself did not.
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'browser', title: 'Browser', component: () => null })
    const records = createNativeTabRecords()

    // Capture the props the slot injector hands the body, so the assertion
    // runs the SAME `paramsOf` the surface registered. The seed lives on the
    // registration's `inject` thunk (evaluated per session), not on the
    // options object itself.
    const injects = new Map<string, (sessionId: string) => Record<string, unknown>>()
    const registry = { current: undefined as undefined | { register: (definition: { id: string; kind: string; title: (address: string) => string }) => () => void } }
    let runInjected: (() => void) | undefined
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: () => unknown }) => void) => {
        runInjected = () => { callback({ get: () => registry.current }) }
        return { dispose: () => { runInjected = undefined } }
      },
      get: () => registry.current,
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: (options: { name: string; key?: string; inject?: (sessionId: string) => Record<string, unknown> }) => {
          if (options.name === 'sidebar.right.pane.tab' && options.inject !== undefined) {
            injects.set(options.key ?? options.name, options.inject)
          }
          return () => {}
        },
      },
    }
    registerNativeSurface({ ctx: ctx as never, store, service, records })
    registry.current = { register: () => () => {} }
    runInjected?.()

    // The body's injector is what computes the seed; replay it with a record
    // shaped exactly like one the native surface produces for a URL open.
    const injected = injects.get('dsh-better-sidebar:browser')?.('s1') as
      { paramsOf?: (info: unknown) => { path?: string } | undefined } | undefined
    expect(injected?.paramsOf, 'the browser descriptor must declare a paramsOf').toBeDefined()
    const info = {
      tab: {
        id: 'native-b1',
        kind: 'browser',
        title: 'example.com',
        contentId: 'sidebar://browser',
        visible: true,
        navigation: { address: 'sidebar://browser', params: { url: 'https://example.com/x' }, revision: 0 },
        signal: new AbortController().signal,
      },
    }
    expect(injected!.paramsOf!(info)).toEqual({ path: 'https://example.com/x' })
    // A record seeded before this mapping existed keeps its URL in `meta.url`;
    // it must still render rather than come back empty.
    const legacy = {
      tab: { ...info.tab, navigation: { address: 'sidebar://browser', params: { meta: { url: 'https://legacy.test/y' } }, revision: 0 } },
    }
    expect(injected!.paramsOf!(legacy)).toEqual({ path: 'https://legacy.test/y' })
    // A tab with neither seed yields nothing, so a fresh browser tab still
    // opens on its empty "enter a URL" state.
    const bare = { tab: { ...info.tab, navigation: { address: 'sidebar://browser', params: undefined, revision: 0 } } }
    expect(injected!.paramsOf!(bare)).toBeUndefined()
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
