// @vitest-environment jsdom
/**
 * D10 (client half) — when the transcript route says the log was truncated, the
 * transcript must SAY so at its top instead of silently starting mid-thread.
 * Design basis: `/tmp/bsb-parity/spec.md` §D10 / §3.8.
 *
 * Why this spec exists: the route caps a response at `EVENTS_CAP = 8000`
 * events and slices the head off (`sidechat-routes.ts:156,879`), returning no
 * marker at all. A thread past the cap therefore opens mid-conversation — the
 * first thing the reader sees is an answer to a question that is not there —
 * with nothing explaining the gap. The main conversation shows an "older"
 * affordance in that situation; the side chat shows nothing.
 *
 * ============================ CONTRACT ============================
 * 1. The `sidechat.events` response may carry an ADDITIVE boolean
 *    `truncated` (absent/false means "this is the whole thread's own log").
 * 2. When it is true, the transcript renders a hint element carrying
 *    `data-sidechat-truncated-notice` INSIDE the scroll container, ABOVE the
 *    first mounted transcript row (the same place the reader meets the gap).
 * 3. Its copy comes from the locale dictionary under
 *    `SIDECHAT_TRUNCATION_KEY = 'sideChatTruncatedNotice'` (added to zh, en and
 *    ja) and is rendered verbatim — no hardcoded sentence.
 * 4. The hint is NOT a transcript row: it must not carry
 *    `data-sidechat-transcript-row`, and it must not change the number of
 *    mounted rows (it is chrome, not conversation).
 * 5. When the flag is absent or false, there is no hint at all — a short thread
 *    must never claim its history was cut.
 * ==================================================================
 *
 * The harness's fetch stub answers `sidechat.events` from `wire`, which has no
 * `truncated` field; this spec wraps the stub (the harness is untouched) to
 * inject the flag into the envelope, exactly as the host route would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { transcriptRows } from '../src/client/sidechat-transcript.ts'
import { t } from '../src/client/locales.ts'
import type { SidebarHistoryEntry } from '../src/context-types.ts'

/** The locale key the notice must come from. */
const SIDECHAT_TRUNCATION_KEY = 'sideChatTruncatedNotice'

/** One user turn: question, answer, turn tail. */
function turn(turn: number, seq: number): unknown[] {
  return [
    { type: 'user/message', seq, time: seq * 1_000, data: { content: [{ type: 'text', text: `q-${String(turn)}` }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: seq + 1, time: (seq + 1) * 1_000, data: { turn } },
    { type: 'assistant/message', seq: seq + 2, time: (seq + 2) * 1_000, data: { turn, step: 1, message: { content: [{ type: 'text', text: `a-${String(turn)}` }] } } },
    { type: 'turn/end', seq: seq + 3, time: (seq + 3) * 1_000, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** The thread's own (seed-cut) log: two short turns, far below any cap. */
function events(): unknown[] {
  return [{ type: 'session/end-seed', seq: 0, time: 0, data: {} }, ...turn(1, 1), ...turn(2, 5)]
}

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/**
 * Wrap the harness's `sidechat.events` envelope so it carries `truncated`,
 * the way the host route will.
 * @param truncated - the flag the route reports.
 */
function reportTruncated(truncated: boolean): void {
  const stubbed = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await stubbed(input as string, init)
    if (!String(input).endsWith('sidechat.events')) return response
    const body = await response.json() as { ok?: boolean; value?: Record<string, unknown> }
    return {
      ok: response.ok,
      status: response.status,
      json: async () => ({ ...body, value: { ...body.value, truncated } }),
    } as unknown as Response
  })
}

/** The transcript's scroll container. */
function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('[class*="sidechatScroll"]')
  expect(scroller, 'the transcript renders its scroll container').not.toBeNull()
  return scroller as HTMLElement
}

/** The mounted transcript rows, in document order. */
function mountedRows(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-sidechat-transcript-row]')]
}

/** The truncation hint, or null when the transcript is whole. */
function noticeOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-sidechat-truncated-notice]')
}

/** Whether `earlier` precedes `later` in document order. */
function precedes(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
  harness.wire.events = events()
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the transcript and let the first pull settle. */
async function mountTranscript() {
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

describe('truncated transcript notice (D10)', () => {
  it('says so at the top of the transcript when the route reports truncation', async () => {
    reportTruncated(true)
    const rendered = await mountTranscript()
    try {
      const notice = noticeOf(rendered.container)
      expect(notice, 'a truncated transcript renders the hint').not.toBeNull()

      const scroller = scrollerOf(rendered.container)
      expect(scroller.contains(notice), 'the hint lives inside the transcript scroller').toBe(true)

      const rows = mountedRows(rendered.container)
      expect(rows.length, 'the transcript mounts its rows').toBeGreaterThan(0)
      expect(
        precedes(notice as Element, rows[0] as Element),
        'the hint sits above the first mounted row',
      ).toBe(true)

      const expected = copy(SIDECHAT_TRUNCATION_KEY)
      expect(
        expected,
        `the ${SIDECHAT_TRUNCATION_KEY} key must exist in the locale dictionary`,
      ).not.toBe(SIDECHAT_TRUNCATION_KEY)
      expect((notice as HTMLElement).textContent?.trim(), 'the hint shows the locale copy').toBe(expected)

      // Chrome, not conversation: it must not inflate the row count.
      expect(notice?.hasAttribute('data-sidechat-transcript-row'), 'the hint is not a transcript row').toBe(false)
      const mapped = transcriptRows(harness.wire.events.map(event => ({ event })) as unknown as SidebarHistoryEntry[])
      expect(rows.length, 'the mounted rows are exactly the mapped ones').toBe(mapped.length)
    } finally {
      rendered.unmount()
    }
  })

  it('shows nothing on a whole transcript', async () => {
    // No wrapper: the harness answers the route without any `truncated` field,
    // which is what a short thread looks like.
    const rendered = await mountTranscript()
    try {
      expect(noticeOf(rendered.container), 'a whole transcript has no hint').toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('shows nothing when the route reports truncated: false', async () => {
    reportTruncated(false)
    const rendered = await mountTranscript()
    try {
      expect(noticeOf(rendered.container), 'an explicit false is not a truncation').toBeNull()
    } finally {
      rendered.unmount()
    }
  })
})
