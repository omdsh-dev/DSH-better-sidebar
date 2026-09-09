/**
 * The live assistant output of a Side Chat thread's in-flight step.
 *
 * DSH 0.1.3-alpha.1 removed the durable `assistant/chunk` event: a step's
 * token stream is now embedded in the settled `assistant/message` /
 * `assistant/attempt` and published live — process-locally, not durably —
 * as `agent/assistant-stream` frames. The thread transcript polls the
 * durable log, which therefore shows a step's prose only once the step
 * settles. This mirror keeps the in-flight prefix in memory so the poll can
 * carry it alongside the events.
 *
 * The prefix is transient by construction: it is dropped at the frame that
 * ends the attempt, because the loop appends the durable settlement BEFORE
 * that end frame — the very next poll reads the same text from the log.
 */
import type { Context } from './context-types.ts'
import type { SidechatLiveStep } from './sidechat-core.ts'

/** Cap on one buffered in-flight prefix (a runaway step cannot grow the
 *  host's memory without bound; the durable settlement carries the whole
 *  text regardless, so the cap only bounds the live preview). */
const LIVE_PREFIX_CAP = 64_000

/** The live-prefix reader the Side Chat routes consult per poll. */
export interface SidechatStreamMirror {
  /** The in-flight step of one session, or undefined when nothing streams. */
  step(sessionId: string): SidechatLiveStep | undefined
}

/** One buffered attempt: its identity plus the prefix delivered so far. */
interface LiveAttempt extends SidechatLiveStep {
  /** The publishing attempt; a later attempt of the same step replaces it. */
  attemptId: string
  /**
   * Highest frame revision applied. The host allocates `revision` per FRAME
   * (monotone within one attached agent lifecycle), not per attempt — so it
   * orders frames and identifies stale ones; it never identifies the attempt.
   */
  revision: number
}

/** The text of one live frame chunk, by delta kind. */
function deltaOf(chunk: unknown): { kind: 'text' | 'reasoning'; text: string } | undefined {
  if (chunk === null || typeof chunk !== 'object') return undefined
  const { type, text } = chunk as { type?: unknown; text?: unknown }
  if (typeof text !== 'string' || text === '') return undefined
  if (type === 'text-delta') return { kind: 'text', text }
  if (type === 'reasoning-delta') return { kind: 'reasoning', text }
  return undefined
}

/**
 * Mirror every attached agent's in-flight assistant prefix.
 * @param ctx - host plugin context (a double without `on` degrades to a
 *   mirror that never reports a live step — the transcript then waits for
 *   the durable settlement, its behavior before the live channel existed).
 * @returns the per-session reader the `sidechat.events` route consults.
 */
export function createAssistantStreamMirror(ctx: Context): SidechatStreamMirror {
  const perSession = new Map<string, LiveAttempt>()
  if (typeof ctx.on !== 'function') return { step: () => undefined }
  const dispose = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = (agent as { session?: { id?: unknown } } | null)?.session?.id
    if (typeof sessionId !== 'string') return
    if (frame.type === 'start') {
      perSession.set(sessionId, {
        turn: frame.turn,
        step: frame.step,
        text: '',
        reasoning: '',
        attemptId: frame.attemptId,
        revision: frame.revision,
      })
      return
    }
    const live = perSession.get(sessionId)
    // A frame of a superseded attempt (its replacement already published a
    // start) must not append to the current prefix, and a frame older than
    // one already applied is a stale duplicate.
    if (live === undefined || live.attemptId !== frame.attemptId || frame.revision <= live.revision) return
    live.revision = frame.revision
    if (frame.type === 'end') {
      // The durable `assistant/message` / `assistant/attempt` is already
      // appended (an abandoned attempt has nothing to show), so the prefix
      // has no reader left.
      perSession.delete(sessionId)
      return
    }
    const delta = deltaOf(frame.chunk)
    if (delta === undefined) return
    if (delta.kind === 'text') live.text = (live.text + delta.text).slice(-LIVE_PREFIX_CAP)
    else live.reasoning = (live.reasoning + delta.text).slice(-LIVE_PREFIX_CAP)
  })
  ctx.effect(() => dispose, 'dsh-better-sidebar: side-chat assistant-stream mirror')
  return {
    step(sessionId) {
      const live = perSession.get(sessionId)
      if (live === undefined || (live.text === '' && live.reasoning === '')) return undefined
      return { turn: live.turn, step: live.step, text: live.text, reasoning: live.reasoning }
    },
  }
}
