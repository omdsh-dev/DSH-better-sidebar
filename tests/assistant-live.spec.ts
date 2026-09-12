/**
 * Unit tests for the live assistant stream buffer (src/assistant-live.ts):
 * the fold that replaces DSH 0.1.2's durable `assistant/chunk` events with
 * the process-local `agent/assistant-stream` frames 0.1.5 publishes instead.
 */
import { describe, expect, it, vi } from 'vitest'
import { createAssistantLiveBuffer, LIVE_CHUNK_CAP, LIVE_SESSION_CAP } from '../src/assistant-live.ts'
import type { Context } from '../src/context-types.ts'

/** A context whose `on` records the stream listener the buffer installs. */
function harness(): {
  ctx: Context
  emit: (payload: unknown) => void
  off: ReturnType<typeof vi.fn>
} {
  let listener: ((payload: unknown) => void) | undefined
  const off = vi.fn()
  const ctx = {
    on: (event: string, fn: (payload: unknown) => void) => {
      expect(event).toBe('agent/assistant-stream')
      listener = fn
      return off
    },
  } as unknown as Context
  return { ctx, emit: payload => { listener?.(payload) }, off }
}

/** One frame as DSH emits it, for the session named by `sessionId`. */
function frame(sessionId: string, frame: Record<string, unknown>): Record<string, unknown> {
  return { agent: { session: { id: sessionId } }, frame }
}

describe('createAssistantLiveBuffer', () => {
  it('folds start + chunk frames into ordered per-session chunks', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    emit(frame('s1', { type: 'start', attemptId: 'a1', revision: 1, turn: 2, step: 1 }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 10, chunk: { type: 'text-delta', index: 0, text: 'he' } }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 11, chunk: { type: 'reasoning-delta', index: 1, text: 'hmm' } }))
    const chunks = live.chunksFor('s1')
    expect(chunks.map(chunk => [chunk.turn, chunk.step, chunk.index, chunk.time])).toEqual([
      [2, 1, 0, 10],
      [2, 1, 1, 11],
    ])
    expect(chunks[1]?.chunk).toEqual({ type: 'reasoning-delta', index: 1, text: 'hmm' })
    expect(live.chunksFor('other')).toEqual([])
  })

  it('ignores payloads it cannot identify', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    emit(undefined)
    emit({})
    emit({ agent: {}, frame: { type: 'chunk', attemptId: 'a1', index: 0, chunk: {} } })
    emit({ agent: { session: { id: 's1' } }, frame: { type: 'chunk', attemptId: 'a1', index: 0, chunk: {} } })
    // A chunk with no start is not an attempt this buffer knows.
    expect(live.chunksFor('s1')).toEqual([])
    emit(frame('s1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a1', index: 0, chunk: 'not-a-record' }))
    expect(live.chunksFor('s1')).toEqual([])
  })

  it('drops the attempt on a gap rather than splicing incomplete text', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    emit(frame('s1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'text-delta', text: 'a' } }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a1', index: 2, chunk: { type: 'text-delta', text: 'c' } }))
    expect(live.chunksFor('s1')).toEqual([])
  })

  it('drops the attempt when a chunk names another attempt', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    emit(frame('s1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a2', index: 0, chunk: { type: 'text-delta', text: 'a' } }))
    expect(live.chunksFor('s1')).toEqual([])
  })

  it('clears the buffer when the attempt ends', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    emit(frame('s1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'text-delta', text: 'a' } }))
    emit(frame('s1', { type: 'end', attemptId: 'a1', index: 1, outcome: { kind: 'abandoned' } }))
    expect(live.chunksFor('s1')).toEqual([])
  })

  it('a new start replaces the previous attempt of the same session', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    emit(frame('s1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 }))
    emit(frame('s1', { type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'text-delta', text: 'old' } }))
    emit(frame('s1', { type: 'start', attemptId: 'a2', turn: 1, step: 2 }))
    expect(live.chunksFor('s1')).toEqual([])
    emit(frame('s1', { type: 'chunk', attemptId: 'a2', index: 0, chunk: { type: 'text-delta', text: 'new' } }))
    expect(live.chunksFor('s1').map(chunk => chunk.chunk['text'])).toEqual(['new'])
  })

  it('caps one attempt at LIVE_CHUNK_CAP chunks (oldest dropped)', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    emit(frame('s1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 }))
    for (let index = 0; index < LIVE_CHUNK_CAP + 3; index++) {
      emit(frame('s1', { type: 'chunk', attemptId: 'a1', index, chunk: { type: 'text-delta', text: String(index) } }))
    }
    const chunks = live.chunksFor('s1')
    expect(chunks).toHaveLength(LIVE_CHUNK_CAP)
    expect(chunks[0]?.index).toBe(3)
    expect(chunks.at(-1)?.index).toBe(LIVE_CHUNK_CAP + 2)
  })

  it('caps tracked sessions at LIVE_SESSION_CAP (oldest dropped)', () => {
    const { ctx, emit } = harness()
    const live = createAssistantLiveBuffer(ctx)
    for (let index = 0; index < LIVE_SESSION_CAP + 1; index++) {
      emit(frame(`s${index}`, { type: 'start', attemptId: 'a1', turn: 1, step: 1 }))
    }
    expect(live.chunksFor('s0')).toEqual([])
    expect(live.chunksFor(`s${LIVE_SESSION_CAP}`)).toEqual([])
    // The most recent session is the only live one, and it has no chunks yet.
    emit(frame(`s${LIVE_SESSION_CAP}`, { type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'text-delta', text: 'x' } }))
    expect(live.chunksFor(`s${LIVE_SESSION_CAP}`)).toHaveLength(1)
  })

  it('dispose unbinds the stream listener', () => {
    const { ctx, off } = harness()
    const live = createAssistantLiveBuffer(ctx)
    live.dispose()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
