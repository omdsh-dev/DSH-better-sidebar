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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { CluesStore } from '../src/clues/store.ts'
import {
  ClueError,
  type CluePortableRef,
  type ClueReadResult,
  type JsonValue,
  type Locator,
} from '../src/clues/types.ts'
import {
  DEFAULT_MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  exportPack,
  inspectExport,
  previewExport,
  type ClueShareExportDeps,
  type ClueShareExportProgress,
} from '../src/clues/share/export.ts'
import { CLUEPACK_MANIFEST_PATH, MAX_MANIFEST_BYTES } from '../src/clues/share/manifest.ts'
import {
  SAFE_FAILURE_REASONS,
  SAFE_PORTABLE_REFUSED_REASON,
  SAFE_UNRESOLVED_REASON,
} from '../src/clues/share/reasons.ts'
import { previewImport } from '../src/clues/share/import.ts'
import { DEFAULT_ZIP_LIMITS, readZip } from '../src/clues/share/zip.ts'
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
function fixture(storeOverride?: CluesStore): Fixture {
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
    ...(storeOverride === undefined ? { root: join(base, 'store') } : { store: storeOverride }),
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
    // Inject a secret-shaped body into the LIVE content and a cached snapshot:
    // references mode must ship neither, or the "no SECRET-TOKEN in the
    // archive" assertion below would prove nothing.
    f.source.read = async () => ({
      format: 'text/plain',
      data: { text: 'SECRET-TOKEN body' },
      text: 'SECRET-TOKEN body',
      fetchedAt: FETCHED_AT,
    })
    await f.service.putSnapshot('ws-1', {
      clueId,
      format: 'text/plain',
      fetchedAt: FETCHED_AT,
      data: { text: 'SECRET-CACHED body' },
      text: 'SECRET-CACHED body',
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
    // The live body was deliberately set to a secret-shaped value; neither the
    // archive bytes nor the manifest may carry it.
    expect(new TextDecoder().decode(result.bytes)).not.toContain('SECRET-TOKEN')
    expect(new TextDecoder().decode(result.bytes)).not.toContain('SECRET-CACHED')
    expect(JSON.stringify(manifest)).not.toContain('SECRET-TOKEN')
    expect(JSON.stringify(manifest)).not.toContain('SECRET-CACHED')
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
    expect(manifest.clues[0]!.portable).toEqual({ portable: false, reason: SAFE_UNRESOLVED_REASON })
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

  it('never copies a source-provided portable reason or a stored unresolved reason', async () => {
    const f = fixture()
    const live = await ensureClue(f, 'a')
    // A source may put a bearer token/path into a reason. The manifest must
    // carry the fixed category wording, never this text.
    f.source.portable = async () => ({
      portable: false,
      locator: { id: 'a' },
      reason: 'Authorization failed Bearer SECRET-TOKEN at /Users/sender/.auth',
    })
    const liveExport = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [live],
    })
    const liveManifest = manifestOf(liveExport.bytes)
    expect(JSON.stringify(liveManifest)).not.toContain('SECRET-TOKEN')
    expect(JSON.stringify(liveManifest)).not.toContain('/Users/sender')
    expect((liveManifest as unknown as { clues: Array<{ portable: CluePortableRef }> }).clues[0]!.portable)
      .toMatchObject({ portable: false, reason: SAFE_PORTABLE_REFUSED_REASON })

    // A portable:true reference needs no reason; an untrusted one must not be
    // copied either.
    f.source.portable = async () => ({
      portable: true,
      locator: { id: 'a' },
      reason: 'Bearer SECRET-PORTABLE-TOKEN at /Users/sender/.auth',
    })
    const portableExport = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [live],
    })
    const portableManifest = manifestOf(portableExport.bytes)
    expect(JSON.stringify(portableManifest)).not.toContain('SECRET-PORTABLE-TOKEN')
    expect(JSON.stringify(portableManifest)).not.toContain('/Users/sender')
    expect((portableManifest as unknown as { clues: Array<{ portable: CluePortableRef }> }).clues[0]!.portable)
      .toEqual({ portable: true, locator: { id: 'a' } })

    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: { id: 'offline' },
      title: '离线记录',
      reason: 'auth failed cookie=SECRET-COOKIE at /Users/sender/.auth',
      portable: {
        portable: false,
        locator: { id: 'offline' },
        reason: 'Bearer SECRET-PORTABLE-TOKEN',
      },
    })
    const unresolvedExport = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [imported.clue.id],
    })
    const unresolvedManifest = manifestOf(unresolvedExport.bytes)
    expect(JSON.stringify(unresolvedManifest)).not.toContain('SECRET-COOKIE')
    expect(JSON.stringify(unresolvedManifest)).not.toContain('SECRET-PORTABLE-TOKEN')
    expect(JSON.stringify(unresolvedManifest)).not.toContain('/Users/sender')
    const unresolvedClue = (unresolvedManifest as unknown as {
      clues: Array<{ portable: CluePortableRef }>
      issues: Array<{ reason: string }>
    }).clues[0]!
    expect(unresolvedClue.portable.reason).toBe(SAFE_UNRESOLVED_REASON)
    expect((unresolvedManifest as unknown as { issues: Array<{ reason: string }> }).issues[0]!.reason)
      .toBe(`no snapshot was captured: ${SAFE_UNRESOLVED_REASON}`)
    expect(unresolvedExport.complete).toBe(false)
  })

  it('never copies a source error message copied by an unresolved import into a re-export', async () => {
    const f = fixture()
    // The importer itself must store a fixed category message, not the raw
    // ClueError message. Seed that path through the real import service.
    const { importPack } = await import('../src/clues/share/import.ts')
    const { createZip } = await import('../src/clues/share/zip.ts')
    const { serializeCluepackManifest } = await import('../src/clues/share/manifest.ts')
    const manifest = {
      formatVersion: 1 as const,
      format: 'dsh-cluepack' as const,
      exportedAt: NOW,
      mode: 'references' as const,
      sources: [{ key: 'source-1', sourceId: 'test.share', name: 'Share test source' }],
      clues: [{
        key: 'clue-1',
        sourceKey: 'source-1',
        typeId: TEST_TYPE,
        title: 'Auth secret',
        portable: { portable: true as const, locator: { id: 'secret' } },
      }],
      packs: [],
      issues: [],
    }
    const bytes = createZip([{ name: 'manifest.json', data: serializeCluepackManifest(manifest) }])
    const failing = {
      ...f.service,
      ensure: async () => {
        throw new ClueError(
          'auth-required',
          'auth failed cookie=SECRET-COOKIE at /Users/sender/.auth',
        )
      },
    } as CluesService
    const imported = await importPack({ clues: failing }, { workspaceId: 'ws-1', bytes })
    expect(imported.complete).toBe(false)
    const row = (await f.service.listClues('ws-1')).clues[0]!
    expect(row.unresolved?.reason).toBe(SAFE_FAILURE_REASONS['auth-required'])
    expect(row.unresolved?.reason).not.toContain('SECRET-COOKIE')

    const reExported = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [row.id],
    })
    const exportedManifest = manifestOf(reExported.bytes)
    expect(JSON.stringify(exportedManifest)).not.toContain('SECRET-COOKIE')
    expect(JSON.stringify(exportedManifest)).not.toContain('/Users/sender')
  })

  it('never copies a sender-local path from a source error into the manifest', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    f.source.read = async () => {
      throw new ClueError('not-found', '"/var/folders/sender/private/missing.md" does not exist')
    }
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(result.complete).toBe(false)
    expect(result.issues[0]).toMatchObject({ category: 'not-found' })
    expect(result.issues[0]!.reason).not.toContain('/var/folders')
    const manifest = manifestOf(result.bytes) as unknown as { issues: Array<{ reason: string }> }
    expect(JSON.stringify(manifest)).not.toContain('/var/folders')
    expect(manifest.issues[0]!.reason).toMatch(/not found/i)
  })
})

describe('export reference lookups', () => {
  it('does not read the whole workspace state once per selected clue', async () => {
    class CountingStore extends CluesStore {
      reads = 0
      override async read(workspaceId: string) {
        this.reads += 1
        return super.read(workspaceId)
      }
    }
    const storeBase = mkdtempSync(join(tmpdir(), 'dsh-clues-share-export-store-'))
    roots.push(storeBase)
    const store = new CountingStore({ root: join(storeBase, 'store') })
    const f = fixture(store)
    const ids: string[] = []
    for (let index = 0; index < 10; index += 1) ids.push(await ensureClue(f, `id-${index}`))
    store.reads = 0
    const references = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: ids,
    })
    expect(references.complete).toBe(true)
    // Exactly listClues + listPacks. A clueId-based portable/read lookup would
    // add one full-store read per clue (12 reads here, 2N+2 for snapshot).
    expect(store.reads).toBe(2)

    store.reads = 0
    const snapshot = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: ids,
    })
    expect(snapshot.complete).toBe(true)
    expect(store.reads).toBe(2)
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

  it('packages a structured body and every asset instead of silently taking the first asset', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'multi')
    const first = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const second = new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6])
    const firstPath = join(f.base, 'one.png')
    const secondPath = join(f.base, 'two.png')
    writeFileSync(firstPath, first)
    writeFileSync(secondPath, second)
    f.source.read = async () => ({
      format: 'text/plain',
      data: { text: 'DOCUMENT BODY' },
      text: 'DOCUMENT BODY',
      fetchedAt: FETCHED_AT,
      assets: [
        { kind: 'download', path: firstPath, mime: 'image/png', size: first.length },
        { kind: 'open', path: secondPath, mime: 'image/png', size: second.length },
      ],
    })
    const exported = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(exported.complete).toBe(true)
    expect(exported.issues).toEqual([])
    const entries = readZip(exported.bytes)
    expect(entries.map(entry => entry.name).sort()).toEqual([
      'content/clue-1.asset-1.bin',
      'content/clue-1.asset-2.bin',
      'content/clue-1.json',
      'manifest.json',
    ])
    const manifest = manifestOf(exported.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; assets?: Array<{ path: string; kind: string; mediaType: string; bytes: number; sha256: string }> } }>
    }
    const snapshot = manifest.clues[0]!.snapshot
    expect(snapshot).toMatchObject({ path: 'content/clue-1.json', encoding: 'json' })
    expect(snapshot.assets).toHaveLength(2)
    expect(snapshot.assets!.map(asset => asset.kind)).toEqual(['download', 'open'])
    const body = JSON.parse(new TextDecoder().decode(
      entries.find(entry => entry.name === 'content/clue-1.json')!.data,
    )) as { format: string; data: { text: string }; text: string }
    expect(body).toEqual({ format: 'text/plain', data: { text: 'DOCUMENT BODY' }, text: 'DOCUMENT BODY' })
    expect(entries.find(entry => entry.name === 'content/clue-1.asset-1.bin')!.data).toEqual(first)
    expect(entries.find(entry => entry.name === 'content/clue-1.asset-2.bin')!.data).toEqual(second)

    // A receiver stores every payload, and an offline re-share reproduces them.
    let next = 0
    const offline = createCluesService({
      root: join(f.base, 'offline-store'),
      now: () => NOW,
      newId: kind => `${kind}-${++next}`,
    })
    const { importPack } = await import('../src/clues/share/import.ts')
    const imported = await importPack({ clues: offline }, {
      workspaceId: 'offline-ws',
      bytes: exported.bytes,
    })
    expect(imported.complete).toBe(true)
    expect(imported.snapshots).toHaveLength(1)
    const stored = await offline.readSnapshot({
      workspaceId: 'offline-ws',
      snapshotId: imported.snapshots[0]!.snapshotId,
    })
    expect(stored.content).toMatchObject({ format: 'text/plain', text: 'DOCUMENT BODY' })
    expect(stored.content.data).toMatchObject({
      kind: 'cluepack-snapshot-bundle',
      version: 1,
      primary: { encoding: 'json', data: { text: 'DOCUMENT BODY' } },
    })
    expect((stored.content.data as { assets: unknown[] }).assets).toHaveLength(2)

    const reExported = await exportPack({ clues: offline, now: () => NOW }, {
      workspaceId: 'offline-ws',
      mode: 'snapshot',
      clueIds: [imported.clues[0]!.clueId],
    })
    expect(reExported.complete).toBe(true)
    expect(reExported.issues).toEqual([])
    const reEntries = readZip(reExported.bytes)
    expect(reEntries.map(entry => entry.name).sort()).toEqual(entries.map(entry => entry.name).sort())
    const reManifest = manifestOf(reExported.bytes) as unknown as {
      clues: Array<{ snapshot: { assets?: Array<{ bytes: number; sha256: string }> } }>
    }
    expect(reManifest.clues[0]!.snapshot.assets).toHaveLength(2)
    expect(reEntries.find(entry => entry.name === 'content/clue-1.asset-2.bin')!.data).toEqual(second)
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

  it('stops reading as soon as the expanded limit is exceeded', async () => {
    const f = fixture()
    const first = await ensureClue(f, 'a')
    const second = await ensureClue(f, 'b')
    const third = await ensureClue(f, 'c')
    await expect(exportPack(deps(f, { maxTotalBytes: 1 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [first, second, third],
    })).rejects.toThrowError(/expanded size limit/i)
    // The old implementation read all three payloads and only checked after
    // the loop; the bounds must be enforced while capturing.
    expect(f.source.calls.read).toBe(1)
  })

  it('pre-checks the entry count before a source read', async () => {
    const f = fixture()
    const first = await ensureClue(f, 'a')
    await expect(exportPack(deps(f, { maxEntries: 1 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [first],
    })).rejects.toThrowError(/entry limit/i)
    expect(f.source.calls.read).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'does not trust a regular-file stat when the asset was swapped for a FIFO',
    async () => {
      const f = fixture()
      const clueId = await ensureClue(f, 'fifo')
      const fifo = join(f.base, 'asset.fifo')
      execFileSync('mkfifo', [fifo])
      f.source.read = async () => ({
        format: 'application/octet-stream',
        data: { kind: 'binary', path: fifo, size: 0 },
        fetchedAt: FETCHED_AT,
        assets: [{ kind: 'download', path: fifo, mime: 'application/octet-stream', size: 0 }],
      })
      // Simulate the race: stat promised a regular file, but the object that
      // is actually opened is a FIFO. O_NONBLOCK keeps the open from waiting
      // for a writer and fstat refuses the real object.
      const result = await exportPack(deps(f, {
        statFile: async () => ({ size: 0, isFile: true }),
      }), {
        workspaceId: 'ws-1',
        mode: 'snapshot',
        clueIds: [clueId],
      })
      expect(result.complete).toBe(false)
      expect(result.issues).toContainEqual(expect.objectContaining({
        category: 'unsupported',
        reason: SAFE_FAILURE_REASONS.unsupported,
      }))
    },
  )

  it('never opens a non-regular local asset', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'binary')
    let assetReads = 0
    f.source.read = async () => ({
      format: 'application/octet-stream',
      data: { kind: 'binary', path: '/dev/null', size: 0 },
      fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: '/dev/null', mime: 'application/x-test', size: 0 }],
    })
    const result = await exportPack(deps(f, {
      statFile: async () => ({ size: 0, isFile: false }),
      readFileBytes: async () => {
        assetReads += 1
        return new Uint8Array()
      },
    }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(result.complete).toBe(false)
    expect(result.issues[0]).toMatchObject({ category: 'unsupported', reason: /regular file/i })
    expect(assetReads).toBe(0)
  })

  it('indexes stored snapshots once for every offline clue', async () => {
    const f = fixture()
    const first = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: 'Offline one',
      reason: 'source is not installed',
    })
    const second = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: 'Offline two',
      reason: 'source is not installed',
    })
    for (const clue of [first, second]) {
      await f.service.putSnapshot('ws-1', {
        clueId: clue.clue.id,
        format: 'text/plain',
        fetchedAt: FETCHED_AT,
        data: { text: clue.clue.id },
      })
    }
    let listCalls = 0
    const counting = {
      ...f.service,
      listSnapshots: async (workspaceId: string) => {
        listCalls += 1
        return f.service.listSnapshots(workspaceId)
      },
    } as CluesService
    const result = await exportPack({ clues: counting, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [first.clue.id, second.clue.id],
    })
    expect(result.complete).toBe(true)
    expect(result.stats.snapshots).toBe(2)
    expect(listCalls).toBe(1)
  })

  it('falls back to the newest stored snapshot when a live read now fails', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', 'Live with old snapshot')
    await f.service.putSnapshot('ws-1', {
      clueId,
      format: 'text/plain',
      fetchedAt: FETCHED_AT,
      data: { text: 'stored before the source disappeared' },
      text: 'stored before the source disappeared',
    })
    f.source.read = async () => {
      throw new ClueError('source-missing', 'the source is no longer installed')
    }
    const progress: ClueShareExportProgress[] = []
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
      onProgress: event => progress.push(event),
    })
    // A failed live read that falls back to an OLD snapshot is a partial
    // export, never a silent complete one: the receiver must see the failure
    // category and the snapshot's real (old) fetchedAt.
    expect(result.complete).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ target: 'clue', category: 'source-missing' })
    expect(result.issues[0]!.reason).toContain(FETCHED_AT)
    expect(result.issues[0]!.reason).toMatch(/earlier snapshot/i)
    expect(result.stats.snapshots).toBe(1)
    expect(progress.find(event => event.key === 'clue-1')?.status).toBe('issue')
    const manifest = manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { fetchedAt: string; encoding: string } }>
      issues: Array<{ category: string }>
    }
    expect(manifest.clues[0]!.snapshot).toMatchObject({ fetchedAt: FETCHED_AT, encoding: 'json' })
    expect(manifest.issues).toEqual([expect.objectContaining({ category: 'source-missing' })])

    // The import confirmation sees BOTH the failure and the old acquisition
    // time, so "this is a stale snapshot" is visible before committing.
    const preview = await previewImport({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: result.bytes,
    })
    expect(preview.items[0]!.snapshotFetchedAt).toBe(FETCHED_AT)
    expect(preview.warnings.join('\n')).toContain(FETCHED_AT)
    expect(preview.warnings.join('\n')).toMatch(/earlier snapshot/i)
  })

  it('lets the ZIP writer reject an archive over the exact limit', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    await expect(exportPack(deps(f, { maxArchiveBytes: 32 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })).rejects.toThrowError(/zip archive exceeds the size limit/i)
  })

  it('accepts a compressible snapshot whose expanded bytes exceed the archive limit', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const text = 'a'.repeat(200_000)
    f.source.read = async () => ({
      format: 'text/plain',
      data: { text },
      text,
      fetchedAt: FETCHED_AT,
    })
    // 200 KiB expands far past this 4 KiB archive bound, but deflate shrinks
    // the JSON payload well under it. Comparing expanded bytes with the
    // archive limit refused this legal pack in the old implementation.
    const result = await exportPack(deps(f, { maxArchiveBytes: 4_096 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(result.complete).toBe(true)
    expect(result.bytes.byteLength).toBeLessThanOrEqual(4_096)
    expect(readZip(result.bytes, {
      maxArchiveBytes: 4_096,
      maxEntryBytes: DEFAULT_MAX_SNAPSHOT_BYTES,
    }).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH, 'content/clue-1.json'])
  })

  it('lets the writer reject an incompressible asset over the archive limit', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const bytes = new Uint8Array(8_192)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 131 + 17) % 256
    let assetReads = 0
    f.source.read = async () => ({
      format: 'application/octet-stream',
      data: { kind: 'binary', path: '/virtual/asset.bin', size: bytes.length },
      fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: '/virtual/asset.bin', mime: 'application/octet-stream', size: bytes.length }],
    })
    // The expanded check would have rejected this too, but it must be the
    // WRITER's exact check that decides: no expanded-vs-archive precheck may
    // stand in for the real archive size.
    await expect(exportPack(deps(f, {
      maxArchiveBytes: 4_096,
      statFile: async () => ({ size: bytes.length, isFile: true }),
      readFileBytes: async () => {
        assetReads += 1
        return bytes
      },
    }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })).rejects.toThrowError(/zip archive exceeds the size limit/i)
    expect(assetReads).toBe(1)
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

describe('inspectExport (share confirmation)', () => {
  it('shows the exact portable locator without reading content', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', '私有文档')
    f.source.portable = async () => ({
      portable: true,
      locator: { url: 'https://example.invalid/private/资源?id=42' },
    })
    const inspection = await inspectExport(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [clueId],
    })
    expect(inspection.items).toHaveLength(1)
    expect(inspection.items[0]).toMatchObject({
      clueId,
      title: '私有文档',
      sourceId: TEST_SOURCE,
      portable: { portable: true, locator: { url: 'https://example.invalid/private/资源?id=42' } },
    })
    expect(inspection.sources[0]).toMatchObject({ sourceId: TEST_SOURCE })
    expect(inspection.fileName).toBe('clues-20261017.cluepack')
    // The consent step resolves addresses only: it must never read content.
    expect(f.source.calls).toEqual({ read: 0, portable: 1 })
  })

  it('shows the stored reference of an unresolved row and its local reason', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: '离线记录',
      reason: 'source is not installed',
      portable: { portable: true, locator: { docId: 'doc-42' } },
    })
    const inspection = await inspectExport(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [imported.clue.id],
    })
    expect(inspection.items[0]).toMatchObject({
      unresolved: 'source is not installed',
      portable: { portable: true, locator: { docId: 'doc-42' } },
      snapshotMode: true,
    })
    expect(inspection.warnings.join('\n')).toMatch(/not installed/i)
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
  })

  it('keeps a per-item portable failure as a readable warning', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    f.source.portable = async () => {
      throw new ClueError('auth-required', 'the source requires authorization')
    }
    const inspection = await inspectExport(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [clueId],
    })
    expect(inspection.items[0]!.portable).toMatchObject({
      portable: false,
      reason: SAFE_FAILURE_REASONS['auth-required'],
    })
    expect(inspection.warnings.join('\n')).toMatch(/authorization/i)
    expect(f.source.calls.read).toBe(0)
  })
})

describe('stored snapshot selection', () => {
  it('picks the newest snapshot by timestamp instant, not by string order', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: 'Offline',
      reason: 'source is not installed',
    })
    // 23:00+08:00 is 15:00Z; 16:00Z is LATER as an instant, but the
    // lexicographically larger string would win under a string compare.
    await f.service.putSnapshot('ws-1', {
      clueId: imported.clue.id,
      format: 'text/plain',
      fetchedAt: '2026-10-16T23:00:00+08:00',
      data: { text: 'older content' },
      text: 'older content',
    })
    await f.service.putSnapshot('ws-1', {
      clueId: imported.clue.id,
      format: 'text/plain',
      fetchedAt: '2026-10-16T16:00:00Z',
      data: { text: 'newer content' },
      text: 'newer content',
    })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [imported.clue.id],
    })
    const manifest = manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { fetchedAt: string; path: string } }>
    }
    expect(manifest.clues[0]!.snapshot.fetchedAt).toBe('2026-10-16T16:00:00Z')
    const content = readZip(result.bytes).find(entry => entry.name === manifest.clues[0]!.snapshot.path)!
    expect(JSON.parse(new TextDecoder().decode(content.data))).toMatchObject({ text: 'newer content' })
  })
})

describe('export limits match the importer', () => {
  it('publishes exactly the reader/import defaults', () => {
    expect(DEFAULT_MAX_SNAPSHOT_BYTES).toBe(DEFAULT_ZIP_LIMITS.maxEntryBytes)
    expect(DEFAULT_MAX_ARCHIVE_BYTES).toBe(DEFAULT_ZIP_LIMITS.maxArchiveBytes)
    expect(DEFAULT_MAX_ENTRIES).toBe(DEFAULT_ZIP_LIMITS.maxEntries)
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(DEFAULT_ZIP_LIMITS.maxTotalBytes)
    expect(DEFAULT_MAX_MANIFEST_BYTES).toBe(MAX_MANIFEST_BYTES)
    // S1 accepts a 10,000-member pack; the archive must be able to hold it.
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThanOrEqual(10_001)
  })

  it('refuses an over-limit entry count, manifest and expanded size before ZIP assembly', async () => {
    const f = fixture()
    const first = await ensureClue(f, 'a')
    const second = await ensureClue(f, 'b')
    const third = await ensureClue(f, 'c')
    await expect(exportPack(deps(f, { maxEntries: 1 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [first],
    })).rejects.toThrowError(/entry limit/i)
    await expect(exportPack(deps(f, { maxManifestBytes: 16 }), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [first],
    })).rejects.toThrowError(/manifest exceeds/i)
    await expect(exportPack(deps(f, { maxTotalBytes: 16, maxManifestBytes: 1_000_000 }), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [first, second, third],
    })).rejects.toThrowError(/expanded size limit/i)
  })

  it('counts one manifest entry in references mode, not one per clue', async () => {
    const f = fixture()
    const first = await ensureClue(f, 'a')
    const second = await ensureClue(f, 'b')
    // A references pack has exactly one ZIP entry; the old pre-check counted
    // clues+1 and refused this legal custom limit.
    const references = await exportPack(deps(f, { maxEntries: 2 }), {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [first, second],
    })
    expect(references.complete).toBe(true)
    await expect(exportPack(deps(f, { maxEntries: 2 }), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [first, second],
    })).rejects.toThrowError(/entry limit/i)
  })

  it('produces an archive readZip accepts at the same default limits', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(readZip(result.bytes).map(entry => entry.name)).toEqual([
      CLUEPACK_MANIFEST_PATH,
      'content/clue-1.json',
    ])
  })
})

describe('download file names', () => {
  it('truncates a long emoji pack name by code point, never mid-surrogate', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const pack = await f.service.createPack({
      workspaceId: 'ws-1',
      name: 'a' + '😀'.repeat(60),
      members: [clueId],
    })
    const preview = await previewExport(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [pack.pack.id],
    })
    expect(preview.fileName).toMatch(/^a(?:😀)+-\d{8}\.cluepack$/)
    // No unpaired surrogate reached the proposed name.
    expect(preview.fileName).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect([...preview.fileName].length).toBeLessThanOrEqual(100 + '-20261017.cluepack'.length)
    const exported = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [pack.pack.id],
    })
    expect(exported.fileName).toBe(preview.fileName)
  })
})

describe('snapshot mode with unresolved clues', () => {
  it('re-shares the stored JSON snapshot instead of reporting a missing source', async () => {
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
    await f.service.putSnapshot('ws-1', {
      clueId: imported.clue.id,
      format: 'text/plain',
      fetchedAt: FETCHED_AT,
      data: { text: 'stored body' },
      text: 'stored body',
    })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [imported.clue.id],
    })
    expect(result.complete).toBe(true)
    expect(result.stats).toMatchObject({ snapshots: 1 })
    const manifest = manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; format: string; fetchedAt: string; sha256: string; bytes: number } }>
    }
    const snapshot = manifest.clues[0]!.snapshot
    expect(snapshot).toMatchObject({
      path: 'content/clue-1.json',
      encoding: 'json',
      format: 'text/plain',
      fetchedAt: FETCHED_AT,
    })
    const content = readZip(result.bytes).find(entry => entry.name === snapshot.path)!
    expect(content.data.byteLength).toBe(snapshot.bytes)
    expect(createHash('sha256').update(content.data).digest('hex')).toBe(snapshot.sha256)
    expect(JSON.parse(new TextDecoder().decode(content.data))).toEqual({
      format: 'text/plain',
      data: { text: 'stored body' },
      text: 'stored body',
    })
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
  })

  it('re-shares a stored binary snapshot byte-for-byte', async () => {
    const f = fixture()
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 0, 13, 10])
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: '离线资产',
      reason: 'source is not installed',
    })
    await f.service.putSnapshot('ws-1', {
      clueId: imported.clue.id,
      format: 'image/png',
      fetchedAt: FETCHED_AT,
      data: {
        kind: 'binary',
        mediaType: 'image/png',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        encoding: 'base64',
        base64: Buffer.from(bytes).toString('base64'),
      },
    })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [imported.clue.id],
    })
    expect(result.complete).toBe(true)
    const manifest = manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; mediaType: string; format: string } }>
    }
    expect(manifest.clues[0]!.snapshot).toMatchObject({
      encoding: 'raw',
      mediaType: 'image/png',
      format: 'image/png',
    })
    const content = readZip(result.bytes).find(entry => entry.name === manifest.clues[0]!.snapshot.path)!
    expect(content.data).toEqual(bytes)
  })

  it('still reports a source-missing issue when the unresolved clue has no snapshot', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: {},
      title: '无快照',
      reason: 'source is not installed',
    })
    const result = await exportPack(deps(f), {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [imported.clue.id],
    })
    expect(result.complete).toBe(false)
    expect(result.issues[0]).toMatchObject({ target: 'clue', category: 'source-missing' })
    expect(result.stats.snapshots).toBe(0)
  })
})
