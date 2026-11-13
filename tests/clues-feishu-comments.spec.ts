/** UI19 source operations: document coverage, native task replies, no third-party calls. */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import { createFeishuDocsSource } from '../src/clues/sources/feishu/docs.ts'
import { createFeishuTasksSource } from '../src/clues/sources/feishu/tasks.ts'
import type { FeishuCommentOperations } from '../src/clues/sources/feishu/comments.ts'
import { FakeLarkRuntime, okResult, failResult, operationContext } from './clues-feishu-fixture.ts'
import type { ClueOperationContext } from '../src/clues/types.ts'
import { normalizeClueDiscussion } from '../src/clues/discussion.ts'
const context = (): ClueOperationContext => operationContext() as ClueOperationContext
const doc = { typeId: 'builtin.feishu.docx', locator: { kind: 'docx', docToken: 'doxcnTest' } }
const task = { typeId: 'builtin.feishu.task', locator: { kind: 'task', guid: '2f4d8c1e-7a3b-4c5d-9e8f-0123456789ab' } }
const reply = (id: string, body: string, user = 'ou_alice') => ({ reply_id: id, user_id: user, create_time: 1700000000, content: { elements: [{ type: 'text_run', text_run: { text: body } }] } })
function docs(runtime: FakeLarkRuntime) { return createFeishuDocsSource(() => runtime.asRuntime()).operations as FeishuCommentOperations }
function tasks(runtime: FakeLarkRuntime) { return createFeishuTasksSource(() => runtime.asRuntime()).operations as FeishuCommentOperations }

describe('Feishu document discussion', () => {
  it('captures explicit unresolved and resolved phases and pending replies before completing', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [{ comment_id: 'open', is_whole: true, is_solved: false, has_more: false, reply_list: { replies: [reply('open-r1', 'Open', '')] } }], has_more: false }))
    const open = await docs(runtime).listComments(doc, context())
    expect(open.items.map(item => [item.id, item.resolved])).toEqual([['open', false]])
    expect(open.complete).toBe(false)
    expect(open.nextCursor).toBeTruthy()
    expect(runtime.requests[0]!.args).toContain('--is-solved=false')
    runtime.enqueue(okResult({ items: [{ comment_id: 'solved', is_whole: true, is_solved: true, has_more: true, page_token: 'solved-replies', reply_list: { replies: [reply('solved-r1', 'Solved', '')] } }], has_more: false }))
    const solved = await docs(runtime).listComments({ ...doc, cursor: open.nextCursor }, context())
    expect(solved.items.map(item => [item.id, item.resolved])).toEqual([['solved', true]])
    expect(solved.complete).toBe(false)
    expect(runtime.requests[1]!.args).toContain('--is-solved=true')
    expect(solved.items[0]?.nextRepliesCursor).toBeUndefined()
    runtime.enqueue(okResult({ items: [{ comment_id: 'solved', is_whole: true }] }), okResult({ items: [reply('solved-r2', 'Last reply', '')], has_more: false }))
    const last = await docs(runtime).listComments({ ...doc, cursor: solved.nextCursor }, context())
    expect(last.items).toMatchObject([{ id: 'solved-r2', kind: 'reply', replyToId: 'solved' }])
    expect(last.complete).toBe(true)
    expect(last.nextCursor).toBeUndefined()
  })

  it('keeps provider page tokens within their solved phase, including empty phases without invented comments', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [], has_more: true, page_token: 'open-2' }))
    const first = await docs(runtime).listComments(doc, context())
    runtime.enqueue(okResult({ items: [], has_more: false }))
    const openEnd = await docs(runtime).listComments({ ...doc, cursor: first.nextCursor }, context())
    expect(openEnd.items).toEqual([])
    expect(openEnd.complete).toBe(false)
    runtime.enqueue(okResult({ items: [], has_more: true, page_token: 'solved-2' }))
    const solved = await docs(runtime).listComments({ ...doc, cursor: openEnd.nextCursor }, context())
    runtime.enqueue(okResult({ items: [], has_more: false }))
    const end = await docs(runtime).listComments({ ...doc, cursor: solved.nextCursor }, context())
    expect(end.items).toEqual([])
    expect(end.complete).toBe(true)
    const args = runtime.requests.map(request => request.args)
    expect(args.map(argv => argv.find(arg => arg.startsWith('--is-solved=')))).toEqual(['--is-solved=false', '--is-solved=false', '--is-solved=true', '--is-solved=true'])
    expect(args[1]).toContain('open-2')
    expect(args[2]).not.toContain('--page-token')
    expect(args[3]).toContain('solved-2')
  })

  it('binds phase cursors to the document and parent-only cursors to their parent scope', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [], has_more: false }))
    const first = await docs(runtime).listComments(doc, context())
    await expect(docs(runtime).listComments({ ...doc, locator: { kind: 'docx', docToken: 'anotherDoc' }, cursor: first.nextCursor }, context())).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(docs(runtime).listComments({ ...doc, parentId: 'whole', cursor: first.nextCursor }, context())).rejects.toMatchObject({ category: 'invalid-request' })
    runtime.enqueue(okResult({ items: [{ comment_id: 'whole', is_whole: true }] }), okResult({ items: [reply('r1', 'Root', ''), reply('r2', 'Reply', '')], has_more: true, page_token: 'next-replies' }))
    const replies = await docs(runtime).listComments({ ...doc, parentId: 'whole' }, context())
    expect(replies.items.map(item => item.id)).toEqual(['r2'])
    await expect(docs(runtime).listComments({ ...doc, cursor: replies.nextCursor }, context())).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(docs(runtime).listComments({ ...doc, parentId: 'other', cursor: replies.nextCursor }, context())).rejects.toMatchObject({ category: 'invalid-request' })
    runtime.enqueue(okResult({ items: [{ comment_id: 'whole', is_whole: true }] }), okResult({ items: [reply('r3', 'Last', '')], has_more: false }))
    const last = await docs(runtime).listComments({ ...doc, parentId: 'whole', cursor: replies.nextCursor }, context())
    expect(last.items.map(item => item.id)).toEqual(['r3'])
    expect(last.complete).toBe(true)
    expect(runtime.requests).toHaveLength(5)
  })

  it('passes a real 34-card, 102-message source page through the public normalizer without truncating replies', async () => {
    const cards = Array.from({ length: 34 }, (_, index) => ({ comment_id: `card-${index}`, is_whole: true, is_solved: false, has_more: false,
      reply_list: { replies: Array.from({ length: 3 }, (_, child) => reply(`reply-${index}-${child}`, `Text ${index}/${child}`, '')) } }))
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: cards, has_more: false }))
    const page = normalizeClueDiscussion(await docs(runtime).listComments({ ...doc, limit: 50 }, context()))
    expect(page.items).toHaveLength(102)
    expect(page.items.filter(item => item.kind === 'comment')).toHaveLength(34)
    expect(page.items.filter(item => item.kind === 'reply')).toHaveLength(68)
    expect(page.items[0]?.createdAt).toBe('2023-11-14T22:13:20.000Z')
    expect(page.complete).toBe(false)
  })

  it('allows an explicit first reply page for a whole-document parent and excludes its root message', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [{ comment_id: 'whole', is_whole: true }] }), okResult({ items: [reply('r1', 'Root'), reply('r2', 'Reply')], has_more: false }), okResult({ items: [] }))
    const page = await docs(runtime).listComments({ ...doc, parentId: 'whole' }, context())
    expect(page.items.map(item => item.id)).toEqual(['r2'])
    expect(page.complete).toBe(true)
  })

  it('refuses incomplete comment pagination without a usable continuation instead of reporting an empty complete thread', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [], has_more: true }))
    await expect(docs(runtime).listComments(doc, context())).rejects.toMatchObject({ category: 'failed' })
  })

  it('lists whole-document comments and drains reply pages before claiming complete', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [
      { comment_id: 'whole', is_whole: true, is_solved: false, has_more: true, page_token: 'reply-next', reply_list: { replies: [reply('r1', 'Root'), reply('r2', 'Reply')] } },
      { comment_id: 'inline', is_whole: false, reply_list: { replies: [reply('x', 'Must not leak inline')] } },
    ], has_more: false }), okResult({ items: [{ open_id: 'ou_alice', name: 'Alice' }] }))
    const first = await docs(runtime).listComments(doc, context())
    expect(first.items.map(item => [item.id, item.kind, item.body])).toEqual([['whole', 'comment', 'Root'], ['r2', 'reply', 'Reply']])
    expect(first.items[0]).toMatchObject({ author: { id: 'ou_alice', name: 'Alice' }, resolved: false })
    expect(first.complete).toBe(false)
    expect(first.nextCursor).toBeTruthy()
    expect(first.items[0]?.nextRepliesCursor).toBeUndefined() // the resource cursor owns reply continuation
    runtime.enqueue(okResult({ items: [{ comment_id: 'whole', is_whole: true }] }), okResult({ items: [reply('r3', 'Last', 'ou_bob')], has_more: false }), okResult({ items: [{ open_id: 'ou_bob', name: 'Bob' }] }))
    const replies = await docs(runtime).listComments({ ...doc, cursor: first.nextCursor }, context())
    expect(replies.items).toMatchObject([{ id: 'r3', kind: 'reply', replyToId: 'whole', body: 'Last', author: { name: 'Bob' } }])
    expect(replies.complete).toBe(false)
    runtime.enqueue(okResult({ items: [], has_more: false }))
    const last = await docs(runtime).listComments({ ...doc, cursor: replies.nextCursor }, context())
    expect(last.items).toEqual([])
    expect(last.complete).toBe(true)
    expect(runtime.requests.at(-1)!.args).toContain('--is-solved=true')
    expect(runtime.requests.filter(request => request.args.includes('batch'))).toHaveLength(2)
    expect(runtime.requests.every(request => !request.args.includes('--page-all'))).toBe(true)
  })

  it('preserves IDs when optional contact permission is missing without invalidating readable comments', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [{ comment_id: 'whole', is_whole: true, reply_list: { replies: [reply('r1', 'Root')] }, has_more: false }], has_more: false }), failResult({ type: 'authorization', subtype: 'missing_scope', missing_scopes: ['contact:contact.base:readonly'] }))
    const page = await docs(runtime).listComments(doc, context())
    expect(page.items[0]?.author).toEqual({ id: 'ou_alice' })
    expect(page.status).toBe('ok')
    expect(runtime.reports).toHaveLength(0)
  })

  it('quotes a whole-document parent and never uses an unsupported native whole-comment reply', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [{ comment_id: 'whole', is_whole: true, reply_list: { replies: [reply('r1', 'Original <text>')] } }] }), okResult({ comment_id: 'new', create_time: 1700000010 }))
    const saved = await docs(runtime).createComment({ ...doc, body: 'Answer <tag>', replyToId: 'whole', requestId: 'r' }, context())
    expect(saved.comment).toMatchObject({ id: 'new', kind: 'reply', replyToId: 'whole' })
    expect(saved.comment.body).toContain('Original <text>')
    expect(saved.comment.body).toContain('Answer <tag>')
    const write = runtime.requests[1]!
    expect(write.args).toContain('create_v2')
    expect(write.args).toContain('-')
    expect(write.args.join(' ')).not.toContain('Answer')
    expect(JSON.parse(String(write.stdin)).reply_elements[0].text).toContain('&lt;tag&gt;')
  })
})

describe('Feishu task discussion', () => {
  it('keeps native parent links, explicit cursor, and batches only missing names', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [
      { id: '1', content: 'First', creator: { id: 'ou_alice' }, created_at: '1700000000000' },
      { id: '2', content: 'Reply', creator: { id: 'ou_alice' }, reply_to_comment_id: '1' },
      { id: '3', content: 'Known', creator: { id: 'ou_known', name: 'Known' } },
    ], has_more: true, page_token: 'next' }), okResult({ items: [{ open_id: 'ou_alice', name: 'Alice' }] }))
    const page = await tasks(runtime).listComments(task, context())
    expect(page.items[1]).toMatchObject({ kind: 'reply', replyToId: '1', author: { id: 'ou_alice', name: 'Alice' } })
    expect(page.complete).toBe(false)
    expect(runtime.requests[1]!.args).toContain('batch')
    expect(runtime.requests[1]!.stdin).toBe(JSON.stringify({ user_ids: ['ou_alice'], user_id_type: 'open_id' }))
    runtime.enqueue(okResult({ items: [], has_more: false }))
    const end = await tasks(runtime).listComments({ ...task, cursor: page.nextCursor }, context())
    expect(end.complete).toBe(true)
    expect(runtime.requests[2]!.stdin).toContain('next')
  })

  it('submits a native task reply through stdin and rejects agent writes before any CLI', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ comment: { id: '4', content: 'Reply', reply_to_comment_id: '1', resource_type: 'task', resource_id: task.locator.guid } }))
    const input = { ...task, body: 'Reply', replyToId: '1', requestId: 'r' }
    await expect(tasks(runtime).createComment(input, { ...context(), caller: 'agent' })).rejects.toMatchObject({ category: 'permission-denied' })
    const result = await tasks(runtime).createComment(input, context())
    expect(result.comment).toMatchObject({ id: '4', kind: 'reply', replyToId: '1' })
    expect(JSON.parse(String(runtime.requests[0]!.stdin))).toMatchObject({ content: 'Reply', reply_to_comment_id: '1', resource_id: task.locator.guid, resource_type: 'task' })
    expect(runtime.requests).toHaveLength(1)
  })
})
