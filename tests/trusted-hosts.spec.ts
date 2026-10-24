/** The sidebar must use native Connection admission, never a reconstructed trust list. */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { SidebarHttpRequest, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** No retired webRuntime service: rc.2 and newer both expose Connection admission. */
function mount(initialRejection: 401 | 403 | undefined = undefined) {
  let rejection = initialRejection
  const connection = { requestRejection: vi.fn((_request: SidebarHttpRequest) => rejection) }
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const effects: Array<() => void> = []
  apply({
    connection,
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { upgrades.push(route); return () => {} },
    },
    sessions: { get: () => undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  } as never)
  return {
    connection,
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
        cookie: 'native-authenticated-session',
      })
      const { res, out } = response()
      await mounted.routes.find(route => route.path === '/sidebar/api')!.handler(req, res)
      expect(out.status).toBe(200)
      expect(mounted.connection.requestRejection).toHaveBeenCalledExactlyOnceWith(req)
      expect(mounted.connection.requestRejection.mock.contexts[0]).toBe(mounted.connection)
    } finally {
      mounted.cleanup()
    }
  })

  it.each([401, 403] as const)('refuses native %s on every HTTP route and WebSocket before consuming data', async (rejection) => {
    const mounted = mount(rejection)
    try {
      expect(mounted.routes.map(route => route.path)).toEqual([
        '/sidebar/api', '/sidebar/upload', '/sidebar/write', '/sidebar/bundle',
        '/sidebar/archive', '/sidebar/file', '/sidebar/html',
      ])
      expect(mounted.upgrades.map(route => route.path)).toEqual([
        '/sidebar/ws/agent-opens', '/sidebar/ws/fs-watch', '/sidebar/ws/sidechat',
      ])
      for (const route of mounted.routes) {
        const input = request(route.path)
        const { res, out } = response()
        await route.handler(input.req, res)
        expect(out.status, route.path).toBe(403)
        expect(input.reads(), route.path).toBe(0)
        expect(mounted.connection.requestRejection).toHaveBeenLastCalledWith(input.req)
      }
      for (const route of mounted.upgrades) {
        const input = request(route.path)
        const socket = { destroy: vi.fn() }
        await route.handler(input.req, socket, new Uint8Array())
        expect(socket.destroy, route.path).toHaveBeenCalledOnce()
        expect(input.reads(), route.path).toBe(0)
        expect(mounted.connection.requestRejection).toHaveBeenLastCalledWith(input.req)
      }
      expect(mounted.connection.requestRejection).toHaveBeenCalledTimes(10)
    } finally {
      mounted.cleanup()
    }
  })

  it.each([null, false, 0, ''])('does not treat an unexpected falsy verdict (%s) as admission', async (verdict) => {
    const mounted = mount()
    try {
      mounted.connection.requestRejection.mockReturnValue(verdict as never)
      for (const route of mounted.routes) {
        const input = request(route.path)
        const { res, out } = response()
        await route.handler(input.req, res)
        expect(out.status, route.path).toBe(403)
        expect(input.reads(), route.path).toBe(0)
      }
      for (const route of mounted.upgrades) {
        const input = request(route.path)
        const socket = { destroy: vi.fn() }
        await route.handler(input.req, socket, new Uint8Array())
        expect(socket.destroy, route.path).toHaveBeenCalledOnce()
        expect(input.reads(), route.path).toBe(0)
      }
    } finally {
      mounted.cleanup()
    }
  })

  it('has no old-host fallback when native admission is missing', async () => {
    const mounted = mount()
    try {
      Reflect.deleteProperty(mounted.connection, 'requestRejection')
      const input = request('/sidebar/api/session.cwd')
      const { res, out } = response()
      await expect(mounted.routes.find(route => route.path === '/sidebar/api')!.handler(input.req, res)).rejects.toThrow(TypeError)
      expect(out.status).toBe(0)
      expect(input.reads()).toBe(0)
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
        expect(mounted.connection.requestRejection).toHaveBeenLastCalledWith(req)
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
      expect(mounted.connection.requestRejection).toHaveBeenCalledTimes(4)
    } finally {
      mounted.cleanup()
    }
  })
})
