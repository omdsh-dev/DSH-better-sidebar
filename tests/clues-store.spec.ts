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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    // Clue is readonly: replace the row rather than mutating the committed shape.
    const next = await second.transact('ws-1', 1, (s) => { s.clues[0] = { ...s.clues[0]!, title: 'renamed' } })
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

  it('rejects malformed ELEMENTS instead of surfacing raw TypeErrors later', async () => {
    const dir = root()
    const workspaceId = 'ws-rows'
    const path = workspaceStatePath(dir, workspaceId)
    mkdirSync(workspaceStoreDir(dir, workspaceId), { recursive: true })
    const valid = { revision: 1, clues: [], packs: [], pins: [], bindings: [] }
    writeFileSync(path, JSON.stringify({ ...valid, clues: [null] }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('clues[0]') })

    writeFileSync(path, JSON.stringify({ ...valid, packs: [{ id: 'p' }] }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('packs[0]') })

    writeFileSync(path, JSON.stringify({ ...valid, pins: [{ workspaceId: 'ws-rows' }] }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('pins[0]') })

    writeFileSync(path, JSON.stringify({
      ...valid,
      bindings: [{ workspaceId: 'ws-rows', target: { kind: 'nope' }, createdAt: 'now' }],
    }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('bindings[0]') })
  })

  it('keeps dot-only workspace ids inside workspaces/ instead of climbing out', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    for (const workspaceId of ['..', '.']) {
      const storeDir = workspaceStoreDir(dir, workspaceId)
      // One ordinary child directory; never the workspaces root or its parent.
      expect(dirname(storeDir)).toBe(join(dir, 'workspaces'))
      await store.transact(workspaceId, undefined, (state) => {
        state.clues.push(sampleClue(`clue-${workspaceId === '..' ? 'dots' : 'dot'}`, workspaceId))
      })
      const state = await store.read(workspaceId)
      expect(state.clues[0]?.workspaceId).toBe(workspaceId)
    }
    // The traversal used to create <root>/state.json (the clues root).
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
    expect(readdirSync(join(dir, 'workspaces')).sort()).toEqual(['%2E', '%2E%2E'])
  })

  it('rejects state rows owned by another workspace', async () => {
    const dir = root()
    const workspaceId = 'ws-owner'
    const path = workspaceStatePath(dir, workspaceId)
    mkdirSync(workspaceStoreDir(dir, workspaceId), { recursive: true })
    const valid = { revision: 1, clues: [], packs: [], pins: [], bindings: [] }
    const pack = {
      id: 'pack-1',
      name: 'P',
      workspaceId: 'ws-other',
      members: [],
      revision: 0,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    }

    writeFileSync(path, JSON.stringify({ ...valid, clues: [sampleClue('clue-1', 'ws-other')] }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId)).rejects.toMatchObject({
      category: 'failed',
      message: expect.stringContaining('belongs to workspace "ws-other"'),
    })

    writeFileSync(path, JSON.stringify({ ...valid, packs: [pack] }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('packs[0]') })

    writeFileSync(path, JSON.stringify({
      ...valid,
      pins: [{ workspaceId: 'ws-other', clueId: 'clue-1', createdAt: '2026-10-17T00:00:00.000Z' }],
    }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('pins[0]') })

    writeFileSync(path, JSON.stringify({
      ...valid,
      bindings: [{ workspaceId: 'ws-other', target: { kind: 'clue', clueId: 'clue-1' }, createdAt: '2026-10-17T00:00:00.000Z' }],
    }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId))
      .rejects.toMatchObject({ category: 'failed', message: expect.stringContaining('bindings[0]') })
  })

  it('rejects duplicate stable ids in one state document', async () => {
    const dir = root()
    const workspaceId = 'ws-dupes'
    const path = workspaceStatePath(dir, workspaceId)
    mkdirSync(workspaceStoreDir(dir, workspaceId), { recursive: true })
    const valid = { revision: 1, clues: [], packs: [], pins: [], bindings: [] }
    writeFileSync(path, JSON.stringify({
      ...valid,
      clues: [sampleClue('same', workspaceId), sampleClue('same', workspaceId)],
    }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId)).rejects.toMatchObject({
      category: 'failed',
      message: expect.stringContaining('duplicate id "same"'),
    })

    const pack = {
      id: 'same-pack',
      name: 'P',
      workspaceId,
      members: [],
      revision: 0,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    }
    writeFileSync(path, JSON.stringify({ ...valid, packs: [pack, pack] }), 'utf8')
    await expect(new CluesStore({ root: dir }).read(workspaceId)).rejects.toMatchObject({
      category: 'failed',
      message: expect.stringContaining('duplicate id "same-pack"'),
    })
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

  it('refuses a duplicate snapshot id instead of silently overwriting the imported snapshot', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    const meta: ClueSnapshotMeta = {
      snapshotId: 'snap-stable',
      workspaceId: 'ws-1',
      clueId: 'clue-1',
      format: 'text/markdown',
      fetchedAt: '2026-10-17T00:00:00.000Z',
      createdAt: '2026-10-17T00:00:01.000Z',
      integrity: 'verified',
    }
    await store.putSnapshot('ws-1', meta, { format: 'text/markdown', data: { text: 'first' } })
    await expect(store.putSnapshot('ws-1', meta, { format: 'text/markdown', data: { text: 'second' } }))
      .rejects.toMatchObject({ category: 'conflict' })
    // The committed snapshot is untouched.
    expect((await store.readSnapshotContent('ws-1', 'snap-stable')).data).toEqual({ text: 'first' })
  })

  it('serializes concurrent snapshot puts so exactly one duplicate can win', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    const meta: ClueSnapshotMeta = {
      snapshotId: 'snap-race',
      workspaceId: 'ws-1',
      clueId: 'clue-1',
      format: 'text/markdown',
      fetchedAt: '2026-10-17T00:00:00.000Z',
      createdAt: '2026-10-17T00:00:01.000Z',
      integrity: 'verified',
    }
    const results = await Promise.allSettled([
      store.putSnapshot('ws-1', meta, { format: 'text/markdown', data: { text: 'first' } }),
      store.putSnapshot('ws-1', meta, { format: 'text/markdown', data: { text: 'second' } }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' ? (rejected.reason as ClueError).category : undefined)
      .toBe('conflict')
    // The surviving pair is complete and belongs to the one that won.
    expect((await store.readSnapshotMeta('ws-1', 'snap-race')).snapshotId).toBe('snap-race')
    expect([{ text: 'first' }, { text: 'second' }])
      .toContainEqual((await store.readSnapshotContent('ws-1', 'snap-race')).data)
  })

  it('removes partial content when the metadata half fails, so the id can be retried', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    const meta: ClueSnapshotMeta = {
      snapshotId: 'snap-retry',
      workspaceId: 'ws-1',
      clueId: 'clue-1',
      format: 'text/markdown',
      fetchedAt: '2026-10-17T00:00:00.000Z',
      createdAt: '2026-10-17T00:00:01.000Z',
    }
    const content = { format: 'text/markdown', data: { text: 'first' } }
    // A value JSON.stringify rejects makes only the METADATA write fail, after
    // the content file has already been committed.
    const badMeta = { ...meta, sourceVersion: 1n as unknown as string }
    await expect(store.putSnapshot('ws-1', badMeta, content))
      .rejects.toMatchObject({ category: 'failed' })
    // No orphan content: the duplicate check would otherwise conflict forever.
    expect(readdirSync(workspaceSnapshotDir(dir, 'ws-1'))).not.toContain('snap-retry.content.json')
    expect(await store.listSnapshots('ws-1')).toEqual([])

    await store.putSnapshot('ws-1', meta, content)
    expect((await store.readSnapshotContent('ws-1', 'snap-retry')).data).toEqual({ text: 'first' })
  })
})
