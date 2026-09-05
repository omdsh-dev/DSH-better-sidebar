/**
 * Host tests for the live assistant-stream mirror: the in-memory stand-in for
 * the durable `assistant/chunk` event DSH 0.1.3-alpha.1 removed. The mirror
 * buffers one in-flight prefix per session from `agent/assistant-stream`
 * frames so the transcript poll can carry it; it must drop that prefix the
 * moment the attempt ends (the durable settlement is already in the log by
 * then) and must never let a superseded attempt append to its replacement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantStreamMirror } from '../src/sidechat-live.ts'
import type { Context, SidebarAssistantStreamFrame } from '../src/context-types.ts'

type Frame = SidebarAssistantStreamFrame
type Listener = (payload: { agent: unknown; frame: Frame }) => void

/** A host context double capturing the one `agent/assistant-stream` listener. */
function ctxDouble() {
  let listener: Listener | undefined
  const dispose = vi.fn()
  const effect = vi.fn((setup: () => unknown, _description?: string) => setup())
  const on = vi.fn((event: string, handler: Listener) => {
    expect(event).toBe('agent/assistant-stream')
    listener = handler
    return dispose
  })
  const ctx = { on, effect } as unknown as Context
  /** Deliver one frame as the named session's agent. */
  const emit = (sessionId: string | undefined, frame: Frame): void => {
    listener?.({ agent: sessionId === undefined ? null : { session: { id: sessionId } }, frame })
  }
  return { ctx, emit, on, effect, dispose }
}

const START: Frame = { type: 'start', attemptId: 'a1', revision: 1, turn: 2, step: 3 }

/** The host allocates `revision` per FRAME, not per attempt — so every frame
 *  of one attempt carries a fresh, higher number. */
let revision = START.revision

/** A text/reasoning delta frame of the started attempt. */
function delta(type: 'text-delta' | 'reasoning-delta', text: string): Frame {
  revision += 1
  return { type: 'chunk', attemptId: 'a1', revision, index: revision, time: revision, chunk: { type, text } }
}

/** The terminal frame of the started attempt, with a durable settlement. */
function end(attemptId = 'a1'): Frame {
  revision += 1
  return {
    type: 'end', attemptId, revision, index: revision,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 42 },
  }
}

beforeEach(() => { revision = START.revision })

describe('createAssistantStreamMirror', () => {
  it('accumulates text and reasoning of the started attempt under its session', () => {
    const { ctx, emit } = ctxDouble()
    const mirror = createAssistantStreamMirror(ctx)
    emit('child', START)
    // A started attempt with nothing delivered yet has nothing to show.
    expect(mirror.step('child')).toBeUndefined()
    emit('child', delta('reasoning-delta', 'thin'))
    emit('child', delta('reasoning-delta', 'king'))
    emit('child', delta('text-delta', 'Hel'))
    emit('child', delta('text-delta', 'lo'))
    expect(mirror.step('child')).toEqual({ turn: 2, step: 3, text: 'Hello', reasoning: 'thinking' })
    // Other sessions are unaffected: the buffer is keyed per session.
    expect(mirror.step('other')).toBeUndefined()
  })

  it('drops the prefix at the end frame, because the log already holds it', () => {
    const { ctx, emit } = ctxDouble()
    const mirror = createAssistantStreamMirror(ctx)
    emit('child', START)
    emit('child', delta('text-delta', 'answer'))
    emit('child', end())
    expect(mirror.step('child')).toBeUndefined()
  })

  it('ignores frames of a superseded attempt once its retry has started', () => {
    const { ctx, emit } = ctxDouble()
    const mirror = createAssistantStreamMirror(ctx)
    emit('child', START)
    emit('child', delta('text-delta', 'abandoned'))
    emit('child', { type: 'start', attemptId: 'a2', revision: 10, turn: 2, step: 3 })
    // A late frame of the abandoned attempt, numbered ABOVE the replacement's
    // start: only the attempt id can reject it.
    emit('child', { type: 'chunk', attemptId: 'a1', revision: 11, index: 3, time: 3, chunk: { type: 'text-delta', text: ' late' } })
    emit('child', { type: 'chunk', attemptId: 'a2', revision: 12, index: 0, time: 4, chunk: { type: 'text-delta', text: 'retried' } })
    expect(mirror.step('child')).toEqual({ turn: 2, step: 3, text: 'retried', reasoning: '' })
    // The stale attempt's end frame must not clear the live replacement.
    emit('child', end('a1'))
    expect(mirror.step('child')).toMatchObject({ text: 'retried' })
  })

  it('ignores a frame numbered at or below one already applied (stale duplicate)', () => {
    const { ctx, emit } = ctxDouble()
    const mirror = createAssistantStreamMirror(ctx)
    emit('child', START)
    const applied = delta('text-delta', 'kept')
    emit('child', applied)
    // The same revision redelivered, and one below it: both already accounted for.
    const at = applied.revision
    emit('child', { type: 'chunk', attemptId: 'a1', revision: at, index: 1, time: 1, chunk: { type: 'text-delta', text: 'redelivered' } })
    emit('child', { type: 'chunk', attemptId: 'a1', revision: at - 1, index: 0, time: 0, chunk: { type: 'text-delta', text: 'older' } })
    expect(mirror.step('child')).toMatchObject({ text: 'kept' })
  })

  it('ignores chunks with no started attempt, no session id, or no usable delta', () => {
    const { ctx, emit } = ctxDouble()
    const mirror = createAssistantStreamMirror(ctx)
    // No start yet.
    emit('child', delta('text-delta', 'orphan'))
    expect(mirror.step('child')).toBeUndefined()
    // An agent without a string session id (a detached or malformed payload).
    emit(undefined, START)
    emit('child', START)
    const chunks = [null, 'not-an-object', {}, { type: 'text-delta' }, { type: 'text-delta', text: '' }, { type: 'tool-call-delta', text: 'x' }]
    chunks.forEach((chunk, offset) => {
      emit('child', { type: 'chunk', attemptId: 'a1', revision: START.revision + 1 + offset, index: offset, time: offset, chunk })
    })
    expect(mirror.step('child')).toBeUndefined()
  })

  it('caps one buffered prefix and keeps its newest text', () => {
    const { ctx, emit } = ctxDouble()
    const mirror = createAssistantStreamMirror(ctx)
    emit('child', START)
    emit('child', delta('text-delta', 'x'.repeat(64_000)))
    emit('child', delta('text-delta', 'tail'))
    emit('child', delta('reasoning-delta', 'y'.repeat(70_000)))
    const live = mirror.step('child')
    expect(live?.text).toHaveLength(64_000)
    expect(live?.text.endsWith('tail')).toBe(true)
    expect(live?.reasoning).toHaveLength(64_000)
  })

  it('registers the listener for disposal and degrades without ctx.on', () => {
    const { ctx, effect, dispose } = ctxDouble()
    createAssistantStreamMirror(ctx)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(effect.mock.calls[0]![1]).toContain('dsh-better-sidebar')
    // The effect setup returns the listener's own disposer.
    expect(effect.mock.results[0]!.value).toBe(dispose)
    // A test double or a host without the event bus: no live step, ever.
    const blind = createAssistantStreamMirror({} as unknown as Context)
    expect(blind.step('child')).toBeUndefined()
  })
})
