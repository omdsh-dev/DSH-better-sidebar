// @vitest-environment jsdom
/**
 * D11 — a generic tool row must read like a sentence when collapsed and like two
 * LABELLED sections when expanded, instead of dumping raw arguments JSON next to
 * raw output. Design basis: `/tmp/bsb-parity/spec.md` §D11 / §3.10.
 *
 * Why this spec exists: only bash / edit / write / read / present get structured
 * cards (`toolCardBody`). Every other tool — grep, glob, web_search, and every
 * host tool the plugin does not know — falls through to
 * `<pre>{row.args}</pre>` + `<pre>{row.resultText}</pre>` with no labels: two
 * unlabelled blocks of raw JSON and raw output, one of which is a wall of
 * escaped quotes. The main conversation renders a per-tool view (search block,
 * web block) because "what did it send and what came back" needs to be readable
 * at a glance.
 *
 * ============================ CONTRACT ============================
 * For a tool row WITHOUT a structured card (the generic case):
 * 1. COLLAPSED LINE. The row is a disclosure (`<details>`), closed on mount, and
 *    its summary line shows the tool name plus `toolArgsSummary(args)` — nothing
 *    else. No raw JSON may appear on that line (`{"`, `"pattern":`, …), and no
 *    raw result text either.
 * 2. EXPANDED BODY. The disclosed body is TWO labelled sections in this order:
 *      `t('sideChatToolArguments')` → the raw arguments,
 *      `t('sideChatToolResult')`    → the plain result text.
 *    Each label precedes its own content, and the arguments section precedes the
 *    result section. The raw content lives in that body (never on the collapsed
 *    line), so a reader who expands always knows which block is which.
 * 3. Dedicated cards are untouched: a `bash` call still renders its terminal
 *    card (the command line + the marker-stripped output) and gains no
 *    arguments/result labels.
 *
 * The two labels are new locale keys — `sideChatToolArguments` and
 * `sideChatToolResult` — and must land in ALL shipped dictionaries: the zh and
 * en source dicts plus the 19 third-language files under
 * `src/client/locales-*.ts` (`tests/locales.spec.ts` keeps every key set equal
 * to zh, so a partial translation fails a gate rather than falling back to en).
 * ==================================================================
 *
 * jsdom does not implement `<details>` disclosure rendering: a closed row's body
 * is still in the DOM. "Collapsed" is therefore asserted on the SUMMARY LINE
 * (what the reader sees) plus the disclosure state, and "expanded" by opening
 * the `<details>` the way a summary click does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { toolArgsSummary } from '../src/client/sidechat-transcript.ts'
import { t } from '../src/client/locales.ts'

/** The two section labels this contract names. */
const ARGS_KEY = 'sideChatToolArguments'
const RESULT_KEY = 'sideChatToolResult'

/** A generic tool's raw arguments — deliberately JSON-looking. */
const ARGS = '{"pattern":"needle","path":"src"}'
/** Its raw output. */
const RESULT = 'src/a.ts:3: needle found'

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** One generic (unstructured) tool call plus its result. */
function genericToolEvents(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'find it' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    { type: 'tool/call', seq: 3, time: 3_000, data: { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: ARGS } },
    {
      type: 'tool/result',
      seq: 4,
      time: 4_000,
      data: {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: RESULT }] }] },
      },
    },
  ]
}

/** A bash call, which has a dedicated terminal card. */
function bashToolEvents(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    { type: 'tool/call', seq: 3, time: 3_000, data: { turn: 1, step: 1, callId: 'b1', name: 'bash', arguments: '{"command":"echo bash-card-ok"}' } },
    {
      type: 'tool/result',
      seq: 4,
      time: 4_000,
      data: {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId: 'b1' }, content: [{ type: 'tool-result', toolCallId: 'b1', content: [{ type: 'text', text: 'bash-card-ok\n[exit code: 0]' }] }] },
      },
    },
  ]
}

/** The disclosure row whose summary names `tool`. */
function toolRow(container: HTMLElement, tool: string): HTMLDetailsElement {
  const rows = [...container.querySelectorAll<HTMLDetailsElement>('details')]
  const row = rows.find(element => element.querySelector('summary')?.textContent?.includes(tool) === true)
  expect(row, `a ${tool} tool row renders as a disclosure`).toBeDefined()
  return row as HTMLDetailsElement
}

/** The collapsed line (what the reader sees before expanding). */
function summaryOf(row: HTMLElement): HTMLElement {
  const summary = row.querySelector('summary')
  expect(summary, 'the row renders a summary line').not.toBeNull()
  return summary as HTMLElement
}

/** The disclosed body (everything the summary is not). */
function bodyOf(row: HTMLElement): HTMLElement {
  const body = row.querySelector<HTMLElement>('[class*="sidechatRowBody"]')
  expect(body, 'the row discloses a body').not.toBeNull()
  return body as HTMLElement
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the transcript and let the first pull settle. */
async function mountTranscript(events: unknown[]) {
  harness.wire.events = events
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

describe('generic tool rows (D11)', () => {
  it('shows only the one-line summary while collapsed — never the raw JSON', async () => {
    const rendered = await mountTranscript(genericToolEvents())
    try {
      const row = toolRow(rendered.container, 'grep')
      expect(row.open, 'a tool row starts collapsed').toBe(false)

      const line = summaryOf(row).textContent ?? ''
      expect(line, 'the summary shows the tool name').toContain('grep')
      expect(line, 'the summary shows the one-line argument summary').toContain(toolArgsSummary(ARGS))
      expect(line, 'no raw argument JSON on the collapsed line').not.toContain('{"')
      expect(line, 'no raw argument keys on the collapsed line').not.toContain('"pattern"')
      expect(line, 'no raw result text on the collapsed line').not.toContain(RESULT)
    } finally {
      rendered.unmount()
    }
  })

  it('splits the expanded body into a labelled arguments section and a labelled result section', async () => {
    const rendered = await mountTranscript(genericToolEvents())
    try {
      const row = toolRow(rendered.container, 'grep')
      // Opening is what a summary click does; React does not control `open`.
      act(() => {
        row.open = true
        row.dispatchEvent(new Event('toggle'))
      })

      const argsLabel = copy(ARGS_KEY)
      const resultLabel = copy(RESULT_KEY)
      expect(argsLabel, `the ${ARGS_KEY} key must exist in the locale dictionary`).not.toBe(ARGS_KEY)
      expect(resultLabel, `the ${RESULT_KEY} key must exist in the locale dictionary`).not.toBe(RESULT_KEY)
      expect(argsLabel, 'the two sections must not share one label').not.toBe(resultLabel)

      const text = bodyOf(row).textContent ?? ''
      const argsLabelAt = text.indexOf(argsLabel)
      const argsAt = text.indexOf(ARGS)
      const resultLabelAt = text.indexOf(resultLabel)
      const resultAt = text.indexOf(RESULT)
      expect(argsLabelAt, 'the arguments section is labelled').toBeGreaterThanOrEqual(0)
      expect(resultLabelAt, 'the result section is labelled').toBeGreaterThanOrEqual(0)
      expect(argsAt, 'the raw arguments are in the expanded body').toBeGreaterThanOrEqual(0)
      expect(resultAt, 'the raw result is in the expanded body').toBeGreaterThanOrEqual(0)
      // Label → content, arguments before result.
      expect(argsLabelAt, 'the arguments label precedes the arguments').toBeLessThan(argsAt)
      expect(argsAt, 'the arguments section precedes the result section').toBeLessThan(resultLabelAt)
      expect(resultLabelAt, 'the result label precedes the result').toBeLessThan(resultAt)
    } finally {
      rendered.unmount()
    }
  })

  it('leaves the dedicated bash card alone', async () => {
    const rendered = await mountTranscript(bashToolEvents())
    try {
      const row = toolRow(rendered.container, 'bash')
      const text = row.textContent ?? ''
      expect(text, 'the terminal card still shows the command line').toContain('echo bash-card-ok')
      expect(text, 'and the marker-stripped output').toContain('bash-card-ok')
      expect(text, 'the terminal card gains no arguments/result labels').not.toContain(copy(ARGS_KEY))
      expect(text, 'the terminal card gains no arguments/result labels').not.toContain(copy(RESULT_KEY))
    } finally {
      rendered.unmount()
    }
  })
})
