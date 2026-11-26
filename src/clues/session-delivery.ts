/** Direct user operations use host admission; they never read or submit composer drafts. */
import type { Context } from '../context-types.ts'
import { ClueError } from './error.ts'

export interface ClueSessionOperation {
  readonly sessionId: string
  readonly target: 'main' | 'side'
  readonly prompt: string
  readonly requestId: string
  readonly signal?: AbortSignal
}
interface SessionPromptFace {
  prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: readonly { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<{ accepted: true }>
}
export interface ClueSessionReceipt { readonly sessionId: string; readonly accepted: true }

/** The host explicitly rejected admission before sending; this intent can be retried. */
export class ClueWriterHeldError extends ClueError {
  constructor(meta?: Record<string, string>) {
    super('conflict', 'The conversation is in use by another DSH instance.', meta)
  }
}

/** The side start callback is the already mounted sidechat.start handler. */
export function createClueSessionDelivery(ctx: Context, startSide: (payload: { sessionId: string; question: string }) => Promise<{ childId: string }>) {
  const deliveries = new Map<string, { prompt: string; pending: boolean; result: Promise<ClueSessionReceipt> }>()
  return async (operation: ClueSessionOperation): Promise<ClueSessionReceipt> => {
    const { sessionId, target, requestId, prompt, signal } = operation
    if (signal?.aborted) throw new ClueError('cancelled', 'the operation was cancelled before admission')
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || !['main', 'side'].includes(target)
      || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(requestId)
      || typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > 256_000) {
      throw new ClueError('invalid-request', 'the session operation is invalid')
    }
    const key = `${sessionId}\u0000${target}\u0000${requestId}`
    const existing = deliveries.get(key)
    if (existing !== undefined) {
      if (existing.prompt !== prompt) throw new ClueError('conflict', 'the operation identity was already used with a different prompt')
      return existing.result
    }
    if (deliveries.size >= 128) {
      const oldest = [...deliveries].find(([, value]) => !value.pending)?.[0]
      if (oldest === undefined) throw new ClueError('rate-limited', 'too many session operations are pending')
      deliveries.delete(oldest)
    }
    const entry = { prompt, pending: true, result: Promise.resolve().then(async (): Promise<ClueSessionReceipt> => {
      if (signal?.aborted) throw new ClueError('cancelled', 'the operation was cancelled before admission')
      try {
        if (target === 'side') {
          const receipt = await startSide({ sessionId, question: prompt })
          return { sessionId: receipt.childId, accepted: true }
        }
        const controller = ctx.get('sessionController') as SessionPromptFace | undefined
        if (controller?.prompt === undefined) throw new ClueError('unsupported', 'main conversation admission is unavailable')
        const receipt = await controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, signal ?? new AbortController().signal)
        if (receipt.accepted !== true) throw new ClueError('failed', 'the conversation did not accept the operation')
        return { sessionId, accepted: true }
      } catch (error) {
        if (error instanceof ClueError) throw error
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ClueError('cancelled', 'the operation was cancelled')
        const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
        if (code === 'session/not-found') throw new ClueError('not-found', 'the target conversation is unavailable')
        if (code === 'session/writer-held') {
          deliveries.delete(key)
          throw new ClueWriterHeldError()
        }
        if (code === 'session/agent-busy') throw new ClueError('conflict', 'the target conversation could not admit the operation')
        throw new ClueError('failed', 'the conversation operation could not be admitted')
      }
    }).finally(() => { entry.pending = false }) }
    deliveries.set(key, entry)
    return entry.result
  }
}
