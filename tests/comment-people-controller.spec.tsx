// @vitest-environment jsdom
/**
 * Comments are people to people; "Send to Tracy" is a chat message (Tracy, 29/09/2026; TCH
 * `tasks/todo-comment-people.md` rules 1–12, contract `tasks/evidence/comment-people/contract.md`
 * H1/H2). `useCommentMode` is given the real door client (`createCommentApi`) over a `fetch` that
 * plays tracy-web's comment and request doors in memory, so every assertion reads what went over the
 * wire, what the chat was handed and what the tab shows afterwards.
 */
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE_UNDO_MS, DISCARD_AGAIN_MS, HIDE_LAPSE_MS, resetCommentModeMemo, useCommentMode, type CommentMode } from '../src/client/comment-controller.ts'
import { createCommentApi, type ServerComment } from '../src/client/comment-api.ts'
import { COMMENT_FAILED_EVENT, COMMENT_SEND_EVENT, COMMENT_SENT_EVENT, RECOVERY_WAIT_MS } from '../src/client/comment-model.ts'
import { COMMENT_ACT_EVENT, COMMENT_LIST_EVENT, type Comment, type CommentListDetail, type CommentSendDetailV3 } from '../src/client/comment-store.ts'
import type { BrowserMode } from '../src/client/browser-mode.ts'
import { PREVIEW_CHANNEL, PREVIEW_VERSION, type PreviewPickTarget } from '../src/client/preview-protocol.generated.ts'

const SITE = 'http://northgate.tracy.test:8080'
const HOME = `${SITE}/`
const ABOUT = `${SITE}/about`
const BASE = '/api/sites/northgate/comments'
const REQUESTS = '/api/sites/northgate/requests'
const LEE = { accountId: 'a1', email: 'lee@example.com', name: 'Lee', initial: 'L' }
const MAI = { accountId: 'a2', email: 'mai@example.com', name: 'Mai', initial: 'M' }

const target = (selector: string, text: string): PreviewPickTarget => ({ text, tag: 'h2', image: null, domPath: `main > ${selector}`, selector, rect: { x: 100, y: 50, width: 200, height: 30 }, marks: [], levels: [], level: 0 })
const H1 = target('main > h1', 'Welcome')
const STAT = target('main > .stat', '13 subsidiaries')

// ── tracy-web's doors, in memory ──
type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let rows: ServerComment[]
let lastN: number
let clock: number
let refuseNext: { url: string; status: number; code: string; next: string } | null
let siteChangedAt: string | null
/** The list's `limits` (round 5, TH-2); null = an older server that does not send it. */
let listLimits: { maxChars: number } | null
/** When set, the next non-GET door waits for this before it answers (a slow network). */
let slowNext: Promise<void> | null
/** No network for writes: every non-GET door throws as `fetch` does offline (round 11, IN5-1). */
let offline: boolean
/** When set, `POST /apply` (content.locate) waits for this before it answers (a slow index, IN5-7). */
let slowLocate: Promise<void> | null
/** What `POST /apply` (content.locate) was asked, and what it answers. */
let applies: Array<{ action: string; params: Record<string, unknown> }>
let applyAnswer: unknown
/** The list's `attachments` field (§C); null = an older server that does not send it. */
let store: { enabled: boolean; maxBytes: number; maxFiles: number } | null
/** Uploads the doors hold (§C), by id, with their bytes. */
let uploads: Map<string, { attachment: Attachment; bytes: Blob }>
type Attachment = { id: string; name: string; size: number; type: string; url: string }
const stamp = (): string => new Date(1_790_000_000_000 + (clock += 1_000)).toISOString()

function serverRow(over: Partial<ServerComment>): ServerComment {
  lastN += 1
  const at = stamp()
  return { id: `srv-${String(lastN)}`, n: lastN, url: HOME, element: null, locate: null, text: 'Words', status: 'pending', replyTo: null, createdAt: at, updatedAt: at, resolvedAt: null, resolvedBy: null, deletedAt: null, author: LEE, can: { edit: true, delete: true }, sentToTracy: false, attachments: [], ...over }
}

function doors(url: string, init?: RequestInit): Response {
  const method = init?.method ?? 'GET'
  const form = init?.body instanceof FormData ? init.body : null
  const body = init?.body === undefined || form !== null ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
  calls.push({ method, url, body: form === null ? body : { file: (form.get('file') as File).name } })
  const answer = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })
  if (refuseNext !== null && method !== 'GET' && url.startsWith(refuseNext.url)) {
    const r = refuseNext
    refuseNext = null
    return answer({ code: r.code, next: r.next }, r.status)
  }
  const ATTACHMENTS = `${BASE}/attachments`
  if (method === 'POST' && url === ATTACHMENTS) {
    const file = form!.get('file') as File
    const id = `att-${String(uploads.size + 1)}`
    const attachment = { id, name: file.name, size: file.size, type: file.type === '' ? 'application/octet-stream' : file.type, url: `${ATTACHMENTS}/${id}` }
    uploads.set(id, { attachment, bytes: file })
    return answer({ attachment }, 201)
  }
  if (method === 'GET' && url.startsWith(`${ATTACHMENTS}/`)) {
    const held = uploads.get(url.slice(ATTACHMENTS.length + 1))
    if (held === undefined) return answer({ code: 'ATTACHMENT_NOT_FOUND', next: 'Gone.' }, 404)
    return new Response(held.bytes, { status: 200, headers: { 'content-type': held.attachment.type } })
  }
  const named = (ids: unknown): Attachment[] => (Array.isArray(ids) ? ids.map(id => uploads.get(String(id))!.attachment) : [])
  if (url === REQUESTS) {
    const items = body!.items as Array<{ commentId?: string }>
    for (const item of items) {
      const hit = rows.find(r => r.id === item.commentId)
      if (hit !== undefined) Object.assign(hit, { sentToTracy: true, updatedAt: stamp() })
    }
    return answer({ requests: items.map(() => { lastN += 1; return { id: `req-${String(lastN)}`, n: lastN } }) }, 201)
  }
  const [path, query] = url.split('?')
  const rest = path!.slice(BASE.length)
  if (method === 'GET') {
    const since = query === undefined ? null : new URLSearchParams(query).get('since')
    // G2 / TH-4: a deleted first message with a live reply stays in the full list as a tombstone.
    const tomb = (r: ServerComment): boolean => r.deletedAt !== null && r.replyTo === null && rows.some(x => x.replyTo === r.id && x.deletedAt === null)
    const list = (since === null ? rows.filter(r => r.deletedAt === null || tomb(r)) : rows.filter(r => (r.updatedAt ?? '') >= since)).map(r => (r.deletedAt === null ? r : { ...r, text: '' }))
    const root = store === null ? { comments: list, n_next: lastN + 1, siteChangedAt } : { comments: list, n_next: lastN + 1, siteChangedAt, attachments: store }
    return answer(listLimits === null ? root : { ...root, limits: listLimits })
  }
  if (method === 'POST' && rest === '') {
    const row = serverRow({ url: String(body!.url), element: body!.element as ServerComment['element'], locate: body!.locate as ServerComment['locate'], text: String(body!.text), replyTo: (body!.replyTo as string | undefined) ?? null, attachments: named(body!.attachments) })
    rows.push(row)
    const parent = row.replyTo === null ? undefined : rows.find(r => r.id === row.replyTo)
    if (parent?.status === 'resolved') Object.assign(parent, { status: 'pending', resolvedAt: null, resolvedBy: null, updatedAt: stamp() })
    return answer(parent === undefined ? { comment: row } : { comment: row, parent }, 201)
  }
  if (method === 'POST' && rest === '/clear') {
    // Rule 12 (Brian 23:20): every comment on that page, open and resolved, everyone's.
    // `{threads}` (UI fine-tune 30/09): exactly the named threads, any page, with their replies.
    const threads = body!.threads as string[] | undefined
    const cleared = rows.filter(r => r.deletedAt === null && (threads === undefined ? r.url === body!.url : threads.includes(r.id) || (r.replyTo !== null && threads.includes(r.replyTo)))).map(r => r.id)
    for (const r of rows) if (cleared.includes(r.id)) { r.deletedAt = stamp(); r.updatedAt = r.deletedAt }
    if (threads === undefined) return answer({ cleared })
    // INTH-1: every thread it can take goes; one already gone is named, never a refusal.
    const took = new Set(rows.filter(r => cleared.includes(r.id)).flatMap(r => [r.id, r.replyTo ?? '']))
    return answer({ cleared, deleted: threads.filter(id => took.has(id)), gone: threads.filter(id => !took.has(id)) })
  }
  const id = decodeURIComponent(rest.split('/')[1]!)
  const row = rows.find(r => r.id === id)
  if (row === undefined) return answer({ code: 'COMMENT_NOT_FOUND', next: 'Reload.' }, 404)
  if (method === 'PATCH') Object.assign(row, body, body!.attachments === undefined ? {} : { attachments: named(body!.attachments) }, { updatedAt: stamp() })
  if (rest.endsWith('/resolve')) Object.assign(row, { status: 'resolved', resolvedAt: stamp(), resolvedBy: LEE, updatedAt: stamp() })
  if (method === 'DELETE') Object.assign(row, { deletedAt: stamp(), updatedAt: stamp() })
  return answer({ comment: row })
}

const writes = (): Call[] => calls.filter(c => c.method !== 'GET')

// ── the harness ──
let root: Root | null = null
let host: HTMLDivElement
let iframe: HTMLIFrameElement
let posted: Array<[unknown, string]>
let mode: CommentMode
let modeNow: BrowserMode
/** The tab's address as the harness holds it, and a way to move it as the tab record would. */
let urlNow: string
let setUrlNow: (next: string) => void
let copied: Comment[]
let linkTaken: number
/** `onSend` phases, each with how many writes had gone out when it was said. */
const sendPhases: Array<[string, number]> = []

function Harness(props: { start: BrowserMode; commentLink: string | null }) {
  const [edit, setEdit] = useState<BrowserMode>(props.start)
  const [url, setUrl] = useState(HOME)
  urlNow = url
  setUrlNow = setUrl
  const [api] = useState(() => createCommentApi({ siteKey: 'northgate' }))
  modeNow = edit
  mode = useCommentMode({
    url,
    frameRef: { current: iframe },
    tracySite: true,
    domainsKnown: true,
    viaHost: false,
    sessionId: 's1',
    edit: edit === 'edit',
    setMode: setEdit,
    tabId: 'tab-1',
    active: true,
    api,
    navigate: setUrl,
    copyCommentLink: async (c) => { copied.push(c); return true },
    commentLink: props.commentLink,
    onCommentLinkTaken: () => { linkTaken += 1 },
    onSend: (phase) => { sendPhases.push([phase, writes().length]) },
  })
  return null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 14; i += 1) await act(async () => { await Promise.resolve() })
}

async function mount(options: { start?: BrowserMode; commentLink?: string } = {}): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Harness, { start: options.start ?? 'edit', commentLink: options.commentLink ?? null })) })
  await flush()
}

async function fromPage(data: Record<string, unknown>): Promise<void> {
  await act(async () => {
    const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, ...data }, origin: SITE })
    Object.defineProperty(event, 'source', { value: iframe.contentWindow })
    window.dispatchEvent(event)
  })
  await flush()
}

async function ready(url = HOME): Promise<void> {
  await act(async () => { mode.onFrameLoad() })
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  await fromPage({ kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url })
  spy.mockRestore()
}

async function pick(t: PreviewPickTarget, words: string): Promise<void> {
  await fromPage({ kind: 'picked', target: t, url: HOME })
  await act(async () => { mode.setText(words) })
}

async function viewAct(detail: Record<string, unknown>): Promise<void> {
  await act(async () => { window.dispatchEvent(new CustomEvent(COMMENT_ACT_EVENT, { detail: { tabId: 'tab-1', ...detail } })) })
  await flush()
}

const sends: CommentSendDetailV3[] = []
let chatAnswer: 'sent' | 'failed' = 'sent'
const cleanups: Array<() => void> = []
function chat(): void {
  const l = (event: Event): void => {
    const detail = (event as CustomEvent).detail as CommentSendDetailV3
    sends.push(detail)
    if (chatAnswer === 'sent') window.dispatchEvent(new CustomEvent(COMMENT_SENT_EVENT, { detail: { requestId: detail.requestId, sessionId: 's1', queued: false } }))
    else window.dispatchEvent(new CustomEvent(COMMENT_FAILED_EVENT, { detail: { requestId: detail.requestId, code: 'no-session' } }))
  }
  window.addEventListener(COMMENT_SEND_EVENT, l)
  cleanups.push(() => { window.removeEventListener(COMMENT_SEND_EVENT, l) })
}

function lists(): CommentListDetail[] {
  const seen: CommentListDetail[] = []
  const l = (event: Event): void => { seen.push((event as CustomEvent).detail as CommentListDetail) }
  window.addEventListener(COMMENT_LIST_EVENT, l)
  cleanups.push(() => { window.removeEventListener(COMMENT_LIST_EVENT, l) })
  return seen
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  rows = []
  lastN = 0
  clock = 0
  refuseNext = null
  siteChangedAt = null
  listLimits = null
  slowNext = null
  offline = false
  slowLocate = null
  applies = []
  applyAnswer = {}
  store = { enabled: true, maxBytes: 20 * 1024 * 1024, maxFiles: 20 }
  uploads = new Map()
  posted = []
  copied = []
  linkTaken = 0
  sends.length = 0
  chatAnswer = 'sent'
  resetCommentModeMemo()
  localStorage.clear()
  const base = document.createElement('base')
  base.href = `${location.origin}/northgate/`
  document.head.append(base)
  iframe = document.createElement('iframe')
  document.body.append(iframe)
  ;(iframe.contentWindow as Window).postMessage = ((message: unknown, origin: string) => { posted.push([message, origin]) }) as Window['postMessage']
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (offline && (init?.method ?? 'GET') !== 'GET' && input !== '/api/sites/northgate/apply') throw new TypeError('Failed to fetch')
    if (slowNext !== null && (init?.method ?? 'GET') !== 'GET') {
      const wait = slowNext
      slowNext = null
      await wait
    }
    if (input.startsWith(BASE) || input === REQUESTS) return doors(input, init)
    if (input === '/api/sites/northgate/preview-ticket') return new Response(JSON.stringify({ ticket: 'pv1.T', exp: 1 }), { status: 200 })
    if (input === '/api/sites/northgate/apply') {
      if (slowLocate !== null) await slowLocate
      applies.push(JSON.parse(String(init?.body)) as { action: string; params: Record<string, unknown> })
      return new Response(JSON.stringify(applyAnswer), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
  chat()
})

afterEach(async () => {
  for (const c of cleanups.splice(0)) c()
  if (root !== null) await act(async () => { root!.unmount() })
  root = null
  document.body.replaceChildren()
  document.head.querySelectorAll('base').forEach(b => { b.remove() })
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const kinds = (): string[] => posted.map(([m]) => (m as { kind: string }).kind)

describe('the new-place popover: Add comment or Send to Tracy ↵ (rules 1 and 2)', () => {
  it('Add comment keeps the words as a people comment: POSTed, open, on the page; the popover closes and the page points again', async () => {
    await mount()
    await ready()
    await pick(H1, 'Say hello')
    expect(mode.foot).toBe('new')
    const before = posted.length
    await act(async () => { mode.addComment() })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['POST', BASE]])
    expect(mode.foot).toBeNull()
    expect(mode.picked).toBeNull()
    expect(kinds().slice(before)).toContain('pick-start')
    expect(mode.pageComments.map(c => [c.id, c.text, c.status])).toEqual([['srv-1', 'Say hello', 'open']])
    expect(sends).toEqual([])
  })

  it('Send to Tracy records the request, then hands ONE v3 message to the chat with the server\'s number — no comment is made', async () => {
    await mount()
    await ready()
    await pick(H1, 'Make only this heading orange.')
    await act(async () => { mode.sendToTracy() })
    await flush()
    const request = writes()
    expect(request.map(c => [c.method, c.url])).toEqual([['POST', REQUESTS]])
    expect(request[0]!.body).toMatchObject({ sessionId: 's1', items: [{ url: HOME, text: 'Make only this heading orange.', element: { selector: 'main > h1', domPath: 'main > main > h1' } }] })
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ v: 3, sessionId: 's1', siteKey: 'northgate', requestId: (request[0]!.body as { requestId: string }).requestId, items: [{ n: 1, url: HOME, text: 'Make only this heading orange.', element: { selector: 'main > h1', label: '"Welcome"' } }] })
    expect(sends[0]!.items[0]).not.toHaveProperty('commentId')
    expect(mode.comments).toEqual([])
    expect(mode.foot).toBeNull()
    expect(kinds().at(-1)).toBe('pick-start')
  })

  it('a refused request says the door\'s sentence and sends nothing; the words stay in the popover', async () => {
    await mount()
    await ready()
    await pick(H1, 'Rename this.')
    refuseNext = { url: REQUESTS, status: 403, code: 'SEAT_REQUIRED', next: 'Ask the owner for a seat.' }
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(sends).toEqual([])
    expect(mode.serverNotice).toBe('Ask the owner for a seat.')
    expect(mode.serverNoticeKind).toBe('send')
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Rename this.')
  })

  it('a chat that did not take it says why; the words stay', async () => {
    chatAnswer = 'failed'
    await mount()
    await ready()
    await pick(H1, 'Rename this.')
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(sends).toHaveLength(1)
    expect(mode.notice).toBe('no-session')
    expect(mode.text).toBe('Rename this.')
  })

  it('✕ (and a second Esc) drops the words; Esc with nothing open goes back to Interactive', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    await act(async () => { mode.escape('parent') })
    expect(mode.text).toBe('Draft')
    await act(async () => { mode.escape('parent') })
    expect(mode.foot).toBeNull()
    expect(mode.text).toBe('')
    expect(modeNow).toBe('edit')
    await act(async () => { mode.escape('parent', {}) })
    expect(modeNow).toBe('interactive')
    expect(writes()).toEqual([])
  })
})

describe('pins open the thread card (rule 4)', () => {
  async function withThread(): Promise<void> {
    rows.push(serverRow({ element: { ...STAT }, text: 'We have 14 subsidiaries now.', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ element: { ...STAT }, text: 'The About page says 13 as well.', replyTo: 'srv-1' }))
    await mount()
    await ready()
  }

  it('a reply has no pin of its own; opening a thread shows its messages in order', async () => {
    await withThread()
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1'])
    await act(async () => { mode.openThread('srv-1') })
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.threadMessages.map(m => m.text)).toEqual(['We have 14 subsidiaries now.', 'The About page says 13 as well.'])
  })

  it('Reply is a people reply: POSTed with replyTo, nothing to Tracy', async () => {
    await withThread()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Agreed.') })
    await act(async () => { mode.reply() })
    await flush()
    expect(writes().map(c => [c.method, c.url, (c.body as { replyTo?: string } | undefined)?.replyTo])).toEqual([['POST', BASE, 'srv-1']])
    expect(sends).toEqual([])
    expect(mode.replyText).toBe('')
    expect(mode.threadMessages.map(m => m.text)).toEqual(['We have 14 subsidiaries now.', 'The About page says 13 as well.', 'Agreed.'])
  })

  it('Send to Tracy ↵ in the card: the typed words and the WHOLE thread as one message; the words do not become a reply; the comment stays', async () => {
    await withThread()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Update it on both pages, please.') })
    await act(async () => { mode.sendThread() })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['POST', REQUESTS]])
    expect(writes()[0]!.body).toMatchObject({ items: [{ commentId: 'srv-1', text: 'Update it on both pages, please.' }] })
    expect(sends).toHaveLength(1)
    const item = sends[0]!.items[0]!
    expect(item).toMatchObject({ commentId: 'srv-1', author: MAI, text: 'Update it on both pages, please.', element: { selector: 'main > .stat' } })
    expect(item.thread).toEqual([
      { author: { name: 'Mai', email: 'mai@example.com' }, at: Date.parse(rows[0]!.createdAt!), text: 'We have 14 subsidiaries now.' },
      { author: { name: 'Lee', email: 'lee@example.com' }, at: Date.parse(rows[1]!.createdAt!), text: 'The About page says 13 as well.' },
    ])
    // The comment's own time rides along, for the chip's age (chat-input contract §H2 `at?`).
    expect(item.at).toBe(Date.parse(rows[0]!.createdAt!))
    // The element's `content.locate` answer rides along (the page's lookup door answers `{}` here).
    expect(item).toHaveProperty('locate')
    expect(mode.comments.map(c => c.id)).toEqual(['srv-1', 'srv-2'])
    expect(mode.comments[0]).toMatchObject({ status: 'open', sentToTracy: true })
    expect(mode.replyText).toBe('')
    expect(mode.thread?.id).toBe('srv-1')
  })

  it('round 9 (acceptance v5 V5S-6): a card\'s send says `start` at the press — before the request door — and `failed` only when it came to nothing', async () => {
    await withThread()
    await act(async () => { mode.openThread('srv-1') })
    sendPhases.length = 0
    await act(async () => { mode.setReplyText('Update it on both pages, please.') })
    await act(async () => { mode.sendThread() })
    await flush()
    expect(sends).toHaveLength(1)
    expect(sendPhases).toEqual([['start', 0]])
    sendPhases.length = 0
    chatAnswer = 'failed'
    await act(async () => { mode.setReplyText('Once more, please.') })
    await act(async () => { mode.sendThread() })
    await flush()
    expect(sendPhases.map(([phase]) => phase)).toEqual(['start', 'failed'])
  })

  it('a reply posted just before Send to Tracy is in the thread sent — last, with its words (Brian 30/09)', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'We have 14 subsidiaries now.', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ element: { ...STAT }, text: 'The About page says 13 as well.', replyTo: 'srv-1' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Mai: fine by me.', replyTo: 'srv-1', author: MAI }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    expect(mode.threadMessages).toHaveLength(3)
    for (const wait of [true, false]) {
      sends.length = 0
      const words = wait ? 'Brian: both pages then.' : 'Brian: and the footer.'
      await act(async () => { mode.setReplyText(words) })
      await act(async () => { mode.reply() })
      // `wait`: the reply's POST answered before the send; otherwise it is still on its way.
      if (wait) await flush()
      await act(async () => { mode.setReplyText('Please do it.') })
      await act(async () => { mode.sendThread() })
      await flush()
      expect(sends).toHaveLength(1)
      const thread = sends[0]!.items[0]!.thread ?? []
      expect(thread.at(-1)).toMatchObject({ text: words })
      expect(thread.filter(e => 'text' in e && e.text === words)).toHaveLength(1)
    }
  })

  it('Resolve is anyone\'s (another person\'s comment here): its door, and the card closes', async () => {
    await withThread()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.resolve(['srv-1']) })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['POST', `${BASE}/srv-1/resolve`]])
    expect(mode.thread).toBeNull()
    expect(mode.pageComments).toEqual([])
  })

  it('⋮ Edit is on one\'s own message only; ⋮ Copy link hands the comment to the view\'s link', async () => {
    await withThread()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.editMessage('srv-1') })
    expect(mode.foot).toBeNull()
    await act(async () => { await mode.copyLink('srv-1') })
    expect(copied.map(c => c.id)).toEqual(['srv-1'])
    await act(async () => { mode.editMessage('srv-2') })
    expect(mode.foot).toBe('edit')
    expect(mode.editing?.id).toBe('srv-2')
    expect(mode.text).toBe('The About page says 13 as well.')
    expect(mode.thread).toBeNull()
  })

  it('Esc closes the card first, then leaves Edit', async () => {
    await withThread()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.escape('parent') })
    expect(mode.thread).toBeNull()
    expect(modeNow).toBe('edit')
  })
})

describe('the edit popover: Save ↵, Send to Tracy, Delete', () => {
  async function editing(): Promise<void> {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
  }

  it('Save PATCHes {text} only', async () => {
    await editing()
    await act(async () => { mode.setText('Say hello, world') })
    await act(async () => { mode.save() })
    await flush()
    expect(writes().map(c => [c.method, c.url, c.body])).toEqual([['PATCH', `${BASE}/srv-1`, { text: 'Say hello, world' }]])
    expect(mode.foot).toBeNull()
  })

  it('Send to Tracy saves changed words, then sends the comment (it stays, open)', async () => {
    await editing()
    await act(async () => { mode.setText('Say hello, world') })
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['PATCH', `${BASE}/srv-1`], ['POST', REQUESTS]])
    expect(sends[0]!.items[0]).toMatchObject({ commentId: 'srv-1', text: 'Say hello, world' })
    expect(mode.comments[0]).toMatchObject({ id: 'srv-1', status: 'open' })
    expect(mode.foot).toBeNull()
  })

  it('Delete is the DELETE door, once its Undo window is over', async () => {
    await editing()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    expect(mode.comments).toEqual([])
    expect(mode.foot).toBeNull()
    // Back in the thread card, whose spot says "Deleted · Undo" for the window.
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.deleted).toEqual({ id: 'srv-1', left: 10 })
    await act(async () => { vi.advanceTimersByTime(DELETE_UNDO_MS) })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['DELETE', `${BASE}/srv-1`]])
  })
})

describe('⋮ Delete is a soft delete with Undo (Brian 29/09 22:45: one word, one style, one action)', () => {
  async function mine(): Promise<void> {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  }

  it('it leaves the page, the pins and every count at once; its spot in the card reads "Deleted · Undo"; nothing reaches the server for ten seconds', async () => {
    await mine()
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    expect(mode.comments).toEqual([])
    expect(mode.pageComments).toEqual([])
    expect(mode.deleted).toEqual({ id: 'srv-1', left: 10 })
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.threadMessages.map(m => m.id)).toEqual(['srv-1'])
    await act(async () => { vi.advanceTimersByTime(DELETE_UNDO_MS - 1) })
    await flush()
    expect(writes()).toEqual([])
    expect(DELETE_UNDO_MS).toBe(10_000)
  })

  it('the countdown (Brian 23:20): 10 → 1, one a second; at 0 the DELETE goes', async () => {
    await mine()
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    const seen = [mode.deleted?.left]
    for (let i = 0; i < 9; i += 1) {
      await act(async () => { vi.advanceTimersByTime(1000) })
      seen.push(mode.deleted?.left)
    }
    expect(seen).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    await flush()
    expect(writes()).toEqual([])
    await act(async () => { vi.advanceTimersByTime(1000) })
    await flush()
    expect(mode.deleted).toBeNull()
    expect(writes().map(c => [c.method, c.url])).toEqual([['DELETE', `${BASE}/srv-1`]])
  })

  it('Undo within the window: the comment comes back and no DELETE is ever sent', async () => {
    await mine()
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    await act(async () => { vi.advanceTimersByTime(3000) })
    await act(async () => { mode.undoDelete() })
    await flush()
    expect(mode.comments.map(c => [c.id, c.text, c.removed === true])).toEqual([['srv-1', 'Say hello', false]])
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1'])
    expect(mode.deleted).toBeNull()
    await act(async () => { vi.advanceTimersByTime(DELETE_UNDO_MS * 2) })
    await flush()
    expect(writes()).toEqual([])
  })

  it('when the window ends: one DELETE, the spot goes, and the card of a comment with no reply closes', async () => {
    await mine()
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    await act(async () => { vi.advanceTimersByTime(DELETE_UNDO_MS) })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['DELETE', `${BASE}/srv-1`]])
    expect(mode.deleted).toBeNull()
    expect(mode.comments).toEqual([])
    expect(mode.thread).toBeNull()
  })

  it('the chat column\'s list (its tab badge) drops the comment at once, gets it back on Undo, and drops it again for good', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'One' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Two' }))
    const seen = lists()
    await mount()
    await ready()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const openIds = (): string[] => seen.at(-1)!.comments.filter(c => c.removed !== true && !c.resolved).map(c => c.id)
    expect(openIds()).toEqual(['srv-1', 'srv-2'])
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    expect(openIds()).toEqual(['srv-2'])
    await act(async () => { mode.undoDelete() })
    await flush()
    expect(openIds()).toEqual(['srv-1', 'srv-2'])
    await act(async () => { mode.deleteComment('srv-1') })
    await act(async () => { vi.advanceTimersByTime(DELETE_UNDO_MS) })
    await flush()
    expect(openIds()).toEqual(['srv-2'])
  })

  it('a poll during the window does not bring the comment back', async () => {
    await mine()
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    // The row changes on the server meanwhile, so the next poll lists it; another write polls.
    rows[0]!.updatedAt = stamp()
    await act(async () => { mode.addGeneral('poke') })
    await flush()
    expect(calls.filter(c => c.method === 'GET').length).toBeGreaterThan(1)
    expect(mode.comments.map(c => c.id)).not.toContain('srv-1')
  })

  it('the page hiding or unloading during the window sends the DELETE at once, with keepalive', async () => {
    await mine()
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['DELETE', `${BASE}/srv-1`]])
    const init = vi.mocked(fetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')![1] as RequestInit
    expect(init.keepalive).toBe(true)
    expect(mode.deleted).toBeNull()
  })

  it('a second Delete during the window sends the first one before starting its own', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'One' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Two' }))
    await mount()
    await ready()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    await act(async () => { mode.deleteComment('srv-2') })
    await flush()
    expect(writes().map(c => [c.method, c.url])).toEqual([['DELETE', `${BASE}/srv-1`]])
    expect(mode.deleted).toEqual({ id: 'srv-2', left: 10 })
    await act(async () => { mode.undoDelete() })
    await flush()
    expect(mode.comments.map(c => c.id)).toEqual(['srv-2'])
  })

  it('another person\'s comment is not deleted', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Theirs', author: MAI, can: { edit: false, delete: false } }))
    await mount()
    await ready()
    await act(async () => { mode.deleteComment('srv-1') })
    await flush()
    expect(mode.deleted).toBeNull()
    expect(mode.comments.map(c => c.id)).toEqual(['srv-1'])
  })
})

describe('the Comments view acts (H2)', () => {
  it('send with the ticked ids: ONE message with those comments, their own words; they stay', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'First' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Second', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ url: ABOUT, text: 'Third' }))
    await mount()
    await ready()
    await viewAct({ kind: 'send', ids: ['srv-3', 'srv-1'] })
    expect(sends).toHaveLength(1)
    expect(sends[0]!.items.map(i => [i.commentId, i.text])).toEqual([['srv-1', 'First'], ['srv-3', 'Third']])
    expect(mode.comments.map(c => [c.id, c.status, c.sentToTracy === true])).toEqual([['srv-1', 'open', true], ['srv-2', 'open', false], ['srv-3', 'open', true]])
  })

  it('send {page: true, text} (the page box): ONLY those words, one whole-page item — never the pending comments', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Never sent, and not sent now' }))
    await mount()
    await ready()
    await viewAct({ kind: 'send', page: true, text: 'Warmer colours everywhere' })
    expect(sends).toHaveLength(1)
    expect(sends[0]!.items).toEqual([{ n: 2, url: HOME, element: null, locate: null, text: 'Warmer colours everywhere' }])
    expect(writes().map(c => c.url)).toEqual([REQUESTS])
  })

  it('send with neither ids nor page sends nothing (there is no "send all pending" any more)', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Open' }))
    await mount()
    await ready()
    await viewAct({ kind: 'send' })
    await viewAct({ kind: 'send', text: 'words but no page flag' })
    expect(sends).toEqual([])
    expect(writes()).toEqual([])
  })

  it('add is a whole-page people comment (element null)', async () => {
    await mount()
    await ready()
    await viewAct({ kind: 'add', text: 'The whole page feels cold' })
    expect(writes()[0]).toMatchObject({ method: 'POST', url: BASE, body: { url: HOME, element: null, text: 'The whole page feels cold' } })
  })

  it('clear: POST /clear {threads} — exactly the comments the view names, another person\'s too, on any page (UI fine-tune 30/09)', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Mine' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Hers', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ url: ABOUT, element: { ...H1 }, text: 'On about' }))
    rows.push(serverRow({ element: { ...H1 }, text: 'Resolved, hidden in the view', status: 'resolved', resolvedAt: stamp(), resolvedBy: LEE }))
    await mount()
    await ready()
    await viewAct({ kind: 'clear', ids: ['srv-1', 'srv-2', 'srv-3'] })
    expect(writes().map(c => [c.method, c.url, c.body])).toEqual([['POST', `${BASE}/clear`, { threads: ['srv-1', 'srv-2', 'srv-3'] }]])
    expect(mode.comments.map(c => c.id)).toEqual(['srv-4'])
  })

  it('reveal opens the comment\'s thread card at its pin, loading its page and turning Edit on first', async () => {
    rows.push(serverRow({ url: ABOUT, element: { ...H1 }, text: 'On about' }))
    await mount({ start: 'interactive' })
    await ready()
    await viewAct({ kind: 'reveal', ids: ['srv-1'] })
    expect(modeNow).toBe('edit')
    await ready(ABOUT)
    expect(mode.thread?.id).toBe('srv-1')
    expect(posted.map(([m]) => m as { kind: string; id?: string }).filter(m => m.kind === 'pick-reveal')).toEqual([expect.objectContaining({ id: 'srv-1' })])
  })

  it('reveal of a RESOLVED comment tracks it while its card is open: a pin at its element and the card there; closing the card lets it go', async () => {
    // Brian 29/09 22:33: a resolved row scrolled the page to its element and flashed it, then after
    // 1.5 s the page let the element go, its box went with it, and the card jumped to the frame's top.
    rows.push(serverRow({ element: { ...H1 }, text: 'Done one', status: 'resolved', resolvedAt: stamp(), resolvedBy: LEE }))
    await mount()
    await ready()
    const tracked = (): string[] => ((posted.map(([m]) => m as { kind: string; items?: Array<{ id: string }> }).filter(m => m.kind === 'pick-track').at(-1)?.items) ?? []).map(i => i.id)
    expect(tracked()).toEqual([])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await viewAct({ kind: 'reveal', ids: ['srv-1'] })
    expect(kinds()).toContain('pick-reveal')
    await fromPage({ kind: 'pick-rect', id: 'srv-1', rect: { x: 40, y: 300, width: 200, height: 30 } })
    await act(async () => { vi.advanceTimersByTime(10_000) })
    vi.useRealTimers()
    await flush()
    expect(mode.thread?.id).toBe('srv-1')
    expect(tracked()).toEqual(['srv-1'])
    expect(mode.rects.get('srv-1')).toEqual({ x: 40, y: 300, width: 200, height: 30 })
    expect(mode.pageComments.map(c => [c.id, c.status])).toEqual([['srv-1', 'resolved']])
    await act(async () => { mode.closeThread() })
    await flush()
    expect(tracked()).toEqual([])
    expect(mode.pageComments).toEqual([])
    expect(mode.rects.has('srv-1')).toBe(false)
  })

  it('the stage-5 acts are gone: reopen and resolve-done do nothing', async () => {
    rows.push(serverRow({ status: 'resolved', resolvedAt: stamp(), text: 'Done' }))
    await mount()
    await viewAct({ kind: 'reopen', ids: ['srv-1'] })
    await viewAct({ kind: 'resolve-done' })
    expect(writes()).toEqual([])
  })

  it('the list says replyCount and sentToTracy, and no status word', async () => {
    const seen = lists()
    rows.push(serverRow({ element: { ...H1 }, text: 'Root', sentToTracy: true }))
    rows.push(serverRow({ element: { ...H1 }, text: 'Reply', replyTo: 'srv-1' }))
    await mount()
    const row0 = seen.at(-1)!.comments[0]!
    expect(row0).toMatchObject({ id: 'srv-1', replyCount: 1, sentToTracy: true })
    expect(row0).not.toHaveProperty('status')
  })

  it('replyCount follows the thread live: a reply added counts at once, a reply deleted stops counting at once (the chat\'s "Send N" reads it)', async () => {
    const seen = lists()
    rows.push(serverRow({ element: { ...STAT }, text: 'Root', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Reply', replyTo: 'srv-1' }))
    await mount()
    await ready()
    const count = (): number | undefined => seen.at(-1)!.comments.find(c => c.id === 'srv-1')?.replyCount
    expect(count()).toBe(1)
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('One more.') })
    await act(async () => { mode.reply() })
    expect(count()).toBe(2)
    await flush()
    expect(count()).toBe(2)
    await act(async () => { mode.deleteComment('srv-2') })
    expect(count()).toBe(1)
  })
})

describe('no status machinery any more', () => {
  it('a stage-5 tracy:comment-status changes nothing and writes nothing', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    const before = JSON.stringify(mode.comments)
    await act(async () => { window.dispatchEvent(new CustomEvent('tracy:comment-status', { detail: { sessionId: 's1', requestId: 'r1', n: 1, status: 'done', callId: 'c1' } })) })
    await flush()
    expect(JSON.stringify(mode.comments)).toBe(before)
    expect(writes()).toEqual([])
  })

  it('an older row\'s "sent" reads as an open comment, tracked as a plain pending outline', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Old', status: 'sent' }))
    await mount()
    await ready()
    expect(mode.comments[0]!.status).toBe('open')
    const track = posted.map(([m]) => m as { kind: string; items?: Array<{ state: string }> }).filter(m => m.kind === 'pick-track').at(-1)
    expect(track?.items?.map(i => i.state)).toEqual(['pending'])
  })
})

describe('the poll brings siteChangedAt for the Refresh button', () => {
  it('is null until the server names one, then the latest', async () => {
    await mount()
    expect(mode.siteChangedAt).toBeNull()
    siteChangedAt = '2026-09-29T21:00:00.000Z'
    await act(async () => { mode.addGeneral('poke') })
    await flush()
    expect(mode.siteChangedAt).toBe('2026-09-29T21:00:00.000Z')
  })

  it('typing is true while words wait in a popover or a reply box', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Root' }))
    await mount()
    await ready()
    expect(mode.typing).toBe(false)
    await pick(STAT, 'half a thought')
    expect(mode.typing).toBe(true)
    await act(async () => { mode.close() })
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('and') })
    expect(mode.typing).toBe(true)
  })
})

describe('a link to a comment (rule 6)', () => {
  it('once the list is in: its page, Edit, scrolled to, the thread card open; the parameter is handed back once', async () => {
    rows.push(serverRow({ url: ABOUT, element: { ...STAT }, text: 'Linked' }))
    await mount({ start: 'interactive', commentLink: 'srv-1' })
    expect(linkTaken).toBe(1)
    expect(modeNow).toBe('edit')
    await ready(ABOUT)
    expect(mode.thread?.id).toBe('srv-1')
    expect(kinds()).toContain('pick-reveal')
  })

  it('round 6: a link to a REPLY opens its thread card at that reply (`threadFocus`); a pin click later opens at the newest', async () => {
    rows.push(serverRow({ url: ABOUT, element: { ...STAT }, text: 'Root' }))
    rows.push(serverRow({ url: ABOUT, replyTo: 'srv-1', text: 'The linked reply', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ url: ABOUT, replyTo: 'srv-1', text: 'A later reply' }))
    await mount({ start: 'interactive', commentLink: 'srv-2' })
    await ready(ABOUT)
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.threadFocus).toBe('srv-2')
    await act(async () => { mode.closeThread() })
    await act(async () => { mode.openThread('srv-1') })
    expect(mode.threadFocus).toBeNull()
  })

  it('round 6: "Reply" counts this person\'s own replies, so the card can show the new one', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Root' }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    const before = mode.ownReplies
    await act(async () => { mode.setReplyText('mine') })
    await act(async () => { mode.reply() })
    expect(mode.ownReplies).toBe(before + 1)
  })

  it('round 11 (EDGE-9): the page the link names is not the comment\'s (or the tab record moved it back): the comment\'s own page is loaded again, and the card opens there', async () => {
    rows.push(serverRow({ url: ABOUT, element: { ...STAT }, text: 'On About' }))
    await mount({ start: 'interactive', commentLink: 'srv-1' })
    expect(urlNow).toBe(ABOUT)
    // The tab record's `page=/` lands after the link asked for /about, and / announces itself.
    await act(async () => { setUrlNow(HOME) })
    await ready(HOME)
    expect(urlNow).toBe(ABOUT)
    await ready(ABOUT)
    expect(mode.thread?.id).toBe('srv-1')
  })

  it('round 11 (EDGE-9): it tries twice, then gives up quietly: the person is never dragged back for ever', async () => {
    rows.push(serverRow({ url: ABOUT, element: { ...STAT }, text: 'On About' }))
    await mount({ start: 'interactive', commentLink: 'srv-1' })
    for (let i = 0; i < 2; i += 1) {
      await act(async () => { setUrlNow(HOME) })
      await ready(HOME)
      expect(urlNow).toBe(ABOUT)
    }
    await act(async () => { setUrlNow(HOME) })
    await ready(HOME)
    expect(urlNow).toBe(HOME)
    expect(mode.thread).toBeNull()
  })

  it('a reveal from the Comments view is not re-driven: a page the person went to meanwhile stays', async () => {
    rows.push(serverRow({ url: ABOUT, element: { ...STAT }, text: 'On About' }))
    await mount()
    await ready()
    await viewAct({ kind: 'reveal', ids: ['srv-1'] })
    expect(urlNow).toBe(ABOUT)
    await act(async () => { setUrlNow(HOME) })
    await ready(HOME)
    expect(urlNow).toBe(HOME)
  })

  it('a link to a comment the site no longer has opens nothing, and is handed back all the same', async () => {
    await mount({ start: 'interactive', commentLink: 'gone' })
    expect(linkTaken).toBe(1)
    expect(modeNow).toBe('interactive')
    expect(mode.thread).toBeNull()
  })
})

describe('writes the server refuses (kept from stage 5)', () => {
  it('a refused Save puts the stored words back and reopens the edit popover with the typed words, in plain words (round 5, TH-2)', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
    await act(async () => { mode.setText('Changed') })
    refuseNext = { url: BASE, status: 500, code: 'BROKEN', next: 'Try again.' }
    await act(async () => { mode.save() })
    await flush()
    expect(mode.comments[0]!.text).toBe('Say hello')
    expect(mode.foot).toBe('edit')
    expect(mode.editing?.id).toBe('srv-1')
    expect(mode.text).toBe('Changed')
    expect(mode.saveError).toEqual({ box: 'popover', key: 'commentErrUnknown' })
    expect(mode.serverNotice).toBeNull()
  })

  it('a comment deleted elsewhere (404 COMMENT_NOT_FOUND) leaves quietly', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    rows.length = 0
    await act(async () => { mode.resolve(['srv-1']) })
    await flush()
    expect(mode.comments).toEqual([])
    expect(mode.serverNotice).toBeNull()
  })
})

describe('a send quotes the page as it reads NOW (runtime 9, kept from stage 5 F16)', () => {
  it('a comment whose element\'s words changed sends them as text and the words when picked as was', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await fromPage({ kind: 'pick-text', id: 'srv-1', text: 'Welcome back' })
    await viewAct({ kind: 'send', ids: ['srv-1'] })
    expect(sends[0]!.items[0]!.element).toMatchObject({ text: 'Welcome back', was: 'Welcome', label: '"Welcome back"' })
  })

  it('words that did not change send exactly what was picked', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await fromPage({ kind: 'pick-text', id: 'srv-1', text: ' Welcome ' })
    await viewAct({ kind: 'send', ids: ['srv-1'] })
    expect(sends[0]!.items[0]!.element).not.toHaveProperty('was')
    expect(sends[0]!.items[0]!.element!.text).toBe('Welcome')
  })
})

describe('pick-hold (runtime 11): the page holds its clicks while a box is open (Brian 23:08)', () => {
  const holds = (): boolean[] => posted.map(([m]) => m as { kind: string; on?: boolean }).filter(m => m.kind === 'pick-hold').map(m => m.on === true)
  async function readyWith(features: string[]): Promise<void> {
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await fromPage({ kind: 'ready', features, url: HOME })
    spy.mockRestore()
  }

  it('a box opening sends pick-hold on to the page, its closing off; the layer is told the page holds', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await readyWith(['pick', 'track', 'reveal', 'text', 'hold'])
    expect(mode.holdable).toBe(true)
    expect(holds()).toEqual([])
    await pick(H1, '')
    expect(holds()).toEqual([true])
    await act(async () => { mode.close() })
    expect(holds()).toEqual([true, false])
    await act(async () => { mode.openThread('srv-1') })
    expect(holds()).toEqual([true, false, true])
    await act(async () => { mode.escape('parent') })
    expect(holds()).toEqual([true, false, true, false])
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'pick-hold').every(([, origin]) => origin === SITE)).toBe(true)
  })

  it('a new document of the page while a box is open is held again (a page starts unheld)', async () => {
    await mount()
    await readyWith(['pick', 'track', 'reveal', 'text', 'hold'])
    await pick(H1, 'typing')
    expect(holds()).toEqual([true])
    await readyWith(['pick', 'track', 'reveal', 'text', 'hold'])
    expect(holds()).toEqual([true, true])
  })

  it('a runtime-9 page (no hold) is never sent pick-hold: the layer shields the frame instead', async () => {
    await mount()
    await readyWith(['pick', 'track', 'reveal', 'text'])
    expect(mode.holdable).toBe(false)
    await pick(H1, '')
    await act(async () => { mode.close() })
    expect(holds()).toEqual([])
  })

  it('pick-outside from the page reaches the layer\'s handler; from another origin or while unheld it does not', async () => {
    await mount()
    await readyWith(['pick', 'track', 'reveal', 'text', 'hold'])
    const heard: Array<{ x: number; y: number }> = []
    const stop = mode.onPageOutside((at) => { heard.push(at) })
    await fromPage({ kind: 'pick-outside', x: 5, y: 6 })
    expect(heard).toEqual([])
    await pick(H1, 'typing')
    await fromPage({ kind: 'pick-outside', x: 120, y: 340 })
    await act(async () => {
      const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-outside', x: 1, y: 1 }, origin: 'https://evil.example' })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)
    })
    expect(heard).toEqual([{ x: 120, y: 340 }])
    stop()
    await fromPage({ kind: 'pick-outside', x: 7, y: 8 })
    expect(heard).toHaveLength(1)
  })
})

describe('a page that came back without its picker while shown in Edit (the continuation lapsed)', () => {
  // Brian 29/09 22:33: the page had been scrolled to a comment (3085 px down); Tracy's turn ended and
  // reloaded it in place, but the picker's continuation had lapsed, so that document came back without
  // the picker; five seconds later the recovery loaded the page AGAIN at a new ticketed address — a new
  // navigation, which the browser opens at the top. The page says where it is (`pick-scroll`, runtime
  // 11); the recovered page is put back there (`pick-scroll-to`).
  const SCROLLING = ['pick', 'track', 'reveal', 'text', 'scroll']

  /** Ready, scrolled, then reloaded in place into a document with no picker, then the recovery's wait. */
  async function lapse(features: string[], y = 3085): Promise<void> {
    await mount()
    await act(async () => { mode.onFrameLoad() })
    const first = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await fromPage({ kind: 'ready', features, url: HOME })
    first.mockRestore()
    await fromPage({ kind: 'pick-scroll', x: 0, y })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    await act(async () => { mode.onFrameLoad() })
    later.mockReturnValue(Date.now() + 180_000)
    await act(async () => { mode.onFrameLoad() })
    await act(async () => { vi.advanceTimersByTime(RECOVERY_WAIT_MS + 10) })
    later.mockRestore()
    vi.useRealTimers()
    await flush()
  }

  /** The recovered document: its load, then its `ready` with the picker. */
  async function recovered(features: string[]): Promise<void> {
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_000)
    await fromPage({ kind: 'ready', features, url: HOME })
    spy.mockRestore()
  }

  const scrollTos = (): Array<[unknown, string]> => posted.filter(([m]) => (m as { kind: string }).kind === 'pick-scroll-to')

  it('the recovery reload puts the page back where it was scrolled to, once, on the page\'s own origin', async () => {
    await lapse(SCROLLING)
    // The recovery asked the ticket door again (the first ask was the page's own first load).
    const asked = vi.mocked(fetch).mock.calls.filter(([input]) => input === '/api/sites/northgate/preview-ticket')
    expect(asked).toHaveLength(2)
    expect(new URL(mode.frameSrc!).searchParams.get('tracy_preview')).toBe('pv1.T')
    expect(scrollTos()).toEqual([])
    await recovered(SCROLLING)
    expect(scrollTos()).toEqual([[{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-scroll-to', x: 0, y: 3085 }, SITE]])
    // The pageshow echo of the same document, or a later load, does not scroll it again.
    await fromPage({ kind: 'ready', features: SCROLLING, url: HOME })
    await recovered(SCROLLING)
    expect(scrollTos()).toHaveLength(1)
  })

  it('an ordinary load in Edit is left where the browser put it: no pick-scroll-to', async () => {
    await mount()
    await ready()
    await fromPage({ kind: 'pick-scroll', x: 0, y: 900 })
    await recovered(SCROLLING)
    expect(scrollTos()).toEqual([])
  })

  it('a page scrolled to the top, or one that names no scroll (runtime 9), gets no pick-scroll-to', async () => {
    await lapse(SCROLLING, 0)
    await recovered(SCROLLING)
    expect(scrollTos()).toEqual([])
    if (root !== null) await act(async () => { root!.unmount() })
    root = null
    posted.length = 0
    resetCommentModeMemo()
    await lapse(['pick', 'track', 'reveal', 'text'])
    await recovered(['pick', 'track', 'reveal', 'text'])
    expect(scrollTos()).toEqual([])
  })

  it('a pick-scroll from another origin or another window is not believed', async () => {
    await mount()
    await act(async () => { mode.onFrameLoad() })
    const first = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await fromPage({ kind: 'ready', features: SCROLLING, url: HOME })
    first.mockRestore()
    await act(async () => {
      const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-scroll', x: 0, y: 5000 }, origin: 'https://evil.example' })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)
      const stray = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-scroll', x: 0, y: 6000 }, origin: SITE })
      Object.defineProperty(stray, 'source', { value: window })
      window.dispatchEvent(stray)
    })
    await flush()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    await act(async () => { mode.onFrameLoad() })
    await act(async () => { vi.advanceTimersByTime(RECOVERY_WAIT_MS + 10) })
    later.mockRestore()
    vi.useRealTimers()
    await flush()
    await recovered(SCROLLING)
    expect(scrollTos()).toEqual([])
  })
})

describe('files on a comment (stage 6 attachments contract §B–§D)', () => {
  const png = (name = 'shot.png', bytes = 'PNG'): File => new File([bytes], name, { type: 'image/png' })
  const pdf = (name = 'brief.pdf'): File => new File(['%PDF'], name, { type: 'application/pdf' })
  const huge = (name: string): File => {
    const f = new File(['x'], name, { type: 'image/png' })
    Object.defineProperty(f, 'size', { value: 21 * 1024 * 1024 })
    return f
  }
  const stored = (name: string, type: string, size = 3): Attachment => {
    const id = `att-${String(uploads.size + 1)}`
    const attachment = { id, name, size, type, url: `${BASE}/attachments/${id}` }
    uploads.set(id, { attachment, bytes: new Blob(['abc'], { type }) })
    return attachment
  }

  it('picked files go in the box; ✕ takes one out again', async () => {
    await mount()
    await ready()
    await pick(H1, 'See the shot')
    await act(async () => { mode.addFiles('popover', [png(), pdf()]) })
    expect(mode.draft.map(d => (d.kind === 'file' ? d.file.name : ''))).toEqual(['shot.png', 'brief.pdf'])
    await act(async () => { mode.removeDraft('popover', mode.draft[0]!.key) })
    expect(mode.draft.map(d => (d.kind === 'file' ? d.file.name : ''))).toEqual(['brief.pdf'])
    expect(mode.draftError).toBeNull()
  })

  it('a file over the limit is refused by name before anything is uploaded; the others still go in', async () => {
    await mount()
    await ready()
    await pick(H1, 'See the shot')
    await act(async () => { mode.addFiles('popover', [huge('poster.png'), png()]) })
    expect(mode.draftError).toEqual({ box: 'popover', refusal: { code: 'too-large', name: 'poster.png', limit: 20 * 1024 * 1024 } })
    expect(mode.draft.map(d => (d.kind === 'file' ? d.file.name : ''))).toEqual(['shot.png'])
    expect(writes()).toEqual([])
  })

  it('more files than the list allows are refused', async () => {
    store = { enabled: true, maxBytes: 20 * 1024 * 1024, maxFiles: 2 }
    await mount()
    await ready()
    await pick(H1, 'Three shots')
    await act(async () => { mode.addFiles('popover', [png('a.png'), png('b.png'), png('c.png')]) })
    expect(mode.draft).toHaveLength(2)
    expect(mode.draftError).toEqual({ box: 'popover', refusal: { code: 'too-many', limit: 2 } })
  })

  it('Add comment uploads each file, then POSTs the comment with their ids in order; the row carries them', async () => {
    await mount()
    await ready()
    await pick(H1, 'See the shot')
    await act(async () => { mode.addFiles('popover', [png(), pdf()]) })
    await act(async () => { mode.addComment() })
    await flush()
    const w = writes()
    expect(w.map(c => [c.method, c.url])).toEqual([['POST', `${BASE}/attachments`], ['POST', `${BASE}/attachments`], ['POST', BASE]])
    expect(w.slice(0, 2).map(c => (c.body as { file: string }).file)).toEqual(['shot.png', 'brief.pdf'])
    expect((w[2]!.body as { attachments: string[] }).attachments).toEqual(['att-1', 'att-2'])
    expect(mode.comments[0]!.attachments?.map(a => a.name)).toEqual(['shot.png', 'brief.pdf'])
    expect(mode.draft).toEqual([])
  })

  it('Add comment with no files POSTs no attachments field', async () => {
    await mount()
    await ready()
    await pick(H1, 'Words only')
    await act(async () => { mode.addComment() })
    await flush()
    expect(writes()[0]!.body).not.toHaveProperty('attachments')
  })

  it('an upload the door refuses keeps nothing on the server: the popover comes back with its words and file, and says so (round 5, TH-2)', async () => {
    await mount()
    await ready()
    await pick(H1, 'See the shot')
    await act(async () => { mode.addFiles('popover', [png()]) })
    refuseNext = { url: `${BASE}/attachments`, status: 503, code: 'ATTACHMENT_STORE_UNAVAILABLE', next: 'Files cannot be kept on this server.' }
    await act(async () => { mode.addComment() })
    await flush()
    expect(writes().map(c => c.url)).toEqual([`${BASE}/attachments`])
    expect(mode.comments).toEqual([])
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('See the shot')
    expect(mode.draft.map(d => (d.kind === 'file' ? d.file.name : ''))).toEqual(['shot.png'])
    expect(mode.saveError).toEqual({ box: 'popover', key: 'commentErrFile' })
  })

  it('Reply uploads its files, then POSTs the reply with their ids', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Numbers are off.', author: MAI, can: { edit: false, delete: false } }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Here is the report.') })
    await act(async () => { mode.addFiles('reply', [pdf()]) })
    await act(async () => { mode.reply() })
    await flush()
    const w = writes()
    expect(w.map(c => [c.method, c.url])).toEqual([['POST', `${BASE}/attachments`], ['POST', BASE]])
    expect(w[1]!.body).toMatchObject({ replyTo: 'srv-1', attachments: ['att-1'] })
    expect(mode.replyDraft).toEqual([])
    expect(mode.threadMessages.at(-1)!.attachments?.map(a => a.name)).toEqual(['brief.pdf'])
  })

  it('the edit popover starts with the comment\'s files; removing one and adding one PATCHes the new list', async () => {
    const kept = [stored('a.png', 'image/png'), stored('b.pdf', 'application/pdf')]
    rows.push(serverRow({ element: { ...H1 }, text: 'Old words', attachments: kept }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
    expect(mode.draft.map(d => (d.kind === 'stored' ? d.attachment.id : ''))).toEqual(['att-1', 'att-2'])
    await act(async () => { mode.removeDraft('popover', mode.draft[0]!.key) })
    await act(async () => { mode.addFiles('popover', [png('c.png')]) })
    await act(async () => { mode.save() })
    await flush()
    const w = writes()
    expect(w.map(c => [c.method, c.url])).toEqual([['POST', `${BASE}/attachments`], ['PATCH', `${BASE}/srv-1`]])
    expect(w[1]!.body).toEqual({ text: 'Old words', attachments: ['att-2', 'att-3'] })
    expect(mode.comments[0]!.attachments?.map(a => a.name)).toEqual(['b.pdf', 'c.png'])
  })

  it('Save with the files unchanged PATCHes {text} only', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Old words', attachments: [stored('a.png', 'image/png')] }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
    await act(async () => { mode.setText('New words') })
    await act(async () => { mode.save() })
    await flush()
    expect(writes().map(c => c.body)).toEqual([{ text: 'New words' }])
  })

  it('Send to Tracy with no files is still v3; with files it is v4 carrying the File objects at the root', async () => {
    await mount()
    await ready()
    await pick(H1, 'No files')
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(sends[0]!.v).toBe(3)
    expect(sends[0]).not.toHaveProperty('attachments')
    const shot = png()
    await pick(STAT, 'With a file')
    await act(async () => { mode.addFiles('popover', [shot]) })
    await act(async () => { mode.sendToTracy() })
    await flush()
    const v4 = sends[1] as unknown as { v: number; attachments: File[]; items: Array<{ text: string }> }
    expect(v4.v).toBe(4)
    expect(v4.attachments).toEqual([shot])
    expect(v4.items[0]!.text).toBe('With a file')
    // Nothing was stored on the server for a Send to Tracy.
    expect(writes().map(c => c.url)).toEqual([REQUESTS, REQUESTS])
    expect(mode.draft).toEqual([])
  })

  it('Send from a thread fetches its stored files into Files; one too large to send is left out with a line in the words', async () => {
    const shot = stored('shot.png', 'image/png')
    const poster = stored('poster.png', 'image/png', 21 * 1024 * 1024)
    rows.push(serverRow({ element: { ...STAT }, text: 'Numbers are off.', author: MAI, can: { edit: false, delete: false }, attachments: [shot] }))
    rows.push(serverRow({ element: { ...STAT }, text: 'And the poster.', replyTo: 'srv-1', attachments: [poster] }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Fix both.') })
    await act(async () => { mode.sendThread() })
    await flush()
    const reads = calls.filter(c => c.method === 'GET' && c.url.includes('/attachments/')).map(c => c.url)
    expect(reads).toEqual([shot.url])
    const v4 = sends[0] as unknown as { v: number; attachments: File[]; items: Array<{ text: string }> }
    expect(v4.v).toBe(4)
    expect(v4.attachments.map(f => [f.name, f.type, f instanceof File])).toEqual([['shot.png', 'image/png', true]])
    expect(v4.items[0]!.text).toBe('Fix both.\n(poster.png not sent: too large)')
  })

  it('Send N (the Comments view) fetches each comment\'s stored files', async () => {
    const shot = stored('shot.png', 'image/png')
    rows.push(serverRow({ element: { ...H1 }, text: 'Brighter', attachments: [shot] }))
    await mount()
    await ready()
    await viewAct({ kind: 'send', ids: ['srv-1'] })
    await flush()
    const v4 = sends[0] as unknown as { v: number; attachments: File[] }
    expect(v4.v).toBe(4)
    expect(v4.attachments.map(f => f.name)).toEqual(['shot.png'])
  })

  it('the list\'s attachments field is the tab\'s: enabled false (or absent) hides the attach road', async () => {
    store = { enabled: false, maxBytes: 20 * 1024 * 1024, maxFiles: 20 }
    await mount()
    expect(mode.attachments.enabled).toBe(false)
    await act(async () => { root!.unmount() })
    root = null
    store = null
    await mount()
    expect(mode.attachments.enabled).toBe(false)
    await act(async () => { root!.unmount() })
    root = null
    store = { enabled: true, maxBytes: 5_000_000, maxFiles: 4 }
    await mount()
    expect(mode.attachments).toEqual({ enabled: true, maxBytes: 5_000_000, maxFiles: 4 })
  })

  it('the Comments view\'s add with files (page box): uploads each, then POSTs the whole-page comment with their ids', async () => {
    await mount()
    await ready()
    await viewAct({ kind: 'add', text: 'Use this logo everywhere', files: [png('logo.png')] })
    await flush()
    const w = writes()
    expect(w.map(c => [c.method, c.url])).toEqual([['POST', `${BASE}/attachments`], ['POST', BASE]])
    expect(w[1]!.body).toMatchObject({ element: null, text: 'Use this logo everywhere', attachments: ['att-1'] })
  })

  it('the Comments view\'s page send with files: POST /requests, then v4 with those files; nothing stored', async () => {
    await mount()
    await ready()
    const logo = png('logo.png')
    await viewAct({ kind: 'send', page: true, text: 'Put this logo in the header', files: [logo] })
    await flush()
    expect(writes().map(c => c.url)).toEqual([REQUESTS])
    const v4 = sends[0] as unknown as { v: number; attachments: File[]; items: Array<{ element: unknown; text: string }> }
    expect([v4.v, v4.attachments, v4.items[0]!.element, v4.items[0]!.text]).toEqual([4, [logo], null, 'Put this logo in the header'])
  })

  it('an act whose files are not files is refused whole', async () => {
    await mount()
    await ready()
    await viewAct({ kind: 'add', text: 'Words', files: ['not a file'] })
    await flush()
    expect(writes()).toEqual([])
  })

  it('tracy:comment-list carries the list\'s attachments at its root and each comment\'s files', async () => {
    const shot = stored('shot.png', 'image/png')
    rows.push(serverRow({ element: { ...H1 }, text: 'Brighter', attachments: [shot] }))
    rows.push(serverRow({ element: { ...STAT }, text: 'No files' }))
    const seen = lists()
    await mount()
    const last = seen.at(-1)!
    expect(last.attachments).toEqual({ enabled: true, maxBytes: 20 * 1024 * 1024, maxFiles: 20 })
    expect(last.comments.map(c => c.attachments)).toEqual([[shot], []])
  })

  it('a send with files waits longer for the chat\'s answer (it answers after the uploads)', async () => {
    cleanups.splice(0).forEach(c => { c() })
    const got: CommentSendDetailV3[] = []
    const l = (event: Event): void => { got.push((event as CustomEvent).detail as CommentSendDetailV3) }
    window.addEventListener(COMMENT_SEND_EVENT, l)
    cleanups.push(() => { window.removeEventListener(COMMENT_SEND_EVENT, l) })
    await mount()
    await ready()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await pick(H1, 'With a file')
    await act(async () => { mode.addFiles('popover', [png()]) })
    await act(async () => { mode.sendToTracy() })
    for (let i = 0; i < 30 && got.length === 0; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(got).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(mode.notice).toBeNull()
    expect(mode.sending).toBe(true)
    await act(async () => { window.dispatchEvent(new CustomEvent(COMMENT_SENT_EVENT, { detail: { requestId: got[0]!.requestId, sessionId: 's1', queued: false } })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mode.sending).toBe(false)
    expect(mode.notice).toBeNull()
  })

  it('files waiting in a box count as typing: the page must not reload under them', async () => {
    await mount()
    await ready()
    await fromPage({ kind: 'picked', target: H1, url: HOME })
    expect(mode.typing).toBe(false)
    await act(async () => { mode.addFiles('popover', [png()]) })
    expect(mode.typing).toBe(true)
  })
})

describe('typed words are never lost silently (round 4, acceptance v2 L03 · L05 · L10, rule 14)', () => {
  // Brian 30/09 (decided for him while he slept): Esc, Interactive and a navigation treat words in a
  // box the way a click outside does — the first attempt flashes the box and keeps it; a second attempt
  // (any of them) within DISCARD_AGAIN_MS goes ahead and drops the words. An empty box closes at once.
  const tracks = (): Array<{ id: string; selector: string; state: string }> => {
    const all = posted.map(([m]) => m as { kind: string; items?: Array<{ id: string; selector: string; state: string }> }).filter(m => m.kind === 'pick-track')
    return all.at(-1)?.items ?? []
  }
  const at = (ms: number): (() => void) => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(ms)
    return () => { spy.mockRestore() }
  }

  it('Esc with words in a new popover: the first flashes and keeps them, a second within the window drops them', async () => {
    await mount()
    await ready()
    await pick(H1, 'Half a thought')
    const flash = mode.flash
    let done = at(1_000_000)
    await act(async () => { mode.escape('parent', {}) })
    done()
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Half a thought')
    expect(mode.flash).toBe(flash + 1)
    done = at(1_000_000 + DISCARD_AGAIN_MS - 100)
    await act(async () => { mode.escape('parent', {}) })
    done()
    expect(mode.foot).toBeNull()
    expect(mode.text).toBe('')
    expect(modeNow).toBe('edit')
  })

  it('a second Esc after the window only flashes again', async () => {
    await mount()
    await ready()
    await pick(H1, 'Still here')
    let done = at(2_000_000)
    await act(async () => { mode.escape('parent', {}) })
    done()
    done = at(2_000_000 + DISCARD_AGAIN_MS + 100)
    await act(async () => { mode.escape('parent', {}) })
    done()
    expect(mode.text).toBe('Still here')
    expect(mode.flash).toBe(2)
  })

  it('Esc on an empty popover closes it at once, as before', async () => {
    await mount()
    await ready()
    await pick(H1, '')
    await act(async () => { mode.escape('parent') })
    expect(mode.foot).toBeNull()
    expect(mode.flash).toBe(0)
  })

  it('Interactive with words typed: the first press flashes and stays in Edit; the second switches and drops them', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    await act(async () => { mode.modes.selectInteractive() })
    expect(modeNow).toBe('edit')
    expect(mode.text).toBe('Draft')
    expect(mode.flash).toBe(1)
    await act(async () => { mode.modes.selectInteractive() })
    expect(modeNow).toBe('interactive')
    expect(mode.text).toBe('')
  })

  it('a reply typed in a thread card is guarded the same way (Esc and Interactive)', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root', author: MAI, can: { edit: false, delete: false } }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('and also') })
    await act(async () => { mode.escape('parent', {}) })
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.flash).toBe(1)
    await act(async () => { mode.modes.selectInteractive() })
    expect(modeNow).toBe('interactive')
    expect(mode.replyText).toBe('')
  })

  it('an edit popover guards only words that differ from what is saved', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
    expect(mode.unsaved).toBe(false)
    await act(async () => { mode.escape('parent', {}) })
    expect(mode.foot).toBeNull()
    await act(async () => { mode.editMessage('srv-1') })
    await act(async () => { mode.setText('Say hello there') })
    expect(mode.unsaved).toBe(true)
    await act(async () => { mode.escape('parent', {}) })
    expect(mode.foot).toBe('edit')
    expect(mode.flash).toBe(1)
  })

  it('mayLeave (the tab\'s address bar, Back, Forward): refused once with words typed, then allowed — and the words go', async () => {
    await mount()
    await ready()
    expect(mode.mayLeave()).toBe(true)
    await pick(H1, 'Draft')
    let allowed = true
    await act(async () => { allowed = mode.mayLeave() })
    expect(allowed).toBe(false)
    expect(mode.flash).toBe(1)
    expect(mode.text).toBe('Draft')
    await act(async () => { allowed = mode.mayLeave() })
    expect(allowed).toBe(true)
    expect(mode.foot).toBeNull()
    expect(mode.text).toBe('')
  })

  it('a reveal from the Comments view to another page is a navigation: refused once while words wait', async () => {
    rows.push(serverRow({ url: ABOUT, element: { ...STAT }, text: 'On about' }))
    await mount()
    await ready()
    await pick(H1, 'Draft')
    await viewAct({ kind: 'reveal', ids: ['srv-1'] })
    expect(mode.text).toBe('Draft')
    expect(mode.flash).toBe(1)
    await viewAct({ kind: 'reveal', ids: ['srv-1'] })
    expect(mode.text).toBe('')
    await ready(ABOUT)
    expect(mode.thread?.id).toBe('srv-1')
  })

  it('the page Esc (pick-cancel) with words typed keeps the popover, and the page is told to outline the element again', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    posted.length = 0
    await fromPage({ kind: 'pick-cancel' })
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Draft')
    expect(mode.flash).toBe(1)
    expect(kinds()).toContain('pick-start')
    expect(tracks()).toContainEqual(expect.objectContaining({ selector: H1.selector, state: 'active' }))
  })

  it('a page navigating by itself (a link, Back in the frame) with words typed: the words stay; the box waits at the top of the frame, then moves to the element if the new page has it', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    await ready(ABOUT)
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Draft')
    expect(mode.picked?.target.rect).toEqual({ x: 14, y: 4, width: 0, height: 0 })
    const item = tracks().find(i => i.state === 'active')!
    expect(item.selector).toBe(H1.selector)
    expect(kinds().at(-1)).not.toBe('pick-stop')
    await fromPage({ kind: 'pick-rect', id: item.id, rect: { x: 10, y: 300, width: 400, height: 40 } })
    expect(mode.picked?.target.rect).toEqual({ x: 10, y: 300, width: 400, height: 40 })
    await fromPage({ kind: 'pick-lost', id: item.id, reason: 'missing' })
    expect(mode.picked?.target.rect).toEqual({ x: 14, y: 4, width: 0, height: 0 })
  })

  // Round 7 (acceptance v4 IN4-1): ✕ ("Close (Esc)") is an attempt like Esc, never a drop on the first press.
  it('✕ with words in a new popover: the first flashes and keeps them, a second within the window drops them', async () => {
    await mount()
    await ready()
    await pick(H1, 'Half a thought')
    let done = at(3_000_000)
    await act(async () => { mode.close() })
    done()
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Half a thought')
    expect(mode.flash).toBe(1)
    done = at(3_000_000 + DISCARD_AGAIN_MS - 100)
    await act(async () => { mode.close() })
    done()
    expect(mode.foot).toBeNull()
    expect(mode.text).toBe('')
    expect(modeNow).toBe('edit')
  })

  it('✕ after the window only flashes again; ✕ then Esc within the window drops', async () => {
    await mount()
    await ready()
    await pick(H1, 'Still here')
    let done = at(4_000_000)
    await act(async () => { mode.close() })
    done()
    done = at(4_000_000 + DISCARD_AGAIN_MS + 100)
    await act(async () => { mode.close() })
    done()
    expect(mode.text).toBe('Still here')
    expect(mode.flash).toBe(2)
    done = at(4_000_000 + DISCARD_AGAIN_MS + 600)
    await act(async () => { mode.escape('parent', {}) })
    done()
    expect(mode.foot).toBeNull()
  })

  it('✕ on an empty popover, or an untouched edit popover, closes at once', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await pick(STAT, '')
    await act(async () => { mode.close() })
    expect(mode.foot).toBeNull()
    await act(async () => { mode.editMessage('srv-1') })
    await act(async () => { mode.close() })
    expect(mode.foot).toBeNull()
    expect(mode.flash).toBe(0)
  })

  it('✕ on an edit popover with changed words: flashes first, drops on the second', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
    await act(async () => { mode.setText('Say hello there') })
    await act(async () => { mode.close() })
    expect(mode.foot).toBe('edit')
    expect(mode.text).toBe('Say hello there')
    expect(mode.flash).toBe(1)
    await act(async () => { mode.close() })
    expect(mode.foot).toBeNull()
  })

  // Round 7 (IN4-2): a click outside only flashes; it is not an attempt, and it closes any window open.
  it('a click outside is not an attempt: the Esc after it only flashes again', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    await act(async () => { mode.clickedOutside() })
    await act(async () => { mode.escape('parent', {}) })
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Draft')
    await act(async () => { mode.escape('parent', {}) })
    expect(mode.foot).toBeNull()
  })

  it('a click outside between two attempts starts over: Esc, click outside, ✕ keeps the words', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    await act(async () => { mode.escape('parent', {}) })
    await act(async () => { mode.clickedOutside() })
    await act(async () => { mode.close() })
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Draft')
    await act(async () => { mode.modes.selectInteractive() })
    expect(modeNow).toBe('interactive')
    expect(mode.text).toBe('')
  })

  // Round 7 (IN4-3): a held Esc repeats its keydown; the repeats are the same press, never more steps.
  it('Esc held down: the repeats neither drop the words nor leave Edit', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    await act(async () => { mode.escape('parent', {}) })
    for (let i = 0; i < 5; i++) await act(async () => { mode.escape('parent', { repeat: true }) })
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Draft')
    expect(mode.flash).toBe(1)
    expect(modeNow).toBe('edit')
    // A second real press drops the words and closes the box — and stays in Edit, repeats or not.
    await act(async () => { mode.escape('parent', {}) })
    for (let i = 0; i < 5; i++) await act(async () => { mode.escape('parent', { repeat: true }) })
    expect(mode.foot).toBeNull()
    expect(modeNow).toBe('edit')
  })

  it('a page-side Esc report arriving late for a press that closed the box does not leave Edit', async () => {
    await mount()
    await ready()
    await pick(H1, '')
    let done = at(5_000_000)
    await act(async () => { mode.escape('parent', {}) })
    done()
    expect(mode.foot).toBeNull()
    done = at(5_000_000 + 400)
    await fromPage({ kind: 'pick-cancel' })
    done()
    expect(modeNow).toBe('edit')
  })

  it('a page navigating by itself with an EMPTY popover closes it, as before', async () => {
    await mount()
    await ready()
    await pick(H1, '')
    await ready(ABOUT)
    expect(mode.foot).toBeNull()
    expect(tracks().some(i => i.state === 'active')).toBe(false)
  })
})

describe('Refresh with a popover open (round 4, acceptance v2 L06)', () => {
  const tracks = (): Array<{ id: string; selector: string; text: string; state: string }> => {
    const all = posted.map(([m]) => m as { kind: string; items?: Array<{ id: string; selector: string; text: string; state: string }> }).filter(m => m.kind === 'pick-track')
    return all.at(-1)?.items ?? []
  }

  it('the reloaded page is armed again and outlines the picked element (a solid active outline); its box moves the popover', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    posted.length = 0
    await ready()
    expect(mode.foot).toBe('new')
    expect(mode.text).toBe('Draft')
    expect(kinds()).toContain('pick-start')
    const item = tracks().find(i => i.state === 'active')
    expect(item).toEqual(expect.objectContaining({ selector: H1.selector, text: H1.text }))
    await fromPage({ kind: 'pick-rect', id: item!.id, rect: { x: 100, y: 80, width: 200, height: 30 } })
    expect(mode.picked?.target.rect).toEqual({ x: 100, y: 80, width: 200, height: 30 })
    // Closing the popover takes the outline down with it (✕ twice: it holds words, round 7).
    await act(async () => { mode.close() })
    await act(async () => { mode.close() })
    expect(tracks().some(i => i.state === 'active')).toBe(false)
  })

  it('before any reload the page draws the pick itself: no tracked copy of it', async () => {
    await mount()
    await ready()
    await pick(H1, 'Draft')
    expect(tracks().some(i => i.state === 'active')).toBe(false)
  })
})

describe('the wheel over a box scrolls the page (round 4, item 8)', () => {
  const SCROLLING = ['pick', 'track', 'reveal', 'text', 'hold', 'scroll']
  const scrollTos = (): Array<{ x: number; y: number }> => posted.map(([m]) => m as { kind: string; x: number; y: number }).filter(m => m.kind === 'pick-scroll-to').map(m => ({ x: m.x, y: m.y }))
  async function readyScrolling(): Promise<void> {
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await fromPage({ kind: 'ready', features: SCROLLING, url: HOME })
    spy.mockRestore()
  }

  it('each wheel step moves the page from where it said it was; a report from the page starts from there again', async () => {
    await mount()
    await readyScrolling()
    await fromPage({ kind: 'pick-scroll', x: 0, y: 761 })
    await act(async () => { mode.wheelPage(0, 100) })
    await act(async () => { mode.wheelPage(0, 100) })
    expect(scrollTos()).toEqual([{ x: 0, y: 861 }, { x: 0, y: 961 }])
    await fromPage({ kind: 'pick-scroll', x: 0, y: 900 })
    await act(async () => { mode.wheelPage(0, -1000) })
    expect(scrollTos().at(-1)).toEqual({ x: 0, y: 0 })
  })

  it('a page that does not say where it is (no scroll feature) is not scrolled', async () => {
    await mount()
    await ready()
    await act(async () => { mode.wheelPage(0, 100) })
    expect(scrollTos()).toEqual([])
  })
})


describe('round 5: a failed save never loses words (acceptance v3 TH-2)', () => {
  it('Add comment refused as too long: the popover comes back on its element with the words, and says the limit', async () => {
    listLimits = { maxChars: 4000 }
    await mount()
    await ready()
    await pick(H1, 'Short enough for the box')
    refuseNext = { url: BASE, status: 400, code: 'COMMENT_TOO_LONG', next: 'Fix the field named in `field` and send the request again.' }
    await act(async () => { mode.addComment() })
    await flush()
    expect(mode.pageComments).toEqual([])
    expect(mode.foot).toBe('new')
    expect(mode.picked?.target.selector).toBe(H1.selector)
    expect(mode.text).toBe('Short enough for the box')
    expect(mode.saveError).toEqual({ box: 'popover', key: 'commentErrTooLong', params: { max: 4000 } })
    expect(mode.serverNotice).toBeNull()
    // Typing again clears the message; a second Add goes through.
    await act(async () => { mode.setText('Short enough for the box!') })
    expect(mode.saveError).toBeNull()
    await act(async () => { mode.addComment() })
    await flush()
    expect(mode.foot).toBeNull()
    expect(mode.pageComments.map(c => c.text)).toEqual(['Short enough for the box!'])
  })

  it('no connection: the same, in words about the connection', async () => {
    await mount()
    await ready()
    await pick(H1, 'Offline words')
    const real = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && input === BASE) throw new TypeError('Failed to fetch')
      return await real(input, init)
    }))
    await act(async () => { mode.addComment() })
    await flush()
    expect(mode.text).toBe('Offline words')
    expect(mode.saveError).toEqual({ box: 'popover', key: 'commentErrNetwork' })
  })

  it('a refused Reply comes back in its card with its words and files; the reply leaves the thread', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Numbers are off.', author: MAI, can: { edit: false, delete: false } }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Here you go') })
    refuseNext = { url: BASE, status: 429, code: 'COMMENT_RATE_LIMIT', next: 'Wait a minute.' }
    await act(async () => { mode.reply() })
    await flush()
    expect(mode.threadMessages.map(m => m.text)).toEqual(['Numbers are off.'])
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.replyText).toBe('Here you go')
    expect(mode.saveError).toEqual({ box: 'reply', key: 'commentErrRateLimit' })
  })

  it('a card closed before the refusal came opens again with the words', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Numbers are off.', author: MAI, can: { edit: false, delete: false } }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Late answer') })
    let go = (): void => {}
    slowNext = new Promise((resolve) => { go = resolve })
    refuseNext = { url: BASE, status: 401, code: 'NOT_SIGNED_IN', next: 'Sign in.' }
    await act(async () => { mode.reply() })
    await act(async () => { mode.closeThread() })
    expect(mode.thread).toBeNull()
    go()
    await flush()
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.replyText).toBe('Late answer')
    expect(mode.saveError).toEqual({ box: 'reply', key: 'commentErrSignedOut' })
  })

  it('never over words typed meanwhile: the failed words wait, and come back once that box is closed', async () => {
    await mount()
    await ready()
    await pick(H1, 'First words')
    let go = (): void => {}
    slowNext = new Promise((resolve) => { go = resolve })
    refuseNext = { url: BASE, status: 403, code: 'SEAT_NOT_AUTHORIZED', next: 'No seat.' }
    await act(async () => { mode.addComment() })
    await pick(STAT, 'Second words')
    go()
    await flush()
    expect(mode.text).toBe('Second words')
    expect(mode.picked?.target.selector).toBe(STAT.selector)
    // ✕ twice: the box holds words, so the first press only flashes it (round 7).
    await act(async () => { mode.close() })
    expect(mode.text).toBe('Second words')
    await act(async () => { mode.close() })
    await flush()
    expect(mode.text).toBe('First words')
    expect(mode.picked?.target.selector).toBe(H1.selector)
    expect(mode.saveError).toEqual({ box: 'popover', key: 'commentErrNoSeat' })
  })

  it('other refused writes (Resolve, Delete) say it in plain words, never the door\'s sentence', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    refuseNext = { url: BASE, status: 400, code: 'COMMENT_BAD_INPUT', next: 'Fix the field named in `field` and send the request again.' }
    await act(async () => { mode.resolve(['srv-1']) })
    await flush()
    expect(mode.serverNotice).toBeNull()
    expect(mode.serverError).toEqual({ key: 'commentErrUnknown' })
  })
})

describe('round 5: the character limit (acceptance v3 TH-2)', () => {
  it('4000 (the server\'s own) when the list names no limit', async () => {
    await mount()
    expect(mode.maxChars).toBe(4000)
  })

  it('the list\'s limits.maxChars is the limit; over it, Add, Send to Tracy, Reply and Save do nothing and keep the words', async () => {
    listLimits = { maxChars: 40 }
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await ready()
    expect(mode.maxChars).toBe(40)
    const long = 'x'.repeat(41)
    await pick(H1, long)
    await act(async () => { mode.addComment() })
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(mode.text).toBe(long)
    expect(mode.foot).toBe('new')
    await act(async () => { mode.close() })
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText(long) })
    await act(async () => { mode.reply() })
    await act(async () => { mode.sendThread() })
    await flush()
    expect(mode.replyText).toBe(long)
    await act(async () => { mode.closeThread() })
    await act(async () => { mode.editMessage('srv-1') })
    await act(async () => { mode.setText(long) })
    await act(async () => { mode.save() })
    await flush()
    expect(mode.foot).toBe('edit')
    expect(writes()).toEqual([])
    expect(sends).toEqual([])
    // Exactly the limit goes.
    await act(async () => { mode.setText('x'.repeat(40)) })
    await act(async () => { mode.save() })
    await flush()
    expect(writes().map(c => c.method)).toEqual(['PATCH'])
  })
})

describe('round 5: a deleted first message with replies stays a thread (acceptance v3 TH-4)', () => {
  it('its pin, the toolbar count and the list keep the thread; its card starts with the tombstone', async () => {
    const root = serverRow({ element: { ...STAT }, text: 'Please fix', deletedAt: null })
    rows.push(root, serverRow({ element: { ...STAT }, text: 'Seconded', replyTo: root.id, author: MAI, can: { edit: false, delete: false } }))
    root.deletedAt = stamp()
    const seen = lists()
    await mount()
    await ready()
    expect(mode.pageComments.map(c => [c.id, c.removed === true])).toEqual([['srv-1', true]])
    expect(mode.comments.filter(c => c.replyTo === undefined)).toHaveLength(1)
    expect(seen.at(-1)!.comments.map(c => [c.id, c.removed === true, c.replyCount])).toEqual([['srv-1', true, 1], ['srv-2', false, 0]])
    await act(async () => { mode.openThread('srv-1') })
    expect(mode.threadMessages.map(m => [m.id, m.removed === true, m.text])).toEqual([['srv-1', true, ''], ['srv-2', false, 'Seconded']])
  })

  it('Send all sends it too: no words of its own, its replies as the thread — what is sent equals the count', async () => {
    const root = serverRow({ element: { ...STAT }, text: 'Please fix', deletedAt: null })
    rows.push(root, serverRow({ element: { ...STAT }, text: 'Seconded', replyTo: root.id, author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ element: { ...H1 }, text: 'Bigger title' }))
    root.deletedAt = stamp()
    await mount()
    await ready()
    await viewAct({ kind: 'send', ids: ['srv-1', 'srv-3'] })
    expect(sends).toHaveLength(1)
    expect(sends[0]!.items.map(i => [i.commentId, i.text, (i.thread ?? []).map(t => ('text' in t ? t.text : 'sent'))])).toEqual([
      ['srv-1', '', ['Seconded']],
      ['srv-3', 'Bigger title', []],
    ])
    const request = writes().find(c => c.url === REQUESTS)!
    expect((request.body as { items: Array<{ commentId?: string; text: string }> }).items.map(i => [i.commentId, i.text])).toEqual([['srv-1', ''], ['srv-3', 'Bigger title']])
  })
})

describe('round 5: Delete all\'s Undo window hides at once (acceptance v3 TH-7)', () => {
  it('hide takes the comments off the pins and the count at once; show brings them back; clear then writes', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'One' }), serverRow({ element: { ...STAT }, text: 'Two', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Reply', replyTo: 'srv-2' }))
    await mount()
    await ready()
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1', 'srv-2'])
    await viewAct({ kind: 'hide', ids: ['srv-1', 'srv-2'] })
    expect(mode.pageComments).toEqual([])
    expect(mode.comments).toEqual([])
    expect(writes()).toEqual([])
    await viewAct({ kind: 'show', ids: ['srv-1', 'srv-2'] })
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1', 'srv-2'])
    await viewAct({ kind: 'hide', ids: ['srv-1', 'srv-2'] })
    await viewAct({ kind: 'clear', ids: ['srv-1', 'srv-2'] })
    expect(writes().map(c => c.url)).toEqual([`${BASE}/clear`])
    expect(mode.pageComments).toEqual([])
  })

  // e2e v7 INTH-1: a thread gone before the clear (a tombstone, or deleted by another seat during the
  // Undo window) made the door refuse the whole batch with 404, which the tab took for "already gone":
  // it reloaded, the rows came back, and nothing said the delete had not happened.
  function clearFailures(): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = []
    const l = (event: Event): void => { seen.push((event as CustomEvent).detail as Record<string, unknown>) }
    window.addEventListener('tracy:comment-act-failed', l)
    cleanups.push(() => { window.removeEventListener('tracy:comment-act-failed', l) })
    return seen
  }

  it('a clear naming a thread another seat deleted meanwhile deletes the rest and counts as done (INTH-1)', async () => {
    const seen = clearFailures()
    rows.push(serverRow({ element: { ...H1 }, text: 'One' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Hers', author: MAI, can: { edit: false, delete: false } }))
    rows.push(serverRow({ element: { ...H1 }, text: 'Two' }))
    await mount()
    await ready()
    await viewAct({ kind: 'hide', ids: ['srv-1', 'srv-2', 'srv-3'] })
    rows[1]!.deletedAt = stamp()
    await viewAct({ kind: 'clear', ids: ['srv-1', 'srv-2', 'srv-3'] })
    await flush()
    expect(writes().map(c => c.body)).toEqual([{ threads: ['srv-1', 'srv-2', 'srv-3'] }])
    expect(mode.comments.filter(c => c.removed !== true)).toEqual([])
    expect(seen).toEqual([])
    expect(mode.serverError).toBeNull()
  })

  it('a clear the door really refuses puts the rows back and tells the Comments view, which says it (INTH-1)', async () => {
    const seen = clearFailures()
    rows.push(serverRow({ element: { ...H1 }, text: 'One' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Two' }))
    await mount()
    await ready()
    await viewAct({ kind: 'hide', ids: ['srv-1', 'srv-2'] })
    refuseNext = { url: `${BASE}/clear`, status: 403, code: 'SEAT_NOT_AUTHORIZED', next: 'Ask the site owner for a seat.' }
    await viewAct({ kind: 'clear', ids: ['srv-1', 'srv-2'] })
    await flush()
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1', 'srv-2'])
    expect(seen).toEqual([{ tabId: 'tab-1', sessionId: 's1', kind: 'clear', ids: ['srv-1', 'srv-2'], text: '', code: 'SEAT_NOT_AUTHORIZED', next: 'Ask the site owner for a seat.' }])
    expect(mode.serverError).toBeNull()
  })

  it('an older server\'s 404 for a named clear is a failure too, never silence (INTH-1)', async () => {
    const seen = clearFailures()
    rows.push(serverRow({ element: { ...H1 }, text: 'One' }))
    await mount()
    await ready()
    refuseNext = { url: `${BASE}/clear`, status: 404, code: 'COMMENT_NOT_FOUND', next: '' }
    await viewAct({ kind: 'clear', ids: ['srv-1'] })
    await flush()
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1'])
    expect(seen.map(d => [d.kind, d.ids, d.code])).toEqual([['clear', ['srv-1'], 'COMMENT_NOT_FOUND']])
  })

  it('a hide nobody follows up (the chat column went away) lapses', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'One' }))
    await mount()
    await ready()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await viewAct({ kind: 'hide', ids: ['srv-1'] })
    expect(mode.pageComments).toEqual([])
    await act(async () => { vi.advanceTimersByTime(HIDE_LAPSE_MS + 10) })
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1'])
  })
})

describe('round 5: a thread card holds the reload only with words in it (acceptance v3 SEND-new-2)', () => {
  it('an open card with an empty reply box lets the page reload; typed words or files hold it; a popover always holds it', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    expect(mode.boxOpen).toBe(true)
    expect(mode.holdsReload).toBe(false)
    await act(async () => { mode.setReplyText('typing') })
    expect(mode.holdsReload).toBe(true)
    await act(async () => { mode.setReplyText('') })
    await act(async () => { mode.addFiles('reply', [new File(['x'], 'a.txt', { type: 'text/plain' })]) })
    expect(mode.holdsReload).toBe(true)
    await act(async () => { mode.closeThread() })
    await pick(H1, '')
    expect(mode.holdsReload).toBe(true)
  })
})

describe('round 5: pins after Refresh with a popover open (acceptance v3 INPUT-new-1)', () => {
  it('the reloaded page is told the comments again and armed; its boxes bring the pins back while the popover stays', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await ready()
    await fromPage({ kind: 'pick-rect', id: 'srv-1', rect: { x: 10, y: 300, width: 100, height: 20 } })
    expect(mode.rects.has('srv-1')).toBe(true)
    await pick(H1, 'Draft')
    posted.length = 0
    await ready()
    const track = posted.map(([m]) => m as { kind: string; items?: Array<{ id: string }> }).filter(m => m.kind === 'pick-track').at(-1)
    expect(track?.items?.map(i => i.id)).toContain('srv-1')
    expect(kinds()).toContain('pick-start')
    await fromPage({ kind: 'pick-rect', id: 'srv-1', rect: { x: 10, y: 300, width: 100, height: 20 } })
    expect(mode.pageComments.map(c => c.id)).toEqual(['srv-1'])
    expect(mode.rects.get('srv-1')).toEqual({ x: 10, y: 300, width: 100, height: 20 })
    expect(mode.foot).toBe('new')
  })
})

describe('round 5: a comment whose words were changed keeps its element (acceptance v3 TH-11)', () => {
  it('a `changed` report tracks it again by its selector alone, so its pin and card come back at the element', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await ready()
    await fromPage({ kind: 'pick-lost', id: 'srv-1', reason: 'changed' })
    const track = posted.map(([m]) => m as { kind: string; items?: Array<{ id: string; text: string }> }).filter(m => m.kind === 'pick-track').at(-1)
    expect(track?.items?.find(i => i.id === 'srv-1')?.text).toBe('')
    await fromPage({ kind: 'pick-rect', id: 'srv-1', rect: { x: 10, y: 300, width: 100, height: 20 } })
    expect(mode.rects.get('srv-1')).toEqual({ x: 10, y: 300, width: 100, height: 20 })
  })

  it('a `missing` element is not guessed at', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await ready()
    posted.length = 0
    await fromPage({ kind: 'pick-lost', id: 'srv-1', reason: 'missing' })
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'pick-track')).toEqual([])
  })
})

describe('round 5: a site with no Content API is not asked per pick (server round 5)', () => {
  it('after the warm says `unavailable`, picks, adds and sends ask content.locate no more on that page', async () => {
    applyAnswer = { status: 'unavailable', code: 'CONTENT_ADAPTER_UNSUPPORTED' }
    await mount()
    await ready()
    await flush()
    expect(applies.map(a => a.params.warm === true)).toEqual([true])
    await pick(H1, 'One')
    await act(async () => { mode.addComment() })
    await flush()
    await pick(STAT, 'Two')
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(applies).toHaveLength(1)
  })

  it('a site that answers keeps being asked', async () => {
    applyAnswer = { status: 'found' }
    await mount()
    await ready()
    await pick(H1, 'One')
    await flush()
    expect(applies.length).toBeGreaterThan(1)
  })
})

describe('round 5: the Comments view\'s page box (chat-input fix/comment-r5-chat)', () => {
  function failures(): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = []
    const l = (event: Event): void => { seen.push((event as CustomEvent).detail as Record<string, unknown>) }
    window.addEventListener('tracy:comment-act-failed', l)
    cleanups.push(() => { window.removeEventListener('tracy:comment-act-failed', l) })
    return seen
  }

  it('an `add` the door refuses is handed back: tracy:comment-act-failed {tabId, kind, text, code, next}', async () => {
    const seen = failures()
    await mount()
    await ready()
    refuseNext = { url: BASE, status: 429, code: 'COMMENT_RATE_LIMIT', next: 'You are writing comments very fast; your text is kept.' }
    await viewAct({ kind: 'add', text: 'Whole page words' })
    await flush()
    expect(seen).toEqual([{ tabId: 'tab-1', sessionId: 's1', kind: 'add', text: 'Whole page words', code: 'COMMENT_RATE_LIMIT', next: 'You are writing comments very fast; your text is kept.' }])
    expect(mode.comments).toEqual([])
    expect(mode.serverError).toBeNull()
  })

  it('an `add` longer than the limit is not sent at all, and is handed back as COMMENT_TOO_LONG', async () => {
    listLimits = { maxChars: 10 }
    const seen = failures()
    await mount()
    await ready()
    await viewAct({ kind: 'add', text: 'x'.repeat(11) })
    expect(writes()).toEqual([])
    expect(seen).toEqual([{ tabId: 'tab-1', sessionId: 's1', kind: 'add', text: 'x'.repeat(11), code: 'COMMENT_TOO_LONG' }])
  })

  // Round 11 (acceptance v5 IN5-1): the page box empties when it hands its words over; a failed page
  // `send` said nothing back, so the words were gone for good (the network down, a refusal, no answer).
  it('a page `send` with the network down is handed back: tracy:comment-act-failed {kind: send, text, files, code NETWORK}', async () => {
    const seen = failures()
    await mount()
    await ready()
    offline = true
    const png = new File(['PNG'], 'page.png', { type: 'image/png' })
    await viewAct({ kind: 'send', page: true, text: 'Page words', files: [png] })
    await flush()
    expect(sends).toEqual([])
    expect(seen).toEqual([{ tabId: 'tab-1', sessionId: 's1', kind: 'send', text: 'Page words', files: [png], code: 'NETWORK' }])
    // The view says it by the box: no far-away "Not sent." over the page.
    expect(mode.serverNotice).toBeNull()
  })

  it('a page `send` the request door refuses is handed back with the door\'s code and sentence', async () => {
    const seen = failures()
    await mount()
    await ready()
    refuseNext = { url: REQUESTS, status: 403, code: 'SEAT_REQUIRED', next: 'Ask the owner for a seat.' }
    await viewAct({ kind: 'send', page: true, text: 'Page words' })
    await flush()
    expect(seen).toEqual([{ tabId: 'tab-1', sessionId: 's1', kind: 'send', text: 'Page words', code: 'SEAT_REQUIRED', next: 'Ask the owner for a seat.' }])
  })

  it('a page `send` the chat does not take is handed back with the chat\'s code', async () => {
    const seen = failures()
    chatAnswer = 'failed'
    await mount()
    await ready()
    await viewAct({ kind: 'send', page: true, text: 'Page words' })
    await flush()
    expect(seen).toEqual([{ tabId: 'tab-1', sessionId: 's1', kind: 'send', text: 'Page words', code: 'no-session' }])
    // verify6 L5: the page box says why itself; the same words over the page as well would show twice.
    expect(mode.notice).toBeNull()
  })

  it('a page `add` with the network down is handed back with its files', async () => {
    const seen = failures()
    await mount()
    await ready()
    offline = true
    const png = new File(['PNG'], 'page.png', { type: 'image/png' })
    await viewAct({ kind: 'add', text: 'Page words', files: [png] })
    await flush()
    expect(seen).toEqual([{ tabId: 'tab-1', sessionId: 's1', kind: 'add', text: 'Page words', files: [png], code: 'NETWORK' }])
  })

  it('the list tells the view the server\'s limit (limits.maxChars)', async () => {
    listLimits = { maxChars: 3000 }
    const seen = lists()
    await mount()
    await flush()
    expect(seen.at(-1)!.limits).toEqual({ maxChars: 3000 })
  })
})

describe('round 6: one act, one controller — the conversation on screen (acceptance v4 SEND-v4-new-1)', () => {
  // dsh mints native tab ids per conversation (`tab1`, `tab2`, …), so the Browser tab of the conversation
  // left behind — kept mounted since round 5 — can carry the SAME id as the one on screen.
  let other: CommentMode
  let otherFrame: HTMLIFrameElement
  function Pair(props: { shown: 's1' | 's2' }) {
    const [api] = useState(() => createCommentApi({ siteKey: 'northgate' }))
    const [apiB] = useState(() => createCommentApi({ siteKey: 'northgate' }))
    const common = { url: HOME, tracySite: true, domainsKnown: true, viaHost: false, edit: true, setMode: () => {}, tabId: 'tab-1' }
    mode = useCommentMode({ ...common, frameRef: { current: iframe }, sessionId: 's1', api, active: props.shown === 's1', conversationShown: props.shown === 's1' })
    other = useCommentMode({ ...common, frameRef: { current: otherFrame }, sessionId: 's2', api: apiB, active: props.shown === 's2', conversationShown: props.shown === 's2' })
    return null
  }
  async function mountPair(shown: 's1' | 's2' = 's1'): Promise<void> {
    otherFrame = document.createElement('iframe')
    document.body.append(otherFrame)
    ;(otherFrame.contentWindow as Window).postMessage = (() => {}) as Window['postMessage']
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(Pair, { shown })) })
    await flush()
  }
  async function show(shown: 's1' | 's2'): Promise<void> {
    await act(async () => { root!.render(createElement(Pair, { shown })) })
    await flush()
  }

  it('the page box\'s send goes out ONCE, from the conversation on screen', async () => {
    await mountPair()
    await viewAct({ kind: 'send', page: true, text: 'Warmer colours everywhere' })
    expect(sends.map(s => s.sessionId)).toEqual(['s1'])
    expect(writes().map(c => c.url)).toEqual([REQUESTS])
  })

  it('"Send all" goes out ONCE; add makes ONE comment', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'First' }))
    await mountPair()
    await viewAct({ kind: 'send', ids: ['srv-1'] })
    expect(sends.map(s => s.sessionId)).toEqual(['s1'])
    await viewAct({ kind: 'add', text: 'The whole page feels cold' })
    expect(writes().filter(c => c.url === BASE)).toHaveLength(1)
  })

  it('after a switch away and back, still one — the left conversation never answers', async () => {
    await mountPair()
    await show('s2')
    await show('s1')
    await viewAct({ kind: 'send', page: true, text: 'Only here' })
    expect(sends.map(s => s.sessionId)).toEqual(['s1'])
    await show('s2')
    await viewAct({ kind: 'send', page: true, text: 'Now the other one' })
    expect(sends.map(s => s.sessionId)).toEqual(['s1', 's2'])
  })

  it('an act carrying `sessionId` (chat-input round 6): the tab with BOTH that tabId and that session acts, once', async () => {
    await mountPair()
    await viewAct({ kind: 'send', page: true, text: 'For s1', sessionId: 's1' })
    expect(sends.map(s => s.sessionId)).toEqual(['s1'])
    await viewAct({ kind: 'send', page: true, text: 'Named s2', sessionId: 's2' })
    expect(sends.map(s => s.sessionId)).toEqual(['s1', 's2'])
    await viewAct({ kind: 'send', page: true, text: 'No such conversation', sessionId: 's9' })
    await viewAct({ tabId: 'tab-9', kind: 'send', page: true, text: 'No such tab', sessionId: 's1' })
    expect(sends).toHaveLength(2)
  })

  it('an act WITHOUT `sessionId` (an older sender): only the tab of the conversation on screen acts', async () => {
    await mountPair('s2')
    await viewAct({ kind: 'send', page: true, text: 'No session named' })
    expect(sends.map(s => s.sessionId)).toEqual(['s2'])
  })

  it('a `list` ask is answered by the conversation on screen only; the other stays silent', async () => {
    await mountPair()
    const seen = lists()
    await viewAct({ tabId: '', kind: 'list' })
    expect(seen.map(l => [l.sessionId, l.active])).toEqual([['s1', true]])
  })

  it('leaving a conversation says `active: false` once, before the shown one speaks; then it is silent', async () => {
    await mountPair()
    const seen = lists()
    await show('s2')
    expect(seen.filter(l => l.sessionId === 's1').map(l => l.active)).toEqual([false])
    // The list the shown one says comes AFTER the retirement of the one left (they share the tab id).
    expect(seen.at(-1)).toMatchObject({ sessionId: 's2', active: true })
    seen.length = 0
    await viewAct({ tabId: '', kind: 'list' })
    expect(seen.map(l => l.sessionId)).toEqual(['s2'])
  })
})

describe('round 6: another seat\'s write at the same moment is never skipped (acceptance v4 thread)', () => {
  // A and B reply to the same thread at the same moment: B's reply lands on the server a moment BEFORE A's
  // own write answers. The poll cursor moved to A's own write's time skipped B's reply until a reload.
  it('a reply by someone else just before my own reply is shown after my write (and goes with a send)', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Root' }))
    await mount()
    await ready()
    rows.push(serverRow({ replyTo: 'srv-1', text: 'Mai at the same moment', author: MAI, can: { edit: false, delete: false } }))
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Lee at the same moment') })
    await act(async () => { mode.reply() })
    await flush()
    expect(mode.comments.map(c => c.text)).toEqual(['Root', 'Mai at the same moment', 'Lee at the same moment'])
    await viewAct({ kind: 'send', ids: ['srv-1'] })
    expect(JSON.stringify(sends.at(-1)!.items[0])).toContain('Mai at the same moment')
  })

  it('a Resolve by someone else 0.3 s before my own write is seen', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'First' }))
    rows.push(serverRow({ element: { ...STAT }, text: 'Second' }))
    await mount()
    await ready()
    Object.assign(rows[0]!, { status: 'resolved', resolvedAt: stamp(), resolvedBy: MAI, updatedAt: stamp() })
    await act(async () => { mode.addGeneral('my own write') })
    await flush()
    expect(mode.comments.find(c => c.id === 'srv-1')?.status).toBe('resolved')
  })

  it('a row the server commits late with an earlier time (its transaction began first) is still picked up', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Root' }))
    await mount()
    await ready()
    // The row is stamped now but only becomes visible after the next poll has already passed its time.
    const late = serverRow({ replyTo: 'srv-1', text: 'late commit', author: MAI, can: { edit: false, delete: false } })
    await act(async () => { mode.addGeneral('poke one') })
    await flush()
    rows.push(late)
    await act(async () => { mode.addGeneral('poke two') })
    await flush()
    expect(mode.comments.map(c => c.text)).toContain('late commit')
  })
})

describe('round 10: the page\'s pins and the wheel over a box (acceptance v5 PICK-new-13, B04)', () => {
  const lastTrack = (): string[] => ((posted.map(([m]) => m as { kind: string; items?: Array<{ id: string }> }).filter(m => m.kind === 'pick-track').at(-1)?.items) ?? []).map(i => i.id)
  async function readyWith(features: string[]): Promise<void> {
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await fromPage({ kind: 'ready', features, url: HOME })
    spy.mockRestore()
  }
  const fourteen = (): void => {
    for (let i = 0; i < 14; i += 1) rows.push(serverRow({ element: { ...target(`#e${String(i)}`, `Block ${String(i)}`) }, text: `c${String(i)}` }))
  }

  it('a runtime-15 page gets 12; a page naming pins60 gets all 14', async () => {
    fourteen()
    await mount()
    await readyWith(['pick', 'track', 'reveal', 'text'])
    expect(lastTrack()).toHaveLength(12)
    await readyWith(['pick', 'track', 'reveal', 'text', 'pins60'])
    expect(lastTrack()).toHaveLength(14)
  })

  it('comments the page reports missing give their slots to the oldest one it can find', async () => {
    fourteen()
    await mount()
    await readyWith(['pick', 'track', 'reveal', 'text'])
    expect(lastTrack()).not.toContain('srv-1')
    for (let n = 4; n <= 14; n += 1) await fromPage({ kind: 'pick-lost', id: `srv-${String(n)}`, reason: 'missing' })
    expect(lastTrack()).toContain('srv-1')
    expect(lastTrack()).toContain('srv-2')
    expect(lastTrack()).toHaveLength(12)
  })

  it('the wheel over a box goes to the page as pick-wheel when it names wheel — for the pick, or a comment by id', async () => {
    await mount()
    await readyWith(['pick', 'track', 'reveal', 'text', 'hold', 'scroll', 'wheel'])
    await act(async () => { mode.wheelPage(0, 100) })
    await act(async () => { mode.wheelPage(0, -40, 'srv-9') })
    const wheels = posted.filter(([m]) => (m as { kind: string }).kind === 'pick-wheel').map(([m, origin]) => [m, origin])
    expect(wheels).toEqual([
      [{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-wheel', dx: 0, dy: 100 }, SITE],
      [{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-wheel', dx: 0, dy: -40, id: 'srv-9' }, SITE],
    ])
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'pick-scroll-to')).toEqual([])
  })
})

describe('round 11: someone else deletes the comment while words wait in its box (acceptance v5 V5-3)', () => {
  const png = new File(['PNG'], 'draft.png', { type: 'image/png' })
  /** Delete all on the page by another seat, seen at this tab's next poll. */
  async function deletedElsewhere(): Promise<void> {
    for (const r of rows) if (r.deletedAt === null) { r.deletedAt = stamp(); r.updatedAt = r.deletedAt }
    // Any write of this tab polls after it (a whole-page comment: no element, no pin).
    await act(async () => { mode.addGeneral('poke') })
    await flush()
  }
  async function cardWithWords(): Promise<void> {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root by Mai', author: MAI, can: { edit: false, delete: false } }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('My reply draft') })
    await act(async () => { mode.addFiles('reply', [png]) })
  }

  it('the card stays open with the words, the files and the messages it showed, and says the comment was deleted', async () => {
    await cardWithWords()
    await deletedElsewhere()
    expect(mode.comments.some(c => c.id === 'srv-1')).toBe(false)
    expect(mode.lost).toBe('thread')
    expect(mode.thread?.id).toBe('srv-1')
    expect(mode.threadMessages.map(m => m.text)).toEqual(['Root by Mai'])
    expect(mode.replyText).toBe('My reply draft')
    expect(mode.replyDraft.map(d => (d.kind === 'file' ? d.file.name : ''))).toEqual(['draft.png'])
    // It holds what a box with words holds: the reload, the typing state, the page's clicks.
    expect([mode.typing, mode.holdsReload, mode.boxOpen, mode.unsaved]).toEqual([true, true, true, true])
  })

  it('"Send to Tracy": the words and files go to the chat about the same element, with no comment id; the card closes', async () => {
    await cardWithWords()
    await deletedElsewhere()
    const before = writes().length
    await act(async () => { mode.sendLost() })
    await flush()
    const sent = writes().slice(before)
    expect(sent.map(c => [c.method, c.url])).toEqual([['POST', REQUESTS]])
    expect(sends.at(-1)!.items).toHaveLength(1)
    const item = sends.at(-1)!.items[0]!
    expect(item).toMatchObject({ url: HOME, text: 'My reply draft', element: { selector: 'main > .stat' } })
    expect(item).not.toHaveProperty('commentId')
    expect(mode.lost).toBeNull()
    expect(mode.thread).toBeNull()
    expect(mode.replyText).toBe('')
  })

  it('"Add as new comment": a new people comment on the same element with the words and files; the card closes', async () => {
    await cardWithWords()
    await deletedElsewhere()
    const before = writes().length
    await act(async () => { mode.addLost() })
    await flush()
    const posts = writes().slice(before).filter(c => c.url === BASE)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toMatchObject({ url: HOME, text: 'My reply draft', element: { selector: 'main > .stat' } })
    expect((posts[0]!.body as { replyTo?: unknown }).replyTo ?? null).toBeNull()
    expect(writes().slice(before).some(c => c.url === `${BASE}/attachments`)).toBe(true)
    expect(mode.lost).toBeNull()
    expect(mode.thread).toBeNull()
    expect(mode.pageComments.filter(c => c.element !== null).map(c => c.text)).toEqual(['My reply draft'])
  })

  it('"Discard": the card closes, the words go, nothing is written', async () => {
    await cardWithWords()
    await deletedElsewhere()
    const before = writes().length
    await act(async () => { mode.discardLost() })
    await flush()
    expect(writes().length).toBe(before)
    expect([mode.lost, mode.thread, mode.replyText, mode.typing]).toEqual([null, null, '', false])
  })

  it('an empty reply box: the card closes quietly, as before', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root by Mai', author: MAI, can: { edit: false, delete: false } }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await deletedElsewhere()
    expect([mode.lost, mode.thread]).toEqual([null, null])
  })

  it('the words stay while the person empties and retypes them: the card does not vanish mid-edit', async () => {
    await cardWithWords()
    await deletedElsewhere()
    await act(async () => { mode.setReplyText('') })
    await act(async () => { mode.removeDraft('reply', mode.replyDraft[0]!.key) })
    expect([mode.lost, mode.thread?.id]).toEqual(['thread', 'srv-1'])
  })

  it('an edit popover whose comment is deleted under changed words keeps them the same way, and Add makes a new comment on its element', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
    await act(async () => { mode.setText('Say hello, warmly') })
    await deletedElsewhere()
    expect(mode.foot).toBe('edit')
    expect(mode.lost).toBe('edit')
    expect(mode.editing?.id).toBe('srv-1')
    expect(mode.text).toBe('Say hello, warmly')
    const before = writes().length
    await act(async () => { mode.addLost() })
    await flush()
    const posts = writes().slice(before).filter(c => c.url === BASE)
    expect(posts.map(c => c.body)).toMatchObject([{ text: 'Say hello, warmly', element: { selector: 'main > h1' } }])
    expect([mode.foot, mode.lost, mode.text]).toEqual([null, null, ''])
  })

  it('an edit popover whose words were not changed closes quietly, as before', async () => {
    rows.push(serverRow({ element: { ...H1 }, text: 'Say hello' }))
    await mount()
    await ready()
    await act(async () => { mode.editMessage('srv-1') })
    await deletedElsewhere()
    expect([mode.foot, mode.lost]).toEqual([null, null])
  })
})

describe('round 11: a send from a box that could not reach the server says why in the box (acceptance v5 IN5-5)', () => {
  const OFFLINE = 'commentErrNotSentNetwork'
  it('the popover: the words stay, and the box says "Not sent. Check your connection and try again."; nothing floats over the page', async () => {
    await mount()
    await ready()
    await pick(H1, 'Make it orange.')
    offline = true
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(mode.text).toBe('Make it orange.')
    expect(mode.saveError).toEqual({ box: 'popover', key: OFFLINE })
    expect(mode.serverNotice).toBeNull()
    // Typing again clears it; a send that goes clears it too.
    offline = false
    await act(async () => { mode.sendToTracy() })
    await flush()
    expect(mode.saveError).toBeNull()
  })

  it('the thread card\'s reply box the same way', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Please update it.') })
    offline = true
    await act(async () => { mode.sendThread() })
    await flush()
    expect(mode.replyText).toBe('Please update it.')
    expect(mode.saveError).toEqual({ box: 'reply', key: OFFLINE })
    expect(mode.serverNotice).toBeNull()
  })
})

describe('round 11: a send never waits for content.locate (acceptance v5 IN5-7)', () => {
  it('Reply\'s Send to Tracy goes within a moment although the index is slow; the answer, when it comes, is kept for the next send', async () => {
    rows.push(serverRow({ element: { ...STAT }, text: 'Root' }))
    await mount()
    await ready()
    await act(async () => { mode.openThread('srv-1') })
    await act(async () => { mode.setReplyText('Please update it.') })
    let answer!: () => void
    slowLocate = new Promise((resolve) => { answer = resolve })
    applyAnswer = { status: 'resolved', kind: 'field', write: { field: 'stat' } }
    const started = Date.now()
    await act(async () => { mode.sendThread() })
    for (let i = 0; i < 40 && sends.length === 0; i += 1) await act(async () => { await new Promise(r => setTimeout(r, 25)) })
    expect(sends).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(1_000)
    answer()
    await flush()
    expect(mode.comments.find(c => c.id === 'srv-1')?.locate).toEqual(applyAnswer)
  })
})

describe('round 11: the page moves on by itself to a page with the same element (acceptance v5 IN5-3)', () => {
  const FEATURES = ['pick', 'track', 'reveal', 'text', 'scroll']
  const scrollTos = (): Array<{ x: number; y: number }> => posted.map(([m]) => m as { kind: string; x: number; y: number }).filter(m => m.kind === 'pick-scroll-to')
  const active = (): string => (posted.map(([m]) => m as { kind: string; items?: Array<{ id: string; state: string }> }).filter(m => m.kind === 'pick-track').at(-1)?.items ?? []).find(i => i.state === 'active')!.id
  async function announce(url: string): Promise<void> {
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await fromPage({ kind: 'ready', features: FEATURES, url })
    spy.mockRestore()
  }
  beforeEach(() => { Object.defineProperty(iframe, 'clientHeight', { value: 900, configurable: true }) })

  it('the element found below the fold of the new page: the page is scrolled to it once, so the popover and its outline are in view', async () => {
    await mount()
    await announce(HOME)
    await pick(H1, 'Draft')
    await announce(ABOUT)
    expect(mode.text).toBe('Draft')
    const id = active()
    await fromPage({ kind: 'pick-rect', id, rect: { x: 100, y: 1361, width: 200, height: 30 } })
    expect(scrollTos()).toEqual([{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-scroll-to', x: 0, y: 1361 - 225 }])
    // The page's next reports (as it scrolls) move the box, and ask for nothing more.
    await fromPage({ kind: 'pick-rect', id, rect: { x: 100, y: 225, width: 200, height: 30 } })
    expect(scrollTos()).toHaveLength(1)
    expect(mode.picked?.target.rect).toEqual({ x: 100, y: 225, width: 200, height: 30 })
  })

  it('the element already in view: nothing is scrolled', async () => {
    await mount()
    await announce(HOME)
    await pick(H1, 'Draft')
    await announce(ABOUT)
    await fromPage({ kind: 'pick-rect', id: active(), rect: { x: 100, y: 300, width: 200, height: 30 } })
    expect(scrollTos()).toEqual([])
  })

  it('the same page reloaded (Refresh) is left where the browser put it', async () => {
    await mount()
    await announce(HOME)
    await pick(H1, 'Draft')
    await announce(HOME)
    await fromPage({ kind: 'pick-rect', id: active(), rect: { x: 100, y: 1361, width: 200, height: 30 } })
    expect(scrollTos()).toEqual([])
  })
})

describe('a page with no picker still says where it is (runtime 18 `address`; TCH e2e v7 ADDR-6…12)', () => {
  // A document without the picker (its continuation lapsed, or the ticket never came) announces
  // `ready {features:['address','route'], url}` and nothing else. The address bar follows it; so must
  // everything this tab calls "the current page": the Comments list, "Comments N", the pins and the url
  // a new comment is saved with.
  const SERVICES = `${SITE}/services`
  const ADDRESS_ONLY = ['address', 'route']

  /** A document of the frame that has no picker, at `url`: its load, then its address-only `ready`. */
  async function noPicker(url: string): Promise<void> {
    await act(async () => { mode.onFrameLoad() })
    await fromPage({ kind: 'ready', features: ADDRESS_ONLY, url })
  }

  it('the current page, the list, the count and a new whole-page comment follow an address-only ready', async () => {
    rows.push(serverRow({ url: HOME, text: 'On the home page' }))
    const seen = lists()
    await mount({ start: 'interactive' })
    await ready()
    expect(mode.pageUrl).toBe(HOME)
    await noPicker(SERVICES)
    expect(mode.pageUrl).toBe(SERVICES)
    expect(mode.pageComments).toEqual([])
    expect(seen.at(-1)!.url).toBe(SERVICES)
    await noPicker(`${SITE}/contact`)
    expect(mode.pageUrl).toBe(`${SITE}/contact`)
    await act(async () => { mode.addGeneral('About this page') })
    await flush()
    expect(writes().map(c => [c.method, c.url, (c.body as { url?: string }).url])).toEqual([['POST', BASE, `${SITE}/contact`]])
  })

  /** In Edit with the picker at HOME, scrolled; the picker lapses and the page goes on to `where` by itself. */
  async function lapseTo(where: string[]): Promise<void> {
    rows.push(serverRow({ url: HOME, element: { ...H1 }, text: 'On the heading' }))
    await mount()
    await act(async () => { mode.onFrameLoad() })
    const first = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await fromPage({ kind: 'ready', features: ['pick', 'track', 'reveal', 'text', 'scroll'], url: HOME })
    first.mockRestore()
    await fromPage({ kind: 'pick-rect', id: 'srv-1', rect: { x: 10, y: 20, width: 100, height: 30 } })
    await fromPage({ kind: 'pick-scroll', x: 0, y: 900 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    for (const url of where) await noPicker(url)
    later.mockRestore()
  }

  it('the recovery reloads the page the person is on, never the last page that had a picker', async () => {
    await lapseTo([ABOUT, SERVICES])
    await act(async () => { vi.advanceTimersByTime(RECOVERY_WAIT_MS + 10) })
    vi.useRealTimers()
    await flush()
    const loaded = new URL(mode.frameSrc!)
    expect(`${loaded.origin}${loaded.pathname}`).toBe(SERVICES)
    expect(loaded.searchParams.get('tracy_preview')).toBe('pv1.T')
    // The scroll of the home page is not handed to another page.
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_000)
    await fromPage({ kind: 'ready', features: ['pick', 'track', 'reveal', 'text', 'scroll'], url: SERVICES })
    spy.mockRestore()
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'pick-scroll-to')).toEqual([])
    expect(mode.pageUrl).toBe(SERVICES)
  })

  it('the last page\'s pins go with it: none drawn, none opened, and none brought back once a picker returns elsewhere', async () => {
    await lapseTo([SERVICES])
    vi.useRealTimers()
    expect(mode.rects.size).toBe(0)
    expect(mode.pageComments).toEqual([])
    // The page with no picker cannot report a box, and a stray report is not believed.
    await fromPage({ kind: 'pick-rect', id: 'srv-1', rect: { x: 10, y: 20, width: 100, height: 30 } })
    expect(mode.rects.size).toBe(0)
    // The picker is back on /services: only its own comments are tracked (none here).
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_000)
    await fromPage({ kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url: SERVICES })
    spy.mockRestore()
    await fromPage({ kind: 'pick-rect', id: 'srv-1', rect: { x: 10, y: 20, width: 100, height: 30 } })
    expect(mode.rects.size).toBe(0)
    expect(mode.pageComments).toEqual([])
    const tracks = posted.filter(([m]) => (m as { kind: string }).kind === 'pick-track')
    expect((tracks.at(-1)![0] as { items: unknown[] }).items).toEqual([])
  })

  it('an open thread card of the last page closes when the page changes under it', async () => {
    await lapseTo([])
    vi.useRealTimers()
    await act(async () => { mode.openThread('srv-1') })
    expect(mode.thread?.id).toBe('srv-1')
    await noPicker(SERVICES)
    expect(mode.thread).toBeNull()
  })

  it('Edit on a page with no picker says it cannot pick there; Reload asks a new ticket for the page the person is on', async () => {
    await lapseTo([SERVICES])
    vi.useRealTimers()
    expect(mode.modes.edit).toBe(true)
    expect(mode.modes.unavailable).toBe(true)
    const asked = (): number => vi.mocked(fetch).mock.calls.filter(([input]) => input === '/api/sites/northgate/preview-ticket').length
    const before = asked()
    await act(async () => { mode.modes.reload() })
    await flush()
    expect(asked()).toBe(before + 1)
    const loaded = new URL(mode.frameSrc!)
    expect(`${loaded.origin}${loaded.pathname}`).toBe(SERVICES)
    expect(loaded.searchParams.get('tracy_preview')).toBe('pv1.T')
    await act(async () => { mode.onFrameLoad() })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_000)
    await fromPage({ kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url: SERVICES })
    spy.mockRestore()
    expect(mode.modes.unavailable).toBe(false)
  })

  it('in Interactive a page with no picker offers no Edit, as before', async () => {
    await mount({ start: 'interactive' })
    await noPicker(ABOUT)
    expect(mode.modes.visible).toBe(false)
    expect(mode.modes.unavailable).toBe(false)
    expect(mode.pageUrl).toBe(ABOUT)
  })

  it('an address-only ready from another origin, or naming another origin, moves nothing', async () => {
    await mount({ start: 'interactive' })
    await ready()
    await fromPage({ kind: 'ready', features: ADDRESS_ONLY, url: 'https://evil.example/x' })
    expect(mode.pageUrl).toBe(HOME)
    await act(async () => {
      const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'ready', features: ADDRESS_ONLY, url: 'https://evil.example/x' }, origin: 'https://evil.example' })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)
    })
    await flush()
    expect(mode.pageUrl).toBe(HOME)
  })
})
