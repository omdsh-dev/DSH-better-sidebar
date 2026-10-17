/**
 * S1 storage contract: per-workspace persistence, atomic writes, revision CAS,
 * loud corruption, and snapshot metadata/content separation.
 *
 * The store is the authority the whole clue line rests on, so these cases pin
 * the failure semantics rather than only the happy path: a stale writer must
 * not lose the committed library, and a damaged document must never be
 * silently replaced by an empty one (that would delete every stable
 * reference).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClueError, type ClueSnapshotContent, type ClueSnapshotMeta } from '../src/clues/types.ts'
import {
  CluesStore,
  emptyWorkspaceState,
  workspaceSnapshotDir,
  workspaceStatePath,
  workspaceStoreDir,
  type WorkspaceState,
} from '../src/clues/store.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-store-'))
  roots.push(path)
  return path
}

function sampleClue(id: string, workspaceId = 'ws-1') {
  return {
    id,
    sourceId: 'test.source',
    typeId: 'test.source.text',
    locator: { path: 'a.txt' },
    title: 'a.txt',
    workspaceId,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

describe('clue store', () => {
  it('reads a missing workspace as an empty library and creates the state lazily', async () => {
    const store = new CluesStore({ root: root() })
    expect(await store.read('ws-1')).toEqual(emptyWorkspaceState())
    const committed = await store.transact('ws-1', undefined, (state) => {
      state.clues.push(sampleClue('clue-1'))
      return state.clues.length
    })
    expect(committed).toEqual({ revision: 1, result: 1 })
    expect((await store.read('ws-1')).clues.map(clue => clue.id)).toEqual(['clue-1'])
  })

  it('keeps stable ids and the revision across a fresh store instance (restart)', async () => {
    const dir = root()
    const first = new CluesStore({ root: dir })
    await first.transact('ws-1', undefined, (state) => {
      state.clues.push(sampleClue('clue-stable'))
    })
    const second = new CluesStore({ root: dir })
    const state = await second.read('ws-1')
    expect(state.revision).toBe(1)
    expect(state.clues[0]?.id).toBe('clue-stable')
    const next = await second.transact('ws-1', 1, (s) => { s.clues[0]!.title = 'renamed' })
    expect(next.revision).toBe(2)
    expect((await new CluesStore({ root: dir }).read('ws-1')).clues[0]?.title).toBe('renamed')
  })

  it('refuses a stale revision with conflict and keeps the committed data', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    await store.transact('ws-1', undefined, (state) => { state.clues.push(sampleClue('one')) })
    await expect(store.transact('ws-1', 0, (state) => {
      state.clues.push(sampleClue('lost'))
    })).rejects.toMatchObject({ category: 'conflict' })
    const state = await store.read('ws-1')
    expect(state.revision).toBe(1)
    expect(state.clues.map(clue => clue.id)).toEqual(['one'])
  })

  it('serializes concurrent writers so neither update is lost', async () => {
    const store = new CluesStore({ root: root() })
    await Promise.all([
      store.transact('ws-1', undefined, (state) => { state.clues.push(sampleClue('a')) }),
      store.transact('ws-1', undefined, (state) => { state.clues.push(sampleClue('b')) }),
    ])
    const state = await store.read('ws-1')
    expect(state.revision).toBe(2)
    expect(state.clues.map(clue => clue.id).sort()).toEqual(['a', 'b'])
  })

  it('lets exactly one of two CAS writers at the same revision succeed', async () => {
    const store = new CluesStore({ root: root() })
    await store.transact('ws-1', 0, (state) => { state.clues.push(sampleClue('base')) })
    const results = await Promise.allSettled([
      store.transact('ws-1', 1, (state) => { state.clues.push(sampleClue('first')) }),
      store.transact('ws-1', 1, (state) => { state.clues.push(sampleClue('second')) }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' ? (rejected.reason as ClueError).category : undefined)
      .toBe('conflict')
    expect((await store.read('ws-1')).revision).toBe(2)
  })

  it('reports a corrupt document loudly and never overwrites it', async () => {
    const dir = root()
    const workspaceId = 'ws-corrupt'
    const path = workspaceStatePath(dir, workspaceId)
    mkdirSync(workspaceStoreDir(dir, workspaceId), { recursive: true })
    writeFileSync(path, '{"revision": 1, "clues": [', 'utf8')
    const before = readFileSync(path, 'utf8')
    const store = new CluesStore({ root: dir })
    await expect(store.read(workspaceId)).rejects.toMatchObject({ category: 'failed' })
    await expect(store.transact(workspaceId, undefined, (state) => { state.revision = 9 }))
      .rejects.toBeInstanceOf(ClueError)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('rejects a malformed state shape (not just invalid JSON)', async () => {
    const dir = root()
    const workspaceId = 'ws-shape'
    const path = workspaceStatePath(dir, workspaceId)
    mkdirSync(workspaceStoreDir(dir, workspaceId), { recursive: true })
    writeFileSync(path, JSON.stringify({ revision: 1, clues: [], packs: 'nope', pins: [], bindings: [] }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId)).rejects.toMatchObject({ category: 'failed' })
  })

  it('writes atomically: no temp siblings survive a commit', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    await store.transact('ws-1', undefined, (state) => { state.clues.push(sampleClue('x')) })
    const entries = readdirSync(workspaceStoreDir(dir, 'ws-1'))
    expect(entries).toEqual(['state.json'])
    const raw = JSON.parse(readFileSync(workspaceStatePath(dir, 'ws-1'), 'utf8')) as WorkspaceState
    expect(raw.revision).toBe(1)
    expect(raw.clues[0]?.id).toBe('x')
  })

  it('fails clearly when no storage root is configured', async () => {
    const store = new CluesStore()
    expect(store.available).toBe(false)
    await expect(store.read('ws-1')).rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('unavailable') })
    await expect(store.transact('ws-1', undefined, () => undefined)).rejects.toMatchObject({ category: 'failed' })
  })

  it('stores snapshot metadata and content in separate, independently readable files', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    const meta: ClueSnapshotMeta = {
      snapshotId: 'snap-1',
      workspaceId: 'ws-1',
      clueId: 'clue-1',
      format: 'text/markdown',
      fetchedAt: '2026-10-17T00:00:00.000Z',
      createdAt: '2026-10-17T00:00:01.000Z',
      integrity: 'verified',
    }
    const content: ClueSnapshotContent = { format: 'text/markdown', data: { text: '# hello' }, text: '# hello' }
    await store.putSnapshot('ws-1', meta, content)

    const dirPath = workspaceSnapshotDir(dir, 'ws-1')
    const entries = readdirSync(dirPath).sort()
    expect(entries).toEqual(['snap-1.content.json', 'snap-1.meta.json'])

    // A separate instance can read both halves without any source runtime.
    const restarted = new CluesStore({ root: dir })
    expect(await restarted.readSnapshotMeta('ws-1', 'snap-1')).toEqual(meta)
    expect(await restarted.readSnapshotContent('ws-1', 'snap-1')).toEqual(content)
    expect((await restarted.readSnapshot('ws-1', 'snap-1')).content).toEqual(content)
    expect((await restarted.listSnapshots('ws-1')).map(row => row.snapshotId)).toEqual(['snap-1'])

    // Deleting the content half only breaks content reads — metadata stays
    // intact, which is the separation the line relies on.
    rmSync(join(dirPath, 'snap-1.content.json'))
    expect((await restarted.readSnapshotMeta('ws-1', 'snap-1')).clueId).toBe('clue-1')
    await expect(restarted.readSnapshotContent('ws-1', 'snap-1')).rejects.toMatchObject({ category: 'not-found' })
  })

  it('reports missing snapshots as not-found and corrupt metadata as failed', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    await expect(store.readSnapshot('ws-1', 'missing')).rejects.toMatchObject({ category: 'not-found' })
    mkdirSync(workspaceSnapshotDir(dir, 'ws-1'), { recursive: true })
    writeFileSync(join(workspaceSnapshotDir(dir, 'ws-1'), 'bad.meta.json'), '{"snapshotId": 1}', 'utf8')
    await expect(store.readSnapshotMeta('ws-1', 'bad')).rejects.toMatchObject({ category: 'failed' })
  })
})
