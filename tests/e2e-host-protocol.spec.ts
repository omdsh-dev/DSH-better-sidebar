/**
 * Unit tests for the e2e lanes' host-transport contracts (tests/e2e/
 * host-protocol.ts + host.ts), locking in the DSH 0.1.2-alpha web dialect
 * the lanes speak:
 *
 * - one-time-token browser auth: `/?token=<43 chars>` launch URL
 *   (303 → signed cookie; a token-less URL is a pre-alpha host and must
 *   fail loudly),
 * - Remote-gateway slash endpoints (`POST /api/workspace/create`, payload
 *   must be exactly `{ args }` keyed by the controller's parameter name,
 *   the envelope method equal to the path endpoint).
 *
 * The shapes were transcribed from the deepseek-harness sources at tag
 * dsh-v0.1.2-alpha.1 and re-verified on the npm-published 0.1.2-alpha.2,
 * 0.1.2-alpha.3, 0.1.2-alpha.5, and 0.1.2-rc.1 (packages/client/connection,
 * packages/api/gateway, packages/bundle/web-app).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { APIRequestContext } from '@playwright/test'
import { parseLaunchUrl, pageUrlWith, rpcAttempt } from './e2e/host-protocol'

const BARE_URL = 'http://127.0.0.1:4199'
const TOKEN_URL = 'http://127.0.0.1:4199/?token=AbCdEf0123456789_-AbCdEf0123456789_-AbCd'

// host.ts validates DSH_E2E_URL at module load; stub the env BEFORE the
// dynamic import so the glue module can load in the unit environment.
let host: typeof import('./e2e/host')

beforeAll(async () => {
  vi.stubEnv('DSH_E2E_URL', TOKEN_URL)
  host = await import('./e2e/host')
})

describe('host-protocol: launch URL parsing', () => {
  it('extracts the one-time token of an authenticated launch URL', () => {
    const launch = parseLaunchUrl(TOKEN_URL)
    expect(launch.origin).toBe(BARE_URL)
    expect(launch.pageUrl).toBe(TOKEN_URL)
    expect(launch.token).toBe('AbCdEf0123456789_-AbCdEf0123456789_-AbCd')
  })

  it('rejects a token-less launch URL (a pre-0.1.2-alpha host the plugin no longer supports)', () => {
    expect(() => parseLaunchUrl(BARE_URL)).toThrow(/no \?token=/)
  })
})

describe('host-protocol: page URL query merge', () => {
  it('merges stamps into a token URL without breaking the token (never append ?…?…)', () => {
    const merged = pageUrlWith(TOKEN_URL, { 'dsh-desktop-mode': 'advanced', 'dsh-desktop-platform': 'win32' })
    const parsed = new URL(merged)
    expect(parsed.searchParams.get('token')).toBe('AbCdEf0123456789_-AbCdEf0123456789_-AbCd')
    expect(parsed.searchParams.get('dsh-desktop-mode')).toBe('advanced')
    expect(parsed.searchParams.get('dsh-desktop-platform')).toBe('win32')
    expect(merged.match(/\?/g)).toHaveLength(1)
  })
})

describe('host-protocol: slash RPC attempts', () => {
  it('targets the slash endpoint with args wrapped by the parameter name', () => {
    const args = { path: '/tmp/w' }
    expect(rpcAttempt('workspace.create', args)).toEqual({
      path: '/api/workspace/create',
      method: 'workspace/create',
      payload: { args: { request: args } },
    })
  })

  it('keys args by the parameter name — session/list is literally `_request` (verified on a live 0.1.2-alpha host)', () => {
    // typert gateway: session/list declares `_request` and rejects `{}` /
    // `{request:{}}` — the wrapper table must reproduce the exact shape.
    expect(rpcAttempt('session.list', {})).toEqual({
      path: '/api/session/list',
      method: 'session/list',
      payload: { args: { _request: {} } },
    })
    expect(rpcAttempt('session.create', { workspaceId: 'w' })).toEqual({
      path: '/api/session/create',
      method: 'session/create',
      payload: { args: { request: { workspaceId: 'w' } } },
    })
  })

  it('fails loudly for methods without a verified args key', () => {
    expect(() => rpcAttempt('settings.describe', {})).toThrow(/no args key/)
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

describe('host glue: hostRpc', () => {
  it('posts the Remote-gateway envelope to the slash endpoint and unwraps the result', async () => {
    const api = stubApi([{ status: 200, body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { sessionId: 'session-1' } } } }])
    const seeded = await host.hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: 'w' })
    expect(seeded.value.sessionId).toBe('session-1')
    expect(api.paths).toEqual(['/api/session/create'])
    const envelope = api.bodies[0] as { type: string; method: string; payload: Record<string, unknown> }
    expect(envelope.type).toBe('client-request')
    expect(envelope.method).toBe('session/create')
    expect(envelope.payload).toEqual({ args: { request: { workspaceId: 'w' } } })
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
