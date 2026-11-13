/** Bounded whole-document discussion capture for a confirmed snapshot export. */
import { parseClueDiscussion } from '../store.ts'
import { ClueError, type Clue, type ClueComment, type ClueDiscussionPage, type ClueReadResult } from '../types.ts'
import type { CluesService } from '../service.ts'
import { safeFailureOf, SAFE_FAILURE_REASONS } from './reasons.ts'

export const DEFAULT_MAX_DISCUSSION_PAGES = 100
export const DEFAULT_MAX_DISCUSSION_ITEMS = 10_000
export const DEFAULT_MAX_DISCUSSION_BYTES = 4 * 1024 * 1024

export interface DiscussionCaptureLimits {
  readonly maxDiscussionPages?: number
  readonly maxDiscussionItems?: number
  readonly maxDiscussionBytes?: number
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClueError('cancelled', 'the clue pack export was cancelled')
}

function limitOf(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new ClueError('invalid-request', 'discussion limits must be positive integers')
  return Math.min(value, fallback)
}

/** Source-owned error messages never travel in shared archives. */
export function sharedDiscussion(value: ClueDiscussionPage): ClueDiscussionPage {
  const page = parseClueDiscussion(value)
  return {
    ...page,
    ...(page.error === undefined ? {} : { error: { category: page.error.category, message: SAFE_FAILURE_REASONS[page.error.category] } }),
  }
}

/**
 * Continues the first read page through comments.list only. Provider transport
 * owns the shared request gate; every continuation keeps this export's signal.
 */
export async function captureDiscussion(
  clues: CluesService,
  clue: Clue,
  body: ClueReadResult,
  limits: DiscussionCaptureLimits,
  signal?: AbortSignal,
): Promise<ClueDiscussionPage | undefined> {
  const capability = clues.getSource(clue.sourceId)?.capabilities.comments
  if (body.discussion === undefined && capability === undefined) return undefined
  const maxPages = limitOf(limits.maxDiscussionPages, DEFAULT_MAX_DISCUSSION_PAGES)
  const maxItems = limitOf(limits.maxDiscussionItems, DEFAULT_MAX_DISCUSSION_ITEMS)
  const maxBytes = limitOf(limits.maxDiscussionBytes, DEFAULT_MAX_DISCUSSION_BYTES)
  const items = new Map<string, ClueComment>()
  const replyCounts = new Map<string, number>()
  const requests = new Set<string>()
  let pages = 0
  let complete = true
  let status: ClueDiscussionPage['status'] = 'ok'
  let fetchedAt = body.fetchedAt
  let total: number | undefined
  let nextCursor: string | undefined
  let error: ClueDiscussionPage['error']
  let bytes = 256
  let stopped = false
  const fail = (category: NonNullable<ClueDiscussionPage['error']>['category'], message: string): void => {
    complete = false
    stopped = true
    error = { category, message }
  }
  const tooLarge = (): void => { fail('unsupported', 'the discussion exceeds the snapshot capture limit') }
  const accept = (raw: ClueDiscussionPage, parentId?: string): ClueDiscussionPage => {
    const page = sharedDiscussion(raw)
    pages += 1
    fetchedAt = page.fetchedAt
    if (parentId === undefined && page.total !== undefined) total = page.total
    if (page.status !== 'ok') {
      status = page.status
      complete = false
      stopped = true
      if (page.status === 'not-captured' && page.error === undefined) {
        error = { category: 'unsupported', message: 'the discussion was not captured by the source' }
      }
    }
    if (page.error !== undefined) {
      error = page.error
      complete = false
    }
    for (const original of page.items) {
      const item = parentId !== undefined && original.kind === 'reply' && original.replyToId === undefined
        ? { ...original, replyToId: parentId }
        : original
      const previous = items.get(item.id)
      const itemBytes = Buffer.byteLength(JSON.stringify(item))
      const previousBytes = previous === undefined ? 0 : Buffer.byteLength(JSON.stringify(previous))
      if ((previous === undefined && items.size >= maxItems) || bytes + itemBytes - previousBytes > maxBytes) {
        tooLarge()
        break
      }
      if (previous?.replyToId !== undefined) replyCounts.set(previous.replyToId, (replyCounts.get(previous.replyToId) ?? 1) - 1)
      if (item.replyToId !== undefined) replyCounts.set(item.replyToId, (replyCounts.get(item.replyToId) ?? 0) + 1)
      items.set(item.id, item)
      bytes += itemBytes - previousBytes
    }
    return page
  }
  const load = async (cursor?: string, parentId?: string): Promise<ClueDiscussionPage | undefined> => {
    checkAbort(signal)
    if (pages >= maxPages) { tooLarge(); return undefined }
    const key = JSON.stringify([parentId ?? null, cursor ?? null])
    if (requests.has(key)) { fail('failed', 'the discussion returned a repeated cursor'); return undefined }
    requests.add(key)
    try {
      const page = await clues.commentsList({
        workspaceId: clue.workspaceId, sourceId: clue.sourceId, typeId: clue.typeId, locator: clue.locator,
        limit: Math.min(100, maxItems - items.size || 1),
        ...(cursor === undefined ? {} : { cursor }),
        ...(parentId === undefined ? {} : { parentId }),
      }, { caller: 'ui', ...(signal === undefined ? {} : { signal }) })
      checkAbort(signal)
      return accept(page, parentId)
    } catch (cause) {
      checkAbort(signal)
      const failure = safeFailureOf(cause)
      if (failure.category === 'cancelled') throw new ClueError('cancelled', failure.reason)
      status = 'unavailable'
      fail(failure.category, failure.reason)
      return undefined
    }
  }

  checkAbort(signal)
  if (capability !== undefined && !capability.read && body.discussion === undefined) {
    return { status: 'unavailable', items: [], fetchedAt, complete: false, coverage: 'document', error: { category: 'permission-denied', message: SAFE_FAILURE_REASONS['permission-denied'] } }
  }
  let current: ClueDiscussionPage | undefined
  try {
    current = body.discussion === undefined ? await load() : accept(body.discussion)
  } catch (cause) {
    checkAbort(signal)
    const failure = safeFailureOf(cause)
    if (failure.category === 'cancelled') throw new ClueError('cancelled', failure.reason)
    return { status: 'unavailable', items: [], fetchedAt, complete: false, coverage: 'document', error: { category: failure.category, message: failure.reason } }
  }
  nextCursor = current?.nextCursor
  let unexplainedIncomplete = current !== undefined && !current.complete && current.nextCursor === undefined
    && !current.items.some(item => item.nextRepliesCursor !== undefined || (item.replyCount ?? 0) > 0)
  while (!stopped && nextCursor !== undefined) {
    current = await load(nextCursor)
    if (current === undefined) break
    nextCursor = current.nextCursor
    if (!current.complete && current.nextCursor === undefined
      && !current.items.some(item => item.nextRepliesCursor !== undefined || (item.replyCount ?? 0) > 0)) unexplainedIncomplete = true
  }

  // Map iteration also visits replies added during the loop, so nested native
  // replies remain bounded by the same item/page budget.
  for (const [id, item] of items) {
    if (stopped) break
    let replyCursor = item.nextRepliesCursor
    const replies = (): number => replyCounts.get(id) ?? 0
    if (replyCursor === undefined && (item.replyCount ?? 0) <= replies()) continue
    do {
      const replyPage = await load(replyCursor, id)
      if (replyPage === undefined || stopped) break
      replyCursor = replyPage.nextCursor
      if (!replyPage.complete && replyCursor === undefined
        && !replyPage.items.some(reply => reply.nextRepliesCursor !== undefined || (reply.replyCount ?? 0) > 0)) unexplainedIncomplete = true
    } while (replyCursor !== undefined)
    if (!stopped && replyCursor === undefined) {
      const latest = items.get(id)!
      const { nextRepliesCursor: _cursor, ...captured } = latest
      bytes += Buffer.byteLength(JSON.stringify(captured)) - Buffer.byteLength(JSON.stringify(latest))
      items.set(id, captured)
      if ((latest.replyCount ?? 0) > replies()) unexplainedIncomplete = true
    }
  }
  checkAbort(signal)
  if (total !== undefined && items.size < total) unexplainedIncomplete = true
  complete &&= !stopped && !unexplainedIncomplete && nextCursor === undefined
  const result: ClueDiscussionPage = {
    status, items: [...items.values()], fetchedAt, complete, coverage: 'document',
    ...(total === undefined ? {} : { total }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(error === undefined ? {} : { error }),
  }
  // Include envelope bytes in the same bound; small diagnostic envelopes stay
  // readable even when the caller intentionally configures a tiny byte budget.
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes && items.size > 0) {
    return { ...result, items: [], complete: false, error: { category: 'unsupported', message: 'the discussion exceeds the snapshot capture limit' } }
  }
  return result
}
