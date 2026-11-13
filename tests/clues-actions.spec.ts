/** Action-start is a dependency-injected delivery seam, never the existing composer draft. */
import { describe, expect, it, vi } from 'vitest'
import { createClueActionStartHandler, type ClueActionDelivery } from '../src/clues/actions.ts'
const payload = { workspaceId: 'w', sessionId: 's', resource: { clueId: 'clue-1' }, action: 'rewrite', target: 'main', requestId: 'request-one', selection: 'A selected passage' }
const draft = { draftId: 'a'.repeat(48), bodyPath: '/data/clue-drafts/body.md', status: 'prepared' as const, format: 'text/markdown', createdAt: '2026-10-24T00:00:00Z' }
function fixture() {
  const drafts = { prepare: vi.fn(async () => draft), commit: vi.fn(), discard: vi.fn(), list: vi.fn() }
  const deliver = vi.fn<(input: ClueActionDelivery) => Promise<{ deliveryId: string }>>(async () => ({ deliveryId: 'message-1' }))
  return { drafts, deliver, handler: createClueActionStartHandler({ drafts, deliver, getCommitUrl: () => 'http://127.0.0.1:1234/sidebar/agent/clues/commit' }) }
}
describe('resource actions', () => {
  it('reuses the entire operation on retry and rejects identity reuse for another target', async () => {
    const { handler, drafts, deliver } = fixture()
    const [first, second] = await Promise.all([handler(payload, { caller: 'ui' }), handler(payload, { caller: 'ui' })])
    expect(first).toEqual(second)
    expect(drafts.prepare).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledOnce()
    await expect(handler({ ...payload, target: 'side' }, { caller: 'ui' })).rejects.toMatchObject({ category: 'conflict' })
  })
  it('supports continuing a passage in an explicit side conversation', async () => {
    const { handler, deliver } = fixture()
    const result = await handler({ ...payload, action: 'continue', target: 'side' }, { caller: 'ui' })
    expect(result).toMatchObject({ action: 'continue', target: 'side' })
    expect(deliver.mock.calls[0]![0]).toMatchObject({ target: 'side', requestId: 'request-one' })
    expect(deliver.mock.calls[0]![0].prompt).toContain('Continue writing after')
  })
  it('prepares a whole-body draft and delivers its packaged skill without consuming a composer', async () => {
    const { handler, drafts, deliver } = fixture()
    const result = await handler(payload, { caller: 'ui' })
    expect(drafts.prepare).toHaveBeenCalledWith({ workspaceId: 'w', sessionId: 's', clueId: 'clue-1' }, { caller: 'ui', signal: undefined, sessionId: 's' })
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's', workspaceId: 'w', action: 'rewrite', draft })
    expect(deliver.mock.calls[0]![0].prompt).toContain('SKILL.md')
    expect(deliver.mock.calls[0]![0].prompt).toContain(draft.bodyPath)
    expect(deliver.mock.calls[0]![0].prompt).toContain(draft.draftId)
    expect(result).toMatchObject({ action: 'rewrite', draft, deliveryId: 'message-1' })
  })
  it('explanation is strictly read-only and comment selections cannot request writes', async () => {
    const { handler, drafts, deliver } = fixture()
    await handler({ ...payload, action: 'explain', comment: true }, { caller: 'ui' })
    expect(drafts.prepare).not.toHaveBeenCalled()
    expect(deliver.mock.calls[0]![0].prompt).toContain('Do not edit')
    expect(deliver.mock.calls[0]![0].prompt).not.toContain('/clues/commit')
    await expect(handler({ ...payload, comment: true }, { caller: 'ui' })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(deliver).toHaveBeenCalledOnce()
  })
  it('rejects non-user starts, mismatched resource scope and oversized selections', async () => {
    const { handler, drafts } = fixture()
    for (const caller of ['agent', 'agent-edit'] as const) await expect(handler(payload, { caller })).rejects.toMatchObject({ category: 'permission-denied' })
    await expect(handler({ ...payload, resource: { clueId: 'x', sessionId: 'different' } }, { caller: 'ui' })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(handler({ ...payload, selection: 'x'.repeat(32769) }, { caller: 'ui' })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(drafts.prepare).not.toHaveBeenCalled()
  })
})
