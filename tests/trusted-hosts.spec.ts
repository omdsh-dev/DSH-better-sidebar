/**
 * Remote-access trust regression tests: the /sidebar fence must accept a
 * reverse-proxy domain or LAN IP listed in the DSH web runtime's
 * `webRuntime.trustedHosts` — the same trust list the /api gateway accepts
 * (LAN IP literals sampled at bind plus `--trusted-host` authorities).
 *
 * Regression: the fence used to read the connection row's trustedHosts
 * through the Loader (`entry.options.name === 'connection'`, which never
 * matched the row's module-specifier name), so trustedHosts stayed empty and
 * every remote /sidebar request was 403 "forbidden".
 *
 * A second group pins the one origin the fence admits without an authority
 * match: the desktop shell's `dsh-app://app` page, whose WebSocket upgrades
 * reach the Host directly and therefore carry an origin no Host authority can
 * name.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

interface FakeRes {
  status: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

function fakeRes(): FakeRes {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      if (body !== undefined) this.body = body.toString()
    },
  } as FakeRes
}

function req(
  method: string,
  url: string,
  headers: Record<string, string>,
  body = '{}',
): IncomingMessage {
  const chunks = [Buffer.from(body)]
  return {
    method,
    url,
    headers,
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** Mount apply() against a fake context with a replaceable webRuntime trust list. */
function mount(initialTrustedHosts: readonly string[] = []): {
  api: (r: IncomingMessage, s: ServerResponse) => Promise<void>
  upgrade: (path: string) => SidebarWebUpgradeRoute['handler']
  setTrustedHosts: (hosts: readonly string[]) => void
  cleanup: () => void
} {
  const runtime = { trustedHosts: [...initialTrustedHosts] }
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const effects: Array<() => void | (() => void)> = []
  const ctx = {
    webRuntime: runtime,
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
    // The session/agent event feeds: nothing emits in these tests.
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  const api = routes.find(route => route.path === '/sidebar/api')?.handler
  if (api === undefined) throw new Error('test setup: /sidebar/api route not registered')
  return {
    api: api as (r: IncomingMessage, s: ServerResponse) => Promise<void>,
    upgrade: (path) => {
      const handler = upgrades.find(route => route.path === path)?.handler
      if (handler === undefined) throw new Error(`test setup: ${path} upgrade route not registered`)
      return handler
    },
    setTrustedHosts: (hosts) => { runtime.trustedHosts = [...hosts] },
    cleanup: () => { for (const cleanup of effects) cleanup() },
  }
}

/** A remote-domain request with the browser markers a same-origin fetch sends. */
function remoteDomainRequest(): IncomingMessage {
  return req('POST', '/sidebar/api/session.cwd', {
    host: 'example.com',
    'sec-fetch-site': 'same-origin',
    origin: 'https://example.com',
  }, '{"sessionId":"test-session"}')
}

/** A LAN-IP request with the browser markers a same-origin fetch sends. */
function lanRequest(): IncomingMessage {
  return req('POST', '/sidebar/api/session.cwd', {
    host: '192.0.2.1:3080',
    'sec-fetch-site': 'same-origin',
    origin: 'http://192.0.2.1:3080',
  }, '{"sessionId":"test-session"}')
}

describe('remote-access trust (webRuntime.trustedHosts)', () => {
  it('accepts a reverse-proxy domain configured in webRuntime.trustedHosts', async () => {
    const { api, cleanup } = mount(['example.com'])
    try {
      const res = fakeRes()
      await api(remoteDomainRequest(), res as unknown as ServerResponse)
      expect(res.status).toBe(200)
    } finally {
      cleanup()
    }
  })

  it('accepts LAN IP literals from webRuntime.trustedHosts', async () => {
    const { api, cleanup } = mount(['192.0.2.1'])
    try {
      const res = fakeRes()
      await api(lanRequest(), res as unknown as ServerResponse)
      expect(res.status).toBe(200)
    } finally {
      cleanup()
    }
  })

  it('stays loopback-only when webRuntime.trustedHosts is empty', async () => {
    const { api, cleanup } = mount([])
    try {
      const remote = fakeRes()
      await api(remoteDomainRequest(), remote as unknown as ServerResponse)
      expect(remote.status).toBe(403)
      const loopback = fakeRes()
      await api(req('POST', '/sidebar/api/session.cwd', {
        host: '127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
      }, '{"sessionId":"test-session"}'), loopback as unknown as ServerResponse)
      expect(loopback.status).toBe(200)
    } finally {
      cleanup()
    }
  })

  it('accepts an Origin that names the Host hostname without its port (Edge 151 serialization)', async () => {
    // Some Chromium builds serialize the Origin of a non-default-port loopback
    // page without the port; refusing those bricks every /sidebar route.
    const { api, cleanup } = mount([])
    try {
      const res = fakeRes()
      await api(req('POST', '/sidebar/api/session.cwd', {
        host: '127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
        origin: 'http://127.0.0.1',
      }, '{"sessionId":"test-session"}'), res as unknown as ServerResponse)
      expect(res.status).toBe(200)
    } finally {
      cleanup()
    }
  })

  it('rejects an Origin whose hostname differs from the Host even on loopback', async () => {
    // hostname, not port, re-decides trust: a same-127/8 address that is not
    // the page's own hostname is still a different authority.
    const { api, cleanup } = mount([])
    try {
      const res = fakeRes()
      await api(req('POST', '/sidebar/api/session.cwd', {
        host: '127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
        origin: 'http://127.0.0.2',
      }, '{"sessionId":"test-session"}'), res as unknown as ServerResponse)
      expect(res.status).toBe(403)
    } finally {
      cleanup()
    }
  })

  it('rejects the opaque "null" origin', async () => {
    const { api, cleanup } = mount([])
    try {
      const res = fakeRes()
      await api(req('POST', '/sidebar/api/session.cwd', {
        host: '127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
        origin: 'null',
      }, '{"sessionId":"test-session"}'), res as unknown as ServerResponse)
      expect(res.status).toBe(403)
    } finally {
      cleanup()
    }
  })

  it('rejects cross-site browser markers even for a trusted host', async () => {
    const { api, cleanup } = mount(['example.com'])
    try {
      const res = fakeRes()
      // Same-origin origin: only the explicit cross-site marker can reject —
      // this pins the marker branch (a mismatched origin would also 403).
      await api(req('POST', '/sidebar/api/session.cwd', {
        host: 'example.com',
        'sec-fetch-site': 'cross-site',
        origin: 'https://example.com',
      }, '{"sessionId":"test-session"}'), res as unknown as ServerResponse)
      expect(res.status).toBe(403)
    } finally {
      cleanup()
    }
  })

  it('reads webRuntime.trustedHosts per request, not once at apply', async () => {
    const { api, setTrustedHosts, cleanup } = mount([])
    try {
      const before = fakeRes()
      await api(remoteDomainRequest(), before as unknown as ServerResponse)
      expect(before.status).toBe(403)
      // The trust list gains an authority after mount (e.g. config reload):
      // the already-mounted fence must pick it up without a plugin restart.
      setTrustedHosts(['example.com'])
      const after = fakeRes()
      await api(remoteDomainRequest(), after as unknown as ServerResponse)
      expect(after.status).toBe(200)
    } finally {
      cleanup()
    }
  })
})

/**
 * The desktop shell serves the GUI from `dsh-app://app`, and its WebSocket
 * upgrades reach the Host directly (the scheme handler does not carry
 * upgrades), so a handshake carries an origin no Host authority can name.
 * Refusing it destroys every /sidebar/ws socket — agent-opens pushes, fs-watch
 * refreshes — while the forwarded HTTP routes keep working, because the shell
 * strips the origin header before forwarding those.
 */
describe('desktop shell application origin', () => {
  /** The shell page's own origin, as its handshakes and fetches present it. */
  const SHELL_ORIGIN = 'dsh-app://app'

  it('accepts the shell page origin on a loopback Host', async () => {
    const { api, cleanup } = mount([])
    try {
      const res = fakeRes()
      await api(req('POST', '/sidebar/api/session.cwd', {
        host: '127.0.0.1:19488',
        origin: SHELL_ORIGIN,
      }, '{"sessionId":"test-session"}'), res as unknown as ServerResponse)
      expect(res.status).toBe(200)
    } finally {
      cleanup()
    }
  })

  it('never carries the shell origin past the Host fence', async () => {
    // The addition is an origin exception, not an authority: an untrusted Host
    // must still refuse even when the request wears the shell's own origin.
    const { api, cleanup } = mount([])
    try {
      const res = fakeRes()
      await api(req('POST', '/sidebar/api/session.cwd', {
        host: 'evil.example',
        origin: SHELL_ORIGIN,
      }, '{"sessionId":"test-session"}'), res as unknown as ServerResponse)
      expect(res.status).toBe(403)
    } finally {
      cleanup()
    }
  })

  it('matches the shell origin exactly, not by scheme and not by suffix', async () => {
    const { api, cleanup } = mount([])
    try {
      for (const origin of ['dsh-app://evil', 'dsh-app://app.evil.example', 'http://evil.example']) {
        const res = fakeRes()
        await api(req('POST', '/sidebar/api/session.cwd', {
          host: '127.0.0.1:19488',
          origin,
        }, '{"sessionId":"test-session"}'), res as unknown as ServerResponse)
        expect(res.status, origin).toBe(403)
      }
    } finally {
      cleanup()
    }
  })

  it('destroys a cross-site handshake before the upgrade completes', async () => {
    // The fence runs ahead of ws's own handshake handling, so its verdict on
    // the upgrade path is observable as whether the socket gets destroyed.
    const { upgrade, cleanup } = mount([])
    try {
      const socket = {
        destroyed: false,
        destroy(): void { this.destroyed = true },
      }
      await upgrade('/sidebar/ws/agent-opens')(req('GET', '/sidebar/ws/agent-opens?sessionId=test-session', {
        host: '127.0.0.1:19488',
        origin: 'http://evil.example',
        connection: 'Upgrade',
        upgrade: 'websocket',
      }), socket, new Uint8Array())
      expect(socket.destroyed).toBe(true)
    } finally {
      cleanup()
    }
  })
})
