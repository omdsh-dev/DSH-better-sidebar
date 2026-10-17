/**
 * S4 Feishu TASKS source contract (fake lark-cli; no real account).
 *
 * Pins the approved task semantics:
 * - list/search are OFFICIAL single-page commands: native `task tasks list`
 *   (or `task tasklists tasks` for an explicit list range) and `task +search`
 *   with the documented keyword/completed/assignee/creator/follower/due
 *   filters and `--page-limit 1` (no `--page-size` exists); a tasklist search
 *   is rejected rather than silently widened, and the auto-paging shortcuts /
 *   `--page-all` never run;
 * - a cursor is bound to its query/range and cannot be replayed elsewhere;
 * - the task GUID is the only identity: todo applinks (`/client/todo/detail`
 *   and the older `/client/todo/task`) resolve through `guid`; a displayed
 *   number (`t104121` / `suite_entity_num`) is rejected for read and update;
 * - read returns title/description/start/due/completed/updatedAt/GUID; the
 *   start-due relation is validated locally BEFORE any write;
 * - edits submit only changed fields through native `task tasks patch` (the
 *   returned `task` confirms each field and can express a cleared time);
 *   completion / reopen is a SEPARATE `+complete` / `+reopen` action whose
 *   success envelope carries the matching task GUID; a field save refreshes the
 *   baseline with a best-effort read and omits the revision when no fresh one
 *   is confirmed;
 * - conflicts are detected by a best-effort fresh read (never claimed as CAS),
 *   a partially applied save is reported as partial and never as success;
 * - portable exports contain the GUID + plain link only.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/types.ts'
import type { ClueOperationContext, JsonValue } from '../src/clues/types.ts'
import { createFeishuTasksSource } from '../src/clues/sources/feishu/tasks.ts'
import { windowsShimCommandLine } from '../src/clues/runtime/cli.ts'
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

/** No task command may put JSON into argv (the Windows `.cmd` shim refuses quotes). */
function expectWindowsSafeArgs(runtime: FakeLarkRuntime): void {
  for (const request of runtime.requests) {
    expect(request.args.every(arg => !arg.includes('"'))).toBe(true)
    expect(() => windowsShimCommandLine('C:\\tools\\lark-cli.cmd', request.args)).not.toThrow()
  }
}

function opsOf(runtime: FakeLarkRuntime) {
  const source = createFeishuTasksSource(() => runtime.asRuntime())
  const operations = source.operations
  if (operations === undefined) throw new Error('tasks source needs operations')
  return { source, operations }
}

/** One lark task record in the native `task.tasks.get` shape (status/completed_at, no `completed`). */
function taskRecord(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    guid: GUID,
    summary: 'Release checklist',
    description: 'Ship the release',
    start: { timestamp: '1700000000000', is_all_day: false },
    due: { timestamp: '1700003600000', is_all_day: false },
    status: 'todo',
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
      items: [taskRecord()],
      has_more: true,
      page_token: 'task-pt-2',
    }))
    const { operations } = opsOf(runtime)
    const first = await operations.list!({ scope: { kind: 'tasks' }, limit: 500 }, context())
    expect(runtime.requests[0]!.args).toEqual([
      'task', 'tasks', 'list',
      '--page-size', '20',
      '--as', 'user', '--format', 'json',
    ])
    expect(runtime.requests[0]!.cwd).toBe(CWD)
    expect(runtime.requests[0]!.stdin).toBeUndefined()
    expectWindowsSafeArgs(runtime)
    expect(first.items[0]).toMatchObject({
      sourceId: 'builtin.feishu.tasks',
      typeId: FEISHU_TYPE_IDS.task,
      title: 'Release checklist',
      locator: { kind: 'task', guid: GUID },
    })
    expect(first.total).toBeUndefined()

    runtime.enqueue(okResult({ items: [], has_more: false }))
    await operations.list!({ scope: { kind: 'tasks' }, cursor: first.nextCursor }, context())
    expect(runtime.requests[1]!.args).toEqual([
      'task', 'tasks', 'list',
      '--page-size', '20',
      '--page-token', 'task-pt-2',
      '--as', 'user', '--format', 'json',
    ])
  })

  it('supports an explicit tasklist range and a completion filter', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [], has_more: false }))
    const { operations } = opsOf(runtime)
    await operations.list!(
      { scope: { kind: 'tasks', tasklistGuid: 'tl-1', completed: false } },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'task', 'tasklists', 'tasks',
      '--tasklist-guid', 'tl-1',
      '--page-size', '20',
      '--completed=false',
      '--as', 'user', '--format', 'json',
    ])
    expectWindowsSafeArgs(runtime)
  })

  it('refuses a cursor from another task range without a provider call', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      items: [taskRecord()], has_more: true, page_token: 'pt',
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!({ scope: { kind: 'tasks' } }, context())
    await expect(operations.list!(
      { scope: { kind: 'tasks', completed: true }, cursor: page.nextCursor },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(1)
  })

  it('uses task +search with the documented single-page flag and never an auto-paging shortcut', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      // Real `task +search` 1.0.55 output rows are FLAT:
      // `{guid, summary, url, created_at, completed_at, updated_at, due_at}`.
      items: [{
        guid: GUID,
        summary: 'Release <hb>checklist</hb>',
        url: URL,
        // The CLI formats these as local `YYYY-MM-DD HH:mm:ss` (not epoch ms).
        created_at: '2023-06-13 07:00:00',
        completed_at: '2023-06-14 08:00:00',
        updated_at: '2023-06-15 09:00:00',
        due_at: '2023-06-16 10:00:00',
      }],
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
      '--page-limit', '1',
      '--as', 'user', '--format', 'json',
    ])
    // The CLI has no `--page-size` for +search; the caller's item limit is not
    // a page-size claim, and `--page-limit 1` is the single-page bound.
    expect(runtime.requests[0]!.args).not.toContain('--page-size')
    expectWindowsSafeArgs(runtime)
    expect(page.items[0]!.title).toBe('Release checklist')
    expect(page.items[0]!.subtitle).toBe('Completed')
    expect(page.items[0]!.meta).toMatchObject({
      completed: true,
      // `due_at`/`completed_at` normalize to one epoch-millisecond instant;
      // the CLI's local wall-clock string is parsed as local time.
      due: String(new Date(2023, 5, 16, 10, 0, 0).getTime()),
      completedAt: String(new Date(2023, 5, 14, 8, 0, 0).getTime()),
      updatedAt: '2023-06-15 09:00:00',
      createdAt: '2023-06-13 07:00:00',
    })
    for (const request of runtime.requests) {
      expect(request.args).not.toContain('--page-all')
      expect(request.args).not.toContain('+get-my-tasks')
      expect(request.args).not.toContain('+get-related-tasks')
    }
  })

  it('passes the documented search filters and binds them into the cursor', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      // Real +search rows are flat (no nested start/due/status).
      items: [{
        guid: GUID,
        summary: 'Release checklist',
        url: URL,
        created_at: '2023-06-13 07:00:00',
        updated_at: '2023-06-15 09:00:00',
      }],
      has_more: true,
      page_token: 'filtered-pt',
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
      '--page-limit', '1',
      '--as', 'user', '--format', 'json',
    ])
    // A cursor from a different filter set must be refused, not replayed.
    await expect(operations.search!(
      { query: 'release', scope: { kind: 'tasks', assignee: 'ou_other' }, cursor: page.nextCursor },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(1)
  })

  it('treats has_more as authoritative and rejects a success envelope without rows', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({ items: [], has_more: false, page_token: 'stale' }))
      .enqueue(okResult({ items: [], has_more: true }))
      .enqueue(okResult({}))
    const { operations } = opsOf(runtime)
    const done = await operations.list!({ scope: { kind: 'tasks' } }, context())
    expect(done.nextCursor).toBeUndefined()
    expect(done.limited).toBeUndefined()
    const truncated = await operations.list!({ scope: { kind: 'tasks' } }, context())
    expect(truncated.nextCursor).toBeUndefined()
    expect(truncated.limited).toBe(true)
    await expect(operations.list!({ scope: { kind: 'tasks' } }, context()))
      .rejects.toMatchObject({ category: 'failed' })
  })

  it('skips a display-number row instead of offering it as a task', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      items: [
        { guid: 't104121', summary: 'Display row', status: 'todo' },
        taskRecord(),
      ],
      has_more: false,
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!({ scope: { kind: 'tasks' } }, context())
    expect(page.items.map(item => (item.locator as { guid: string }).guid)).toEqual([GUID])
  })

  it('validates the keyword like a filter instead of forwarding control characters', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.search!({ query: 'release\u0000drop' }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    await expect(operations.search!({ query: 'x'.repeat(600) }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
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

  it('accepts the documented /client/todo/detail applink and ignores suite_entity_num', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const detailUrl = `https://applink.feishu.cn/client/todo/detail?guid=${GUID}&suite_entity_num=12345`
    const candidate = await operations.resolve!({ text: detailUrl, explicit: true }, context())
    expect(candidate).toMatchObject({
      typeId: FEISHU_TYPE_IDS.task,
      locator: { kind: 'task', guid: GUID, url: detailUrl },
    })
    const withoutGuid = `https://applink.feishu.cn/client/todo/detail?suite_entity_num=12345`
    await expect(operations.resolve!({ text: withoutGuid, explicit: true }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('rejects a displayed task number and numeric GUIDs explicitly (they are not GUIDs)', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.resolve!({ text: 't104121', explicit: true }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    // Auto resolution keeps asking later sources instead of failing the whole parse.
    expect(await operations.resolve!({ text: 't104121' }, context())).toBeUndefined()
    await expect(operations.read!(
      { typeId: FEISHU_TYPE_IDS.task, locator: { kind: 'task', guid: '12345678' } },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    const displayGuid = 'https://applink.feishu.cn/client/todo/detail?guid=t104121'
    await expect(operations.resolve!({ text: displayGuid, explicit: true }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(await operations.resolve!({ text: displayGuid }, context())).toBeUndefined()
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
      '--task-guid', GUID,
      '--as', 'user', '--format', 'json',
    ])
    expectWindowsSafeArgs(runtime)
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

  it('fails on an empty/null get payload instead of fabricating a blank task', async () => {
    const answers = [
      okResult({}),
      okResult({ task: null }),
      okResult({ task: {} }),
      okResult({ task: taskRecord({ guid: 'a-different-guid' }) }),
    ]
    for (const answer of answers) {
      const runtime = new FakeLarkRuntime().enqueue(answer)
      const { operations } = opsOf(runtime)
      await expect(operations.read!(
        { typeId: FEISHU_TYPE_IDS.task, locator: locator() },
        context(),
      )).rejects.toMatchObject({ category: 'failed' })
    }
    // A direct object with the matching GUID is accepted.
    const runtime = new FakeLarkRuntime().enqueue(okResult(taskRecord()))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.task, locator: locator() },
      context(),
    )
    expect(result.data).toMatchObject({ guid: GUID })
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

  it('rejects mixed all-day flags locally (the API requires both times to agree)', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const mixed = editedDocument({
      start: { timestamp: '1700000000000', isAllDay: false },
      due: { timestamp: '1700003600000', isAllDay: true },
    })
    await expect(operations.saveEdit!(saveInput(mixed), context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('submits ONLY the changed fields through the native task PATCH and refreshes the baseline', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      // Native `task tasks patch` output: the updated task under data.task.
      .enqueue(taskGet({
        summary: 'New title',
        description: 'New description',
        updated_at: UPDATED_2,
      }))
      // The native PATCH returns a task but the source still re-reads for the
      // NEXT save's baseline, so a returned stamp cannot mask a stale one.
      .enqueue(taskGet({ summary: 'New title', description: 'New description', updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    const result = await operations.saveEdit!(
      saveInput(editedDocument({ title: 'New title', description: 'New description' })),
      context(),
    )

    expect(runtime.requests).toHaveLength(3)
    expect(runtime.requests[0]!.args.slice(0, 2)).toEqual(['task', 'tasks'])
    const updateArgs = runtime.requests[1]!.args
    expect(updateArgs).toEqual([
      'task', 'tasks', 'patch',
      '--task-guid', GUID,
      '--data', '-',
      '--as', 'user', '--format', 'json',
    ])
    // The JSON body travels on stdin, never as a quoted argv token.
    const body = runtime.requests[1]!.stdin
    expect(typeof body).toBe('string')
    const payload = JSON.parse(body as string) as Record<string, JsonValue>
    expect(payload).toEqual({
      task: { summary: 'New title', description: 'New description' },
      update_fields: ['summary', 'description'],
    })
    expect(updateArgs.every(arg => !arg.includes('"'))).toBe(true)
    expect(updateArgs).not.toContain('--page-all')
    expectWindowsSafeArgs(runtime)
    expect(runtime.requests[2]!.args.slice(0, 3)).toEqual(['task', 'tasks', 'get'])
    expect(result.revision).toBe(UPDATED_2)
  })

  it('gets a fresh revision when the updated task carries no updated_at', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({ task: { guid: GUID, summary: 'No stamp' } }))
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
      .enqueue(okResult({ task: { guid: GUID, summary: 'No stamp' } }))
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
      .enqueue(taskGet({ start: null }))
      .enqueue(taskGet({
        start: null,
        due: { timestamp: '1700007200000', is_all_day: true },
        updated_at: UPDATED_2,
      }))
      .enqueue(taskGet({
        start: null,
        due: { timestamp: '1700007200000', is_all_day: true },
        updated_at: UPDATED_2,
      }))
    const { operations } = opsOf(runtime)
    await operations.saveEdit!(
      saveInput(editedDocument({ start: null, due: { timestamp: '1700007200000', isAllDay: true } })),
      context(),
    )
    const payload = JSON.parse(runtime.requests[1]!.stdin as string) as Record<string, JsonValue>
    expect(payload).toEqual({
      task: { due: { timestamp: '1700007200000', is_all_day: true } },
      update_fields: ['due'],
    })
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
      // Real 1.0.55 `+complete` write output: resource identifiers only. It
      // does not echo status/completed_at/already_completed.
      .enqueue(okResult({ guid: GUID, url: URL }))
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
    // The completion action changes updated_at; the source re-reads it so the
    // NEXT save compares against a fresh baseline instead of a guaranteed conflict.
    expect(result.revision).toBe(UPDATED_2)
  })

  it('treats an already-completed idempotent result as success', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      // `+complete` skips its PATCH when the task is already completed and
      // still returns the same `{guid,url}` write output.
      .enqueue(okResult({ guid: GUID, url: URL }))
      .enqueue(taskGet({ status: 'done', completed_at: '1700009999000', updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(saveInput(editedDocument({ completed: true })), context()))
      .resolves.toMatchObject({ revision: UPDATED_2 })
    expect(runtime.requests).toHaveLength(3)
  })

  it('reopens a completed task with +reopen and confirms the task GUID', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet({ status: 'done', completed_at: '1700009999000' }))
      .enqueue(okResult({ guid: GUID, url: URL }))
      .enqueue(taskGet({ status: 'todo', updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    await operations.saveEdit!(saveInput(editedDocument({ completed: false })), context())
    expect(runtime.requests[1]!.args).toEqual([
      'task', '+reopen', '--task-id', GUID, '--as', 'user', '--format', 'json',
    ])
    expect(runtime.requests).toHaveLength(3)
  })

  it('rejects a completion answer that does not identify the task', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(okResult({ url: URL }))
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(saveInput(editedDocument({ completed: true })), context()))
      .rejects.toMatchObject({ category: 'failed' })
    expect(runtime.requests).toHaveLength(2)
  })

  it('reports partial success when fields were saved but completion failed', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(taskGet({ summary: 'New title', updated_at: UPDATED_2 }))
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

  it('rejects a returned task that does not confirm the changed field', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      .enqueue(taskGet({ summary: 'Some other title' }))
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(saveInput(editedDocument({ title: 'New title' })), context()))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringMatching(/summary/) })
    expect(runtime.requests).toHaveLength(2)
  })

  it('clears a previously set time by naming it in update_fields and omitting it from task', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(taskGet())
      // The API clears a field when update_fields names it but task leaves it
      // out. This is exactly what the `+update` shortcut's --data path cannot
      // express, which is why the save uses the native PATCH.
      .enqueue(taskGet({ due: null, updated_at: UPDATED_2 }))
      .enqueue(taskGet({ due: null, updated_at: UPDATED_2 }))
    const { operations } = opsOf(runtime)
    const result = await operations.saveEdit!(
      saveInput(editedDocument({ due: null })),
      context(),
    )
    const payload = JSON.parse(runtime.requests[1]!.stdin as string) as Record<string, JsonValue>
    expect(payload).toEqual({ task: {}, update_fields: ['due'] })
    expect(result.revision).toBe(UPDATED_2)
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
  it('exports the GUID + plain link from the locator without a CLI call', async () => {
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

  it('reads a GUID-only locator once to recover the host and plain link', async () => {
    const runtime = new FakeLarkRuntime().enqueue(taskGet())
    const { operations } = opsOf(runtime)
    const portable = await operations.portable!(
      { typeId: FEISHU_TYPE_IDS.task, locator: { kind: 'task', guid: GUID } },
      context(),
    )
    expect(portable).toEqual({
      portable: true,
      locator: { kind: 'task', guid: GUID, url: URL, host: 'applink.larksuite.com' },
    })
    expect(runtime.requests).toHaveLength(1)
  })

  it('reports portable:false when the task exposes no link at all', async () => {
    const runtime = new FakeLarkRuntime().enqueue(taskGet({ url: null }))
    const { operations } = opsOf(runtime)
    const portable = await operations.portable!(
      { typeId: FEISHU_TYPE_IDS.task, locator: { kind: 'task', guid: GUID } },
      context(),
    )
    expect(portable.portable).toBe(false)
    expect(portable.reason).toMatch(/link/)
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
