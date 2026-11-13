/** One discussion schema shared by sources, HTTP, snapshots and cluepack import/export. */
import { CLUE_ERROR_CATEGORIES, ClueError } from './error.ts'
import { normalizeClueResourceInfo } from './resource-info.ts'
import type { ClueComment, ClueCommentAnchor, ClueDiscussionPage, ClueErrorCategory, CluePerson, JsonObject, JsonValue } from './types.ts'
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/**
 * Maximum number of comments one COMPLETE captured discussion may carry.
 *
 * A snapshot stores the aggregated multi-page discussion (the source pages
 * remain bounded separately), so this bound covers the whole captured
 * resource rather than one wire page. Share import/export uses the same
 * validator and therefore the same limit.
 */
export const MAX_DISCUSSION_PAGE_ITEMS = 10_000

/** Deepest JSON value accepted inside one anchor locator (matches the manifest). */
const MAX_DISCUSSION_JSON_DEPTH = 64

/** The strict ISO-8601 form captured discussion fetch times must use. */
const DISCUSSION_ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

/** Days in one proleptic Gregorian month. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
}

/**
 * Whether one string is a real ISO-8601 instant, not merely something
 * `Date.parse` accepts (Feb 30, hour 24 and a +14:30 offset are all refused).
 *
 * Kept in sync with the cluepack manifest's writer/reader rule; both ends of a
 * share must agree on the exact timestamp spelling.
 */
function isDiscussionIsoTimestamp(value: string): boolean {
  const match = DISCUSSION_ISO_TIMESTAMP.exec(value)
  if (match === null || Number.isNaN(Date.parse(value))) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const zone = match[7]!
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3))
    const zoneMinute = Number(zone.slice(4, 6))
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) return false
  }
  return true
}

const DISCUSSION_STATUSES: ReadonlySet<string> = new Set(['ok', 'unavailable', 'not-captured'])
const COMMENT_KINDS: ReadonlySet<string> = new Set(['comment', 'reply', 'review'])
const COMMENT_FORMATS: ReadonlySet<string> = new Set(['text/plain', 'text/markdown'])
const COMMENT_ANCHOR_KINDS: ReadonlySet<string> = new Set(['text', 'code'])
const CLUE_ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(CLUE_ERROR_CATEGORIES)

/**
 * Strictly validate one captured discussion page and return a normalized copy.
 *
 * This is the ONE validator shared by the local snapshot store and share
 * import/export: unknown extension keys are dropped, every documented field is
 * copied only when it has the documented type, and a malformed page fails with
 * `invalid-request` instead of reaching the UI/Agent as a partial object.
 *
 * An omitted `body` is accepted only for a `review`, where a status-only
 * summary is meaningful (contract: "empty review body may be omitted"); it is
 * normalized to the empty string so the returned shape always satisfies
 * {@link ClueComment}.
 *
 * @param value - untrusted discussion value (archive JSON or store document).
 * @param source - safe context used in the failure message (never raw input).
 */
export function parseClueDiscussion(value: unknown, source = 'discussion'): ClueDiscussionPage {
  const fail = (detail: string): never => {
    throw new ClueError('invalid-request', `the ${source} is not a valid clue discussion page: ${detail}`)
  }
  const recordOf = (raw: unknown, what: string): Record<string, unknown> => {
    if (!isRecord(raw)) fail(`${what} must be a JSON object`)
    return raw as Record<string, unknown>
  }
  const optionalString = (raw: Record<string, unknown>, key: string, what: string): string | undefined => {
    const field = raw[key]
    if (field === undefined) return undefined
    if (typeof field !== 'string') fail(`${what}.${key} must be a string`)
    return field as string
  }
  const requiredString = (raw: Record<string, unknown>, key: string, what: string): string => {
    const field = raw[key]
    if (typeof field !== 'string') fail(`${what}.${key} must be a string`)
    return field as string
  }
  const requiredNonBlankString = (raw: Record<string, unknown>, key: string, what: string): string => {
    const field = requiredString(raw, key, what)
    // Preserve the caller's exact spelling (opaque ids/cursors may contain
    // meaningful spaces) but never accept a value that is only whitespace.
    if (field.trim() === '') fail(`${what}.${key} must not be blank`)
    return field
  }
  const optionalCount = (raw: Record<string, unknown>, key: string, what: string): number | undefined => {
    const field = raw[key]
    if (field === undefined) return undefined
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) {
      fail(`${what}.${key} must be a non-negative safe integer`)
    }
    return field as number
  }
  const optionalBoolean = (raw: Record<string, unknown>, key: string, what: string): boolean | undefined => {
    const field = raw[key]
    if (field === undefined) return undefined
    if (typeof field !== 'boolean') fail(`${what}.${key} must be a boolean`)
    return field as boolean
  }
  /**
   * Deep-clone one JSON value with strict bounds.
   *
   * `JSON.parse(JSON.stringify(...))` silently drops functions/undefined and
   * turns NaN into null; an anchor locator must reject those instead. Cycles,
   * BigInt, non-finite numbers, class instances and values deeper than
   * {@link MAX_DISCUSSION_JSON_DEPTH} are refused. The clone keeps the
   * caller's strings verbatim.
   */
  const jsonClone = (
    raw: unknown,
    what: string,
    depth = 0,
    seen = new Set<object>(),
  ): JsonValue => {
    if (depth > MAX_DISCUSSION_JSON_DEPTH) {
      fail(`${what} is nested too deeply (limit ${MAX_DISCUSSION_JSON_DEPTH})`)
    }
    if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') return raw
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) fail(`${what} must be a finite JSON number`)
      return raw
    }
    if (typeof raw !== 'object' || raw === null) fail(`${what} must be a JSON value`)
    const objectValue = raw as object
    if (seen.has(objectValue)) fail(`${what} must not contain cycles`)
    seen.add(objectValue)
    if (Array.isArray(objectValue)) {
      const clone = objectValue.map((item, index) => jsonClone(item, `${what}[${index}]`, depth + 1, seen))
      seen.delete(objectValue)
      return clone as JsonValue
    }
    const prototype = Object.getPrototypeOf(objectValue) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(objectValue)
      fail(`${what} must contain only plain JSON objects`)
    }
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      seen.delete(objectValue)
      fail(`${what} must not contain symbol keys`)
    }
    const clone: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(objectValue)) {
      clone[key] = jsonClone(item, `${what}.${key}`, depth + 1, seen)
    }
    seen.delete(objectValue)
    return clone
  }
  const personOf = (raw: unknown, what: string): CluePerson => {
    const record = recordOf(raw, what)
    const id = optionalString(record, 'id', what)
    const name = optionalString(record, 'name', what)
    const handle = optionalString(record, 'handle', what)
    const url = optionalString(record, 'url', what)
    return {
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
      ...(handle === undefined ? {} : { handle }),
      ...(url === undefined ? {} : { url }),
    }
  }
  const anchorOf = (raw: unknown, what: string): ClueCommentAnchor => {
    const record = recordOf(raw, what)
    const kind = record.kind
    if (typeof kind !== 'string' || !COMMENT_ANCHOR_KINDS.has(kind)) {
      fail(`${what}.kind must be "text" or "code"`)
    }
    const quote = optionalString(record, 'quote', what)
    const revision = optionalString(record, 'revision', what)
    let locator: JsonObject | undefined
    if (record.locator !== undefined) {
      recordOf(record.locator, `${what}.locator`)
      locator = jsonClone(record.locator, `${what}.locator`) as JsonObject
    }
    return {
      kind: kind as ClueCommentAnchor['kind'],
      ...(quote === undefined ? {} : { quote }),
      ...(revision === undefined ? {} : { revision }),
      ...(locator === undefined ? {} : { locator }),
    }
  }
  const errorOf = (raw: unknown, what: string): { category: ClueErrorCategory; message: string } => {
    const record = recordOf(raw, what)
    const category = record.category
    if (typeof category !== 'string' || !CLUE_ERROR_CATEGORY_SET.has(category)) {
      fail(`${what}.category must be a fixed clue error category`)
    }
    const message = requiredString(record, 'message', what)
    return { category: category as ClueErrorCategory, message }
  }
  const commentOf = (raw: unknown, what: string): ClueComment => {
    const record = recordOf(raw, what)
    const id = requiredNonBlankString(record, 'id', what)
    const kind = record.kind
    if (typeof kind !== 'string' || !COMMENT_KINDS.has(kind)) {
      fail(`${what}.kind must be "comment", "reply" or "review"`)
    }
    const format = record.format
    if (typeof format !== 'string' || !COMMENT_FORMATS.has(format)) {
      fail(`${what}.format must be "text/plain" or "text/markdown"`)
    }
    const rawBody = record.body
    let body: string
    if (typeof rawBody === 'string') body = rawBody
    else if (rawBody === undefined && kind === 'review') body = ''
    else {
      fail(`${what}.body must be a string`)
      body = ''
    }
    const author = record.author === undefined ? undefined : personOf(record.author, `${what}.author`)
    const createdAt = optionalString(record, 'createdAt', what)
    const updatedAt = optionalString(record, 'updatedAt', what)
    const url = optionalString(record, 'url', what)
    const replyToId = optionalString(record, 'replyToId', what)
    const resolved = optionalBoolean(record, 'resolved', what)
    const reviewState = optionalString(record, 'reviewState', what)
    const replyCount = optionalCount(record, 'replyCount', what)
    const nextRepliesCursor = record.nextRepliesCursor === undefined
      ? undefined
      : requiredNonBlankString(record, 'nextRepliesCursor', what)
    const anchor = record.anchor === undefined ? undefined : anchorOf(record.anchor, `${what}.anchor`)
    return {
      id,
      kind: kind as ClueComment['kind'],
      format: format as ClueComment['format'],
      body,
      ...(author === undefined ? {} : { author }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(url === undefined ? {} : { url }),
      ...(replyToId === undefined ? {} : { replyToId }),
      ...(resolved === undefined ? {} : { resolved }),
      ...(reviewState === undefined ? {} : { reviewState }),
      ...(replyCount === undefined ? {} : { replyCount }),
      ...(nextRepliesCursor === undefined ? {} : { nextRepliesCursor }),
      ...(anchor === undefined ? {} : { anchor }),
    }
  }

  const page = recordOf(value, 'discussion')
  const status = page.status
  if (typeof status !== 'string' || !DISCUSSION_STATUSES.has(status)) {
    fail('status must be "ok", "unavailable" or "not-captured"')
  }
  const itemsValue: readonly unknown[] = Array.isArray(page.items)
    ? page.items
    : fail('items must be an array')
  if (itemsValue.length > MAX_DISCUSSION_PAGE_ITEMS) {
    fail(`items must contain at most ${MAX_DISCUSSION_PAGE_ITEMS} comments`)
  }
  const fetchedAt = requiredNonBlankString(page, 'fetchedAt', 'discussion')
  if (!isDiscussionIsoTimestamp(fetchedAt)) fail('fetchedAt must be a strict ISO-8601 timestamp')
  const complete: boolean = typeof page.complete === 'boolean'
    ? page.complete
    : fail('complete must be a boolean')
  if (page.coverage !== 'document') fail('coverage must be "document"')
  const seenCommentIds = new Set<string>()
  const items = itemsValue.map((item: unknown, index: number) => {
    const comment = commentOf(item, `items[${index}]`)
    if (seenCommentIds.has(comment.id)) fail('items must not contain duplicate comment ids')
    seenCommentIds.add(comment.id)
    return comment
  })
  const nextCursor = page.nextCursor === undefined
    ? undefined
    : requiredNonBlankString(page, 'nextCursor', 'discussion')
  const total = optionalCount(page, 'total', 'discussion')
  const error = page.error === undefined ? undefined : errorOf(page.error, 'error')
  // A page may claim completeness only when no operation remains: no later
  // comment page, no reply page and no error/unavailable state.
  if (complete) {
    if (status !== 'ok') fail('complete cannot be true for an unavailable or not-captured discussion')
    if (error !== undefined) fail('complete cannot be true when the discussion carries an error')
    if (nextCursor !== undefined) fail('complete cannot be true when a comment page remains')
    if (items.some(comment => comment.nextRepliesCursor !== undefined)) {
      fail('complete cannot be true when a reply page remains')
    }
  }
  return {
    status: status as ClueDiscussionPage['status'],
    items,
    fetchedAt,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(total === undefined ? {} : { total }),
    complete,
    coverage: 'document',
    ...(error === undefined ? {} : { error }),
  }
}


/** Live source pages are smaller than complete captured discussions. */
export function normalizeClueComment(value: unknown): ClueComment {
  const item = parseClueDiscussion({ status: 'ok', items: [value], fetchedAt: '1970-01-01T00:00:00.000Z', complete: false, coverage: 'document' }).items[0]!
  const fail = (): never => { throw new ClueError('invalid-request', 'the source comment exceeds its limit or has an unsafe display field') }
  if (item.id.length > 2048 || new TextEncoder().encode(item.body).byteLength > (1 << 20)) fail()
  const checked = { ...item }
  if (item.author !== undefined) Object.assign(checked, { author: normalizeClueResourceInfo({ author: item.author }).author })
  for (const key of ['createdAt', 'updatedAt'] as const) {
    const timestamp = item[key]
    if (timestamp !== undefined) {
      if (!isDiscussionIsoTimestamp(timestamp)) fail()
      Object.assign(checked, { [key]: new Date(timestamp).toISOString() })
    }
  }
  if (item.url !== undefined) {
    let url: URL
    try { url = new URL(item.url) } catch { return fail() }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') fail()
    Object.assign(checked, { url: url.href })
  }
  if (item.anchor !== undefined && JSON.stringify(item.anchor).length > 16_384) fail()
  return checked
}
export function normalizeClueDiscussion(value: unknown): ClueDiscussionPage {
  if (!isRecord(value) || typeof value.complete !== 'boolean' || !Array.isArray(value.items) || value.items.length > 5_000) {
    throw new ClueError('invalid-request', 'the source discussion page is invalid or exceeds its limit')
  }
  // Live sources may conservatively mark an individual page complete even when
  // a nested reply cursor remains. The public envelope never echoes that claim.
  const parsed = parseClueDiscussion({ ...value, complete: false })
  const result: ClueDiscussionPage = {
    ...parsed,
    items: parsed.items.map(normalizeClueComment),
    fetchedAt: new Date(parsed.fetchedAt).toISOString(),
    complete: value.complete && parsed.status === 'ok' && parsed.error === undefined
      && parsed.nextCursor === undefined && parsed.items.every(item => item.nextRepliesCursor === undefined),
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > (8 << 20)) {
    throw new ClueError('invalid-request', 'the source discussion page exceeds its byte limit')
  }
  return result
}
