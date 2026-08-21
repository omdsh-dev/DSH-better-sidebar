/**
 * Unit tests for the Side Chat transcript mapping (src/client/sidechat-
 * transcript.ts): the seed cut at session/end-seed, the boundary-row drop,
 * chunk streaming accumulation superseded by assembled messages, tool
 * call/result pairing, and orphan failed results.
 */
import { describe, expect, it } from 'vitest'
import type { SidebarHistoryEntry, SidebarSessionEvent } from '../src/context-types.ts'
import { SIDE_BOUNDARY_PREFIX } from '../src/sidechat-core.ts'
import { collectOwnEvents, transcriptRows, type SidechatTranscriptRow } from '../src/client/sidechat-transcript.ts'

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
  it('cuts the inherited seed at the last end-seed and drops the boundary row', () => {
    const entries = [
      entry(ev('user/message', 0, { content: textBlocks('inherited'), source: { kind: 'user' } })),
      entry(ev('session/end-seed', 1)),
      entry(ev('user/message', 2, { content: textBlocks(`${SIDE_BOUNDARY_PREFIX}\n\nmode`), source: { kind: 'user' } })),
      entry(ev('user/message', 3, { content: textBlocks('the side question'), source: { kind: 'user' } })),
    ]
    const rows = transcriptRows(entries)
    expect(rows).toEqual([{ kind: 'user', seq: 3, text: 'the side question' }])
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

describe('collectOwnEvents', () => {
  /** A paginated fake log: fetchPage(beforeSeq) returns the ≤pageSize events
   *  ENDING before beforeSeq (exclusive); the tail page when omitted. */
  function pagedLog(events: SidebarSessionEvent[], pageSize: number) {
    const calls: Array<number | undefined> = []
    const fetchPage = async (beforeSeq?: number): Promise<SidebarHistoryEntry[]> => {
      calls.push(beforeSeq)
      const window = beforeSeq === undefined ? events : events.filter(e => e.seq < beforeSeq)
      return window.slice(-pageSize).map(entry)
    }
    return { fetchPage, calls }
  }

  it('finds the seed boundary on the tail page in one fetch', async () => {
    const { fetchPage, calls } = pagedLog([
      ev('user/message', 0, { content: textBlocks('inherited'), source: { kind: 'user' } }),
      ev('session/end-seed', 1),
      ev('user/message', 2, { content: textBlocks('own'), source: { kind: 'user' } }),
      ev('assistant/message', 3, { turn: 1, step: 1, message: { content: textBlocks('a') } }),
    ], 200)
    const result = await collectOwnEvents(fetchPage)
    expect(calls).toEqual([undefined])
    expect(result.seedBoundary).toBe(1)
    expect(result.entries.map(e => e.event.seq)).toEqual([2, 3])
  })

  it('walks back across pages until the boundary surfaces', async () => {
    // A dense chunk tail (cold reads re-expand chunk-rows): the boundary is
    // several pages back and earlier tool/call events must NOT fall out of
    // the loaded window (the re-entry tool-row regression).
    const events = [
      ev('session/end-seed', 0),
      ev('tool/call', 1, { turn: 1, step: 1, callId: 'c1', name: 'bash' }),
      ...Array.from({ length: 12 }, (_, i) => ev('assistant/chunk', 2 + i, { turn: 1, step: 1 })),
    ]
    const { fetchPage, calls } = pagedLog(events, 5)
    const result = await collectOwnEvents(fetchPage)
    expect(calls.length).toBeGreaterThan(1)
    expect(result.seedBoundary).toBe(0)
    // Everything after the marker, oldest-first, deduped.
    expect(result.entries.map(e => e.event.seq)).toEqual(events.slice(1).map(e => e.seq))
  })

  it('stops at the log start when no marker exists and reports boundary 0', async () => {
    const { fetchPage } = pagedLog([
      ev('user/message', 0, { content: textBlocks('legacy'), source: { kind: 'user' } }),
      ev('assistant/message', 1, { turn: 1, step: 1, message: { content: textBlocks('a') } }),
    ], 200)
    const result = await collectOwnEvents(fetchPage)
    expect(result.seedBoundary).toBe(0)
    expect(result.entries.map(e => e.event.seq)).toEqual([0, 1])
  })

  it('honours the page cap instead of re-walking forever', async () => {
    const events = Array.from({ length: 30 }, (_, i) => ev('assistant/chunk', i, { turn: 1, step: 1 }))
    const { fetchPage, calls } = pagedLog(events, 5)
    const result = await collectOwnEvents(fetchPage, 2)
    expect(calls).toEqual([undefined, 25])
    expect(result.seedBoundary).toBe(0)
    expect(result.entries.map(e => e.event.seq)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  })
})
