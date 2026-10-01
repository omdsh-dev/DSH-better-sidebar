// @vitest-environment jsdom
/**
 * Tracy's browser tab (`tracy:browser`) on the native right Sidebar.
 *
 * Upstream 0.21.1 deleted its own browser tab; Tracy keeps this one as a page
 * kind for the site preview. These tests hold what the port had to keep:
 * the kind registers through the service, a URL seed reaches the view on the
 * FIRST open, the view follows its record's address, a reload keeps the frame
 * (and asks the preview agent first), and a Tracy site renders unsandboxed.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    SidebarApiError: actual.SidebarApiError,
    isForbiddenError: actual.isForbiddenError,
    api: {
      browserProbe: vi.fn(async () => ({ reachable: false })),
    },
    mediaUrl: () => '',
  }
})

import type { Context } from '../src/context-types.ts'
import { api, SidebarApiError } from '../src/client/api.ts'
import {
  BrowserEmbedBlocked,
  BrowserView,
  browserAddressOf,
  frameRouteUrl,
  isTracySiteUrl,
  TRACY_BROWSER_KIND,
} from '../src/client/BrowserView.tsx'
import { tracyBrowserTab } from '../src/client/builtins/tracy-browser.tsx'
import { registerSiteVisits } from '../src/client/site-visits.ts'
import { BrowserTabTitle } from '../src/client/BrowserTabTitle.tsx'
import { browserIdentityParams, rememberBrowserIdentity } from '../src/client/native/browser-identity.ts'
import { createNativeTabRecords, NativeTabTitle } from '../src/client/native/tab-adapter.tsx'
import { PREVIEW_CHANNEL, PREVIEW_VERSION } from '../src/client/preview-protocol.generated.ts'
import { createBetterSidebarService, type SidebarSurface } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

afterEach(() => { document.body.replaceChildren() })

/** A context whose `betterSidebar` records every `updateTab`. */
function fakeCtx(updates: Array<{ id: string; patch: unknown }> = []): Context {
  return {
    get: (name: string) => (name === 'betterSidebar'
      ? { updateTab: (id: string, patch: unknown) => { updates.push({ id, patch }) } }
      : undefined),
  } as unknown as Context
}

/** Props for one native-shaped browser record (the address rides `meta.url`). */
function props(url: string, meta: Record<string, unknown> = {}, ctx: Context = fakeCtx()) {
  return {
    ctx,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    tab: { id: 'native-7', type: TRACY_BROWSER_KIND, title: new URL(url).hostname, meta: { ...meta, url } },
    visible: true,
  }
}

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  return { host, root }
}

describe('tracy:browser registration', () => {
  it('never combines a new explicit site key with an old saved address', () => {
    rememberBrowserIdentity('key-change', 'tab1', 'site-a', 'https://a.test/')
    const params = { meta: { siteKey: 'site-b' } }
    expect(browserIdentityParams('key-change', 'tab1', params)).toBe(params)
    localStorage.clear()
  })
  it('restores a resolved inactive site identity after reload even when inventory is unavailable', async () => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [
      { siteKey: 'owner-key', status: 'accepted', copyUrl: 'https://public-domain.test/', agent: '/' },
    ] }))))
    const makeTitle = (params?: { url: string }) => createElement(NativeTabTitle, {
      sessionId: 'persist-session', records: createNativeTabRecords(),
      service: createBetterSidebarService(createSidebarStore()), descriptorId: 'tracy:browser',
      useTabInfo: () => ({ tab: { id: 'inactive', kind: 'tracy:browser', title: 'Browser',
        contentId: 'sidebar://tracy:browser', visible: false, signal: new AbortController().signal,
        navigation: { address: 'sidebar://tracy:browser', revision: 0, params } } }),
    } as never)
    const first = await mount(makeTitle({ url: 'https://public-domain.test/' }))
    expect(first.host.textContent).toContain('owner-key')
    await act(async () => { first.root.unmount() })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const second = await mount(makeTitle())
    try { expect(second.host.textContent).toContain('owner-key') }
    finally { await act(async () => { second.root.unmount() }); localStorage.clear(); vi.unstubAllGlobals() }
  })
  it('resolves an old URL-only tab to the canonical site key and persists that identity', async () => {
    const rememberSite = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [
      { siteKey: 'owner-key', status: 'accepted', copyUrl: 'https://public-domain.test/', agent: '/' },
    ] }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, {
      tab: undefined, params: { url: 'https://public-domain.test/about' }, title: 'Browser', rememberSite,
    }))
    try {
      expect(host.textContent).toContain('owner-key')
      expect(host.textContent).not.toContain('public-domain.test')
      expect(rememberSite).toHaveBeenCalledWith('owner-key')
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
  })
  it('refreshes accepted sites when the dropdown reopens, including revoked access', async () => {
    let sites = [{ siteKey: 'a.test', status: 'accepted', agent: '/' }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, {
      tab: undefined, params: { meta: { siteKey: 'a.test' } }, title: 'Browser',
    }))
    try {
      await act(async () => { host.querySelector('button')!.click() })
      expect(document.querySelector('[role="menuitem"][aria-haspopup="menu"]')?.textContent).toBe('a.test')
      await act(async () => { host.querySelector('button')!.click() })
      sites = [{ siteKey: 'b.test', status: 'accepted', agent: '/' }]
      await act(async () => { host.querySelector('button')!.click() })
      expect(document.querySelector('[role="menuitem"][aria-haspopup="menu"]')?.textContent).toBe('b.test')
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
  })
  it('pins the workspace first, orders recent visits and updates from another browser tab', async () => {
    const originalUrl = window.location.href
    window.history.replaceState(null, '', '/b.test/')
    localStorage.clear()
    localStorage.setItem('tracy:site-visited:v1:a.test', '200')
    localStorage.setItem('tracy:site-visited:v1:c.test', '300')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(Date, 'now').mockReturnValue(500)
    const stopVisits = registerSiteVisits()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites:
      ['d.test', 'a.test', 'b.test', 'c.test'].map(siteKey => ({ siteKey, status: 'accepted', agent: '/' })),
    }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, {
      tab: undefined, params: { meta: { siteKey: 'b.test' } }, title: 'Browser',
    }))
    const order = () => [...document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')].map(row => row.textContent)
    try {
      await act(async () => { host.querySelector('button')!.click() })
      expect(order()).toEqual(['b.test', 'c.test', 'a.test', 'd.test'])
      expect(localStorage.getItem('tracy:site-visited:v1:b.test')).toBe('500')
      localStorage.setItem('tracy:site-visited:v1:a.test', '600')
      await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'tracy:site-visited:v1:a.test' })) })
      expect(order()).toEqual(['b.test', 'a.test', 'c.test', 'd.test'])
      vi.mocked(Date.now).mockReturnValue(700)
      await act(async () => { window.dispatchEvent(new Event('focus')) })
      expect(localStorage.getItem('tracy:site-visited:v1:b.test')).toBe('700')
    } finally {
      await act(async () => { root.unmount() })
      stopVisits()
      window.history.replaceState(null, '', originalUrl)
      localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
    }
  })
  it('records management-only workspace visits without a Browser tab and stops on disposal', () => {
    const originalUrl = window.location.href
    window.history.replaceState(null, '', '/settings-only.test/?tab=tracy:site-settings')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const stop = registerSiteVisits()
    try {
      expect(localStorage.getItem('tracy:site-visited:v1:settings-only.test')).toBe('100')
      vi.mocked(Date.now).mockReturnValue(200)
      window.dispatchEvent(new Event('focus'))
      expect(localStorage.getItem('tracy:site-visited:v1:settings-only.test')).toBe('200')
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      vi.mocked(Date.now).mockReturnValue(300)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(localStorage.getItem('tracy:site-visited:v1:settings-only.test')).toBe('200')
      stop()
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      window.dispatchEvent(new Event('focus'))
      expect(localStorage.getItem('tracy:site-visited:v1:settings-only.test')).toBe('200')
    } finally { stop(); window.history.replaceState(null, '', originalUrl); localStorage.clear(); vi.restoreAllMocks() }
  })
  it('keeps the current site first when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites:
      ['a.test', 'b.test', 'c.test'].map(siteKey => ({ siteKey, status: 'accepted', agent: '/' })),
    }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, {
      tab: undefined, params: { meta: { siteKey: 'c.test' } }, title: 'Browser',
    }))
    try {
      await act(async () => { host.querySelector('button')!.click() })
      expect([...document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')].map(row => row.textContent))
        .toEqual(['c.test', 'a.test', 'b.test'])
    } finally { await act(async () => { root.unmount() }); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  })
  it('repeats the site favicon in the tab and site menu and falls back when the image fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input === '/api/sites'
      ? new Response(JSON.stringify({ sites: [{ siteKey: 'a.test', status: 'accepted', platform: 'wordpress', copyUrl: 'https://a.test/', agent: '/' }] }))
      : new Response(JSON.stringify({ url: 'https://a.test/uploads/owner-icon.png' }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, {
      tab: undefined, params: { meta: { siteKey: 'a.test' } }, title: 'Browser',
    }))
    try {
      const icon = host.querySelector('img')!
      expect(icon?.src).toBe('https://a.test/uploads/owner-icon.png')
      await act(async () => { host.querySelector('button')!.click() })
      expect(document.querySelector('[role="menu"] img')?.getAttribute('src')).toBe(icon.src)
      await act(async () => { icon.dispatchEvent(new Event('error')) })
      expect(host.querySelector('img')).toBeNull()
      expect(host.querySelector('[data-site-icon="wordpress"]')).not.toBeNull()
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
  })
  it('lists accepted sites and opens Live Edit in the selected workspace from a parent row', async () => {
    const openOtherSite = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [
      { siteKey: 'a.test', status: 'accepted', platform: 'wordpress', copyUrl: 'https://a.test/', agent: '/' },
      { siteKey: 'b.test', status: 'accepted', platform: 'joomla', copyUrl: 'https://b.test/', agent: '/' },
      { siteKey: 'pending.test', status: 'invited', agent: '/' },
    ] }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, {
      tab: undefined, params: { meta: { siteKey: 'a.test' } }, title: 'Browser', openOtherSite,
    }))
    try {
      await act(async () => { host.querySelector('button')!.click() })
      const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"][aria-haspopup="menu"]')]
      expect(rows.map(row => row.textContent)).toEqual(['a.test', 'b.test'])
      await act(async () => { rows[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(document.body.textContent).toContain('Live Edit')
      expect(document.body.textContent).toContain('Team')
      await act(async () => { rows[1]!.click() })
      const url = new URL(openOtherSite.mock.calls[0]![0] as string, 'https://cowork.test')
      expect(url.pathname).toBe('/b.test/')
      expect(url.searchParams.get('open')).toBe('browser')
      expect(url.searchParams.get('page')).toBe('/')
      expect(url.searchParams.get('mode')).toBe('interactive')
      expect(url.searchParams.has('s')).toBe(false)
    } finally {
      await act(async () => { root.unmount() })
      vi.unstubAllGlobals()
    }
  })
  it.each([['Settings', 'tracy:site-settings'], ['History', 'tracy:history']])('opens %s in the selected site workspace', async (label, type) => {
    const openOtherSite = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [
      { siteKey: 'b.test', status: 'accepted', platform: 'wordpress', copyUrl: 'https://b.test/', agent: '/' },
    ] }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, { tab: undefined, params: undefined, title: 'Browser', openOtherSite }))
    try {
      await act(async () => { host.querySelector('button')!.click() })
      const parent = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-haspopup="menu"]')!
      await act(async () => { parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent === label)!
      expect(item.disabled).toBe(false)
      await act(async () => { item.click() })
      const url = new URL(openOtherSite.mock.calls[0]![0] as string, 'https://cowork.test')
      expect(url.pathname).toBe('/b.test/')
      expect(url.searchParams.get('tab')).toBe(type)
      expect(url.searchParams.get('site')).toBe('b.test')
      expect(url.searchParams.has('s')).toBe(false)
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
  })
  it.each([
    ['parent', true, undefined],
    ['Live Edit', true, undefined],
    ['Live Edit', false, 'tracy:browser'],
    ['Settings', false, 'tracy:site-settings'],
    ['History', false, 'tracy:history'],
    ['Team', false, 'tracy:team'],
  ] as const)('keeps same-site %s navigation inside the current browser window (active=%s)', async (label, active, kind) => {
    const before = window.location.href
    window.history.replaceState(null, '', '/a.test/s/session-a')
    const openLocal = vi.fn()
    const openOtherSite = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [
      { siteKey: 'a.test', status: 'accepted', copyUrl: 'https://a.test/', agent: '/' },
    ] }))))
    const { host, root } = await mount(createElement(BrowserTabTitle, {
      tab: undefined, params: { meta: { siteKey: 'a.test' } }, title: 'a.test', active, openLocal, openOtherSite,
    }))
    try {
      await act(async () => { host.querySelector('button')!.click() })
      const parent = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-haspopup="menu"]')!
      if (label !== 'parent') await act(async () => { parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      const item = label === 'parent' ? parent : [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent === label)!
      await act(async () => { item.click() })
      expect(openOtherSite).not.toHaveBeenCalled()
      if (kind === undefined) expect(openLocal).not.toHaveBeenCalled()
      else expect(openLocal).toHaveBeenCalledWith(kind, 'a.test')
      expect(window.location.pathname).toBe('/a.test/s/session-a')
      expect(document.querySelector('[role="menu"]')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      window.history.replaceState(null, '', before)
      vi.unstubAllGlobals()
    }
  })
  it('keeps the persisted site identity on an inactive native tab before its body mounts', async () => {
    const records = createNativeTabRecords()
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTab(tracyBrowserTab())
    const { host, root } = await mount(createElement(NativeTabTitle, {
      records, service, descriptorId: 'tracy:browser',
      useTabInfo: () => ({ tab: {
        id: 'inactive', kind: 'tracy:browser', title: 'Browser', contentId: 'sidebar://tracy:browser',
        visible: false, navigation: { address: 'sidebar://tracy:browser', revision: 0,
          params: { url: 'https://site-copy.test/', meta: { siteKey: 'owner-site.test' } } },
        signal: new AbortController().signal,
      } }),
    } as never))
    try {
      expect(host.textContent).toContain('owner-site.test')
      expect(host.textContent).not.toContain('Browser')
      expect(host.querySelector('[aria-haspopup="menu"]')).not.toBeNull()
    } finally { await act(async () => { root.unmount() }) }
  })
  it('registers as a page kind named tracy:browser, one page per pane (no createTab), off the guide', () => {
    const descriptor = tracyBrowserTab()
    expect(descriptor.id).toBe('tracy:browser')
    expect(descriptor.createTab).toBeUndefined()
    expect(descriptor.hidden).toBe(true)
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTab(descriptor)
    expect(service.getTab('tracy:browser')).toBe(descriptor)
  })

  it.each(['parent', 'Live Edit'])('reveals the existing Browser from History through %s even though its title is visible', async (label) => {
    const before = window.location.href
    window.history.replaceState(null, '', '/a.test/s/s1?tab=tracy%3Ahistory&site=a.test')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [
      { siteKey: 'a.test', status: 'accepted', copyUrl: 'https://a.test/', agent: '/' },
    ] }))))
    const records = createNativeTabRecords()
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab(tracyBrowserTab())
    const params = { meta: { siteKey: 'a.test', url: 'https://a.test/about', zoom: 125, mode: 'edit' } }
    records.ensure({ id: 'browser-1', kind: 'tracy:browser', title: 'a.test', params, scope: { sessionId: 's1' } })
    let selected = 'history-1'
    const openTab = vi.fn<SidebarSurface['openTab']>(input => {
      expect(input).toMatchObject({ sessionId: 's1', kind: 'tracy:browser', revealIfOpened: true })
      // The real surface deduplicates the page; the adapter merges the seed into its existing record.
      records.ensure({ id: 'browser-1', kind: input.kind, title: 'a.test', params: input.params, scope: { sessionId: input.sessionId } })
      selected = 'browser-1'
    })
    service.setSurface({ openTab, openResource: () => {}, fileAddress: () => '', close: () => undefined,
      update: (id, patch) => { records.update(id, patch); return true }, activate: () => false, has: id => records.has(id) })
    const { host, root } = await mount(createElement(NativeTabTitle, {
      sessionId: 's1', records, service, descriptorId: 'tracy:browser',
      activeTab: () => ({ id: selected, kind: selected === 'browser-1' ? 'tracy:browser' : 'tracy:history' }),
      useTabInfo: () => ({ tab: { id: 'browser-1', kind: 'tracy:browser', title: 'a.test',
        contentId: 'sidebar://tracy:browser', visible: true, signal: new AbortController().signal,
        navigation: { address: 'sidebar://tracy:browser', revision: 0, params } } }),
    }))
    const select = async () => {
      await act(async () => { host.querySelector('button')!.click() })
      const parent = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-haspopup="menu"]')!
      if (label !== 'parent') await act(async () => { parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      const item = label === 'parent' ? parent : [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent === label)!
      await act(async () => { item.click() })
    }
    try {
      await select()
      expect(selected).toBe('browser-1')
      expect(openTab).toHaveBeenCalledTimes(1)
      expect(records.get('browser-1')?.tab.meta).toEqual(params.meta)
      expect(document.querySelector('[role="menu"]')).toBeNull()
      await select()
      expect(openTab).toHaveBeenCalledTimes(1)
      expect(records.get('browser-1')?.tab.meta).toEqual(params.meta)
    } finally {
      await act(async () => { root.unmount() })
      window.history.replaceState(null, '', before)
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ['History', 'tracy:history', 'tracy:browser', 1],
    ['Settings', 'tracy:site-settings', 'tracy:site-settings', 0],
  ] as const)('uses the selected native tab for %s instead of a stale mirrored URL', async (label, kind, selectedKind, opens) => {
    const before = window.location.href
    window.history.replaceState(null, '', '/a.test/s/s1?tab=tracy%3Ahistory&site=a.test')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [
      { siteKey: 'a.test', status: 'accepted', agent: '/' },
    ] }))))
    const records = createNativeTabRecords()
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTab(tracyBrowserTab())
    service.registerTab({ id: kind, title: label, icon: () => null, component: () => null })
    const openTab = vi.fn<SidebarSurface['openTab']>()
    service.setSurface({ openTab, openResource: () => {}, fileAddress: () => '', close: () => undefined,
      update: () => false, activate: () => false, has: () => false })
    const { host, root } = await mount(createElement(NativeTabTitle, {
      sessionId: 's1', records, service, descriptorId: 'tracy:browser',
      activeTab: () => ({ id: 'selected', kind: selectedKind }),
      useTabInfo: () => ({ tab: { id: 'browser-1', kind: 'tracy:browser', title: 'a.test',
        contentId: 'sidebar://tracy:browser', visible: true, signal: new AbortController().signal,
        navigation: { address: 'sidebar://tracy:browser', revision: 0, params: { meta: { siteKey: 'a.test' } } } } }),
    }))
    try {
      await act(async () => { host.querySelector('button')!.click() })
      const parent = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-haspopup="menu"]')!
      await act(async () => { parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent === label)!
      await act(async () => { item.click() })
      expect(openTab).toHaveBeenCalledTimes(opens)
      if (opens > 0) expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ kind, sessionId: 's1' }))
      expect(document.querySelector('[role="menu"]')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      window.history.replaceState(null, '', before)
      vi.unstubAllGlobals()
    }
  })

  it('an open routes to the native surface as kind tracy:browser with the url as a param', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab(tracyBrowserTab())
    const opens: Array<{ kind: string; params: unknown; revealIfOpened: boolean }> = []
    const surface: SidebarSurface = {
      openTab: ({ kind, params, revealIfOpened }) => { opens.push({ kind, params, revealIfOpened }) },
      openResource: () => {},
      fileAddress: () => '',
      close: () => undefined,
      update: () => false,
      activate: () => false,
      has: () => false,
    }
    service.setSurface(surface)
    service.openTab({ type: 'tracy:browser', url: 'https://demo.tracy.test/', title: 'demo.tracy.test' })
    expect(opens).toEqual([{
      kind: 'tracy:browser',
      params: { title: 'demo.tracy.test', url: 'https://demo.tracy.test/' },
      revealIfOpened: true,
    }])
  })

  it('a first open carries its url seed into the record (meta.url), like a later navigation', () => {
    const records = createNativeTabRecords()
    const first = records.ensure({
      id: 'n1', kind: 'tracy:browser', title: 'Browser',
      params: { url: 'https://a.tracy.test/' }, scope: { sessionId: 's1' },
    })
    expect(browserAddressOf(first.tab)).toBe('https://a.tracy.test/')
    const second = records.ensure({
      id: 'n1', kind: 'tracy:browser', title: 'Browser',
      params: { url: 'https://b.tracy.test/' }, scope: { sessionId: 's1' },
    })
    expect(browserAddressOf(second.tab)).toBe('https://b.tracy.test/')
  })
})

describe('BrowserView follows its record', () => {
  it('starts with the browser controls without a redundant Live Edit heading', () => {
    const html = renderToString(createElement(BrowserView, props('https://a.test/')))
    expect(html).not.toContain('Live Edit')
    expect(html).toContain('browserBar')
  })
  it('shows the new address when the same tab is navigated to another site', async () => {
    const { host, root } = await mount(<BrowserView {...props('http://namdemo21.tracy.test:51710/')} />)
    expect(host.querySelector('input')?.value).toBe('http://namdemo21.tracy.test:51710/')
    await act(async () => { root.render(<BrowserView {...props('http://namdemo22.tracy.test:51710/')} />) })
    expect(host.querySelector('input')?.value).toBe('http://namdemo22.tracy.test:51710/')
    expect(host.querySelector('iframe')?.getAttribute('src')).toContain('namdemo22')
    await act(async () => { root.unmount() })
  })

  it('persists an address-bar navigation through updateTab (meta.url + title)', async () => {
    const updates: Array<{ id: string; patch: unknown }> = []
    const { host, root } = await mount(<BrowserView {...props('https://a.example/', {}, fakeCtx(updates))} />)
    const input = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'b.example')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(updates).toEqual([{ id: 'native-7', patch: { meta: { url: 'https://b.example/' }, title: 'b.example' } }])
    await act(async () => { root.unmount() })
  })
})

describe('a refresh keeps the frame', () => {
  const url = 'http://namdemo21.tracy.test:51710/'

  it('reloads the SAME iframe element instead of replacing it', async () => {
    const { host, root } = await mount(<BrowserView {...props(url)} />)
    const before = host.querySelector('iframe')
    expect(before).not.toBeNull()
    await act(async () => { root.render(<BrowserView {...props(url, { reloadNonce: 'reload:1:1' })} />) })
    expect(host.querySelector('iframe')).toBe(before)
    await act(async () => { root.unmount() })
  })

  it('reloads a page with no preview agent from the site, never from the browser cache', async () => {
    // Measured 28/09/2026: `frame.src = frame.src` replayed a 301 Chrome had kept for `/`, so the
    // tab stayed broken while the site answered 200. Every plain reload asks an address the cache
    // has never seen, and the tab's own address stays clean.
    const { host, root } = await mount(<BrowserView {...props(url)} />)
    const frame = host.querySelector('iframe') as HTMLIFrameElement
    const nonces: string[] = []
    for (const nonce of ['reload:1:1', 'reload:2:2']) {
      await act(async () => { root.render(<BrowserView {...props(url, { reloadNonce: nonce })} />) })
      expect(host.querySelector('iframe')).toBe(frame)
      const src = new URL(frame.src)
      nonces.push(src.searchParams.get('tracy_reload') ?? '')
      src.searchParams.delete('tracy_reload')
      expect(src.href).toBe(url)
    }
    expect(nonces[0]).not.toBe('')
    expect(nonces[1]).not.toBe(nonces[0])
    expect((host.querySelector('input') as HTMLInputElement).value).toBe(url)
    await act(async () => { root.unmount() })
  })

  it('posts a style refresh into a page that announced the preview agent, and does not touch src', async () => {
    const { host, root } = await mount(<BrowserView {...props(url)} />)
    const frame = host.querySelector('iframe') as HTMLIFrameElement
    const posted: unknown[] = []
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    })
    const srcBefore = frame.getAttribute('src')
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'ready' },
        source: frame.contentWindow as Window,
      }))
    })
    await act(async () => {
      root.render(<BrowserView {...props(url, { reloadNonce: 'reload:1:1', reloadMode: 'style' })} />)
    })
    expect(posted).toEqual([{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'refresh', mode: 'style' }])
    expect(frame.getAttribute('src')).toBe(srcBefore)
    await act(async () => { root.unmount() })
  })

  it('ignores a ready announcement from any window that is not this frame', async () => {
    const { host, root } = await mount(<BrowserView {...props(url)} />)
    const frame = host.querySelector('iframe') as HTMLIFrameElement
    const posted: unknown[] = []
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    })
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'ready' },
        source: window,
      }))
    })
    await act(async () => {
      root.render(<BrowserView {...props(url, { reloadNonce: 'reload:1:1', reloadMode: 'style' })} />)
    })
    expect(posted).toEqual([])
    await act(async () => { root.unmount() })
  })
})

describe('sandbox and embedding', () => {
  it('keeps a non-Tracy page sandboxed, with no per-tab toggle', () => {
    const html = renderToString(createElement(BrowserView, props('https://example.com/')))
    expect(/<iframe[^>]*>/.exec(html)?.[0]).toContain('sandbox=')
    expect(html).not.toContain('aria-pressed=')
  })

  it('knows a Tracy site by the deployment site domain or an alias, and nothing else', () => {
    const domains = ['tracy.test', 'localhost']
    expect(isTracySiteUrl('http://namdemo22.tracy.test:51710/', domains)).toBe(true)
    expect(isTracySiteUrl('http://tracy.test:51710/', domains)).toBe(true)
    expect(isTracySiteUrl('http://demo.localhost:8080/', domains)).toBe(true)
    expect(isTracySiteUrl('https://example.com/', domains)).toBe(false)
    expect(isTracySiteUrl('https://nottracy.test/', domains)).toBe(false)
    expect(isTracySiteUrl(undefined, domains)).toBe(false)
  })

  it('routes a framing-refused site through the host frame route, relative to the page', () => {
    expect(frameRouteUrl('https://a.example/x?y=1')).toBe('/sidebar/frame?url=https%3A%2F%2Fa.example%2Fx%3Fy%3D1')
  })

  it('explains an embed refusal with both actions', () => {
    const html = renderToString(createElement(BrowserEmbedBlocked, {
      url: 'https://arxiv.org/abs/2401.10001',
      onOpenInBrowser: () => {},
      onLoadAnyway: () => {},
    }))
    expect(html).toContain('arxiv.org')
  })
})

describe('the embeddability probe after a 403 (TCH #515)', () => {
  const probe = vi.mocked(api.browserProbe)
  beforeEach(() => { probe.mockClear() })
  afterEach(() => { probe.mockReset(); probe.mockImplementation(async () => ({ reachable: false })) })

  /** Navigate the same view through `urls`, one record update each. */
  async function navigate(urls: string[]) {
    const { host, root } = await mount(<BrowserView {...props(urls[0]!)} />)
    for (const url of urls.slice(1)) {
      await act(async () => { root.render(<BrowserView {...props(url)} />) })
    }
    return { host, root }
  }

  it('a refused probe is not asked again for the life of the tab, whatever the navigation', async () => {
    probe.mockImplementation(async () => { throw new SidebarApiError('http', 'HTTP 403', 403) })
    const { host, root } = await navigate(['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://a.example/'])
    expect(probe).toHaveBeenCalledTimes(1)
    // The page itself still shows, in the plain frame.
    expect(host.querySelector('iframe')?.getAttribute('src')).toContain('a.example')
    await act(async () => { root.unmount() })
  })

  it('a transient failure is per address: the next navigation probes again', async () => {
    probe.mockImplementation(async () => { throw new SidebarApiError('http', 'HTTP 503', 503) })
    const first = await navigate(['https://a.example/', 'https://b.example/'])
    expect(probe).toHaveBeenCalledTimes(2)
    await act(async () => { first.root.unmount() })
    probe.mockClear()
    probe.mockImplementation(async () => { throw new SidebarApiError('network', 'Failed to fetch') })
    const second = await navigate(['https://a.example/', 'https://b.example/'])
    expect(probe).toHaveBeenCalledTimes(2)
    await act(async () => { second.root.unmount() })
  })

  it('a probe that is allowed still reports a framing refusal', async () => {
    probe.mockImplementation(async () => ({ reachable: true, xFrameOptions: 'DENY' }))
    const { host, root } = await navigate(['https://a.example/'])
    await act(async () => { await Promise.resolve() })
    expect(probe).toHaveBeenCalledTimes(1)
    // The refused site is fetched through the host frame route instead.
    expect(host.querySelector('iframe')?.getAttribute('src')).toContain('/sidebar/frame?url=')
    await act(async () => { root.unmount() })
  })
})
