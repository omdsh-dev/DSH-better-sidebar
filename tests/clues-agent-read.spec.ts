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
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLUE_AGENT_READ_ROUTE_PATH, createClueAgentReadRoute, isLoopbackAddress } from '../src/clues/agent-read.ts'
import { createCluesService, type ClueCallOptions, type ClueSnapshotInput, type ClueSourceRegistration, type CluesService } from '../src/clues/service.ts'
import type { ClueCommentsListParams, ClueDiscussionPage, ClueOperationContext, ClueReadResult, Locator } from '../src/clues/types.ts'
import type { SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from '../src/context-types.ts'
import { MAX_AGENT_READ_PACK_MEMBERS } from '../src/clues/tools.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
const servers: Server[] = []
const NOW = '2026-10-17T00:00:00.000Z'
const PORT = 3080
const ORIGIN = `http://127.0.0.1:${PORT}`
const DEFAULT_HEADERS = { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' }

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const path of roots.splice(0)) removeTree(path)
})

function makeService(): CluesService {
  let next = 0
  const root = mkdtempSync(join(tmpdir(), 'dsh-clues-agent-read-'))
  roots.push(root)
  return createCluesService({ root, now: () => NOW, newId: kind => `${kind}-${++next}` })
}

const liveRead = async (input: { readonly locator: Locator }): Promise<ClueReadResult> => ({
  format: 'text/plain', data: { text: `live:${String(input.locator.id)}` }, fetchedAt: NOW, text: `live:${String(input.locator.id)}`,
})

function source(
  sourceId: string,
  read: (input: { readonly locator: Locator }, context: ClueOperationContext) => Promise<ClueReadResult> = liveRead,
): ClueSourceRegistration {
  const typeId = `${sourceId}.text`
  return {
    descriptor: { sourceId, name: sourceId, order: 0, pluginId: 'test', types: [typeId], transport: 'http',
      capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false } },
    types: [{ typeId, sourceId, formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations: { read: async (input, context) => read(input, context) },
  }
}

const text = (chunk: string | Uint8Array): string => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')

type FakeRequest = SidebarHttpRequest & { readonly bodyReads: number; emitAborted(): void }

interface RequestInput {
  url?: string; method?: string; body?: string; remoteAddress?: string; localPort?: number
  headers?: Record<string, string | string[] | undefined>
}

/** The default admitted request, with per-case overrides. */
function post(input: RequestInput = {}): FakeRequest {
  let reads = 0
  let abort: (() => void) | undefined
  const headers: Record<string, string | string[] | undefined> = { ...DEFAULT_HEADERS, ...input.headers }
  for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key]
  const request = {
    url: input.url ?? CLUE_AGENT_READ_ROUTE_PATH,
    method: input.method ?? 'POST',
    headers,
    socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1', localPort: input.localPort ?? PORT },
    async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
      reads += 1
      if (input.body !== undefined) yield Buffer.from(input.body)
    },
    once(event: 'aborted' | 'close', listener: () => void) { if (event === 'aborted') abort = listener; return request },
    off() { abort = undefined; return request },
    get bodyReads(): number { return reads },
    emitAborted: () => { abort?.() },
  }
  return request
}

/** One buffered response; `closableResponse` adds the close event the abort test needs. */
type FakeResponse = SidebarHttpResponse & { status: number; headers: Record<string, string>; body: string }

function fakeResponse(): FakeResponse {
  const res = {
    statusCode: 0,
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) { res.status = status; res.headers = headers ?? {} },
    write(chunk: string | Uint8Array) { res.body += text(chunk); return true },
    end(chunk?: string | Uint8Array) { if (chunk !== undefined) res.body += text(chunk) },
    destroy() {},
  }
  return res
}

function closableResponse(): FakeResponse & { close(): void } {
  const res = fakeResponse()
  let listener: (() => void) | undefined
  res.once = (event, callback) => { if (event === 'close') listener = callback; return res }
  res.off = () => { listener = undefined; return res }
  return Object.assign(res, { close: () => listener?.() })
}

const routeFor = (clues: CluesService): SidebarWebRoute => createClueAgentReadRoute({
  clues,
  getWebServer: () => ({ port: PORT, getOrigin: () => ORIGIN }),
  getWorkspaceRegistry: () => ({
    get: id => (id === 'ws-1' || id === 'ws-2' ? { id } : undefined),
    list: () => [{ id: 'ws-1' }, { id: 'ws-2' }],
  }),
})

async function call(request: FakeRequest, target: SidebarWebRoute = route): Promise<FakeResponse> {
  const response = fakeResponse()
  await target.handler(request, response)
  return response
}

const json = (response: FakeResponse): Record<string, unknown> => JSON.parse(response.body) as Record<string, unknown>

async function addClue(sourceId: string, locator = 'a', title = 'A', workspaceId = 'ws-1'): Promise<string> {
  const { clue } = await service.ensure({ workspaceId, sourceId, typeId: `${sourceId}.text`, locator: { id: locator }, title })
  return clue.id
}

const putSnapshot = (clueId: string, body: string, extra: Partial<ClueSnapshotInput> = {}) =>
  service.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { text: body }, text: body, fetchedAt: NOW, ...extra })

const wireBody = (reference: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ workspaceId: 'ws-1', reference, sessionId: 's', ...extra })
const clueBody = (id: string, extra: Record<string, unknown> = {}): string => wireBody(`[[dsh-clue:${id}]]`, extra)

let service: CluesService
let route: SidebarWebRoute
let clueId: string

beforeEach(async () => {
  service = makeService()
  route = routeFor(service)
  service.registerSource(source('test.alpha'))
  clueId = await addClue('test.alpha')
})

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
  it.each([
    ['the admitted cookie-less local POST', {}],
    ['the literal localhost Host spelling', { headers: { host: 'localhost:3080' } }],
    ['an IPv6 loopback peer and bracketed Host', { headers: { host: '[::1]:3080' }, remoteAddress: '::1' }],
    ['a media-type parameter and case variation', { headers: { 'content-type': 'Application/JSON; Charset=UTF-8' } }],
  ] as Array<[string, RequestInput]>)('accepts %s', async (_label, overrides) => {
    const response = await call(post({ ...overrides, body: clueBody(clueId) }))
    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({ ok: true, value: { status: 'ok', kind: 'clue', id: clueId, text: 'live:a', freshness: 'live' } })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  const refusal = (label: string, input: RequestInput, status = 403): [string, RequestInput, number] => [label, input, status]
  const hostRefusals = (hosts: readonly string[]) => hosts.map(host => refusal(`Host ${host}`, { headers: { host } }))
  const headerRefusals = (headers: readonly Record<string, string>[]) => headers.map(header => refusal(`${Object.keys(header)[0]} header`, { headers: header }))
  const refused: Array<[string, RequestInput, number]> = [
    refusal('a non-loopback peer', { remoteAddress: '10.1.2.3' }),
    refusal('a different local port', { localPort: 9999 }),
    ...hostRefusals(['evil.example:3080', '0.0.0.0:3080', '127.0.0.1:9999', 'localhost:9999', 'localhost', '127.0.0.1']),
    ...hostRefusals(['127.0.0.1:+3080', '127.0.0.1:3080.0', '127.0.0.1:0', '127.0.0.1:65536']),
    refusal('an array/duplicate Host', { headers: { host: ['127.0.0.1:3080', 'evil.example:3080'] } }),
    ...headerRefusals([
      { origin: ORIGIN }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'empty' },
      { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-host': '127.0.0.1:3080' }, { 'x-forwarded-proto': 'http' },
    ]),
    ...['text/plain', 'application/x-www-form-urlencoded', 'application/json-patch+json'].map(contentType => refusal(`content type ${contentType}`, { headers: { 'content-type': contentType } }, 415)),
    refusal('a missing content type', { headers: { 'content-type': undefined } }, 415),
    ...['GET', 'OPTIONS', 'HEAD', 'PUT'].map(method => refusal(`${method} method`, { method }, 405)),
    ...[`http://127.0.0.1:3080${CLUE_AGENT_READ_ROUTE_PATH}`, `//evil.example${CLUE_AGENT_READ_ROUTE_PATH}`, '\\sidebar\\agent\\clues\\read'].map(url => refusal(`URL ${url}`, { url })),
    ...['?workspaceId=ws-1', '?', '#fragment'].map(suffix => refusal(`query/fragment ${suffix}`, { url: `${CLUE_AGENT_READ_ROUTE_PATH}${suffix}` })),
  ]
  it.each(refused)('refuses %s before reading the body', async (_label, input, status) => {
    const request = post(input)
    const response = await call(request)
    expect(response.status).toBe(status)
    expect(request.bodyReads).toBe(0)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-methods']).toBeUndefined()
  })
})

describe('body contract', () => {
  it.each([
    ['not json', 'not json'], ['an empty object', '{}'],
    ['a missing workspaceId', wireBody('[[dsh-clue:a]]', { workspaceId: undefined })], ['an empty workspaceId', wireBody('[[dsh-clue:a]]', { workspaceId: '' })],
    ['a missing reference', JSON.stringify({ workspaceId: 'ws-1', sessionId: 's' })], ['a missing sessionId', JSON.stringify({ workspaceId: 'ws-1', reference: '[[dsh-clue:a]]' })],
    ['a negative offset', wireBody('[[dsh-clue:a]]', { offset: -1 })], ['a fractional offset', wireBody('[[dsh-clue:a]]', { offset: 1.5 })],
    ['an unsafe offset', wireBody('[[dsh-clue:a]]', { offset: Number.MAX_SAFE_INTEGER + 1 })], ['a non-string workspaceId', wireBody('[[dsh-clue:a]]', { workspaceId: 42 })],
    ['embedded reference text', wireBody('look [[dsh-clue:a]]')], ['two reference tokens', wireBody('[[dsh-clue:a]] [[dsh-clue:b]]')],
    ['an over-bracketed token', wireBody('[[[dsh-clue:a]]]')], ['an empty token id', wireBody('[[dsh-clue:]]')],
  ] as Array<[string, string]>)('refuses %s as a bad request', async (_label, body) => {
    expect((await call(post({ body }))).status).toBe(400)
  })

  it('refuses an unregistered workspace id', async () => {
    expect((await call(post({ body: wireBody('[[dsh-clue:a]]', { workspaceId: 'ws-other' }) }))).status).toBe(403)
  })

  it.each([
    { method: 'clues.saveEdit' }, { saveEdit: { format: 'text/plain' } },
    { sourceId: 'test.alpha' }, { source: { id: 'x' } },
    { locator: { id: 'x' } }, { typeId: 'test.alpha.text' },
    { kind: 'clue' }, { id: 'x' },
    { workspace: '/tmp' }, { snapshotId: 'x' },
    { includeContent: true },
  ])('refuses the out-of-protocol field %s', async extra => {
    const response = await call(post({ body: clueBody(clueId, extra) }))
    expect(response.status).toBe(400)
    expect(json(response)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('validates snapshotOffset as a non-negative safe integer', async () => {
    for (const snapshotOffset of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
      expect((await call(post({ body: clueBody(clueId, { snapshotOffset }) }))).status, String(snapshotOffset)).toBe(400)
    expect((await call(post({ body: clueBody(clueId, { snapshotOffset: 0 }) }))).status).toBe(200)
  })

  it('bounds the body at the shared 1 MiB default', async () => {
    const response = await call(post({ body: wireBody('[[dsh-clue:a]]', { sessionId: 'x'.repeat((1 << 20) + 32) }) }))
    expect(response.status).toBe(413)
    expect(json(response)).toMatchObject({ ok: false, error: { code: 'too-large', message: 'request body too large' } })
  })
})

describe('reader semantics through the route', () => {
  it('propagates caller=agent and the body session id, and never falls back to a snapshot', async () => {
    const seen: Array<{ caller: string; sessionId?: string }> = []
    service.registerSource(source('test.session', async (_input, context) => {
      seen.push({ caller: context.caller, ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }) })
      return { format: 'text/plain', data: {}, text: 'ok', fetchedAt: NOW }
    }))
    const sessionClue = await addClue('test.session')
    expect((await call(post({ body: clueBody(sessionClue, { sessionId: 'session-from-prompt' }) }))).status).toBe(200)
    expect(seen).toEqual([{ caller: 'agent', sessionId: 'session-from-prompt' }])

    service.registerSource(source('test.fail', async () => {
      throw new Error('SECRET=host-internals')
    }))
    const failClue = await addClue('test.fail', 'x', 'Failing')
    const snapshot = await putSnapshot(failClue, 'old body', { fetchedAt: '2026-02-02T00:00:00.000Z', integrity: 'verified' })
    const response = await call(post({ body: clueBody(failClue) }))
    expect(response.status).toBe(200)
    const errorBody = json(response)
    expect(errorBody).toMatchObject({ ok: true, value: { status: 'error', kind: 'clue', error: { category: 'failed' }, snapshotOffset: 0, snapshotCount: 1 } })
    expect((errorBody.value as { snapshots: unknown[] }).snapshots).toEqual([expect.objectContaining({ snapshotId: snapshot.snapshotId, clueId: failClue })])
    for (const secret of ['SECRET', 'host-internals', 'old body']) expect(response.body).not.toContain(secret)

    const historical = await call(post({ body: wireBody(`[[dsh-clue-snapshot:${snapshot.snapshotId}]]`) }))
    expect(json(historical)).toMatchObject({ ok: true, value: { status: 'ok', kind: 'snapshot', text: 'old body', fetchedAt: '2026-02-02T00:00:00.000Z', integrity: 'verified' } })
  })

  it('pages snapshot metadata and reports an unavailable index explicitly', async () => {
    service.registerSource(source('test.fail', async () => {
      throw new Error('live unavailable')
    }))
    const failClue = await addClue('test.fail', 'x', 'Many snapshots')
    for (let index = 0; index < 21; index += 1) await putSnapshot(failClue, `snapshot ${index}`)
    const first = json(await call(post({ body: clueBody(failClue) })))
    expect(first).toMatchObject({ ok: true, value: { status: 'error', snapshotOffset: 0, snapshotCount: 21, snapshotsLimited: true, snapshotNextOffset: 20 } })
    expect((first.value as { snapshots: unknown[] }).snapshots).toHaveLength(20)
    expect(JSON.stringify(first)).not.toContain('snapshot 0')

    const second = json(await call(post({ body: clueBody(failClue, { snapshotOffset: 20 }) })))
    expect(second).toMatchObject({ ok: true, value: { status: 'error', snapshotOffset: 20, snapshotCount: 21 } })
    expect((second.value as { snapshots: unknown[] }).snapshots).toHaveLength(1)

    service.listSnapshots = async () => { throw new Error('snapshot index offline') }
    const unavailable = json(await call(post({ body: clueBody(clueId) }))).value as Record<string, unknown>
    expect(unavailable).toMatchObject({ status: 'ok', snapshotOffset: 0, snapshotsUnavailable: { category: 'failed', message: 'the clue operation failed' } })
    expect(unavailable.snapshotCount).toBeUndefined()
    expect(unavailable.snapshots).toBeUndefined()
  })

  it('returns pack member metadata only, in bounded pages', async () => {
    const members: string[] = []
    for (let index = 0; index < MAX_AGENT_READ_PACK_MEMBERS + 1; index += 1) members.push(await addClue('test.alpha', `m${index}`, `M${index}`))
    const pack = await service.createPack({ workspaceId: 'ws-1', name: 'P', members })
    const snapshot = await putSnapshot(members[0]!, 'member body')
    const response = await call(post({ body: wireBody(`[[dsh-cluepack:${pack.pack.id}]]`) }))
    const value = json(response).value as { members: Array<{ snapshotCount: number; snapshots: Array<{ snapshotId: string }> }> }
    expect(json(response)).toMatchObject({ ok: true, value: {
      status: 'ok', kind: 'pack', memberCount: MAX_AGENT_READ_PACK_MEMBERS + 1,
      limited: true, nextOffset: MAX_AGENT_READ_PACK_MEMBERS, snapshotOffset: 0,
    } })
    expect(value.members).toHaveLength(MAX_AGENT_READ_PACK_MEMBERS)
    expect(value.members[0]).toMatchObject({ snapshotCount: 1, snapshots: [expect.objectContaining({ snapshotId: snapshot.snapshotId })] })
    expect(response.body).not.toContain('member body')
  })

  it('finds a stable reference in another registered workspace', async () => {
    const foreign = await addClue('test.alpha', 'foreign', 'Foreign', 'ws-2')
    expect(json(await call(post({ body: clueBody(foreign) })))).toMatchObject({ ok: true, value: { status: 'ok', workspaceId: 'ws-2', text: 'live:foreign' } })
  })

  it.each(['response close', 'request abort'])('aborts an active source read on %s', async event => {
    let notifyReadStarted!: (signal: AbortSignal) => void
    const readStarted = new Promise<AbortSignal>(resolve => { notifyReadStarted = resolve })
    service.registerSource(source('test.slow', (_input, context) => new Promise((_resolve, reject) => {
      const signal = context.signal!
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      notifyReadStarted(signal)
    })))
    const request = post({ body: clueBody(await addClue('test.slow', 'slow', 'Slow')) })
    const response = closableResponse()
    const handled = route.handler(request, response)
    const signal = await readStarted
    if (event === 'response close') response.close()
    else request.emitAborted()
    await handled
    expect(signal.aborted).toBe(true)
    expect(response.status).toBe(0)
    expect(response.body).toBe('')
  })
})

/** Issue one real loopback POST without cookies through Node's HTTP client. */
function realRequest(port: number, body: unknown): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port, path: CLUE_AGENT_READ_ROUTE_PATH, method: 'POST',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('real loopback HTTP (cookie-less)', () => {
  it('answers a real local POST without a cookie challenge or CORS surface', async () => {
    const realClue = await addClue('test.alpha', 'real', 'Real')
    const holder: { port: number } = { port: 0 }
    const realRoute = createClueAgentReadRoute({
      clues: service,
      getWebServer: () => ({ port: holder.port, getOrigin: () => `http://127.0.0.1:${holder.port}` }),
      getWorkspaceRegistry: () => ({ get: id => (id === 'ws-1' ? { id } : undefined), list: () => [{ id: 'ws-1' }] }),
    })
    const server = createServer((req, res) => { void realRoute.handler(req as unknown as SidebarHttpRequest, res as unknown as SidebarHttpResponse) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    holder.port = (server.address() as AddressInfo).port
    const response = await realRequest(holder.port, { workspaceId: 'ws-1', reference: `[[dsh-clue:${realClue}]]`, sessionId: 'session-real' })
    expect(response.status, response.body).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, value: { status: 'ok', text: 'live:real' } })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})

// ── UI19 discussion follow-up through the fixed route ─────────────────────

/** Install the parent-owned comments reader on the fixture service. */
function stubCommentsList(
  list: (params: ClueCommentsListParams, options?: ClueCallOptions) => Promise<ClueDiscussionPage>,
): void {
  ;(service as unknown as { commentsList: typeof list }).commentsList = list
}

/** One valid discussion page used by the route projections. */
function discussionPage(): ClueDiscussionPage {
  return {
    status: 'ok',
    items: [{
      id: 'comment-1', kind: 'comment', format: 'text/markdown', body: 'First page',
      createdAt: NOW, replyCount: 1, nextRepliesCursor: 'replies-1',
    }],
    fetchedAt: NOW, nextCursor: 'page-2', total: 2, complete: false, coverage: 'document',
  }
}

describe('discussion follow-up through the fixed route', () => {
  it('forwards commentsCursor/parentId without a body read, and projects a live read discussion', async () => {
    let reads = 0
    service.registerSource(source('test.discussion', async () => {
      reads += 1
      return { format: 'text/plain', data: {}, text: 'live body', fetchedAt: NOW }
    }))
    const discussionClue = await addClue('test.discussion', 'a', 'Discussion')
    const calls: Array<{ params: ClueCommentsListParams; options?: ClueCallOptions }> = []
    stubCommentsList(async (params, options) => {
      calls.push({ params, ...(options === undefined ? {} : { options }) })
      return discussionPage()
    })

    const response = await call(post({
      body: clueBody(discussionClue, { sessionId: 'session-1', commentsCursor: 'page-2', parentId: 'comment-9' }),
    }))
    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({
      ok: true,
      value: { status: 'ok', kind: 'clue', id: discussionClue, workspaceId: 'ws-1', title: 'Discussion', discussion: discussionPage() },
    })
    expect((json(response).value as { text?: string }).text).toBeUndefined()
    expect(reads).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toMatchObject({ workspaceId: 'ws-1', clueId: discussionClue, cursor: 'page-2', parentId: 'comment-9' })
    expect(calls[0]!.options).toMatchObject({ caller: 'agent', sessionId: 'session-1' })

    const page = discussionPage()
    service.registerSource(source('test.read-discussion', async () => ({
      format: 'text/plain', data: {}, text: 'live body', fetchedAt: NOW, discussion: page,
    })))
    const readClue = await addClue('test.read-discussion', 'a', 'Read discussion')
    expect(json(await call(post({ body: clueBody(readClue, { sessionId: 'session-1' }) })))).toMatchObject({
      ok: true,
      value: { status: 'ok', text: 'live body', discussion: page },
    })
  })

  it.each([
    ['an empty commentsCursor', { commentsCursor: '' }],
    ['a blank commentsCursor', { commentsCursor: '   ' }],
    ['a numeric commentsCursor', { commentsCursor: 1 }],
    ['a null commentsCursor', { commentsCursor: null }],
    ['an empty parentId', { parentId: '' }],
    ['a numeric parentId', { parentId: 42 }],
    ['an object parentId', { parentId: {} }],
  ] as Array<[string, Record<string, unknown>]>)('rejects %s as a bad request', async (_label, fields) => {
    const response = await call(post({ body: clueBody(clueId, { sessionId: 'session-1', ...fields }) }))
    expect(response.status).toBe(400)
    expect(json(response)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('keeps a comments-page failure safe on the wire', async () => {
    stubCommentsList(async () => {
      throw new Error('SECRET=super-secret TOKEN=abc')
    })
    const response = await call(post({ body: clueBody(clueId, { sessionId: 'session-1', commentsCursor: 'page-2' }) }))
    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({ ok: true, value: { status: 'error', kind: 'clue', error: { category: 'failed' } } })
    expect(response.body).not.toContain('super-secret')
    expect(response.body).not.toContain('SECRET=')
    expect(response.body).not.toContain('TOKEN=')
  })
})
