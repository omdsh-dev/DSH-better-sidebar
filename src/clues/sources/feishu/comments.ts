/** Bounded whole-document discussions and native task replies through fixed CLI APIs. */
import { ClueError, type ClueComment, type ClueCommentCreateResult, type ClueDiscussionPage, type ClueOperationContext, type JsonValue } from '../../types.ts'
import type { ClueSourceReadInput } from '../../service.ts'
import type { ClueRuntime } from '../../runtime/types.ts'
import { isoInstantOf } from '../../resource-info.ts'
import { isRecord, stringOf } from './format.ts'
import { decodeCursor, encodeCursor } from './cursor.ts'
import { larkWorkingDirectory, type LarkSuccess } from './lark.ts'
import { runFeishuCommand } from './auth.ts'
import { feishuPeopleNames, feishuPersonOf, namedFeishuPerson } from './people.ts'
import { decodeXmlEntities } from './edit.ts'
import { parseTaskLocator } from './urls.ts'

export type CommentListInput = ClueSourceReadInput & { cursor?: string; limit?: number; parentId?: string }
export type CommentCreateInput = ClueSourceReadInput & { body: string; replyToId?: string; requestId: string }
export interface FeishuCommentOperations {
  listComments(input: CommentListInput, context: ClueOperationContext): Promise<ClueDiscussionPage>
  createComment(input: CommentCreateInput, context: ClueOperationContext): Promise<ClueCommentCreateResult>
}

type ReplyPage = { id: string; token: string }
type DocCursor = { phase: 'unresolved' | 'resolved'; page?: string; replies: ReplyPage[]; done: boolean }
const ID = /^[A-Za-z0-9_-]{1,256}$/
function requireId(id: string): void { if (!ID.test(id)) throw new ClueError('invalid-request', 'invalid Feishu comment id') }
function limitOf(limit?: number): number {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new ClueError('invalid-request', 'invalid discussion page size')
  return Math.min(limit ?? 20, 50)
}
function requireBody(body: string, max: number): void {
  if (typeof body !== 'string' || body.trim() === '' || [...body].length > max) throw new ClueError('invalid-request', 'the comment must contain text within the provider size limit')
}
function requireUi(context: ClueOperationContext): void {
  if (context.caller !== 'ui') throw new ClueError('permission-denied', 'comment submission requires an interactive user request')
}
function rowsOf(success: LarkSuccess): JsonValue[] {
  if (!Array.isArray(success.data.items)) throw new ClueError('failed', 'Feishu returned a malformed discussion page')
  return success.data.items
}
function nextToken(success: { has_more?: JsonValue; page_token?: JsonValue }): string | undefined {
  if (success.has_more === false) return undefined
  if (success.has_more !== true) throw new ClueError('failed', 'Feishu did not confirm discussion completeness')
  const token = stringOf(success.page_token)
  if (token === undefined) throw new ClueError('failed', 'Feishu did not provide a discussion continuation')
  return token
}
function request(runtime: ClueRuntime, context: ClueOperationContext, args: string[], stdin?: string) {
  return runFeishuCommand(runtime, { args: [...args, '--as', 'user', '--format', 'json'], cwd: larkWorkingDirectory(context.workspacePath),
    ...(stdin === undefined ? {} : { stdin }), ...(context.signal === undefined ? {} : { signal: context.signal }) })
}
async function namedPage(runtime: ClueRuntime, context: ClueOperationContext, items: ClueComment[], nextCursor?: string): Promise<ClueDiscussionPage> {
  const names = await feishuPeopleNames(runtime, items.map(item => item.author), context)
  return { status: 'ok', coverage: 'document', fetchedAt: new Date().toISOString(), complete: nextCursor === undefined,
    items: items.map(item => item.author === undefined ? item : { ...item, author: namedFeishuPerson(item.author, names) }),
    ...(nextCursor === undefined ? {} : { nextCursor }) }
}
function taskCommentOf(value: JsonValue): ClueComment {
  if (!isRecord(value) || stringOf(value.id) === undefined || typeof value.content !== 'string') throw new ClueError('failed', 'Feishu returned a malformed task comment')
  const replyToId = stringOf(value.reply_to_comment_id)
  const author = feishuPersonOf(value.creator)
  const createdAt = isoInstantOf(value.created_at)
  const updatedAt = isoInstantOf(value.updated_at)
  return { id: value.id as string, kind: replyToId === undefined ? 'comment' : 'reply', format: 'text/plain', body: value.content,
    ...(author === undefined ? {} : { author }), ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(replyToId === undefined ? {} : { replyToId }) }
}

export function createFeishuTaskCommentOperations(getRuntime: () => ClueRuntime): FeishuCommentOperations {
  return {
    async listComments(input, context) {
      const locator = parseTaskLocator(input.locator)
      const limit = limitOf(input.limit)
      if (input.parentId !== undefined) throw new ClueError('unsupported', 'task replies are already included in the discussion timeline')
      const signature = `task-comments:${locator.guid}`
      const token = input.cursor === undefined ? undefined : decodeCursor(signature, input.cursor).pageToken
      const runtime = getRuntime()
      // The pinned CLI's generic API verb supports these fixed endpoints even without a downloaded command catalogue.
      const response = await request(runtime, context, ['api', 'GET', '/open-apis/task/v2/comments', '--params', '-'], JSON.stringify({ resource_type: 'task', resource_id: locator.guid, direction: 'asc', page_size: limit, user_id_type: 'open_id', ...(token === undefined ? {} : { page_token: token }) }))
      const items = rowsOf(response).map(taskCommentOf)
      const next = nextToken(response.data)
      return namedPage(runtime, context, items, next === undefined ? undefined : encodeCursor(signature, next))
    },
    async createComment(input, context) {
      requireUi(context)
      requireBody(input.body, 3000)
      if (input.replyToId !== undefined) requireId(input.replyToId)
      const locator = parseTaskLocator(input.locator)
      const response = await request(getRuntime(), context, ['api', 'POST', '/open-apis/task/v2/comments', '--data', '-'], JSON.stringify({ content: input.body, resource_id: locator.guid, resource_type: 'task', ...(input.replyToId === undefined ? {} : { reply_to_comment_id: input.replyToId }) }))
      const raw = response.data.comment
      if (!isRecord(raw) || (raw.resource_id !== undefined && raw.resource_id !== locator.guid) || (raw.resource_type !== undefined && raw.resource_type !== 'task')) throw new ClueError('failed', 'Feishu did not confirm the task comment resource')
      const comment = taskCommentOf(raw)
      if (comment.body !== input.body || comment.replyToId !== input.replyToId) throw new ClueError('failed', 'Feishu did not confirm the submitted task comment')
      return { comment, savedAt: new Date().toISOString() }
    },
  }
}

function replyBody(value: JsonValue): string {
  if (!isRecord(value)) throw new ClueError('failed', 'Feishu returned a malformed document reply')
  const content = isRecord(value.content) ? value.content : undefined
  if (!Array.isArray(content?.elements)) throw new ClueError('failed', 'Feishu returned a document reply without content')
  return content.elements.map(raw => {
    if (!isRecord(raw)) return ''
    if (isRecord(raw.text_run) && typeof raw.text_run.text === 'string') return decodeXmlEntities(raw.text_run.text)
    if (isRecord(raw.docs_link)) return stringOf(raw.docs_link.url) ?? ''
    if (isRecord(raw.person)) return `@${stringOf(raw.person.user_id) ?? ''}`
    return ''
  }).join('')
}
function docReplyOf(value: JsonValue, parentId: string, root = false): ClueComment {
  if (!isRecord(value) || stringOf(value.reply_id) === undefined) throw new ClueError('failed', 'Feishu returned a malformed document reply')
  const author = feishuPersonOf(value.user_id)
  const createdAt = isoInstantOf(value.create_time)
  const updatedAt = isoInstantOf(value.update_time)
  return { id: root ? parentId : value.reply_id as string, kind: root ? 'comment' : 'reply', format: 'text/plain', body: replyBody(value),
    ...(author === undefined ? {} : { author }), ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(root ? {} : { replyToId: parentId }) }
}
function parseDocCursor(signature: string, cursor?: string): DocCursor {
  if (cursor === undefined) return { phase: 'unresolved', replies: [], done: false }
  try {
    if (cursor.length > 64 * 1024) throw new Error('size')
    const value: unknown = JSON.parse(decodeCursor(signature, cursor).pageToken)
    if (!isRecord(value) || (value.phase !== 'unresolved' && value.phase !== 'resolved') || typeof value.done !== 'boolean'
      || !Array.isArray(value.replies) || value.replies.length > 50
      || (value.page !== undefined && typeof value.page !== 'string')) throw new Error('shape')
    const replies = value.replies.map(raw => {
      if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.token !== 'string' || raw.token === '') throw new Error('reply')
      requireId(raw.id)
      return { id: raw.id, token: raw.token }
    })
    return { phase: value.phase, done: value.done, replies, ...(typeof value.page === 'string' ? { page: value.page } : {}) }
  } catch { throw new ClueError('invalid-request', 'invalid or foreign Feishu discussion cursor') }
}
function docCursor(signature: string, state: DocCursor): string | undefined {
  return state.done && state.replies.length === 0 ? undefined : encodeCursor(signature, JSON.stringify(state))
}
async function wholeParent(runtime: ClueRuntime, context: ClueOperationContext, token: string, id: string): Promise<Record<string, JsonValue>> {
  requireId(id)
  const response = await request(runtime, context, ['drive', 'file.comments', 'batch_query', '--file-token', token, '--file-type', 'docx', '--user-id-type', 'open_id', '--data', '-'], JSON.stringify({ comment_ids: [id] }))
  const parent = rowsOf(response).find(raw => isRecord(raw) && raw.comment_id === id)
  if (!isRecord(parent) || parent.is_whole !== true) throw new ClueError('invalid-request', 'the parent is not a whole-document comment on this resource')
  return parent
}

/** Wiki resolution belongs to the owning docs adapter, keeping its token/type validation authoritative. */
export function createFeishuDocCommentOperations(getRuntime: () => ClueRuntime, documentToken: (input: ClueSourceReadInput, context: ClueOperationContext) => Promise<string>): FeishuCommentOperations {
  return {
    async listComments(input, context) {
      const limit = limitOf(input.limit)
      const token = await documentToken(input, context)
      const signature = input.parentId === undefined ? `doc-comments:v2:${token}` : `doc-replies:v2:${token}:${input.parentId}`
      const state = parseDocCursor(signature, input.cursor)
      const runtime = getRuntime()
      const items: ClueComment[] = []
      if (input.parentId !== undefined || state.replies.length > 0) {
        const pending = state.replies[0]
        const parentId = input.parentId ?? pending!.id
        if (input.parentId !== undefined && input.cursor !== undefined && (pending?.id !== input.parentId || state.replies.length !== 1 || !state.done)) throw new ClueError('invalid-request', 'the replies cursor belongs to a different parent')
        await wholeParent(runtime, context, token, parentId)
        const response = await request(runtime, context, ['drive', 'file.comment.replys', 'list', '--file-token', token, '--file-type', 'docx', '--comment-id', parentId,
          '--user-id-type', 'open_id', '--page-size', String(limit), ...(pending === undefined ? [] : ['--page-token', pending.token])])
        const repliesPage = rowsOf(response)
        items.push(...(pending === undefined ? repliesPage.slice(1) : repliesPage).map(raw => docReplyOf(raw, parentId)))
        const next = nextToken(response.data)
        const replies = [...state.replies.slice(1)]
        if (next !== undefined) replies.unshift({ id: parentId, token: next })
        return namedPage(runtime, context, items, docCursor(signature, { ...state, ...(input.parentId === undefined ? {} : { done: true }), replies }))
      }
      const response = await request(runtime, context, ['drive', 'file.comments', 'list', '--file-token', token, '--file-type', 'docx', '--is-whole=true', `--is-solved=${state.phase === 'resolved'}`, '--user-id-type', 'open_id', '--page-size', String(limit), ...(state.page === undefined ? [] : ['--page-token', state.page])])
      const pending: ReplyPage[] = []
      for (const raw of rowsOf(response)) {
        if (!isRecord(raw) || raw.is_whole !== true) continue
        const id = stringOf(raw.comment_id)
        const replyList = isRecord(raw.reply_list) ? raw.reply_list : undefined
        if (id === undefined || !Array.isArray(replyList?.replies) || replyList.replies.length === 0) throw new ClueError('failed', 'Feishu returned a whole-document comment without its content')
        const replies = replyList.replies
        const next = nextToken(raw)
        // The resource cursor already drains these replies; exposing both
        // continuations would make snapshot capture fetch the same page twice.
        if (next !== undefined) pending.push({ id, token: next })
        items.push({ ...docReplyOf(replies[0]!, id, true), ...(typeof raw.is_solved === 'boolean' ? { resolved: raw.is_solved } : {}) })
        items.push(...replies.slice(1).map(value => docReplyOf(value, id)))
      }
      const next = nextToken(response.data)
      // A missing token finishes only this filter, not the document discussion.
      const phase = next === undefined && state.phase === 'unresolved' ? 'resolved' : state.phase
      return namedPage(runtime, context, items, docCursor(signature, {
        phase, done: next === undefined && state.phase === 'resolved', replies: pending,
        ...(next === undefined ? {} : { page: next }),
      }))
    },
    async createComment(input, context) {
      requireUi(context)
      requireBody(input.body, 10_000)
      const token = await documentToken(input, context)
      const runtime = getRuntime()
      let body = input.body
      if (input.replyToId !== undefined) {
        // Full-document comments cannot be replied to natively; a quoted new full comment is explicit.
        const parent = await wholeParent(runtime, context, token, input.replyToId)
        const replies = isRecord(parent.reply_list) ? parent.reply_list.replies : undefined
        if (!Array.isArray(replies) || replies[0] === undefined) throw new ClueError('failed', 'the reply parent has no readable content')
        const quote = replyBody(replies[0]).slice(0, 4000).split('\n').map(line => `> ${line}`).join('\n')
        body = `Reply to comment ${input.replyToId}\n\n${quote}\n\n${input.body}`
        requireBody(body, 10_000)
      }
      // XML escaping is required by the native Drive comment protocol, not Markdown conversion.
      const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const response = await request(runtime, context, ['drive', 'file.comments', 'create_v2', '--file-token', token, '--data', '-'], JSON.stringify({ file_type: 'docx', reply_elements: [{ type: 'text', text: escaped }] }))
      const id = stringOf(response.data.comment_id)
      if (id === undefined) throw new ClueError('failed', 'Feishu did not confirm the created document comment')
      const createdAt = isoInstantOf(response.data.create_time ?? response.data.created_at)
      return { comment: { id, kind: input.replyToId === undefined ? 'comment' : 'reply', format: 'text/plain', body,
        ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId }), ...(createdAt === undefined ? {} : { createdAt }) }, savedAt: new Date().toISOString() }
    },
  }
}
