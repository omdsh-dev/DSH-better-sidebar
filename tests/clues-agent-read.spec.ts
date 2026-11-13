/**
 * The fixed local read route, driven at its PUBLIC HTTP seam.
 *
 * No controller internals are mocked: the route handler is the boundary under
 * test, backed by a REAL clue service/store and a fake workspace registry.
 * The spec pins:
 * - the loopback-only admission gate (real peer socket, OS-assigned local
 *   port, literal loopback Host+port, no Origin/sec-fetch/Forwarded headers,
 *   application/json, POST only, no CORS/preflight);
 * - body validation (workspace id must be registered, one token only, offset);
 * - the reader semantics carried by the route (live clue, safe live error with
 *   no fallback, explicit snapshot, pack metadata only, cross-workspace find);
 * - session/caller propagation into the source operation;
 * - close/abort propagation; and
 * - a real cookie-less loopback HTTP request through a Node server.
 */
import { mkdtempSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import {
  CLUE_AGENT_READ_ROUTE_PATH,
  createClueAgentReadRoute,
  isLoopbackAddress,
} from '../src/clues/agent-read.ts'
import { createCluesService, type ClueCallOptions, type ClueSourceRegistration, type CluesService } from '../src/clues/service.ts'
import type {
  ClueDiscussionPage,
  ClueOperationContext,
  ClueReadResult,
  ClueCommentsListParams,
  Locator,
} from '../src/clues/types.ts'
import type { SidebarHttpRequest, SidebarHttpResponse } from '../src/context-types.ts'
import { MAX_AGENT_READ_PACK_MEMBERS } from '../src/clues/tools.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
const servers: Server[] = []
const NOW = '2026-10-17T00:00:00.000Z'

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const path of roots.splice(0)) removeTree(path)
})

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-agent-read-'))
  roots.push(path)
  return path
}

function makeService(): CluesService {
  let next = 0
  return createCluesService({ root: tempRoot(), now: () => NOW, newId: kind => `${kind}-${++next}` })
}

function source(
  sourceId: string,
  read: (input: { readonly locator: Locator }, context: ClueOperationContext) => Promise<ClueReadResult> = async (input) => ({
    format: 'text/plain',
    data: { text: `live:${String(input.locator.id)}` },
    fetchedAt: NOW,
    text: `live:${String(input.locator.id)}`,
  }),
): ClueSourceRegistration {
  const typeId = `${sourceId}.text`
  return {
    descriptor: {
      sourceId,
      name: sourceId,
      order: 0,
      pluginId: 'test',
      types: [typeId],
      transport: 'http',
      capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false },
    },
    types: [{
      typeId,
      sourceId,
      formats: ['text/plain'],
      capabilities: { read: true, edit: false, concurrency: 'none' },
    }],
    operations: { read: async (input, context) => read(input, context) },
  }
}

/** One response capture with event support (Node-like close/finish). */
interface FakeResponse {
  res: SidebarHttpResponse
  status: number
  headers: Record<string, string>
  body: string
  ended: boolean
  destroyed: boolean
  emitClose(): void
}

function fakeResponse(): FakeResponse {
  const listeners = new Map<string, Set<() => void>>()
  const emit = (event: string): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener()
  }
  const captured: FakeResponse = {
    status: 0,
    headers: {},
    body: '',
    ended: false,
    destroyed: false,
    res: undefined as unknown as SidebarHttpResponse,
    emitClose: () => { emit('close') },
  }
  const res: SidebarHttpResponse = {
    statusCode: 0,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    write(chunk: string | Uint8Array) {
      captured.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) {
        captured.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      }
      captured.ended = true
    },
    destroy() { captured.destroyed = true },
    once(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return res
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
      return res
    },
  }
  captured.res = res
  return captured
}

/** One request capture with a peer socket and abort event support. */
interface FakeRequest extends SidebarHttpRequest {
  readonly bodyReads: number
  emitAborted(): void
}

function fakeRequest(input: {
  readonly url?: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly remoteAddress?: string
  readonly localPort?: number
} = {}): FakeRequest {
  const listeners = new Map<string, Set<() => void>>()
  const emit = (event: string): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener()
  }
  let reads = 0
  const request = {
    url: input.url ?? CLUE_AGENT_READ_ROUTE_PATH,
    method: input.method ?? 'POST',
    headers: input.headers ?? {},
    socket: {
      remoteAddress: input.remoteAddress ?? '127.0.0.1',
      localPort: input.localPort ?? 3080,
    },
    once(event: 'aborted' | 'close', listener: () => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return request
    },
    off(event: 'aborted' | 'close', listener: () => void) {
      listeners.get(event)?.delete(listener)
      return request
    },
    async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
      reads += 1
      if (input.body !== undefined) yield Buffer.from(input.body)
    },
    get bodyReads(): number { return reads },
    emitAborted: () => { emit('aborted') },
  }
  return request
}

/** The default admitted request. */
function post(overrides: {
  readonly body?: string
  readonly headers?: Record<string, string>
  readonly url?: string
  readonly method?: string
  readonly remoteAddress?: string
  readonly localPort?: number
} = {}): FakeRequest {
  return fakeRequest({
    url: CLUE_AGENT_READ_ROUTE_PATH,
    method: 'POST',
    headers: {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
      ...overrides.headers,
    },
    body: overrides.body ?? JSON.stringify({
      workspaceId: 'ws-1',
      reference: '[[dsh-clue:clue-1]]',
      sessionId: 'session-1',
    }),
    ...(overrides.url === undefined ? {} : { url: overrides.url }),
    ...(overrides.method === undefined ? {} : { method: overrides.method }),
    ...(overrides.remoteAddress === undefined ? {} : { remoteAddress: overrides.remoteAddress }),
    ...(overrides.localPort === undefined ? {} : { localPort: overrides.localPort }),
  })
}

interface Harness {
  readonly service: CluesService
  readonly route: ReturnType<typeof createClueAgentReadRoute>
  readonly warnings: string[]
}

function harness(service: CluesService = makeService()): Harness {
  const warnings: string[] = []
  const route = createClueAgentReadRoute({
    clues: service,
    getWebServer: () => ({ port: 3080, getOrigin: () => 'http://127.0.0.1:3080' }),
    getWorkspaceRegistry: () => ({
      get: id => (id === 'ws-1' ? { id: 'ws-1' } : id === 'ws-2' ? { id: 'ws-2' } : undefined),
      list: () => [{ id: 'ws-1' }, { id: 'ws-2' }],
    }),
    logger: { warn: message => { warnings.push(message) } },
  })
  return { service, route, warnings }
}

async function call(route: Harness['route'], request: FakeRequest): Promise<FakeResponse> {
  const response = fakeResponse()
  await route.handler(request, response.res)
  return response
}

function json(response: FakeResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

/** A fixture with one live test clue in ws-1. */
async function clueFixture(): Promise<{ harness: Harness; clueId: string }> {
  const harnessValue = harness()
  harnessValue.service.registerSource(source('test.alpha'))
  const ensured = await harnessValue.service.ensure({
    workspaceId: 'ws-1',
    sourceId: 'test.alpha',
    typeId: 'test.alpha.text',
    locator: { id: 'a' },
    title: 'Alpha',
  })
  return { harness: harnessValue, clueId: ensured.clue.id }
}

describe('isLoopbackAddress', () => {
  it('accepts loopback spellings and rejects everything else', () => {
    for (const address of ['127.0.0.1', '127.9.8.7', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isLoopbackAddress(address), address).toBe(true)
    }
    for (const address of ['10.0.0.1', '192.168.1.4', '::2', '2001:db8::1', '127.0.0.999', 'localhost', '']) {
      expect(isLoopbackAddress(address), address).toBe(false)
    }
  })
})

describe('loopback admission gate', () => {
  it('accepts the admitted cookie-less local POST', async () => {
    const { harness: h, clueId } = await clueFixture()
    const request = post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${clueId}]]`,
        sessionId: 'session-1',
      }),
    })
    const response = await call(h.route, request)
    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({
      ok: true,
      value: {
        status: 'ok',
        kind: 'clue',
        id: clueId,
        text: 'live:a',
        freshness: 'live',
      },
    })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('accepts the literal localhost Host spelling', async () => {
    const { harness: h, clueId } = await clueFixture()
    const response = await call(h.route, post({
      headers: { host: 'localhost:3080' },
      body: JSON.stringify({ workspaceId: 'ws-1', reference: `[[dsh-clue:${clueId}]]`, sessionId: 's' }),
    }))
    expect(response.status).toBe(200)
  })

  it('accepts an IPv6 loopback peer and bracketed Host', async () => {
    const { harness: h, clueId } = await clueFixture()
    const response = await call(h.route, post({
      headers: { host: '[::1]:3080' },
      remoteAddress: '::1',
      body: JSON.stringify({ workspaceId: 'ws-1', reference: `[[dsh-clue:${clueId}]]`, sessionId: 's' }),
    }))
    expect(response.status).toBe(200)
  })

  it('refuses a non-loopback peer address before reading the body', async () => {
    const { harness: h } = await clueFixture()
    for (const remoteAddress of ['10.1.2.3', '192.168.0.10', '::2']) {
      const request = post({ remoteAddress })
      const response = await call(h.route, request)
      expect(response.status, remoteAddress).toBe(403)
      expect(request.bodyReads).toBe(0)
    }
  })

  it('refuses a different local port than the OS-bound listener port', async () => {
    const { harness: h } = await clueFixture()
    const request = post({ localPort: 9999 })
    const response = await call(h.route, request)
    expect(response.status).toBe(403)
    expect(request.bodyReads).toBe(0)
  })

  it('refuses non-loopback and wrong-port Host headers', async () => {
    const { harness: h } = await clueFixture()
    for (const host of ['evil.example:3080', '0.0.0.0:3080', '127.0.0.1:9999', 'localhost:9999', 'localhost', '127.0.0.1']) {
      const request = post({ headers: { host } })
      const response = await call(h.route, request)
      expect(response.status, host).toBe(403)
      expect(request.bodyReads, host).toBe(0)
    }
    for (const host of ['127.0.0.1:+3080', '127.0.0.1:3080.0', '127.0.0.1:0', '127.0.0.1:65536']) {
      const request = post({ headers: { host } })
      const response = await call(h.route, request)
      expect(response.status, host).toBe(403)
    }
  })

  it('refuses an array/duplicate Host header', async () => {
    const { harness: h } = await clueFixture()
    const request = post()
    ;(request.headers as Record<string, unknown>).host = ['127.0.0.1:3080', 'evil.example:3080']
    const response = await call(h.route, request)
    expect(response.status).toBe(403)
    expect(request.bodyReads).toBe(0)
  })

  it('refuses Origin, every sec-fetch and every forwarded/proxy header', async () => {
    const { harness: h } = await clueFixture()
    const cases: Array<Record<string, string>> = [
      { origin: 'http://127.0.0.1:3080' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-dest': 'empty' },
      { forwarded: 'for=127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-host': '127.0.0.1:3080' },
      { 'x-forwarded-proto': 'http' },
    ]
    for (const headers of cases) {
      const request = post({ headers })
      const response = await call(h.route, request)
      expect(response.status, JSON.stringify(headers)).toBe(403)
      expect(request.bodyReads, JSON.stringify(headers)).toBe(0)
    }
  })

  it('requires application/json', async () => {
    const { harness: h } = await clueFixture()
    for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/json-patch+json']) {
      const request = post({
        headers: contentType === undefined
          ? { 'content-type': undefined as unknown as string }
          : { 'content-type': contentType },
      })
      if (contentType === undefined) delete (request.headers as Record<string, unknown>)['content-type']
      const response = await call(h.route, request)
      expect(response.status, String(contentType)).toBe(415)
      expect(request.bodyReads).toBe(0)
    }
    // A media-type parameter and case variation are fine.
    const { harness: h2, clueId } = await clueFixture()
    const response = await call(h2.route, post({
      headers: { 'content-type': 'Application/JSON; Charset=UTF-8' },
      body: JSON.stringify({ workspaceId: 'ws-1', reference: `[[dsh-clue:${clueId}]]`, sessionId: 's' }),
    }))
    expect(response.status).toBe(200)
  })

  it('refuses GET and OPTIONS with no CORS/preflight surface', async () => {
    const { harness: h } = await clueFixture()
    for (const method of ['GET', 'OPTIONS', 'HEAD', 'PUT']) {
      const request = post({ method })
      const response = await call(h.route, request)
      expect(response.status, method).toBe(405)
      expect(request.bodyReads).toBe(0)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
      expect(response.headers['access-control-allow-methods']).toBeUndefined()
    }
  })

  it('refuses absolute-form and scheme-relative URLs', async () => {
    const { harness: h } = await clueFixture()
    for (const url of [
      `http://127.0.0.1:3080${CLUE_AGENT_READ_ROUTE_PATH}`,
      `//evil.example${CLUE_AGENT_READ_ROUTE_PATH}`,
      '\\sidebar\\agent\\clues\\read',
    ]) {
      const request = post({ url })
      const response = await call(h.route, request)
      expect(response.status, url).toBe(403)
      expect(request.bodyReads, url).toBe(0)
    }
  })

  it('refuses a query string on the fixed read route', async () => {
    const { harness: h } = await clueFixture()
    for (const url of [
      `${CLUE_AGENT_READ_ROUTE_PATH}?workspaceId=ws-1`,
      `${CLUE_AGENT_READ_ROUTE_PATH}?`,
      `${CLUE_AGENT_READ_ROUTE_PATH}#fragment`,
    ]) {
      const request = post({ url })
      const response = await call(h.route, request)
      expect(response.status, url).toBe(403)
      expect(request.bodyReads, url).toBe(0)
    }
  })
})

describe('body contract', () => {
  it('refuses malformed bodies, missing fields and a bad offset', async () => {
    const { harness: h } = await clueFixture()
    const cases: Array<[string, number]> = [
      ['not json', 400],
      ['{}', 400],
      [JSON.stringify({ reference: '[[dsh-clue:a]]', sessionId: 's' }), 400],
      [JSON.stringify({ workspaceId: '', reference: '[[dsh-clue:a]]', sessionId: 's' }), 400],
      [JSON.stringify({ workspaceId: 'ws-1', sessionId: 's' }), 400],
      [JSON.stringify({ workspaceId: 'ws-1', reference: '[[dsh-clue:a]]' }), 400],
      [JSON.stringify({ workspaceId: 'ws-1', reference: '[[dsh-clue:a]]', sessionId: 's', offset: -1 }), 400],
      [JSON.stringify({ workspaceId: 'ws-1', reference: '[[dsh-clue:a]]', sessionId: 's', offset: 1.5 }), 400],
      [JSON.stringify({ workspaceId: 'ws-1', reference: '[[dsh-clue:a]]', sessionId: 's', offset: Number.MAX_SAFE_INTEGER + 1 }), 400],
      [JSON.stringify({ workspaceId: 42, reference: '[[dsh-clue:a]]', sessionId: 's' }), 400],
    ]
    for (const [body, status] of cases) {
      const response = await call(h.route, post({ body }))
      expect(response.status, body).toBe(status)
    }
  })

  it('refuses an unregistered workspace id', async () => {
    const { harness: h } = await clueFixture()
    const response = await call(h.route, post({
      body: JSON.stringify({ workspaceId: 'ws-other', reference: '[[dsh-clue:a]]', sessionId: 's' }),
    }))
    expect(response.status).toBe(403)
  })

  it('refuses embedded, multiple and malformed reference tokens', async () => {
    const { harness: h } = await clueFixture()
    for (const reference of [
      'look [[dsh-clue:a]]',
      '[[dsh-clue:a]] [[dsh-clue:b]]',
      '[[[dsh-clue:a]]]',
      '[[dsh-clue:]]',
    ]) {
      const response = await call(h.route, post({
        body: JSON.stringify({ workspaceId: 'ws-1', reference, sessionId: 's' }),
      }))
      expect(response.status, reference).toBe(400)
    }
  })

  it('refuses any body field outside the fixed protocol', async () => {
    const { harness: h } = await clueFixture()
    const extras: Array<Record<string, unknown>> = [
      { method: 'clues.saveEdit' },
      { saveEdit: { format: 'text/plain' } },
      { sourceId: 'test.alpha' },
      { source: { id: 'x' } },
      { locator: { id: 'x' } },
      { typeId: 'test.alpha.text' },
      { kind: 'clue' },
      { id: 'x' },
      { workspace: '/tmp' },
      { snapshotId: 'x' },
      { includeContent: true },
    ]
    for (const extra of extras) {
      const body = JSON.stringify({
        workspaceId: 'ws-1',
        reference: '[[dsh-clue:a]]',
        sessionId: 's',
        ...extra,
      })
      const response = await call(h.route, post({ body }))
      expect(response.status, JSON.stringify(extra)).toBe(400)
      expect(json(response), JSON.stringify(extra)).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
    }
  })

  it('validates snapshotOffset as a non-negative safe integer', async () => {
    const { harness: h, clueId } = await clueFixture()
    for (const snapshotOffset of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      const response = await call(h.route, post({
        body: JSON.stringify({
          workspaceId: 'ws-1',
          reference: `[[dsh-clue:${clueId}]]`,
          sessionId: 's',
          snapshotOffset,
        }),
      }))
      expect(response.status, String(snapshotOffset)).toBe(400)
    }
    const accepted = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${clueId}]]`,
        sessionId: 's',
        snapshotOffset: 0,
      }),
    }))
    expect(accepted.status).toBe(200)
  })

  it('bounds the body at the shared 1 MiB default', async () => {
    const { harness: h } = await clueFixture()
    const body = JSON.stringify({
      workspaceId: 'ws-1',
      reference: '[[dsh-clue:a]]',
      sessionId: 'x'.repeat((1 << 20) + 32),
    })
    const response = await call(h.route, post({ body }))
    // The default `readJsonBody` bound reports an oversized body as
    // `too-large` / 413 (the route deliberately does not use the edit cap).
    expect(response.status).toBe(413)
    expect(json(response)).toMatchObject({
      ok: false,
      error: { code: 'too-large', message: 'request body too large' },
    })
  })
})

describe('reader semantics through the route', () => {
  it('propagates caller=agent and the body session id', async () => {
    const h = harness()
    const seen: Array<{ caller: string; sessionId?: string }> = []
    h.service.registerSource(source('test.session', async (_input, context) => {
      seen.push({
        caller: context.caller,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      })
      return { format: 'text/plain', data: {}, text: 'ok', fetchedAt: NOW }
    }))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.session',
      typeId: 'test.session.text',
      locator: { id: 'a' },
      title: 'A',
    })
    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${ensured.clue.id}]]`,
        sessionId: 'session-from-prompt',
      }),
    }))
    expect(response.status).toBe(200)
    expect(seen).toEqual([{ caller: 'agent', sessionId: 'session-from-prompt' }])
  })

  it('returns a safe live error and never falls back to a snapshot', async () => {
    const h = harness()
    h.service.registerSource(source('test.fail', async () => {
      throw new Error('SECRET=host-internals')
    }))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.fail',
      typeId: 'test.fail.text',
      locator: { id: 'x' },
      title: 'Failing',
    })
    const snapshot = await h.service.putSnapshot('ws-1', {
      clueId: ensured.clue.id,
      format: 'text/plain',
      data: { text: 'old body' },
      text: 'old body',
      fetchedAt: NOW,
    })
    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${ensured.clue.id}]]`,
        sessionId: 's',
      }),
    }))
    expect(response.status).toBe(200)
    const body = json(response)
    expect(body).toMatchObject({
      ok: true,
      value: {
        status: 'error',
        kind: 'clue',
        error: { category: 'failed' },
        snapshotOffset: 0,
        snapshotCount: 1,
      },
    })
    expect((body.value as { snapshots: Array<{ snapshotId: string; clueId: string }> }).snapshots)
      .toEqual([expect.objectContaining({ snapshotId: snapshot.snapshotId, clueId: ensured.clue.id })])
    expect(response.body).not.toContain('SECRET')
    expect(response.body).not.toContain('host-internals')
    expect(response.body).not.toContain('old body')

    // The snapshot id is discoverable and is the only way to read history.
    const historical = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue-snapshot:${snapshot.snapshotId}]]`,
        sessionId: 's',
      }),
    }))
    expect(json(historical)).toMatchObject({
      ok: true,
      value: { status: 'ok', kind: 'snapshot', text: 'old body' },
    })
  })

  it('pages snapshot metadata through the optional snapshotOffset', async () => {
    const h = harness()
    h.service.registerSource(source('test.fail', async () => {
      throw new Error('live unavailable')
    }))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.fail',
      typeId: 'test.fail.text',
      locator: { id: 'x' },
      title: 'Many snapshots',
    })
    for (let index = 0; index < 21; index += 1) {
      await h.service.putSnapshot('ws-1', {
        clueId: ensured.clue.id,
        format: 'text/plain',
        data: { text: `snapshot ${index}` },
        text: `snapshot ${index}`,
        fetchedAt: NOW,
      })
    }
    const request = (snapshotOffset?: number): FakeRequest => post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${ensured.clue.id}]]`,
        sessionId: 's',
        ...(snapshotOffset === undefined ? {} : { snapshotOffset }),
      }),
    })
    const first = json(await call(h.route, request()))
    expect(first).toMatchObject({
      ok: true,
      value: {
        status: 'error',
        snapshotOffset: 0,
        snapshotCount: 21,
        snapshotsLimited: true,
        snapshotNextOffset: 20,
      },
    })
    expect((first.value as { snapshots: unknown[] }).snapshots).toHaveLength(20)
    expect(JSON.stringify(first)).not.toContain('snapshot 0')

    const second = json(await call(h.route, request(20)))
    expect(second).toMatchObject({
      ok: true,
      value: { status: 'error', snapshotOffset: 20, snapshotCount: 21 },
    })
    expect((second.value as { snapshots: unknown[] }).snapshots).toHaveLength(1)
  })

  it('reports an unavailable snapshot index explicitly', async () => {
    const h = harness()
    h.service.registerSource(source('test.alpha'))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'a' },
      title: 'A',
    })
    const original = h.service.listSnapshots
    h.service.listSnapshots = async () => {
      throw new Error('snapshot index offline')
    }
    try {
      const response = await call(h.route, post({
        body: JSON.stringify({
          workspaceId: 'ws-1',
          reference: `[[dsh-clue:${ensured.clue.id}]]`,
          sessionId: 's',
        }),
      }))
      const body = json(response)
      expect(body).toMatchObject({
        ok: true,
        value: {
          status: 'ok',
          snapshotOffset: 0,
          snapshotsUnavailable: { category: 'failed', message: 'the clue operation failed' },
        },
      })
      expect((body.value as { snapshotCount?: number }).snapshotCount).toBeUndefined()
      expect((body.value as { snapshots?: unknown[] }).snapshots).toBeUndefined()
    } finally {
      h.service.listSnapshots = original
    }
  })

  it('reads an explicit snapshot token with fetchedAt and integrity', async () => {
    const h = harness()
    h.service.registerSource(source('test.alpha'))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'a' },
      title: 'A',
    })
    const snapshot = await h.service.putSnapshot('ws-1', {
      clueId: ensured.clue.id,
      format: 'text/plain',
      data: { text: 'snapshot body' },
      text: 'snapshot body',
      fetchedAt: '2026-02-02T00:00:00.000Z',
      integrity: 'verified',
    })
    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue-snapshot:${snapshot.snapshotId}]]`,
        sessionId: 's',
      }),
    }))
    expect(json(response)).toMatchObject({
      ok: true,
      value: {
        status: 'ok',
        kind: 'snapshot',
        text: 'snapshot body',
        fetchedAt: '2026-02-02T00:00:00.000Z',
        integrity: 'verified',
      },
    })
  })

  it('returns pack member metadata only, in bounded pages', async () => {
    const h = harness()
    h.service.registerSource(source('test.alpha'))
    const members: string[] = []
    for (let index = 0; index < MAX_AGENT_READ_PACK_MEMBERS + 1; index += 1) {
      const ensured = await h.service.ensure({
        workspaceId: 'ws-1',
        sourceId: 'test.alpha',
        typeId: 'test.alpha.text',
        locator: { id: `m${index}` },
        title: `M${index}`,
      })
      members.push(ensured.clue.id)
    }
    const pack = await h.service.createPack({ workspaceId: 'ws-1', name: 'P', members })
    const snapshot = await h.service.putSnapshot('ws-1', {
      clueId: members[0]!,
      format: 'text/plain',
      data: { text: 'member body' },
      text: 'member body',
      fetchedAt: NOW,
    })
    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-cluepack:${pack.pack.id}]]`,
        sessionId: 's',
      }),
    }))
    const body = json(response)
    expect(body).toMatchObject({
      ok: true,
      value: {
        status: 'ok',
        kind: 'pack',
        memberCount: MAX_AGENT_READ_PACK_MEMBERS + 1,
        limited: true,
        nextOffset: MAX_AGENT_READ_PACK_MEMBERS,
        snapshotOffset: 0,
      },
    })
    const firstMember = (body.value as {
      members: Array<{ snapshotCount: number; snapshots: Array<{ snapshotId: string }> }>
    }).members[0]!
    expect(firstMember).toMatchObject({
      snapshotCount: 1,
      snapshots: [expect.objectContaining({ snapshotId: snapshot.snapshotId })],
    })
    expect((body.value as { members: unknown[] }).members).toHaveLength(MAX_AGENT_READ_PACK_MEMBERS)
    expect(response.body).not.toContain('member body')
  })

  it('finds a stable reference in another registered workspace', async () => {
    const h = harness()
    h.service.registerSource(source('test.alpha'))
    const foreign = await h.service.ensure({
      workspaceId: 'ws-2',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'foreign' },
      title: 'Foreign',
    })
    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${foreign.clue.id}]]`,
        sessionId: 's',
      }),
    }))
    expect(json(response)).toMatchObject({
      ok: true,
      value: { status: 'ok', workspaceId: 'ws-2', text: 'live:foreign' },
    })
  })

  it('aborts the source read when the response closes', async () => {
    const h = harness()
    let observedAbort = false
    h.service.registerSource(source('test.slow', async () => {
      await new Promise((_resolve, reject) => {
        // Wait until the route aborts the controller, then fail like a source
        // whose transport noticed cancellation.
        const timer = setInterval(() => {
          if (observedAbort) {
            clearInterval(timer)
            reject(new Error('aborted'))
          }
        }, 1)
      })
      return { format: 'text/plain', data: {}, text: 'never', fetchedAt: NOW }
    }))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.slow',
      typeId: 'test.slow.text',
      locator: { id: 'slow' },
      title: 'Slow',
    })
    const request = post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${ensured.clue.id}]]`,
        sessionId: 's',
      }),
    })
    const response = fakeResponse()
    const pending = h.route.handler(request, response.res)
    await new Promise(resolve => setTimeout(resolve, 10))
    observedAbort = true
    response.emitClose()
    await pending
    // The client is gone: no envelope is written onto a closed response.
    expect(response.status).toBe(0)
    expect(response.body).toBe('')
  })

  it('aborts the source read when the request emits aborted', async () => {
    const h = harness()
    let signal: AbortSignal | undefined
    h.service.registerSource(source('test.abort', async (_input, context) => {
      signal = context.signal
      await new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return { format: 'text/plain', data: {}, text: 'never', fetchedAt: NOW }
    }))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.abort',
      typeId: 'test.abort.text',
      locator: { id: 'x' },
      title: 'Abort',
    })
    const request = post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${ensured.clue.id}]]`,
        sessionId: 's',
      }),
    })
    const response = fakeResponse()
    const pending = h.route.handler(request, response.res)
    await new Promise(resolve => setTimeout(resolve, 10))
    request.emitAborted()
    await pending
    expect(signal?.aborted).toBe(true)
    expect(response.status).toBe(0)
  })
})

/** Issue one real loopback POST without cookies through Node's HTTP client. */
function realRequest(port: number, body: unknown): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: CLUE_AGENT_READ_ROUTE_PATH,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('real loopback HTTP (cookie-less)', () => {
  it('answers a real local POST through the route and rejects a remote-style Host', async () => {
    const h = harness()
    h.service.registerSource(source('test.alpha'))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'real' },
      title: 'Real',
    })
    const holder: { port: number } = { port: 0 }
    const route = createClueAgentReadRoute({
      clues: h.service,
      getWebServer: () => ({ port: holder.port, getOrigin: () => `http://127.0.0.1:${holder.port}` }),
      getWorkspaceRegistry: () => ({
        get: id => (id === 'ws-1' ? { id: 'ws-1' } : undefined),
        list: () => [{ id: 'ws-1' }],
      }),
    })
    const server = createServer((req, res) => {
      void route.handler(
        req as unknown as SidebarHttpRequest,
        res as unknown as SidebarHttpResponse,
      )
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    holder.port = (server.address() as AddressInfo).port

    const response = await realRequest(holder.port, {
      workspaceId: 'ws-1',
      reference: `[[dsh-clue:${ensured.clue.id}]]`,
      sessionId: 'session-real',
    })
    expect(response.status, response.body).toBe(200)
    const body = JSON.parse(response.body) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, value: { status: 'ok', text: 'live:real' } })
    // No CORS surface and no login redirect/cookie challenge.
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.status).not.toBe(401)
    expect(response.status).not.toBe(403)
  })
})

// ── UI19 discussion follow-up through the fixed route ─────────────────────

/** The target public comments-reader signature the parent service will wire. */
type CommentsList = (
  params: ClueCommentsListParams,
  options?: ClueCallOptions,
) => Promise<ClueDiscussionPage>

/** Install the parent-owned comments method on the fixture service. */
function stubCommentsList(clues: CluesService, list: CommentsList): void {
  ;(clues as unknown as { commentsList: CommentsList }).commentsList = list
}

/** One valid discussion page used by the route projections. */
function discussionPage(): ClueDiscussionPage {
  return {
    status: 'ok',
    items: [{
      id: 'comment-1',
      kind: 'comment',
      format: 'text/markdown',
      body: 'First page',
      createdAt: NOW,
      replyCount: 1,
      nextRepliesCursor: 'replies-1',
    }],
    fetchedAt: NOW,
    nextCursor: 'page-2',
    total: 2,
    complete: false,
    coverage: 'document',
  }
}

describe('discussion follow-up through the fixed route', () => {
  it('forwards commentsCursor/parentId without reading the clue body', async () => {
    const h = harness()
    let reads = 0
    h.service.registerSource(source('test.discussion', async () => {
      reads += 1
      return { format: 'text/plain', data: {}, text: 'live body', fetchedAt: NOW }
    }))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.discussion',
      typeId: 'test.discussion.text',
      locator: { id: 'a' },
      title: 'Discussion',
    })
    const calls: Array<{ params: ClueCommentsListParams; options?: ClueCallOptions }> = []
    stubCommentsList(h.service, async (params, options) => {
      calls.push({ params, ...(options === undefined ? {} : { options }) })
      return discussionPage()
    })

    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${ensured.clue.id}]]`,
        sessionId: 'session-1',
        commentsCursor: 'page-2',
        parentId: 'comment-9',
      }),
    }))

    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({
      ok: true,
      value: {
        status: 'ok',
        kind: 'clue',
        id: ensured.clue.id,
        workspaceId: 'ws-1',
        title: 'Discussion',
        discussion: discussionPage(),
      },
    })
    expect((json(response).value as { text?: string }).text).toBeUndefined()
    expect(reads).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toMatchObject({
      workspaceId: 'ws-1',
      clueId: ensured.clue.id,
      cursor: 'page-2',
      parentId: 'comment-9',
    })
    expect(calls[0]!.options).toMatchObject({ caller: 'agent', sessionId: 'session-1' })
  })

  it('projects the first discussion page carried by a live read', async () => {
    const h = harness()
    const page = discussionPage()
    h.service.registerSource(source('test.read-discussion', async () => ({
      format: 'text/plain',
      data: {},
      text: 'live body',
      fetchedAt: NOW,
      discussion: page,
    })))
    const ensured = await h.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.read-discussion',
      typeId: 'test.read-discussion.text',
      locator: { id: 'a' },
      title: 'Read discussion',
    })

    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${ensured.clue.id}]]`,
        sessionId: 'session-1',
      }),
    }))

    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({
      ok: true,
      value: { status: 'ok', text: 'live body', discussion: page },
    })
  })

  it('rejects an empty or non-string commentsCursor/parentId as bad request', async () => {
    const { harness: h, clueId } = await clueFixture()
    const malformed: Array<Record<string, unknown>> = [
      { commentsCursor: '' },
      { commentsCursor: '   ' },
      { commentsCursor: 1 },
      { commentsCursor: null },
      { parentId: '' },
      { parentId: 42 },
      { parentId: {} },
    ]
    for (const fields of malformed) {
      const response = await call(h.route, post({
        body: JSON.stringify({
          workspaceId: 'ws-1',
          reference: `[[dsh-clue:${clueId}]]`,
          sessionId: 'session-1',
          ...fields,
        }),
      }))
      expect(response.status, JSON.stringify(fields)).toBe(400)
      expect(json(response), JSON.stringify(fields)).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
    }
  })

  it('keeps a comments-page failure safe on the wire', async () => {
    const { harness: h, clueId } = await clueFixture()
    stubCommentsList(h.service, async () => {
      throw new Error('SECRET=super-secret TOKEN=abc')
    })

    const response = await call(h.route, post({
      body: JSON.stringify({
        workspaceId: 'ws-1',
        reference: `[[dsh-clue:${clueId}]]`,
        sessionId: 'session-1',
        commentsCursor: 'page-2',
      }),
    }))

    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({
      ok: true,
      value: { status: 'error', kind: 'clue', error: { category: 'failed' } },
    })
    expect(JSON.stringify(json(response))).not.toContain('super-secret')
    expect(JSON.stringify(json(response))).not.toContain('SECRET=')
    expect(JSON.stringify(json(response))).not.toContain('TOKEN=')
  })
})
