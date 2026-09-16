/**
 * Process-local live assistant stream buffer (DSH 0.1.5+).
 *
 * 0.1.2 appended a durable `assistant/chunk` session event for every model
 * delta, so the side-chat transcript and the inherited in-progress snapshot
 * could read streaming text straight out of the session log. 0.1.5 removed
 * that event: an in-flight attempt now publishes `agent/assistant-stream`
 * frames (start / chunk / end) that are NOT part of the log, and the durable
 * record lands only at settlement — `assistant/message` (with the exact
 * `stream` embedded) or `assistant/attempt` (a failed attempt that committed
 * no message, also with its `stream`).
 *
 * This module folds those frames into a bounded per-session buffer of
 * normalized chunks — the same information the old `assistant/chunk` events
 * carried — so the plugin keeps a live transcript and an honest in-progress
 * snapshot. The buffer is cleared when an attempt ends, so a settled step
 * never duplicates its durable message.
 */
import type { Context } from './context-types.ts'

/** One normalized live delta, keyed by its attempt and dense position. */
export interface AssistantLiveChunk {
  /** The attempt these chunks belong to (DSH `LlmAttemptId`). */
  readonly attemptId: string
  /** The turn the attempt belongs to. */
  readonly turn: number
  /** The step the attempt belongs to. */
  readonly step: number
  /** Dense zero-based position within the attempt (DSH's own index). */
  readonly index: number
  /** Safe-integer timestamp of the frame (reused by the durable stream). */
  readonly time: number
  /** The raw model stream chunk (`text-delta` / `reasoning-delta` / …). */
  readonly chunk: Record<string, unknown>
}

/** The plugin's read face over the live frames of every session. */
export interface AssistantLiveBuffer {
  /**
   * The live chunks of one session's active attempt, in index order.
   * @param sessionId - the session whose attempt is streaming.
   * @returns the chunks; empty when nothing is streaming for that session.
   */
  chunksFor(sessionId: string): readonly AssistantLiveChunk[]
  /** Stop observing the agent stream. */
  dispose(): void
}

/** Per-attempt buffer ceiling; beyond it the oldest deltas are dropped. */
export const LIVE_CHUNK_CAP = 4000

/** How many sessions may hold a live buffer at once (the oldest is dropped). */
export const LIVE_SESSION_CAP = 64

/** One session's active attempt as it accumulates. */
interface Attempt {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  readonly chunks: AssistantLiveChunk[]
  /** The next dense frame index this attempt accepts (independent of the
   *  window below, which drops the oldest chunks once the cap is reached). */
  nextIndex: number
}

/** A frame's `chunk` payload must be a JSON record to be worth buffering. */
function chunkOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A finite non-negative integer, or undefined. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Fold `agent/assistant-stream` frames into per-session live buffers.
 *
 * Frames arrive for every attached agent, so the buffer is keyed by the
 * emitting session and ignores anything it cannot identify. An out-of-order
 * or mismatched chunk drops the attempt rather than splicing a gap: a
 * transcript with a hole is worse than one that settles at the next durable
 * event.
 * @param ctx - host plugin context (its `on` subscribes the session feed).
 * @param cap - per-attempt chunk ceiling.
 * @returns the read face and a disposer unbinding the listener.
 */
export function createAssistantLiveBuffer(ctx: Context, cap: number = LIVE_CHUNK_CAP): AssistantLiveBuffer {
  const attempts = new Map<string, Attempt>()
  const off = ctx.on('agent/assistant-stream', (payload) => {
    const record = payload as { agent?: unknown; frame?: unknown } | null
    const frame = record?.frame as Record<string, unknown> | undefined
    if (frame === undefined) return
    const session = (record?.agent as { session?: { id?: unknown } } | undefined)?.session
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    const type = frame['type']
    if (type === 'end') {
      attempts.delete(sessionId)
      return
    }
    const attemptId = typeof frame['attemptId'] === 'string' ? frame.attemptId : undefined
    if (attemptId === undefined) return
    if (type === 'start') {
      const turn = countOf(frame['turn'])
      const step = countOf(frame['step'])
      if (turn === undefined || step === undefined) return
      const known = attempts.has(sessionId)
      attempts.delete(sessionId)
      // Only a NEW session may evict the oldest tracked one.
      if (!known && attempts.size >= LIVE_SESSION_CAP) {
        const oldest = attempts.keys().next().value
        if (oldest !== undefined) attempts.delete(oldest)
      }
      attempts.set(sessionId, { attemptId, turn, step, chunks: [], nextIndex: 0 })
      return
    }
    if (type !== 'chunk') return
    const attempt = attempts.get(sessionId)
    if (attempt === undefined || attempt.attemptId !== attemptId) return
    const index = countOf(frame['index'])
    const chunk = chunkOf(frame['chunk'])
    // Dense positions only: a gap means the buffer missed frames (a
    // replacement attempt, a reconnect) and its text would be wrong.
    if (index === undefined || chunk === undefined || index !== attempt.nextIndex) {
      attempts.delete(sessionId)
      return
    }
    attempt.nextIndex = index + 1
    const time = countOf(frame['time']) ?? 0
    attempt.chunks.push({ attemptId, turn: attempt.turn, step: attempt.step, index, time, chunk })
    if (attempt.chunks.length > cap) attempt.chunks.splice(0, attempt.chunks.length - cap)
  })
  return {
    chunksFor: sessionId => attempts.get(sessionId)?.chunks ?? [],
    dispose: () => { off() },
  }
}
