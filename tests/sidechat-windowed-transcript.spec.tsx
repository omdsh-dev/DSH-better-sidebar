// @vitest-environment jsdom
/**
 * D1 (P0) — the side chat transcript is WINDOWED to its tail; the history that
 * is not mounted is collapsed into a top spacer behind a "reveal earlier"
 * control. Design basis: `/tmp/bsb-parity/spec.md` §D1 and §3.1.
 *
 * Why this spec exists: `SideChatView` builds `rowNodes` with a FULL
 * `rows.map(...)` (no slice, no spacer), so a long thread mounts every row —
 * every code card's syntax highlight, table and image with it — and the DOM is
 * never reclaimed. The window has to be bounded and the hidden part has to be
 * reachable, or long threads stay both slow and unreadable.
 *
 * ============================ CONTRACT ============================
 * Everything below is what this file pins; the implementation must match it
 * (these names are the agreed test hooks — see the spec's §3.1):
 *
 * 1. TAIL WINDOW. At most `SIDECHAT_WINDOW_MAX = 50` transcript rows are
 *    MOUNTED. The mapping itself is untouched (`transcriptRows` still returns
 *    every row); only the mount is bounded. With more rows than the cap, the
 *    mounted window is the TAIL, and it mounts exactly the cap.
 * 2. ROW HOOK. Each mounted transcript row exposes exactly one element with
 *    `data-sidechat-transcript-row` (on the row's root or on a wrapper that
 *    wraps it).
 * 3. SPACER. While rows are hidden, the scroller carries an element with
 *    `data-sidechat-spacer` ABOVE the first mounted row, whose INLINE
 *    `height` (or `min-height`) is a px value > 0. jsdom performs no layout, so
 *    the spacer must declare its height in the inline style; a measured
 *    (getBoundingClientRect) height would read 0 here and in any test run.
 * 4. GEOMETRY. The spacer's height is linear in the hidden row count at a
 *    CONSTANT px-per-hidden-row: what a reveal takes off the spacer is exactly
 *    what the revealed rows add. (In jsdom this is the only expressible form of
 *    "revealing does not jump the scroll position" — there is no layout to
 *    measure.) When nothing is hidden the spacer is gone (absent, or height 0).
 * 5. REVEAL CONTROL. An element with `data-sidechat-reveal-earlier` sits above
 *    the first mounted row. Its visible copy is the locale string
 *    `t(SIDECHAT_REVEAL_KEY, { hidden })` with
 *    `SIDECHAT_REVEAL_KEY = 'sideChatRevealEarlier'` (add it to the zh, en and
 *    ja dictionaries — AGENTS §5), and `hidden` is the number of hidden rows.
 *    The copy must never be a hardcoded Chinese literal.
 * 6. REVEAL STEP. One activation reveals `SIDECHAT_REVEAL_STEP = 25` more rows
 *    (the last activation reveals whatever remains), and the control disappears
 *    once nothing is hidden. No row is ever lost: revealing every segment makes
 *    the mounted count equal the mapped row count.
 * ==================================================================
 *
 * The assertions are behavioural on purpose: they count mounted rows and read
 * the spacer's declared height, never the implementation's internal state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { transcriptRows } from '../src/client/sidechat-transcript.ts'
import { attachLocale, t } from '../src/client/locales.ts'
import type { SidebarHistoryEntry } from '../src/context-types.ts'

/** Contract constant: the mounted tail-window row cap (see CONTRACT §1). */
const WINDOW_MAX = 50
/** Contract constant: how many more rows one reveal activation mounts (§6). */
const REVEAL_STEP = 25
/** Contract key: the reveal control's locale entry (§5). */
const REVEAL_KEY = 'sideChatRevealEarlier'
/** Guard against a control that never exhausts the history. */
const MAX_REVEAL_CLICKS = 40

/** Turns in the fixture. Four rows per turn (user + tool + answer + usage), so
 *  the transcript is far longer than any sensible window. */
const TURNS = 40

/** Unique, prefix-free prose markers (three digits: `q-000` is never a
 *  substring of `q-001`, so a presence check cannot be a false positive). */
const question = (turn: number): string => `q-${String(turn).padStart(3, '0')}`
const answer = (turn: number): string => `a-${String(turn).padStart(3, '0')}`
const toolMarker = (turn: number): string => `t-${String(turn).padStart(3, '0')}`

/** One turn: a question, a tool call (+ its paired result), an answer and the
 *  turn tail (which maps onto a usage row). */
function turn(turn: number, seq: number): unknown[] {
  const callId = `call-${String(turn)}`
  return [
    { type: 'user/message', seq, time: seq * 1_000, data: { content: [{ type: 'text', text: question(turn) }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: seq + 1, time: (seq + 1) * 1_000, data: { turn } },
    {
      type: 'tool/call',
      seq: seq + 2,
      time: (seq + 2) * 1_000,
      data: { turn, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command: `echo ${toolMarker(turn)}` }) },
    },
    {
      type: 'tool/result',
      seq: seq + 3,
      time: (seq + 3) * 1_000,
      data: {
        turn,
        step: 1,
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `${toolMarker(turn)}-ok` }] }],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: seq + 4,
      time: (seq + 4) * 1_000,
      data: { turn, step: 2, message: { content: [{ type: 'text', text: answer(turn) }] } },
    },
    { type: 'turn/end', seq: seq + 5, time: (seq + 5) * 1_000, data: { turn, reason: 'completed' } },
  ]
}

/** The thread's own (seed-cut) durable log: one `session/end-seed`, then turns. */
function wireEvents(turns: number): unknown[] {
  const events: unknown[] = [{ type: 'session/end-seed', seq: 0, time: 0, data: {} }]
  for (let index = 0; index < turns; index += 1) events.push(...turn(index, 1 + index * 6))
  return events
}

const WIRE = wireEvents(TURNS)

function entriesOf(events: readonly unknown[]): SidebarHistoryEntry[] {
  return events.map(event => ({ event })) as unknown as SidebarHistoryEntry[]
}

/** How many rows the mapping produces for this fixture (the view maps all of
 *  them; only the MOUNT is windowed — CONTRACT §1). */
const TOTAL_ROWS = transcriptRows(entriesOf(WIRE)).length

/** A locale service frozen on one language (the harness fake is always zh). */
class FixedLocale {
  constructor(private readonly lang: string) {}
  getSnapshot(): { active: string } { return { active: this.lang } }
  subscribe(): () => void { return () => {} }
  register(): () => void { return () => {} }
}

/** The reveal copy through the plugin's own translator, so the assertion pins
 *  the DICTIONARY entry rather than a literal in this file. A missing key makes
 *  `t` return the key itself — the first thing every locale test rules out. */
function revealCopy(hidden: number): string {
  const translate = t as unknown as (key: string, params?: Record<string, string | number>) => string
  return translate(REVEAL_KEY, { hidden })
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

/** The top spacer, or null when nothing is hidden. */
function spacerOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-sidechat-spacer]')
}

/** The reveal control, or null when nothing is hidden. */
function revealOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-sidechat-reveal-earlier]')
}

/** The spacer's DECLARED height in px (inline style — see CONTRACT §3). */
function declaredHeightOf(element: HTMLElement): number {
  const raw = element.style.height !== '' ? element.style.height : element.style.minHeight
  const value = Number.parseFloat(raw)
  return Number.isNaN(value) ? 0 : value
}

/** Whether `earlier` precedes `later` in document order. */
function precedes(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('SideChatView windowed transcript (D1)', () => {
  it('mounts only the tail window: the newest rows render, the oldest never mount', async () => {
    harness.wire.events = WIRE
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      // Precondition: the fixture really is longer than one window.
      expect(TOTAL_ROWS).toBeGreaterThan(WINDOW_MAX)

      const mounted = mountedRows(rendered.container)
      expect(
        mounted.length,
        `the tail window mounts exactly ${String(WINDOW_MAX)} rows (got ${String(mounted.length)} of ${String(TOTAL_ROWS)} mapped rows)`,
      ).toBe(WINDOW_MAX)

      const text = rendered.container.textContent ?? ''
      // The tail is on screen: the last question, its tool call and its answer.
      expect(text, 'the newest question is mounted').toContain(question(TURNS - 1))
      expect(text, 'the newest answer is mounted').toContain(answer(TURNS - 1))
      expect(text, 'the newest tool call is mounted').toContain(toolMarker(TURNS - 1))
      // The head is NOT in the DOM at all — windowed, not merely scrolled or
      // hidden by CSS (a CSS-hidden row would still be mounted and still costly).
      expect(text, 'the oldest question is not mounted').not.toContain(question(0))
      expect(text, 'the oldest tool call is not mounted').not.toContain(toolMarker(0))
      expect(text, 'the oldest answer is not mounted').not.toContain(answer(0))
    } finally {
      rendered.unmount()
    }
  })

  it('pays for every hidden row with a top spacer and gives that height back exactly, reveal by reveal', async () => {
    harness.wire.events = WIRE
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const container = rendered.container
      const scroller = scrollerOf(container)
      const firstRow = mountedRows(container)[0]
      expect(firstRow, 'the window mounts rows carrying the row hook').toBeDefined()

      // §3: the hidden history is held open by a top spacer with a declared,
      // non-zero height, above the first mounted row.
      const spacer = spacerOf(container)
      expect(spacer, 'the hidden history is held open by a spacer').not.toBeNull()
      expect(declaredHeightOf(spacer as HTMLElement), 'the spacer declares a positive height').toBeGreaterThan(0)
      expect(precedes(spacer as Element, firstRow as Element), 'the spacer sits above the mounted rows').toBe(true)

      // §5: the reveal control exists, above the mounted rows too.
      const reveal = revealOf(container)
      expect(reveal, 'the reveal control exists while history is hidden').not.toBeNull()
      expect(precedes(reveal as Element, firstRow as Element), 'the reveal control sits above the mounted rows').toBe(true)

      /** (mounted rows, declared spacer height) after each activation. */
      const states: Array<{ mounted: number; height: number }> = []
      const record = (): void => {
        const current = spacerOf(container)
        states.push({
          mounted: mountedRows(container).length,
          height: current === null ? 0 : declaredHeightOf(current),
        })
      }
      record()

      // §6: reveal until nothing is hidden left.
      let clicks = 0
      while (revealOf(container) !== null && clicks < MAX_REVEAL_CLICKS) {
        const control = revealOf(container) as HTMLElement
        act(() => { control.click() })
        await harness.flush(4)
        record()
        clicks += 1
      }
      expect(clicks, 'at least one history segment is revealable').toBeGreaterThan(0)
      expect(clicks, `the control exhausts the history within ${String(MAX_REVEAL_CLICKS)} activations`).toBeLessThan(MAX_REVEAL_CLICKS)
      expect(revealOf(container), 'the control retires once nothing is hidden').toBeNull()

      const total = states.at(-1)?.mounted ?? 0
      // §6: no row was dropped by the window — every mapped row is recoverable.
      expect(total, 'revealing everything mounts every mapped row').toBe(TOTAL_ROWS)

      // §6: each activation mounts the contracted step (the last, the remainder).
      for (let index = 1; index < states.length; index += 1) {
        const before = states[index - 1] as { mounted: number; height: number }
        const after = states[index] as { mounted: number; height: number }
        const remaining = total - before.mounted
        expect(
          after.mounted - before.mounted,
          `reveal #${String(index)} mounts ${String(Math.min(REVEAL_STEP, remaining))} rows`,
        ).toBe(Math.min(REVEAL_STEP, remaining))
      }

      // §4: the spacer's cost per hidden row is CONSTANT across reveals — the
      // revealed rows are paid back by exactly the spacer height they free.
      const costs = states
        .filter(state => state.mounted < total)
        .map(state => state.height / (total - state.mounted))
      expect(costs.length, 'the history spans more than one window').toBeGreaterThan(0)
      const unit = costs[0] as number
      expect(unit, 'a hidden row is worth a positive spacer height').toBeGreaterThan(0)
      for (const cost of costs) {
        expect(cost, 'the spacer stays linear in the hidden row count').toBeCloseTo(unit, 6)
      }

      // §4: with nothing hidden there is nothing left to hold open.
      expect(states.at(-1)?.height, 'the spacer retires with the last reveal').toBe(0)
      // The scroller still holds the rows themselves in document order.
      expect(scroller.contains(firstRow as Element)).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('takes the reveal copy from the locale dictionary with the hidden count, never a hardcoded literal', async () => {
    // English, so a Chinese literal immediately shows up as a CJK assertion.
    attachLocale(new FixedLocale('en'))
    harness.wire.events = WIRE
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const mounted = mountedRows(rendered.container).length
      const hidden = TOTAL_ROWS - mounted
      expect(hidden, 'the control is showing because history is hidden').toBeGreaterThan(0)

      const reveal = revealOf(rendered.container)
      expect(reveal, 'the reveal control is present').not.toBeNull()

      const copy = revealCopy(hidden)
      expect(copy, `the ${REVEAL_KEY} key must exist in the en dictionary`).not.toBe(REVEAL_KEY)
      expect(
        (reveal as HTMLElement).textContent?.trim(),
        'the control shows the locale copy for the hidden row count',
      ).toBe(copy)
      expect(copy, 'the English copy carries no CJK literal').not.toMatch(/[\u3400-\u9fff\u3040-\u30ff]/)
      expect(copy, 'the copy reports the hidden row count').toContain(String(hidden))

      // The same key must resolve to real copy in zh as well (zh is the source
      // dictionary; a missing en entry would have fallen back to the key).
      attachLocale(new FixedLocale('zh'))
      const zhCopy = revealCopy(hidden)
      expect(zhCopy, `the ${REVEAL_KEY} key must exist in the zh dictionary`).not.toBe(REVEAL_KEY)
      expect(zhCopy, 'zh and en are different dictionary entries').not.toBe(copy)
    } finally {
      rendered.unmount()
    }
  })
})
