/**
 * The client adapter over DSH's open-in-app capability: which host facility
 * each gesture uses, the availability gate, and the degradation path when the
 * deployment has no desktop or no Remote namespace.
 *
 * The host's own behaviour is NOT re-tested here — only the adapter's
 * routing (Remote vs catalog route), its caching, and its fail-closed
 * answers.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenInApp, type OpenInAppEntry } from '../src/client/open-in-app.ts'

interface RemoteCalls {
  canOpen: number
  applications: { path: string }[]
  open: { path: string; action?: 'reveal'; application?: string }[]
}

/** A fake `ctx.remote.session` recording every call. */
function fakeCtx(options: {
  canOpen?: boolean
  apps?: readonly { id: string; name: string; default: boolean; icon: string | null }[]
  openResult?: boolean
  revealResult?: boolean
  noRemote?: boolean
} = {}): { ctx: { get(name: string): unknown }; calls: RemoteCalls } {
  const calls: RemoteCalls = { canOpen: 0, applications: [], open: [] }
  const session = {
    canOpenWorkspacePath: async () => {
      calls.canOpen += 1
      return { ok: true, value: options.canOpen ?? true }
    },
    workspacePathApplications: async (request: { path: string }) => {
      calls.applications.push(request)
      if (options.apps === undefined) return { ok: false }
      return { ok: true, value: options.apps }
    },
    openWorkspacePath: async (request: { path: string; action?: 'reveal'; application?: string }) => {
      calls.open.push(request)
      if (request.action === 'reveal') return { ok: options.revealResult ?? true }
      return { ok: options.openResult ?? true }
    },
  }
  return { ctx: { get: (name) => (name === 'remote' ? { session } : undefined) }, calls }
}

/** Install a fetch stub answering the host's catalog/launch routes. */
function stubFetch(options: { apps?: readonly string[]; appsStatus?: number; openStatus?: number } = {}) {
  const calls: { url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    if (String(url).includes('/open-in-app/apps')) {
      const status = options.appsStatus ?? 200
      return new Response(JSON.stringify({ apps: options.apps ?? [] }), { status })
    }
    return new Response('{}', { status: options.openStatus ?? 200 })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The adapter built over a ctx that cannot reach the Remote at all. */
function withoutRemote() {
  return createOpenInApp({ get: () => undefined })
}

describe('createOpenInApp', () => {
  it('reports unavailable and degrades every gesture when the Remote is absent', async () => {
    const adapter = withoutRemote()
    expect(adapter.available()).toBeNull()
    expect(await adapter.probe()).toBe(false)
    expect(adapter.available()).toBe(false)
    expect(await adapter.fileApps('/tmp/a.ts')).toBeNull()
    expect(await adapter.open('/tmp/a.ts')).toBe(false)
    expect(await adapter.reveal('/tmp/a.ts')).toBe(false)
  })

  it('probes availability once and shares the answer', async () => {
    const { ctx, calls } = fakeCtx({ canOpen: true })
    const adapter = createOpenInApp(ctx)
    expect(await adapter.probe()).toBe(true)
    expect(await adapter.probe()).toBe(true)
    expect(adapter.available()).toBe(true)
    expect(calls.canOpen).toBe(1)
  })

  it('maps the OS handlers of one file, default included', async () => {
    const { ctx, calls } = fakeCtx({
      apps: [{ id: '/Applications/VSCode.app', name: 'Visual Studio Code', default: true, icon: 'data:image/png;base64,AA' }],
    })
    const adapter = createOpenInApp(ctx)
    const apps = await adapter.fileApps('/tmp/a.ts')
    expect(apps).toEqual([{ id: '/Applications/VSCode.app', name: 'Visual Studio Code', icon: 'data:image/png;base64,AA', isDefault: true }])
    expect(calls.applications).toEqual([{ path: '/tmp/a.ts' }])
  })

  it('answers null for a failed handler query, never an empty list', async () => {
    const { ctx } = fakeCtx({ apps: undefined })
    expect(await createOpenInApp(ctx).fileApps('/tmp/a.ts')).toBeNull()
  })

  it('opens a path through the Remote, default or explicit application', async () => {
    const { ctx, calls } = fakeCtx()
    const adapter = createOpenInApp(ctx)
    expect(await adapter.open('/tmp/a.ts')).toBe(true)
    expect(await adapter.open('/tmp/a.ts', '/Applications/VSCode.app')).toBe(true)
    expect(calls.open).toEqual([
      { path: '/tmp/a.ts' },
      { path: '/tmp/a.ts', application: '/Applications/VSCode.app' },
    ])
  })

  it('falls back to the host catalog route when a catalog id is not a file handler', async () => {
    const fetchCalls = stubFetch()
    // The Remote refuses the catalog id (it is not registered for this path).
    const { ctx, calls } = fakeCtx({ openResult: false })
    const adapter = createOpenInApp(ctx)
    expect(await adapter.open('/tmp/ws', 'vscode')).toBe(true)
    expect(calls.open).toEqual([{ path: '/tmp/ws', application: 'vscode' }])
    expect(fetchCalls).toEqual([{ url: '/open-in-app/open', body: { app: 'vscode', path: '/tmp/ws' } }])
  })

  it('reports a launch failure instead of pretending success', async () => {
    stubFetch({ openStatus: 400 })
    const { ctx } = fakeCtx({ openResult: false })
    expect(await createOpenInApp(ctx).open('/tmp/ws', 'vscode')).toBe(false)
  })

  it('reveals through the Remote action', async () => {
    const { ctx, calls } = fakeCtx()
    expect(await createOpenInApp(ctx).reveal('/tmp/a.ts')).toBe(true)
    expect(calls.open).toEqual([{ path: '/tmp/a.ts', action: 'reveal' }])
  })

  it('lists the directory catalog from the host route, with icon URLs', async () => {
    const fetchCalls = stubFetch({ apps: ['vscode', 'finder'] })
    const { ctx } = fakeCtx()
    const apps: readonly OpenInAppEntry[] = await createOpenInApp(ctx).directoryApps()
    expect(apps.map(app => app.id)).toEqual(['vscode', 'finder'])
    expect(apps[0]?.icon).toBe('/open-in-app/icon/vscode')
    // Without the host locale namespace the label falls back to the id itself.
    expect(apps[0]?.name).toBe('Vscode')
    expect(fetchCalls[0]?.url).toBe('/open-in-app/apps')
  })

  it('answers an empty catalog when the host route fails or the desktop is gone', async () => {
    stubFetch({ appsStatus: 500 })
    const { ctx } = fakeCtx()
    expect(await createOpenInApp(ctx).directoryApps()).toEqual([])
    const offline = fakeCtx({ canOpen: false })
    expect(await createOpenInApp(offline.ctx).directoryApps()).toEqual([])
  })
})

describe('createOpenInApp (host inject guard)', () => {
  it('treats a ctx that THROWS on service access as unavailable instead of crashing the caller', async () => {
    // Cordis raises `cannot get property "remote.session" without inject`
    // when the bundle forgets the inject entry; a render path must survive it.
    const adapter = createOpenInApp({
      get: () => { throw new Error('cannot get property "remote.session" without inject') },
    })
    expect(await adapter.probe()).toBe(false)
    expect(await adapter.fileApps('/tmp/a.ts')).toBeNull()
    expect(await adapter.open('/tmp/a.ts')).toBe(false)
    expect(await adapter.reveal('/tmp/a.ts')).toBe(false)
  })
})
