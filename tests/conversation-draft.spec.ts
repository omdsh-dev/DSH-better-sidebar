import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { sendToConversation } from '../src/client/conversation-draft.ts'

describe('sendToConversation', () => {
  it('resolves the conversation service from the target session scope', async () => {
    const send = vi.fn(async () => {})
    const actx = { get: vi.fn(() => ({ send })) }
    const ctx = { sessions: { scope: vi.fn(() => actx) } } as unknown as Context

    await sendToConversation(ctx, 'session-1', 'review prompt')

    expect(ctx.sessions.scope).toHaveBeenCalledWith('session-1')
    expect(actx.get).toHaveBeenCalledWith('conversation')
    expect(send).toHaveBeenCalledWith('review prompt')
  })

  it('rejects when the session or service is unavailable', async () => {
    const noSession = { sessions: { scope: () => undefined } } as unknown as Context
    await expect(sendToConversation(noSession, 'missing', 'x')).rejects.toThrow(/session is unavailable/)

    const noService = {
      sessions: { scope: () => ({ get: () => undefined }) },
    } as unknown as Context
    await expect(sendToConversation(noService, 'session-1', 'x')).rejects.toThrow(/service is unavailable/)
  })
})
