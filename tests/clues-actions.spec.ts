/** A refused admission can be retried without preparing or delivering an accepted intent twice. */
import { describe, expect, it, vi } from 'vitest'
import { createClueActionStartHandler } from '../src/clues/actions.ts'
import { createClueSessionDelivery } from '../src/clues/session-delivery.ts'
import type { ClueDraftManager } from '../src/clues/drafts.ts'
import type { Context } from '../src/context-types.ts'

const request = { workspaceId: 'ws', sessionId: 'session', resource: { clueId: 'clue' }, target: 'main', action: 'rewrite', requestId: 'intent', selection: 'chosen line' }

function fixture(prompt: ReturnType<typeof vi.fn>) {
  const ctx = { get: () => ({ prompt }) } as unknown as Context
  const send = createClueSessionDelivery(ctx, vi.fn())
  const prepare = vi.fn<ClueDraftManager['prepare']>().mockResolvedValue({ draftId: 'draft', status: 'prepared', bodyPath: '/draft.md', format: 'text/markdown', createdAt: '2026-01-01T00:00:00Z' })
  const handler = createClueActionStartHandler({
    drafts: { prepare, commit: vi.fn(), discard: vi.fn(), list: vi.fn() },
    getCommitUrl: () => 'http://127.0.0.1:12345/sidebar/agent/clues/commit',
    deliver: async operation => ({ deliveryId: (await send(operation)).sessionId }),
  })
  return { start: () => handler(request, { caller: 'ui' }), prepare }
}

describe('selection action admission', () => {
  it('retries a writer refusal with the same request and draft, then reuses the receipt', async () => {
    const prompt = vi.fn().mockRejectedValueOnce({ code: 'session/writer-held' }).mockResolvedValue({ accepted: true })
    const { start, prepare } = fixture(prompt)
    await expect(start()).rejects.toMatchObject({ category: 'conflict', meta: { draftId: 'draft' } })
    const [receipt, joined] = await Promise.all([start(), start()])
    expect(joined).toEqual(receipt)
    await expect(start()).resolves.toEqual(receipt)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls[1]?.[0]).toEqual(prompt.mock.calls[0]?.[0])
  })

  it('does not retry an admission whose outcome is uncertain', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error('connection interrupted'))
    const { start, prepare } = fixture(prompt)
    await expect(start()).rejects.toMatchObject({ category: 'failed' })
    await expect(start()).rejects.toMatchObject({ category: 'failed' })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})
