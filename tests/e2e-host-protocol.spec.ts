/**
 * Unit tests for the e2e lanes' host-transport contracts (tests/e2e/
 * host-protocol.ts + host.ts), locking in the two DSH web dialects the lanes
 * must speak:
 *
 * - 0.1.1-rc.x: bare-origin launch URL, no browser auth, ApiProxy dot
 *   endpoints (`POST /api/workspace.create`, payload = the bare args).
 * - 0.1.2-alpha.1+ (Remote gateway + one-time-token browser auth):
 *   `/?token=<43 chars>` launch URL (303 → signed cookie), slash endpoints
 *   (`POST /api/workspace/create`, payload must be exactly `{ args }`, the
 *   envelope method equal to the path endpoint; a dot path is no longer
 *   claimed → 404).
 *
 * The shapes were transcribed from the deepseek-harness sources at tags
 * dsh-v0.1.1-rc.2 and dsh-v0.1.2-alpha.1 (packages/client/connection,
 * packages/api/gateway, packages/bundle/web-app).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { APIRequestContext } from '@playwright/test'
import { parseLaunchUrl, pageUrlWith, rpcAttempts } from './e2e/host-protocol'

const BARE_URL = 'http://127.0.0.1:4199'
const TOKEN_URL = 'http://127.0.0.1:4199/?token=AbCdEf0123456789_-AbCdEf0123456789_-AbCd'

// host.ts validates DSH_E2E_URL at module load; stub the env BEFORE the
// dynamic import so the glue module can load in the unit environment.
let host: typeof import('./e2e/host')

beforeAll(async () => {
  vi.stubEnv('DSH_E2E_URL', BARE_URL)
  host = await import('./e2e/host')
})

describe('host-protocol: launch URL parsing', () => {
  it('splits a bare-origin launch URL (0.1.1-rc.x hosts)', () => {
    const launch = parseLaunchUrl(BARE_URL)
    expect(launch.origin).toBe(BARE_URL)
    expect(launch.pageUrl).toBe(BARE_URL)
    expect(launch.token).toBeUndefined()
  })

  it('extracts the one-time token of an authenticated launch URL (0.1.2-alpha.1+)', () => {
    const launch = parseLaunchUrl(TOKEN_URL)
    expect(launch.origin).toBe(BARE_URL)
    expect(launch.pageUrl).toBe(TOKEN_URL)
    expect(launch.token).toBe('AbCdEf0123456789_-AbCdEf0123456789_-AbCd')
  })
})

describe('host-protocol: page URL query merge', () => {
  it('appends stamps to a bare-origin URL', () => {
    expect(pageUrlWith(BARE_URL, { 'dsh-desktop-mode': 'advanced' }))
      .toBe(`${BARE_URL}/?dsh-desktop-mode=advanced`)
  })

  it('merges stamps into a token URL without breaking the token (never append ?…?…)', () => {
    const merged = pageUrlWith(TOKEN_URL, { 'dsh-desktop-mode': 'advanced', 'dsh-desktop-platform': 'win32' })
    const parsed = new URL(merged)
    expect(parsed.searchParams.get('token')).toBe('AbCdEf0123456789_-AbCdEf0123456789_-AbCd')
    expect(parsed.searchParams.get('dsh-desktop-mode')).toBe('advanced')
    expect(parsed.searchParams.get('dsh-desktop-platform')).toBe('win32')
    expect(merged.match(/\?/g)).toHaveLength(1)
  })
})

describe('host-protocol: dual-dialect RPC attempts', () => {
  it('orders the 0.1.1-rc.x dot dialect first (published hosts never pay a probe)', () => {
    const args = { path: '/tmp/w' }
    const [dot, slash] = rpcAttempts('workspace.create', args)
    expect(dot).toEqual({
      protocol: 'dot',
      path: '/api/workspace.create',
      method: 'workspace.create',
      payload: args,
    })
    // The dot payload is the BARE args object (same reference — no wrapper).
    expect(dot!.payload).toBe(args)
    expect(slash).toEqual({
      protocol: 'slash',
      path: '/api/workspace/create',
      method: 'workspace/create',
      payload: { args: { request: args } },
    })
  })

  it('keys slash args by the parameter name — session/list is literally `_request` (verified on a live 0.1.2-alpha.1 host)', () => {
    // typert gateway: session/list declares `_request` and rejects `{}` /
    // `{request:{}}` — the wrapper table must reproduce the exact shape.
    expect(rpcAttempts('session.list', {})[1]).toEqual({
      protocol: 'slash',
      path: '/api/session/list',
      method: 'session/list',
      payload: { args: { _request: {} } },
    })
    expect(rpcAttempts('session.create', { workspaceId: 'w' })[1]).toEqual({
      protocol: 'slash',
      path: '/api/session/create',
      method: 'session/create',
      payload: { args: { request: { workspaceId: 'w' } } },
    })
  })

  it('fails loudly for methods without a verified slash args key', () => {
    expect(() => rpcAttempts('settings.describe', {})).toThrow(/no slash-dialect args key/)
  })
})

/** A scripted APIRequestContext stand-in: records request paths/bodies and
 *  replays the queued responses (the last one repeats). */
interface StubResponse { status: number; body: unknown }

function stubApi(responses: StubResponse[]): APIRequestContext & { paths: string[]; bodies: unknown[] } {
  const paths: string[] = []
  const bodies: unknown[] = []
  let cursor = 0
  const api = {
    paths,
    bodies,
    post: async (path: string, options?: { data?: unknown }): Promise<{
      ok: () => boolean
      status: () => number
      text: () => Promise<string>
    }> => {
      paths.push(path)
      bodies.push(options?.data)
      const response = responses[Math.min(cursor, responses.length - 1)]!
      cursor += 1
      const bodyText = JSON.stringify(response.body)
      return {
        ok: () => response.status >= 200 && response.status < 300,
        status: () => response.status,
        text: async () => bodyText,
      }
    },
  }
  return api as unknown as APIRequestContext & { paths: string[]; bodies: unknown[] }
}

describe('host glue: hostRpc dialect negotiation', () => {
  beforeEach(() => {
    host.resetHostRpcForTests()
  })

  it('uses the dot dialect directly when the host answers it (0.1.1-rc.x)', async () => {
    const api = stubApi([{ status: 200, body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { items: [] } } } }])
    const first = await host.hostRpc<{ items: unknown[] }>(api, 'session.list', {})
    expect(first.value.items).toEqual([])
    // Second call must NOT probe again: the resolved dialect is cached.
    await host.hostRpc(api, 'session.list', {})
    expect(api.paths).toEqual(['/api/session.list', '/api/session.list'])
  })

  it('falls back to the slash dialect on 404 and caches it (0.1.2-alpha.1+)', async () => {
    const api = stubApi([
      { status: 404, body: { error: 'not found' } },
      { status: 200, body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { sessionId: 'session-1' } } } },
    ])
    const seeded = await host.hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: 'w' })
    expect(seeded.value.sessionId).toBe('session-1')
    expect(api.paths).toEqual(['/api/session.create', '/api/session/create'])
    // The slash attempt carries the Remote-gateway payload shape: args keyed
    // by the controller's parameter name (`request` for session/create),
    // method equal to the path endpoint.
    const slashEnvelope = api.bodies[1] as { type: string; method: string; payload: Record<string, unknown> }
    expect(slashEnvelope.type).toBe('client-request')
    expect(slashEnvelope.method).toBe('session/create')
    expect(slashEnvelope.payload).toEqual({ args: { request: { workspaceId: 'w' } } })
    // Cached: the next call goes straight to the slash endpoint.
    await host.hostRpc(api, 'session.list', {})
    expect(api.paths[2]).toBe('/api/session/list')
  })

  it('fails loudly when neither dialect is claimed', async () => {
    const api = stubApi([{ status: 404, body: {} }])
    await expect(host.hostRpc(api, 'workspace.create', { path: '/tmp/w' })).rejects.toThrow(/no dialect answered/)
  })

  it('surfaces an envelope error instead of returning it', async () => {
    const api = stubApi([{ status: 200, body: { type: 'server-response', rpcId: 'x', result: { ok: false, error: { message: 'boom' } } } }])
    await expect(host.hostRpc(api, 'workspace.create', { path: '/tmp/w' })).rejects.toThrow(/envelope error/)
  })
})

describe('host glue: one-time-token cookie exchange', () => {
  it('follows the token URL with redirect manual and keeps only the cookie pair', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-abc=xyz; Path=/; HttpOnly; SameSite=Strict' } })
    }) as typeof fetch
    const cookie = await host.exchangeLaunchCookie(TOKEN_URL, fetchImpl)
    expect(cookie).toBe('dsh-auth-abc=xyz')
    expect(calls[0]!.url).toBe(TOKEN_URL)
    expect(calls[0]!.init.redirect).toBe('manual')
  })

  it('rejects a token exchange without set-cookie (the /api seeding cannot proceed)', async () => {
    const fetchImpl = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    await expect(host.exchangeLaunchCookie(TOKEN_URL, fetchImpl)).rejects.toThrow(/no set-cookie/)
  })
})
