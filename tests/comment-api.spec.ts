/**
 * The comment doors (Tracy, 29/09/2026; stage 6 contract `tasks/evidence/comment-people/contract.md`
 * H1): what the Browser tab sends to `/api/sites/:key/comments` and `/requests`, and how it reads the
 * answers back into its store. `fetch` is a parameter; every call is recorded and answered here.
 */
import { describe, expect, it } from 'vitest'
import { commentFromServer, createBodyOf, createCommentApi, type ServerComment } from '../src/client/comment-api.ts'
import type { Comment } from '../src/client/comment-store.ts'
import { NO_ATTACHMENTS, formatBytes } from '../src/client/comment-attachments.ts'

type Call = { url: string; method: string; body: unknown; credentials?: string }

function fakeFetch(answer: (call: Call) => { status: number; body: unknown }): { calls: Call[]; fetchImpl: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = []
  return {
    calls,
    fetchImpl: async (input, init) => {
      const call: Call = { url: input, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init?.credentials }
      calls.push(call)
      const out = answer(call)
      return new Response(JSON.stringify(out.body), { status: out.status })
    },
  }
}

const ROW: ServerComment = {
  id: '6f1c0f3e-0000-4000-8000-000000000001',
  n: 7,
  url: 'http://northgate.tracy.test/',
  element: { url: 'http://northgate.tracy.test/', selector: 'main > h1', label: '"Welcome"', text: 'Welcome', rect: { x: 1, y: 2, width: 3, height: 4 }, marks: [], tag: 'h1', image: null, domPath: 'main > h1', levels: [], level: 0 },
  locate: null,
  text: 'Say hello',
  status: 'pending',
  replyTo: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:01.000Z',
  resolvedAt: null,
  resolvedBy: null,
  deletedAt: null,
  author: { accountId: 'a1', email: 'lee@example.com', name: 'Lee', initial: 'L' },
  can: { edit: true, delete: true },
  sentToTracy: false,
}

describe('the doors: method, path and body per action', () => {
  it('list asks GET /api/sites/<key>/comments, with ?since= when given, and reads siteChangedAt', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { comments: [ROW], n_next: 8, siteChangedAt: '2026-09-29T10:03:00.000Z' } }))
    const api = createCommentApi({ siteKey: 'north gate', fetchImpl: f.fetchImpl })
    const all = await api.list()
    const since = await api.list('2026-09-29T10:00:01.000Z')
    expect(f.calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'GET /api/sites/north%20gate/comments',
      'GET /api/sites/north%20gate/comments?since=2026-09-29T10%3A00%3A01.000Z',
    ])
    expect(f.calls[0]!.credentials).toBe('same-origin')
    expect(all).toEqual({ ok: true, value: { comments: [ROW], nNext: 8, siteChangedAt: '2026-09-29T10:03:00.000Z', attachments: NO_ATTACHMENTS, maxChars: 4000 } })
    expect(since.ok).toBe(true)
  })

  it('a list without siteChangedAt (or with no date in it) says null', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { comments: [], n_next: 1, siteChangedAt: 'soon' } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect(await api.list()).toEqual({ ok: true, value: { comments: [], nNext: 1, siteChangedAt: null, attachments: NO_ATTACHMENTS, maxChars: 4000 } })
  })

  it('create, patch {text}, resolve, delete and clear {url} hit their doors — no reopen, no status', async () => {
    const f = fakeFetch(call => ({ status: call.url.endsWith('/clear') ? 200 : call.method === 'POST' && call.url.endsWith('/comments') ? 201 : 200, body: call.url.endsWith('/clear') ? { cleared: [ROW.id] } : { comment: ROW } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    const created = await api.create({ url: ROW.url, element: null, locate: null, text: 'Hi', replyTo: 'p1' })
    await api.patch(ROW.id, { text: 'Hello' })
    await api.resolve(ROW.id)
    await api.remove(ROW.id)
    const cleared = await api.clear(ROW.url)
    const base = '/api/sites/northgate/comments'
    expect(f.calls.map(c => [c.method, c.url, c.body])).toEqual([
      ['POST', base, { url: ROW.url, element: null, locate: null, text: 'Hi', replyTo: 'p1' }],
      ['PATCH', `${base}/${ROW.id}`, { text: 'Hello' }],
      ['POST', `${base}/${ROW.id}/resolve`, undefined],
      ['DELETE', `${base}/${ROW.id}`, undefined],
      ['POST', `${base}/clear`, { url: ROW.url }],
    ])
    expect(created).toEqual({ ok: true, value: { comment: ROW, parent: null } })
    expect(cleared).toEqual({ ok: true, value: [ROW.id] })
    expect('reopen' in api).toBe(false)
  })

  it('requests POSTs {sessionId, requestId, items} to /api/sites/<key>/requests and reads each item\'s number', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { requests: [{ id: 'q1', n: 41 }, { id: 'q2', n: 42 }] } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    const body = { sessionId: 's1', requestId: 'r1', items: [{ url: ROW.url, element: null, text: 'Make it orange' }, { url: ROW.url, element: null, text: 'Say hello', commentId: ROW.id }] }
    expect(await api.requests(body)).toEqual({ ok: true, value: [{ id: 'q1', n: 41 }, { id: 'q2', n: 42 }] })
    expect(f.calls.map(c => [c.method, c.url, c.body])).toEqual([['POST', '/api/sites/northgate/requests', body]])
  })

  it('requests answered with fewer numbers than items is BAD_ANSWER: nothing may go without its number', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { requests: [{ id: 'q1', n: 41 }] } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect(await api.requests({ sessionId: 's1', requestId: 'r1', items: [{ url: 'u', element: null, text: 'a' }, { url: 'u', element: null, text: 'b' }] })).toMatchObject({ ok: false, code: 'BAD_ANSWER' })
  })

  it('clearThreads (Delete all of what the Comments tab shows, UI fine-tune 30/09) POSTs {threads} with keepalive', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { cleared: ['a', 'b'] } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect(await api.clearThreads(['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] })
    expect(f.calls.map(c => [c.method, c.url, c.body])).toEqual([['POST', '/api/sites/northgate/comments/clear', { threads: ['a', 'b'] }]])
  })

  it('Clear and Delete go out with keepalive, so one sent as the page hides or unloads (Undo window) still reaches the door', async () => {
    const inits: Array<RequestInit | undefined> = []
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: async (_input, init) => { inits.push(init); return new Response(JSON.stringify({ cleared: [ROW.id] }), { status: 200 }) } })
    await api.clear(ROW.url)
    await api.remove(ROW.id)
    await api.resolve(ROW.id)
    await api.clearThreads([ROW.id])
    expect(inits.map(i => i?.keepalive === true)).toEqual([true, true, false, true])
  })

  it('a reply\'s create answer carries its parent as it now stands (a resolved parent reopened)', async () => {
    const parent = { ...ROW, id: 'p1', n: 1 }
    const f = fakeFetch(() => ({ status: 201, body: { comment: { ...ROW, replyTo: 'p1' }, parent } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect(await api.create({ url: ROW.url, element: null, locate: null, text: 'Hi', replyTo: 'p1' })).toEqual({ ok: true, value: { comment: { ...ROW, replyTo: 'p1' }, parent } })
  })

  it('a refusal carries the door\'s code and next; a network error is NETWORK with no next', async () => {
    const f = fakeFetch(() => ({ status: 409, body: { code: 'COMMENT_LIMIT', next: 'Resolve some first.' } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect(await api.create({ url: 'u', element: null, locate: null, text: 't' })).toEqual({ ok: false, status: 409, code: 'COMMENT_LIMIT', next: 'Resolve some first.' })
    const broken = createCommentApi({ siteKey: 'northgate', fetchImpl: async () => { throw new Error('offline') } })
    expect(await broken.list()).toEqual({ ok: false, status: 0, code: 'NETWORK', next: null })
  })

  it('the list names its longest text at its root (limits.maxChars); absent or nonsense = 4000, the server limit (round 5, TH-2)', async () => {
    let limits: unknown = { maxChars: 3000 }
    const f = fakeFetch(() => ({ status: 200, body: { comments: [], n_next: 1, limits } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect((await api.list()).ok && (await api.list() as { value: { maxChars: number } }).value.maxChars).toBe(3000)
    for (limits of [undefined, null, { maxChars: 0 }, { maxChars: '4000' }, { maxChars: 1.5 }]) {
      const answer = await api.list()
      expect(answer.ok && answer.value.maxChars, JSON.stringify(limits)).toBe(4000)
    }
  })

  it('a too-long refusal carries the server\'s limit and the field it names, for the words a person reads', async () => {
    const f = fakeFetch(() => ({ status: 400, body: { code: 'COMMENT_TOO_LONG', next: 'Shorten it.', field: 'text', maxChars: 4000, length: 5009 } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect(await api.create({ url: 'u', element: null, locate: null, text: 't' })).toEqual({ ok: false, status: 400, code: 'COMMENT_TOO_LONG', next: 'Shorten it.', field: 'text', maxChars: 4000 })
  })

  it('an answer of the wrong shape is refused as BAD_ANSWER, never trusted', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { nope: true } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    expect(await api.list()).toMatchObject({ ok: false, code: 'BAD_ANSWER' })
    expect(await api.resolve('x')).toMatchObject({ ok: false, code: 'BAD_ANSWER' })
  })
})

describe('a server row read into the store', () => {
  it('pending reads as open; times become ms; the author, can and replyTo pass through', () => {
    const c = commentFromServer({ ...ROW, replyTo: 'p1' })!
    expect(c).toMatchObject({ id: ROW.id, n: 7, status: 'open', text: 'Say hello', createdAt: Date.parse('2026-09-29T10:00:00.000Z'), updatedAt: '2026-09-29T10:00:01.000Z', replyTo: 'p1', author: ROW.author, can: { edit: true, delete: true } })
    expect(c.element).toMatchObject({ selector: 'main > h1', text: 'Welcome', tag: 'h1', domPath: 'main > h1' })
    expect(c.sentToTracy).toBeUndefined()
  })

  it('an older row\'s stage-5 status (sent, done, asked…) reads as open, with nothing of Tracy on it', () => {
    for (const status of ['sent', 'working', 'done', 'failed', 'asked']) {
      const c = commentFromServer({ ...ROW, status, question: 'Which page?', answer: 'updated: x' } as unknown as ServerComment)!
      expect(c.status).toBe('open')
      expect(c).not.toHaveProperty('question')
      expect(c).not.toHaveProperty('answer')
    }
  })

  it('resolved keeps its resolve time and who; sentToTracy passes through; an old can {resolve, edit} still reads', () => {
    const by = { accountId: 'a2', email: 'mai@example.com', initial: 'M' }
    expect(commentFromServer({ ...ROW, status: 'resolved', resolvedAt: '2026-09-29T11:00:00.000Z', resolvedBy: by })).toMatchObject({ status: 'resolved', resolvedAt: Date.parse('2026-09-29T11:00:00.000Z'), resolvedBy: by })
    expect(commentFromServer({ ...ROW, sentToTracy: true })?.sentToTracy).toBe(true)
    expect(commentFromServer({ ...ROW, can: { resolve: true, edit: false } } as unknown as ServerComment)?.can).toEqual({ edit: false, delete: false })
  })

  it('earlier sends, when the server lists them on a row, are kept (who and when); malformed ones are skipped', () => {
    const sends = [{ author: ROW.author, at: '2026-09-29T10:05:00.000Z' }, { author: null, at: '2026-09-29T10:06:00.000Z' }, { author: ROW.author, at: 'soon' }]
    expect(commentFromServer({ ...ROW, sends } as unknown as ServerComment)?.sends).toEqual([{ author: ROW.author, at: Date.parse('2026-09-29T10:05:00.000Z') }])
    expect(commentFromServer(ROW)).not.toHaveProperty('sends')
  })

  it('a general comment (element null) stays general; a malformed row is null', () => {
    expect(commentFromServer({ ...ROW, element: null })?.element).toBeNull()
    expect(commentFromServer({ ...ROW, n: 0 })).toBeNull()
    expect(commentFromServer({ ...ROW, text: '  ' })).toBeNull()
    expect(commentFromServer(null)).toBeNull()
  })
})

describe('round 5: tombstones (server TH-4)', () => {
  it('a deleted row marked deletedRoot reads as its placeholder; deletedRoot false is gone; an older row without the flag stays a placeholder', () => {
    const gone = { ...ROW, text: '', deletedAt: '2026-09-30T10:00:00.000Z', can: { edit: false, delete: false } }
    expect(commentFromServer({ ...gone, deletedRoot: true })).toMatchObject({ id: ROW.id, removed: true, text: '' })
    expect(commentFromServer({ ...gone, deletedRoot: false })).toBeNull()
    expect(commentFromServer(gone)).toMatchObject({ removed: true })
  })
})

describe('what a create sends', () => {
  it('the element plus what the page needs to track it again, the locate, the words and replyTo', () => {
    const c: Comment = { id: 'l1', n: 1, url: 'http://northgate.tracy.test/', element: { text: 'Welcome', tag: 'h1', image: null, domPath: 'main > h1', selector: 'main > h1', rect: { x: 1, y: 2, width: 3, height: 4 }, marks: ['m'], levels: [], level: 0 }, locate: { status: 'resolved' }, text: ' Say hello ', status: 'open', createdAt: 1, replyTo: 'p1' }
    expect(createBodyOf(c)).toEqual({
      url: c.url,
      element: { url: c.url, selector: 'main > h1', label: '"Welcome"', text: 'Welcome', rect: { x: 1, y: 2, width: 3, height: 4 }, marks: ['m'], tag: 'h1', image: null, domPath: 'main > h1', levels: [], level: 0 },
      locate: { status: 'resolved' },
      text: 'Say hello',
      replyTo: 'p1',
    })
    expect(createBodyOf({ ...c, element: null, replyTo: undefined })).toEqual({ url: c.url, element: null, locate: { status: 'resolved' }, text: 'Say hello' })
  })
})

describe('round 8 (acceptance v5 JS-v5-new-3): an element with no words keeps its name through a save', () => {
  it('the create carries the page\'s name for a canvas, an embed or an icon button, and the row reads it back', () => {
    const element = { text: '', name: 'canvas near "E2E fixture: DOM changes"', tag: 'canvas', image: null, domPath: 'main > canvas', selector: 'main > canvas', rect: { x: 1, y: 2, width: 3, height: 4 }, marks: [], levels: [], level: 0 }
    const c: Comment = { id: 'l1', n: 1, url: 'http://northgate.tracy.test/', element, locate: null, text: 'Bigger', status: 'open', createdAt: 1 }
    const body = createBodyOf(c)
    expect(body.element).toMatchObject({ name: 'canvas near "E2E fixture: DOM changes"', label: 'canvas near "E2E fixture: DOM changes"' })
    expect(commentFromServer({ ...ROW, element: body.element })?.element?.name).toBe('canvas near "E2E fixture: DOM changes"')
    // An element with words sends no name (it has none).
    expect(createBodyOf({ ...c, element: { ...element, text: 'Welcome', name: undefined } }).element).not.toHaveProperty('name')
  })
})

describe('files kept with a comment (attachments contract §C/§D)', () => {
  const SHOT = { id: 'att-1', name: 'shot.png', size: 3, type: 'image/png', url: '/api/sites/northgate/comments/attachments/att-1' }

  it('the list names at its root whether the server keeps files, and its limits', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { comments: [], n_next: 1, attachments: { enabled: true, maxBytes: 20_971_520, maxFiles: 20 } } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    const list = await api.list()
    expect(list.ok && list.value.attachments).toEqual({ enabled: true, maxBytes: 20_971_520, maxFiles: 20 })
  })

  it('upload is multipart with one part `file` (the browser writes the content type), and reads {attachment}', async () => {
    const seen: RequestInit[] = []
    const api = createCommentApi({
      siteKey: 'northgate',
      fetchImpl: async (input, init) => {
        seen.push({ ...init, method: `${init?.method ?? 'GET'} ${input}` })
        return new Response(JSON.stringify({ attachment: SHOT }), { status: 201 })
      },
    })
    const file = new File(['PNG'], 'shot.png', { type: 'image/png' })
    expect(await api.upload(file)).toEqual({ ok: true, value: SHOT })
    expect(seen[0]!.method).toBe('POST /api/sites/northgate/comments/attachments')
    expect(seen[0]!.headers).toEqual({ accept: 'application/json' })
    expect(((seen[0]!.body as FormData).get('file') as File).name).toBe('shot.png')
    expect(seen[0]!.credentials).toBe('same-origin')
  })

  it('an upload refused says the door\'s code and sentence', async () => {
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: async () => new Response(JSON.stringify({ code: 'ATTACHMENT_TOO_LARGE', next: 'Pick a smaller file.', limit: 1 }), { status: 413 }) })
    expect(await api.upload(new File(['x'], 'x.bin'))).toEqual({ ok: false, status: 413, code: 'ATTACHMENT_TOO_LARGE', next: 'Pick a smaller file.' })
  })

  it('fetchFile reads a kept file back as a File with its name and type; a refused read is null', async () => {
    const urls: string[] = []
    let status = 200
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: async (input) => { urls.push(input); return new Response(status === 200 ? new Blob(['PNG']) : null, { status }) } })
    const file = await api.fetchFile(SHOT)
    expect([file?.name, file?.type, file?.size]).toEqual(['shot.png', 'image/png', 3])
    status = 404
    expect(await api.fetchFile(SHOT)).toBeNull()
    // Only this site's own door is read, whatever address a row names.
    status = 200
    await api.fetchFile({ ...SHOT, url: 'https://elsewhere.example/steal' })
    expect(urls).toEqual([SHOT.url, SHOT.url, SHOT.url])
  })

  it('PATCH can carry the whole new list of ids', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { comment: ROW } }))
    const api = createCommentApi({ siteKey: 'northgate', fetchImpl: f.fetchImpl })
    await api.patch(ROW.id, { attachments: [] })
    expect(f.calls[0]!.body).toEqual({ attachments: [] })
  })

  it('a row\'s attachments read onto the comment; a deleted row keeps none', () => {
    const c = commentFromServer({ ...ROW, attachments: [SHOT, { id: 'bad' }] })!
    expect(c.attachments).toEqual([SHOT])
    expect(commentFromServer({ ...ROW, attachments: [] })!).not.toHaveProperty('attachments')
    const gone = commentFromServer({ ...ROW, deletedAt: '2026-09-29T10:00:00.000Z', text: '', attachments: [SHOT] })!
    expect(gone).not.toHaveProperty('attachments')
  })

  it('a create names the uploaded ids only when there are some', () => {
    const c = commentFromServer(ROW)!
    expect(createBodyOf(c, ['att-1', 'att-2']).attachments).toEqual(['att-1', 'att-2'])
    expect(createBodyOf(c)).not.toHaveProperty('attachments')
  })

  it('sizes read as people read them', () => {
    // 1000-based, as tracy-chat-input's `formatSize`: one file reads the same in both places.
    expect([formatBytes(820), formatBytes(14_000), formatBytes(1_300_000), formatBytes(20 * 1024 * 1024)]).toEqual(['820 B', '14 KB', '1.3 MB', '21 MB'])
  })
})
