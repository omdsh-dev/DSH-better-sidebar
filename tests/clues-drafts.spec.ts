/** Public draft seam: complete body files, immutable baseline, one commit and durable recovery. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClueDraftManager } from '../src/clues/drafts.ts'
import { ClueError } from '../src/clues/error.ts'
import type { ClueEditDocument, CluesReadParams } from '../src/clues/types.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(removeTree) })
const resource: CluesReadParams = { workspaceId: 'w', sourceId: 'builtin.github.issues', typeId: 'builtin.github.issue', locator: { number: 7 }, sessionId: 's' }
async function fixture(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clue-drafts-')); roots.push(root)
  let document: ClueEditDocument = { format: 'github.document', data: { title: 'Keep title', body: 'Entire body\n\nLast paragraph', labels: ['kept'] }, baseRevision: 'r1' }
  const loadEdit = vi.fn(async () => structuredClone(document))
  const saveEdit = vi.fn(async () => ({ revision: 'r2', savedAt: '2026-10-24T00:00:00Z' }))
  const clues = { loadEdit, saveEdit }
  const manager = createClueDraftManager({ root, clues, ...options })
  return { root, clues, manager, change: (value: ClueEditDocument) => { document = value } }
}

describe('clue body drafts', () => {
  it('prepares the entire Markdown body and commits only its edit while preserving metadata', async () => {
    const { manager, clues } = await fixture()
    const draft = await manager.prepare(resource)
    expect(draft.bodyPath.endsWith('.md')).toBe(true)
    expect(await readFile(draft.bodyPath, 'utf8')).toBe('Entire body\n\nLast paragraph')
    await writeFile(draft.bodyPath, 'Edited whole body')
    const result = await manager.commit(draft.draftId)
    expect(result.status).toBe('committed')
    expect(clues.saveEdit).toHaveBeenCalledWith({ ...resource, document: { format: 'github.document', data: { title: 'Keep title', body: 'Edited whole body', labels: ['kept'] }, baseRevision: 'r1' } }, { caller: 'agent-edit', sessionId: 's' })
    expect((await manager.commit(draft.draftId)).status).toBe('committed')
    expect(clues.saveEdit).toHaveBeenCalledTimes(1)
  })

  it('restores prepared task descriptions after restart and preserves every other task field', async () => {
    const { manager, clues, root, change } = await fixture()
    const task = { format: 'feishu.task.document', baseRevision: 't1', data: { kind: 'task', guid: 'task1', title: 'Keep task title', description: 'Complete **description**', start: null, due: null, completed: false } }
    change(task)
    const prepared = await manager.prepare(resource)
    expect(await readFile(prepared.bodyPath, 'utf8')).toBe('Complete **description**')
    const resumed = createClueDraftManager({ clues, root })
    expect((await resumed.list())[0]?.status).toBe('prepared')
    await writeFile(prepared.bodyPath, 'Revised **description**')
    await resumed.commit(prepared.draftId)
    expect(clues.saveEdit).toHaveBeenCalledWith({ ...resource, document: { ...task, data: { ...task.data, description: 'Revised **description**' } } }, { caller: 'agent-edit', sessionId: 's' })
  })

  it('recovers an interrupted attempt as uncertain without replaying or losing its body', async () => {
    const { manager, clues, root } = await fixture()
    const prepared = await manager.prepare(resource)
    await writeFile(join(root, 'clue-drafts', `${prepared.draftId}.attempt`), 'attempted\n')
    const recovered = createClueDraftManager({ clues, root })
    expect((await recovered.list())[0]?.status).toBe('uncertain')
    await expect(recovered.commit(prepared.draftId)).rejects.toMatchObject({ category: 'conflict' })
    expect(clues.saveEdit).not.toHaveBeenCalled()
    expect(await readFile(prepared.bodyPath, 'utf8')).toBe('Entire body\n\nLast paragraph')
  })

  it('refuses changed baselines before writing and keeps the agent edit available', async () => {
    const { manager, clues, change } = await fixture()
    const draft = await manager.prepare(resource)
    await writeFile(draft.bodyPath, 'Must survive')
    change({ format: 'github.document', data: { title: 'External', body: 'Changed upstream' }, baseRevision: 'r2' })
    await expect(manager.commit(draft.draftId)).rejects.toMatchObject({ category: 'conflict' })
    expect(clues.saveEdit).not.toHaveBeenCalled()
    expect(await readFile(draft.bodyPath, 'utf8')).toBe('Must survive')
    expect((await manager.list())[0]?.status).toBe('failed')
  })

  it('never blindly retries partial or uncertain writes, including after a restart', async () => {
    const { manager, clues, root } = await fixture()
    const draft = await manager.prepare(resource)
    await writeFile(draft.bodyPath, 'Retained failed file')
    clues.saveEdit.mockRejectedValueOnce(new Error('transport failed with token=secret'))
    await expect(manager.commit(draft.draftId)).rejects.toMatchObject({ category: 'failed' })
    expect((await manager.list())[0]).toMatchObject({ status: 'uncertain', error: { message: 'The write outcome is uncertain; inspect the resource before preparing a new draft.' } })
    const recovered = createClueDraftManager({ clues, root })
    expect((await recovered.list())[0]?.status).toBe('uncertain')
    await expect(recovered.commit(draft.draftId)).rejects.toMatchObject({ category: 'conflict' })
    expect(clues.saveEdit).toHaveBeenCalledTimes(1)
    expect(await readFile(draft.bodyPath, 'utf8')).toBe('Retained failed file')
  })

  it('records a known partial write distinctly and never replays it after restart', async () => {
    const { manager, clues, root } = await fixture()
    const draft = await manager.prepare(resource)
    clues.saveEdit.mockRejectedValueOnce(new ClueError('failed', 'a block update was partial', { partial: 'true', written: 'p1', unwritten: 'p2' }))
    await expect(manager.commit(draft.draftId)).rejects.toMatchObject({ meta: { partial: 'true' } })
    expect((await manager.list())[0]).toMatchObject({ status: 'partial', error: { partial: true } })
    const recovered = createClueDraftManager({ root, clues })
    expect((await recovered.list())[0]?.status).toBe('partial')
    await expect(recovered.commit(draft.draftId)).rejects.toMatchObject({ category: 'conflict' })
    expect(clues.saveEdit).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent POSTs and restores committed receipts after restart', async () => {
    const { manager, clues, root } = await fixture()
    const draft = await manager.prepare(resource)
    const results = await Promise.all([manager.commit(draft.draftId), manager.commit(draft.draftId)])
    expect(results.map(result => result.status)).toEqual(['committed', 'committed'])
    expect(clues.saveEdit).toHaveBeenCalledTimes(1)
    expect((await createClueDraftManager({ clues, root }).commit(draft.draftId)).status).toBe('committed')
    expect(clues.saveEdit).toHaveBeenCalledTimes(1)
  })

  it('reclaims successful body files and old receipts rather than filling the active draft capacity', async () => {
    const { manager } = await fixture({ maxDrafts: 1 })
    const first = await manager.prepare(resource)
    await manager.commit(first.draftId)
    await expect(readFile(first.bodyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const next = await manager.prepare(resource)
    expect(next.draftId).not.toBe(first.draftId)
    expect((await manager.list()).map(value => value.draftId)).toEqual([next.draftId])
  })

  it('enforces capacity without evicting failed drafts and bounds edited bytes', async () => {
    const { manager } = await fixture({ maxDrafts: 1, maxBodyBytes: 48 })
    const draft = await manager.prepare(resource)
    await expect(manager.prepare(resource)).rejects.toMatchObject({ category: 'failed' })
    await writeFile(draft.bodyPath, 'x'.repeat(49))
    await expect(manager.commit(draft.draftId)).rejects.toMatchObject({ category: 'invalid-request' })
    expect(await readFile(draft.bodyPath, 'utf8')).toHaveLength(49)
    await manager.discard(draft.draftId)
    expect(await manager.list()).toEqual([])
    await expect(manager.prepare(resource)).resolves.toMatchObject({ status: 'prepared' })
  })
})
