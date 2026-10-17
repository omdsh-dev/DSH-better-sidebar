/**
 * S4 Feishu TASKS source contract (fake lark-cli; no real account).
 *
 * Pins the approved task semantics:
 * - list/search are OFFICIAL single-page commands: native `task tasks list`
 *   (or `task tasklists tasks` for an explicit list range) and `task +search`
 *   with the documented keyword/completed/assignee/creator/follower/due
 *   filters and `--page-limit`; a tasklist search is rejected rather than
 *   silently widened, and the auto-paging shortcuts / `--page-all` never run;
 * - a cursor is bound to its query/range and cannot be replayed elsewhere;
 * - the task GUID is the only identity: applinks resolve through `guid`, a
 *   displayed number (`t104121`) is rejected for read and update;
 * - read returns title/description/start/due/completed/updatedAt/GUID; the
 *   start-due relation is validated locally BEFORE any write;
 * - edits submit only changed fields through one `task +update`; completion /
 *   reopen is a SEPARATE `+complete` / `+reopen` action; a field save refreshes
 *   the baseline with a best-effort read (the CLI documents no `updated_at` on
 *   `+update`) and omits the revision when no fresh one is confirmed;
 * - conflicts are detected by a best-effort fresh read (never claimed as CAS),
 *   a partially applied save is reported as partial and never as success;
 * - portable exports contain the GUID + plain link only.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/types.ts'
import type { ClueOperationContext, JsonValue } from '../src/clues/types.ts'
import { createFeishuTasksSource } from '../src/clues/sources/feishu/tasks.ts'
import {
  FEISHU_CONNECTION_ID,
  FEISHU_FORMATS,
  FEISHU_TYPE_IDS,
  type FeishuTaskDocumentData,
} from '../src/clues/sources/feishu/format.ts'
import {
  failResult,
  FakeLarkRuntime,
  okResult,
  operationContext,
} from './clues-feishu-fixture.ts'

const CWD = '/tmp/dsh-feishu'
const GUID = '2f4d8c1e-7a3b-4c5d-9e8f-0123456789ab'
const URL = `https://applink.larksuite.com/client/todo/task?guid=${GUID}`
const UPDATED_1 = '1700000001000'
const UPDATED_2 = '1700001111000'

function context(): ClueOperationContext {
  return operationContext() as unknown as ClueOperationContext
}

function opsOf(runtime: FakeLarkRuntime) {
  const source = createFeishuTasksSource(() => runtime.asRuntime())
  const operations = source.operations
  if (operations === undefined) throw new Error('tasks source needs operations')
  return { source, operations }
}

/** One lark task record. */
function taskRecord(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    guid: GUID,
    summary: 'Release checklist',
    description: 'Ship the release',
    start: { timestamp: '1700000000000', is_all_day: false },
    due: { timestamp: '1700003600000', is_all_day: false },
    completed: false,
    updated_at: UPDATED_1,
    url: URL,
    ...overrides,
  }
}

/** One successful task-get answer. */
function taskGet(overrides: Record<string, JsonValue> = {}) {
  return okResult({ task: taskRecord(overrides) })
}

/** One editable task document as the client editor produces it. */
function editedDocument(overrides: Partial<FeishuTaskDocumentData> = {}): FeishuTaskDocumentData {
  return {
    kind: 'task',
    guid: GUID,
    title: 'Release checklist',
    description: 'Ship the release',
    start: { timestamp: '1700000000000', isAllDay: false },
    due: { timestamp: '1700003600000', isAllDay: false },
    completed: false,
    updatedAt: UPDATED_1,
    url: URL,
    ...overrides,
  }
}

function locator() {
  return { kind: 'task', guid: GUID, url: URL }
}

function saveInput(data: FeishuTaskDocumentData, baseRevision: string | undefined = UPDATED_1) {
  return {
    typeId: FEISHU_TYPE_IDS.task,
    locator: locator(),
    document: {
      format: FEISHU_FORMATS.taskDocument,
      data: data as unknown as JsonValue,
      ...(baseRevision === undefined ? {} : { baseRevision }),
    },
  }
}

describe('task browsing and search', () => {
  it('lists one official native task page and resumes only with its cursor', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      tasks: [taskRecord()],
      has_more: true,
      page_token: 'task-pt-2',
    }))
    const { operations } = opsOf(runtime)
    const first = await operations.list!({ scope: { kind: 'tasks' }, limit: 500 }, context())
    expect(runtime.requests[0]!.args).toEqual([
      'task', 'tasks', 'list',
      '--params', JSON.stringify({ page_size: 20 }),
      '--as', 'user', '--format', 'json',
    ])
    expect(runtime.requests[0]!.cwd).toBe(CWD)
    expect(first.items[0]).toMatchObject({
      sourceId: 'builtin.feishu.tasks',
      typeId: FEISHU_TYPE_IDS.task,
      title: 'Release checklist',
      locator: { kind: 'task', guid: GUID },
    })
    expect(first.total).toBeUndefined()

    runtime.enqueue(okResult({ tasks: [], has_more: false }))
    await operations.list!({ scope: { kind: 'tasks' }, cursor: first.nextCursor }, context())
    expect(runtime.requests[1]!.args[4]).toBe(JSON.stringify({
      page_size: 20, page_token: 'task-pt-2',
    }))
  })

  it('supports an explicit tasklist range and a completion filter', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ tasks: [], has_more: false }))
    const { operations } = opsOf(runtime)
    await operations.list!(
      { scope: { kind: 'tasks', tasklistGuid: 'tl-1', completed: false } },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'task', 'tasklists', 'tasks',
      '--params', JSON.stringify({ page_size: 20, completed: false, tasklist_guid: 'tl-1' }),
      '--as', 'user', '--format', 'json',
    ])
  })

  it('refuses a cursor from another task range without a provider call', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      tasks: [taskRecord()], has_more: true, page_token: 'pt',
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!({ scope: { kind: 'tasks' } }, context())
    await expect(operations.list!(
      { scope: { kind: 'tasks', completed: true }, cursor: page.nextCursor },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(1)
  })

  it('uses task +search with a single page limit and never an auto-paging shortcut', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      tasks: [taskRecord({ summary: 'Release <hb>checklist</hb>' })],
      has_more: false,
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.search!(
      { query: ' release ', scope: { kind: 'tasks', completed: false }, limit: 500 },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'task', '+search',
      '--query', 'release',
      '--completed=false',
      '--page-limit', '20',
      '--as', 'user', '--format', 'json',
    ])
    for (const request of runtime.requests) {
      expect(request.args).not.toContain('--page-all')
      expect(request.args).not.toContain('+get-my-tasks')
      expect(request.args).not.toContain('+get-related-tasks')
    }
    expect(page.items[0]!.title).toBe('Release checklist')
  })

  it('passes the documented search filters and binds them into the cursor', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      tasks: [taskRecord()], has_more: true, page_token: 'filtered-pt',
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.search!(
      {
        query: 'release',
        scope: {
          kind: 'tasks',
          completed: false,
          assignee: 'ou_ada',
          creator: 'ou_grace',
          follower: 'ou_lin',
          due: '-1d,+7d',
        },
      },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'task', '+search',
      '--query', 'release',
      '--completed=false',
      '--assignee', 'ou_ada',
      '--creator', 'ou_grace',
      '--follower', 'ou_lin',
      '--due', '-1d,+7d',
      '--page-limit', '20',
      '--as', 'user', '--format', 'json',
    ])
    // A cursor from a different filter set must be refused, not replayed.
    await expect(operations.search!(
      { query: 'release', scope: { kind: 'tasks', assignee: 'ou_other' }, cursor: page.nextCursor },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(1)
  })

  it('rejects a tasklist search instead of silently returning global results', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.search!(
      { query: 'release', scope: { kind: 'tasks', tasklistGuid: 'tl-1' } },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(operations.search!(
      { query: 'release', scope: { kind: 'tasks', assignee: 'ou_' + 'x'.repeat(600) } },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('requires a keyword or a completion filter for task search', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.search!({ query: ' ' }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })
})

describe('task resolve', () => {
  it('extracts the guid from a task applink and performs no CLI call', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const candidate = await operations.resolve!({ text: URL, explicit: true }, context())
    expect(candidate).toMatchObject({
      sourceId: 'builtin.feishu.tasks',
      typeId: FEISHU_TYPE_IDS.task,
      locator: { kind: 'task', guid: GUID, url: URL },
    })
    expect(runtime.requests).toHaveLength(0)
  })

  it('rejects a displayed task number explicitly (it is not a GUID)', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.resolve!({ text: 't104121', explicit: true }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    // Auto resolution keeps asking later sources instead of failing the whole parse.
    expect(await operations.resolve!({ text: 't104121' }, context())).toBeUndefined()
    expect(runtime.requests).toHaveLength(0)
  })
})

describe('task read and edit loading', () => {
  it('reads the latest task by GUID and maps all editable fields', async () => {
    const runtime = new FakeLarkRuntime().enqueue(taskGet())
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.task, locator: locator() },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'task', 'tasks', 'get',
      '--params', JSON.stringify({ task_guid: GUID }),
      '--as', 'user', '--format', 'json',
    ])
    expect(result.format).toBe(FEISHU_FORMATS.taskDocument)
    expect(result.revision).toBe(UPDATED_1)
    expect(result.text).toContain('# Release checklist')
    expect(result.data).toMatchObject({
      kind: 'task',
      guid: GUID,
      title: 'Release checklist',
      description: 'Ship the release',
      start: { timestamp: '1700000000000', isAllDay: false },
      due: { timestamp: '1700003600000', isAllDay: false },
      completed: false,
      updatedAt: UPDATED_1,
      url: URL,
    })
  })

  it('rejects a displayed number as a read locator with no CLI call', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.read!(
      { typeId: FEISHU_TYPE_IDS.task, locator: { kind: 'task', guid: 't104121' } },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('reports a task authorization failure to the shared connection', async () => {
    const runtime = new FakeLarkRuntime().enqueue(failResult({
      type: 'authorization',
      subtype: 'missing_scope',
      missing_scopes: ['task:task:read'],
      console_url: 'https://open.feishu.cn/app/cli_x/auth',
      message: 'raw token secret',
    }))
    const { operations } = opsOf(runtime)
    let failure: unknown
    try {
      await operations.read!({ typeId: FEISHU_TYPE_IDS.task, locator: locator() }, context())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ClueError)
    const clueError = failure as ClueError
    expect(clueError.category).toBe('auth-required')
    expect(clueError.message).toContain('task:task:read')
    expect(clueError.message).not.toMatch(/raw token secret/)
    expect(runtime.reports).toHaveLength(1)
    expect(runtime.reports[0]).toMatchObject({
      connectionId: FEISHU_CONNECTION_ID,
      inspection: { configuration: 'ready', authorization: 'scope-insufficient' },
    })
    expect(runtime.reports[0]!.inspection.detail).toContain('task:task:read')
  })

  it('loadEdit returns the editable document plus the updated-at baseline', async () => {
    const runtime = new FakeLarkRuntime().enqueue(taskGet())
    const { operations } = opsOf(runtime)
    const document = await operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.task, locator: locator() },
      context(),
    )
    expect(document).toMatchObject({
      format: FEISHU_FORMATS.taskDocument,
      baseRevision: UPDATED_1,
      data: { guid: GUID, title: 'Release checklist' },
    })
  })

  it('reserves editing for an interactive caller (agent load/save is refused)', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const agent = { ...context(), caller: 'agent' as const }
    await expect(operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.task, locator: locator() },
      agent,
    )).rejects.toMatchObject({ category: 'permission-denied' })
    await expect(operations.saveEdit!(saveInput(editedDocument()), agent))
      .rejects.toMatchObject({ category: 'permission-denied' })
    expect(runtime.requests).toHaveLength(0)
  })
})

describe('task save: changed fields, completion and partial success', () => {
  it('validates start <= due locally before any read or write', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const invalid = editedDocument({
      start: { timestamp: '1700009999999', isAllDay: false },
    })
    await expect(operations.saveEdit!(saveInput(invalid), context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('submits ONLY the changed fields and refreshes the baseline after the update', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({
        updated_fields: ['summary', 'description'],
        tasks: [{
          guid: GUID,
          updated_at: UPDATED_2,
          confirmed: { summary: 'New title', description: 'New description' },
        }],
      }))
      // `task +update` documents no updated_at; the source re-reads the task so
      // the NEXT save compares against a fresh baseline instead of a false
      // conflict.
      .enqueue(taskGet({ summary: 'New title', description: 'New description', updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    const result = await operations.saveEdit!(
      saveInput(editedDocument({ title: 'New title', description: 'New description' })),
      context(),
    )

    expect(runtime.requests).toHaveLength(3)
    expect(runtime.requests[0]!.args.slice(0, 2)).toEqual(['task', 'tasks'])
    const updateArgs = runtime.requests[1]!.args
    expect(updateArgs.slice(0, 4)).toEqual(['task', '+update', '--task-id', GUID])
    const payload = JSON.parse(updateArgs[5]!) as Record<string, JsonValue>
    expect(payload).toEqual({ summary: 'New title', description: 'New description' })
    expect(updateArgs).not.toContain('--page-all')
    expect(runtime.requests[2]!.args.slice(0, 3)).toEqual(['task', 'tasks', 'get'])
    expect(result.revision).toBe(UPDATED_2)
  })

  it('gets a fresh revision even when the update confirmation carries no updated_at', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({
        updated_fields: ['summary'],
        tasks: [{ guid: GUID, confirmed: { summary: 'No stamp' } }],
      }))
      .enqueue(taskGet({ summary: 'No stamp', updated_at: '1700002222000' }))
    const { operations } = opsOf(runtime)
    const result = await operations.saveEdit!(
      saveInput(editedDocument({ title: 'No stamp' })),
      context(),
    )
    expect(result.revision).toBe('1700002222000')
    expect(runtime.requests).toHaveLength(3)
  })

  it('omits the revision when neither the update nor a fresh read confirms it', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({
        updated_fields: ['summary'],
        tasks: [{ guid: GUID, confirmed: { summary: 'No stamp' } }],
      }))
    const { operations } = opsOf(runtime)
    const result = await operations.saveEdit!(
      saveInput(editedDocument({ title: 'No stamp' })),
      context(),
    )
    // Returning the OLD baseline would guarantee a false conflict next save.
    expect(result.revision).toBeUndefined()
    expect(result.savedAt).toBeTruthy()
  })

  it('submits a changed due time alone, preserving all-day semantics', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({
        updated_fields: ['due'],
        tasks: [{
          guid: GUID,
          updated_at: UPDATED_2,
          confirmed: { due: { timestamp: '1700007200000', is_all_day: true } },
        }],
      }))
      .enqueue(taskGet({
        due: { timestamp: '1700007200000', is_all_day: true },
        updated_at: UPDATED_2,
      }))
    const { operations } = opsOf(runtime)
    await operations.saveEdit!(
      saveInput(editedDocument({ due: { timestamp: '1700007200000', isAllDay: true } })),
      context(),
    )
    const payload = JSON.parse(runtime.requests[1]!.args[5]!) as Record<string, JsonValue>
    expect(payload).toEqual({ due: { timestamp: '1700007200000', is_all_day: true } })
  })

  it('returns conflict when the fresh read no longer matches the loaded baseline', async () => {
    const runtime = new FakeLarkRuntime().enqueue(taskGet({ updated_at: '1700005555000' }))
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(
      saveInput(editedDocument({ title: 'New title' }), UPDATED_1),
      context(),
    )).rejects.toMatchObject({ category: 'conflict' })
    expect(runtime.requests).toHaveLength(1)
  })

  it('sends completion as a separate +complete action, with no field PATCH', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({ status: 'done', completed_at: '1700009999000', already_completed: false }))
      .enqueue(taskGet({ updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    const result = await operations.saveEdit!(
      saveInput(editedDocument({ completed: true })),
      context(),
    )
    expect(runtime.requests).toHaveLength(3)
    expect(runtime.requests[1]!.args).toEqual([
      'task', '+complete', '--task-id', GUID, '--as', 'user', '--format', 'json',
    ])
    // The completion PATCH changes updated_at; the source re-reads it so the
    // NEXT save compares against a fresh baseline instead of a guaranteed conflict.
    expect(result.revision).toBe(UPDATED_2)
  })

  it('treats an already-completed idempotent result as success', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({ status: 'done', already_completed: true, updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(saveInput(editedDocument({ completed: true })), context()))
      .resolves.toMatchObject({ revision: UPDATED_2 })
    // The completion answer carried updated_at, so no extra read is needed.
    expect(runtime.requests).toHaveLength(2)
  })

  it('reopens a completed task with +reopen', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet({ completed: true, completed_at: '1700009999000' }))
      .enqueue(okResult({ status: 'todo', completed_at: '0' }))
      .enqueue(taskGet({ completed: false, updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    await operations.saveEdit!(saveInput(editedDocument({ completed: false })), context())
    expect(runtime.requests[1]!.args).toEqual([
      'task', '+reopen', '--task-id', GUID, '--as', 'user', '--format', 'json',
    ])
    expect(runtime.requests).toHaveLength(3)
  })

  it('reports partial success when fields were saved but completion failed', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({
        updated_fields: ['summary'],
        tasks: [{ guid: GUID, updated_at: UPDATED_2, confirmed: { summary: 'New title' } }],
      }))
      .enqueue(failResult({ type: 'rate_limit', subtype: 'too_many_requests', code: 429 }))
    const { operations } = opsOf(runtime)
    let failure: unknown
    try {
      await operations.saveEdit!(
        saveInput(editedDocument({ title: 'New title', completed: true })),
        context(),
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ClueError)
    const clueError = failure as ClueError
    expect(clueError.category).toBe('failed')
    expect(clueError.message).toMatch(/partial success/)
    expect(clueError.message).toMatch(/draft is preserved/)
    expect(clueError.meta).toMatchObject({ partial: 'true', written: 'summary', unwritten: 'completed' })
    expect(runtime.requests).toHaveLength(3)
  })

  it('refuses a write the server did not confirm', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({ result: 'success' }))
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(saveInput(editedDocument({ title: 'New title' })), context()))
      .rejects.toMatchObject({ category: 'failed' })
    expect(runtime.requests).toHaveLength(2)
  })

  it('refuses to clear a previously set time instead of inventing a deletion', async () => {
    const runtime = new FakeLarkRuntime().enqueue(taskGet())
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(
      saveInput(editedDocument({ due: null })),
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(1)
  })

  it('performs no write when nothing changed', async () => {
    const runtime = new FakeLarkRuntime().enqueue(taskGet())
    const { operations } = opsOf(runtime)
    const result = await operations.saveEdit!(saveInput(editedDocument()), context())
    expect(runtime.requests).toHaveLength(1)
    expect(result.revision).toBe(UPDATED_1)
  })
})

describe('task portable and type metadata', () => {
  it('exports only the GUID + plain link', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const portable = await operations.portable!(
      { typeId: FEISHU_TYPE_IDS.task, locator: locator() },
      context(),
    )
    expect(portable).toEqual({
      portable: true,
      locator: { kind: 'task', guid: GUID, url: URL, host: 'applink.larksuite.com' },
    })
    expect(JSON.stringify(portable)).not.toMatch(/t104121|accessToken|Bearer/i)
    expect(runtime.requests).toHaveLength(0)
  })

  it('declares an editable, check-before-save task type (never native CAS)', () => {
    const { source } = opsOf(new FakeLarkRuntime())
    expect(source.descriptor.capabilities.edit).toBe(true)
    expect(source.types[0]).toMatchObject({
      typeId: FEISHU_TYPE_IDS.task,
      formats: [FEISHU_FORMATS.taskDocument],
      capabilities: { read: true, edit: true, concurrency: 'check-before-save' },
    })
  })
})
