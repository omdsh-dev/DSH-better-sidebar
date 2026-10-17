/**
 * S2 HTTP boundary contract (fake fetch; NO network).
 *
 * Pins the approved §3 rules:
 * - secrets are resolved per operation from the host credential seam and sent
 *   as a request header — caller `authorization`/`cookie` headers are refused;
 * - the target host is allowlisted before any fetch, and redirects are followed
 *   manually and ONLY same-origin (never another host, never an https → http
 *   downgrade);
 * - caller cancellation and the operation timeout abort the request with the
 *   fixed `cancelled` / `timeout` categories;
 * - the response body cap is explicit (`truncated`), only safe response headers
 *   are projected (no cookies), and no error message copies a request header,
 *   secret, raw body or provider diagnostics.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import {
  createHttpClient,
  requireHttpOk,
} from '../src/clues/runtime/http.ts'
import type {
  ClueFetch,
  ClueFetchInit,
  ClueFetchResponse,
  ClueHttpResult,
} from '../src/clues/runtime/types.ts'

const URL_BASE = 'https://api.example.invalid'

interface FetchCall {
  readonly url: string
  readonly init: ClueFetchInit
}

function headerBag(headers: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  return { get: name => lower.get(name.toLowerCase()) ?? null }
}

function textResponse(status: number, text: string, headers: Record<string, string> = {}): ClueFetchResponse {
  return { status, headers: headerBag(headers), body: null, text: async () => text }
}

function chunkedResponse(status: number, chunks: readonly string[]): ClueFetchResponse & {
  readonly cancelled: () => boolean
} {
  let cancelled = false
  let index = 0
  return {
    status,
    headers: headerBag({}),
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled || index >= chunks.length) return { done: true as const }
            const value = Buffer.from(chunks[index++]!, 'utf8')
            return { done: false as const, value }
          },
          async cancel() {
            cancelled = true
          },
        }
      },
    },
    cancelled: () => cancelled,
  }
}

type Handler = (url: string, init: ClueFetchInit, index: number) => ClueFetchResponse | Promise<ClueFetchResponse>

function fakeFetch(handler: Handler): ClueFetch & { readonly calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetcher = (async (url: string, init: ClueFetchInit): Promise<ClueFetchResponse> => {
    calls.push({ url, init })
    return await handler(url, init, calls.length - 1)
  }) as ClueFetch & { readonly calls: FetchCall[] }
  ;(fetcher as { calls: FetchCall[] }).calls = calls
  return fetcher
}

function makeClient(
  handler: Handler,
  options: {
    credential?: (ref: string) => Promise<string | undefined>
    timeoutMs?: number
    maxBytes?: number
  } = {},
) {
  const fetcher = fakeFetch(handler)
  const resolutions: string[] = []
  const client = createHttpClient({
    fetch: fetcher,
    ...(options.credential === undefined ? {} : {
      resolveCredential: async ref => {
        resolutions.push(ref)
        return await options.credential!(ref)
      },
    }),
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { defaultMaxResponseBytes: options.maxBytes }),
  })
  return { client, fetcher, resolutions }
}

describe('HTTP request boundary', () => {
  it('attaches the per-operation credential and projects only safe response headers', async () => {
    const { client, fetcher, resolutions } = makeClient(
      () => textResponse(200, '{"ok":true}', {
        'content-type': 'application/json',
        'set-cookie': 'session=secret',
        link: '<next>; rel="next"',
      }),
      { credential: async () => 'operation-secret' },
    )
    const result = await client.request({
      url: `${URL_BASE}/items`,
      allowedHosts: ['api.example.invalid'],
      credential: { ref: 'FEISHU_TENANT_TOKEN' },
    })
    expect(result).toMatchObject({
      status: 200,
      url: `${URL_BASE}/items`,
      text: '{"ok":true}',
      truncated: false,
      redirects: 0,
    })
    expect(fetcher.calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
    })
    expect(fetcher.calls[0]?.init.headers.authorization).toBe('Bearer operation-secret')
    expect(result.headers['content-type']).toBe('application/json')
    expect(result.headers.link).toBe('<next>; rel="next"')
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(resolutions).toEqual(['FEISHU_TENANT_TOKEN'])
  })

  it('resolves credentials per operation rather than caching them', async () => {
    let counter = 0
    const { client, resolutions } = makeClient(
      () => textResponse(200, 'ok'),
      { credential: async () => `secret-${++counter}` },
    )
    const credential = { ref: 'FEISHU_TENANT_TOKEN' }
    await client.request({ url: `${URL_BASE}/a`, credential, allowedHosts: ['api.example.invalid'] })
    await client.request({ url: `${URL_BASE}/b`, credential, allowedHosts: ['api.example.invalid'] })
    expect(resolutions).toEqual(['FEISHU_TENANT_TOKEN', 'FEISHU_TENANT_TOKEN'])
  })

  it('refuses caller-supplied authorization headers and embedded URL credentials', async () => {
    const { client, fetcher } = makeClient(() => textResponse(200, 'ok'))
    await expect(client.request({
      url: `${URL_BASE}/x`,
      headers: { Authorization: 'Bearer stolen' },
    })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(client.request({
      url: 'https://user:pass@api.example.invalid/x',
    })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(client.request({
      url: `${URL_BASE}/x`,
      credential: { ref: 'TOKEN', header: 'cookie' },
    })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(fetcher.calls).toHaveLength(0)
  })

  it('fails as auth-required when the credential is unavailable and never calls fetch', async () => {
    const { client, fetcher } = makeClient(() => textResponse(200, 'ok'), {
      credential: async () => undefined,
    })
    const error = await client.request({
      url: `${URL_BASE}/x`,
      credential: { ref: 'MISSING_TOKEN' },
      allowedHosts: ['api.example.invalid'],
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('auth-required')
    expect(String(JSON.stringify((error as ClueError).meta))).not.toContain('MISSING_TOKEN')
    expect(fetcher.calls).toHaveLength(0)
  })

  it('requires an allowlist before resolving a connection credential', async () => {
    const { client, fetcher, resolutions } = makeClient(() => textResponse(200, 'ok'), {
      credential: async () => 'operation-secret',
    })
    await expect(client.request({
      url: `${URL_BASE}/x`,
      credential: { ref: 'TOKEN' },
    })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(resolutions).toEqual([])
    expect(fetcher.calls).toHaveLength(0)
  })

  it('refuses the same host on an undeclared port', async () => {
    const { client, fetcher } = makeClient(() => textResponse(200, 'ok'))
    await expect(client.request({
      url: 'https://api.example.invalid:8443/x',
      allowedHosts: ['api.example.invalid'],
    })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(fetcher.calls).toHaveLength(0)
    // An explicit host:port entry allows exactly that port.
    const allowed = await client.request({
      url: 'https://api.example.invalid:8443/x',
      allowedHosts: ['api.example.invalid:8443'],
    })
    expect(allowed.status).toBe(200)
    expect(fetcher.calls).toHaveLength(1)
  })

  it('releases a redirect response body before following it', async () => {
    let cancelled = false
    const redirect: ClueFetchResponse = {
      status: 302,
      headers: headerBag({ location: '/next' }),
      body: {
        getReader: () => ({
          read: async () => ({ done: true as const }),
          cancel: async () => { cancelled = true },
        }),
      },
    }
    const { client } = makeClient(url => url.endsWith('/next') ? textResponse(200, 'moved') : redirect)
    const result = await client.request({ url: `${URL_BASE}/start` })
    expect(result).toMatchObject({ status: 200, redirects: 1, text: 'moved' })
    expect(cancelled).toBe(true)
  })

  it('refuses a target host outside the connection allowlist', async () => {
    const { client, fetcher } = makeClient(() => textResponse(200, 'ok'))
    await expect(client.request({
      url: 'https://other.example.invalid/x',
      allowedHosts: ['api.example.invalid'],
    })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(fetcher.calls).toHaveLength(0)
  })

  it('follows a same-origin redirect and keeps the credential on the same origin', async () => {
    const { client, fetcher } = makeClient(
      (url) => url.includes('/next')
        ? textResponse(200, 'moved')
        : textResponse(302, '', { location: '/next?page=2' }),
      { credential: async () => 'op-secret' },
    )
    const result = await client.request({
      url: `${URL_BASE}/start`,
      credential: { ref: 'TOKEN' },
      allowedHosts: ['api.example.invalid'],
    })
    expect(result).toMatchObject({
      status: 200,
      text: 'moved',
      redirects: 1,
      url: `${URL_BASE}/next?page=2`,
    })
    expect(fetcher.calls).toHaveLength(2)
    expect(fetcher.calls[1]?.init.headers.authorization).toBe('Bearer op-secret')
  })

  it('refuses a cross-host redirect without forwarding the secret', async () => {
    const { client, fetcher } = makeClient(
      () => textResponse(302, '', { location: 'https://evil.example.invalid/steal' }),
      { credential: async () => 'op-secret' },
    )
    const error = await client.request({
      url: `${URL_BASE}/start`,
      credential: { ref: 'TOKEN' },
      allowedHosts: ['api.example.invalid'],
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('permission-denied')
    expect((error as ClueError).message).not.toContain('evil.example.invalid')
    expect(fetcher.calls).toHaveLength(1)
    expect(JSON.stringify(fetcher.calls[0]?.init.headers)).toContain('op-secret')
  })

  it('stops after the redirect budget', async () => {
    const { client } = makeClient(() => textResponse(302, '', { location: '/loop' }))
    await expect(client.request({
      url: `${URL_BASE}/loop`,
      maxRedirects: 2,
    })).rejects.toMatchObject({ category: 'failed' })
  })

  it('aborts on the operation timeout with the fixed timeout category', async () => {
    const { client } = makeClient((_url, init) => new Promise<ClueFetchResponse>((_resolve, reject) => {
      // The fake never answers; the runtime must abort it via the signal.
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    }), { timeoutMs: 5 })
    await expect(client.request({ url: `${URL_BASE}/slow` })).rejects.toMatchObject({ category: 'timeout' })
  })

  it('aborts on caller cancellation with the fixed cancelled category', async () => {
    const { client } = makeClient((_url, init) => new Promise<ClueFetchResponse>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    }))
    const controller = new AbortController()
    const promise = client.request({ url: `${URL_BASE}/slow` }, { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ category: 'cancelled' })
  })

  it('caps the response body explicitly instead of silently truncating', async () => {
    const response = chunkedResponse(200, ['0123', '4567', '89'])
    const { client } = makeClient(() => response, { maxBytes: 5 })
    const result = await client.request({ url: `${URL_BASE}/big` })
    expect(result.text).toBe('01234')
    expect(result.truncated).toBe(true)
    expect(response.cancelled()).toBe(true)
  })

  it('normalizes a body-read failure without leaking its text', async () => {
    const response: ClueFetchResponse = {
      status: 200,
      headers: headerBag({}),
      body: {
        getReader: () => ({
          read: async () => { throw new Error('provider body token=leak') },
          cancel: async () => undefined,
        }),
      },
    }
    const { client } = makeClient(() => response)
    const error = await client.request({ url: `${URL_BASE}/broken` }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('failed')
    expect((error as ClueError).message).not.toContain('leak')
  })

  it('normalizes a transport failure without echoing the URL or secret', async () => {
    const { client } = makeClient(() => {
      throw new Error('network failure token=leak-secret host=api.example.invalid')
    }, { credential: async () => 'leak-secret' })
    const error = await client.request({
      url: `${URL_BASE}/x`,
      credential: { ref: 'TOKEN' },
      allowedHosts: ['api.example.invalid'],
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('failed')
    expect((error as ClueError).message).not.toContain('leak-secret')
    expect((error as ClueError).message).not.toContain('api.example.invalid')
  })
})

describe('requireHttpOk', () => {
  function result(status: number): ClueHttpResult {
    return { status, url: `${URL_BASE}/x`, headers: {}, text: '', truncated: false, redirects: 0 }
  }

  it('maps provider statuses to fixed categories', () => {
    expect(requireHttpOk(result(200)).status).toBe(200)
    const categoryOf = (status: number): string => {
      try {
        requireHttpOk(result(status))
      } catch (error) {
        return (error as ClueError).category
      }
      throw new Error(`status ${status} did not throw`)
    }
    expect(categoryOf(401)).toBe('auth-required')
    expect(categoryOf(403)).toBe('permission-denied')
    expect(categoryOf(404)).toBe('not-found')
    expect(categoryOf(409)).toBe('conflict')
    expect(categoryOf(429)).toBe('rate-limited')
    expect(categoryOf(503)).toBe('failed')
  })
})
