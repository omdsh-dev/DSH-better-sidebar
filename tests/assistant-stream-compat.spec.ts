/**
 * Unit tests for the v2 assistant-stream compatibility helper
 * (src/assistant-stream-compat.ts): packed delta runs, raw chunk records,
 * unknown/tool-call records, and the event-level entry point.
 */
import { describe, expect, it } from 'vitest'
import { assistantEventDeltas, assistantStreamDeltas } from '../src/assistant-stream-compat.ts'

describe('assistantStreamDeltas', () => {
  it('expands packed text and reasoning runs in record order', () => {
    const deltas = assistantStreamDeltas([
      { type: 'text-chunks', time0: 1, index: 0, dt: [0, 10], texts: ['Hel', 'lo'] },
      { type: 'reasoning-chunks', time0: 30, index: 1, dt: [0], texts: ['think'] },
    ])
    expect(deltas).toEqual([
      { kind: 'assistant', text: 'Hel', index: 0 },
      { kind: 'assistant', text: 'lo', index: 0 },
      { kind: 'reasoning', text: 'think', index: 1 },
    ])
  })

  it('keeps raw chunk records and ignores tool-call runs', () => {
    const deltas = assistantStreamDeltas([
      { type: 'tool-call-chunks', time0: 1, index: 0, dt: [0], id: 'c1', name: 'read', args: ['{"path":"a"}'] },
      { type: 'chunk', time: 5, chunk: { type: 'text-delta', index: 2, text: 'raw' } },
    ])
    expect(deltas).toEqual([{ kind: 'assistant', text: 'raw', index: 2 }])
  })

  it('skips malformed, unknown, and empty entries instead of throwing', () => {
    const deltas = assistantStreamDeltas([
      null,
      'nope',
      { type: 'future-encoding', anything: true },
      { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: 'not-an-array' },
      { type: 'chunk', time: 1, chunk: { type: 'usage', usage: {} } },
      { type: 'text-chunks', time0: 0, index: 0, dt: [0, 0], texts: ['ok', ''] },
    ])
    expect(deltas).toEqual([{ kind: 'assistant', text: 'ok', index: 0 }])
  })

  it('tolerates a missing or non-array stream', () => {
    expect(assistantStreamDeltas(undefined)).toEqual([])
    expect(assistantStreamDeltas(null)).toEqual([])
    expect(assistantStreamDeltas({})).toEqual([])
  })
})

describe('assistantEventDeltas', () => {
  it('reads the embedded stream of a v2 settlement', () => {
    expect(assistantEventDeltas({
      turn: 1,
      step: 1,
      message: { content: [] },
      stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: ['hi'] }],
    })).toEqual([{ kind: 'assistant', text: 'hi', index: 0 }])
  })

  it('returns nothing for v1 chunk events (they carry no embedded stream)', () => {
    expect(assistantEventDeltas({ turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' } })).toEqual([])
  })
})
