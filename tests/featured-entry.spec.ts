/**
 * Featured plugins integration contract.
 *
 * Host (`featured-source.ts`): the first activated integrator provides the
 * cross-plugin `featured-plugins` service and serves the exact aggregate
 * route (same-origin GET only); a second integrator yields the route and
 * only contributes data. Remote mirrors failing degrades to `remote: null`
 * without breaking the route; the installed map is computed per request.
 *
 * Client (`featured-entry.tsx`): the window-flag contract keeps exactly one
 * tab — a later inline entry does nothing, a loaded full plugin makes the
 * entry back off, and the disposer restores the flags. The tab component
 * renders the pitch plus the install action when the page provides one.
 *
 * Dictionary parity for the new copy keys is enforced by
 * `locales.spec.ts`; nothing is duplicated here.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { Context, SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from '../src/context-types.ts'
import { FEATURED_ROUTE, FEATURED_SERVICE, FEATURED_SOURCE, integrateFeaturedPlugins, normalizeSource, type FeaturedRegistry } from '../src/featured-source.ts'
import { FeaturedSection, installFeaturedEntry, launchOf } from '../src/client/featured-entry.tsx'

const CATALOG = {
  updated: '2026-11-24',
  entries: [
    { package: 'dsh-featured', title: 'Featured plugins', version: '1.2.3', author: 'skillpie', homepage: 'https://skillpie.cn' },
  ],
}

/** Call one registered route with a fresh capturing response. */
async function callRoute(
  route: SidebarWebRoute,
  request: Partial<SidebarHttpRequest> = { headers: {}, method: 'GET' },
): Promise<{ status: number | undefined, payload: Record<string, unknown> }> {
  let statusCode: number | undefined
  let body = ''
  const res = {
    get statusCode(): number | undefined { return statusCode },
    set statusCode(value: number) { statusCode = value },
    writeHead(code: number) { statusCode = code },
    end(chunk?: string) { body = typeof chunk === 'string' ? chunk : '' },
  }
  await route.handler(request as SidebarHttpRequest, res as unknown as SidebarHttpResponse)
  return { status: statusCode, payload: JSON.parse(body) as Record<string, unknown> }
}

/** Stub the global fetch; the returned array records every URL in order. */
function stubFetch(doc: unknown, mode: 'ok' | 'status' | 'reject' = 'ok'): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string | URL) => {
    calls.push(String(url))
    if (mode === 'reject') throw new Error('network down')
    if (mode === 'status') return { ok: false, json: async () => doc }
    return { ok: true, json: async () => doc }
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('featured host integration', () => {
  /** A stub host context: services resolve from a live map, effects run inline. */
  function makeCtx(options: { registry?: FeaturedRegistry, manager?: unknown, failProvide?: boolean, failRoute?: boolean } = {}) {
    const routes: SidebarWebRoute[] = []
    const provided: string[] = []
    const warnings: string[] = []
    const services = new Map<string, unknown>()
    if (options.manager !== undefined) services.set('pluginManager', options.manager)
    const ctx: Record<string, unknown> = {
      get(key: string) {
        if (key === FEATURED_SERVICE && options.registry !== undefined) return options.registry
        return services.get(key)
      },
      provide(key: string, value: unknown) {
        if (options.failProvide) throw new Error('service already provided')
        services.set(key, value)
        provided.push(key)
      },
      effect(fn: () => unknown) {
        fn()
        return () => {}
      },
      inject(_deps: string[], cb: (child: unknown) => void) {
        cb(ctx)
      },
      logger: {
        warn: (line: string) => { warnings.push(line) },
      },
      webServer: {
        register(route: SidebarWebRoute) {
          if (options.failRoute) throw new Error('route already served')
          routes.push(route)
          return () => {}
        },
      },
    }
    return { ctx: ctx as never as Context, routes, provided, warnings }
  }

  it('provides the service once and serves the exact aggregate route', async () => {
    const calls = stubFetch(CATALOG)
    const { ctx, routes, provided } = makeCtx({
      manager: {
        listBundles: async () => [
          { name: 'dsh-featured', version: '1.2.3', installed: true },
          { name: 'dsh-other', version: '2.0.0', installed: false },
        ],
      },
    })
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
    expect(provided).toEqual([FEATURED_SERVICE])
    expect(routes).toHaveLength(1)
    expect(routes[0]!.kind).toBe('exact')
    expect(routes[0]!.path).toBe(FEATURED_ROUTE)
    const { status, payload } = await callRoute(routes[0]!)
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    const data = payload.data as Record<string, unknown>
    expect((data.entries as Array<{ package: string }>).map((entry) => entry.package)).toEqual(['dsh-featured'])
    expect(data.installed).toEqual({ 'dsh-featured': '1.2.3' })
    expect(data.sources).toEqual([{ id: 'dsh-better-sidebar', title: 'Better Sidebar', count: 0 }])
    expect(data.remote).toEqual({ fetchedAt: expect.any(String), count: 1 })
    expect(calls).toHaveLength(2)
  })

  it('rejects cross-origin requests and non-GET methods, admits same-origin', async () => {
    stubFetch(CATALOG)
    const { ctx, routes } = makeCtx()
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
    const route = routes[0]!
    const cross = await callRoute(route, { headers: { origin: 'https://evil.example', host: '127.0.0.1:50729' }, method: 'GET' })
    expect(cross.status).toBe(403)
    expect(cross.payload.error).toBe('cross-origin request rejected')
    const refused = await callRoute(route, { headers: { host: '127.0.0.1:50729' }, method: 'POST' })
    expect(refused.status).toBe(405)
    const same = await callRoute(route, { headers: { origin: 'http://127.0.0.1:50729', host: '127.0.0.1:50729' }, method: 'GET' })
    expect(same.status).toBe(200)
  })

  it('a second integrator yields the route and only contributes data', async () => {
    stubFetch(CATALOG)
    const { ctx, routes, provided } = makeCtx({ manager: { listBundles: async () => [] } })
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
    integrateFeaturedPlugins(ctx, {
      id: 'dsh-other-plugin',
      title: 'Other plugin',
      entries: [{ package: 'dsh-featured', title: 'Duplicate', source: 'dsh-other-plugin' }],
    })
    expect(routes).toHaveLength(1)
    expect(provided).toEqual([FEATURED_SERVICE])
    const { payload } = await callRoute(routes[0]!)
    const data = payload.data as Record<string, unknown>
    // The remote catalog owns `dsh-featured`; the peer's duplicate never wins.
    expect((data.entries as Array<{ package: string, title: string }>).map((entry) => entry.package + ':' + entry.title))
      .toEqual(['dsh-featured:Featured plugins'])
    expect(data.sources).toEqual([
      { id: 'dsh-better-sidebar', title: 'Better Sidebar', count: 0 },
      { id: 'dsh-other-plugin', title: 'Other plugin', count: 1 },
    ])
  })

  it('a dead remote degrades to remote: null without breaking the route', async () => {
    stubFetch(CATALOG, 'reject')
    const { ctx, routes, warnings } = makeCtx()
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
    const { status, payload } = await callRoute(routes[0]!)
    expect(status).toBe(200)
    const data = payload.data as Record<string, unknown>
    expect(data.remote).toBeNull()
    expect(data.entries).toEqual([])
    expect(warnings).toEqual([])
  })

  it('a malformed remote (bad status or shape) is skipped like a dead mirror', async () => {
    stubFetch(CATALOG, 'status')
    const { ctx, routes } = makeCtx()
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
    const { payload } = await callRoute(routes[0]!)
    expect((payload.data as Record<string, unknown>).remote).toBeNull()
  })

  it('caches the remote catalog for five minutes', async () => {
    const calls = stubFetch(CATALOG)
    const { ctx, routes } = makeCtx({ manager: { listBundles: async () => [] } })
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
    await callRoute(routes[0]!)
    await callRoute(routes[0]!)
    expect(calls).toHaveLength(2)
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(Date.now() + 6 * 60_000)
    await callRoute(routes[0]!)
    expect(calls).toHaveLength(4)
  })

  it('an occupied route is yielded with a warning, never a throw', () => {
    stubFetch(CATALOG)
    const { ctx, warnings } = makeCtx({ failRoute: true })
    expect(() => integrateFeaturedPlugins(ctx, FEATURED_SOURCE)).not.toThrow()
    expect(warnings.some((line) => line.includes('featured route stays with another provider'))).toBe(true)
  })

  it('a lost provide race degrades to a pure data contributor', () => {
    stubFetch(CATALOG)
    const { ctx, routes, provided, warnings } = makeCtx({ failProvide: true })
    expect(() => integrateFeaturedPlugins(ctx, FEATURED_SOURCE)).not.toThrow()
    expect(provided).toEqual([])
    expect(routes).toEqual([])
    expect(warnings.some((line) => line.includes('featured-plugins service stays with another provider'))).toBe(true)
  })

  it('a failing pluginManager keeps the installed map empty', async () => {
    stubFetch(CATALOG)
    const { ctx, routes } = makeCtx({ manager: { listBundles: async () => { throw new Error('manager down') } } })
    integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
    const { payload } = await callRoute(routes[0]!)
    expect((payload.data as Record<string, unknown>).installed).toEqual({})
  })

  it('normalizeSource demands an id (the integrating package name)', () => {
    expect(() => normalizeSource({ id: '', title: 'x', entries: [] })).toThrow(/id/)
    const normalized = normalizeSource({ id: 'pkg', title: '', entries: [{ package: 'a', title: 'A', source: 'x' }] })
    expect(normalized.title).toBe('pkg')
    expect(normalized.entries).toHaveLength(1)
  })
})

describe('featured client entry', () => {
  /** A stub client context capturing plugins.tab registrations. */
  function makeClientCtx() {
    const registered: Array<{ slot: string, options: Record<string, unknown> }> = []
    let pending: Record<string, unknown> | undefined
    const ctx = {
      slots: {
        inject(slot: string, factory: () => () => void) {
          pending = {}
          const off = factory()
          registered.push({ slot, options: pending })
          pending = undefined
          return () => { off?.() }
        },
        register(options: Record<string, unknown>) {
          if (pending !== undefined) Object.assign(pending, options)
          return () => {}
        },
      },
    }
    return { ctx: ctx as never as Context, registered }
  }

  it('registers one plugins.tab slot and exposes the ENTRY hook', () => {
    const flags: Record<string, unknown> = {}
    vi.stubGlobal('window', flags)
    const { ctx, registered } = makeClientCtx()
    const disposer = installFeaturedEntry(ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.slot).toBe('plugins.tab')
    expect(registered[0]!.options.id).toBe('dsh-plugins-plugin')
    expect(registered[0]!.options.order).toBe(100)
    expect(typeof registered[0]!.options.label).toBe('function')
    expect(flags.__DSH_FEATURED_APPLIED__).toBe(true)
    expect(typeof (flags.__DSH_FEATURED_ENTRY__ as { dispose: () => void }).dispose).toBe('function')
    disposer()
    expect(flags.__DSH_FEATURED_APPLIED__).toBe(false)
    expect(flags.__DSH_FEATURED_ENTRY__).toBeUndefined()
  })

  it('a later inline entry does nothing once the flag is taken', () => {
    const flags: Record<string, unknown> = { __DSH_FEATURED_APPLIED__: true }
    vi.stubGlobal('window', flags)
    const { ctx, registered } = makeClientCtx()
    const disposer = installFeaturedEntry(ctx)
    expect(registered).toEqual([])
    expect(flags.__DSH_FEATURED_APPLIED__).toBe(true)
    disposer()
    expect(flags.__DSH_FEATURED_APPLIED__).toBe(true)
  })

  it('a loaded full plugin makes the entry back off and restores the flag', () => {
    const flags: Record<string, unknown> = { __DSH_FEATURED_FULL__: true }
    vi.stubGlobal('window', flags)
    const { ctx, registered } = makeClientCtx()
    const disposer = installFeaturedEntry(ctx)
    expect(registered).toEqual([])
    expect(flags.__DSH_FEATURED_APPLIED__).toBe(true)
    disposer()
    expect(flags.__DSH_FEATURED_APPLIED__).toBe(false)
    expect(flags.__DSH_FEATURED_ENTRY__).toBeUndefined()
  })

  it('the tab renders the pitch, and the install action only when installable', () => {
    const withInstall = renderToString(createElement(FeaturedSection, { install: () => {} }))
    expect(withInstall).toContain('One tab for community-curated plugins')
    expect(withInstall).toContain('<button')
    expect(withInstall).toContain('Install the full version')
    const withoutInstall = renderToString(createElement(FeaturedSection, {}))
    expect(withoutInstall).toContain('One tab for community-curated plugins')
    expect(withoutInstall).not.toContain('<button')
  })

  it('the install launch reports a refused dialog instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => launchOf({ install: () => { throw new Error('dialog refused') } })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    const seen = vi.fn()
    launchOf({ install: seen })
    expect(seen).toHaveBeenCalledWith({ spec: 'dsh-featured', title: expect.any(String), version: '' })
    launchOf({})
    expect(seen).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
