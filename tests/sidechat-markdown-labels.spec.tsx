// @vitest-environment jsdom
/**
 * D1 — Markdown hot path (spec: docs/plans/2026-10-22-sidechat-render-parity/spec.md,
 * contract C3 / deliverable D1).
 *
 * Two behaviors, both deterministic (no timers, no clocks):
 *
 * 1. `markdownTextProps(text, labels)` must hand the host `MarkdownText` the
 *    SAME nested `labels` object for equal label values — the host memoizes on
 *    that identity, so a fresh object per render defeats its `memo` and
 *    re-parses the whole transcript on every composer keystroke and every
 *    streaming push. Different label values must still get different objects
 *    (a single shared object would leak the previous locale's copy).
 *
 * 2. The real `SideChatView` must stop re-executing `MarkdownText` for rows
 *    whose markdown did not change, and an UNSETTLED `assistant/live-chunk`
 *    row must reach it with `streaming === true` while the assembled
 *    `assistant/message` row does not (streaming is what lets the host keep
 *    its incremental parse across chunks instead of restarting it).
 *
 * `MarkdownText` is replaced through the primitives module mock with a counter
 * wrapped in `memo` — the exact memo boundary the host ships — so a recorded
 * call means the host component was ASKED to re-render (its parser would run).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { markdownTextProps, type MarkdownCopyLabels } from '../src/client/markdown-labels.tsx'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'

/** Every props object the mocked `MarkdownText` was asked to render. */
const markdownRenders = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; streaming: boolean | undefined }>,
}))

/** How many times the session-scoped prose pass ran (one call per row rewritten). */
const rewriteCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('../src/client/markdown-images.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/markdown-images.ts')>()
  return {
    ...actual,
    rewriteProseLocalImageUrls: (...args: Parameters<typeof actual.rewriteProseLocalImageUrls>) => {
      rewriteCalls.count += 1
      return actual.rewriteProseLocalImageUrls(...args)
    },
  }
})

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  const react = await import('react')
  type Props = ComponentProps<typeof actual.MarkdownText>
  // Same memo boundary as the host's own export: a call here is a memo MISS.
  const CountingMarkdownText = react.memo(function CountingMarkdownText(props: Props) {
    markdownRenders.calls.push({ text: props.text, streaming: props.streaming })
    return react.createElement(actual.MarkdownText, props)
  })
  return { ...actual, MarkdownText: CountingMarkdownText }
})

/** The chrome labels the view threads through every markdown row. */
const LABELS: MarkdownCopyLabels = {
  copyLabel: '复制',
  copiedLabel: '已复制',
  codeLabel: '代码',
  wrapLabel: '换行',
  unwrapLabel: '不换行',
}

/** How many times `MarkdownText` was asked to render exactly this text. */
function countOf(text: string): number {
  return markdownRenders.calls.filter(call => call.text === text).length
}

/** The last render `MarkdownText` was asked to do for exactly this text. */
function lastRenderOf(text: string): { text: string; streaming: boolean | undefined } | undefined {
  return [...markdownRenders.calls].reverse().find(call => call.text === text)
}

describe('markdownTextProps label identity (C3)', () => {
  it('returns the same nested labels object for equal label values', () => {
    const first = markdownTextProps('first body', { ...LABELS })
    const second = markdownTextProps('second body', { ...LABELS })
    // The text is per-call; the labels object is what the host memo compares.
    expect(first.text).toBe('first body')
    expect(second.text).toBe('second body')
    expect(second.labels).toBe(first.labels)
  })

  it('returns different nested labels objects for different label values', () => {
    const zh = markdownTextProps('body', LABELS)
    const en = markdownTextProps('body', { ...LABELS, copyLabel: 'Copy' })
    expect(en.labels).not.toBe(zh.labels)
    // A different value in ANY of the five fields is a different cache entry.
    for (const key of ['copyLabel', 'copiedLabel', 'codeLabel', 'wrapLabel', 'unwrapLabel'] as const) {
      const changed = markdownTextProps('body', { ...LABELS, [key]: `${LABELS[key]}-other` })
      expect(changed.labels, key).not.toBe(zh.labels)
    }
  })

  it('keeps one cache entry per distinct label value (a value seen again reuses its object)', () => {
    const first = markdownTextProps('a', { ...LABELS })
    // Interleave other values: a last-only cache would lose the entry below.
    markdownTextProps('b', { ...LABELS, copiedLabel: 'Copied' })
    markdownTextProps('c', { ...LABELS, codeLabel: 'Code' })
    const again = markdownTextProps('d', { ...LABELS })
    expect(again.labels).toBe(first.labels)
  })
})

describe('SideChatView markdown re-parse (C3)', () => {
  /** Three markdown rows that never change during the test. */
  const ROWS = {
    user: 'hi-there',
    assistant: 'answer-one',
    secondUser: 'second-question',
  }

  /** A tiny settled conversation: user prose, assistant prose, user prose. */
  function settledConversation(): unknown[] {
    return [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: ROWS.user }], source: { kind: 'user' } } },
      { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 3_000,
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: ROWS.assistant }] } },
      },
      { type: 'turn/end', seq: 4, time: 4_000, data: { turn: 1, reason: 'completed' } },
      { type: 'user/message', seq: 5, time: 5_000, data: { content: [{ type: 'text', text: ROWS.secondUser }], source: { kind: 'user' } } },
    ]
  }

  let harness: SidechatHarness

  beforeEach(() => {
    markdownRenders.calls = []
    harness = installSidechatHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('does not re-execute MarkdownText for unchanged rows on a composer keystroke', async () => {
    harness.wire.events = settledConversation()
    const view = harness.mount()
    await harness.flush()

    // Guard: the mock really replaced the host component on these rows (a
    // mock that never applied would make the zero-delta assertion vacuous).
    for (const text of Object.values(ROWS)) {
      expect(countOf(text), `${text} must render through the counted MarkdownText`).toBeGreaterThan(0)
    }

    // First keystroke: a warm-up that absorbs any mount-time async churn.
    harness.typeComposer('a')
    await harness.flush()
    const baseline = new Map(Object.values(ROWS).map(text => [text, countOf(text)]))

    // Second keystroke: the rows are untouched, so the host memo must hit.
    harness.typeComposer('ab')
    await harness.flush()
    expect(harness.composerValue()).toBe('ab')  // the view really re-rendered
    for (const text of Object.values(ROWS)) {
      expect(countOf(text), `${text} was re-parsed by an unrelated composer keystroke`).toBe(baseline.get(text))
    }

    view.unmount()
  })

  it('does not re-run the prose rewrite for unchanged rows on a composer keystroke', async () => {
    harness.wire.events = settledConversation()
    const view = harness.mount()
    await harness.flush()

    // Guard: the rewrite really ran for the mounted rows (a mock that never
    // applied would make the zero-delta assertion vacuous).
    expect(rewriteCalls.count).toBeGreaterThan(0)
    rewriteCalls.count = 0

    harness.typeComposer('a')
    await harness.flush()
    harness.typeComposer('ab')
    await harness.flush()
    expect(harness.composerValue()).toBe('ab')
    expect(rewriteCalls.count, 'a composer keystroke re-ran the prose rewrite for unchanged rows').toBe(0)

    view.unmount()
  })

  it('passes streaming to an unsettled live row and not to the settled message', async () => {
    const settled = 'settled-answer'
    const live = 'live-token'
    harness.wire.events = [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } } },
      { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 3_000,
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: settled }] } },
      },
      { type: 'turn/end', seq: 4, time: 4_000, data: { turn: 1, reason: 'completed' } },
      // The in-flight attempt: its deltas arrive on the LIVE channel only.
      { type: 'turn/start', seq: 5, time: 5_000, data: { turn: 2 } },
    ]
    harness.wire.live = [
      {
        type: 'assistant/live-chunk',
        seq: 100,
        time: 9_000,
        data: { attemptId: 'a1', turn: 2, step: 1, index: 0, chunk: { type: 'text-delta', text: live, index: 0 } },
      },
    ]

    const view = harness.mount()
    await harness.flush()
    expect(view.container.textContent ?? '').toContain(live)

    const liveRender = lastRenderOf(live)
    expect(liveRender, 'the unsettled live row must reach MarkdownText').toBeDefined()
    expect(liveRender!.streaming, 'an unsettled live row must render with streaming').toBe(true)

    const settledRender = lastRenderOf(settled)
    expect(settledRender, 'the assembled message must reach MarkdownText').toBeDefined()
    expect(settledRender!.streaming ?? false, 'a settled message must not render as streaming').toBe(false)

    view.unmount()
  })
})
