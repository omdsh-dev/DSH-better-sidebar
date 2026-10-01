// @vitest-environment jsdom
/**
 * Comment mode's three calls (Tracy, 27/09/2026): the ticket door, `content.locate` through the
 * Apply door (and Send's bounded wait for it), and the `tracy:comment-send` round trip with the chat
 * input — each with its stubs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCATE_TIMEOUT_MS, isUnavailable, locateElement, requestPreviewTicket, sendCommentToChat, waitForLocate, warmLocate } from '../src/client/comment-client.ts'
import { COMMENT_FAILED_EVENT, COMMENT_SEND_EVENT, COMMENT_SENT_EVENT, type CommentSendDetail } from '../src/client/comment-model.ts'

afterEach(() => { vi.useRealTimers() })

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init?: RequestInit }> = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, init })
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

describe('the ticket door', () => {
  it('POSTs the parent origin to the root door and reads the ticket', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const answer = await requestPreviewTicket({ siteKey: 'north gate', parentOrigin: 'https://cowork.tracy.ai', fetchImpl: fakeFetch(200, { ticket: 'pv1.a.b', exp: 99 }, seen) })
    expect(answer).toEqual({ kind: 'ticket', ticket: 'pv1.a.b', exp: 99 })
    expect(seen[0]!.url).toBe('/api/sites/north%20gate/preview-ticket')
    expect(seen[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ parentOrigin: 'https://cowork.tracy.ai' })
  })

  it('404 = feature off, 403 = no button, a throw or a hang = load without it', async () => {
    expect(await requestPreviewTicket({ siteKey: 'k', parentOrigin: 'o', fetchImpl: fakeFetch(404, { code: 'NOT_FOUND' }) })).toEqual({ kind: 'off' })
    expect(await requestPreviewTicket({ siteKey: 'k', parentOrigin: 'o', fetchImpl: fakeFetch(403, { code: 'ROLE_CANNOT_EDIT' }) })).toEqual({ kind: 'refused' })
    expect(await requestPreviewTicket({ siteKey: 'k', parentOrigin: 'o', fetchImpl: async () => { throw new Error('offline') } })).toEqual({ kind: 'error' })
    const hang = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    expect(await requestPreviewTicket({ siteKey: 'k', parentOrigin: 'o', fetchImpl: hang, timeoutMs: 20 })).toEqual({ kind: 'error' })
  })
})

describe('content.locate', () => {
  it('asks the Apply door with the content.locate action and returns the answer', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const body = await locateElement({ siteKey: 'k', params: { url: 'https://a/', text: 'Services' }, fetchImpl: fakeFetch(200, { status: 'resolved', levels: [] }, seen) })
    expect(body).toEqual({ status: 'resolved', levels: [] })
    expect(seen[0]!.url).toBe('/api/sites/k/apply')
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ action: 'content.locate', params: { url: 'https://a/', text: 'Services' } })
  })

  it('asks nothing for an element with no text, no image and no marks (the door answers 400 LOCATE_BAD_QUERY)', async () => {
    // Stand E2E round 2, V2-L0: a click on an empty header box sent six 400s into the browser log.
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const params = { url: 'https://a/', text: '  ', image: null, marks: [], domPath: 'header > div', selector: 'header > div' }
    expect(await locateElement({ siteKey: 'k', params, fetchImpl: fakeFetch(400, { code: 'LOCATE_BAD_QUERY' }, seen) })).toBeNull()
    expect(seen).toEqual([])
    // Any one of the three is a query.
    await locateElement({ siteKey: 'k', params: { ...params, marks: ['menu-item:1'] }, fetchImpl: fakeFetch(200, {}, seen) })
    await locateElement({ siteKey: 'k', params: { ...params, image: { src: 'https://a/x.jpg', alt: '' } }, fetchImpl: fakeFetch(200, {}, seen) })
    expect(seen).toHaveLength(2)
  })

  it('unwraps a relayed {ok, result} and gives null on a refusal', async () => {
    expect(await locateElement({ siteKey: 'k', params: { text: 'Services' }, fetchImpl: fakeFetch(200, { ok: true, result: { status: 'unknown', levels: [] } }) })).toEqual({ status: 'unknown', levels: [] })
    expect(await locateElement({ siteKey: 'k', params: { text: 'Services' }, fetchImpl: fakeFetch(403, { code: 'TOOLSET_NOT_GRANTED' }) })).toBeNull()
    expect(await locateElement({ siteKey: 'k', params: { text: 'Services' }, fetchImpl: async () => { throw new Error('x') } })).toBeNull()
  })

  // 28/09/2026: the call had no bound of its own, so a read stuck behind a slow site kept the request
  // open for as long as the door took.
  it(`gives up after ${String(LOCATE_TIMEOUT_MS / 1000)} s with no answer, aborting the request`, async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const hang = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal) signals.push(init.signal)
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    let settled: unknown = 'pending'
    void locateElement({ siteKey: 'k', params: { text: 'Services' }, fetchImpl: hang }).then((v) => { settled = v })
    await vi.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeNull()
    expect(signals[0]!.aborted).toBe(true)
  })

  it('a door that answers its headers and then stalls is bounded too', async () => {
    vi.useFakeTimers()
    const stalled = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response
    let settled: unknown = 'pending'
    void locateElement({ siteKey: 'k', params: { text: 'Services' }, fetchImpl: stalled, timeoutMs: 50 }).then((v) => { settled = v })
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBeNull()
  })

  it('the caller\'s abort (a new pick, the view going) still ends it at once', async () => {
    const abort = new AbortController()
    const signals: AbortSignal[] = []
    const hang = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal) signals.push(init.signal)
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const answer = locateElement({ siteKey: 'k', params: { text: 'Services' }, fetchImpl: hang, signal: abort.signal })
    abort.abort()
    expect(await answer).toBeNull()
    expect(signals[0]!.aborted).toBe(true)
  })
})

describe('the warm', () => {
  it('asks content.locate with warm:true for the page, and never throws or answers', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const abort = new AbortController()
    expect(await warmLocate({ siteKey: 'north gate', url: 'https://a/', signal: abort.signal, fetchImpl: fakeFetch(200, { status: 'warmed', cached: false, ms: 9 }, seen) })).toBeUndefined()
    expect(seen[0]!.url).toBe('/api/sites/north%20gate/apply')
    expect(seen[0]!.init?.signal).toBe(abort.signal)
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ action: 'content.locate', params: { url: 'https://a/', warm: true } })
    await expect(warmLocate({ siteKey: 'k', url: 'u', fetchImpl: fakeFetch(403, { code: 'TOOLSET_NOT_GRANTED' }) })).resolves.toBeUndefined()
    await expect(warmLocate({ siteKey: 'k', url: 'u', fetchImpl: async () => { throw new Error('aborted') } })).resolves.toBeUndefined()
  })

  it('says `unavailable` when the site has no Content API (server round 5), so the tab stops asking per pick', async () => {
    expect(await warmLocate({ siteKey: 'k', url: 'u', fetchImpl: fakeFetch(200, { status: 'unavailable', code: 'CONTENT_ADAPTER_UNSUPPORTED' }) })).toBe('unavailable')
    expect(await warmLocate({ siteKey: 'k', url: 'u', fetchImpl: fakeFetch(200, { ok: true, result: { status: 'unavailable' } }) })).toBe('unavailable')
    expect(isUnavailable({ status: 'found' })).toBe(false)
    expect(isUnavailable(null)).toBe(false)
  })
})

describe('Send waits for content.locate at most 3 s', () => {
  it('hands on an answer that comes in time', async () => {
    expect(await waitForLocate(Promise.resolve({ status: 'resolved', levels: [] }))).toEqual({ status: 'resolved', levels: [] })
  })

  it('gives null after 3 s when the answer has not come, and on a rejection', async () => {
    vi.useFakeTimers()
    let settled: unknown = 'pending'
    void waitForLocate(new Promise(() => {})).then((v) => { settled = v })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeNull()
    vi.useRealTimers()
    expect(await waitForLocate(Promise.reject(new Error('x')))).toBeNull()
  })
})

describe('the chat round trip', () => {
  const detail = { v: 1, requestId: 'r1', sessionId: 's1', siteKey: 'k', text: 'hi', element: { url: 'u', selector: 's', label: 'l', text: 't', rect: { x: 0, y: 0, width: 1, height: 1 }, marks: [] }, locate: null, mode: 'queue' } satisfies CommentSendDetail

  it('dispatches tracy:comment-send and resolves on the matching sent', async () => {
    const got: unknown[] = []
    const listener = (event: Event) => {
      got.push((event as CustomEvent).detail)
      window.dispatchEvent(new CustomEvent(COMMENT_SENT_EVENT, { detail: { requestId: 'other' } }))
      window.dispatchEvent(new CustomEvent(COMMENT_SENT_EVENT, { detail: { requestId: 'r1', queued: true } }))
    }
    window.addEventListener(COMMENT_SEND_EVENT, listener)
    const outcome = await sendCommentToChat(detail)
    window.removeEventListener(COMMENT_SEND_EVENT, listener)
    expect(got).toEqual([detail])
    expect(outcome).toEqual({ ok: true, queued: true })
  })

  it('resolves failed with the listener code', async () => {
    const listener = () => { window.dispatchEvent(new CustomEvent(COMMENT_FAILED_EVENT, { detail: { requestId: 'r1', code: 'site-mismatch' } })) }
    window.addEventListener(COMMENT_SEND_EVENT, listener)
    expect(await sendCommentToChat(detail)).toEqual({ ok: false, code: 'site-mismatch' })
    window.removeEventListener(COMMENT_SEND_EVENT, listener)
  })

  it('says timeout after 10 s with no answer, and still reports a late sent', async () => {
    vi.useFakeTimers()
    const late: unknown[] = []
    const pending = sendCommentToChat(detail, { onLate: (o) => { late.push(o) } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toEqual({ ok: false, code: 'timeout' })
    window.dispatchEvent(new CustomEvent(COMMENT_SENT_EVENT, { detail: { requestId: 'r1', queued: false } }))
    expect(late).toEqual([{ ok: true, queued: false }])
  })
})
