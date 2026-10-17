/**
 * S7 export contract: `previewExport` (no content reads) and `exportPack` in
 * `references` and `snapshot` modes.
 *
 * Pinned semantics:
 * - references mode never reads a body (the source `read` operation is not
 *   called) and the archive carries only `manifest.json`;
 * - snapshot mode fetches per clue, records real fetchedAt/revision/SHA-256,
 *   preserves raw local-file bytes, and turns every failed/unfetchable item
 *   into an explicit issue instead of silently claiming a complete pack;
 * - progress is reported per item and cancellation leaves no result;
 * - pack membership is ordered and de-duplicated across packs; an empty
 *   selection still produces a valid pack;
 * - credential-shaped values never appear in the archive.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import {
  ClueError,
  type CluePortableRef,
  type ClueReadResult,
  type JsonValue,
  type Locator,
} from '../src/clues/types.ts'
import {
  exportPack,
  previewExport,
  type ClueShareExportDeps,
  type ClueShareExportProgress,
} from '../src/clues/share/export.ts'
import { CLUEPACK_MANIFEST_PATH } from '../src/clues/share/manifest.ts'
import { readZip } from '../src/clues/share/zip.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const FETCHED_AT = '2026-10-16T12:00:00.000Z'
const TEST_SOURCE = 'test.share'
const TEST_TYPE = 'test.share.text'

const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

interface Fixture {
  base: string
  workspace: string
  service: CluesService
  /** Mutable behavior of the test source. */
  source: {
    calls: { read: number; portable: number }
    read?: () => Promise<ClueReadResult>
    portable?: () => Promise<CluePortableRef>
  }
}

/** A service with one controllable source and deterministic ids. */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-export-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
  const source: Fixture['source'] = {
    calls: { read: 0, portable: 0 },
    read: async () => ({
      format: 'text/plain',
      data: { text: 'hello world' },
      text: 'hello world',
      revision: 'rev-1',
      fetchedAt: FETCHED_AT,
    }),
    portable: async () => ({ portable: true, locator: { id: 'a' } }),
  }
  const operations: NonNullable<ClueSourceRegistration['operations']> = {
    async read() {
      source.calls.read += 1
      return source.read!()
    },
    async portable() {
      source.calls.portable += 1
      return source.portable!()
    },
    normalizeLocator(locator: Locator) {
      return { id: String(locator.id ?? '') }
    },
    locatorKey(locator: Locator) {
      return `id:${String(locator.id)}`
    },
  }
  const service = createCluesService({
    root: join(base, 'store'),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
    resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
    builtinSources: [{
      descriptor: {
        sourceId: TEST_SOURCE,
        name: 'Share test source',
        order: 20,
        pluginId: 'plugin.test',
        types: [TEST_TYPE],
        transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: true },
      },
      types: [{
        typeId: TEST_TYPE,
        sourceId: TEST_SOURCE,
        formats: ['text/plain'],
        capabilities: { read: true, edit: false, concurrency: 'none' },
      }],
      operations,
    }],
  })
  return { base, workspace, service, source }
}

/** Ensure one test-source clue and return its local id. */
async function ensureClue(fixtureValue: Fixture, id: string, title = `title ${id}`): Promise<string> {
  const result = await fixtureValue.service.ensure({
    workspaceId: 'ws-1',
    sourceId: TEST_SOURCE,
    typeId: TEST_TYPE,
    locator: { id },
    title,
  })
  return result.clue.id
}

/** Manifest of one export result. */
function manifestOf(bytes: Uint8Array): JsonValue {
  const entry = readZip(bytes).find(candidate => candidate.name === CLUEPACK_MANIFEST_PATH)
  expect(entry).toBeDefined()
  return JSON.parse(new TextDecoder().decode(entry!.data)) as JsonValue
}

/** Deps of one export (real fs reads unless a case overrides). */
function deps(fixtureValue: Fixture, overrides: Partial<ClueShareExportDeps> = {}): ClueShareExportDeps {
  return { clues: fixtureValue.service, now: () => NOW, ...overrides }
}

describe('previewExport', () => {
  it('lists the selection without reading source content', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', '设计笔记')
    const pack = await f.service.createPack({ workspaceId: 'ws-1', name: '发布材料', members: [clueId] })

    const preview = await previewExport(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      packIds: [pack.pack.id],
    })
    expect(preview.mode).toBe('snapshot')
    expect(preview.packs).toEqual([{ packId: pack.pack.id, name: '发布材料', members: 1 }])
    expect(preview.items).toEqual([expect.objectContaining({ clueId, title: '设计笔记', snapshotMode: true })])
    expect(preview.fileName).toBe('发布材料-20261017.cluepack')
    expect(preview.totals).toMatchObject({ clues: 1, packs: 1 })
    expect(f.source.calls.read).toBe(0)
    expect(f.source.calls.portable).toBe(0)
  })

  it('marks unresolved rows and refuses an unknown pack', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: '离线记录',
      reason: 'source is not installed',
    })
    const preview = await previewExport(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [imported.clue.id],
    })
    expect(preview.items[0]).toMatchObject({ title: '离线记录', unresolved: 'source is not installed' })
    expect(preview.warnings.join('\n')).toMatch(/source is not installed/i)
    await expect(previewExport(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: ['pack-missing'],
    })).rejects.toMatchObject({ category: 'not-found' })
  })
})

describe('exportPack references mode', () => {
  it('does not read content and ships only the manifest', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', '公开标题')
    f.source.portable = async () => ({
      portable: true,
      locator: { id: 'a', note: 'ordinary usage' },
    })

    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [clueId],
    })
    expect(f.source.calls.read).toBe(0)
    expect(result.mode).toBe('references')
    expect(result.complete).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.stats).toMatchObject({ clues: 1, packs: 0, sources: 1, snapshots: 0 })
    expect(readZip(result.bytes).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
    const manifest = manifestOf(result.bytes) as unknown as {
      mode: string
      clues: Array<{ title: string; portable: { portable: boolean; locator?: unknown }; snapshot?: unknown }>
      sources: unknown[]
    }
    expect(manifest.mode).toBe('references')
    expect(manifest.clues[0]).toMatchObject({
      title: '公开标题',
      portable: { portable: true, locator: { id: 'a', note: 'ordinary usage' } },
    })
    expect(manifest.clues[0]!.snapshot).toBeUndefined()
    expect(new TextDecoder().decode(result.bytes)).not.toContain('hello world')
    expect(new TextDecoder().decode(result.bytes)).not.toContain('SECRET-TOKEN')
  })

  it('represents an unresolved clue as a non-portable reference with a reason', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: '离线记录',
      reason: 'source is not installed',
      portable: { portable: false, reason: 'no portable address' },
    })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [imported.clue.id],
    })
    expect(f.source.calls.portable).toBe(0)
    const manifest = manifestOf(result.bytes) as unknown as { clues: Array<{ portable: CluePortableRef }> }
    expect(manifest.clues[0]!.portable).toEqual({ portable: false, reason: 'no portable address' })
    expect(result.complete).toBe(true)
  })

  it('reports a portable-reference failure as an issue instead of inventing one', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    f.source.portable = async () => {
      throw new ClueError('auth-required', 'the source requires authorization')
    }
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [clueId],
    })
    expect(result.complete).toBe(false)
    expect(result.issues[0]).toMatchObject({ target: 'clue', category: 'auth-required' })
    const manifest = manifestOf(result.bytes) as unknown as { clues: Array<{ portable: CluePortableRef }> }
    expect(manifest.clues[0]!.portable.portable).toBe(false)
  })
})

describe('exportPack snapshot mode', () => {
  it('writes a JSON content entry with real hash/size/fetchedAt/revision', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(result.complete).toBe(true)
    expect(result.stats).toMatchObject({ snapshots: 1 })
    const manifest = manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; bytes: number; sha256: string; fetchedAt: string; sourceVersion: string; format: string } }>
    }
    const snapshot = manifest.clues[0]!.snapshot
    expect(snapshot).toMatchObject({
      path: 'content/clue-1.json',
      encoding: 'json',
      format: 'text/plain',
      fetchedAt: FETCHED_AT,
      sourceVersion: 'rev-1',
    })
    const content = readZip(result.bytes).find(entry => entry.name === snapshot.path)
    expect(content).toBeDefined()
    expect(content!.data.byteLength).toBe(snapshot.bytes)
    expect(createHash('sha256').update(content!.data).digest('hex')).toBe(snapshot.sha256)
    expect(JSON.parse(new TextDecoder().decode(content!.data))).toEqual({
      format: 'text/plain',
      data: { text: 'hello world' },
      text: 'hello world',
    })
  })

  it('preserves raw local-file bytes and media type', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'binary')
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 0, 42])
    const assetPath = join(f.base, 'asset.bin')
    writeFileSync(assetPath, bytes)
    f.source.read = async () => ({
      format: 'application/octet-stream',
      data: { kind: 'binary', path: assetPath, size: bytes.length },
      fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: assetPath, mime: 'application/x-test', size: bytes.length }],
    })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(result.complete).toBe(true)
    const manifest = manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; mediaType: string; bytes: number; sha256: string } }>
    }
    const snapshot = manifest.clues[0]!.snapshot
    expect(snapshot).toMatchObject({
      encoding: 'raw',
      mediaType: 'application/x-test',
      bytes: bytes.length,
    })
    const content = readZip(result.bytes).find(entry => entry.name === snapshot.path)
    expect(content!.data).toEqual(bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.sha256)
  })

  it('reports read failures, unfetchable sources and limited reads as issues', async () => {
    const f = fixture()
    const authFail = await ensureClue(f, 'auth')
    const unsupported = await ensureClue(f, 'unsupported')
    const limited = await ensureClue(f, 'limited')
    const ok = await ensureClue(f, 'ok')
    f.source.read = async () => {
      const current = f.source.calls.read
      if (current === 1) throw new ClueError('auth-required', 'the source requires authorization')
      if (current === 2) throw new ClueError('unsupported', 'the source cannot read this type')
      if (current === 3) {
        return { format: 'text/plain', data: { text: 'page' }, text: 'page', fetchedAt: FETCHED_AT, limited: true }
      }
      return { format: 'text/plain', data: { text: 'ok' }, text: 'ok', fetchedAt: FETCHED_AT }
    }
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [authFail, unsupported, limited, ok],
    })
    expect(result.complete).toBe(false)
    expect(result.issues).toHaveLength(3)
    expect(result.issues.map(issue => issue.category)).toEqual(['auth-required', 'unsupported', 'unsupported'])
    expect(result.issues[2]!.reason).toMatch(/not fully captured|limited/i)
    expect(result.stats).toMatchObject({ clues: 4, snapshots: 1 })
    const manifest = manifestOf(result.bytes) as unknown as { clues: Array<{ snapshot?: unknown }>; issues: unknown[] }
    expect(manifest.clues.filter(clue => clue.snapshot !== undefined)).toHaveLength(1)
    expect(manifest.issues).toHaveLength(3)
  })

  it('reports a snapshot that exceeds the per-content limit and omits it', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const result = await exportPack(deps(f, { maxSnapshotBytes: 8 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(result.complete).toBe(false)
    expect(result.issues[0]!.reason).toMatch(/limit/i)
    expect(result.stats).toMatchObject({ snapshots: 0 })
  })

  it('fails loudly when the assembled archive exceeds the export limit', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    await expect(exportPack(deps(f, { maxArchiveBytes: 32 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })).rejects.toMatchObject({ category: 'failed' })
  })
})

describe('exportPack selection, progress and cancellation', () => {
  it('unions packs in order, de-duplicates shared clues and keeps pack membership', async () => {
    const f = fixture()
    const first = await ensureClue(f, 'a', 'A')
    const second = await ensureClue(f, 'b', 'B')
    const third = await ensureClue(f, 'c', 'C')
    const packA = await f.service.createPack({ workspaceId: 'ws-1', name: 'Pack A', members: [first, second] })
    const packB = await f.service.createPack({ workspaceId: 'ws-1', name: 'Pack B', members: [second, third] })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [packA.pack.id, packB.pack.id],
    })
    const manifest = manifestOf(result.bytes) as unknown as {
      clues: Array<{ key: string; title: string }>
      packs: Array<{ key: string; name: string; members: string[] }>
    }
    expect(manifest.clues.map(clue => clue.title)).toEqual(['A', 'B', 'C'])
    expect(manifest.packs.map(pack => pack.name)).toEqual(['Pack A', 'Pack B'])
    const keysByTitle = new Map(manifest.clues.map(clue => [clue.title, clue.key]))
    expect(manifest.packs[0]!.members).toEqual([keysByTitle.get('A'), keysByTitle.get('B')])
    expect(manifest.packs[1]!.members).toEqual([keysByTitle.get('B'), keysByTitle.get('C')])
    expect(result.stats).toMatchObject({ clues: 3, packs: 2 })
  })

  it('produces a valid empty pack and a portable file name', async () => {
    const f = fixture()
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references' })
    expect(result.complete).toBe(true)
    expect(result.fileName).toBe('clues-20261017.cluepack')
    expect(readZip(result.bytes).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
    const manifest = manifestOf(result.bytes) as unknown as { clues: unknown[]; packs: unknown[]; sources: unknown[] }
    expect(manifest).toMatchObject({ clues: [], packs: [], sources: [] })
  })

  it('sanitizes unsafe pack names in the download name but keeps the manifest title', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const pack = await f.service.createPack({
      workspaceId: 'ws-1',
      name: 'a/b:c*?.md',
      members: [clueId],
    })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [pack.pack.id],
    })
    expect(result.fileName).toBe('a-b-c--.md-20261017.cluepack')
    const manifest = manifestOf(result.bytes) as unknown as { packs: Array<{ name: string }> }
    expect(manifest.packs[0]!.name).toBe('a/b:c*?.md')
  })

  it('reports progress per clue and a final done event', async () => {
    const f = fixture()
    const first = await ensureClue(f, 'a')
    const second = await ensureClue(f, 'b')
    const events: ClueShareExportProgress[] = []
    await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [first, second],
      onProgress: event => events.push(event),
    })
    expect(events[0]).toMatchObject({ phase: 'collect', completed: 0, total: 2 })
    expect(events.filter(event => event.phase === 'read')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ phase: 'done', completed: 2, total: 2 })
  })

  it('refuses a cancelled export without producing bytes', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const controller = new AbortController()
    controller.abort()
    await expect(exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
      signal: controller.signal,
    })).rejects.toMatchObject({ category: 'cancelled' })
    expect(f.source.calls.read).toBe(0)
  })
})
