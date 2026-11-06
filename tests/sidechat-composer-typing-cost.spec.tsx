// @vitest-environment jsdom
/**
 * Typing cost at transcript scale: with a transcript of 20+ rows, ONE composer
 * keystroke must not re-render the rows that did not change.
 *
 * Mechanic this spec pins: the transcript rows are memo inputs, not fresh work
 * per keystroke. Three deterministic counters stand in for "the row rendered":
 *
 *  - `toolArgsSummary` — called once per tool row while that row renders (it
 *    JSON-parses the call arguments, so it is exactly the per-keystroke work a
 *    long transcript must not repeat);
 *  - `formatTokens` — called once per turn-tail usage row while that row
 *    renders;
 *  - the host `MarkdownText` render count for a prose row's text (the host
 *    memo boundary, see tests/sidechat-markdown-labels.spec.tsx).
 *
 * All three go to ZERO for an unchanged row once the keystroke is not the
 * first one (the first absorbs mount-time churn). A fixed transcript is used,
 * the composer grows only its own draft, and `transcriptRows` itself must not
 * re-run: rows are reused by object identity, which is what makes the zero
 * deltas possible at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'

/** Every props object the mocked host `MarkdownText` was asked to render. */
const markdownRenders = vi.hoisted(() => ({ texts: [] as string[] }))

/** Row-level work the transcript did (see the file header). */
const rowWork = vi.hoisted(() => ({
  /** `toolArgsSummary` executions (one per tool row render). */
  args: 0,
  /** `formatTokens` executions (one per usage row render, twice each). */
  tokens: 0,
  /** `transcriptRows` executions (the row mapping must not re-run per key). */
  mappings: 0,
  /** The row count of the last `transcriptRows` result. */
  lastRowCount: 0,
}))

vi.mock('../src/client/sidechat-transcript.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/sidechat-transcript.ts')>()
  return {
    ...actual,
    transcriptRows: (...args: Parameters<typeof actual.transcriptRows>) => {
      const rows = actual.transcriptRows(...args)
      rowWork.mappings += 1
      rowWork.lastRowCount = rows.length
      return rows
    },
    toolArgsSummary: (...args: Parameters<typeof actual.toolArgsSummary>) => {
      rowWork.args += 1
      return actual.toolArgsSummary(...args)
    },
    formatTokens: (...args: Parameters<typeof actual.formatTokens>) => {
      rowWork.tokens += 1
      return actual.formatTokens(...args)
    },
  }
})

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  const react = await import('react')
  type Props = ComponentProps<typeof actual.MarkdownText>
  // Same memo boundary as the host's own export: a call here is a memo MISS.
  const CountingMarkdownText = react.memo(function CountingMarkdownText(props: Props) {
    markdownRenders.texts.push(props.text)
    return react.createElement(actual.MarkdownText, props)
  })
  return { ...actual, MarkdownText: CountingMarkdownText }
})

/** How many times `MarkdownText` was asked to render exactly this text. */
function markdownCountOf(text: string): number {
  return markdownRenders.texts.filter(rendered => rendered === text).length
}

/** The prose rows the fixed transcript carries (unchanged across keystrokes). */
const PROSE = {
  lastQuestion: 'q-9',
  lastAnswer: 'a-9',
}

/**
 * A settled 10-turn conversation: per turn a user message, a bash call/result
 * pair and an assistant message with usage. The mapping yields 4 rows per turn
 * (user · tool · assistant · turn tail) = 40 rows — comfortably above the
 * "20+ rows" scale this spec is about.
 */
function longTranscript(): unknown[] {
  const events: unknown[] = [{ type: 'session/end-seed', seq: 0, time: 0, data: {} }]
  let seq = 1
  for (let index = 0; index < 10; index += 1) {
    events.push({
      type: 'user/message',
      seq,
      time: seq * 1_000,
      data: { content: [{ type: 'text', text: `q-${String(index)}` }], source: { kind: 'user' } },
    })
    seq += 1
    events.push({ type: 'turn/start', seq, time: seq * 1_000, data: { turn: index + 1 } })
    seq += 1
    events.push({
      type: 'tool/call',
      seq,
      time: seq * 1_000,
      data: { turn: index + 1, step: 1, callId: `c${String(index)}`, name: 'bash', arguments: `{"command":"echo t-${String(index)}"}` },
    })
    seq += 1
    events.push({
      type: 'tool/result',
      seq,
      time: seq * 1_000,
      data: {
        turn: index + 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: `c${String(index)}` },
          content: [{ type: 'tool-result', toolCallId: `c${String(index)}`, content: [{ type: 'text', text: `t-${String(index)}\n[exit code: 0]` }] }],
        },
      },
    })
    seq += 1
    events.push({
      type: 'assistant/message',
      seq,
      time: seq * 1_000,
      data: {
        turn: index + 1,
        step: 2,
        message: { content: [{ type: 'text', text: `a-${String(index)}` }] },
        usage: { inputTokens: 1_200, outputTokens: 345 },
      },
    })
    seq += 1
    events.push({ type: 'turn/end', seq, time: seq * 1_000, data: { turn: index + 1, reason: 'completed' } })
    seq += 1
  }
  return events
}

let harness: SidechatHarness

beforeEach(() => {
  markdownRenders.texts = []
  rowWork.args = 0
  rowWork.tokens = 0
  rowWork.mappings = 0
  rowWork.lastRowCount = 0
  harness = installSidechatHarness({ events: longTranscript() })
})

afterEach(() => {
  harness.cleanup()
})

describe('composer keystroke cost on a long transcript', () => {
  it('re-renders no existing transcript row for one composer keystroke', async () => {
    const view = harness.mount()
    await harness.flush()

    // Precondition: the transcript really is the long one this spec is about,
    // and the rows really render through the counted boundaries (a mock that
    // never applied would make the zero deltas below vacuous).
    expect(rowWork.lastRowCount, 'the transcript must carry 20+ rows').toBeGreaterThanOrEqual(20)
    expect(rowWork.args, 'tool rows must render through the counted helper').toBeGreaterThan(0)
    expect(rowWork.tokens, 'usage rows must render through the counted helper').toBeGreaterThan(0)
    expect(markdownCountOf(PROSE.lastQuestion), 'prose must render through the counted MarkdownText').toBeGreaterThan(0)
    expect(markdownCountOf(PROSE.lastAnswer)).toBeGreaterThan(0)

    // First keystroke: a warm-up that absorbs any mount-time async churn.
    harness.typeComposer('a')
    await harness.flush()
    const baseline = {
      args: rowWork.args,
      tokens: rowWork.tokens,
      mappings: rowWork.mappings,
      question: markdownCountOf(PROSE.lastQuestion),
      answer: markdownCountOf(PROSE.lastAnswer),
    }

    // Second keystroke: nothing in the transcript changed, so nothing in it
    // may be rendered again.
    harness.typeComposer('ab')
    await harness.flush()
    expect(harness.composerValue(), 'the view really re-rendered').toBe('ab')

    expect(
      {
        toolRowsRendered: rowWork.args - baseline.args,
        usageRowsRendered: rowWork.tokens - baseline.tokens,
        rowMappingsReran: rowWork.mappings - baseline.mappings,
        proseRowsParsed: (markdownCountOf(PROSE.lastQuestion) - baseline.question)
          + (markdownCountOf(PROSE.lastAnswer) - baseline.answer),
      },
      'one composer keystroke re-rendered transcript rows that did not change',
    ).toEqual({
      toolRowsRendered: 0,
      usageRowsRendered: 0,
      rowMappingsReran: 0,
      proseRowsParsed: 0,
    })

    view.unmount()
  })
})
