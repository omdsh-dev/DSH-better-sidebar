// @vitest-environment jsdom
/**
 * D1 regression (P1) — revealing older rows must ANCHOR the reader's viewport.
 * Design basis: `/tmp/bsb-parity/spec.md` §D1/§3.1 (the risk column says
 * "revealing earlier rows shifts the scroll position, so it must land together
 * with D2").
 *
 * Why this spec exists: the windowed transcript (D1) grows the mounted row
 * count when the reader activates "reveal earlier". Inserting rows above the
 * viewport changes the scroller's content height, and a browser keeps
 * `scrollTop` as-is while the content above grows — so the line the reader was
 * reading slides down by exactly the height that was inserted above it. The
 * current reveal handler only bumps the revealed counter and never touches
 * `scrollTop`, so every reveal silently jumps the reader.
 *
 * ============================ CONTRACT ============================
 * Revealing one step of history must preserve the reader's line:
 *
 * 1. NOT FOLLOWING (the reader scrolled up to read): after the reveal,
 *      scrollTop_after === scrollTop_before + (scrollHeight_after - scrollHeight_before)
 *    — the scroll offset is corrected by the content-height DELTA, which is
 *    what keeps the visible line exactly where it was. (`scrollHeight` is the
 *    only geometry a jsdom test can drive; the implementation is expected to
 *    capture the height before the commit and correct by the difference.)
 * 2. FOLLOWING (the reader is at the tail): the reveal still pins to the BOTTOM
 *    OFFSET of the NEW geometry — `scrollTop_after === scrollHeight_after -
 *    clientHeight` — so a reader who asked to stay at the bottom stays there
 *    instead of being left behind by the rows that were just added above.
 * 3. Neither case may submit, drop rows or lose the reveal control while
 *    history is still hidden; the reveal really does mount more rows (an
 *    anchor assertion over an unchanged transcript would prove nothing).
 * ==================================================================
 *
 * jsdom performs no layout, so the geometry is stubbed and DERIVED from the
 * DOM: the transcript is `mounted rows * ROW_PX + the spacer's declared height`,
 * which is exactly the shape a real transcript has (mounted rows have heights,
 * unmounted ones are held open by the spacer) and it makes the height move when
 * rows are revealed. Only the effective scroll offset is asserted, never pixels
 * on screen — the same approach as tests/sidechat-scroll-follow.spec.tsx.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'

/** Stubbed height of one mounted transcript row. */
const ROW_PX = 40
/** Stubbed height of the visible pane. */
const CLIENT_PX = 300
/** Turns in the fixture: three mapped rows each, far past the tail window. */
const TURNS = 30

/** One user turn: question, answer and the turn tail (a usage row). */
function turn(turn: number, seq: number): unknown[] {
  return [
    { type: 'user/message', seq, time: seq * 1_000, data: { content: [{ type: 'text', text: `q-${String(turn).padStart(3, '0')}` }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: seq + 1, time: (seq + 1) * 1_000, data: { turn } },
    { type: 'assistant/message', seq: seq + 2, time: (seq + 2) * 1_000, data: { turn, step: 1, message: { content: [{ type: 'text', text: `a-${String(turn).padStart(3, '0')}` }] } } },
    { type: 'turn/end', seq: seq + 3, time: (seq + 3) * 1_000, data: { turn, reason: 'completed' } },
  ]
}

/** The thread's own (seed-cut) durable log with `TURNS` completed turns. */
function wireEvents(): unknown[] {
  const events: unknown[] = [{ type: 'session/end-seed', seq: 0, time: 0, data: {} }]
  for (let index = 0; index < TURNS; index += 1) events.push(...turn(index, 1 + index * 4))
  return events
}

/** Every scroll offset written or observed (jsdom keeps none of it). */
const scrollTops = new WeakMap<Element, number>()

/** The transcript's derived content height: mounted rows + the declared spacer. */
function transcriptHeight(scroller: HTMLElement): number {
  const rows = scroller.querySelectorAll('[data-sidechat-transcript-row]').length
  const spacer = scroller.querySelector('[data-sidechat-spacer]') as HTMLElement | null
  const spacerPx = spacer === null ? 0 : Number.parseFloat(spacer.style.height) || 0
  return rows * ROW_PX + spacerPx
}

/** Whether this element is the transcript's scroll container. */
function isScroller(element: Element): boolean {
  return element.matches('[class*="sidechatScroll"]')
}

/**
 * Stub the geometry: `scrollHeight` is a FUNCTION of the transcript's DOM (so it
 * moves when rows are revealed), `clientHeight` is the pane, and `scrollTop` is
 * a recorded, writable value.
 */
function stubGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isScroller(this) ? transcriptHeight(this) : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => CLIENT_PX,
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element): number { return scrollTops.get(this) ?? 0 },
    set(this: Element, value: number): void { scrollTops.set(this, value) },
  })
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

/** How many rows are mounted right now. */
function mountedRowCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-sidechat-transcript-row]').length
}

/** The "reveal earlier" control, or null when nothing is hidden. */
function revealOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-sidechat-reveal-earlier]')
}

/** The reader scrolls the transcript to `top` (jsdom emits no scroll event). */
function readerScrollsTo(scroller: HTMLElement, top: number): void {
  act(() => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  })
}

let harness: SidechatHarness

beforeEach(() => {
  stubGeometry()
  harness = installSidechatHarness()
  harness.wire.events = wireEvents()
})

afterEach(() => {
  harness.cleanup()
  restoreGeometry()
})

/** Mount the transcript and let the first pull settle. */
async function mountThread() {
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

describe('revealing earlier rows keeps the reader anchored (D1 regression)', () => {
  it('corrects scrollTop by the content-height delta when the reader is not following', async () => {
    const rendered = await mountThread()
    try {
      const scroller = scrollerOf(rendered.container)
      const mountedBefore = mountedRowCount(rendered.container)

      // The reader scrolled up to re-read; the view is no longer following.
      readerScrollsTo(scroller, 1_000)
      const heightBefore = scroller.scrollHeight
      expect(heightBefore, 'the transcript has scrollable content').toBeGreaterThan(CLIENT_PX)

      const reveal = revealOf(rendered.container)
      expect(reveal, 'the reveal control exists while history is hidden').not.toBeNull()
      act(() => { (reveal as HTMLElement).click() })
      await harness.flush(4)

      const heightAfter = scroller.scrollHeight
      // Non-vacuous: the reveal really mounted rows, and the geometry moved.
      expect(mountedRowCount(rendered.container), 'the reveal mounts more rows').toBeGreaterThan(mountedBefore)
      expect(heightAfter, 'revealing changes the content height').not.toBe(heightBefore)

      // The reader's line stays put: the offset follows the height delta.
      expect(
        scroller.scrollTop,
        `a reveal while reading must anchor: ${String(1_000)} + (${String(heightAfter)} - ${String(heightBefore)})`,
      ).toBe(1_000 + (heightAfter - heightBefore))
    } finally {
      rendered.unmount()
    }
  })

  it('pins to the new bottom offset when the reader is following the tail', async () => {
    const rendered = await mountThread()
    try {
      const scroller = scrollerOf(rendered.container)
      const mountedBefore = mountedRowCount(rendered.container)

      // The reader is at the tail (following).
      readerScrollsTo(scroller, scroller.scrollHeight - CLIENT_PX)
      const heightBefore = scroller.scrollHeight

      const reveal = revealOf(rendered.container)
      expect(reveal, 'the reveal control exists while history is hidden').not.toBeNull()
      act(() => { (reveal as HTMLElement).click() })
      await harness.flush(4)

      const heightAfter = scroller.scrollHeight
      expect(mountedRowCount(rendered.container), 'the reveal mounts more rows').toBeGreaterThan(mountedBefore)
      expect(heightAfter, 'revealing changes the content height').not.toBe(heightBefore)

      // Still at the tail — of the NEW geometry, not the old one.
      expect(
        scroller.scrollTop,
        'a reveal while following still pins to the bottom offset',
      ).toBe(heightAfter - CLIENT_PX)
      expect(scroller.scrollTop, 'and the old bottom offset is not what it keeps').not.toBe(heightBefore - CLIENT_PX)
    } finally {
      rendered.unmount()
    }
  })
})
