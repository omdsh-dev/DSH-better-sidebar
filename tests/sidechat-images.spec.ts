/** Side Chat admits bounded image batches, preserves message identity, and reads only owned occurrences from live or cold queues. */
import { describe, expect, it, vi } from 'vitest'
import { AttachmentError, isAttachmentError } from '@deepseek-ai/dsh-attachment'
import { buildSidechatApi, readSidechatImage } from '../src/sidechat-routes.ts'
import { coldPendingMessages, pendingInputs } from '../src/sidechat-core.ts'
import { parseSidechatPrompt, sidechatPromptBodyLimit } from '../src/sidechat-image-admission.ts'
import { transcriptRows } from '../src/client/sidechat-transcript.ts'
import { readJsonBody } from '../src/wire.ts'
import type { Context, SidebarHttpRequest } from '../src/context-types.ts'

const limits = { maxImagesPerMessage: 8, maxImageBytes: 10 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024, mediaTypes: ['image/png'] as const, maxImagePixels: 100, maxImageDimension: 10 }
const upload = { mediaType: 'image/png', data: 'YWJj', name: 'shot.png' }
const ref = { attachmentId: 'saved', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png' }
const content = [{ type: 'text', text: 'same' }, { type: 'image', attachment: ref }]
const message = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content })
const ev = (type: string, seq: number, data: Record<string, unknown>) => ({ type, seq, time: seq, data })
const seed = [ev('subagent/descriptor', 0, { provider: 'sidechat', mode: 'continuable', version: 3 }), ev('session/end-seed', 1, { inherited: true })]

function harness(signal?: AbortSignal) {
  const events = [...seed]
  const inbox = { nextStep: [] as ReturnType<typeof message>[], nextTurn: [] as ReturnType<typeof message>[], remove(id: string) { for (const queue of [this.nextStep, this.nextTurn]) { const i = queue.findIndex(item => item.id === id); if (i !== -1) { queue.splice(i, 1); return true } } return false }, clear() { this.nextStep = []; this.nextTurn = [] } }
  const agent = {
    id: 'child', status: 'idle', options: { provider: 'test', model: 'vision' }, ctx: { on: () => () => {} }, inbox,
    session: { header: { origin: 'subagent', parentSession: 'parent' }, inheritedEventCount: 1, snapshotEvents: () => events, append: (type: string, data: Record<string, unknown>) => { events.push(ev(type, events.length, data)) } },
    inject: (value: ReturnType<typeof message>) => { inbox.nextStep.push(value) },
    followup: (value: ReturnType<typeof message>) => { inbox.nextTurn.push(value) },
  }
  let live = true
  const attachments = {
    imageLimits: limits,
    isAttachmentError,
    admitPromptContent: vi.fn(async (parts: { type: string }[]) => parts.map(part => part.type === 'image' ? { type: 'image', attachment: ref } : part)),
    readImage: vi.fn(async () => ({ ref, data: new Uint8Array([97, 98, 99]) })),
  }
  const services = {
    attachments,
    agents: { get: (id: string) => live && id === 'child' ? agent : undefined, resume: vi.fn(async () => { live = true; return { agent, dispose: async () => { live = false } } }) },
    sessionPersistence: { stat: vi.fn(async () => ({ revision: 'r1' })), open: vi.fn(async () => ({ header: agent.session.header, inheritedEventCount: 1, read: async () => ({ events }), close: async () => {} })) },
    llm: { resolveModelInfo: vi.fn(async (_provider: string, _model: string): Promise<{ inputModalities?: string[] }> => ({ inputModalities: ['text', 'image'] })) },
  }
  const ctx = { get: (key: string) => services[key as keyof typeof services] } as unknown as Context
  return { ctx, services, agent, inbox, events, api: buildSidechatApi(ctx, undefined, signal), cold: () => { live = false } }
}

describe('sidechat image admission and owned reads', () => {
  it('admits one whole mixed prompt and reconciles queued and durable images by host identity', async () => {
    const h = harness()
    const result = await h.api['sidechat.prompt']({ childId: 'child', text: 'same', images: [upload] })
    expect(h.inbox.nextTurn[0]).toMatchObject({ id: result.messageId, content, source: { kind: 'user' } })
    expect(h.inbox.nextStep).toHaveLength(1)
    expect(h.services.attachments.admitPromptContent.mock.calls).toEqual([[ [{ type: 'text', text: 'same' }, { type: 'image', ...upload }] ]])
    const queued = await h.api['sidechat.events']({ childId: 'child' })
    expect(queued.pending.find(row => row.id === result.messageId)).toEqual({ id: result.messageId, target: 'next-turn', text: 'same', images: [{ blockIndex: 1, mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png' }] })
    expect(Array.from((await readSidechatImage(h.ctx, 'child', result.messageId, 1)).data)).toEqual([97, 98, 99])
    h.events.push(ev('user/message', 2, h.inbox.nextTurn.shift()!))
    h.cold()
    expect(Array.from((await readSidechatImage(h.ctx, 'child', result.messageId, 1)).data)).toEqual([97, 98, 99])
    expect(h.services.agents.resume.mock.calls).toEqual([])
  })

  it('supports pure images and followups without another pending boundary', async () => {
    const h = harness()
    const first = await h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })
    const second = await h.api['sidechat.prompt']({ childId: 'child', text: 'same', images: [upload] })
    expect(first.messageId).not.toBe(second.messageId)
    expect(h.inbox.nextTurn.map(item => item.content)).toEqual([[{ type: 'image', attachment: ref }], content])
    expect(h.inbox.nextStep).toHaveLength(1)
    const rows = transcriptRows([{ event: ev('user/message', 3, h.inbox.nextTurn[0]!) }])
    expect(rows[0]).toMatchObject({ kind: 'user', text: '', messageId: first.messageId, images: [{ blockIndex: 0 }] })
  })

  it('rejects batch failures before a boundary and retains text compatibility', async () => {
    const h = harness()
    h.services.attachments.admitPromptContent.mockRejectedValueOnce(new Error('bad pixels'))
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toThrow('bad pixels')
    expect(h.inbox).toMatchObject({ nextStep: [], nextTurn: [] })
    const result = await h.api['sidechat.prompt']({ childId: 'child', text: 'legacy' })
    expect(h.inbox.nextTurn[0]).toMatchObject({ id: result.messageId, content: [{ type: 'text', text: 'legacy' }] })
  })

  it('maps an oversized image to 413 too-large and a storage fault to 500', async () => {
    const h = harness()
    h.services.attachments.admitPromptContent.mockRejectedValueOnce(
      new AttachmentError('Image exceeds the configured pixel budget.', 'IMAGE_TOO_MANY_PIXELS'),
    )
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toMatchObject({
      code: 'too-large',
      status: 413,
      message: 'Image exceeds the configured pixel budget.',
    })
    h.services.attachments.admitPromptContent.mockRejectedValueOnce(
      new AttachmentError('attachment store is read-only', 'ATTACHMENT_WRITE_FAILED'),
    )
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toMatchObject({
      code: 'sidechat-error',
      status: 500,
      message: 'attachment store is read-only',
    })
    expect(h.inbox).toMatchObject({ nextStep: [], nextTurn: [] })
  })

  it('rejects explicit text-only models, defers unknown capabilities and reports lookup failure', async () => {
    const h = harness()
    h.services.llm.resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] })
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toThrow('does not accept images')
    h.services.llm.resolveModelInfo.mockRejectedValueOnce(new Error('catalog offline'))
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toThrow('catalog offline')
    h.services.llm.resolveModelInfo.mockResolvedValue({})
    await h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })
    expect(h.inbox.nextTurn[0]?.content).toEqual([{ type: 'image', attachment: ref }])
  })

  it('rechecks the effective model after admission and rejects a disposed send', async () => {
    const h = harness()
    h.services.attachments.admitPromptContent.mockImplementationOnce(async () => {
      h.events.push(ev('model/selection', 2, { provider: 'test', model: 'text-only' }))
      return [{ type: 'image', attachment: ref }]
    })
    h.services.llm.resolveModelInfo.mockImplementation(async (_provider, model) => ({ inputModalities: model === 'text-only' ? ['text'] : ['image'] }))
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toThrow('does not accept images')
    expect(h.inbox.nextTurn).toEqual([])
    h.events.pop()
    h.services.attachments.admitPromptContent.mockImplementationOnce(async () => {
      await h.api['sidechat.dispose']({ childId: 'child' })
      return [{ type: 'image', attachment: ref }]
    })
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toThrow('closed while sending')
    expect(h.inbox.nextStep).toEqual([])
  })

  it('rejects a model change between capability validation and enqueue', async () => {
    const h = harness()
    h.services.llm.resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['image'] })
    h.services.llm.resolveModelInfo.mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => {
        h.events.push(ev('model/selection', 2, { provider: 'test', model: 'text-only' }))
      }))
      return { inputModalities: ['image'] }
    })
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toMatchObject({ status: 409 })
    expect(h.inbox).toMatchObject({ nextStep: [], nextTurn: [] })
  })

  it('refuses inherited, removed, cross-thread and text-block references', async () => {
    const h = harness()
    h.events.unshift(ev('user/message', 0, message('parent-image')))
    h.agent.session.inheritedEventCount = 2
    await expect(readSidechatImage(h.ctx, 'child', 'parent-image', 1)).rejects.toThrow('not in this conversation')
    const result = await h.api['sidechat.prompt']({ childId: 'child', text: 'same', images: [upload] })
    await expect(readSidechatImage(h.ctx, 'child', result.messageId, 0)).rejects.toThrow('not in this conversation')
    await h.api['sidechat.dequeue']({ childId: 'child', messageId: result.messageId })
    await expect(readSidechatImage(h.ctx, 'child', result.messageId, 1)).rejects.toThrow('not in this conversation')
    h.agent.session.header.origin = 'user'
    await expect(readSidechatImage(h.ctx, 'child', result.messageId, 1)).rejects.toThrow('require a side conversation')
    expect(h.services.attachments.readImage.mock.calls).toEqual([])
  })

  it('folds full cold queue indices before removing exact inherited ghosts', () => {
    const log = [
      ev('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, removedCount: 0, inserted: [message('ghost')] }),
      ev('session/end-seed', 1, { inherited: true }),
      ev('agent/inbox/spliced', 2, { target: 'next-turn', start: 1, removedCount: 0, inserted: [message('own1'), message('own2')] }),
      ev('agent/inbox/spliced', 3, { target: 'next-turn', start: 1, removedCount: 1, inserted: [] }),
    ]
    const inbox = coldPendingMessages(log)
    expect(pendingInputs(inbox.nextStep, inbox.nextTurn)).toEqual([{ id: 'own2', target: 'next-turn', text: 'same', images: [{ blockIndex: 1, mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png' }] }])
  })

  it('rejects image delivery after plugin unload without consuming the first boundary', async () => {
    const lifetime = new AbortController()
    const h = harness(lifetime.signal)
    h.services.attachments.admitPromptContent.mockImplementationOnce(async () => {
      lifetime.abort()
      return [{ type: 'image', attachment: ref }]
    })
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: '', images: [upload] })).rejects.toThrow('closed while sending')
    expect(h.inbox).toMatchObject({ nextStep: [], nextTurn: [] })
    await expect(h.api['sidechat.prompt']({ childId: 'child', text: 'later' })).rejects.toMatchObject({ status: 503 })
  })

  it('shares cold ownership snapshots across simultaneous image and transcript reads and refreshes changed storage', async () => {
    const h = harness()
    h.events.push(ev('user/message', 2, message('saved')))
    h.cold()
    await Promise.all([
      ...Array.from({ length: 8 }, () => readSidechatImage(h.ctx, 'child', 'saved', 1)),
      h.api['sidechat.events']({ childId: 'child' }),
      h.api['sidechat.info']({ childId: 'child' }),
    ])
    expect(h.services.sessionPersistence.open).toHaveBeenCalledTimes(1)
    expect(h.services.agents.resume).not.toHaveBeenCalled()
    h.services.sessionPersistence.stat.mockResolvedValue({ revision: 'r2' })
    await readSidechatImage(h.ctx, 'child', 'saved', 1)
    expect(h.services.sessionPersistence.open).toHaveBeenCalledTimes(2)
  })

  it('reads a queued image when its message is claimed during ownership validation', async () => {
    const h = harness()
    h.inbox.nextTurn.push(message('claiming'))
    vi.spyOn(h.agent.session, 'snapshotEvents').mockImplementationOnce(() => {
      queueMicrotask(() => {
        h.events.push(ev('user/message', 2, h.inbox.nextTurn.shift()!))
      })
      return [...h.events]
    })
    await expect(readSidechatImage(h.ctx, 'child', 'claiming', 1)).resolves.toMatchObject({ ref })
  })

  it('keeps valid text when legacy image blocks are malformed', () => {
    const rows = transcriptRows([{ event: ev('user/message', 2, {
      id: 'broken', source: { kind: 'user' }, content: [{ type: 'text', text: 'keep' }, { type: 'image', attachment: null }, { type: 'image', attachment: { mediaType: 'image/png' } }],
    }) }])
    expect(rows).toEqual([{ kind: 'user', seq: 2, text: 'keep', messageId: 'broken' }])
  })

  it('enforces source, aggregate and metadata bounds without allowing stored reference admission', async () => {
    expect(parseSidechatPrompt({ childId: 'child', text: 'legacy' }, undefined).content).toEqual([{ type: 'text', text: 'legacy' }])
    expect(() => parseSidechatPrompt({ childId: 'child', text: '', images: [{ attachment: ref }] }, limits)).toThrow('encoded bytes')
    expect(() => parseSidechatPrompt({ childId: 'child', text: '', images: [upload, upload] }, { ...limits, maxMessageImageBytes: 5 })).toThrow('byte limit')
    expect(() => parseSidechatPrompt({ childId: 'child', text: 'x'.repeat(1024 * 1024), images: [upload] }, limits)).toThrow('metadata')
    const h = harness()
    const body = JSON.stringify({ childId: 'child', text: '', images: [{ ...upload, data: 'YWJj'.repeat(300_000) }] })
    const request = (): SidebarHttpRequest => ({ headers: {}, async *[Symbol.asyncIterator]() { yield body } })
    await expect(readJsonBody(request())).rejects.toMatchObject({ status: 413 })
    expect(await readJsonBody(request(), sidechatPromptBodyLimit(h.ctx))).toMatchObject({ childId: 'child', text: '' })
  })
})
