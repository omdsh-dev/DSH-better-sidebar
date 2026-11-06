// @vitest-environment jsdom
/**
 * D14 — compaction and model-retry rows, plus the replacement-message fix.
 * Design basis: `/tmp/bsb-parity/p2-feasibility.md` §3, the host's own node
 * definitions (`ui-chat/src/client/conversation-nodes/compaction.ts:26-58`,
 * `command.ts:60-136`, `retry.ts:24-90`), the host event shapes
 * (`llm-retry/src/types.ts:16-50`, `compaction/src/types.ts:24-92`) and the
 * surface predicate `isReplacementSurfaceEvent` (`session/src/surface.ts:102`).
 *
 * Why this spec exists: the side transcript knows ten event types and drops the
 * rest on the floor. So a side thread that had its history compacted shows the
 * reader nothing at all — no marker where the older turns went — and a model
 * request that had to retry shows a single silent gap. Worse, the compaction
 * checkpoint is logged as a `user/message` REPLACEMENT and the user branch has
 * no replacement test, so it is classified by its `source.kind` alone: today
 * `isContextInjectionMessage` (any source that is not `'user'`) turns the whole
 * compacted summary into a collapsible row labelled “context injected”. The
 * transcript then claims a context was INJECTED at the exact moment history was
 * compacted away, and a reader who expands that row reads the entire summary as
 * though the plugin had pasted it there. The checkpoint belongs to the
 * compaction transaction, not to either of those rows.
 *
 * ============================ CONTRACT ============================
 * A. COMPACTION — one row per compaction transaction, and only when the
 *    checkpoint landed (host parity: `if (state.checkpoint === undefined)
 *    return null`).
 *    A1. `compaction/start` / `compaction/summary` / `compaction/end` alone
 *        (no checkpoint) produce NO row — never one per lifecycle event.
 *    A2. The landed checkpoint (a `user/message` whose `surfaceOp` is
 *        `{ op: 'replace', … }` and whose `data.source.kind` is
 *        `'compact-checkpoint'`) produces exactly ONE row, at the checkpoint's
 *        own `seq`, shaped like the host node:
 *          `{ kind: 'compaction', seq, summary, shadowedItemCount,
 *             shadowedTokenCount }`
 *        where `summary` is the `compaction/summary` content's `text` blocks
 *        joined (trimmed; `null` when there is none), `shadowedItemCount` is
 *        `data.shadowedSeqs.length` and `shadowedTokenCount` is
 *        `data.shadowedTokenCount` (`null` when the summary event is outside
 *        the window).
 *    A3. `summary: null` is still a ROW: the line reads the localized
 *        `t('sideChatCompactionSummary')` plus the counts it does have, and
 *        never `undefined`/`null`. If the row publishes the summary text at
 *        all it is behind a `<details>` disclosure — the row LINE is a label,
 *        never a wall of prose.
 * B. MODEL RETRY — one row per producer `retryId`, folded the way the host
 *    folds it: `llm/retry` carries the attempt, `llm/retry-started` only flips
 *    THAT attempt to `started` and adds no row, and repeated attempts replace
 *    the same row, which keeps the CHAIN's first event seq:
 *    `{ kind: 'retry', seq, retry, maxRetries?, delayMs, provider,
 *       state: 'scheduled' | 'started', failureMessage? }`. The visible
 *    copy is `t('sideChatRetryAttempt', { retry })`, so after two retries the
 *    reader sees one row reading “已重试 2 次” and the provider failure text.
 *    A retry event without a `retryId` produces no row.
 * C. REPLACEMENT FIX — a replacement `user/message`
 *    (`surfaceOp.op === 'replace'`, i.e. `isReplacementSurfaceEvent`) is NEVER
 *    a `user` row and NEVER a context-injection row: the checkpoint's summary
 *    text is carried by the compaction row and by nothing else, so the DOM
 *    holds no giant bubble for it, and the transcript's normal `user/message`
 *    rows (the side question itself) are untouched.
 *    Manual `/compact` (`data.source.sourceCommandId` present) is out of scope:
 *    this contract only claims the automatic node the host draws.
 *
 * Locale keys this contract needs (every shipped dictionary, not just zh/en):
 *   `sideChatCompactionSummary` — the compaction row's label
 *   `sideChatCompactionItems`   — `{count}` shadowed items
 *   `sideChatCompactionTokens`  — `{tokens}` shadowed tokens
 *   `sideChatRetryAttempt`      — `{retry}` attempt counter
 * ==================================================================
 *
 * The mapping is a pure function, so the cardinality/folding clauses are
 * asserted on `transcriptRows` directly; the copy clauses go through the real
 * view (`wait/inspect the DOM`), which is the only place a giant bubble shows
 * up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SidebarHistoryEntry, SidebarSessionEvent } from '../src/context-types.ts'
import { transcriptRows, type SidechatTranscriptRow } from '../src/client/sidechat-transcript.ts'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The row kinds and fields this contract pins (asserted through a permissive
 *  view so the spec compiles before the kinds exist — the assertions, not the
 *  types, carry the contract). */
interface CompactionRow {
  kind: string
  seq: number
  summary?: string | null
  shadowedItemCount?: number | null
  shadowedTokenCount?: number | null
}

interface RetryRow {
  kind: string
  seq: number
  retry?: number
  maxRetries?: number
  delayMs?: number
  provider?: string
  state?: string
  failureMessage?: string
}

/** The locale keys this contract names. */
const COMPACTION_KEY = 'sideChatCompactionSummary'
const ITEMS_KEY = 'sideChatCompactionItems'
const TOKENS_KEY = 'sideChatCompactionTokens'
const RETRY_KEY = 'sideChatRetryAttempt'

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** The side question that opens the thread (a GENUINE user message). */
const QUESTION = 'which turns changed?'

/** The opening marker of the compacted summary — the giant text that must never
 *  become a user bubble. */
const SUMMARY_MARKER = 'SUMMARY-OF-THE-SHADOWED-TURNS'

/** The compacted summary body: long enough that rendering it as a user bubble
 *  is unmistakable. */
function summaryBody(): string {
  return `${SUMMARY_MARKER} ${'the older turns said a great deal. '.repeat(30)}`
}

/** The shadowed surface nodes the compaction replaced. */
const SHADOWED = [3, 5, 6, 11, 13] as const
/** The heuristic shadow price the summary event records. */
const SHADOWED_TOKENS = 100

/** One log event fixture. Surface-eligible events carry their `surfaceOp`
 *  marker, exactly like the live pipeline appends them. */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): SidebarSessionEvent {
  const event = { type, seq, time: seq * 1_000, data }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
    return { ...event, surfaceOp: 'append' } as SidebarSessionEvent
  }
  return event as SidebarSessionEvent
}

/** History rows from a plain event list (the wire's shape). */
function entries(events: readonly SidebarSessionEvent[]): SidebarHistoryEntry[] {
  return events.map(event => ({ event }))
}

/** The thread's own opening: seed cut, the side question, the turn it opens. */
function opening(): SidebarSessionEvent[] {
  return [
    ev('session/end-seed', 0, { inherited: true }),
    ev('user/message', 1, { id: 'm1', role: 'user', content: [{ type: 'text', text: QUESTION }], source: { kind: 'user' } }),
    ev('turn/start', 2, { turn: 1 }),
  ]
}

/** Close the turn after a compaction group so the transcript has a tail. */
function closing(at: number): SidebarSessionEvent[] {
  return [
    ev('assistant/message', at, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } }),
    ev('turn/end', at + 1, { turn: 1, reason: { kind: 'stop' } }),
  ]
}

interface CompactionOptions {
  id?: string
  turn?: number | null
  /** `null` omits the `compaction/summary` event entirely (out of the window). */
  summary?: string | null
  /** Keep the summary event but give it no text blocks (host: `summary: null`). */
  textless?: boolean
}

/** The compaction transaction the host logs: start → summary → checkpoint →
 *  end, in that order (the checkpoint is the shadow-price carrier). */
function compactionGroup(startSeq: number, options: CompactionOptions = {}): SidebarSessionEvent[] {
  const id = options.id ?? 'cp1'
  const turn = options.turn === undefined ? null : options.turn
  const summaryText = options.summary === undefined ? summaryBody() : options.summary
  const first = SHADOWED[0]
  const last = SHADOWED[SHADOWED.length - 1]
  const group: SidebarSessionEvent[] = [ev('compaction/start', startSeq, { compactionId: id, turn })]
  let seq = startSeq + 1
  if (summaryText !== null) {
    group.push(ev('compaction/summary', seq, {
      compactionId: id,
      summary: options.textless === true ? [] : [{ type: 'text', text: summaryText }],
      shadowedRange: { start: first, end: last },
      shadowedSeqs: [...SHADOWED],
      shadowedTokenCount: SHADOWED_TOKENS,
      provider: 'deepseek',
      model: 'test-model',
    }))
    seq += 1
  }
  group.push({
    type: 'user/message',
    seq,
    time: seq * 1_000,
    data: {
      id: `m-${id}`,
      role: 'user',
      content: [{ type: 'text', text: summaryText ?? '' }],
      source: { kind: 'compact-checkpoint', compactionId: id },
    },
    surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
    sourceEventSeqs: [...SHADOWED],
  } as SidebarSessionEvent)
  group.push(ev('compaction/end', seq + 1, { compactionId: id, turn }))
  return group
}

/** The checkpoint event of a group (the replacement `user/message`). */
function checkpointOf(group: readonly SidebarSessionEvent[]): SidebarSessionEvent {
  const checkpoint = group.find(event => event.type === 'user/message')
  expect(checkpoint, 'the fixture carries a checkpoint replacement').toBeDefined()
  return checkpoint as SidebarSessionEvent
}

/** One `llm/retry` attempt (`mode: 'normal'` carries `maxRetries`). */
function retryEvent(seq: number, retry: number, over: { mode?: 'normal' | 'always'; retryId?: string | null } = {}): SidebarSessionEvent {
  const mode = over.mode ?? 'normal'
  const retryId = over.retryId === undefined ? 'r1' : over.retryId
  return ev('llm/retry', seq, {
    ...(retryId === null ? {} : { retryId }),
    turn: 1,
    step: 1,
    provider: 'deepseek',
    mode,
    policyKey: 'default',
    retry,
    ...(mode === 'normal' ? { maxRetries: 3 } : {}),
    delayMs: retry * 1_000,
    failure: { kind: 'provider', message: 'provider overloaded' },
  })
}

/** The durable transition that ends one retry wait. */
function retryStarted(seq: number, retry: number): SidebarSessionEvent {
  return ev('llm/retry-started', seq, { retryId: 'r1', turn: 1, step: 1, retry })
}

/** Rows as the permissive view types above. */
function compactionRows(rows: readonly SidechatTranscriptRow[]): CompactionRow[] {
  return (rows as unknown as CompactionRow[]).filter(row => row.kind === 'compaction')
}

function retryRows(rows: readonly SidechatTranscriptRow[]): RetryRow[] {
  return (rows as unknown as RetryRow[]).filter(row => row.kind === 'retry')
}

/** The text of every `user` row (compaction checkpoints must never appear). */
function userTexts(rows: readonly SidechatTranscriptRow[]): string[] {
  return (rows as unknown as Array<{ kind: string; text?: string }>)
    .filter(row => row.kind === 'user')
    .map(row => row.text ?? '')
}

/** Every row whose text contains `marker`, with its kind — the replacement
 *  clause ("carried by the compaction row and nothing else"). */
function rowsCarrying(rows: readonly SidechatTranscriptRow[], marker: string): Array<{ kind: string; seq: number }> {
  return (rows as unknown as Array<{ kind: string; seq: number; text?: string }>)
    .filter(row => (row.text ?? '').includes(marker))
    .map(row => ({ kind: row.kind, seq: row.seq }))
}

/** The innermost disclosure that owns `marker` (a summary body lives in one). */
function ownerDisclosure(container: HTMLElement, marker: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('details')]
    .filter(node => (node.textContent ?? '').includes(marker))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0]
}

/** How many times `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number {
  if (needle === '') return 0
  return text.split(needle).length - 1
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the real transcript for one event log. */
async function mountEvents(events: readonly SidebarSessionEvent[]) {
  harness.wire.events = [...events]
  const rendered = harness.mount()
  await harness.flush(6)
  return rendered
}

describe('row copy (D14)', () => {
  it('defines the four keys the new rows need in the dictionaries', () => {
    for (const key of [COMPACTION_KEY, ITEMS_KEY, TOKENS_KEY, RETRY_KEY]) {
      expect(copy(key), `the ${key} key must exist in the locale dictionary`).not.toBe(key)
    }
  })
})

describe('compaction rows (D14-A)', () => {
  it('draws one row for the whole transaction, at the checkpoint', () => {
    const group = compactionGroup(3, { turn: 1 })
    const checkpoint = checkpointOf(group)
    const rows = transcriptRows(entries([...opening(), ...group, ...closing(20)]))

    const compaction = compactionRows(rows)
    expect(compaction, 'the landed checkpoint draws exactly one row').toHaveLength(1)
    expect(compaction[0]).toMatchObject({
      seq: checkpoint.seq,
      summary: summaryBody(),
      shadowedItemCount: SHADOWED.length,
      shadowedTokenCount: SHADOWED_TOKENS,
    })
    const kinds = (rows as unknown as Array<{ kind: string }>).map(row => row.kind)
    expect(
      kinds.indexOf('compaction'),
      'the row sits where the checkpoint landed, after the question',
    ).toBeGreaterThan(kinds.indexOf('user'))
  })

  it('draws no row while the transaction has not landed a checkpoint', () => {
    const group = compactionGroup(3, { turn: 1 }).filter(event => event.type !== 'user/message')
    const rows = transcriptRows(entries([...opening(), ...group, ...closing(20)]))
    expect(compactionRows(rows), 'start/summary/end without a checkpoint draw nothing').toHaveLength(0)
    expect(userTexts(rows), 'and nothing impersonates a user message').toEqual([QUESTION])
  })

  it('still draws a non-blank row when the summary text is missing', () => {
    const cases: Array<[string, CompactionOptions, { items: number | null; tokens: number | null }]> = [
      ['the summary event is outside the window', { summary: null }, { items: null, tokens: null }],
      ['the summary event carries no text block', { textless: true }, { items: SHADOWED.length, tokens: SHADOWED_TOKENS }],
    ]
    for (const [label, options, counts] of cases) {
      const group = compactionGroup(3, { turn: 1, ...options })
      const rows = transcriptRows(entries([...opening(), ...group, ...closing(20)]))
      const compaction = compactionRows(rows)
      expect.soft(compaction, `${label}: one row survives the missing summary`).toHaveLength(1)
      expect.soft(compaction[0]).toMatchObject({
        summary: null,
        shadowedItemCount: counts.items,
        shadowedTokenCount: counts.tokens,
      })
    }
  })

  it('carries the replacement checkpoint on the compaction row and nowhere else', async () => {
    const group = compactionGroup(3, { turn: 1 })
    const checkpoint = checkpointOf(group)
    const events = [...opening(), ...group, ...closing(20)]
    const rows = transcriptRows(entries(events))
    expect(
      rowsCarrying(rows, SUMMARY_MARKER),
      'the checkpoint summary is carried by the compaction row alone — no user row, no injection row',
    ).toEqual([{ kind: 'compaction', seq: checkpoint.seq }])
    expect(userTexts(rows), 'the genuine user message is untouched').toEqual([QUESTION])

    const rendered = await mountEvents(events)
    try {
      const container = rendered.container
      const text = container.textContent ?? ''
      expect(text, 'the side question still renders').toContain(QUESTION)
      // A row MAY publish the summary body behind a disclosure; when it does,
      // that disclosure must be the compaction row (its summary line carries
      // the compaction label) — not a context-injection row wearing the whole
      // summary as its content.
      if (text.includes(SUMMARY_MARKER)) {
        const owner = ownerDisclosure(container, SUMMARY_MARKER)
        expect(owner, 'a published summary body lives inside a disclosure').toBeDefined()
        const line = owner?.querySelector('summary')?.textContent ?? ''
        expect(line, 'and that disclosure is the compaction row').toContain(copy(COMPACTION_KEY))
        expect(line, 'the summary body is never the always-visible row line').not.toContain(SUMMARY_MARKER)
      }
    } finally {
      rendered.unmount()
    }
  })

  it('renders the row label and the counts it has', async () => {
    const group = compactionGroup(3, { turn: 1 })
    const rendered = await mountEvents([...opening(), ...group, ...closing(20)])
    try {
      const text = rendered.container.textContent ?? ''
      expect(text, 'the compaction marker is visible').toContain(copy(COMPACTION_KEY))
      expect(text, 'the shadowed item count is visible')
        .toContain(copy(ITEMS_KEY, { count: SHADOWED.length }))
      expect(text, 'the shadowed token count is visible')
        .toContain(copy(TOKENS_KEY, { tokens: SHADOWED_TOKENS }))
      expect(occurrences(text, copy(COMPACTION_KEY)), 'one marker line, not one per lifecycle event').toBe(1)
      expect(text, 'the row shows translated copy, not a raw key').not.toContain(COMPACTION_KEY)
    } finally {
      rendered.unmount()
    }
  })

  it('renders a readable line when the summary is absent', async () => {
    const group = compactionGroup(3, { turn: 1, summary: null })
    const rendered = await mountEvents([...opening(), ...group, ...closing(20)])
    try {
      const text = rendered.container.textContent ?? ''
      expect(text, 'the row is not blank without a summary').toContain(copy(COMPACTION_KEY))
      expect(text, 'no absent field leaks into the copy').not.toContain('undefined')
      expect(text, 'the row shows translated copy, not a raw key').not.toContain(COMPACTION_KEY)
      expect(
        occurrences(text, copy(COMPACTION_KEY)),
        'one marker line even with nothing to summarize',
      ).toBe(1)
    } finally {
      rendered.unmount()
    }
  })
})

describe('model retry rows (D14-B)', () => {
  it('folds one retryId into one row and only changes state on retry-started', () => {
    const base = [...opening(), retryEvent(3, 1)]
    const first = retryRows(transcriptRows(entries(base)))
    expect(first, 'the first scheduled attempt draws the row').toHaveLength(1)
    expect(first[0]).toMatchObject({
      seq: 3,
      retry: 1,
      maxRetries: 3,
      delayMs: 1_000,
      provider: 'deepseek',
      state: 'scheduled',
      failureMessage: 'provider overloaded',
    })

    const started = retryRows(transcriptRows(entries([...base, retryStarted(4, 1)])))
    expect(started, 'llm/retry-started adds NO row').toHaveLength(1)
    expect(started[0]).toMatchObject({ seq: 3, retry: 1, state: 'started' })

    const second = retryRows(transcriptRows(entries([...base, retryStarted(4, 1), retryEvent(5, 2)])))
    expect(second, 'a further attempt updates the same row').toHaveLength(1)
    expect(second[0]).toMatchObject({ seq: 3, retry: 2, delayMs: 2_000, state: 'scheduled' })

    const settled = retryRows(transcriptRows(entries([...base, retryStarted(4, 1), retryEvent(5, 2), retryStarted(6, 2)])))
    expect(settled, 'the chain stays one row to its end').toHaveLength(1)
    expect(settled[0]).toMatchObject({ seq: 3, retry: 2, state: 'started' })
    expect(settled[0]?.maxRetries, 'the policy limit survives the fold').toBe(3)
  })

  it('keeps the row for an unbounded policy with no retry limit', () => {
    const rows = retryRows(transcriptRows(entries([...opening(), retryEvent(3, 1, { mode: 'always' })])))
    expect(rows, 'mode "always" also draws a row').toHaveLength(1)
    expect(rows[0]).toMatchObject({ retry: 1, state: 'scheduled' })
    expect(rows[0]?.maxRetries, 'no invented limit').toBeUndefined()
  })

  it('draws nothing for a retry event without a retryId', () => {
    const rows = transcriptRows(entries([...opening(), retryEvent(3, 1, { retryId: null })]))
    expect(retryRows(rows), 'an uncorrelated retry is not a row').toHaveLength(0)
    expect(userTexts(rows), 'and it does not impersonate a user message').toEqual([QUESTION])
  })

  it('reads “retried N times” with the provider failure on the row', async () => {
    const events = [
      ...opening(),
      retryEvent(3, 1),
      retryStarted(4, 1),
      retryEvent(5, 2),
      retryStarted(6, 2),
      ...closing(20),
    ]
    const rendered = await mountEvents(events)
    try {
      const attempt = copy(RETRY_KEY, { retry: 2 })
      const text = rendered.container.textContent ?? ''
      expect(text, 'the reader can see the thread retried').toContain(attempt)
      expect(occurrences(text, attempt), 'one row for the chain, not one per attempt').toBe(1)
      expect(text, 'and why it retried').toContain('provider overloaded')
      expect(text, 'the row is not blank').not.toContain('undefined')
      expect(text, 'the row shows translated copy, not a raw key').not.toContain(RETRY_KEY)
    } finally {
      rendered.unmount()
    }
  })
})
