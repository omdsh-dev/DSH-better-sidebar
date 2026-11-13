/** UI19 source save boundary: ordinary agents stay read-only; explicit draft commits work. */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import { createFeishuDocsSource } from '../src/clues/sources/feishu/docs.ts'
import { createFeishuTasksSource } from '../src/clues/sources/feishu/tasks.ts'
import { createGithubSourceRegistrations } from '../src/clues/sources/github/sources.ts'
import type { GithubGhClient } from '../src/clues/sources/github/gh.ts'
import { FakeLarkRuntime, okResult, operationContext } from './clues-feishu-fixture.ts'
import type { ClueOperationContext } from '../src/clues/types.ts'

const context = { ...operationContext(), caller: 'agent-edit' as const }
describe('explicit source draft commits', () => {
  it('allows an explicit GitHub draft commit while refusing an unknown caller', async () => {
    const writes: unknown[] = []
    const client = { saveEdits: async (input: unknown) => { writes.push(input); return { savedAt: '2026-10-24T00:00:00Z' } } } as unknown as GithubGhClient
    const operations = createGithubSourceRegistrations({ client })[0]!.operations!
    const input = { typeId: 'builtin.github.issue', locator: { host: 'github.com', owner: 'a', repo: 'b', kind: 'issue', number: 1 }, document: { format: 'text/markdown', data: { title: 'Title', body: 'Body' }, baseRevision: 'r' } }
    await expect(operations.saveEdit!(input, { ...context, caller: 'other' } as unknown as ClueOperationContext)).rejects.toMatchObject({ category: 'unsupported' })
    await operations.saveEdit!(input, context)
    expect(writes).toHaveLength(1)
  })
  it('refuses ordinary and unknown task save callers before any provider access', async () => {
    const runtime = new FakeLarkRuntime()
    const operations = createFeishuTasksSource(() => runtime.asRuntime()).operations!
    const input = { typeId: 'builtin.feishu.task', locator: { kind: 'task', guid: 'test-guid' }, document: { format: 'feishu.task.document', data: {} } }
    for (const caller of ['agent', 'other']) await expect(operations.saveEdit!(input, { ...context, caller } as unknown as ClueOperationContext)).rejects.toMatchObject({ category: 'permission-denied' })
    expect(runtime.requests).toHaveLength(0)
  })
  it('allows an explicit task draft commit through the existing field save path', async () => {
    const task = { guid: 'test-guid', summary: 'Title', description: 'Body', updated_at: '1700000000000' }
    const runtime = new FakeLarkRuntime().enqueue(okResult({ task }), okResult({ task: { ...task, description: 'Changed' } }), okResult({ task: { ...task, description: 'Changed' } }))
    const operations = createFeishuTasksSource(() => runtime.asRuntime()).operations!
    const input = { typeId: 'builtin.feishu.task', locator: { kind: 'task', guid: 'test-guid' }, document: { format: 'feishu.task.document', data: { kind: 'task', guid: 'test-guid', title: 'Title', description: 'Changed', start: null, due: null, completed: false }, baseRevision: '1700000000000' } }
    await operations.saveEdit!(input, context)
    expect(runtime.requests[1]!.args).toContain('patch')
  })
  it('refuses ordinary and unknown document save callers before any provider access', async () => {
    const runtime = new FakeLarkRuntime()
    const operations = createFeishuDocsSource(() => runtime.asRuntime()).operations!
    const input = { typeId: 'builtin.feishu.docx', locator: { kind: 'docx', docToken: 'doc' }, document: { format: 'feishu.docs.xml', data: {} } }
    for (const caller of ['agent', 'other']) await expect(operations.saveEdit!(input, { ...context, caller } as unknown as ClueOperationContext)).rejects.toMatchObject({ category: 'permission-denied' })
    expect(runtime.requests).toHaveLength(0)
  })
})
