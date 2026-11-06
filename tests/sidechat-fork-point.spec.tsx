// @vitest-environment jsdom
/**
 * R2 (client half) — the transcript shows the pre-fork context the way the user
 * asked for it: the parent's last exchange rendered as ORDINARY conversation,
 * opened by one divider line that says where it came from. Design basis: the
 * field report on the card that shipped first (`/tmp/bsb-parity/forkpoint-recon.md`
 * §Q3/§Q4 introduced the field; the presentation changed twice after review).
 *
 * Why this spec exists: a side thread opens on the side question, as if the
 * conversation began there — yet it was forked to continue a main-pane exchange.
 * The first attempt drew a card (a disclosure with a caption and a body); the
 * reader's verdict was that it should not be a card at all: the inherited
 * question and answer should look exactly like the messages below them, with
 * one divider marking the boundary.
 *
 * ============================ CONTRACT ============================
 * 1. PLACEMENT, NO CARD. When the first pull carries `fork` with something to
 *    show, the transcript renders ONE block inside its scroll container, ABOVE
 *    the first mounted transcript row. `[data-sidechat-fork-point]` is a plain
 *    container: it holds NO `<details>` and NO `<summary>` — nothing about the
 *    fork block is expandable.
 * 2. TWO DIVIDERS BRACKET THE EXCHANGE. The block OPENS with a divider row
 *    carrying `data-sidechat-fork-divider` and the localized
 *    `t('sideChatForkDivider')` ("the main session before the fork"), and it
 *    CLOSES with the matching row carrying `data-sidechat-fork-divider-end` and
 *    `t('sideChatForkDividerEnd')` ("… ends here"), so the reader can see where
 *    the inherited context stops. Both are the SAME line: same element kind,
 *    a shared style class (one composable), never a button/link/control, and
 *    never a transcript row. The hairline itself is CSS; the hooks and the copy
 *    are what the DOM pins.
 * 3. THEN THE INHERITED QUESTION, presented like a user message of THIS thread:
 *    the same `sidechatUser` presentation block, markdown-rendered, carrying
 *    `data-sidechat-fork-question`, in FULL (the route no longer caps it — no
 *    ellipsis, no client-side shortening).
 * 4. THEN THE INHERITED ANSWER, presented like a normal assistant message: the
 *    same `sidechatAssistant` presentation block and the same markdown
 *    renderer (emphasis becomes `<strong>`, a code span becomes `<code>`), in
 *    FULL and never truncated.
 * 5. NO ANSWER = no assistant block: with `assistant` absent the block is the
 *    opening divider, the question, and the CLOSING divider; nothing pretends an
 *    answer exists.
 * 6. NOTHING TO SAY = NO BLOCK: without the field, or with a field carrying
 *    neither `user` nor `assistant` (an empty seed), the transcript renders no
 *    fork block at all.
 * 7. CHROME, NOT CONVERSATION: the block carries no
 *    `data-sidechat-transcript-row` and changes neither the number nor the
 *    content of the mounted transcript rows.
 *
 * Locale keys this contract needs (every shipped dictionary, not just zh/en):
 *   `sideChatForkDivider`    — the opening divider's copy
 *   `sideChatForkDividerEnd` — the closing divider's copy ("… ends here")
 * (`sideChatForkBanner` / `sideChatForkAnswer` belonged to the retired card and
 * leave with it.)
 * ==================================================================
 *
 * The harness's fetch stub answers `sidechat.events` from `wire`, which owns no
 * `fork` field; this spec wraps the stub (the harness is untouched) to inject
 * it into the envelope, exactly as the host route does — the same technique the
 * truncation notice spec uses for `truncated`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The opening divider's copy. */
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

describe('fork point block (R2)', () => {
  it('defines both divider copies in the dictionaries', () => {
    for (const key of [DIVIDER_KEY, END_DIVIDER_KEY]) {
      expect(copy(key), `the ${key} key must exist in the locale dictionary`).not.toBe(key)
    }
  })

  it('renders a plain, non-expandable block above the transcript', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const container = rendered.container
      const block = blockOf(container)
      expect(block, 'the fork point is shown').not.toBeNull()
      const forkBlock = block as HTMLElement
      expect(scrollerOf(container).contains(forkBlock), 'it lives in the transcript chrome region').toBe(true)

      const rows = mountedRows(container)
      expect(rows.length, 'the transcript itself still renders').toBeGreaterThan(0)
      expect(precedes(forkBlock, rows[0] as Element), 'it sits above the first row').toBe(true)

      // Not a card: nothing about the fork block opens or closes.
      expect(forkBlock.querySelectorAll('details'), 'no disclosure').toHaveLength(0)
      expect(forkBlock.querySelectorAll('summary'), 'no summary line').toHaveLength(0)
      expect(container.textContent ?? '', 'the side thread itself still renders').toContain('SIDE-QUESTION')
    } finally {
      rendered.unmount()
    }
  })

  it('opens with the divider, then the inherited question', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      expect(block, 'the fork point is shown').not.toBeNull()

      const divider = block.querySelector<HTMLElement>('[data-sidechat-fork-divider]')
      expect(divider, 'the block opens with a divider row').not.toBeNull()
      expect(divider?.textContent ?? '', 'the divider says what follows').toContain(copy(DIVIDER_KEY))

      const question = block.querySelector<HTMLElement>('[data-sidechat-fork-question]')
      expect(question, 'the inherited question carries its own hook').not.toBeNull()
      expect(precedes(divider as HTMLElement, question as HTMLElement), 'the divider comes first').toBe(true)
      expect(question?.textContent, 'the question is quoted verbatim').toBe(PARENT_QUESTION)
      expect(
        presentedAs(question as HTMLElement, 'sidechatUser'),
        'it is presented like a user message of this thread',
      ).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('renders the inherited answer like a normal assistant message', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
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

  it('closes with the end divider after the inherited exchange', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      const start = block.querySelector<HTMLElement>('[data-sidechat-fork-divider]')
      const question = block.querySelector<HTMLElement>('[data-sidechat-fork-question]')
      const answer = partOf(block, 'PARENT-ANSWER with')?.closest<HTMLElement>('[class*="sidechatAssistant"]')
      const end = block.querySelector<HTMLElement>('[data-sidechat-fork-divider-end]')
      expect(start, 'the block still opens with a divider').not.toBeNull()
      expect(end, 'and now closes with one').not.toBeNull()
      expect(end?.textContent ?? '', 'the closing line says the inherited context ends')
        .toContain(copy(END_DIVIDER_KEY))
      expect(end?.textContent ?? '', 'the closing copy is translated, not a raw key')
        .not.toContain(END_DIVIDER_KEY)
      expect(precedes(start as HTMLElement, question as HTMLElement), 'order: opening divider').toBe(true)
      expect(precedes(question as HTMLElement, answer as HTMLElement), 'then the question').toBe(true)
      expect(
        precedes(answer as HTMLElement, end as HTMLElement),
        'then the answer, then the closing divider',
      ).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('renders both dividers as the same non-interactive line', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      const start = block.querySelector<HTMLElement>('[data-sidechat-fork-divider]')
      const end = block.querySelector<HTMLElement>('[data-sidechat-fork-divider-end]')
      expect(start, 'the opening divider exists').not.toBeNull()
      expect(end, 'the closing divider exists').not.toBeNull()
      expect(end?.tagName, 'both dividers are the same element kind').toBe(start?.tagName)
      const shared = classTokens(end as Element).filter(token => classTokens(start as Element).includes(token))
      expect(
        shared.length,
        'both dividers share the line style (one composable, same level)',
      ).toBeGreaterThan(0)
      for (const divider of [start as HTMLElement, end as HTMLElement]) {
        expect(divider.closest('button, a'), 'a divider is never wrapped in a control').toBeNull()
        expect(divider.getAttribute('role'), 'and never claims a control role').not.toBe('button')
        expect(divider.getAttribute('tabindex'), 'and is not focusable').toBeNull()
        expect(divider.querySelector('button, a'), 'and contains no control').toBeNull()
      }
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
    const rendered = await mountTranscript()
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

  it('renders the divider and the question only when there is no answer', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION } })
    const rendered = await mountTranscript()
    try {
      const block = blockOf(rendered.container) as HTMLElement
      expect(block, 'a fork summarised with just the question still renders').not.toBeNull()
      expect(block.querySelector('[data-sidechat-fork-divider]'), 'the divider is there').not.toBeNull()
      expect(block.querySelector('[data-sidechat-fork-question]'), 'and the question').not.toBeNull()
      const end = block.querySelector<HTMLElement>('[data-sidechat-fork-divider-end]')
      expect(end, 'and it still closes with the end divider').not.toBeNull()
      expect(
        precedes(block.querySelector('[data-sidechat-fork-question]') as HTMLElement, end as HTMLElement),
        'after the question',
      ).toBe(true)
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

  it('keeps the block out of the conversation rows', async () => {
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
      for (const selector of ['[data-sidechat-fork-divider]', '[data-sidechat-fork-divider-end]']) {
        expect(
          block.querySelector(selector)?.closest('[data-sidechat-transcript-row]') ?? null,
          `${selector} never counts as a transcript row`,
        ).toBeNull()
      }
      expect(
        mountedRows(rendered.container).length,
        'it does not change how many rows mount',
      ).toBe(baseline)
    } finally {
      rendered.unmount()
    }
  })
})
