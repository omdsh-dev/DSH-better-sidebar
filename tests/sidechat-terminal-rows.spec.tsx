// @vitest-environment jsdom
/**
 * D9 — a turn that ENDED without a normal completion must leave a terminal row:
 * "stopped" for an abort/interrupt, "output limit" for a max-tokens cut.
 * Design basis: `/tmp/bsb-parity/spec.md` §D9 / §3.7.
 *
 * Why this spec exists: `failureText` only recognizes `reason.kind === 'error'`,
 * and `turn/end` handling drops every other reason. So pressing Stop makes the
 * transcript simply stop growing — no "you stopped it", no way to tell a
 * finished answer from a killed one — and a max-tokens cut looks like a normal
 * ending even though the model was truncated mid-sentence. The host has a
 * dedicated interrupted marker and a max-tokens node; the side chat has neither.
 *
 * ============================ CONTRACT ============================
 * 1. `turn/end { reason: { kind: 'aborted' } }` and `{ kind: 'interrupted' }`
 *    produce exactly ONE row of the new `terminal` kind, rendered as
 *    `t('sideChatTerminalAborted')`.
 * 2. `turn/end { reason: { kind: 'max-tokens' } }` produces exactly ONE
 *    `terminal` row rendered as `t('sideChatTerminalMaxTokens')` — a different
 *    sentence from the abort one, because the reader's next action differs.
 * 3. The terminal state is DEDUPED per turn: an `assistant/attempt` whose
 *    terminal `finish` reason is the same abort, followed by its `turn/end`,
 *    still yields exactly one row (the same "one failure per turn" rule the
 *    error path already follows).
 * 4. The ERROR path is unchanged: `reason.kind === 'error'` still renders the
 *    existing error row with the provider's message, and never a terminal row;
 *    a normal completion renders neither.
 * 5. Localised copy only: both sentences come from the dictionaries
 *    (`sideChatTerminalAborted` / `sideChatTerminalMaxTokens`, added to zh, en
 *    and ja like every other key).
 * ==================================================================
 *
 * Mapping-level assertions run against `transcriptRows` (deterministic, no DOM);
 * the wording assertions run against the real view through the shared harness,
 * because "the transcript shows it" is the behaviour that was missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { transcriptRows } from '../src/client/sidechat-transcript.ts'
import { t } from '../src/client/locales.ts'
import type { SidebarHistoryEntry } from '../src/context-types.ts'

/** The two terminal sentences this contract names. */
const ABORTED_KEY = 'sideChatTerminalAborted'
const MAX_TOKENS_KEY = 'sideChatTerminalMaxTokens'

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** One turn whose `turn/end` carries `reason`. */
function turnEvents(reason: unknown, extra: unknown[] = []): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    ...extra,
    { type: 'turn/end', seq: 90, time: 9_000, data: { turn: 1, reason } },
  ]
}

/** The mapped rows of one event log. */
function rowsOf(events: readonly unknown[]) {
  return transcriptRows(events.map(event => ({ event })) as unknown as SidebarHistoryEntry[])
}

/** The rows of one kind. */
function rowsOfKind(events: readonly unknown[], kind: string) {
  return rowsOf(events).filter(row => row.kind === kind)
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('turn terminal rows (D9)', () => {
  it('maps an aborted turn (and an interrupted one) onto exactly one terminal row', () => {
    for (const reason of [{ kind: 'aborted' }, { kind: 'interrupted' }]) {
      const events = turnEvents(reason)
      const terminal = rowsOfKind(events, 'terminal')
      expect(terminal, `${String(reason.kind)} must produce one terminal row`).toHaveLength(1)
      expect(
        rowsOfKind(events, 'error'),
        `${String(reason.kind)} is not a provider error and must not use the error row`,
      ).toHaveLength(0)
    }
  })

  it('maps a max-tokens cut onto exactly one terminal row of its own', () => {
    const events = turnEvents({ kind: 'max-tokens' })
    expect(rowsOfKind(events, 'terminal'), 'a truncated answer leaves a terminal row').toHaveLength(1)
    expect(rowsOfKind(events, 'error')).toHaveLength(0)
  })

  it('keeps the error path exactly as it was', () => {
    const events = turnEvents({ kind: 'error', error: { message: 'provider exploded' } })
    const errors = rowsOfKind(events, 'error')
    expect(errors, 'a provider error still renders its own row').toHaveLength(1)
    expect((errors[0] as { text: string }).text).toBe('provider exploded')
    expect(rowsOfKind(events, 'terminal'), 'an error is not a terminal state').toHaveLength(0)
  })

  it('leaves a completed turn with no terminal row at all', () => {
    const events = turnEvents({ kind: 'completed' })
    expect(rowsOfKind(events, 'terminal')).toHaveLength(0)
    expect(rowsOfKind(events, 'error')).toHaveLength(0)
  })

  it('dedupes the attempt abort and the turn/end that repeats it into one row', () => {
    const attempt = {
      type: 'assistant/attempt',
      seq: 3,
      time: 3_000,
      data: { turn: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'aborted' } } }] },
    }
    const events = turnEvents({ kind: 'aborted' }, [attempt])
    expect(rowsOfKind(events, 'terminal'), 'one stopped turn leaves one row').toHaveLength(1)
  })

  it('shows the aborted sentence in the transcript, from the locale dictionary', async () => {
    harness.wire.events = turnEvents({ kind: 'aborted' })
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const aborted = copy(ABORTED_KEY)
      expect(aborted, `the ${ABORTED_KEY} key must exist in the locale dictionary`).not.toBe(ABORTED_KEY)
      expect(rendered.container.textContent, 'a stopped turn says so').toContain(aborted)
    } finally {
      rendered.unmount()
    }
  })

  it('shows the output-limit sentence for a max-tokens cut, and it differs from the abort one', async () => {
    harness.wire.events = turnEvents({ kind: 'max-tokens' })
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const limit = copy(MAX_TOKENS_KEY)
      expect(limit, `the ${MAX_TOKENS_KEY} key must exist in the locale dictionary`).not.toBe(MAX_TOKENS_KEY)
      expect(limit, 'the two terminal states must not share one sentence').not.toBe(copy(ABORTED_KEY))
      expect(rendered.container.textContent, 'a truncated answer says so').toContain(limit)
    } finally {
      rendered.unmount()
    }
  })

  it('does not claim a stop on a completed turn', async () => {
    harness.wire.events = turnEvents({ kind: 'completed' })
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const text = rendered.container.textContent ?? ''
      expect(text).not.toContain(copy(ABORTED_KEY))
      expect(text).not.toContain(copy(MAX_TOKENS_KEY))
    } finally {
      rendered.unmount()
    }
  })
})
