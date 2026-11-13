/** UI19 people enrichment is bounded per visible page, never one request per row. */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import { createFeishuTasksSource } from '../src/clues/sources/feishu/tasks.ts'
import { feishuPeopleNames } from '../src/clues/sources/feishu/people.ts'
import { FakeLarkRuntime, okResult, failResult, operationContext } from './clues-feishu-fixture.ts'
const GUID = '2f4d8c1e-7a3b-4c5d-9e8f-0123456789ab'

describe('Feishu visible people', () => {
  it('resolves all missing creator/member names on a task page with one deduplicated contact request', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [
      { guid: GUID, summary: 'Task', creator: { id: 'ou_alice' }, members: [{ id: 'ou_alice', role: 'assignee' }, { id: 'ou_bob', role: 'follower' }] },
      { guid: 'another-guid', summary: 'Second', creator: { id: 'ou_known', name: 'Known' } },
    ], has_more: false }), okResult({ items: [{ open_id: 'ou_alice', name: 'Alice' }, { open_id: 'ou_bob', name: 'Bob' }] }))
    const operations = createFeishuTasksSource(() => runtime.asRuntime()).operations!
    const page = await operations.list!({}, operationContext())
    expect(page.items[0]?.info).toMatchObject({ author: { id: 'ou_alice', name: 'Alice' }, assignees: [{ id: 'ou_alice', name: 'Alice' }], followers: [{ id: 'ou_bob', name: 'Bob' }] })
    expect(runtime.requests).toHaveLength(2)
    expect(JSON.parse(String(runtime.requests[1]!.stdin))).toEqual({ user_ids: ['ou_alice', 'ou_bob'], user_id_type: 'open_id' })
  })

  it('leaves task authors as IDs when contact scope is unavailable', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ task: { guid: GUID, summary: 'Task', creator: { id: 'ou_alice' } } }), failResult({ type: 'authorization', subtype: 'missing_scope', missing_scopes: ['contact:contact.base:readonly'] }))
    const read = await createFeishuTasksSource(() => runtime.asRuntime()).operations!.read!({ typeId: 'builtin.feishu.task', locator: { kind: 'task', guid: GUID } }, operationContext())
    expect(read.info?.author).toEqual({ id: 'ou_alice' })
    expect(runtime.requests).toHaveLength(2)
    expect(runtime.reports).toHaveLength(0)
  })

  it('batches at the official 50-ID bound and never replaces existing page names', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({ items: [] }), okResult({ items: [] }))
    const people = Array.from({ length: 51 }, (_, index) => ({ id: `ou_${index}` }))
    const names = await feishuPeopleNames(runtime.asRuntime(), [...people, { id: 'ou_known', name: 'Known' }, { id: 'ou_known' }], operationContext())
    expect(names.get('ou_known')).toBe('Known')
    expect(runtime.requests.map(request => JSON.parse(String(request.stdin)).user_ids.length)).toEqual([50, 1])
  })
})
