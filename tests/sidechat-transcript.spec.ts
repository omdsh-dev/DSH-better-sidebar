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
import { toolArgsSummary, transcriptRows, type SidechatTranscriptRow } from '../src/client/sidechat-transcript.ts'

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
