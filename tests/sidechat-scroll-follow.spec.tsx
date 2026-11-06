// @vitest-environment jsdom
/**
 * D2 (P0) — following the stream is an INTENT, not an unconditional write, and
 * a reader who scrolls away gets a way back. Design basis:
 * `/tmp/bsb-parity/spec.md` §D2 and §3.2.
 *
 * Why this spec exists: the view pins the transcript with
 * `scroller.scrollTop = scroller.scrollHeight` on every growth (`rows.length`,
 * `pendingRows.length`, `echoText`, `threadId`). The host pushes an
 * invalidation every ~250 ms while a turn streams, so a reader who scrolls up
 * to read what was just generated is yanked back to the bottom on the next
 * push — reading the middle of a streaming answer is impossible, and there is
 * no control to return to the tail.
 *
 * ============================ CONTRACT ============================
 * The implementation must match this contract (the names below are the agreed
 * test hooks — see the spec's §3.2):
 *
 * 1. NEAR BOTTOM. "Following the tail" is decided by the host's own rule:
 *    `scrollHeight - clientHeight - scrollTop <= SIDECHAT_FOLLOW_THRESHOLD (24)`.
 * 2. PIN. While following, a growth pins the reader at the BOTTOM OFFSET
 *    (`scrollTop = scrollHeight - clientHeight`) — never the raw `scrollHeight`
 *    (that is a browser-clamped over-scroll, and it hides the missing offset
 *    arithmetic). Assigning `scrollTop` (or `scrollTo({ top })`, which this
 *    spec stubs to the same accessor) is what the stub observes.
 * 3. NO YANK. When the reader is NOT near the bottom, a growth must not touch
 *    `scrollTop` at all — it stays exactly where the reader left it.
 * 4. BACK-TO-LATEST. An element with `data-sidechat-to-bottom` renders only
 *    while the reader is not following the tail; activating it re-pins to the
 *    bottom offset and removes itself.
 * 5. INTENT SOURCE. The intent updates from the scroller's own `scroll` event
 *    (what a real user scroll emits); this spec always dispatches it.
 * 6. D1 COUPLING. Revealing hidden history (D1's "reveal earlier" control)
 *    must not pin a reader who is not following the tail — the two P0 items
 *    share one scroller and must land together.
 * ==================================================================
 *
 * jsdom performs no layout: every element reports the geometry this spec
 * stubs, and the only thing observable is WHICH value was written (or that
 * none was). The assertions therefore compare the effective scroll offset, not
 * pixels on screen — the same approach as tests/editor-large-file.spec.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'

/** Contract constant: the host's near-bottom threshold (use-chat-reading.ts). */
const FOLLOW_THRESHOLD = 24
/** Stubbed transcript geometry: a long thread in a short pane. */
const SCROLL_HEIGHT = 5_000
const CLIENT_HEIGHT = 300
/** The only honest "bottom" of that pane — CONTRACT §2. */
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT
/** How far above the bottom a "reader who is still following" sits: inside the
 *  threshold (so the view must follow) but not exactly on the bottom (so the
 *  pin has something to correct and "wrote nothing" cannot pass). */
const NEAR_MARGIN = 12
/** Room for the 80 ms push debounce plus the pull it triggers. */
const PUSH_SETTLE_MS = 300

/** One user turn: question, answer and the turn tail (four mapped rows with
 *  the usage row), so a push grows the transcript by more than one row. */
function turn(turn: number, seq: number): unknown[] {
  return [
    { type: 'user/message', seq, time: seq * 1_000, data: { content: [{ type: 'text', text: `q-${String(turn).padStart(3, '0')}` }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: seq + 1, time: (seq + 1) * 1_000, data: { turn } },
    { type: 'assistant/message', seq: seq + 2, time: (seq + 2) * 1_000, data: { turn, step: 1, message: { content: [{ type: 'text', text: `a-${String(turn).padStart(3, '0')}` }] } } },
    { type: 'turn/end', seq: seq + 3, time: (seq + 3) * 1_000, data: { turn, reason: 'completed' } },
  ]
}

/** The thread's own (seed-cut) durable log with `turns` completed turns. */
function wireEvents(turns: number): unknown[] {
  const events: unknown[] = [{ type: 'session/end-seed', seq: 0, time: 0, data: {} }]
  for (let index = 0; index < turns; index += 1) events.push(...turn(index, 1 + index * 4))
  return events
}

/**
 * The narrowest WebSocket the push hook needs. `installSidechatHarness` stubs a
 * socket of its own, but it does not hand out its instances; the view only
 * needs ONE deliverable invalidation frame, so this spec stubs its own class
 * over it (before mount) and keeps the reference.
 */
class PushSocket {
  static instances: PushSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readonly url: string
  readyState = PushSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    PushSocket.instances.push(this)
  }
  send(_frame: string): void {}
  close(): void { this.readyState = 3 }
  /** Deliver one host invalidation frame for a watched thread. */
  frame(threadId: string): void {
    this.onmessage?.({ data: JSON.stringify({ threadId }) })
  }
}

/** Every scroll offset written or observed, per element (jsdom keeps none). */
const scrollTops = new WeakMap<Element, number>()

/**
 * Force the transcript geometry every element reports, and make `scrollTop`
 * readable/writable so the stub can tell "wrote the bottom offset" from "wrote
 * nothing" (the approach of tests/editor-large-file.spec.tsx:169-171, extended
 * to record writes instead of only declaring a value).
 */
function stubGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get: () => SCROLL_HEIGHT,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get: () => CLIENT_HEIGHT,
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element): number { return scrollTops.get(this) ?? 0 },
    set(this: Element, value: number): void { scrollTops.set(this, value) },
  })
  // An implementation may land the pin through scrollTo() instead of an
  // assignment; both are the same observable write (CONTRACT §2).
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: function scrollTo(this: Element, arg: ScrollToOptions | number, maybeY?: number): void {
      const top = typeof arg === 'number' ? (maybeY ?? 0) : (arg.top ?? 0)
      scrollTops.set(this, top)
    },
  })
}

function restoreGeometry(): void {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo
}

/** The transcript's scroll container. */
function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('[class*="sidechatScroll"]')
  expect(scroller, 'the transcript renders its scroll container').not.toBeNull()
  return scroller as HTMLElement
}

function socketOf(): PushSocket {
  const socket = PushSocket.instances.at(-1)
  if (socket === undefined) throw new Error('the push socket was never opened')
  return socket
}

/** Mount the thread on the given wire and let the first pull settle. */
async function mountThread(harness: SidechatHarness, events: unknown[]) {
  harness.wire.events = events
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

/** The reader scrolls the transcript to `top` (jsdom emits no scroll event). */
function readerScrollsTo(scroller: HTMLElement, top: number): void {
  act(() => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  })
}

/**
 * One host push: the log grows, the host invalidates the thread, the view
 * re-pulls. This is the exact path that used to yank the reader.
 */
async function pushGrowth(harness: SidechatHarness, events: unknown[]): Promise<void> {
  harness.wire.events = events
  act(() => { socketOf().frame('t1') })
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, PUSH_SETTLE_MS) }) })
  await harness.flush(4)
}

/** The distance from the bottom the pane reports, per CONTRACT §1. */
const distanceFromBottom = (scroller: HTMLElement): number =>
  SCROLL_HEIGHT - CLIENT_HEIGHT - scroller.scrollTop

let harness: SidechatHarness

beforeEach(() => {
  stubGeometry()
  harness = installSidechatHarness()
  // Replace the harness socket AFTER install (its stub only has to keep a real
  // WebSocket from opening); this one can deliver an invalidation frame.
  vi.stubGlobal('WebSocket', PushSocket)
  PushSocket.instances = []
})

afterEach(() => {
  harness.cleanup()
  restoreGeometry()
})

describe('SideChatView scroll follow intent (D2)', () => {
  it('keeps a reader who is near the bottom pinned to the bottom when a push arrives', async () => {
    const rendered = await mountThread(harness, wireEvents(1))
    try {
      const scroller = scrollerOf(rendered.container)
      // The reader sits NEAR the bottom (inside the threshold) but not exactly
      // on it: a push that pins has to correct the offset, so "pinned" can be
      // told apart from "never wrote anything".
      readerScrollsTo(scroller, BOTTOM - NEAR_MARGIN)
      expect(distanceFromBottom(scroller), 'the reader is inside the follow threshold').toBeLessThanOrEqual(FOLLOW_THRESHOLD)
      expect(scroller.scrollTop, 'and is not at the bottom yet').not.toBe(BOTTOM)

      await pushGrowth(harness, wireEvents(2))

      // Still at the tail — and at the BOTTOM OFFSET, not the raw scrollHeight
      // (the over-scroll a browser would silently clamp).
      expect(
        Math.abs(scroller.scrollTop - BOTTOM),
        `a push while following stays within ${String(FOLLOW_THRESHOLD)}px of the bottom offset ${String(BOTTOM)} (wrote ${String(scroller.scrollTop)})`,
      ).toBeLessThanOrEqual(FOLLOW_THRESHOLD)
      expect(scroller.scrollTop, 'the pin is the bottom offset, never the scroll height').toBe(BOTTOM)
      // The push really did grow the transcript (otherwise this proves nothing).
      expect(rendered.container.textContent).toContain('a-001')
    } finally {
      rendered.unmount()
    }
  })

  it('does not yank a reader who scrolled away, and offers the way back', async () => {
    const rendered = await mountThread(harness, wireEvents(1))
    try {
      const scroller = scrollerOf(rendered.container)
      readerScrollsTo(scroller, BOTTOM)
      expect(
        rendered.container.querySelector('[data-sidechat-to-bottom]'),
        'nothing to return to while the reader is at the tail',
      ).toBeNull()

      // The reader scrolls up to re-read what was already generated.
      readerScrollsTo(scroller, 1_000)
      await pushGrowth(harness, wireEvents(2))

      expect(
        scroller.scrollTop,
        'a push must not move a reader who scrolled away from the tail',
      ).toBe(1_000)
      expect(
        rendered.container.querySelector('[data-sidechat-to-bottom]'),
        'the back-to-latest control appears once the reader leaves the tail',
      ).not.toBeNull()
      // Non-vacuous: the transcript grew while the reader stayed put.
      expect(rendered.container.textContent).toContain('a-001')
    } finally {
      rendered.unmount()
    }
  })

  it('re-pins to the bottom when the back-to-latest control is activated, and then retires it', async () => {
    const rendered = await mountThread(harness, wireEvents(1))
    try {
      const scroller = scrollerOf(rendered.container)
      readerScrollsTo(scroller, BOTTOM)
      readerScrollsTo(scroller, 1_000)
      await pushGrowth(harness, wireEvents(2))

      const back = rendered.container.querySelector('[data-sidechat-to-bottom]')
      expect(back, 'the back-to-latest control is available').not.toBeNull()
      act(() => { (back as HTMLElement).click() })
      await harness.flush(4)

      expect(scroller.scrollTop, 'activating the control returns to the bottom offset').toBe(BOTTOM)
      expect(
        rendered.container.querySelector('[data-sidechat-to-bottom]'),
        'the control retires once the reader is back at the tail',
      ).toBeNull()

      // And the reader is following again: the next push still pins.
      await pushGrowth(harness, wireEvents(3))
      expect(scroller.scrollTop, 'following resumes after the return').toBe(BOTTOM)
    } finally {
      rendered.unmount()
    }
  })

  it('does not pin a reader who is reading earlier rows when more history is revealed (D1 coupling)', async () => {
    // A transcript long enough to be windowed, so the reveal control exists.
    const rendered = await mountThread(harness, wireEvents(40))
    try {
      const scroller = scrollerOf(rendered.container)
      const reveal = rendered.container.querySelector('[data-sidechat-reveal-earlier]')
      expect(reveal, 'D1: the reveal control exists on a long transcript').not.toBeNull()
      const before = rendered.container.querySelectorAll('[data-sidechat-transcript-row]').length

      readerScrollsTo(scroller, BOTTOM)
      readerScrollsTo(scroller, 1_000)

      act(() => { (reveal as HTMLElement).click() })
      await harness.flush(4)

      const after = rendered.container.querySelectorAll('[data-sidechat-transcript-row]').length
      expect(after, 'D1: the reveal mounts more rows (otherwise this proves nothing)').toBeGreaterThan(before)
      expect(
        scroller.scrollTop,
        'revealing earlier rows must not yank the reader to the bottom',
      ).toBe(1_000)
    } finally {
      rendered.unmount()
    }
  })
})
