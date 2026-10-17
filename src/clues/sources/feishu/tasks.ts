/**
 * `builtin.feishu.tasks`: single-page task browsing/search, latest reads and
 * field-level editing through the official task commands.
 *
 * Commands (official, single page only):
 * - list: native `task tasks list` (or `task tasklists tasks` for an explicit
 *   tasklist range), continued only with the returned `page_token`;
 * - search: `task +search` with `--page-limit` and an explicit `--page-token`;
 * - read: `task tasks get` by GUID;
 * - edit: `task +update` with ONLY the changed fields, then completion/reopen
 *   as a SEPARATE `task +complete` / `task +reopen` call.
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
  millisOf,
  parseTaskDocument,
  stringOf,
  stripHighlight,
  taskFieldConfirmed,
  taskText,
  taskUpdateFields,
  taskUpdatePayload,
  validateTaskDocument,
  type FeishuTaskDocumentData,
  type FeishuTaskUpdatePayload,
} from './format.ts'
import {
  arrayField,
  larkWorkingDirectory,
  recordField,
  runLark,
  stringField,
  type LarkSuccess,
} from './lark.ts'
import {
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
type TasksScope = {
  readonly kind: 'tasks'
  readonly tasklistGuid?: string
  readonly completed?: boolean
}

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

/** Parse one task range; the default is the user's task list (an explicit range choice). */
function parseTasksScope(value: JsonValue | undefined): TasksScope {
  if (value === undefined) return { kind: 'tasks' }
  if (!isRecord(value)) throw new ClueError('invalid-request', 'a task range must be a JSON object')
  if (value.kind !== undefined && value.kind !== 'tasks') {
    throw new ClueError('invalid-request', 'unknown Feishu task range')
  }
  if (value.completed !== undefined && typeof value.completed !== 'boolean') {
    throw new ClueError('invalid-request', 'a task range "completed" filter must be a boolean')
  }
  return {
    kind: 'tasks',
    ...(stringOf(value.tasklistGuid) === undefined ? {} : { tasklistGuid: stringOf(value.tasklistGuid) }),
    ...(value.completed === undefined ? {} : { completed: value.completed }),
  }
}

/** Decode a caller cursor against the exact range/query that minted it. */
function pageTokenOf(signature: string, cursor: string | undefined): string | undefined {
  return cursor === undefined ? undefined : decodeCursor(signature, cursor).pageToken
}

/** The next task cursor, or a `limited` marker when the provider gave no token. */
function pageOf(success: LarkSuccess, signature: string): { readonly nextCursor?: string; readonly limited?: boolean } {
  const token = stringField(success.data, 'page_token') ?? stringField(success.data, 'next_page_token')
  if (token !== undefined && token !== '') return { nextCursor: encodeCursor(signature, token) }
  return success.data.has_more === true ? { limited: true } : {}
}

/** The rows of one task list/search answer. */
function taskRows(success: LarkSuccess): JsonValue[] {
  return arrayField(success.data, 'tasks') ?? arrayField(success.data, 'items') ?? []
}

/** Build one candidate from a task record. */
function taskCandidate(row: JsonValue): ClueCandidate | undefined {
  if (!isRecord(row)) return undefined
  const guid = stringOf(row.guid)
  if (guid === undefined) return undefined
  const task = parseTaskDocument(row, guid)
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
  const success = await runLark({
    runtime,
    args: [
      'task', 'tasks', 'get',
      '--params', JSON.stringify({ task_guid: guid }),
      '--as', 'user', '--format', 'json',
    ],
    cwd: cwdOf(context),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const task = recordField(success.data, 'task') ?? success.data
  const document = parseTaskDocument(task as JsonValue, guid)
  if (document === undefined) {
    throw new ClueError('failed', 'lark-cli returned an unreadable task payload')
  }
  if (document.guid !== guid) {
    throw new ClueError('failed', 'lark-cli returned a different task than the requested GUID')
  }
  return document
}

/** The confirmation view of one `task +update` answer. */
interface UpdateConfirmation {
  readonly updatedFields?: readonly JsonValue[]
  readonly confirmed?: JsonValue
  readonly updatedAt?: string
}

/** Parse the server confirmation of an update (never assume success from the envelope). */
function updateConfirmationOf(success: LarkSuccess): UpdateConfirmation {
  const updatedFields = arrayField(success.data, 'updated_fields')
  const tasks = arrayField(success.data, 'tasks')
  const firstTask = tasks === undefined || tasks.length === 0 ? undefined : tasks[0]
  const taskRecord = isRecord(firstTask) ? firstTask : undefined
  const confirmed = taskRecord?.confirmed ?? success.data.confirmed
  return {
    ...(updatedFields === undefined ? {} : { updatedFields }),
    ...(confirmed === undefined ? {} : { confirmed }),
    ...(taskRecord?.updated_at === undefined ? {} : { updatedAt: String(taskRecord.updated_at) }),
  }
}

/**
 * Verify the CLI actually confirmed every changed field.
 * @throws {ClueError} `failed` when the server did not confirm thewrite.
 */
function requireUpdateConfirmation(
  confirmation: UpdateConfirmation,
  payload: FeishuTaskUpdatePayload,
  fields: readonly string[],
): void {
  if (confirmation.updatedFields === undefined && confirmation.confirmed === undefined) {
    throw new ClueError('failed', 'the task update was not confirmed by the server')
  }
  if (confirmation.updatedFields !== undefined) {
    for (const field of fields) {
      if (!confirmation.updatedFields.includes(field)) {
        throw new ClueError('failed', `the task update did not confirm the changed field "${field}"`)
      }
    }
  }
  if (confirmation.confirmed !== undefined) {
    for (const field of fields) {
      if (!taskFieldConfirmed(payload, field, confirmation.confirmed)) {
        throw new ClueError('failed', `the task update did not confirm the changed field "${field}"`)
      }
    }
  }
}

/** Submit the completion state as its own action. */
async function submitCompletion(
  runtime: ClueRuntime,
  guid: string,
  completed: boolean,
  context: ClueOperationContext,
): Promise<void> {
  const success = await runLark({
    runtime,
    args: [
      'task', completed ? '+complete' : '+reopen',
      '--task-id', guid,
      '--as', 'user', '--format', 'json',
    ],
    cwd: cwdOf(context),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const status = stringField(success.data, 'status')
  if (completed) {
    const already = success.data.already_completed === true
    const completedAt = millisOf(success.data.completed_at)
    if (!(already || status === 'done' || (completedAt !== undefined && completedAt > 0))) {
      throw new ClueError('failed', 'the server did not confirm the task completion')
    }
    return
  }
  // Reopen: only a server answer that still says "done" (or a positive
  // completion instant) is a non-confirmation; otherwise the envelope + exit 0
  // is the documented result of `+reopen`.
  if (status === 'done') throw new ClueError('failed', 'the server did not confirm the task reopen')
  const completedAt = millisOf(success.data.completed_at)
  if (completedAt !== undefined && completedAt > 0) {
    throw new ClueError('failed', 'the server did not confirm the task reopen')
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
        const scope = parseTasksScope(input.scope)
        const signature = stableJson(scope as unknown as JsonValue)
        const pageToken = pageTokenOf(signature, input.cursor)
        const limit = pageLimitOf(input.limit)
        const params: Record<string, JsonValue> = {
          page_size: limit,
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
          ...(scope.completed === undefined ? {} : { completed: scope.completed }),
        }
        const success = await runLark({
          runtime: runtime(),
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
        for (const row of taskRows(success)) {
          const candidate = taskCandidate(row)
          if (candidate !== undefined) items.push(candidate)
        }
        return { items, ...pageOf(success, signature) }
      },

      async search(input: ClueSourceSearchInput, context): Promise<ClueListResult> {
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        const scope = parseTasksScope(input.scope)
        if (query === '' && scope.completed === undefined) {
          throw new ClueError('invalid-request', 'a Feishu task search needs a keyword or a completion filter')
        }
        const signature = stableJson({
          query,
          ...(scope.completed === undefined ? {} : { completed: scope.completed }),
        } as unknown as JsonValue)
        const pageToken = pageTokenOf(signature, input.cursor)
        const limit = pageLimitOf(input.limit)
        const success = await runLark({
          runtime: runtime(),
          args: [
            'task', '+search',
            ...(query === '' ? [] : ['--query', query]),
            ...(scope.completed === undefined ? [] : [`--completed=${scope.completed}`]),
            '--page-limit', String(limit),
            ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
            '--as', 'user', '--format', 'json',
          ],
          cwd: cwdOf(context),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        const items: ClueCandidate[] = []
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
        const edited = parseTaskDocument(document.data, locator.guid)
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
        if (
          document.baseRevision !== undefined
          && current.updatedAt !== undefined
          && document.baseRevision !== current.updatedAt
        ) {
          throw new ClueError('conflict', 'the task changed since it was loaded; re-read it and retry')
        }
        let update: FeishuTaskUpdatePayload
        try {
          update = taskUpdatePayload(current, edited)
        } catch (error) {
          throw new ClueError(
            'invalid-request',
            error instanceof Error ? error.message : 'the task edit cannot be applied',
          )
        }
        const fields = taskUpdateFields(update)
        const completionChanged = edited.completed !== current.completed
        const savedAt = new Date().toISOString()
        let revision = current.updatedAt

        if (fields.length > 0) {
          const json = JSON.stringify(update)
          if (new TextEncoder().encode(json).length > MAX_TASK_UPDATE_BYTES) {
            throw new ClueError('invalid-request', 'the task edit payload is too large')
          }
          const success = await runLark({
            runtime: runtime(),
            args: [
              'task', '+update', '--task-id', locator.guid,
              '--data', json,
              '--as', 'user', '--format', 'json',
            ],
            cwd: cwdOf(context),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
          const confirmation = updateConfirmationOf(success)
          requireUpdateConfirmation(confirmation, update, fields)
          if (confirmation.updatedAt !== undefined) revision = confirmation.updatedAt
          if (completionChanged) {
            try {
              await submitCompletion(runtime(), locator.guid, edited.completed, context)
            } catch (error) {
              const message = error instanceof ClueError ? error.message : 'the completion change failed'
              throw new ClueError(
                'failed',
                `partial success: the task fields (${fields.join(', ')}) were saved, but the completion `
                + `change was not confirmed (${message}); the draft is preserved`,
                { partial: 'true', written: fields.join(','), unwritten: 'completed' },
              )
            }
          }
          return { savedAt, ...(revision === undefined ? {} : { revision }) }
        }

        if (completionChanged) {
          await submitCompletion(runtime(), locator.guid, edited.completed, context)
          return { savedAt, ...(revision === undefined ? {} : { revision }) }
        }
        // Nothing changed: no write is issued and the draft is considered clean.
        return { savedAt, ...(revision === undefined ? {} : { revision }) }
      },

      async portable(input: ClueSourceReadInput): Promise<CluePortableRef> {
        const locator = parseTaskLocator(input.locator)
        const url = locator.url
        let host: string | undefined
        if (url !== undefined) {
          try {
            host = new URL(url).host
          } catch {
            host = undefined
          }
        }
        return {
          portable: true,
          locator: {
            kind: 'task',
            guid: locator.guid,
            ...(url === undefined ? {} : { url }),
            ...(host === undefined ? {} : { host }),
          } as unknown as Locator,
        }
      },
    },
  }
}
