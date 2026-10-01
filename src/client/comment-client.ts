/**
 * Comment mode in Tracy's browser tab — the three calls it makes (Tracy, 27/09/2026).
 *
 *   1. `POST /api/sites/:key/preview-ticket` — a one-use ticket that turns the picker on inside
 *      the framed site (the site proxy checks it). Asked BEFORE the frame loads.
 *   2. `POST /api/sites/:key/apply {action:'content.locate'}` — which record the picked element
 *      comes from, with the viewer's own seat. Asked ONCE per pick, in the background, and given
 *      up after `LOCATE_TIMEOUT_MS`; Send waits for it at most `LOCATE_WAIT_MS` (`waitForLocate`),
 *      asks again when it came back incomplete or not at all (`pick-lookup.ts`), and nothing on
 *      screen reads it.
 *      Edit turning on warms it first (`warmLocate`): the same action with `warm: true`, once per page
 *      load, so the site's index is built while the person is still choosing what to click.
 *   3. `tracy:comment-send` on `window` — hands the comment to the chat input
 *      (`@tracy/dsh-chat-input`), which answers `tracy:comment-sent` or `tracy:comment-failed`.
 *
 * Both doors are tracy-web's, at the ROOT of the host — the same place `/api/config` is asked
 * (`BrowserView.tsx`), and the same root-absolute path every Tracy plugin uses for `/api/sites/…`
 * (`packages/core/tracy-core/src/siteApi.ts`). They are not dsh routes, so they do not go through
 * `dshUrl()`: under a `<base href="/<siteKey>/">` that would ask dsh, where nothing answers.
 *
 * `fetch`, `window` and the timers are parameters, so tests drive every branch without a network.
 */
import {
  COMMENT_FAILED_EVENT,
  COMMENT_SEND_EVENT,
  COMMENT_SEND_FILES_TIMEOUT_MS,
  COMMENT_SEND_TIMEOUT_MS,
  COMMENT_SENT_EVENT,
  LOCATE_WAIT_MS,
  readCommentAnswer,
  ticketAnswerOf,
  type CommentFailureCode,
  type CommentSendDetail,
  type TicketAnswer,
} from './comment-model.ts'
import type { CommentSendDetailV3, CommentSendDetailV4 } from './comment-store.ts'

/**
 * Whether `content.locate` params name anything the door can search by: the element's words, its
 * image, or a provenance mark. Selector and DOM path alone are not a query (the door refuses them).
 * @param params - the params `locateParams` built.
 * @returns false when there is nothing to look up.
 */
export function hasLocateQuery(params: Record<string, unknown>): boolean {
  const text = typeof params.text === 'string' ? params.text.trim() : ''
  const marks = Array.isArray(params.marks) ? params.marks : []
  const image = params.image !== null && typeof params.image === 'object' ? params.image as { src?: unknown } : null
  return text !== '' || marks.length > 0 || (image !== null && typeof image.src === 'string' && image.src !== '')
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** How long a frame load waits for a ticket before it goes ahead without one. */
export const TICKET_WAIT_MS = 2_500

/**
 * Ask for a preview ticket.
 *
 * Never throws and never waits long: a slow or broken door must not hold the page back, so after
 * {@link TICKET_WAIT_MS} the frame loads as it always did, with no Comment button.
 * @param input - the site key, this page's origin, and optional seams.
 * @returns what the door said.
 */
export async function requestPreviewTicket(input: {
  siteKey: string
  parentOrigin: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}): Promise<TicketAnswer> {
  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, input.timeoutMs ?? TICKET_WAIT_MS)
  try {
    const res = await fetchImpl(`/api/sites/${encodeURIComponent(input.siteKey)}/preview-ticket`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ parentOrigin: input.parentOrigin }),
      signal: controller.signal,
    })
    const body: unknown = res.status === 200 ? await res.json().catch(() => null) : null
    return ticketAnswerOf(res.status, body)
  } catch {
    return { kind: 'error' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How long one `content.locate` call may take before the tab stops waiting for it.
 *
 * The door bounds its own index build (it answers `incomplete` after its budget), but not what
 * stands around it — the site's head read, the host's file read, a proxy, the network — so a slow
 * site can hold the call open for minutes. Past this bound it reads as no answer: the comment goes
 * with `locate: null` as for a refusal (or Send asks again, `pick-lookup.ts`), and no request is
 * left open behind it.
 */
export const LOCATE_TIMEOUT_MS = 15_000

/**
 * Ask which record a picked element comes from.
 * @param input - the site key, the `content.locate` params, and optional seams (`timeoutMs`
 *   defaults to {@link LOCATE_TIMEOUT_MS}; `signal` aborts it earlier).
 * @returns the parsed answer, or null when the door refused or did not answer in time (the comment
 *   then goes with `locate: null`, and the agent asks `content.locate` itself — never a guessed record).
 */
export async function locateElement(input: {
  siteKey: string
  params: Record<string, unknown>
  fetchImpl?: FetchLike
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<unknown> {
  // 🔒 NOTHING TO LOOK UP IS NOT A QUESTION (stand E2E round 2, V2-L0). An element with no words, no
  // image and no marks (an empty header box) was asked anyway, the door answered 400
  // `LOCATE_BAD_QUERY`, and each pick left an error in the browser log. It is the same as no answer:
  // the comment goes with `locate: null`, and the agent looks the page up itself.
  if (!hasLocateQuery(input.params)) return null
  const fetchImpl = input.fetchImpl ?? fetch
  // One signal for both ends: the caller's abort (a new pick, the view going) and the time bound,
  // which also covers reading the body — a door can answer its headers and then stall.
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  if (input.signal?.aborted === true) stop()
  input.signal?.addEventListener('abort', stop)
  const timer = setTimeout(stop, input.timeoutMs ?? LOCATE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`/api/sites/${encodeURIComponent(input.siteKey)}/apply`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action: 'content.locate', params: input.params }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = await Promise.race([
      res.json().catch(() => null) as Promise<unknown>,
      new Promise<null>((resolve) => { controller.signal.addEventListener('abort', () => { resolve(null) }) }),
    ])
    if (controller.signal.aborted) return null
    // The Apply door relays some actions wrapped as `{ok, result}`; accept both shapes.
    if (body !== null && typeof body === 'object' && 'result' in body && !('status' in body)) {
      return (body as { result: unknown }).result
    }
    return body
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', stop)
  }
}

/**
 * Have the Apply door build (or revalidate) the index `content.locate` reads for this page, so the
 * first pick after Edit turns on does not wait for it. Fire and forget: it never throws, returns
 * nothing, and a failed warm only means the first pick pays for the build as it did before.
 * @param input - the site key, the page address, and optional seams.
 */
export async function warmLocate(input: {
  siteKey: string
  url: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
}): Promise<'unavailable' | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`/api/sites/${encodeURIComponent(input.siteKey)}/apply`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action: 'content.locate', params: { url: input.url, warm: true } }),
      signal: input.signal,
    })
    // Read to the end so the connection is released. Only one answer is used: `unavailable` (the site
    // has no Content API, `CONTENT_ADAPTER_UNSUPPORTED`) — then no pick of this page asks at all.
    const text = await res.text().catch(() => '')
    return isUnavailable(parseJson(text)) ? 'unavailable' : undefined
  } catch {
    // Aborted, offline or refused: the first pick builds the index itself.
    return undefined
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return null }
}

/**
 * A `content.locate` answer saying the site cannot be looked up at all (200 `{status: 'unavailable',
 * code: 'CONTENT_ADAPTER_UNSUPPORTED'}`, TCH server round 5): asking again per pick only adds noise.
 */
export function isUnavailable(answer: unknown): boolean {
  if (answer === null || typeof answer !== 'object') return false
  const a = 'result' in answer && !('status' in answer) ? (answer as { result: unknown }).result : answer
  return a !== null && typeof a === 'object' && (a as { status?: unknown }).status === 'unavailable'
}

/**
 * The locate answer if it comes within `ms`, else null — so a slow index never holds a Send back.
 * @param answer - the pending `locateElement` call.
 * @param ms - how long to wait (default {@link LOCATE_WAIT_MS}).
 * @returns the answer, or null after the wait.
 */
export function waitForLocate(answer: Promise<unknown>, ms: number = LOCATE_WAIT_MS): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(null) }, ms)
    void answer.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}

/** The outcome of one send. `late` = the answer came after the tab had already said timeout. */
export type SendOutcome = { ok: true; queued: boolean } | { ok: false; code: CommentFailureCode }

/**
 * Hand one comment (v1) or one chat message from the page (v3, stage 6; v4 with files) to the chat input and wait for its answer.
 *
 * Resolves with `timeout` after {@link COMMENT_SEND_TIMEOUT_MS} ({@link COMMENT_SEND_FILES_TIMEOUT_MS}
 * with files: the chat answers after their upload); an answer that still arrives
 * afterwards is passed to `onLate` (the chat did take it — the tab must not keep saying it failed).
 * @param detail - the event detail.
 * @param seams - the window to dispatch on, the timeout, and the late-answer callback.
 * @returns the outcome.
 */
export function sendCommentToChat(
  detail: CommentSendDetail | CommentSendDetailV3 | CommentSendDetailV4,
  seams: { target?: Window; timeoutMs?: number; onLate?: (outcome: SendOutcome) => void } = {},
): Promise<SendOutcome> {
  const target = seams.target ?? window
  return new Promise((resolve) => {
    let settled = false
    const onAnswer = (event: Event): void => {
      const outcome = readCommentAnswer(event.type, (event as CustomEvent).detail, detail.requestId)
      if (outcome === null) return
      target.removeEventListener(COMMENT_SENT_EVENT, onAnswer)
      target.removeEventListener(COMMENT_FAILED_EVENT, onAnswer)
      if (settled) {
        seams.onLate?.(outcome)
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    target.addEventListener(COMMENT_SENT_EVENT, onAnswer)
    target.addEventListener(COMMENT_FAILED_EVENT, onAnswer)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, code: 'timeout' })
      // Keep listening for a while: a late `sent` still means the turn is in the chat.
      setTimeout(() => {
        target.removeEventListener(COMMENT_SENT_EVENT, onAnswer)
        target.removeEventListener(COMMENT_FAILED_EVENT, onAnswer)
      }, 60_000)
    }, seams.timeoutMs ?? (detail.v === 4 ? COMMENT_SEND_FILES_TIMEOUT_MS : COMMENT_SEND_TIMEOUT_MS))
    target.dispatchEvent(new CustomEvent(COMMENT_SEND_EVENT, { detail }))
  })
}
