/** Direct selection operations queue via the host, independently of composer draft state. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { createClueSessionDelivery } from '../src/clues/session-delivery.ts'
const operation = { sessionId: 'session-main', target: 'main' as const, requestId: 'op-one', prompt: 'Explain the selected passage' }
describe('clue session admission', () => {
  it('uses the cold/live host queue seam without touching the input service or resuming an agent itself', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }))
    const get = vi.fn((key: string) => key === 'sessionController' ? { prompt } : undefined)
    const send = createClueSessionDelivery({ get } as unknown as Context, vi.fn())
    expect(await send(operation)).toEqual({ sessionId: 'session-main', accepted: true })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'op-one', sessionId: 'session-main', mode: 'queue', content: [{ type: 'text', text: operation.prompt }] }), expect.any(AbortSignal))
    expect(get.mock.calls.map(([key]) => key)).toEqual(['sessionController'])
  })
  it('deduplicates a repeated side operation rather than creating two children', async () => {
    const start = vi.fn(async () => ({ childId: 'child' }))
    const send = createClueSessionDelivery({} as Context, start)
    const request = { ...operation, target: 'side' as const }
    expect(await Promise.all([send(request), send(request)])).toEqual([{ sessionId: 'child', accepted: true }, { sessionId: 'child', accepted: true }])
    expect(start).toHaveBeenCalledTimes(1)
    await expect(send({ ...request, prompt: 'different' })).rejects.toMatchObject({ category: 'conflict' })
  })
  it('fails explicitly if host admission is missing and never silently switches destination', async () => {
    const start = vi.fn()
    const send = createClueSessionDelivery({ get: () => undefined } as unknown as Context, start)
    await expect(send(operation)).rejects.toMatchObject({ category: 'unsupported' })
    expect(start).not.toHaveBeenCalled()
  })
  it('maps host errors without leaking raw diagnostics or automatically retrying', async () => {
    const prompt = vi.fn(async () => { throw { code: 'session/writer-held', message: 'private source data' } })
    const send = createClueSessionDelivery({ get: () => ({ prompt }) } as unknown as Context, vi.fn())
    await expect(send(operation)).rejects.toMatchObject({ category: 'conflict' })
    await expect(send(operation)).rejects.not.toHaveProperty('message', 'private source data')
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('cancelled operations are not sent to either target', async () => {
    const get = vi.fn(), start = vi.fn()
    const send = createClueSessionDelivery({ get } as unknown as Context, start)
    await expect(send({ ...operation, signal: AbortSignal.abort() })).rejects.toMatchObject({ category: 'cancelled' })
    expect(get).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
  })
})
