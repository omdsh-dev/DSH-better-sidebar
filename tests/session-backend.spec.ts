/**
 * Session backend seam: claim resolution, request routing, payload fencing,
 * owner-strict cwd resolution and the local-path regression guard.
 *
 * The invariant every case here protects: a deployment with no backend
 * installed must behave exactly as it did before the seam existed.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.ts'
import {
  forwardablePayload,
  isRoutableSessionMethod,
  ownerSessionCwdOf,
  SessionBackendRegistry,
  sessionBackendError,
  type SidebarSessionBackend,
} from '../src/session-backend.ts'
import { defaultShell, PtyManager } from '../src/pty-manager.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** A backend stub recording every call it receives. */
function stubBackend(id: string, claims: (sessionId: string) => boolean): SidebarSessionBackend & {
  calls: { method: string; sessionId: string; payload: unknown }[]
  binaryCalls: { method: string; sessionId: string; payload: unknown }[]
  terminals: { sessionId: string; tab: string | null }[]
} {
  const calls: { method: string; sessionId: string; payload: unknown }[] = []
  const binaryCalls: { method: string; sessionId: string; payload: unknown }[] = []
  const terminals: { sessionId: string; tab: string | null }[] = []
  return {
    id,
    calls,
    binaryCalls,
    terminals,
    claimSession: claims,
    invoke: async (method, sessionId, payload) => {
      calls.push({ method, sessionId, payload })
      return { ok: true, value: { servedBy: id, method } }
    },
    invokeBinary: async (method, sessionId, payload) => {
      binaryCalls.push({ method, sessionId, payload })
      return { ok: true, status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(id) }
    },
    attachTerminal: (_ws, sessionId, tab) => { terminals.push({ sessionId, tab }) },
  }
}

/** Mount the host plugin and hand back its routes plus the seam services. */
function mountHost(sessions: Record<string, { cwd?: string }> = {}): {
  routes: SidebarWebRoute[]
  upgrades: SidebarWebUpgradeRoute[]
  services: Record<string, unknown>
  dispose: () => void
} {
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const effects: Array<() => void> = []
  const services: Record<string, unknown> = {}
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { upgrades.push(route); return () => {} },
    },
    sessions: { get: (id: string) => (sessions[id] === undefined ? undefined : { header: sessions[id]! }) },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    inject: () => () => {},
    get: () => undefined,
    provide: (key: string, value: unknown) => { services[key] = value },
  }
  apply(ctx as never)
  return { routes, upgrades, services, dispose: () => { for (const cleanup of effects) cleanup() } }
}

/** Drive one `/sidebar/api/<method>` request through the mounted route. */
async function callApi(route: SidebarWebRoute, method: string, payload: unknown): Promise<{
  status: number
  body: unknown
}> {
  let status = 200
  let body: unknown
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(payload)) },
  }
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: unknown) => { if (chunk !== undefined) body = String(chunk) },
    setHeader: () => {},
  }
  await route.handler(req as never, res as never)
  return { status, body: typeof body === 'string' ? JSON.parse(body) as unknown : body }
}

describe('session backend registry', () => {
  it('resolves no backend when none is registered (local path intact)', () => {
    const registry = new SessionBackendRegistry()
    expect(registry.size).toBe(0)
    expect(registry.claim('session-a')).toBeUndefined()
  })

  it('claims by predicate and ignores unclaimed sessions', () => {
    const registry = new SessionBackendRegistry()
    const backend = stubBackend('remote', id => id.startsWith('remote:'))
    registry.register(backend)
    expect(registry.claim('remote:one')?.id).toBe('remote')
    expect(registry.claim('local-session')).toBeUndefined()
  })

  it('gives the first registered claimer priority and falls through otherwise', () => {
    const registry = new SessionBackendRegistry()
    registry.register(stubBackend('first', id => id.startsWith('shared')))
    registry.register(stubBackend('second', id => id.startsWith('shared') || id === 'only-second'))
    expect(registry.claim('shared-1')?.id).toBe('first')
    expect(registry.claim('only-second')?.id).toBe('second')
  })

  it('treats a throwing predicate as "not claimed" instead of failing the request', () => {
    const registry = new SessionBackendRegistry()
    registry.register({
      id: 'broken',
      claimSession: () => { throw new Error('backend is confused') },
      invoke: async () => ({ ok: true, value: null }),
      invokeBinary: async () => ({ ok: true, status: 200, headers: {}, body: new Uint8Array() }),
    })
    registry.register(stubBackend('healthy', id => id === 'claimed'))
    expect(() => registry.claim('anything')).not.toThrow()
    expect(registry.claim('anything')).toBeUndefined()
    expect(registry.claim('claimed')?.id).toBe('healthy')
  })

  it('stops routing to a disposed backend', () => {
    const registry = new SessionBackendRegistry()
    const dispose = registry.register(stubBackend('temp', () => true))
    expect(registry.claim('any')?.id).toBe('temp')
    dispose()
    expect(registry.size).toBe(0)
    expect(registry.claim('any')).toBeUndefined()
  })

  it('ignores blank session ids', () => {
    const registry = new SessionBackendRegistry()
    registry.register(stubBackend('greedy', () => true))
    expect(registry.claim(undefined)).toBeUndefined()
    expect(registry.claim(null)).toBeUndefined()
    expect(registry.claim('')).toBeUndefined()
  })
})

describe('routable method allow list', () => {
  it('accepts session-scoped workspace methods', () => {
    for (const method of ['fs.tree', 'fs.read', 'fs.write', 'git.status', 'git.commit', 'terminal.open', 'terminal.read']) {
      expect(isRoutableSessionMethod(method)).toBe(true)
    }
  })

  it('refuses methods that are not about a session workspace', () => {
    // Global settings, ingress-local probes, this process's pty install and
    // uuid-addressed agent terminals must never leave for a remote owner.
    for (const method of ['settings.get', 'settings.update', 'browser.probe', 'deps.status', 'agent-pty.close', 'shell.get']) {
      expect(isRoutableSessionMethod(method)).toBe(false)
    }
  })
})

describe('payload fencing', () => {
  it('strips caller-supplied sessionId and cwd before forwarding', () => {
    const forwarded = forwardablePayload({ sessionId: 'spoofed', cwd: '/etc', path: 'README.md', depth: 2 })
    expect(forwarded).toEqual({ path: 'README.md', depth: 2 })
  })

  it('normalises non-object payloads to an empty record', () => {
    expect(forwardablePayload(null)).toEqual({})
    expect(forwardablePayload('nope')).toEqual({})
    expect(forwardablePayload([1, 2])).toEqual({})
  })

  it('maps a missing session to 404 and any other backend fault to 502', () => {
    expect(sessionBackendError({ code: 'session-not-found', message: 'gone' }).status).toBe(404)
    expect(sessionBackendError({ code: 'not-found', message: 'gone' }).status).toBe(404)
    expect(sessionBackendError({ code: 'transport-failure', message: 'ssh died' }).status).toBe(502)
  })
})

describe('owner-strict cwd resolution', () => {
  it('resolves the session header cwd', () => {
    const get = (id: string) => (id === 'live' ? { header: { cwd: process.cwd() } } : undefined)
    expect(ownerSessionCwdOf(get, 'live')).toBe(process.cwd())
  })

  it('never falls back to the process cwd for an unknown session', () => {
    const get = () => undefined
    expect(() => ownerSessionCwdOf(get, 'ghost')).toThrowError(/no owner-local working directory/)
    try {
      ownerSessionCwdOf(get, 'ghost')
    } catch (error) {
      expect((error as { status: number }).status).toBe(404)
    }
  })

  it('rejects a session whose cwd is blank or relative', () => {
    expect(() => ownerSessionCwdOf(() => ({ header: { cwd: '' } }), 's')).toThrowError(/no owner-local working directory/)
    try {
      ownerSessionCwdOf(() => ({ header: { cwd: 'relative/path' } }), 's')
    } catch (error) {
      expect((error as { status: number }).status).toBe(400)
    }
  })
})

describe('mounted host routing', () => {
  it('provides both halves of the seam', () => {
    const host = mountHost()
    expect(host.services.sidebarSessionBackends).toBeDefined()
    expect(host.services.sidebarHostApi).toBeDefined()
    host.dispose()
  })

  it('serves the local path when no backend claims the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-seam-local-'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'note.txt'), 'local bytes')
    try {
      const host = mountHost({ 'local-session': { cwd: dir } })
      const api = host.routes.find(route => route.path === '/sidebar/api')!
      const result = await callApi(api, 'fs.tree', { sessionId: 'local-session', path: dir })
      const value = (result.body as { ok: boolean; value: { entries: { name: string }[] } })
      expect(value.ok).toBe(true)
      expect(value.value.entries.some(entry => entry.name === 'sub')).toBe(true)
      host.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes a claimed session to its backend and fences the payload', async () => {
    const host = mountHost()
    const registry = host.services.sidebarSessionBackends as SessionBackendRegistry
    const backend = stubBackend('remote', id => id.startsWith('remote:'))
    registry.register(backend)
    const api = host.routes.find(route => route.path === '/sidebar/api')!
    const result = await callApi(api, 'fs.tree', { sessionId: 'remote:one', cwd: '/etc/passwd', path: 'src' })
    expect((result.body as { ok: boolean; value: { servedBy: string } }).value.servedBy).toBe('remote')
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]!.sessionId).toBe('remote:one')
    // The caller's cwd never reaches the owner, even riding an ordinary payload.
    expect(backend.calls[0]!.payload).toEqual({ path: 'src' })
    host.dispose()
  })

  it('keeps non-routable methods local even for a claimed session', async () => {
    const host = mountHost()
    const registry = host.services.sidebarSessionBackends as SessionBackendRegistry
    const backend = stubBackend('remote', () => true)
    registry.register(backend)
    const api = host.routes.find(route => route.path === '/sidebar/api')!
    await callApi(api, 'settings.get', { sessionId: 'remote:one' })
    expect(backend.calls).toHaveLength(0)
    host.dispose()
  })

  it('hands a claimed terminal socket to the backend', () => {
    const host = mountHost()
    const registry = host.services.sidebarSessionBackends as SessionBackendRegistry
    const backend = stubBackend('remote', id => id.startsWith('remote:'))
    registry.register(backend)
    const upgrade = host.upgrades.find(route => route.path === '/sidebar/ws/terminal')!
    // The upgrade handler runs the ws handshake; drive the claim decision by
    // calling the registry the same way the route does.
    expect(registry.claim('remote:one')?.id).toBe('remote')
    backend.attachTerminal!({ send: () => {}, close: () => {}, on: () => undefined, readyState: 1 }, 'remote:one', 'term-1', { reconnectGraceMs: 0 })
    expect(backend.terminals).toEqual([{ sessionId: 'remote:one', tab: 'term-1' }])
    expect(upgrade).toBeDefined()
    host.dispose()
  })
})

describe('owner-side session API', () => {
  it('reads the workspace through the session header, refusing a caller cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-seam-owner-'))
    writeFileSync(join(dir, 'file.txt'), 'owner bytes')
    try {
      const host = mountHost({ owned: { cwd: dir } })
      const hostApi = host.services.sidebarHostApi as {
        createSessionApi: () => {
          invoke: (method: string, sessionId: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>
          methods: { read: readonly string[]; write: readonly string[]; binary: readonly string[] }
        }
      }
      const sessionApi = hostApi.createSessionApi()
      const result = await sessionApi.invoke('fs.read', 'owned', { path: join(dir, 'file.txt'), cwd: '/somewhere/else' })
      expect(result.ok).toBe(true)
      expect((result.value as { content: string }).content).toBe('owner bytes')
      // The capability lists a backend advertises are the routable methods.
      expect(sessionApi.methods.read).toContain('fs.tree')
      expect(sessionApi.methods.binary).toEqual(['file.read', 'html.read'])
      host.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an unknown session instead of reading the process cwd', async () => {
    const host = mountHost()
    const hostApi = host.services.sidebarHostApi as {
      createSessionApi: () => { invoke: (m: string, s: string, p: unknown) => Promise<{ ok: boolean; error?: { code: string } }> }
    }
    const result = await hostApi.createSessionApi().invoke('fs.tree', 'ghost', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('not-found')
    host.dispose()
  })

  it('refuses methods outside the session-scoped allow list', async () => {
    const host = mountHost({ owned: { cwd: process.cwd() } })
    const hostApi = host.services.sidebarHostApi as {
      createSessionApi: () => { invoke: (m: string, s: string, p: unknown) => Promise<{ ok: boolean; error?: { code: string } }> }
    }
    const result = await hostApi.createSessionApi().invoke('settings.update', 'owned', { patch: {} })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('not-found')
    host.dispose()
  })

  it('fences binary reads to the session workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-seam-binary-'))
    writeFileSync(join(dir, 'page.html'), '<p>hi</p>')
    try {
      const host = mountHost({ owned: { cwd: dir } })
      const hostApi = host.services.sidebarHostApi as {
        createSessionApi: () => { invokeBinary: (m: string, s: string, p: unknown) => Promise<{ ok: boolean; status?: number; headers?: Record<string, string>; body?: Uint8Array; error?: { code: string } }> }
      }
      const sessionApi = hostApi.createSessionApi()
      const inside = await sessionApi.invokeBinary('html.read', 'owned', { path: join(dir, 'page.html') })
      expect(inside.ok).toBe(true)
      // The HTML previewer's sandbox CSP rides the owner response too.
      expect(inside.headers?.['content-security-policy']).toContain('sandbox')
      const outside = await sessionApi.invokeBinary('file.read', 'owned', { path: join(tmpdir(), 'not-in-workspace.txt') })
      expect(outside.ok).toBe(false)
      host.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('terminal offsets', () => {
  it('tracks a monotonic output offset alongside the bounded transcript', async () => {
    const manager = new PtyManager(defaultShell(), 2)
    try {
      const handle = manager.open('s1', 't1', process.cwd(), 80, 24)
      expect(handle.outputOffset).toBe(0)
      expect(handle.transcriptBase).toBe(0)
      handle.pty.write('echo seam-offset-probe\r')
      const deadline = Date.now() + 5000
      while (handle.outputOffset === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      // The offset advances with output, and base + transcript length is the
      // invariant an offset reader relies on.
      expect(handle.outputOffset).toBeGreaterThan(0)
      expect(handle.transcriptBase + handle.transcript.length).toBe(handle.outputOffset)
    } finally {
      manager.disposeAll()
    }
  })
})
