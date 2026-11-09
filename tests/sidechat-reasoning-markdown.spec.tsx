// @vitest-environment jsdom
/**
 * D6 — the reasoning row must render as HOST MARKDOWN, through the same
 * delegate surface as assistant prose, and its collapsed summary must say how
 * much thinking there is. Design basis: `/tmp/bsb-parity/spec.md` §D6 / §3.6.
 *
 * Why this spec exists: `renderRow` gives the reasoning body a plain
 * `<div className={css.sidechatRowProse}>{row.text}</div>` with
 * `white-space: pre-wrap`. Reasoning models write lists, emphasis, inline code
 * and file references, so the reader gets a literal `**…**` wall — the one
 * place where the side chat still looks nothing like the main conversation
 * (whose `ReasoningContent` is markdown). The row also carries no disclosure
 * summary, so "is this worth expanding?" has no answer.
 *
 * ============================ CONTRACT ============================
 * 1. MARKDOWN. The reasoning body renders through the host `MarkdownText`
 *    (the same component the assistant prose uses), so GFM structure becomes
 *    elements: `**bold**` → `<strong>`, `- item` → `<li>`, `` `code` `` →
 *    `<code>`. No raw marker text may survive in the body (`**bold**` must not
 *    appear literally).
 * 2. SAME SURFACE. The row delegates through the SAME `MarkdownDelegateProvider`
 *    as assistant prose: a local `[text](<path:line>)` link inside reasoning is
 *    CLAIMED — it renders as the host's link control, not literal text — and
 *    activating it opens the same file at the same line through the host face
 *    (`betterSidebar.openTab`), which is exactly what the assistant row's
 *    identical link does. (The transcript's source-side rewrite pass is NOT
 *    separately observable here: with a provider in scope the host claims local
 *    destinations itself, so a row rendered "without the pass" produces the
 *    same control. What this spec pins is the delegate — the part that decides
 *    whether reasoning prose behaves like prose at all.)
 * 3. SUMMARY. The collapsed row shows a char-count summary from the locale key
 *    `SIDECHAT_REASONING_SUMMARY_KEY = 'sideChatReasoningSummary'` with the
 *    `{ chars }` parameter (the RAW reasoning text length), added to the zh, en
 *    and ja dictionaries like every other key (`tests/locales.spec.ts` keeps the
 *    three key sets equal). No duration is shown: the transcript's reasoning
 *    rows carry no timing data (only `assistant/message` usage is aggregated,
 *    per turn), so a duration would have to be invented.
 * 4. The collapsed body stays the row's only expandable content: the summary is
 *    in the `<summary>`, the markdown is in the disclosed body.
 * ==================================================================
 *
 * The row is located by its existing label (`t('sideChatThink')`) so the spec
 * does not depend on the renderer's class names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The locale key the collapsed reasoning summary must come from. */
const SIDECHAT_REASONING_SUMMARY_KEY = 'sideChatReasoningSummary'

/** Reasoning prose that exercises emphasis, a list, inline code and a link. */
const REASONING = [
  'Thinking about **the plan**:',
  '',
  '- first step',
  '- second step',
  '',
  'Run `npm test` after.',
  '',
  'See [source](<src/Foo.java:37-58>) for the entry point.',
].join('\n')

/** The assistant's answer, carrying the same link so the two surfaces can be compared. */
const ANSWER = 'Done — see [source](<src/Foo.java:37-58>).'

/** The thread's own (seed-cut) log: one reasoning block plus one text block. */
function events(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'why?' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: REASONING },
            { type: 'text', text: ANSWER },
          ],
        },
      },
    },
  ]
}

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** The collapsed reasoning row (`<details>` whose summary carries the think label). */
function reasoningRow(container: HTMLElement): HTMLElement {
  const label = copy('sideChatThink')
  const rows = [...container.querySelectorAll<HTMLElement>('details')]
  const row = rows.find(element => element.querySelector('summary')?.textContent?.includes(label) === true)
  expect(row, `a reasoning row labelled "${label}" renders`).toBeDefined()
  return row as HTMLElement
}

/** The expandable body of the reasoning row. */
function reasoningBody(container: HTMLElement): HTMLElement {
  const body = reasoningRow(container).querySelector<HTMLElement>('[class*="sidechatRowBody"]')
  expect(body, 'the reasoning row discloses a body').not.toBeNull()
  return body as HTMLElement
}

/** The collapsed summary line of the reasoning row. */
function reasoningMeta(container: HTMLElement): string {
  const meta = reasoningRow(container).querySelector('[class*="sidechatRowMeta"]')
  expect(meta, 'the reasoning row shows a summary beside its label').not.toBeNull()
  return (meta as HTMLElement).textContent ?? ''
}

/** Every host link control in a subtree (a claimed local link renders as a button). */
function linkControls(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button')]
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

describe('reasoning rows render host markdown (D6)', () => {
  it('renders emphasis, lists and inline code as elements instead of literal markers', async () => {
    const rendered = await mountTranscript()
    try {
      const body = reasoningBody(rendered.container)

      const strong = body.querySelector('strong')
      expect(strong, 'emphasis becomes a <strong>').not.toBeNull()
      expect(strong?.textContent).toBe('the plan')

      const items = [...body.querySelectorAll('li')].map(item => item.textContent?.trim())
      expect(items, 'the list becomes <li> elements').toEqual(['first step', 'second step'])

      const code = [...body.querySelectorAll('code')].map(node => node.textContent)
      expect(code, 'inline code becomes a <code>').toContain('npm test')

      // The raw markdown syntax must not survive as text.
      const text = body.textContent ?? ''
      expect(text, 'no literal emphasis markers').not.toContain('**')
      expect(text, 'no literal list markers').not.toContain('- first step')
      expect(text, 'no literal code fences').not.toContain('`npm test`')
    } finally {
      rendered.unmount()
    }
  })

  it('claims local links in reasoning through the same delegate surface as assistant prose', async () => {
    const rendered = await mountTranscript()
    try {
      const reasoningLinks = linkControls(reasoningBody(rendered.container))
      const reasoningLink = reasoningLinks.find(button => button.title.includes('src/Foo.java'))
      expect(reasoningLink, 'a local markdown link inside reasoning is claimed like prose').toBeDefined()

      // The assistant prose claims the very same link the very same way.
      const assistantLinks = linkControls(rendered.container)
        .filter(button => button !== reasoningLink && button.title.includes('src/Foo.java'))
      expect(assistantLinks.length, 'assistant prose claims the same link').toBeGreaterThan(0)

      act(() => { (reasoningLink as HTMLButtonElement).click() })
      expect(
        harness.host.openTab,
        'activating the reasoning link opens the file at the referenced line, through the host face',
      ).toHaveBeenCalledWith(expect.objectContaining({ path: '/p/src/Foo.java', line: 37 }))
    } finally {
      rendered.unmount()
    }
  })

  it('shows the reasoning length in the collapsed summary, from the locale dictionary', async () => {
    const rendered = await mountTranscript()
    try {
      const expected = copy(SIDECHAT_REASONING_SUMMARY_KEY, { chars: REASONING.length })
      expect(
        expected,
        `the ${SIDECHAT_REASONING_SUMMARY_KEY} key must exist in the locale dictionary`,
      ).not.toBe(SIDECHAT_REASONING_SUMMARY_KEY)
      expect(expected, 'the copy reports the character count').toContain(String(REASONING.length))
      expect(reasoningMeta(rendered.container).trim()).toBe(expected)
    } finally {
      rendered.unmount()
    }
  })
})
