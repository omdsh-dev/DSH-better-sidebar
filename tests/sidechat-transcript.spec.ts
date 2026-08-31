/**
 * Unit tests for the Side Chat transcript mapping (src/client/sidechat-
 * transcript.ts): the seed cut at session/end-seed, context-injection rows
 * (plugin-stamped sources and the legacy boundary-prefix blob), chunk
 * streaming accumulation superseded by assembled messages, tool call/result
 * pairing, and orphan failed results.
 */
import { describe, expect, it } from 'vitest'
import type { SidebarHistoryEntry, SidebarSessionEvent } from '../src/context-types.ts'
import { SIDE_BOUNDARY_PREFIX, SIDE_BOUNDARY_PROMPT, SIDE_INJECTION_PLUGIN } from '../src/sidechat-core.ts'
import {
  formatDurationMs,
  formatTokens,
  toolArgsSummary,
  transcriptRows,
  type SidechatTranscriptRow,
} from '../src/client/sidechat-transcript.ts'

/** One history entry (event + optional view). */
function entry(event: SidebarSessionEvent): SidebarHistoryEntry {
  return { event }
}

/** One log event fixture. Surface-eligible events carry their required
 *  `surfaceOp: 'append'` marker, exactly like the live pipeline appends them. */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): SidebarSessionEvent {
  const event: SidebarSessionEvent = { type, seq, time: seq * 1000, data }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
    return { ...event, surfaceOp: 'append' } as SidebarSessionEvent
  }
  return event
}

function textBlocks(...texts: string[]): unknown[] {
  return texts.map(text => ({ type: 'text', text }))
}

describe('transcriptRows', () => {
  it('cuts the inherited seed at the last end-seed and renders the boundary as an injection row', () => {
    const entries = [
      entry(ev('user/message', 0, { content: textBlocks('inherited'), source: { kind: 'user' } })),
      entry(ev('session/end-seed', 1)),
      entry(ev('user/message', 2, { content: textBlocks(`${SIDE_BOUNDARY_PREFIX}\n\nmode`), source: { kind: 'plugin', plugin: SIDE_INJECTION_PLUGIN } })),
      entry(ev('user/message', 3, { content: textBlocks('the side question'), source: { kind: 'user' } })),
    ]
    const rows = transcriptRows(entries)
    expect(rows).toEqual([
      { kind: 'injection', seq: 2, text: `${SIDE_BOUNDARY_PREFIX}\n\nmode` },
      { kind: 'user', seq: 3, text: 'the side question' },
    ])
  })

  it('splits the LEGACY wrapped first message (boundary + question in one user row) at the boundary prompt', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('user/message', 1, {
        content: textBlocks(`${SIDE_BOUNDARY_PROMPT}\n\nthe first question`),
        source: { kind: 'user' },
      })),
      entry(ev('user/message', 2, { content: textBlocks('follow-up'), source: { kind: 'user' } })),
    ]
    const rows = transcriptRows(entries)
    expect(rows).toEqual([
      { kind: 'injection', seq: 1, text: SIDE_BOUNDARY_PROMPT },
      { kind: 'user', seq: 1, text: 'the first question' },
      { kind: 'user', seq: 2, text: 'follow-up' },
    ])
  })

  it('renders any plugin-sourced context message as an injection row, boundary prefix or not', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('user/message', 1, { content: textBlocks('runtime context'), source: { kind: 'plugin', plugin: 'other-plugin' } })),
      entry(ev('user/message', 2, { content: textBlocks('q'), source: { kind: 'user' } })),
    ]
    const rows = transcriptRows(entries)
    expect(rows).toEqual([
      { kind: 'injection', seq: 1, text: 'runtime context' },
      { kind: 'user', seq: 2, text: 'q' },
    ])
  })

  it('accumulates chunk deltas per block and supersedes them on settle', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('user/message', 1, { content: textBlocks('q'), source: { kind: 'user' } })),
      entry(ev('turn/start', 2, { turn: 1 })),
      entry(ev('step/start', 3, { turn: 1, step: 1 })),
      entry(ev('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } })),
      entry(ev('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } })),
      entry(ev('assistant/chunk', 6, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'think' } })),
    ]
    const rows = transcriptRows(entries)
    const assistant = rows.find(row => row.kind === 'assistant') as Extract<SidechatTranscriptRow, { kind: 'assistant' }>
    expect(assistant.text).toBe('Hello')
    expect(assistant.settled).toBe(false)
    const reasoning = rows.find(row => row.kind === 'reasoning') as Extract<SidechatTranscriptRow, { kind: 'reasoning' }>
    expect(reasoning.text).toBe('think')
  })

  it('replaces streaming rows with the settled assistant message', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('user/message', 1, { content: textBlocks('q'), source: { kind: 'user' } })),
      entry(ev('turn/start', 2, { turn: 1 })),
      entry(ev('step/start', 3, { turn: 1, step: 1 })),
      entry(ev('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } })),
      entry(ev('assistant/message', 5, { turn: 1, step: 1, message: { content: textBlocks('final answer') } })),
    ]
    const rows = transcriptRows(entries)
    const assistants = rows.filter(row => row.kind === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ kind: 'assistant', text: 'final answer', settled: true })
  })

  it('pairs tool calls with results and marks failures', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('turn/start', 1, { turn: 1 })),
      entry(ev('step/start', 2, { turn: 1, step: 1 })),
      entry(ev('tool/call', 3, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' })),
      entry(ev('tool/result', 4, {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'denied' }] }],
        },
        error: { name: 'EACCES', code: 'EACCES' },
      })),
    ]
    const rows = transcriptRows(entries)
    expect(rows).toHaveLength(1)
    const tool = rows[0]
    expect(tool).toMatchObject({
      kind: 'tool',
      name: 'read',
      args: '{"path":"a"}',
      resultText: 'denied',
      failed: true,
      executing: false,
    })
  })

  it('keeps a call executing until its result lands and surfaces orphan failures', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('turn/start', 1, { turn: 1 })),
      entry(ev('step/start', 2, { turn: 1, step: 1 })),
      entry(ev('tool/call', 3, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })),
    ]
    let rows = transcriptRows(entries)
    expect(rows[0]).toMatchObject({ kind: 'tool', executing: true })

    // Orphan failed result outside the fetched window still surfaces.
    const orphan = [
      entry(ev('session/end-seed', 0)),
      entry(ev('tool/result', 1, {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'gone' },
          content: [{ type: 'tool-result', toolCallId: 'gone', isError: true, content: [{ type: 'text', text: 'boom' }] }],
        },
        error: { name: 'X', code: 'X' },
      })),
    ]
    rows = transcriptRows(orphan)
    expect(rows[0]).toMatchObject({ kind: 'tool', failed: true, resultText: 'boom' })
  })
})

describe('turnSummary rows', () => {
  it('emits one tail row per turn: envelope-time duration + last-input/summed-output usage', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('turn/start', 1, { turn: 1 })),
      entry(ev('assistant/message', 2, { turn: 1, step: 1, message: { content: textBlocks('a') }, usage: { inputTokens: 100, outputTokens: 40 } })),
      entry(ev('assistant/message', 3, { turn: 1, step: 2, message: { content: textBlocks('b') }, usage: { inputTokens: 160, outputTokens: 30 } })),
      entry(ev('turn/end', 4, { turn: 1, reason: 'completed' })),
    ]
    const rows = transcriptRows(entries)
    expect(rows.at(-1)).toEqual({ kind: 'turnSummary', seq: 4, inputTokens: 160, outputTokens: 70, durationMs: 3000 })
  })

  it('keeps a duration-only tail without usage and a usage-only tail without a turn/start', () => {
    const cancelled = [
      entry(ev('session/end-seed', 0)),
      entry(ev('turn/start', 2, { turn: 1 })),
      entry(ev('turn/end', 7, { turn: 1, reason: 'cancelled' })),
    ]
    expect(transcriptRows(cancelled).at(-1)).toEqual({ kind: 'turnSummary', seq: 7, durationMs: 5000 })

    const seedCutStart = [
      entry(ev('session/end-seed', 0)),
      entry(ev('assistant/message', 2, { turn: 1, step: 1, message: { content: textBlocks('a') }, usage: { inputTokens: 10, outputTokens: 5 } })),
      entry(ev('turn/end', 3, { turn: 1, reason: 'completed' })),
    ]
    expect(transcriptRows(seedCutStart).at(-1)).toEqual({ kind: 'turnSummary', seq: 3, inputTokens: 10, outputTokens: 5 })
  })

  it('skips the tail entirely when nothing is computable', () => {
    const entries = [
      entry(ev('session/end-seed', 0)),
      entry(ev('turn/end', 1, { turn: 1, reason: 'completed' })),
    ]
    expect(transcriptRows(entries)).toEqual([])
  })
})

describe('tool cards', () => {
  const callRow = (seq: number, name: string, args: string): SidebarHistoryEntry =>
    entry(ev('tool/call', seq, { turn: 1, step: 1, callId: `c${seq}`, name, arguments: args }))

  const resultRow = (seq: number, callId: string, text: string, extra: Record<string, unknown> = {}): SidebarHistoryEntry =>
    entry(ev('tool/result', seq, {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
      ...extra,
    }))

  const toolRow = (entries: readonly SidebarHistoryEntry[]) => {
    const rows = transcriptRows(entries)
    expect(rows).toHaveLength(1)
    return rows[0] as Extract<SidechatTranscriptRow, { kind: 'tool' }>
  }

  it('derives the call-time terminal card for bash and refines output/exit from the result marker', () => {
    const row = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'bash', '{"command":"echo hi","workdir":"/w"}'),
      resultRow(2, 'c1', 'hi\n[exit code: 3]'),
    ])
    expect(row.card).toEqual({ type: 'terminal', command: 'echo hi', cwd: '/w', output: 'hi', exitCode: 3 })
  })

  it('recovers the signal pill and defaults a marker-less settle to exit code 0', () => {
    const signaled = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'bash', '{"command":"x"}'),
      resultRow(2, 'c1', 'boom\n[killed by signal: SIGKILL]'),
    ])
    expect(signaled.card).toEqual({ type: 'terminal', command: 'x', output: 'boom', signal: 'SIGKILL' })

    const clean = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'bash', '{"command":"x"}'),
      resultRow(2, 'c1', 'ok'),
    ])
    expect(clean.card).toEqual({ type: 'terminal', command: 'x', output: 'ok', exitCode: 0 })
  })

  it('skips the terminal card for background bash and drops it on failed results', () => {
    const background = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'bash', '{"command":"x","run_in_background":true}'),
    ])
    expect(background.card).toBeUndefined()

    const failed = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'bash', '{"command":"x"}'),
      resultRow(2, 'c1', 'denied', { error: { name: 'EACCES', code: 'EACCES' } }),
    ])
    expect(failed.card).toBeUndefined()
  })

  it('derives literal diff cards for edit/write calls and refines from the result meta hunks', () => {
    const edit = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'edit', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
    ])
    expect(edit.card).toEqual({ type: 'diff', diffs: [{ path: '/a.ts', oldText: 'x', newText: 'y' }] })

    const write = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'write', '{"file_path":"/new.ts","content":"body"}'),
    ])
    expect(write.card).toEqual({ type: 'diff', diffs: [{ path: '/new.ts', oldText: null, newText: 'body' }] })

    const refined = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'edit', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
      resultRow(2, 'c1', 'ok', { meta: { diffs: [{ path: '/a.ts', oldText: 'x\nctx', newText: 'y\nctx' }] } }),
    ])
    expect(refined.card).toEqual({ type: 'diff', diffs: [{ path: '/a.ts', oldText: 'x\nctx', newText: 'y\nctx' }] })

    const malformed = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'edit', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'),
      resultRow(2, 'c1', 'ok', { meta: { diffs: [{ path: 7, oldText: 'x', newText: 'y' }] } }),
    ])
    // Malformed meta declines to the call-time literal card, never throws.
    expect(malformed.card).toEqual({ type: 'diff', diffs: [{ path: '/a.ts', oldText: 'x', newText: 'y' }] })
  })

  it('builds the read card from the result line-window meta and declines malformed windows', () => {
    const read = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'read', '{"path":"/a.ts","offset":2,"limit":2}'),
      resultRow(2, 'c1', 'window text', {
        meta: { path: '/a.ts', offset: 2, lines: [{ number: 2, text: 'b' }, { number: 3, text: 'c' }], totalLines: 5, lang: 'ts' },
      }),
    ])
    expect(read.card).toEqual({
      type: 'read',
      label: '/a.ts',
      lines: [{ number: 2, text: 'b' }, { number: 3, text: 'c' }],
      totalLines: 5,
      lang: 'ts',
    })

    const nonMonotonic = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'read', '{"path":"/a.ts"}'),
      resultRow(2, 'c1', 'window text', {
        meta: { path: '/a.ts', offset: 1, lines: [{ number: 3, text: 'c' }, { number: 2, text: 'b' }], totalLines: 5 },
      }),
    ])
    expect(nonMonotonic.card).toBeUndefined()
  })

  it('leaves unknown tools on the generic row', () => {
    const row = toolRow([
      entry(ev('session/end-seed', 0)),
      callRow(1, 'todo_write', '{"todos":[]}'),
    ])
    expect(row.card).toBeUndefined()
  })
})

describe('usage formatting', () => {
  it('formatTokens mirrors the main conversation K/M compaction', () => {
    expect(formatTokens(517)).toBe('517')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_234)).toBe('1.2K')
    expect(formatTokens(12_234)).toBe('12.2K')
    expect(formatTokens(122_345)).toBe('122K')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })

  it('formatDurationMs mirrors the main conversation s / m+s cadence', () => {
    expect(formatDurationMs(0)).toBe('0s')
    expect(formatDurationMs(500)).toBe('0.5s')
    expect(formatDurationMs(45_200)).toBe('45.2s')
    expect(formatDurationMs(61_000)).toBe('1m1s')
    expect(formatDurationMs(162_000)).toBe('2m42s')
  })
})

describe('toolArgsSummary', () => {
  it('picks the most identifying string field', () => {
    expect(toolArgsSummary('{"command":"ls -la","timeout":1000}')).toBe('ls -la')
    expect(toolArgsSummary('{"file_path":"/a/b.ts","old_string":"x"}')).toBe('/a/b.ts')
    expect(toolArgsSummary('{"pattern":"foo","path":"/repo"}')).toBe('/repo')
  })

  it('flattens and truncates raw text when no known key parses', () => {
    expect(toolArgsSummary('{"custom":"v"}')).toBe('{"custom":"v"}')
    expect(toolArgsSummary('not json at all')).toBe('not json at all')
    expect(toolArgsSummary(`{"command":"${'x'.repeat(200)}"`)).toHaveLength(80)
    expect(toolArgsSummary(`{"command":"${'x'.repeat(200)}"`)).toMatch(/…$/)
  })

  it('reads empty for missing or blank input', () => {
    expect(toolArgsSummary(undefined)).toBe('')
    expect(toolArgsSummary('{"command":"   "}')).toBe('{"command":" "}')
  })
})
