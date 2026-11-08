// @vitest-environment jsdom
/**
 * R2 (client half) — the pre-fork context is TUCKED AWAY behind one divider
 * line: the reader sees "the main session before the fork" and expands it only
 * if they want the inherited exchange. Design basis: the fork-point recon
 * (`/tmp/bsb-parity/forkpoint-recon.md` §Q3/§Q4) plus the reader's verdict on
 * the previous two presentations (a card, then a permanently open exchange).
 *
 * Why this spec exists: a side thread opens on the side question, as if the
 * conversation began there — the inherited exchange explains where it came from,
 * but rendered permanently open it pushes the reader's own question off the
 * first screen and reads as if THIS thread had asked it. It is context, not
 * conversation: one collapsed line, expandable on demand.
 *
 * ============================ CONTRACT ============================
 * 1. COLLAPSED BY DEFAULT. `[data-sidechat-fork-point]` is a native
 *    `<details>` inside the transcript's scroll container, ABOVE the first
 *    mounted transcript row, and it starts CLOSED — no `open` attribute, and
 *    `details.open === false` after the first render.
 * 2. THE LINE IS THE OPENING DIVIDER. Its `<summary>` carries the divider copy
 *    `t('sideChatForkDivider')` (the same divider styling as the closing line)
 *    and the expand chevron. The summary holds NO inherited text: neither the
 *    question nor the answer may appear inside it.
 * 3. EXPANDED ORDER: the inherited question (presented like a user message of
 *    this thread — the same `sidechatUser` block, markdown, `data-sidechat-fork-question`,
 *    verbatim) → the inherited answer (the same `sidechatAssistant` block and
 *    renderer, verbatim) → the closing divider `data-sidechat-fork-divider-end`
 *    with `t('sideChatForkDividerEnd')`.
 * 4. NO ANSWER: expanded, the block is the question plus the closing divider;
 *    nothing pretends an answer exists.
 * 5. CHROME, NOT CONVERSATION: the block is not a transcript row and changes
 *    neither the number nor the content of the mounted rows — and expanding or
 *    collapsing it does not change that count either.
 * 6. NOTHING INTERACTIVE BEYOND THE SUMMARY: the summary is the disclosure's own
 *    control; the dividers add no button, link or focusable row of their own.
 * 7. NOTHING TO SAY = NO BLOCK: without the field, or with a field carrying
 *    neither `user` nor `assistant` (an empty seed), no block renders at all.
 *
 * Locale keys this contract needs (every shipped dictionary, not just zh/en):
 *   `sideChatForkDivider`    — the opening divider's (and the summary's) copy
 *   `sideChatForkDividerEnd` — the closing divider's copy ("… ends here")
 * ==================================================================
 *
 * The harness's fetch stub answers `sidechat.events` from `wire`, which owns no
 * `fork` field; this spec wraps the stub (the harness is untouched) to inject
 * it into the envelope, exactly as the host route does — the same technique the
 * truncation notice spec uses for `truncated`.
 *
 * jsdom toggles `details.open` on a summary click but fires no `toggle` event,
 * so {@link expand} drives BOTH: the click covers a native/`onClick`
 * implementation, the dispatched `toggle` covers the `onToggle` one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The opening divider's (and the summary's) copy. */
const DIVIDER_KEY = 'sideChatForkDivider'
/** The closing divider's copy ("… ends here"). */
const END_DIVIDER_KEY = 'sideChatForkDividerEnd'

/** What the route reports for the parent's last exchange. */
const PARENT_QUESTION = 'PARENT-QUESTION-TWO'
/** The answer carries markdown: the block must render it the way a normal
 *  assistant row does, so emphasis and code spans become elements. */
const PARENT_ANSWER = 'PARENT-ANSWER with **emphasis** and a `code span`'

/** A question well past the old 400-character cap. */
const LONG_QUESTION = `${'question words here. '.repeat(60)}LAST-QUESTION-WORDS`
/** An answer well past the old 4000-character cap, still ending in markdown. */
const LONG_ANSWER = `${'A long sentence about the work. '.repeat(200)}**the end**`

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** The field the route adds to the `sidechat.events` result. */
interface ForkField {
  cutSeq: number
  user?: { seq: number; text: string }
  assistant?: { seq: number; text: string }
}

/** The thread's own (seed-cut) log: the side question and its answer. */
function events(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } },
    {
      type: 'user/message',
      seq: 1,
      time: 1_000,
      surfaceOp: 'append',
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'SIDE-QUESTION' }], source: { kind: 'user' } },
    },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3_000,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'SIDE-ANSWER' }] } },
    },
    { type: 'turn/end', seq: 4, time: 4_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Wrap the harness's `sidechat.events` envelope so the FIRST pull carries
 * `fork`, the way the host route will.
 * @param fork - the field to inject, or undefined to leave the response alone.
 */
function reportFork(fork: ForkField | undefined): void {
  if (fork === undefined) return
  const stubbed = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await stubbed(input as string, init)
    if (!String(input).endsWith('sidechat.events')) return response
    const body = await response.json() as { ok?: boolean; value?: Record<string, unknown> }
    // A delta poll answers without the field, exactly like the route.
    const isFirstPull = !String(init?.body ?? '').includes('afterSeq')
    return {
      ok: response.ok,
      status: response.status,
      json: async () => ({ ...body, value: { ...body.value, ...(isFirstPull ? { fork } : {}) } }),
    } as unknown as Response
  })
}

/** The transcript's scroll container. */
function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('[data-genui-surface="dsh-better-sidebar/sidechat"]')
  expect(scroller, 'the transcript renders its scroll container').not.toBeNull()
  return scroller as HTMLElement
}

/** The mounted transcript rows, in document order. */
function mountedRows(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-sidechat-transcript-row]')]
}

/** The fork block, or null when the transcript shows none. */
function blockOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-sidechat-fork-point]')
}

/** The innermost element carrying `needle` (document order puts descendants last). */
function innermost(scope: HTMLElement, needle: string): HTMLElement | undefined {
  const matches = [...scope.querySelectorAll<HTMLElement>('*')]
    .filter(element => (element.textContent ?? '').includes(needle))
  return matches.at(-1)
}

/** The class tokens of an element (its CSS-module classes). */
function classTokens(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(token => token !== '')
}

/** Whether `earlier` precedes `later` in document order. */
function precedes(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** The node that presents one part of the fork block, inside `block`. */
function partOf(block: HTMLElement, marker: string): HTMLElement | undefined {
  return innermost(block, marker)
}

/**
 * Whether `node` is presented with the transcript's own block for `kind`: the
 * same `sidechatUser` / `sidechatAssistant` styling a real message row uses, so
 * the two can never drift apart in type size or colour.
 * @param node - the element carrying the inherited text.
 * @param kind - which presentation block to require.
 */
function presentedAs(node: HTMLElement, kind: 'sidechatUser' | 'sidechatAssistant'): boolean {
  return node.closest(`[class*="${kind}"]`) !== null
}

/** The block's always-visible line. */
function summaryOf(block: HTMLElement): HTMLElement | null {
  return block.querySelector('summary')
}

/**
 * Expand the block the way a reader does: click the summary (which is what a
 * browser toggles on) and fire the `toggle` event jsdom does not emit.
 * @param block - the fork block.
 */
function expand(block: HTMLElement): void {
  act(() => {
    summaryOf(block)?.click()
    block.dispatchEvent(new Event('toggle'))
  })
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
  await harness.flush(6)
  return rendered
}

/** Mount, expand the fork block, and hand it back. */
async function mountExpanded() {
  const rendered = await mountTranscript()
  expand(blockOf(rendered.container) as HTMLElement)
  await harness.flush(4)
  return rendered
}

describe('fork point block (R2)', () => {
  it('defines both divider copies in the dictionaries', () => {
    for (const key of [DIVIDER_KEY, END_DIVIDER_KEY]) {
      expect(copy(key), `the ${key} key must exist in the locale dictionary`).not.toBe(key)
    }
  })

  it('starts collapsed above the transcript', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const container = rendered.container
      const block = blockOf(container)
      expect(block, 'the fork point is shown').not.toBeNull()
      const forkBlock = block as HTMLElement
      expect(forkBlock.tagName, 'the block is a native disclosure').toBe('DETAILS')
      expect(forkBlock.hasAttribute('open'), 'and it starts closed').toBe(false)
      expect((forkBlock as HTMLDetailsElement).open, 'details.open is false').toBe(false)
      expect(scrollerOf(container).contains(forkBlock), 'it lives in the transcript chrome region').toBe(true)

      const rows = mountedRows(container)
      expect(rows.length, 'the transcript itself still renders').toBeGreaterThan(0)
      expect(precedes(forkBlock, rows[0] as Element), 'it sits above the first row').toBe(true)

      const line = summaryOf(forkBlock)
      expect(line, 'the collapsed line is the summary').not.toBeNull()
      expect(line?.textContent ?? '', 'and says what it hides').toContain(copy(DIVIDER_KEY))
      expect(
        line?.querySelector('svg, [class*="sidechatRowChevron"]') ?? null,
        'the line carries the expand chevron',
      ).not.toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the collapsed line to the divider copy', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const container = rendered.container
      const block = blockOf(container) as HTMLElement
      const line = summaryOf(block) as HTMLElement
      expect(line, 'the collapsed line is the summary').not.toBeNull()
      expect(
        line.textContent ?? '',
        'the inherited question never shows on the collapsed line',
      ).not.toContain(PARENT_QUESTION)
      expect(
        line.textContent ?? '',
        'and neither does the inherited answer',
      ).not.toContain(PARENT_ANSWER)
      expect(line.querySelector('[data-sidechat-fork-question]'), 'no question node in the line').toBeNull()
      expect(line.querySelector('[class*="sidechatAssistant"]'), 'no answer block in the line').toBeNull()

      // Whatever the body holds, it belongs to the disclosure — never to a
      // sibling that would render as conversation.
      const question = container.querySelector('[data-sidechat-fork-question]')
      if (question !== null) {
        expect(block.contains(question), 'the body lives inside the disclosure').toBe(true)
      }
    } finally {
      rendered.unmount()
    }
  })

  it('reveals the inherited exchange only after it is expanded', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const container = rendered.container
      const block = blockOf(container) as HTMLElement
      const line = summaryOf(block) as HTMLElement
      expect(line, 'the collapsed line is the summary').not.toBeNull()

      expand(block)
      await harness.flush(4)
      expect((block as HTMLDetailsElement).open, 'the disclosure is open').toBe(true)

      const question = block.querySelector<HTMLElement>('[data-sidechat-fork-question]')
      const answer = partOf(block, 'PARENT-ANSWER with')?.closest<HTMLElement>('[class*="sidechatAssistant"]')
      const end = block.querySelector<HTMLElement>('[data-sidechat-fork-divider-end]')
      expect(question, 'the question is revealed').not.toBeNull()
      expect(answer, 'and the answer').not.toBeNull()
      expect(end, 'and the closing divider').not.toBeNull()
      expect(line.contains(question as HTMLElement), 'the question is in the body, not the line').toBe(false)
      expect(precedes(line, question as HTMLElement), 'order: the line first').toBe(true)
      expect(precedes(question as HTMLElement, answer as HTMLElement), 'then the question').toBe(true)
      expect(precedes(answer as HTMLElement, end as HTMLElement), 'then the answer').toBe(true)
      expect(end?.textContent ?? '', 'the closing line says the context ends')
        .toContain(copy(END_DIVIDER_KEY))
    } finally {
      rendered.unmount()
    }
  })

  it('presents the inherited question like a user message of this thread', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountExpanded()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      const question = block.querySelector<HTMLElement>('[data-sidechat-fork-question]')
      expect(question, 'the inherited question carries its own hook').not.toBeNull()
      expect(question?.textContent, 'the question is quoted verbatim').toBe(PARENT_QUESTION)
      expect(
        presentedAs(question as HTMLElement, 'sidechatUser'),
        'it is presented like a user message of this thread',
      ).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('presents the inherited answer like a normal assistant message', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountExpanded()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      const answer = partOf(block, 'PARENT-ANSWER with')
      expect(answer, 'the inherited answer renders').toBeDefined()
      expect(
        presentedAs(answer as HTMLElement, 'sidechatAssistant'),
        'it uses the same presentation block as a normal assistant message',
      ).toBe(true)
      expect(
        answer?.closest('[class*="sidechatAssistant"]')?.querySelector('strong'),
        'and goes through the same markdown renderer (emphasis becomes <strong>)',
      ).not.toBeNull()
      expect(
        answer?.closest('[class*="sidechatAssistant"]')?.querySelector('code'),
        'a code span becomes <code>',
      ).not.toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('carries the inherited question and answer in full, with no truncation mark', async () => {
    reportFork({
      cutSeq: 0,
      user: { seq: 3, text: LONG_QUESTION },
      assistant: { seq: 4, text: LONG_ANSWER },
    })
    const rendered = await mountExpanded()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      const question = block.querySelector<HTMLElement>('[data-sidechat-fork-question]')
      expect(question?.textContent, 'the whole question arrives').toBe(LONG_QUESTION)
      expect(question?.textContent ?? '', 'and carries no truncation mark').not.toMatch(/…$|\.\.\.$/)
      const answerBlock = partOf(block, 'A long sentence about the work.')
        ?.closest<HTMLElement>('[class*="sidechatAssistant"]')
      expect(answerBlock, 'the whole answer arrives').toBeTruthy()
      expect(answerBlock?.textContent ?? '', 'the whole answer arrives').toContain('the end')
      expect(answerBlock?.textContent ?? '', 'and carries no truncation mark').not.toMatch(/…$|\.\.\.$/)
    } finally {
      rendered.unmount()
    }
  })

  it('renders both dividers as the same line, with no extra controls', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountExpanded()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      const line = summaryOf(block)
      expect(line, 'the collapsed line is the summary').not.toBeNull()
      const start = block.querySelector<HTMLElement>('[data-sidechat-fork-divider]')
      const end = block.querySelector<HTMLElement>('[data-sidechat-fork-divider-end]')
      expect(start, 'the opening divider exists').not.toBeNull()
      expect(end, 'the closing divider exists').not.toBeNull()
      // The opening line IS the summary (or lives inside it).
      expect(
        start === line || (line?.contains(start as HTMLElement) ?? false),
        'the opening divider is the collapsed line',
      ).toBe(true)
      const shared = classTokens(end as Element).filter(token => classTokens(start as Element).includes(token))
      expect(shared.length, 'both dividers share the divider style').toBeGreaterThan(0)
      // The summary is the only control; neither divider adds another one.
      expect(
        (start as HTMLElement).querySelector('button, a'),
        'the opening line adds no button/link of its own',
      ).toBeNull()
      expect((end as HTMLElement).querySelector('button, a'), 'the closing line adds no control').toBeNull()
      expect(end?.getAttribute('role'), 'the closing line claims no role').toBeNull()
      expect(end?.getAttribute('tabindex'), 'and is not focusable').toBeNull()
      expect(block.querySelectorAll('button, a'), 'the block adds no buttons or links').toHaveLength(0)
    } finally {
      rendered.unmount()
    }
  })

  it('renders the question and the closing divider only when there is no answer', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION } })
    const rendered = await mountExpanded()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      const question = block.querySelector<HTMLElement>('[data-sidechat-fork-question]')
      const end = block.querySelector<HTMLElement>('[data-sidechat-fork-divider-end]')
      expect(question, 'the question is revealed').not.toBeNull()
      expect(end, 'and the closing divider').not.toBeNull()
      expect(precedes(question as HTMLElement, end as HTMLElement), 'after the question').toBe(true)
      expect(
        block.querySelector('[class*="sidechatAssistant"]'),
        'but nothing pretends an answer exists',
      ).toBeNull()
      expect(block.textContent ?? '', 'no absent field leaks into the copy').not.toContain('undefined')
    } finally {
      rendered.unmount()
    }
  })

  it('renders no block when the route reports no fork point', async () => {
    const rendered = await mountTranscript()
    try {
      expect(blockOf(rendered.container), 'an unseeded thread has nothing to show').toBeNull()
      expect(rendered.container.textContent ?? '', 'and the transcript is whole').toContain('SIDE-ANSWER')
    } finally {
      rendered.unmount()
    }
  })

  it('renders no block when the fork point carries nothing to show', async () => {
    reportFork({ cutSeq: 0 })
    const rendered = await mountTranscript()
    try {
      expect(blockOf(rendered.container), 'an empty seed renders no empty block').toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the block out of the conversation rows, collapsed or expanded', async () => {
    const plain = await mountTranscript()
    const baseline = mountedRows(plain.container).length
    plain.unmount()

    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      expect(block, 'the block exists for this comparison').not.toBeNull()
      expect(block.closest('[data-sidechat-transcript-row]'), 'the block is not a transcript row').toBeNull()
      expect(block.querySelector('[data-sidechat-transcript-row]'), 'and contains none').toBeNull()
      expect(
        mountedRows(rendered.container).length,
        'it does not change how many rows mount',
      ).toBe(baseline)

      expand(block)
      await harness.flush(4)
      expect(
        mountedRows(rendered.container).length,
        'expanding it does not add conversation rows either',
      ).toBe(baseline)
    } finally {
      rendered.unmount()
    }
  })
})
