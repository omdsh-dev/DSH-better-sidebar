/**
 * The S4 Feishu vocabulary shared by the host source adapters AND the client
 * preview/editor renderers.
 *
 * This module is deliberately node-free (types, constants and pure functions
 * only) so the browser bundle can import it without pulling a `node:*` import
 * in. It owns:
 * - the two source ids and the three type ids (`docx`, `wiki`, `task`);
 * - the content format ids the client registers renderers for;
 * - the JSON shapes a read/edit returns;
 * - pure task validation / diffing shared by the form editor and the host
 *   save path, so the UI and the write path can never disagree about the
 *   start-due rule.
 *
 * Read-only docs: the lark-cli document writes that touch EXISTING content are
 * whole-command operations (`str_replace` is a global find/replace with no
 * block scope, `block_replace` rebuilds the whole block, and `append` /
 * `overwrite` / `block_delete` / `block_move_after` are explicitly forbidden
 * by the approved spec). No documented verb performs a LOSSLESS local
 * text-block update, so docs stay read-only this round instead of degrading to
 * append/overwrite. See {@link DOCS_EDIT_LIMITATION}.
 */
import { BUILTIN_SOURCE_IDS, type JsonValue } from '../../types.ts'

// ── Identities ─────────────────────────────────────────────────────────────

/** The two built-in source ids this module implements. */
export const FEISHU_SOURCE_IDS = {
  docs: BUILTIN_SOURCE_IDS.feishuDocs,
  tasks: BUILTIN_SOURCE_IDS.feishuTasks,
} as const

/** The three content type ids (docx, wiki, task) — no extra folder type. */
export const FEISHU_TYPE_IDS = {
  docx: 'builtin.feishu.docx',
  wiki: 'builtin.feishu.wiki',
  task: 'builtin.feishu.task',
} as const

/** One Feishu type id. */
export type FeishuTypeId = (typeof FEISHU_TYPE_IDS)[keyof typeof FEISHU_TYPE_IDS]

/**
 * Content format ids registered with `registerFormatRenderer`.
 *
 * XML is the default read format and the only structural document format; the
 * Markdown projection is read-only and never a save input.
 */
export const FEISHU_FORMATS = {
  docsXml: 'feishu.docs.xml',
  docsMarkdown: 'feishu.docs.markdown',
  taskDocument: 'feishu.task.document',
} as const

/** Why document editing is not offered this round (surfaced to the UI). */
export const DOCS_EDIT_LIMITATION =
  'read-only: lark-cli has no lossless local text-block update — `str_replace` is a '
  + 'whole-document find/replace with no block scope, `block_replace`/`block_delete`/'
  + '`block_move_after` rebuild or remove blocks, and append/overwrite are forbidden; this '
  + 'source does not offer a degraded write path'

/** The fixed detail shown when the lark-cli application configuration is missing. */
export const FEISHU_CONFIGURATION_DETAIL =
  'The lark-cli application is not configured. Run `lark-cli config init` in a terminal '
  + '(lark-cli drives its own interactive flow), then check the connection again.'

/** The CLI dependency / shared connection ids fixed by the S4 contract. */
export const FEISHU_DEPENDENCY_ID = 'lark.cli'
export const FEISHU_CONNECTION_ID = 'feishu.lark.auth'
export const FEISHU_CLI_COMMAND = 'lark-cli'
export const FEISHU_PLUGIN_ID = 'dsh-better-sidebar'
/** Official npm distribution (pinned; real installation is NOT verified here). */
export const LARK_CLI_PACKAGE = '@larksuite/cli'
export const LARK_CLI_VERSION = '1.0.55'

/** Capability ids the shared connection grants once authorized. */
export const FEISHU_CONNECTION_CAPABILITIES = [
  'docs.read',
  'docs.search',
  'tasks.read',
  'tasks.edit',
] as const

/** One declared connection capability. */
export type FeishuConnectionCapability = (typeof FEISHU_CONNECTION_CAPABILITIES)[number]

// ── Locators ───────────────────────────────────────────────────────────────

/** Which document surface a locator points at. */
export type FeishuDocProjection = 'xml' | 'markdown'

/** A direct Docx document reference. */
export type FeishuDocxLocator = {
  readonly kind: 'docx'
  readonly docToken: string
  /** Original browser URL, when the resource arrived through one. */
  readonly url?: string
  /** Explicit read projection; XML is the default. */
  readonly projection?: FeishuDocProjection
}

/**
 * A wiki node reference. `wikiToken` is the NODE token and must never be
 * treated as a docx token; `objToken`/`objType` are the resolved underlying
 * object (only `docx` objects are supported as documents).
 */
export type FeishuWikiLocator = {
  readonly kind: 'wiki'
  readonly wikiToken: string
  readonly objToken?: string
  readonly objType?: string
  readonly spaceId?: string
  readonly url?: string
  readonly projection?: FeishuDocProjection
}

/** A wiki SPACE is a browsing scope, not a document (list picker only). */
export type FeishuWikiSpaceLocator = {
  readonly kind: 'wiki-space'
  readonly spaceId: string
  readonly url?: string
}

/**
 * A Drive FOLDER is a browsing scope, not a document. It carries the folder
 * token needed to list the direct children of one level; the user must choose
 * the folder explicitly to descend (no recursive scan).
 */
export type FeishuDriveFolderLocator = {
  readonly kind: 'drive-folder'
  readonly folderToken: string
  readonly url?: string
}

/** One document-surface locator (docx, wiki node, wiki space or Drive scope row). */
export type FeishuDocLocator =
  | FeishuDocxLocator
  | FeishuWikiLocator
  | FeishuWikiSpaceLocator
  | FeishuDriveFolderLocator

/** One task locator: the OpenAPI GUID, never the display number. */
export type FeishuTaskLocator = {
  readonly kind: 'task'
  readonly guid: string
  readonly url?: string
}

// ── Content data ───────────────────────────────────────────────────────────

/** The `data` of one document read. */
export type FeishuDocReadData = {
  readonly kind: 'docx' | 'wiki'
  readonly title: string
  readonly projection: FeishuDocProjection
  readonly content: string
  readonly docToken: string
  readonly wikiToken?: string
  readonly objToken?: string
  readonly objType?: string
  readonly sourceUrl?: string
  readonly revisionId?: string
  /** Structured reference sidecar returned WITH the content by `docs +fetch`. */
  readonly referenceMap?: JsonValue
}

/** One task time. `timestamp` is an epoch-millisecond instant; `isAllDay` keeps the task's own semantics. */
export type FeishuTaskTime = {
  readonly timestamp: string
  readonly isAllDay: boolean
}

/** The `data` of one task read / edit document. */
export type FeishuTaskDocumentData = {
  readonly kind: 'task'
  readonly guid: string
  readonly title: string
  readonly description: string
  readonly start: FeishuTaskTime | null
  readonly due: FeishuTaskTime | null
  readonly completed: boolean
  readonly completedAt?: string
  readonly updatedAt?: string
  readonly url?: string
}

/** One field-level validation failure the form can render. */
export type FeishuTaskField = 'title' | 'description' | 'start' | 'due' | 'completed'

/** One validation failure. */
export interface FeishuTaskValidationError {
  readonly field: FeishuTaskField
  readonly message: string
}

// ── JSON helpers ───────────────────────────────────────────────────────────

/** Whether a value is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string field, or undefined. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** A finite number or numeric string as a millisecond value. */
export function millisOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Strip the CLI's highlight tags from a search title. */
export function stripHighlight(value: string): string {
  return value.replace(/<\/?hb?>/gi, '')
}

// ── Document / task parsing ────────────────────────────────────────────────

/** A stable display title when the response carries no title. */
export function fallbackTitle(token: string): string {
  const tail = token.length > 10 ? token.slice(-10) : token
  return `Feishu document ${tail}`
}

/** Parse the `{ timestamp, is_all_day }` shape used by the task API. */
function parseTaskTime(value: unknown): FeishuTaskTime | null | undefined {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) return undefined
  const timestamp = millisOf(value.timestamp)
  if (timestamp === undefined) return undefined
  const isAllDay = value.is_all_day === true || value.isAllDay === true
  return { timestamp: String(timestamp), isAllDay }
}

/** Whether a task record says it is completed. */
function completedOf(record: Record<string, JsonValue>): boolean {
  if (typeof record.completed === 'boolean') return record.completed
  if (record.completed_at !== undefined) {
    const completedAt = millisOf(record.completed_at)
    return completedAt !== undefined && completedAt > 0
  }
  return record.status === 'done' || record.status === 'completed'
}

/**
 * Project one lark task record into the source-owned document shape.
 * @param value - the task object from `task tasks get` (or a list row).
 * @param fallbackGuid - locator GUID used when the record omits it.
 * @returns the document, or undefined when the record is not an object.
 */
export function parseTaskDocument(value: JsonValue, fallbackGuid: string): FeishuTaskDocumentData | undefined {
  if (!isRecord(value)) return undefined
  const guid = stringOf(value.guid) ?? fallbackGuid
  const title = stringOf(value.summary) ?? stringOf(value.title) ?? ''
  const description = typeof value.description === 'string' ? value.description : ''
  const start = parseTaskTime(value.start)
  const due = parseTaskTime(value.due)
  const completedAt = millisOf(value.completed_at)
  const updatedAt = value.updated_at === undefined ? undefined : String(value.updated_at)
  const url = stringOf(value.url) ?? stringOf(value.applink)
  return {
    kind: 'task',
    guid,
    title,
    description,
    start: start === undefined ? null : start,
    due: due === undefined ? null : due,
    completed: completedOf(value),
    ...(completedAt === undefined || completedAt <= 0 ? {} : { completedAt: String(completedAt) }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(url === undefined ? {} : { url }),
  }
}

/**
 * Render the model-facing text projection of one task.
 * @param task - the task document.
 */
export function taskText(task: FeishuTaskDocumentData): string {
  const lines = [
    `# ${task.title}`,
    '',
    `Status: ${task.completed ? 'completed' : 'open'}`,
    `GUID: ${task.guid}`,
  ]
  if (task.start !== null) lines.push(`Start: ${task.start.timestamp}${task.start.isAllDay ? ' (all day)' : ''}`)
  if (task.due !== null) lines.push(`Due: ${task.due.timestamp}${task.due.isAllDay ? ' (all day)' : ''}`)
  if (task.updatedAt !== undefined) lines.push(`Updated: ${task.updatedAt}`)
  if (task.description !== '') {
    lines.push('', task.description)
  }
  return lines.join('\n')
}

/** Parse a document read payload from `data` (tolerant; returns undefined on garbage). */
export function parseDocReadData(value: JsonValue): FeishuDocReadData | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind === 'wiki' ? 'wiki' : value.kind === 'docx' ? 'docx' : undefined
  const docToken = stringOf(value.docToken)
  const title = typeof value.title === 'string' ? value.title : undefined
  const content = typeof value.content === 'string' ? value.content : undefined
  const projection = value.projection === 'markdown' ? 'markdown' : value.projection === 'xml' ? 'xml' : undefined
  if (kind === undefined || docToken === undefined || title === undefined || content === undefined || projection === undefined) {
    return undefined
  }
  return {
    kind,
    title,
    projection,
    content,
    docToken,
    ...(stringOf(value.wikiToken) === undefined ? {} : { wikiToken: stringOf(value.wikiToken) }),
    ...(stringOf(value.objToken) === undefined ? {} : { objToken: stringOf(value.objToken) }),
    ...(stringOf(value.objType) === undefined ? {} : { objType: stringOf(value.objType) }),
    ...(stringOf(value.sourceUrl) === undefined ? {} : { sourceUrl: stringOf(value.sourceUrl) }),
    ...(value.revisionId === undefined ? {} : { revisionId: String(value.revisionId) }),
    ...(value.referenceMap === undefined ? {} : { referenceMap: value.referenceMap }),
  }
}

// ── Task validation and diffing (shared by UI + host) ──────────────────────

/** Local start <= due validation, preserving each time's all-day semantics. */
export function validateTaskDocument(data: FeishuTaskDocumentData): FeishuTaskValidationError[] {
  const errors: FeishuTaskValidationError[] = []
  if (typeof data.title !== 'string' || data.title.trim() === '') {
    errors.push({ field: 'title', message: 'A task title is required.' })
  }
  for (const [field, time] of [['start', data.start], ['due', data.due]] as const) {
    if (time !== null && millisOf(time.timestamp) === undefined) {
      errors.push({ field, message: 'This time is not a valid instant.' })
    }
  }
  if (data.start !== null && data.due !== null) {
    const start = millisOf(data.start.timestamp)
    const due = millisOf(data.due.timestamp)
    if (start !== undefined && due !== undefined && start > due) {
      errors.push({ field: 'due', message: 'The start must not be later than the due time.' })
    }
  }
  return errors
}

/** The API-shaped time payload (`is_all_day`, string timestamp). */
export function taskTimePayload(time: FeishuTaskTime): Record<string, JsonValue> {
  return { timestamp: time.timestamp, is_all_day: time.isAllDay }
}

/** The fields an update may carry; only changed ones are ever sent. */
export interface FeishuTaskUpdatePayload {
  readonly summary?: string
  readonly description?: string
  readonly start?: Record<string, JsonValue>
  readonly due?: Record<string, JsonValue>
}

/** Same JSON value (order-insensitive for plain objects). */
function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => sameJson(item, right[index]))
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key, index) =>
      key === rightKeys[index] && sameJson((left as Record<string, JsonValue>)[key], (right as Record<string, JsonValue>)[key]))
  }
  return false
}

/** Time payload equality, including the all-day flag. */
function sameTime(left: FeishuTaskTime | null, right: FeishuTaskTime | null): boolean {
  if (left === null || right === null) return left === right
  return left.timestamp === right.timestamp && left.isAllDay === right.isAllDay
}

/**
 * Build the update payload for the fields the user actually changed.
 * @param current - the freshly re-read server task (baseline).
 * @param edited - the submitted document.
 * @throws {Error} when a previously set time is cleared (unsupported here).
 */
export function taskUpdatePayload(
  current: FeishuTaskDocumentData,
  edited: FeishuTaskDocumentData,
): FeishuTaskUpdatePayload {
  const summary = edited.title.trim()
  const changedSummary = summary !== current.title.trim() ? summary : undefined
  const changedDescription = edited.description !== current.description ? edited.description : undefined
  if (current.start !== null && edited.start === null) {
    throw new Error('clearing a start time is not supported')
  }
  if (current.due !== null && edited.due === null) {
    throw new Error('clearing a due time is not supported')
  }
  const changedStart = !sameTime(current.start, edited.start) && edited.start !== null
    ? taskTimePayload(edited.start)
    : undefined
  const changedDue = !sameTime(current.due, edited.due) && edited.due !== null
    ? taskTimePayload(edited.due)
    : undefined
  return {
    ...(changedSummary === undefined ? {} : { summary: changedSummary }),
    ...(changedDescription === undefined ? {} : { description: changedDescription }),
    ...(changedStart === undefined ? {} : { start: changedStart }),
    ...(changedDue === undefined ? {} : { due: changedDue }),
  }
}

/** The changed API field names of one update payload (ordered). */
export function taskUpdateFields(payload: FeishuTaskUpdatePayload): string[] {
  const fields: string[] = []
  if (payload.summary !== undefined) fields.push('summary')
  if (payload.description !== undefined) fields.push('description')
  if (payload.start !== undefined) fields.push('start')
  if (payload.due !== undefined) fields.push('due')
  return fields
}

/** Whether one payload field is confirmed by the CLI's `confirmed` object. */
export function taskFieldConfirmed(payload: FeishuTaskUpdatePayload, field: string, confirmed: JsonValue): boolean {
  if (!isRecord(confirmed)) return false
  const expected = (payload as Record<string, JsonValue | undefined>)[field]
  return sameJson(expected, confirmed[field])
}
