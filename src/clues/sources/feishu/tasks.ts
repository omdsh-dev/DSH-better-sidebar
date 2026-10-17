/**
 * `builtin.feishu.tasks`: single-page task browsing/search, latest reads and
 * field-level editing through the official task commands.
 *
 * Commands (official, single page only):
 * - list: native `task tasks list` (or `task tasklists tasks` for an explicit
 *   tasklist range), continued only with the returned `page_token`;
 * - search: `task +search` with the documented keyword/completed/assignee/
 *   creator/follower/due filters, an explicit `--page-token` and
 *   `--page-limit 1` (the only documented way to bound it to a single page;
 *   the caller's `limit` cannot set items per page because the CLI exposes no
 *   `--page-size` for `+search`). A tasklist is a LIST range, not a documented
 *   search filter, so a tasklist search is rejected instead of silently
 *   widening to the global corpus;
 * - read: `task tasks get` by GUID;
 * - edit: native `task tasks patch` with ONLY the changed fields, then
 *   completion/reopen as a SEPARATE `task +complete` / `task +reopen` call.
 *   The native PATCH returns the updated task, which confirms each changed
 *   field and can express clearing a time (`update_fields` names it while
 *   `task` omits it); the `+update` shortcut cannot express that clear and
 *   returns only `{guid,url}`. A field save still does a best-effort fresh read
 *   for the next baseline (never a CAS claim).
 *
 * The auto-paginating shortcuts (`+get-my-tasks` / `+get-related-tasks`) and
 * `--page-all` are never used: they silently loop up to 20–40 pages, which the
 * approved spec forbids for this source.
 *
 * Identity: the task GUID is the ONLY locator. A displayed number (`t104121`)
 * is rejected in parsing, read, update and portable paths. Completion is never
 * mixed into the field PATCH; a partially applied save is reported as partial
 * and keeps the draft.
 */
import { ClueError } from '../../types.ts'
import type {
  ClueCandidate,
  ClueEditDocument,
  ClueListResult,
  ClueOperationContext,
  CluePortableRef,
  ClueReadResult,
  ClueSaveEditInput,
  ClueSaveEditResult,
  ClueTypeDescriptor,
  JsonValue,
  Locator,
} from '../../types.ts'
import type {
  ClueSourceListInput,
  ClueSourceReadInput,
  ClueSourceRegistration,
  ClueSourceSaveInput,
  ClueSourceSearchInput,
} from '../../service.ts'
import type { ClueRuntime } from '../../runtime/types.ts'
import { decodeCursor, encodeCursor, stableJson } from './cursor.ts'
import {
  FEISHU_CONNECTION_ID,
  FEISHU_DEPENDENCY_ID,
  FEISHU_FORMATS,
  FEISHU_PLUGIN_ID,
  FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS,
  isRecord,
  parseTaskDocument,
  stringOf,
  stripHighlight,
  taskText,
  taskUpdateFields,
  taskUpdatePayload,
  taskUpdateUnconfirmedField,
  validateTaskDocument,
  type FeishuTaskDocumentData,
  type FeishuTaskUpdatePayload,
} from './format.ts'
import {
  larkWorkingDirectory,
  stringField,
  type LarkSuccess,
} from './lark.ts'
import { runFeishuCommand } from './auth.ts'
import {
  hostOf,
  isDisplayTaskId,
  normalizeTaskLocator,
  parseFeishuTaskText,
  parseTaskLocator,
  taskLocatorKey,
} from './urls.ts'

/** One task page from the provider (never an automatic multi-page walk). */
const TASK_PAGE_SIZE = 20
/** Bound of the `--data` payload handed to the CLI in argv. */
const MAX_TASK_UPDATE_BYTES = 32 * 1024

/** The browsing range of the task source. */
export type TasksScope = {
  readonly kind: 'tasks'
  readonly tasklistGuid?: string
  readonly completed?: boolean
}

/**
 * The search range: the documented `task +search` filters. A tasklist is NOT
 * a search filter (the CLI has no tasklist argument for `+search`), so it is
 * rejected instead of silently returning global results.
 */
export type TaskSearchScope = {
  readonly kind: 'tasks'
  readonly completed?: boolean
  readonly assignee?: string
  readonly creator?: string
  readonly follower?: string
  readonly due?: string
}

/** Bound of one open-id / due-range filter argument. */
const MAX_SEARCH_FILTER_CHARS = 500

/** Page-size bound of one explicit page. */
function pageLimitOf(limit: number | undefined): number {
  if (limit === undefined) return TASK_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ClueError('invalid-request', 'the page size must be a positive integer')
  }
  return Math.min(limit, TASK_PAGE_SIZE)
}

/** The CLI process cwd (never the resource scope). */
function cwdOf(context: ClueOperationContext): string {
  return larkWorkingDirectory(context.workspacePath)
}

/** Whether a value contains ASCII control characters (never valid in an argv filter). */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** One non-empty, bounded search filter (argv-only; never a shell string). */
function searchFilterOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ClueError('invalid-request', `a task search "${field}" filter must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SEARCH_FILTER_CHARS || hasControlCharacters(trimmed)) {
    throw new ClueError('invalid-request', `a task search "${field}" filter is invalid`)
  }
  return trimmed
}

/** Parse one task list range; the default is the user's task list (an explicit range choice). */
export function parseFeishuTasksScope(value: JsonValue | undefined): TasksScope {
  if (value === undefined) return { kind: 'tasks' }
  if (!isRecord(value)) throw new ClueError('invalid-request', 'a task range must be a JSON object')
  if (value.kind !== undefined && value.kind !== 'tasks') {
    throw new ClueError('invalid-request', 'unknown Feishu task range')
  }
  if (value.completed !== undefined && typeof value.completed !== 'boolean') {
    throw new ClueError('invalid-request', 'a task range "completed" filter must be a boolean')
  }
  for (const field of ['assignee', 'creator', 'follower', 'due'] as const) {
    if (value[field] !== undefined) {
      throw new ClueError(
        'invalid-request',
        `a task list range does not support the "${field}" filter; use task search`,
      )
    }
  }
  if (value.tasklistGuid !== undefined && stringOf(value.tasklistGuid) === undefined) {
    throw new ClueError('invalid-request', 'a tasklist range needs a non-empty tasklist GUID')
  }
  return {
    kind: 'tasks',
    ...(stringOf(value.tasklistGuid) === undefined ? {} : { tasklistGuid: stringOf(value.tasklistGuid) }),
    ...(value.completed === undefined ? {} : { completed: value.completed }),
  }
}

/** Parse one task search scope; only the filters `task +search` documents. */
export function parseFeishuTaskSearchScope(value: JsonValue | undefined): TaskSearchScope {
  if (value === undefined) return { kind: 'tasks' }
  if (!isRecord(value)) throw new ClueError('invalid-request', 'a task search range must be a JSON object')
  if (value.kind !== undefined && value.kind !== 'tasks') {
    throw new ClueError('invalid-request', 'unknown Feishu task range')
  }
  if (value.tasklistGuid !== undefined) {
    throw new ClueError(
      'invalid-request',
      'a Feishu task search cannot filter by tasklist; use the task list range instead',
    )
  }
  if (value.completed !== undefined && typeof value.completed !== 'boolean') {
    throw new ClueError('invalid-request', 'a task search "completed" filter must be a boolean')
  }
  const assignee = searchFilterOf(value.assignee, 'assignee')
  const creator = searchFilterOf(value.creator, 'creator')
  const follower = searchFilterOf(value.follower, 'follower')
  const due = searchFilterOf(value.due, 'due')
  return {
    kind: 'tasks',
    ...(value.completed === undefined ? {} : { completed: value.completed }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(creator === undefined ? {} : { creator }),
    ...(follower === undefined ? {} : { follower }),
    ...(due === undefined ? {} : { due }),
  }
}

/** Decode a caller cursor against the exact range/query that minted it. */
function pageTokenOf(signature: string, cursor: string | undefined): string | undefined {
  return cursor === undefined ? undefined : decodeCursor(signature, cursor).pageToken
}

/**
 * The next task cursor, or a `limited` marker when the provider truncated but
 * gave no token. `has_more:false` wins over a stale/echoed token.
 */
function pageOf(success: LarkSuccess, signature: string): { readonly nextCursor?: string; readonly limited?: boolean } {
  const hasMore = typeof success.data.has_more === 'boolean' ? success.data.has_more : undefined
  const token = stringField(success.data, 'page_token') ?? stringField(success.data, 'next_page_token')
  if (hasMore !== false && token !== undefined && token !== '') {
    return { nextCursor: encodeCursor(signature, token) }
  }
  return hasMore === true ? { limited: true } : {}
}

/**
 * The rows of one task list/search answer.
 *
 * lark-cli 1.0.55 returns `items` for native `task tasks list`,
 * `tasklists tasks` AND `task +search` (the shortcut's Go source builds
 * `{items, page_token, has_more}`). A success envelope without that array is a
 * malformed answer, never a complete empty page.
 */
function taskRows(success: LarkSuccess): JsonValue[] {
  const value = success.data.items
  if (Array.isArray(value)) return value
  throw new ClueError('failed', 'lark-cli returned no task list in its success payload')
}

/** Build one candidate from a task record. */
function taskCandidate(row: JsonValue): ClueCandidate | undefined {
  if (!isRecord(row)) return undefined
  const guid = stringOf(row.guid)
  if (guid === undefined || isDisplayTaskId(guid)) return undefined
  const task = parseTaskDocument(row)
  if (task === undefined) return undefined
  const title = task.title.trim() === '' ? `Feishu task ${guid.slice(0, 8)}` : task.title
  return {
    sourceId: FEISHU_SOURCE_IDS.tasks,
    typeId: FEISHU_TYPE_IDS.task,
    locator: { kind: 'task', guid, ...(task.url === undefined ? {} : { url: task.url }) } as unknown as Locator,
    title: stripHighlight(title),
    subtitle: task.completed ? 'Completed' : 'Open',
    meta: {
      completed: task.completed,
      ...(task.start === null ? {} : { start: task.start.timestamp }),
      ...(task.due === null ? {} : { due: task.due.timestamp }),
      ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
    },
  }
}

/** Read one task's latest fields by GUID. */
async function readTask(
  runtime: ClueRuntime,
  guid: string,
  context: ClueOperationContext,
): Promise<FeishuTaskDocumentData> {
  const success = await runFeishuCommand(runtime, {
    args: [
      'task', 'tasks', 'get',
      '--params', JSON.stringify({ task_guid: guid }),
      '--as', 'user', '--format', 'json',
    ],
    cwd: cwdOf(context),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  // The task object is `data.task`; a direct object is accepted only when it
  // carries a matching non-empty GUID. `{}`, `{task:null}` and a task for a
  // different GUID are failures, never a blank document with the requested id.
  const data = success.data
  const sourceRecord = isRecord(data.task)
    ? data.task
    : typeof data.guid === 'string' && data.guid.trim() !== ''
      ? data
      : undefined
  if (sourceRecord === undefined) {
    throw new ClueError('failed', 'lark-cli returned no task object in its success payload')
  }
  const document = parseTaskDocument(sourceRecord)
  if (document === undefined) {
    throw new ClueError('failed', 'lark-cli returned an unreadable task payload')
  }
  if (document.guid !== guid) {
    throw new ClueError('failed', 'lark-cli returned a different task than the requested GUID')
  }
  return document
}

/**
 * The confirmation view of one native `task.tasks.patch` answer.
 *
 * The pinned 1.0.55 native command returns the full updated task under
 * `data.task`; unlike the `task +update` shortcut it does not return
 * `updated_fields`/`confirmed` (those fields do not exist in this CLI
 * version). The returned task is the server confirmation.
 */
interface UpdateConfirmation {
  readonly task?: FeishuTaskDocumentData
  readonly updatedAt?: string
}

/** Parse the server confirmation of an update (never assume success from the envelope). */
function updateConfirmationOf(success: LarkSuccess, guid: string): UpdateConfirmation {
  const taskRecord = isRecord(success.data.task) ? success.data.task : undefined
  if (taskRecord === undefined) {
    throw new ClueError('failed', 'the task update was not confirmed by the server')
  }
  const task = parseTaskDocument(taskRecord)
  if (task === undefined || task.guid !== guid) {
    throw new ClueError('failed', 'the task update was not confirmed by the server')
  }
  return { task, ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }) }
}

/**
 * Verify the returned task confirms every changed field.
 * @throws {ClueError} `failed` when a changed field is missing or different.
 */
function requireUpdateConfirmation(
  confirmation: UpdateConfirmation,
  payload: FeishuTaskUpdatePayload,
): void {
  if (confirmation.task === undefined) {
    throw new ClueError('failed', 'the task update was not confirmed by the server')
  }
  const field = taskUpdateUnconfirmedField(payload, confirmation.task)
  if (field !== undefined) {
    throw new ClueError('failed', `the task update did not confirm the changed field "${field}"`)
  }
}

/**
 * Submit the completion state as its own `+complete` / `+reopen` action.
 *
 * lark-cli 1.0.55 returns only `{guid, url}` for these commands (the completion
 * state itself is not echoed), so requiring `status`/`completed_at`/
 * `already_completed` made every successful call throw. A matching GUID in the
 * success envelope is the confirmation this command actually offers; `+complete`
 * itself performs a GET first and skips the PATCH when the task is already
 * completed (the idempotent path).
 */
async function submitCompletion(
  runtime: ClueRuntime,
  guid: string,
  completed: boolean,
  context: ClueOperationContext,
): Promise<{ readonly updatedAt?: string }> {
  const success = await runFeishuCommand(runtime, {
    args: [
      'task', completed ? '+complete' : '+reopen',
      '--task-id', guid,
      '--as', 'user', '--format', 'json',
    ],
    cwd: cwdOf(context),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const returnedGuid = stringField(success.data, 'guid')
  if (returnedGuid === undefined || returnedGuid !== guid) {
    throw new ClueError(
      'failed',
      completed
        ? 'the server did not confirm the task completion'
        : 'the server did not confirm the task reopen',
    )
  }
  const updatedAt = success.data.updated_at
  return updatedAt === undefined ? {} : { updatedAt: String(updatedAt) }
}

/** A best-effort fresh revision after a completion action (never fails the save). */
async function refreshRevision(
  runtime: ClueRuntime,
  guid: string,
  context: ClueOperationContext,
): Promise<string | undefined> {
  try {
    return (await readTask(runtime, guid, context)).updatedAt
  } catch {
    return undefined
  }
}

/** The source descriptor (client presentation is registered separately). */
function tasksDescriptor(): ClueSourceRegistration['descriptor'] {
  return {
    sourceId: FEISHU_SOURCE_IDS.tasks,
    name: 'Feishu tasks',
    icon: 'feishu-tasks',
    order: 4,
    pluginId: FEISHU_PLUGIN_ID,
    types: [FEISHU_TYPE_IDS.task],
    transport: 'cli',
    capabilities: {
      resolve: true,
      list: true,
      search: true,
      read: true,
      edit: true,
      portable: true,
    },
    dependencyIds: [FEISHU_DEPENDENCY_ID],
    connectionId: FEISHU_CONNECTION_ID,
  }
}

/** The task type descriptor; concurrency is a best-effort re-read, never a CAS claim. */
function tasksTypes(): ClueTypeDescriptor[] {
  return [{
    typeId: FEISHU_TYPE_IDS.task,
    sourceId: FEISHU_SOURCE_IDS.tasks,
    formats: [FEISHU_FORMATS.taskDocument],
    capabilities: { read: true, edit: true, concurrency: 'check-before-save' },
  }]
}

/**
 * Create the `builtin.feishu.tasks` source registration.
 * @param getRuntime - lazy runtime accessor (never called at construction).
 */
export function createFeishuTasksSource(getRuntime: () => ClueRuntime): ClueSourceRegistration {
  const runtime = (): ClueRuntime => getRuntime()

  return {
    descriptor: tasksDescriptor(),
    types: tasksTypes(),
    operations: {
      normalizeLocator(locator: Locator): Locator {
        return normalizeTaskLocator(locator)
      },

      locatorKey(locator: Locator): string {
        return taskLocatorKey(locator)
      },

      async resolve(input: { readonly text?: string; readonly locator?: Locator; readonly explicit?: boolean }, _context) {
        if (input.locator !== undefined) {
          // A locator of another source's shape (docx/wiki/wiki-space) is not a
          // task failure in auto resolution: answer "not mine" so the docs
          // source's locator does not abort the walk.
          const kind = isRecord(input.locator) ? input.locator.kind : undefined
          if (kind !== 'task') {
            if (input.explicit === true) {
              throw new ClueError('invalid-request', 'a locator must be a Feishu task reference')
            }
            return undefined
          }
          const locator = parseTaskLocator(input.locator)
          return {
            sourceId: FEISHU_SOURCE_IDS.tasks,
            typeId: FEISHU_TYPE_IDS.task,
            locator: locator as unknown as Locator,
            title: `Feishu task ${locator.guid.slice(0, 8)}`,
            subtitle: 'Task',
          }
        }
        if (input.text === undefined) return undefined
        const parsed = parseFeishuTaskText(input.text)
        if (parsed === undefined) return undefined
        if (parsed.kind === 'display-id') {
          if (input.explicit === true) {
            throw new ClueError(
              'invalid-request',
              parsed.value === 'applink-without-guid'
                ? 'a Feishu task applink needs a `guid` query parameter'
                : 'the displayed task number is not a task GUID',
            )
          }
          return undefined
        }
        return {
          sourceId: FEISHU_SOURCE_IDS.tasks,
          typeId: FEISHU_TYPE_IDS.task,
          locator: { kind: 'task', guid: parsed.guid, url: parsed.url } as unknown as Locator,
          title: `Feishu task ${parsed.guid.slice(0, 8)}`,
          subtitle: 'Task',
        }
      },

      async list(input: ClueSourceListInput, context): Promise<ClueListResult> {
        const scope = parseFeishuTasksScope(input.scope)
        const signature = stableJson(scope as unknown as JsonValue)
        const pageToken = pageTokenOf(signature, input.cursor)
        const limit = pageLimitOf(input.limit)
        const params: Record<string, JsonValue> = {
          page_size: limit,
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
          ...(scope.completed === undefined ? {} : { completed: scope.completed }),
        }
        const success = await runFeishuCommand(runtime(), {
          args: scope.tasklistGuid === undefined
            ? ['task', 'tasks', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json']
            : [
                'task', 'tasklists', 'tasks',
                '--params', JSON.stringify({ ...params, tasklist_guid: scope.tasklistGuid }),
                '--as', 'user', '--format', 'json',
              ],
          cwd: cwdOf(context),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        const items: ClueCandidate[] = []
        // Native `task tasks list` / `tasklists tasks` expose `items`.
        for (const row of taskRows(success)) {
          const candidate = taskCandidate(row)
          if (candidate !== undefined) items.push(candidate)
        }
        return { items, ...pageOf(success, signature) }
      },

      async search(input: ClueSourceSearchInput, context): Promise<ClueListResult> {
        const rawQuery = typeof input.query === 'string' ? input.query.trim() : ''
        // Validate the keyword with the same control-character/length bound as
        // the structured filters: a NUL or a runaway query must be a typed
        // invalid-request, not a generic CLI failure.
        const query = rawQuery === '' ? '' : searchFilterOf(rawQuery, 'query')!
        const scope = parseFeishuTaskSearchScope(input.scope)
        const hasFilter = scope.completed !== undefined
          || scope.assignee !== undefined
          || scope.creator !== undefined
          || scope.follower !== undefined
          || scope.due !== undefined
        if (query === '' && !hasFilter) {
          throw new ClueError(
            'invalid-request',
            'a Feishu task search needs a keyword or at least one documented filter',
          )
        }
        // The cursor is bound to every filter, not just the keyword.
        const signature = stableJson({
          query,
          ...(scope.completed === undefined ? {} : { completed: scope.completed }),
          ...(scope.assignee === undefined ? {} : { assignee: scope.assignee }),
          ...(scope.creator === undefined ? {} : { creator: scope.creator }),
          ...(scope.follower === undefined ? {} : { follower: scope.follower }),
          ...(scope.due === undefined ? {} : { due: scope.due }),
        } as unknown as JsonValue)
        const pageToken = pageTokenOf(signature, input.cursor)
        // `task +search` documents no `--page-size`; `--page-limit` is a page
        // count (capped at 40) and is the only way to keep it to one page. The
        // caller's item limit therefore does not apply to search.
        const success = await runFeishuCommand(runtime(), {
          args: [
            'task', '+search',
            ...(query === '' ? [] : ['--query', query]),
            ...(scope.completed === undefined ? [] : [`--completed=${scope.completed}`]),
            ...(scope.assignee === undefined ? [] : ['--assignee', scope.assignee]),
            ...(scope.creator === undefined ? [] : ['--creator', scope.creator]),
            ...(scope.follower === undefined ? [] : ['--follower', scope.follower]),
            ...(scope.due === undefined ? [] : ['--due', scope.due]),
            '--page-limit', '1',
            ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
            '--as', 'user', '--format', 'json',
          ],
          cwd: cwdOf(context),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        const items: ClueCandidate[] = []
        // `task +search` also returns `items` (same shape as the native list).
        for (const row of taskRows(success)) {
          const candidate = taskCandidate(row)
          if (candidate !== undefined) items.push(candidate)
        }
        return { items, ...pageOf(success, signature) }
      },

      async read(input: ClueSourceReadInput, context): Promise<ClueReadResult> {
        const locator = parseTaskLocator(input.locator)
        const task = await readTask(runtime(), locator.guid, context)
        return {
          format: FEISHU_FORMATS.taskDocument,
          data: task as unknown as JsonValue,
          ...(task.updatedAt === undefined ? {} : { revision: task.updatedAt }),
          fetchedAt: new Date().toISOString(),
          freshness: 'live',
          text: taskText(task),
        }
      },

      async loadEdit(input: ClueSourceReadInput, context): Promise<ClueEditDocument> {
        if (context.caller === 'agent') {
          throw new ClueError('permission-denied', 'task editing is available only to an interactive user request')
        }
        const locator = parseTaskLocator(input.locator)
        const task = await readTask(runtime(), locator.guid, context)
        return {
          format: FEISHU_FORMATS.taskDocument,
          data: task as unknown as JsonValue,
          ...(task.updatedAt === undefined ? {} : { baseRevision: task.updatedAt }),
        }
      },

      async saveEdit(input: ClueSourceSaveInput, context): Promise<ClueSaveEditResult> {
        if (context.caller === 'agent') {
          throw new ClueError('permission-denied', 'task editing is available only to an interactive user request')
        }
        const locator = parseTaskLocator(input.locator)
        const document: ClueSaveEditInput = input.document
        if (document.format !== FEISHU_FORMATS.taskDocument) {
          throw new ClueError('unsupported', 'the task edit document uses an unsupported format')
        }
        const edited = parseTaskDocument(document.data)
        if (edited === undefined) {
          throw new ClueError('invalid-request', 'the task edit document is not a task object')
        }
        if (edited.guid !== locator.guid) {
          throw new ClueError('invalid-request', 'the task edit document belongs to a different GUID')
        }
        const validation = validateTaskDocument(edited)
        if (validation.length > 0) {
          const fields = [...new Set(validation.map(error => error.field))]
          throw new ClueError(
            'invalid-request',
            validation[0]!.message,
            { fields: fields.join(',') },
          )
        }

        // Best-effort fresh read: the source has no atomic conditional update.
        const current = await readTask(runtime(), locator.guid, context)
        if (document.baseRevision !== undefined) {
          if (current.updatedAt === undefined) {
            throw new ClueError('conflict', 'the task baseline could not be confirmed; re-read it and retry')
          }
          if (document.baseRevision !== current.updatedAt) {
            throw new ClueError('conflict', 'the task changed since it was loaded; re-read it and retry')
          }
        }
        const update = taskUpdatePayload(current, edited)
        const fields = taskUpdateFields(update)
        const completionChanged = edited.completed !== current.completed
        const savedAt = new Date().toISOString()
        let revision = current.updatedAt

        if (fields.length > 0) {
          // Native PATCH rather than the `+update` shortcut: the native body
          // can name a cleared field in `update_fields` while omitting it from
          // `task` (the shortcut treats every `--data` key as both), and its
          // output carries the updated `task` for field-level confirmation.
          const json = JSON.stringify({ task: update.task, update_fields: update.updateFields })
          if (new TextEncoder().encode(json).length > MAX_TASK_UPDATE_BYTES) {
            throw new ClueError('invalid-request', 'the task edit payload is too large')
          }
          const success = await runFeishuCommand(runtime(), {
            args: [
              'task', 'tasks', 'patch', '--task-guid', locator.guid,
              '--data', json,
              '--as', 'user', '--format', 'json',
            ],
            cwd: cwdOf(context),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
          const confirmation = updateConfirmationOf(success, locator.guid)
          requireUpdateConfirmation(confirmation, update)
          // Once a write happened, the OLD baseline is no longer a valid
          // revision to return. Prefer the returned task's stamp, then a fresh
          // read; if neither is available, omit the revision instead of lying.
          revision = confirmation.updatedAt
          if (completionChanged) {
            try {
              const completion = await submitCompletion(runtime(), locator.guid, edited.completed, context)
              revision = completion.updatedAt ?? await refreshRevision(runtime(), locator.guid, context) ?? revision
            } catch (error) {
              const message = error instanceof ClueError ? error.message : 'the completion change failed'
              throw new ClueError(
                'failed',
                `partial success: the task fields (${fields.join(', ')}) were saved, but the completion `
                + `change was not confirmed (${message}); the draft is preserved`,
                { partial: 'true', written: fields.join(','), unwritten: 'completed' },
              )
            }
          } else {
            // The native PATCH normally stamps `updated_at`; a best-effort
            // fresh read keeps the next save from a guaranteed false conflict.
            revision = await refreshRevision(runtime(), locator.guid, context) ?? revision
          }
          return { savedAt, ...(revision === undefined ? {} : { revision }) }
        }

        if (completionChanged) {
          const completion = await submitCompletion(runtime(), locator.guid, edited.completed, context)
          revision = completion.updatedAt ?? await refreshRevision(runtime(), locator.guid, context)
          return { savedAt, ...(revision === undefined ? {} : { revision }) }
        }
        // Nothing changed: no write is issued and the draft is considered clean.
        return { savedAt, ...(revision === undefined ? {} : { revision }) }
      },

      async portable(input: ClueSourceReadInput, context): Promise<CluePortableRef> {
        const locator = parseTaskLocator(input.locator)
        // S4 §2 requires the export to carry the source host and a plain task
        // link. A GUID-only locator has neither, so read the task once (the
        // native detail carries `url`) instead of dropping both silently.
        const task = locator.url === undefined
          ? await readTask(runtime(), locator.guid, context)
          : undefined
        const url = locator.url ?? task?.url
        const host = hostOf(url)
        if (url === undefined) {
          return {
            portable: false,
            reason: 'the task did not expose a plain link; open it in Feishu once and export again',
          }
        }
        return {
          portable: true,
          locator: {
            kind: 'task',
            guid: locator.guid,
            url,
            ...(host === undefined ? {} : { host }),
          } as unknown as Locator,
        }
      },
    },
  }
}
