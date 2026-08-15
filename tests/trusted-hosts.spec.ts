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
    get: () => undefined,
  }
  apply(ctx as never)
  const api = routes.find(route => route.path === '/sidebar/api')?.handler
  if (api === undefined) throw new Error('test setup: /sidebar/api route not registered')
  return {
    api: api as (r: IncomingMessage, s: ServerResponse) => Promise<void>,
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
