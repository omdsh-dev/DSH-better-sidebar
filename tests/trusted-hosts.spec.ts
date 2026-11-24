/** The sidebar must use native Connection admission, never a reconstructed trust list.
 *
 * DSH 0.2.3 deleted `requestRejection`: `admit` is the only admission call and it
 * verifies credentials through the NESTED `connection.authentication` service,
 * which cordis only exposes to the caller that injected the dependency. The
 * plugin therefore admits from its injected child fiber and has no second path:
 * without the provider every fenced request fails loudly.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { SidebarHttpRequest, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** Mount the plugin with a 0.2.3 host: bare `admit` on the plugin context that
 *  rejects the nested read, plus the injected provider connection the plugin's
 *  child fiber declares. */
function mount(initialRejection: 401 | 403 | undefined = undefined, activateProvider = true) {
  let rejection = initialRejection
  const providerAdmit = vi.fn((_request: SidebarHttpRequest) =>
    rejection === undefined ? { peer: {} } : { rejection })
  const providerConnection = { admit: providerAdmit }
  const connection = {
    admit: () => { throw new Error('cannot get property "connection.authentication" without inject') },
  }
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const effects: Array<() => void> = []
  const injections: Array<{ deps: readonly string[]; activate: (ctx: unknown) => void }> = []
  apply({
    connection,
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { upgrades.push(route); return () => {} },
      // The approved loopback read route compares the peer socket's local port
      // with the real bound port.
      port: 3080,
    },
    sessions: { get: () => undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    inject: (deps: readonly string[], callback: (ctx: unknown) => void) => {
      injections.push({ deps, activate: callback })
      return () => {}
    },
    on: () => () => {},
    get: () => undefined,
  } as never)
  if (activateProvider) {
    for (const injection of injections) {
      if (injection.deps.includes('connection.authentication')) injection.activate({ connection: providerConnection })
    }
  }
  return {
    connection,
    providerAdmit,
    providerConnection,
    routes,
    upgrades,
    setRejection: (next: 401 | 403 | undefined) => { rejection = next },
    cleanup: () => { for (const cleanup of effects) cleanup() },
  }
}

function request(url: string, headers: SidebarHttpRequest['headers'] = { host: '127.0.0.1:3080' }) {
  let reads = 0
  const req: SidebarHttpRequest = {
    method: 'POST',
    url,
    headers,
    [Symbol.asyncIterator]: async function* () {
      reads += 1
      yield JSON.stringify({ sessionId: 'test-session' })
    },
  }
  return { req, reads: () => reads }
}

function response() {
  const out = { status: 0, body: '' }
  return {
    out,
    res: {
      writeHead: (status: number) => { out.status = status },
      end: (body?: string | Uint8Array) => { out.body += String(body ?? '') },
    } as never,
  }
}

describe('native Connection admission', () => {
  it('accepts the native verdict without webRuntime and preserves the request and method receiver', async () => {
    const mounted = mount()
    try {
      const { req } = request('/sidebar/api/session.cwd', {
        host: 'example.com',
        origin: 'https://example.com',
        cookie: 'test-cookie',
      })
      const { res, out } = response()
      await mounted.routes.find(route => route.path === '/sidebar/api')!.handler(req, res)
      expect(out.status).toBe(200)
      expect(mounted.providerAdmit).toHaveBeenCalledExactlyOnceWith(req)
      expect(mounted.providerAdmit.mock.contexts[0]).toBe(mounted.providerConnection)
    } finally {
      mounted.cleanup()
    }
  })

  it.each([401, 403] as const)('refuses native %s on every HTTP route and WebSocket before consuming data', async (rejection) => {
    const mounted = mount(rejection)
    try {
      expect(mounted.routes.map(route => route.path)).toEqual([
        // S7 share surface (four exact POST routes, fenced per request).
        '/sidebar/clues/share/export-preview', '/sidebar/clues/share/export',
        '/sidebar/clues/share/import-preview', '/sidebar/clues/share/import',
        // Two approved exact loopback POST exceptions (not a generic API bypass).
        '/sidebar/agent/clues/read', '/sidebar/agent/clues/commit',
        '/sidebar/api', '/sidebar/sidechat-image', '/sidebar/upload', '/sidebar/write', '/sidebar/bundle',
        '/sidebar/archive', '/sidebar/file', '/sidebar/html',
      ])
      expect(mounted.upgrades.map(route => route.path)).toEqual([
        '/sidebar/ws/agent-opens', '/sidebar/ws/fs-watch', '/sidebar/ws/sidechat',
      ])
      const agentPaths = ['/sidebar/agent/clues/read', '/sidebar/agent/clues/commit']
      for (const route of mounted.routes) {
        if (agentPaths.includes(route.path)) continue
        const input = request(route.path)
        const { res, out } = response()
        await route.handler(input.req, res)
        expect(out.status, route.path).toBe(403)
        expect(input.reads(), route.path).toBe(0)
        expect(mounted.providerAdmit).toHaveBeenLastCalledWith(input.req)
      }
      // Both exact routes reject a non-loopback peer before reading a body.
      for (const path of agentPaths) {
        const input = request(path)
        const { res, out } = response()
        await mounted.routes.find(route => route.path === path)!.handler(input.req, res)
        expect(out.status).toBe(403)
        expect(input.reads()).toBe(0)
        expect(mounted.providerAdmit).not.toHaveBeenCalledWith(input.req)
      }
      for (const route of mounted.upgrades) {
        const input = request(route.path)
        const socket = { destroy: vi.fn() }
        await route.handler(input.req, socket, new Uint8Array())
        expect(socket.destroy, route.path).toHaveBeenCalledOnce()
        expect(input.reads(), route.path).toBe(0)
        expect(mounted.providerAdmit).toHaveBeenLastCalledWith(input.req)
      }
      // One admission check per FENCED HTTP route and per WebSocket upgrade.
      expect(mounted.providerAdmit).toHaveBeenCalledTimes(mounted.routes.length + mounted.upgrades.length - agentPaths.length)
    } finally {
      mounted.cleanup()
    }
  })

  it('does not admit through the bare connection when the authentication provider never activates', async () => {
    const mounted = mount(undefined, false)
    try {
      const input = request('/sidebar/api/session.cwd')
      const { res, out } = response()
      await expect(mounted.routes.find(route => route.path === '/sidebar/api')!.handler(input.req, res))
        .rejects.toThrow(TypeError)
      expect(out.status).toBe(0)
      expect(input.reads()).toBe(0)
      // The bare context `admit` throws when it reads the uninjected service;
      // reaching it would surface that error instead of the fence's TypeError.
      expect(() => (mounted.connection.admit as () => unknown)()).toThrow(/without inject/)
    } finally {
      mounted.cleanup()
    }
  })

  it('admits through the injected authentication provider', async () => {
    const mounted = mount()
    try {
      const route = mounted.routes.find(candidate => candidate.path === '/sidebar/api')!
      for (const [verdict, expected] of [[undefined, 200], [401, 403], [403, 403]] as const) {
        mounted.setRejection(verdict)
        const { res, out } = response()
        await route.handler(request('/sidebar/api/session.cwd').req, res)
        expect(out.status).toBe(expected)
      }
      expect(mounted.providerAdmit).toHaveBeenCalledTimes(3)
    } finally {
      mounted.cleanup()
    }
  })

  it('does not bypass native refusals for former desktop, image, or port exceptions', async () => {
    const mounted = mount(403)
    try {
      for (const headers of [
        { host: '127.0.0.1:3080', origin: 'dsh-app://app' },
        { host: '127.0.0.1:3080', origin: 'http://127.0.0.1' },
        {
          host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', referer: 'http://127.0.0.1:3080/',
        },
      ]) {
        const { req } = request('/sidebar/file', headers)
        req.method = 'GET'
        const { res, out } = response()
        await mounted.routes.find(route => route.path === '/sidebar/file')!.handler(req, res)
        expect(out.status).toBe(403)
        expect(mounted.providerAdmit).toHaveBeenLastCalledWith(req)
        expect(req.headers).toBe(headers)
      }
    } finally {
      mounted.cleanup()
    }
  })

  it('reads native admission on every request, including authentication expiry', async () => {
    const mounted = mount()
    try {
      const route = mounted.routes.find(route => route.path === '/sidebar/api')!
      const { req } = request('/sidebar/api/session.cwd')
      for (const [rejection, expected] of [[undefined, 200], [401, 403], [403, 403], [undefined, 200]] as const) {
        mounted.setRejection(rejection)
        const { res, out } = response()
        await route.handler(req, res)
        expect(out.status).toBe(expected)
      }
      expect(mounted.providerAdmit).toHaveBeenCalledTimes(4)
    } finally {
      mounted.cleanup()
    }
  })
})
