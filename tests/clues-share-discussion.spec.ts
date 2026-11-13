/** UI19 public share seam: v2 snapshots retain complete document discussions. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCluesService } from '../src/clues/service.ts'
import { exportPack } from '../src/clues/share/export.ts'
import { readZip } from '../src/clues/share/zip.ts'
import { ClueError, type ClueDiscussionPage, type ClueOperationContext } from '../src/clues/types.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-24T00:00:00.000Z'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTree(root) })
const page = (overrides: Partial<ClueDiscussionPage> = {}): ClueDiscussionPage => ({
  status: 'ok', items: [], fetchedAt: NOW, complete: true, coverage: 'document', ...overrides,
})

async function fixture(commentsRead = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-share-discussion-'))
  roots.push(root)
  let id = 0
  const clues = createCluesService({ root, now: () => NOW, newId: kind => `${kind}-${++id}` })
  clues.registerSource({
    descriptor: {
      sourceId: 'test.discussion', name: 'Discussion', order: 0, pluginId: 'test', types: ['test.discussion.text'], transport: 'http',
      capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: true, comments: { read: commentsRead, create: false, reply: 'none' } },
    },
    types: [{ sourceId: 'test.discussion', typeId: 'test.discussion.text', formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations: { portable: async () => ({ portable: true, locator: { id: 'doc' } }) },
  })
  const ensured = await clues.ensure({ workspaceId: 'ws', sourceId: 'test.discussion', typeId: 'test.discussion.text', locator: { id: 'doc' }, title: 'Document' })
  return { clues, clueId: ensured.clue.id }
}

function discussionOf(bytes: Uint8Array): ClueDiscussionPage {
  const entries = readZip(bytes)
  const manifest = JSON.parse(new TextDecoder().decode(entries.find(e => e.name === 'manifest.json')!.data))
  const descriptor = manifest.clues[0].snapshot.discussion
  expect(descriptor).toBeDefined()
  return JSON.parse(new TextDecoder().decode(entries.find(e => e.name === descriptor.path)!.data)) as ClueDiscussionPage
}

describe('v2 discussion snapshots', () => {
  it('captures remaining comments and replies once without rereading the body', async () => {
    const { clues, clueId } = await fixture()
    const first = page({ items: [{ id: 'c1', kind: 'comment', body: 'First', format: 'text/plain', replyCount: 1, nextRepliesCursor: 'r1' }], nextCursor: 'c2', complete: false })
    const read = vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', text: 'Body', fetchedAt: NOW, discussion: first })
    const commentsList = vi.fn(async (input: { cursor?: string; parentId?: string }) => input.parentId === 'c1'
      ? page({ items: [{ id: 'r1', kind: 'reply', body: 'Reply', format: 'text/markdown', replyToId: 'c1' }] })
      : page({ items: [{ id: 'review1', kind: 'review', body: 'Approved', format: 'text/plain', reviewState: 'APPROVED' }] }))
    Object.assign(clues, { commentsList })
    const result = await exportPack({ clues, now: () => NOW }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(result.manifest.formatVersion).toBe(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(commentsList).toHaveBeenCalledTimes(2)
    expect(commentsList.mock.calls.map(([input]) => input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ cursor: 'c2' }), expect.objectContaining({ cursor: 'r1', parentId: 'c1' }),
    ]))
    const captured = discussionOf(result.bytes)
    expect(captured.complete).toBe(true)
    expect(captured.items.map(item => item.id)).toEqual(['c1', 'review1', 'r1'])
    expect(result.complete).toBe(true)
  })

  it('completes nested reply continuations before claiming a complete snapshot', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: [{ id: 'c1', kind: 'comment', body: 'Parent', format: 'text/plain', replyCount: 1, nextRepliesCursor: 'replies' }], complete: false }),
    })
    const commentsList = vi.fn(async (input: { parentId?: string }) => input.parentId === 'c1'
      ? page({ items: [{ id: 'r1', kind: 'reply', body: 'Reply', format: 'text/plain', replyToId: 'c1', replyCount: 1, nextRepliesCursor: 'nested' }], complete: false })
      : page({ items: [{ id: 'r2', kind: 'reply', body: 'Nested', format: 'text/plain', replyToId: 'r1' }] }))
    Object.assign(clues, { commentsList })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(commentsList).toHaveBeenCalledTimes(2)
    expect(discussionOf(result.bytes)).toMatchObject({ complete: true, items: [{ id: 'c1' }, { id: 'r1' }, { id: 'r2' }] })
    expect(result.complete).toBe(true)
  })

  it('keeps the body and already captured comments when later pages fail safely', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: [{ id: 'c1', kind: 'comment', body: 'First', format: 'text/plain' }], nextCursor: 'next', complete: false }),
    })
    Object.assign(clues, { commentsList: vi.fn().mockRejectedValue(new ClueError('permission-denied', 'SECRET_PROVIDER_MESSAGE')) })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(false)
    expect(result.manifest.clues[0]!.snapshot).toBeDefined()
    expect(discussionOf(result.bytes)).toMatchObject({ status: 'unavailable', complete: false, items: [{ id: 'c1' }], error: { category: 'permission-denied' } })
    expect(JSON.stringify(result.manifest)).not.toContain('SECRET_PROVIDER_MESSAGE')
    expect(readZip(result.bytes).map(entry => new TextDecoder().decode(entry.data)).join('')).not.toContain('SECRET_PROVIDER_MESSAGE')
  })

  it('does not treat an unsupported continuation as an empty complete discussion', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW })
    const commentsList = vi.fn().mockResolvedValue(page({ status: 'unavailable', complete: false, error: { category: 'auth-required', message: 'SOURCE_SECRET' } }))
    Object.assign(clues, { commentsList })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(false)
    expect(discussionOf(result.bytes)).toMatchObject({ status: 'unavailable', complete: false, items: [], error: { category: 'auth-required' } })
    expect(result.issues).toEqual([expect.objectContaining({ category: 'auth-required' })])
  })

  it('caps aggregate comment pages and marks the captured subset incomplete', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: [{ id: 'c1', kind: 'comment', body: 'First', format: 'text/plain' }], nextCursor: 'next', complete: false }),
    })
    const commentsList = vi.fn()
    Object.assign(clues, { commentsList })
    const result = await exportPack({ clues, maxDiscussionPages: 1 }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(commentsList).not.toHaveBeenCalled()
    expect(result.complete).toBe(false)
    expect(discussionOf(result.bytes)).toMatchObject({ complete: false, items: [{ id: 'c1' }], nextCursor: 'next', error: { category: 'unsupported' } })
  })

  it('refuses unreadable discussion capability without starting a comments request', async () => {
    const { clues, clueId } = await fixture(false)
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW })
    const commentsList = vi.fn()
    Object.assign(clues, { commentsList })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(commentsList).not.toHaveBeenCalled()
    expect(result.complete).toBe(false)
    expect(discussionOf(result.bytes)).toMatchObject({ complete: false, status: 'unavailable', error: { category: 'permission-denied' } })
  })

  it('bounds comment counts and bytes while retaining the body snapshot', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: [{ id: 'c1', kind: 'comment', body: 'First', format: 'text/plain' }, { id: 'c2', kind: 'comment', body: 'Second', format: 'text/plain' }] }),
    })
    const counted = await exportPack({ clues, maxDiscussionItems: 1 }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(counted.complete).toBe(false)
    expect(discussionOf(counted.bytes)).toMatchObject({ complete: false, items: [{ id: 'c1' }], error: { category: 'unsupported' } })
    const sized = await exportPack({ clues, maxDiscussionBytes: 300 }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(sized.manifest.clues[0]!.snapshot).toBeDefined()
    expect(sized.complete).toBe(false)
    expect(discussionOf(sized.bytes)).toMatchObject({ complete: false, error: { category: 'unsupported' } })
    expect(sized.manifest.clues[0]!.snapshot!.discussion!.bytes).toBeLessThanOrEqual(300)
  })

  it('stops a provider cursor cycle and labels the archived subset incomplete', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW, discussion: page({ complete: false, nextCursor: 'loop' }) })
    const commentsList = vi.fn().mockResolvedValue(page({ complete: false, nextCursor: 'loop' }))
    Object.assign(clues, { commentsList })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(commentsList).toHaveBeenCalledTimes(1)
    expect(result.complete).toBe(false)
    expect(discussionOf(result.bytes)).toMatchObject({ complete: false, error: { category: 'failed' } })
  })

  it('marks an offline re-export incomplete when its stored discussion is incomplete', async () => {
    const { clues } = await fixture()
    const unresolved = await clues.importUnresolved({ workspaceId: 'ws', sourceId: 'missing.source', typeId: 'missing.text', locator: {}, title: 'Offline', reason: 'source missing' })
    const meta = { snapshotId: 'snapshot-offline', clueId: unresolved.clue.id, workspaceId: 'ws', format: 'text/plain', fetchedAt: NOW, createdAt: NOW }
    vi.spyOn(clues, 'listSnapshots').mockResolvedValue([meta])
    vi.spyOn(clues, 'readSnapshot').mockResolvedValue({ meta, content: { format: 'text/plain', data: 'Offline body', discussion: page({ complete: false, status: 'unavailable', error: { category: 'auth-required', message: 'OLD_SECRET' } }) } })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [unresolved.clue.id] })
    expect(discussionOf(result.bytes)).toMatchObject({ complete: false, status: 'unavailable' })
    expect(result.complete).toBe(false)
    expect(result.issues).toEqual([expect.objectContaining({ category: 'auth-required' })])
    expect(JSON.stringify(result.manifest)).not.toContain('OLD_SECRET')
  })

  it('preserves legacy not-captured discussion without inventing an export failure', async () => {
    const { clues } = await fixture()
    const unresolved = await clues.importUnresolved({ workspaceId: 'ws', sourceId: 'missing.source', typeId: 'missing.text', locator: {}, title: 'Legacy', reason: 'source missing' })
    const meta = { snapshotId: 'legacy', clueId: unresolved.clue.id, workspaceId: 'ws', format: 'text/plain', fetchedAt: NOW, createdAt: NOW }
    vi.spyOn(clues, 'listSnapshots').mockResolvedValue([meta])
    vi.spyOn(clues, 'readSnapshot').mockResolvedValue({ meta, content: { format: 'text/plain', data: 'Body', discussion: page({ status: 'not-captured', complete: false }) } })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [unresolved.clue.id] })
    expect(discussionOf(result.bytes)).toMatchObject({ status: 'not-captured', complete: false, items: [] })
    expect(result.issues).toEqual([])
    expect(result.complete).toBe(true)
  })

  it('preserves the requested parent relationship when a native reply omits replyToId', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: [{ id: 'c1', kind: 'comment', body: 'Parent', format: 'text/plain', replyCount: 1, nextRepliesCursor: 'replies' }], complete: false }),
    })
    Object.assign(clues, { commentsList: vi.fn().mockResolvedValue(page({ items: [{ id: 'r1', kind: 'reply', body: 'Reply', format: 'text/plain' }] })) })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(discussionOf(result.bytes)).toMatchObject({ complete: true, items: [{ id: 'c1' }, { id: 'r1', replyToId: 'c1' }] })
    expect(result.complete).toBe(true)
  })

  it('releases consumed reply cursor bytes before collecting another thread', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: ['c1', 'c2'].map(id => ({ id, kind: 'comment' as const, body: 'Parent', format: 'text/plain' as const, replyCount: 1, nextRepliesCursor: 'x'.repeat(300) })), complete: false }),
    })
    Object.assign(clues, { commentsList: vi.fn(async (input: { parentId: string }) => page({ items: [{ id: `r${input.parentId}`, kind: 'reply', body: 'Reply', format: 'text/plain', replyToId: input.parentId }] })) })
    const result = await exportPack({ clues, maxDiscussionBytes: 1150 }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(discussionOf(result.bytes)).toMatchObject({ complete: true, items: [{ id: 'c1' }, { id: 'c2' }, { id: 'rc1' }, { id: 'rc2' }] })
    expect(result.complete).toBe(true)
  })

  it('uses a total first reported by a continuation to detect missing comments', async () => {
    const { clues, clueId } = await fixture()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: [{ id: 'c1', kind: 'comment', body: 'One', format: 'text/plain' }], complete: false, nextCursor: 'next' }),
    })
    Object.assign(clues, { commentsList: vi.fn().mockResolvedValue(page({ total: 3, items: [{ id: 'c2', kind: 'comment', body: 'Two', format: 'text/plain' }] })) })
    const result = await exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId] })
    expect(discussionOf(result.bytes)).toMatchObject({ total: 3, complete: false })
    expect(result.complete).toBe(false)
  })

  it('forwards cancellation to comments.list and returns no archive on abort', async () => {
    const { clues, clueId } = await fixture()
    const controller = new AbortController()
    vi.spyOn(clues, 'read').mockResolvedValue({ format: 'text/plain', data: 'Body', fetchedAt: NOW,
      discussion: page({ items: [], nextCursor: 'next', complete: false }),
    })
    const commentsList = vi.fn(async (_input: unknown, context: ClueOperationContext) => {
      expect(context.signal).toBe(controller.signal)
      expect(context.caller).toBe('ui')
      controller.abort()
      return page()
    })
    Object.assign(clues, { commentsList })
    await expect(exportPack({ clues }, { workspaceId: 'ws', mode: 'snapshot', clueIds: [clueId], signal: controller.signal })).rejects.toMatchObject({ category: 'cancelled' })
    expect(commentsList).toHaveBeenCalledTimes(1)
  })
})
