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
 * Editing: the docs source edits ONLY text blocks through lark-cli's native
 * block-scoped `docs +update block_replace` (the target block id comes from
 * `docs +fetch --detail full`). Tables, callouts, grids, images and other
 * complex containers stay read-only because rebuilding them is not a lossless
 * text-block operation. Markdown remains a read-only projection and is never a
 * save input. See {@link DOCS_EDIT_SCOPE_NOTE}.
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

/** Which text-block surfaces the editor supports (surfaced to the UI). */
export const DOCS_EDIT_SCOPE_NOTE =
  'Only text blocks are editable (title, paragraphs, headings, lists, todos, quotes and code); '
  + 'tables, callouts, grids, images and other complex blocks stay read-only. '
  + 'Markdown is a read-only projection and never a save input.'

/**
 * The fixed detail shown when the lark-cli application configuration is missing.
 *
 * The pinned CLI's `config init --new` blocks until the browser flow finishes
 * and prints a verification URL before blocking. The S2 CLI runtime exposes only
 * a buffered run-to-exit call, so this adapter cannot stream that URL back to
 * the settings row; the explicit action stays the CLI's own flow in a terminal
 * (the user runs `config init --new`, opens the URL, and returns here).
 */
export const FEISHU_CONFIGURATION_DETAIL =
  'The lark-cli application is not configured. Run `lark-cli config init --new` in a terminal '
  + '(lark-cli blocks on its own browser flow), then check the connection again.'

/** The CLI dependency / shared connection ids fixed by the S4 contract. */
export const FEISHU_DEPENDENCY_ID = 'lark.cli'
export const FEISHU_CONNECTION_ID = 'feishu.lark.auth'
export const FEISHU_CLI_COMMAND = 'lark-cli'
export const FEISHU_PLUGIN_ID = 'dsh-better-sidebar'
/** Official npm distribution (pinned; real installation is NOT verified here). */
export const LARK_CLI_PACKAGE = '@larksuite/cli'
export const LARK_CLI_VERSION = '1.0.55'

/**
 * Capability ids the shared connection grants once authorized.
 *
 * `docs.edit` and `wiki.read` are separate capabilities on purpose: a
 * read-only Docx grant must not advertise document writes, and the wiki
 * shortcuts (`wiki +node-get` / `+node-list` / `+space-list`) need their own
 * `wiki:*` scopes, which the `docs`/`drive` domains do not include.
 */
export const FEISHU_CONNECTION_CAPABILITIES = [
  'docs.read',
  'docs.search',
  'docs.edit',
  'wiki.read',
  'tasks.read',
  'tasks.edit',
] as const

/** The `meta.role` marker of a browsing-range candidate (folder/wiki space). */
export const FEISHU_SCOPE_ROLE = 'scope'

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
  /**
   * Present when `content` is one window of a longer document: `blocks` means
   * only complete top-level XML blocks were included, `bytes` means the window
   * is a raw byte slice (a single block larger than the read window). Absent
   * means the content is the whole document.
   */
  readonly fragment?: 'blocks' | 'bytes'
}

/**
 * One editable text block of the XML edit model.
 *
 * `text` is the block's INNER XML (for title/code it is plain text). Sending
 * the inner XML back inside the original outer tag preserves inline styles and
 * unknown inline markup when the caller does not touch it. `baseline` is what
 * `loadEdit` returned; a save only writes blocks whose `text` differs.
 */
export interface FeishuDocEditBlock {
  /** The lark-cli block id (`--block-id` of `docs +update`). */
  readonly id: string
  /** Outer XML tag (`p`, `h1`…`h9`, `li`, `checkbox`, `blockquote`, `pre`). */
  readonly tag: string
  /** Original outer attributes EXCEPT `id` (align/done/lang/caption/…). */
  readonly attrs: string
  /** Editable inner XML (plain text for title/code blocks). */
  readonly text: string
  /** The text as loaded; used both for change detection and lossless diffs. */
  readonly baseline: string
  /**
   * `plain` — `text` is escaped plain text (title/code);
   * `xml` — `text` is inner XML whose inline tags are preserved verbatim.
   */
  readonly kind: 'plain' | 'xml'
  /** Position in the document, used only to interleave read-only blocks. */
  readonly order: number
}

/** The `data` of one document edit load (`docs +fetch --detail full`). */
export interface FeishuDocEditData {
  readonly kind: 'docx' | 'wiki'
  readonly docToken: string
  readonly wikiToken?: string
  readonly objToken?: string
  readonly objType?: string
  readonly sourceUrl?: string
  readonly revisionId?: string
  readonly title: string
  /** The title exactly as loaded; a save compares against this baseline. */
  readonly baselineTitle: string
  /** Editable only when `docs +fetch --detail full` gave the title block an id. */
  readonly titleEditable: boolean
  readonly titleBlockId?: string
  readonly titleAttrs: string
  readonly blocks: readonly FeishuDocEditBlock[]
  /** Complex containers kept verbatim (read-only), in document order. */
  readonly readOnlyBlocks: readonly FeishuDocReadOnlyBlock[]
}

/** One non-editable block (complex container/resource) kept for context. */
export interface FeishuDocReadOnlyBlock {
  readonly tag: string
  /** Outer attributes EXCEPT `id` (the resource URL/token lives here). */
  readonly attrs: string
  /** Plain text projection of the block, for display only. */
  readonly text: string
  readonly reason: string
  /** Position in the document, used to interleave with editable blocks. */
  readonly order: number
  /** A safe http(s) origin of the block (image/file/whiteboard link), when present. */
  readonly url?: string
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

/** Stable validation codes the client maps to localized copy. */
export type FeishuTaskValidationCode =
  | 'title-required'
  | 'invalid-time'
  | 'start-after-due'
  | 'all-day-mismatch'

/** One validation failure. */
export interface FeishuTaskValidationError {
  readonly field: FeishuTaskField
  readonly code: FeishuTaskValidationCode
  /** English fallback used by the host (the client renders the code). */
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
 *
 * The GUID is part of the task identity, so a record without a non-empty GUID
 * is not a task document. There is deliberately no caller-supplied fallback:
 * a malformed `task tasks get` answer must be an error, never a blank task
 * fabricated from the requested locator.
 * @param value - the task object from `task tasks get` (or a list row).
 * @returns the document, or undefined when the record is not an object/`guid`.
 */
export function parseTaskDocument(value: JsonValue): FeishuTaskDocumentData | undefined {
  if (!isRecord(value)) return undefined
  const guid = stringOf(value.guid)
  if (guid === undefined) return undefined
  const title = stringOf(value.summary) ?? stringOf(value.title) ?? ''
  const description = typeof value.description === 'string' ? value.description : ''
  const start = parseTaskTime(value.start)
  const due = parseTaskTime(value.due)
  const completedAt = millisOf(value.completed_at ?? value.completedAt)
  const updatedAtValue = value.updated_at ?? value.updatedAt
  const updatedAt = updatedAtValue === undefined ? undefined : String(updatedAtValue)
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
  const fragment = value.fragment === 'blocks' || value.fragment === 'bytes' ? value.fragment : undefined
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
    ...(fragment === undefined ? {} : { fragment }),
  }
}

/** Parse one editable block (tolerant; a malformed row makes the document invalid). */
function parseEditBlock(value: JsonValue, index: number): FeishuDocEditBlock | undefined {
  if (!isRecord(value)) return undefined
  const id = stringOf(value.id)
  const tag = stringOf(value.tag)
  const text = typeof value.text === 'string' ? value.text : undefined
  const baseline = typeof value.baseline === 'string' ? value.baseline : undefined
  const kind = value.kind === 'plain' ? 'plain' : value.kind === 'xml' ? 'xml' : undefined
  if (id === undefined || tag === undefined || text === undefined || baseline === undefined || kind === undefined) {
    return undefined
  }
  return {
    id,
    tag,
    attrs: typeof value.attrs === 'string' ? value.attrs : '',
    text,
    baseline,
    kind,
    order: typeof value.order === 'number' && Number.isInteger(value.order) ? value.order : index,
  }
}

/**
 * Parse the `data` of one document edit load (the shape `FeishuDocsEditor`
 * consumes). Returns undefined for a read payload, so the renderer can dispatch
 * safely on the data shape.
 * @param value - the edit document's data.
 */
export function parseDocEditData(value: JsonValue): FeishuDocEditData | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind === 'wiki' ? 'wiki' : value.kind === 'docx' ? 'docx' : undefined
  const docToken = stringOf(value.docToken)
  const title = typeof value.title === 'string' ? value.title : undefined
  const baselineTitle = typeof value.baselineTitle === 'string' ? value.baselineTitle : undefined
  if (kind === undefined || docToken === undefined || title === undefined || baselineTitle === undefined) {
    return undefined
  }
  if (!Array.isArray(value.blocks) || !Array.isArray(value.readOnlyBlocks)) return undefined
  const blocks: FeishuDocEditBlock[] = []
  for (const row of value.blocks) {
    const block = parseEditBlock(row, blocks.length)
    if (block === undefined) return undefined
    blocks.push(block)
  }
  const readOnlyBlocks: FeishuDocReadOnlyBlock[] = []
  for (const row of value.readOnlyBlocks) {
    if (!isRecord(row)) return undefined
    const tag = stringOf(row.tag)
    const text = typeof row.text === 'string' ? row.text : undefined
    const reason = stringOf(row.reason)
    if (tag === undefined || text === undefined || reason === undefined) return undefined
    readOnlyBlocks.push({
      tag,
      attrs: typeof row.attrs === 'string' ? row.attrs : '',
      text,
      reason,
      order: typeof row.order === 'number' && Number.isInteger(row.order)
        ? row.order
        : blocks.length + readOnlyBlocks.length,
      ...(stringOf(row.url) === undefined ? {} : { url: stringOf(row.url) }),
    })
  }
  return {
    kind,
    docToken,
    ...(stringOf(value.wikiToken) === undefined ? {} : { wikiToken: stringOf(value.wikiToken) }),
    ...(stringOf(value.objToken) === undefined ? {} : { objToken: stringOf(value.objToken) }),
    ...(stringOf(value.objType) === undefined ? {} : { objType: stringOf(value.objType) }),
    ...(stringOf(value.sourceUrl) === undefined ? {} : { sourceUrl: stringOf(value.sourceUrl) }),
    ...(value.revisionId === undefined ? {} : { revisionId: String(value.revisionId) }),
    title,
    baselineTitle,
    titleEditable: value.titleEditable === true,
    ...(stringOf(value.titleBlockId) === undefined ? {} : { titleBlockId: stringOf(value.titleBlockId) }),
    titleAttrs: typeof value.titleAttrs === 'string' ? value.titleAttrs : '',
    blocks,
    readOnlyBlocks,
  }
}

// ── Task validation and diffing (shared by UI + host) ──────────────────────

/** Local start <= due and same-all-day validation, preserving each time's semantics. */
export function validateTaskDocument(data: FeishuTaskDocumentData): FeishuTaskValidationError[] {
  const errors: FeishuTaskValidationError[] = []
  if (typeof data.title !== 'string' || data.title.trim() === '') {
    errors.push({ field: 'title', code: 'title-required', message: 'A task title is required.' })
  }
  for (const [field, time] of [['start', data.start], ['due', data.due]] as const) {
    if (time !== null && millisOf(time.timestamp) === undefined) {
      errors.push({ field, code: 'invalid-time', message: 'This time is not a valid instant.' })
    }
  }
  if (data.start !== null && data.due !== null) {
    const start = millisOf(data.start.timestamp)
    const due = millisOf(data.due.timestamp)
    if (start !== undefined && due !== undefined && start > due) {
      errors.push({ field: 'due', code: 'start-after-due', message: 'The start must not be later than the due time.' })
    }
    // `task.tasks.patch` requires both times to agree on is_all_day when both
    // are set; a mixed pair is rejected by the server as a generic invalid
    // request, so the form and the save path must reject it locally.
    if (data.start.isAllDay !== data.due.isAllDay) {
      errors.push({
        field: 'due',
        code: 'all-day-mismatch',
        message: 'The start and due times must both be all-day or both be timed.',
      })
    }
  }
  return errors
}

/** The API-shaped time payload (`is_all_day`, string timestamp). */
export function taskTimePayload(time: FeishuTaskTime): Record<string, JsonValue> {
  return { timestamp: time.timestamp, is_all_day: time.isAllDay }
}

/**
 * The `task.tasks.patch` body of one update.
 *
 * `task` carries only the changed values; `updateFields` lists every changed
 * name. A time the user CLEARED is listed in `updateFields` but omitted from
 * `task` — that is the API's documented way to clear a field. It is also why
 * this cannot use the `task +update` shortcut's `--data`: that shortcut treats
 * every key in `--data` as an update field and cannot express a field that is
 * named but absent.
 */
export interface FeishuTaskUpdatePayload {
  readonly task: {
    readonly summary?: string
    readonly description?: string
    readonly start?: Record<string, JsonValue>
    readonly due?: Record<string, JsonValue>
  }
  readonly updateFields: readonly string[]
}

/** Time payload equality, including the all-day flag. */
function sameTime(left: FeishuTaskTime | null, right: FeishuTaskTime | null): boolean {
  if (left === null || right === null) return left === right
  return left.timestamp === right.timestamp && left.isAllDay === right.isAllDay
}

/** Build the update body for the fields the user actually changed. */
export function taskUpdatePayload(
  current: FeishuTaskDocumentData,
  edited: FeishuTaskDocumentData,
): FeishuTaskUpdatePayload {
  const summary = edited.title.trim()
  const fields: string[] = []
  const task: {
    summary?: string
    description?: string
    start?: Record<string, JsonValue>
    due?: Record<string, JsonValue>
  } = {}
  if (summary !== current.title.trim()) {
    task.summary = summary
    fields.push('summary')
  }
  if (edited.description !== current.description) {
    task.description = edited.description
    fields.push('description')
  }
  if (!sameTime(current.start, edited.start)) {
    fields.push('start')
    // A cleared time is named in update_fields but leaves no `task` value.
    if (edited.start !== null) task.start = taskTimePayload(edited.start)
  }
  if (!sameTime(current.due, edited.due)) {
    fields.push('due')
    if (edited.due !== null) task.due = taskTimePayload(edited.due)
  }
  return { task, updateFields: fields }
}

/** The changed API field names of one update payload (ordered). */
export function taskUpdateFields(payload: FeishuTaskUpdatePayload): string[] {
  return [...payload.updateFields]
}

/** Read one expected `{timestamp,is_all_day}` payload as a task time. */
function expectedTimeOf(value: JsonValue | undefined): FeishuTaskTime | null | undefined {
  if (value === undefined) return null
  if (!isRecord(value)) return undefined
  const timestamp = millisOf(value.timestamp)
  if (timestamp === undefined) return undefined
  return { timestamp: String(timestamp), isAllDay: value.is_all_day === true }
}

/**
 * Check the task object the native PATCH returned against every changed field.
 * The native command returns `{task}`; that object is the server confirmation,
 * so a missing/mismatched field is never reported as success.
 * @returns the first field the answer did not confirm, or undefined when all match.
 */
export function taskUpdateUnconfirmedField(
  payload: FeishuTaskUpdatePayload,
  returned: FeishuTaskDocumentData,
): string | undefined {
  for (const field of payload.updateFields) {
    if (field === 'summary') {
      if (returned.title.trim() !== payload.task.summary) return field
      continue
    }
    if (field === 'description') {
      if (returned.description !== payload.task.description) return field
      continue
    }
    if (field === 'start' || field === 'due') {
      const expected = expectedTimeOf(payload.task[field])
      if (expected === undefined || !sameTime(expected, field === 'start' ? returned.start : returned.due)) {
        return field
      }
      continue
    }
    return field
  }
  return undefined
}
