/** UI19 discussion belongs to a resource; independent paging never rereads its body. */
import { describe, expect, it, vi } from 'vitest'
import { createCluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { ClueError, type ClueDiscussionPage } from '../src/clues/types.ts'
import { registerCluesApi } from '../src/clues/api.ts'

const page: ClueDiscussionPage = { status: 'ok', items: [{ id: 'c1', kind: 'comment', body: 'important', format: 'text/markdown' }], fetchedAt: '2026-10-24T00:00:00.000Z', complete: true, coverage: 'document' }
function setup() {
  const body = vi.fn(async () => ({ format: 'text/plain', data: 'body', fetchedAt: page.fetchedAt }))
  const comments = vi.fn(async (_input: { cursor?: string; limit?: number }) => page)
  const create = vi.fn(async () => ({ comment: page.items[0]!, savedAt: page.fetchedAt }))
  const source: ClueSourceRegistration = {
    descriptor: { sourceId: 'test.discussion', name: 'Discussion', order: 1, pluginId: 'test', types: ['test.discussion.text'], transport: 'http', capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false, comments: { read: true, create: true, reply: 'native' } } },
    types: [{ sourceId: 'test.discussion', typeId: 'test.discussion.text', formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations: { read: body, listComments: comments, createComment: create },
  }
  const service = createCluesService()
  service.registerSource(source)
  const params = { workspaceId: 'ws', sourceId: 'test.discussion', typeId: 'test.discussion.text', locator: { id: 'one' } }
  return { service, body, comments, create, params }
}
describe('resource discussion service', () => {
  it('includes the first discussion page on default resource read', async () => {
    const { service, params, comments } = setup()
    expect((await service.read(params)).discussion).toEqual(page)
    expect(comments).toHaveBeenCalledTimes(1)
  })
  it('does not refetch the initial discussion while paging the body', async () => {
    const { service, params, comments } = setup()
    await service.read(params)
    await service.read({ ...params, offset: 100 })
    expect(comments).toHaveBeenCalledTimes(1)
    await service.read({ ...params, offset: 200, includeDiscussion: true })
    expect(comments).toHaveBeenCalledTimes(2)
  })
  it('can read the body first then page discussion without reading the body again', async () => {
    const { service, params, body, comments } = setup()
    expect((await service.read({ ...params, includeDiscussion: false })).discussion).toBeUndefined()
    expect(comments).not.toHaveBeenCalled()
    await service.commentsList({ ...params, cursor: 'next', limit: 30 })
    expect(body).toHaveBeenCalledTimes(1)
    expect(comments.mock.calls[0]?.[0]).toMatchObject({ cursor: 'next', limit: 30 })
  })
  it('preserves body and reports inaccessible discussion rather than pretending it is empty', async () => {
    const { service, params, comments } = setup()
    comments.mockRejectedValueOnce(new ClueError('permission-denied', 'safe denial'))
    expect(await service.read(params)).toMatchObject({ data: 'body', discussion: { status: 'unavailable', complete: false, error: { category: 'permission-denied' } } })
  })
  it('deduplicates double submit and rejects reuse with a different body', async () => {
    const { service, params, create } = setup()
    const request = { ...params, body: 'hello', requestId: 'submit-1' }
    const [a, b] = await Promise.all([service.commentsCreate(request), service.commentsCreate(request)])
    expect(a).toEqual(b)
    expect(create).toHaveBeenCalledTimes(1)
    await expect(service.commentsCreate({ ...request, body: 'other' })).rejects.toMatchObject({ category: 'conflict' })
  })
  it('keeps ordinary agent calls read-only and validates input before provider writes', async () => {
    const { service, params, create } = setup()
    for (const caller of ['agent', 'agent-edit'] as const) await expect(service.commentsCreate({ ...params, body: 'hello', requestId: 'one' }, { caller })).rejects.toMatchObject({ category: 'permission-denied' })
    await expect(service.commentsCreate({ ...params, body: ' ', requestId: 'two' })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(create).not.toHaveBeenCalled()
  })
  it('routes typed comments and validates body/read controls through the wire handlers', async () => {
    const { service, params, comments, create } = setup()
    registerCluesApi(service)
    expect(await service.invokeApi('clues.read', { ...params, includeDiscussion: false })).not.toHaveProperty('discussion')
    await expect(service.invokeApi('clues.read', { ...params, includeDiscussion: 'false' })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(await service.invokeApi('clues.comments.list', { ...params, cursor: 'more', parentId: 'root', limit: 5 })).toEqual(page)
    expect(comments.mock.calls[0]?.[0]).toMatchObject({ cursor: 'more', parentId: 'root', limit: 5 })
    expect(await service.invokeApi('clues.comments.create', { ...params, body: 'reply', replyToId: 'root', requestId: 'wire-1' })).toHaveProperty('comment')
    expect(create).toHaveBeenCalledTimes(1)
    await expect(service.invokeApi('clues.comments.create', { ...params, body: 12, requestId: 'wire-2' })).rejects.toMatchObject({ category: 'invalid-request' })
  })
  it('rejects malformed provider discussion data and never calls it complete', async () => {
    const { service, params, comments } = setup()
    comments.mockResolvedValueOnce({ ...page, items: [{ ...page.items[0]!, id: '' }] })
    await expect(service.commentsList(params)).rejects.toMatchObject({ category: 'invalid-request' })
  })
})
