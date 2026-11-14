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
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import { CluesStore } from '../src/clues/store.ts'
import { ClueError, type CluePortableRef, type ClueReadResult, type JsonValue, type Locator } from '../src/clues/types.ts'
import {
  DEFAULT_MAX_ARCHIVE_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_MANIFEST_BYTES, DEFAULT_MAX_SNAPSHOT_BYTES, DEFAULT_MAX_TOTAL_BYTES,
  exportPack, inspectExport, previewExport, type ClueShareExportDeps, type ClueShareExportProgress,
} from '../src/clues/share/export.ts'
import { importPack, previewImport } from '../src/clues/share/import.ts'
import { CLUEPACK_MANIFEST_PATH, MAX_MANIFEST_BYTES } from '../src/clues/share/manifest.ts'
import { SAFE_FAILURE_REASONS, SAFE_PORTABLE_REFUSED_REASON, SAFE_SOURCE_NOT_INSTALLED, SAFE_UNRESOLVED_REASON } from '../src/clues/share/reasons.ts'
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
  source: { calls: { read: number; portable: number }; read?: () => Promise<ClueReadResult>; portable?: () => Promise<CluePortableRef> }
}

interface FixtureOptions {
  readonly store?: CluesStore
  readonly descriptor?: { readonly pluginId?: string; readonly name?: string }
}

/** A service with one controllable source and deterministic ids. */
function fixture(options: FixtureOptions = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-export-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
  const source: Fixture['source'] = {
    calls: { read: 0, portable: 0 },
    read: async () => ({ format: 'text/plain', data: { text: 'hello world' }, text: 'hello world', revision: 'rev-1', fetchedAt: FETCHED_AT }),
    portable: async () => ({ portable: true, locator: { id: 'a' } }),
  }
  const service = createCluesService({
    ...(options.store === undefined ? { root: join(base, 'store') } : { store: options.store }),
    now: () => NOW,
    newId: kind => kind + '-' + (++next),
    resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
    builtinSources: [{
      descriptor: {
        sourceId: TEST_SOURCE, name: 'Share test source', order: 20, pluginId: 'plugin.test', ...(options.descriptor ?? {}),
        types: [TEST_TYPE], transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: true },
      },
      types: [{ typeId: TEST_TYPE, sourceId: TEST_SOURCE, formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
      operations: {
        async read() { source.calls.read += 1; return source.read!() },
        async portable() { source.calls.portable += 1; return source.portable!() },
        normalizeLocator(locator: Locator) { return { id: String(locator.id ?? '') } },
        locatorKey(locator: Locator) { return 'id:' + String(locator.id) },
      },
    }],
  })
  return { base, workspace, service, source }
}

/** Ensure one test-source clue and return its local id. */
async function ensureClue(f: Fixture, id: string, title = 'title ' + id): Promise<string> {
  return (await f.service.ensure({ workspaceId: 'ws-1', sourceId: TEST_SOURCE, typeId: TEST_TYPE, locator: { id }, title })).clue.id
}

/** Manifest of one export result. */
function manifestOf(bytes: Uint8Array): JsonValue {
  const entry = readZip(bytes).find(candidate => candidate.name === CLUEPACK_MANIFEST_PATH)
  expect(entry).toBeDefined()
  return JSON.parse(new TextDecoder().decode(entry!.data)) as JsonValue
}

/** Deps of one export (real fs reads unless a case overrides). */
function deps(f: Fixture, overrides: Partial<ClueShareExportDeps> = {}): ClueShareExportDeps {
  return { clues: f.service, now: () => NOW, ...overrides }
}

describe('previewExport', () => {
  it('lists the selection without reading source content', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', '设计笔记')
    const pack = await f.service.createPack({ workspaceId: 'ws-1', name: '发布材料', members: [clueId] })
    const preview = await previewExport(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', packIds: [pack.pack.id] })
    expect(preview).toMatchObject({ mode: 'snapshot', fileName: '发布材料-20261017.cluepack', totals: { clues: 1, packs: 1 } })
    expect(preview.packs).toEqual([{ packId: pack.pack.id, name: '发布材料', members: 1 }])
    expect(preview.items).toEqual([expect.objectContaining({ clueId, title: '设计笔记', snapshotMode: true })])
    // The consent step resolves addresses only: preview must never read content.
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
  })
  it('marks unresolved rows, refuses an unknown pack and never echoes a stored reason', async () => {
    const f = fixture()
    const senderPath = join(f.base, 'private', 'notes.md')
    const safeRow = await f.service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: '离线记录', reason: SAFE_SOURCE_NOT_INSTALLED })
    const untrusted = await f.service.importUnresolved({
      workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: '历史行',
      reason: 'cannot open ' + senderPath, portable: { portable: true, locator: { docId: 'doc-1' } },
    })
    const clueIds = [safeRow.clue.id, untrusted.clue.id]
    const preview = await previewExport(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds })
    expect(preview.items[0]).toMatchObject({ title: '离线记录', unresolved: SAFE_SOURCE_NOT_INSTALLED })
    expect(preview.items[1]!.unresolved).toBe(SAFE_UNRESOLVED_REASON)
    expect(preview.warnings.join('\n')).toMatch(/source is not installed/i)
    expect(JSON.stringify(preview)).not.toContain(senderPath)
    const inspection = await inspectExport(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds })
    expect(inspection.items[1]!.unresolved).toBe(SAFE_UNRESOLVED_REASON)
    expect(JSON.stringify(inspection)).not.toContain(senderPath)
    await expect(previewExport(deps(f), { workspaceId: 'ws-1', mode: 'references', packIds: ['pack-missing'] })).rejects.toMatchObject({ category: 'not-found' })
  })
})

describe('exportPack references mode', () => {
  it('does not read content and ships only the manifest', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', '公开标题')
    f.source.portable = async () => ({ portable: true, locator: { id: 'a', note: 'ordinary usage' } })
    // Inject a secret-shaped body into the LIVE content and a cached snapshot:
    // references mode must ship neither.
    f.source.read = async () => ({ format: 'text/plain', data: { text: 'SECRET-TOKEN body' }, text: 'SECRET-TOKEN body', fetchedAt: FETCHED_AT })
    await f.service.putSnapshot('ws-1', { clueId, format: 'text/plain', fetchedAt: FETCHED_AT, data: { text: 'SECRET-CACHED body' }, text: 'SECRET-CACHED body' })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [clueId] })
    expect(f.source.calls.read).toBe(0)
    expect(result).toMatchObject({ mode: 'references', complete: true, issues: [], stats: { clues: 1, packs: 0, sources: 1, snapshots: 0 } })
    expect(readZip(result.bytes).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
    const manifest = manifestOf(result.bytes) as unknown as {
      mode: string
      clues: Array<{ title: string; portable: { portable: boolean; locator?: unknown }; snapshot?: unknown }>
    }
    expect(manifest.mode).toBe('references')
    expect(manifest.clues[0]).toMatchObject({ title: '公开标题', portable: { portable: true, locator: { id: 'a', note: 'ordinary usage' } } })
    expect(manifest.clues[0]!.snapshot).toBeUndefined()
    expect(new TextDecoder().decode(result.bytes)).not.toMatch(/SECRET-TOKEN|SECRET-CACHED/)
  })
  it('represents an unresolved clue as a non-portable reference with a reason', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: '离线记录',
      reason: 'source is not installed', portable: { portable: false, reason: 'no portable address' },
    })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [imported.clue.id] })
    expect(f.source.calls.portable).toBe(0)
    expect((manifestOf(result.bytes) as unknown as { clues: Array<{ portable: CluePortableRef }> }).clues[0]!.portable)
      .toEqual({ portable: false, reason: SAFE_UNRESOLVED_REASON })
    expect(result.complete).toBe(true)
  })
  it('degrades a portable failure to an issue and omits empty attribution', async () => {
    const failing = fixture()
    const failingId = await ensureClue(failing, 'a')
    failing.source.portable = async () => { throw new ClueError('auth-required', 'the source requires authorization') }
    const failed = await exportPack(deps(failing), { workspaceId: 'ws-1', mode: 'references', clueIds: [failingId] })
    expect(failed.complete).toBe(false)
    expect(failed.issues[0]).toMatchObject({ target: 'clue', category: 'auth-required' })
    expect((manifestOf(failed.bytes) as unknown as { clues: Array<{ portable: CluePortableRef }> }).clues[0]!.portable.portable).toBe(false)
    // The manifest refuses empty optional strings; copying an empty
    // pluginId/name used to fail after every read.
    const f = fixture({ descriptor: { pluginId: '', name: '' } })
    const clueId = await ensureClue(f, 'a')
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [clueId] })
    expect(result.complete).toBe(true)
    expect((manifestOf(result.bytes) as unknown as { sources: Array<Record<string, unknown>> }).sources[0])
      .toEqual({ key: 'source-1', sourceId: TEST_SOURCE, transport: 'mcp', typeIds: [TEST_TYPE] })
  })
  it('never copies a source-provided or stored reason into the manifest', async () => {
    const f = fixture()
    const live = await ensureClue(f, 'a')
    // A source may put a bearer token/path into a reason; the manifest must
    // carry the fixed category wording instead.
    f.source.portable = async () => ({ portable: false, locator: { id: 'a' }, reason: 'Authorization failed Bearer SECRET-TOKEN at /Users/sender/.auth' })
    const refused = manifestOf((await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [live] })).bytes)
    expect(JSON.stringify(refused)).not.toMatch(/SECRET-TOKEN|\/Users\/sender/)
    expect((refused as unknown as { clues: Array<{ portable: CluePortableRef }> }).clues[0]!.portable)
      .toMatchObject({ portable: false, reason: SAFE_PORTABLE_REFUSED_REASON })
    // A portable:true reference needs no reason; an untrusted one must not be copied either.
    f.source.portable = async () => ({ portable: true, locator: { id: 'a' }, reason: 'Bearer SECRET-PORTABLE-TOKEN at /Users/sender/.auth' })
    const portable = manifestOf((await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [live] })).bytes)
    expect(JSON.stringify(portable)).not.toMatch(/SECRET-PORTABLE-TOKEN|\/Users\/sender/)
    expect((portable as unknown as { clues: Array<{ portable: CluePortableRef }> }).clues[0]!.portable).toEqual({ portable: true, locator: { id: 'a' } })
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: { id: 'offline' }, title: '离线记录',
      reason: 'auth failed cookie=SECRET-COOKIE at /Users/sender/.auth', portable: { portable: false, locator: { id: 'offline' }, reason: 'Bearer SECRET-PORTABLE-TOKEN' },
    })
    const unresolvedExport = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [imported.clue.id] })
    const unresolvedManifest = manifestOf(unresolvedExport.bytes) as unknown as {
      clues: Array<{ portable: CluePortableRef }>
      issues: Array<{ reason: string }>
    }
    expect(JSON.stringify(unresolvedManifest)).not.toMatch(/SECRET-COOKIE|SECRET-PORTABLE-TOKEN|\/Users\/sender/)
    expect(unresolvedManifest.clues[0]!.portable.reason).toBe(SAFE_UNRESOLVED_REASON)
    expect(unresolvedManifest.issues[0]!.reason).toBe('no snapshot was captured: ' + SAFE_UNRESOLVED_REASON)
    expect(unresolvedExport.complete).toBe(false)
  })
  it('never copies a source error message copied by an unresolved import into a re-export', async () => {
    const f = fixture()
    // The importer itself must store a fixed category message, not the raw ClueError.
    const { importPack } = await import('../src/clues/share/import.ts')
    const { createZip } = await import('../src/clues/share/zip.ts')
    const { serializeCluepackManifest } = await import('../src/clues/share/manifest.ts')
    const manifest = {
      formatVersion: 1 as const, format: 'dsh-cluepack' as const, exportedAt: NOW, mode: 'references' as const,
      sources: [{ key: 'source-1', sourceId: TEST_SOURCE, name: 'Share test source' }],
      clues: [{ key: 'clue-1', sourceKey: 'source-1', typeId: TEST_TYPE, title: 'Auth secret', portable: { portable: true as const, locator: { id: 'secret' } } }],
      packs: [], issues: [],
    }
    const bytes = createZip([{ name: 'manifest.json', data: serializeCluepackManifest(manifest) }])
    const failing = { ...f.service, ensure: async () => { throw new ClueError('auth-required', 'auth failed cookie=SECRET-COOKIE at /Users/sender/.auth') } } as CluesService
    expect((await importPack({ clues: failing }, { workspaceId: 'ws-1', bytes })).complete).toBe(false)
    const row = (await f.service.listClues('ws-1')).clues[0]!
    expect(row.unresolved?.reason).toBe(SAFE_FAILURE_REASONS['auth-required'])
    const reExported = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [row.id] })
    expect(JSON.stringify(manifestOf(reExported.bytes))).not.toMatch(/SECRET-COOKIE|\/Users\/sender/)
  })
})

describe('export reference lookups', () => {
  it('does not read the whole workspace state once per selected clue', async () => {
    class CountingStore extends CluesStore {
      reads = 0
      override async read(workspaceId: string) { this.reads += 1; return super.read(workspaceId) }
    }
    const storeBase = mkdtempSync(join(tmpdir(), 'dsh-clues-share-export-store-'))
    roots.push(storeBase)
    const store = new CountingStore({ root: join(storeBase, 'store') })
    const f = fixture({ store })
    const ids: string[] = []
    for (let index = 0; index < 10; index += 1) ids.push(await ensureClue(f, 'id-' + index))
    store.reads = 0
    expect((await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: ids })).complete).toBe(true)
    // Exactly listClues + listPacks; a per-clue lookup would add one read each.
    expect(store.reads).toBe(2)
    store.reads = 0
    expect((await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: ids })).complete).toBe(true)
    expect(store.reads).toBe(2)
  })
})

describe('exportPack snapshot mode', () => {
  it('writes a JSON content entry with real hash/size/fetchedAt/revision', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(result).toMatchObject({ complete: true, stats: { snapshots: 1 } })
    const snapshot = (manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; bytes: number; sha256: string; fetchedAt: string; sourceVersion: string; format: string } }>
    }).clues[0]!.snapshot
    expect(snapshot).toMatchObject({ path: 'content/clue-1.json', encoding: 'json', format: 'text/plain', fetchedAt: FETCHED_AT, sourceVersion: 'rev-1' })
    const content = readZip(result.bytes).find(entry => entry.name === snapshot.path)!
    expect(content.data.byteLength).toBe(snapshot.bytes)
    expect(createHash('sha256').update(content.data).digest('hex')).toBe(snapshot.sha256)
    expect(JSON.parse(new TextDecoder().decode(content.data))).toEqual({ format: 'text/plain', data: { text: 'hello world' }, text: 'hello world' })
  })
  it('omits an empty source revision instead of failing the export', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    f.source.read = async () => ({ format: 'text/plain', data: { text: 'x' }, text: 'x', revision: '', fetchedAt: FETCHED_AT })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(true)
    expect((manifestOf(result.bytes) as unknown as { clues: Array<{ snapshot: { sourceVersion?: string } }> }).clues[0]!.snapshot)
      .not.toHaveProperty('sourceVersion')
  })
  it('packages a structured body and every asset and re-imports them', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'multi')
    const first = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const second = new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6])
    const firstPath = join(f.base, 'one.png')
    const secondPath = join(f.base, 'two.png')
    writeFileSync(firstPath, first)
    writeFileSync(secondPath, second)
    f.source.read = async () => ({
      format: 'text/plain', data: { text: 'DOCUMENT BODY' }, text: 'DOCUMENT BODY', fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: firstPath, mime: 'image/png', size: first.length }, { kind: 'open', path: secondPath, mime: 'image/png', size: second.length }],
    })
    const exported = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(exported).toMatchObject({ complete: true, issues: [] })
    const entries = readZip(exported.bytes)
    expect(entries.map(entry => entry.name).sort()).toEqual(['content/clue-1.asset-1.bin', 'content/clue-1.asset-2.bin', 'content/clue-1.json', 'manifest.json'])
    const snapshot = (manifestOf(exported.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; assets?: Array<{ path: string; kind: string; mediaType: string; bytes: number; sha256: string }> } }>
    }).clues[0]!.snapshot
    expect(snapshot).toMatchObject({ path: 'content/clue-1.json', encoding: 'json' })
    expect(snapshot.assets!.map(asset => asset.kind)).toEqual(['download', 'open'])
    expect(JSON.parse(new TextDecoder().decode(entries.find(entry => entry.name === 'content/clue-1.json')!.data)))
      .toEqual({ format: 'text/plain', data: { text: 'DOCUMENT BODY' }, text: 'DOCUMENT BODY' })
    expect(entries.find(entry => entry.name === 'content/clue-1.asset-1.bin')!.data).toEqual(first)
    expect(entries.find(entry => entry.name === 'content/clue-1.asset-2.bin')!.data).toEqual(second)
    // A receiver stores every payload, and an offline re-share reproduces them.
    let next = 0
    const offline = createCluesService({ root: join(f.base, 'offline-store'), now: () => NOW, newId: kind => kind + '-' + (++next) })
    const imported = await importPack({ clues: offline }, { workspaceId: 'offline-ws', bytes: exported.bytes })
    expect(imported).toMatchObject({ complete: true })
    expect(imported.snapshots).toHaveLength(1)
    const stored = await offline.readSnapshot({ workspaceId: 'offline-ws', snapshotId: imported.snapshots[0]!.snapshotId })
    expect(stored.content).toMatchObject({ format: 'text/plain', text: 'DOCUMENT BODY' })
    expect(stored.content.data).toMatchObject({ kind: 'cluepack-snapshot-bundle', version: 1, primary: { encoding: 'json', data: { text: 'DOCUMENT BODY' } } })
    expect((stored.content.data as { assets: unknown[] }).assets).toHaveLength(2)
    const reExported = await exportPack({ clues: offline, now: () => NOW }, { workspaceId: 'offline-ws', mode: 'snapshot', clueIds: [imported.clues[0]!.clueId] })
    expect(reExported).toMatchObject({ complete: true, issues: [] })
    const reEntries = readZip(reExported.bytes)
    // Import explicitly captures the legacy unknown state; v2 preserves it on re-export.
    expect(reEntries.map(entry => entry.name).sort()).toEqual([...entries.map(entry => entry.name), 'content/clue-1.discussion.json'].sort())
    expect(JSON.parse(new TextDecoder().decode(reEntries.find(entry => entry.name === 'content/clue-1.discussion.json')!.data)))
      .toMatchObject({ status: 'not-captured', items: [], complete: false, coverage: 'document' })
    expect((manifestOf(reExported.bytes) as unknown as { clues: Array<{ snapshot: { assets?: unknown[] } }> }).clues[0]!.snapshot.assets).toHaveLength(2)
    expect(reEntries.find(entry => entry.name === 'content/clue-1.asset-2.bin')!.data).toEqual(second)
  })
  it('preserves raw local-file bytes and media type', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'binary')
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 0, 42])
    const assetPath = join(f.base, 'asset.bin')
    writeFileSync(assetPath, bytes)
    f.source.read = async () => ({
      format: 'application/octet-stream', data: { kind: 'binary', path: assetPath, size: bytes.length }, fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: assetPath, mime: 'application/x-test', size: bytes.length }],
    })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(true)
    const snapshot = (manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; mediaType: string; bytes: number; sha256: string } }>
    }).clues[0]!.snapshot
    expect(snapshot).toMatchObject({ encoding: 'raw', mediaType: 'application/x-test', bytes: bytes.length })
    const content = readZip(result.bytes).find(entry => entry.name === snapshot.path)!
    expect(content.data).toEqual(bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.sha256)
  })
  it('reports a binary read without an asset instead of exporting metadata-only JSON', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'binary')
    const senderPath = join(f.base, 'private-sender.bin')
    f.source.read = async () => ({ format: 'application/octet-stream', data: { kind: 'binary', path: senderPath, size: 7 }, fetchedAt: FETCHED_AT })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      key: 'clue-1', category: 'unsupported', reason: expect.stringMatching(/binary reference without an exportable asset/i),
    }))
    expect(result.stats).toMatchObject({ snapshots: 0 })
    expect(readZip(result.bytes).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
    expect(new TextDecoder().decode(result.bytes)).not.toContain('private-sender.bin')
    expect((manifestOf(result.bytes) as unknown as { clues: Array<{ snapshot?: unknown }> }).clues[0]!.snapshot).toBeUndefined()
  })
  it('refuses a read payload the importer would reject instead of shipping it', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    f.source.read = async () => ({ format: 'text/plain', data: undefined as never, fetchedAt: FETCHED_AT })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ key: 'clue-1', category: 'unsupported', reason: expect.stringMatching(/JSON/i) }))
    expect(result.stats).toMatchObject({ snapshots: 0 })
    // The produced archive must remain importable (exporter/importer parity).
    const preview = await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: result.bytes })
    expect([preview.items.length, preview.snapshotCount]).toEqual([1, 0])
  })
  it('rejects non-round-trippable data and a non-string text projection', async () => {
    const f = fixture()
    const nanClue = await ensureClue(f, 'nan')
    const textClue = await ensureClue(f, 'text')
    f.source.read = async () => (f.source.calls.read === 1
      ? { format: 'text/plain', data: { value: Number.NaN } as never, fetchedAt: FETCHED_AT }
      : { format: 'text/plain', data: { text: 'x' }, text: 42 as never, fetchedAt: FETCHED_AT })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [nanClue, textClue] })
    expect(result.issues).toHaveLength(2)
    expect(result.issues.every(issue => issue.category === 'unsupported')).toBe(true)
    expect(result.stats).toMatchObject({ snapshots: 0 })
    expect((await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: result.bytes })).snapshotCount).toBe(0)
  })
  it('reports read failures and limited reads as sanitized issues', async () => {
    const f = fixture()
    const authFail = await ensureClue(f, 'auth')
    const unsupported = await ensureClue(f, 'unsupported')
    const pathClue = await ensureClue(f, 'path')
    const limited = await ensureClue(f, 'limited')
    const ok = await ensureClue(f, 'ok')
    f.source.read = async () => {
      const current = f.source.calls.read
      if (current === 1) throw new ClueError('auth-required', 'the source requires authorization')
      if (current === 2) throw new ClueError('unsupported', 'the source cannot read this type')
      if (current === 3) throw new ClueError('not-found', '"/var/folders/sender/private/missing.md" does not exist')
      if (current === 4) return { format: 'text/plain', data: { text: 'page' }, text: 'page', fetchedAt: FETCHED_AT, limited: true }
      return { format: 'text/plain', data: { text: 'ok' }, text: 'ok', fetchedAt: FETCHED_AT }
    }
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [authFail, unsupported, pathClue, limited, ok] })
    expect(result).toMatchObject({ complete: false, stats: { clues: 5, snapshots: 1 } })
    expect(result.issues.map(issue => issue.category)).toEqual(['auth-required', 'unsupported', 'not-found', 'unsupported'])
    expect(result.issues[2]!.reason).not.toContain('/var/folders')
    expect(result.issues[2]!.reason).toMatch(/not found/i)
    expect(result.issues[3]!.reason).toMatch(/not fully captured|limited/i)
    const manifest = manifestOf(result.bytes) as unknown as { clues: Array<{ snapshot?: unknown }>; issues: unknown[] }
    expect(JSON.stringify(manifest)).not.toContain('/var/folders')
    expect([manifest.clues.filter(clue => clue.snapshot !== undefined).length, manifest.issues.length]).toEqual([1, 4])
  })
  it('reports a snapshot that exceeds the per-content limit and omits it', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const result = await exportPack(deps(f, { maxSnapshotBytes: 8 }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(false)
    expect(result.issues[0]!.reason).toMatch(/limit/i)
    expect(result.stats).toMatchObject({ snapshots: 0 })
  })
  it('enforces entry and size budgets before reading too much', async () => {
    const f = fixture()
    const ids = [await ensureClue(f, 'a'), await ensureClue(f, 'b'), await ensureClue(f, 'c')]
    await expect(exportPack(deps(f, { maxTotalBytes: 1 }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: ids })).rejects.toThrowError(/expanded size limit/i)
    // The bounds must be enforced while capturing, not after reading every payload.
    expect(f.source.calls.read).toBe(1)
    f.source.calls.read = 0
    await expect(exportPack(deps(f, { maxEntries: 1 }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [ids[0]!] })).rejects.toThrowError(/entry limit/i)
    expect(f.source.calls.read).toBe(0)
    const assets = fixture()
    const clueId = await ensureClue(assets, 'a')
    let assetReads = 0
    assets.source.read = async () => ({
      format: 'text/plain', data: { text: 'body' }, text: 'body', fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: '/virtual/one.bin', mime: 'application/octet-stream', size: 4 }, { kind: 'open', path: '/virtual/two.bin', mime: 'application/octet-stream', size: 4 }],
    })
    // manifest + ONE content entry fits; the body plus two assets needs three.
    await expect(exportPack(deps(assets, { maxEntries: 2, statFile: async () => ({ size: 4, isFile: true }), readFileBytes: async () => { assetReads += 1; return new Uint8Array(4) } }), {
      workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId],
    })).rejects.toThrowError(/entry limit/i)
    expect(assetReads).toBe(0)
    assets.source.read = async () => ({
      format: 'text/plain', data: { text: 'body' }, text: 'body', fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: '/virtual/one.bin', mime: 'application/octet-stream', size: 900 }, { kind: 'open', path: '/virtual/two.bin', mime: 'application/octet-stream', size: 900 }],
    })
    // The first asset fits; the second is refused BEFORE its bytes are read.
    await expect(exportPack(deps(assets, { maxTotalBytes: 1_500, statFile: async () => ({ size: 900, isFile: true }), readFileBytes: async () => { assetReads += 1; return new Uint8Array(900) } }), {
      workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId],
    })).rejects.toThrowError(/expanded size limit/i)
    expect(assetReads).toBe(1)
  })
  it.skipIf(process.platform === 'win32')('does not trust a regular-file stat when the asset was swapped for a FIFO', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'fifo')
    const fifo = join(f.base, 'asset.fifo')
    execFileSync('mkfifo', [fifo])
    f.source.read = async () => ({
      format: 'application/octet-stream', data: { kind: 'binary', path: fifo, size: 0 }, fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: fifo, mime: 'application/octet-stream', size: 0 }],
    })
    // Simulate the race: stat promised a regular file, but fstat refuses the real FIFO.
    const result = await exportPack(deps(f, { statFile: async () => ({ size: 0, isFile: true }) }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId] })
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ category: 'unsupported', reason: SAFE_FAILURE_REASONS.unsupported }))
  })
  it('never opens a non-regular local asset', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'binary')
    let assetReads = 0
    f.source.read = async () => ({
      format: 'application/octet-stream', data: { kind: 'binary', path: '/dev/null', size: 0 }, fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: '/dev/null', mime: 'application/x-test', size: 0 }],
    })
    const result = await exportPack(deps(f, { statFile: async () => ({ size: 0, isFile: false }), readFileBytes: async () => { assetReads += 1; return new Uint8Array() } }), {
      workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId],
    })
    expect(result.complete).toBe(false)
    expect(result.issues[0]).toMatchObject({ category: 'unsupported', reason: /regular file/i })
    expect(assetReads).toBe(0)
  })
  it('indexes stored snapshots once for every offline clue', async () => {
    const f = fixture()
    const first = await f.service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: 'Offline one', reason: 'source is not installed' })
    const second = await f.service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: 'Offline two', reason: 'source is not installed' })
    for (const clue of [first, second]) {
      await f.service.putSnapshot('ws-1', { clueId: clue.clue.id, format: 'text/plain', fetchedAt: FETCHED_AT, data: { text: clue.clue.id } })
    }
    let listCalls = 0
    const counting = { ...f.service, listSnapshots: async (workspaceId: string) => { listCalls += 1; return f.service.listSnapshots(workspaceId) } } as CluesService
    const result = await exportPack({ clues: counting, now: () => NOW }, { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [first.clue.id, second.clue.id] })
    expect(result.complete).toBe(true)
    expect([result.stats.snapshots, listCalls]).toEqual([2, 1])
  })
  it('falls back to the newest stored snapshot when a live read now fails', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', 'Live with old snapshot')
    await f.service.putSnapshot('ws-1', { clueId, format: 'text/plain', fetchedAt: FETCHED_AT, data: { text: 'stored before the source disappeared' }, text: 'stored before the source disappeared' })
    f.source.read = async () => { throw new ClueError('source-missing', 'the source is no longer installed') }
    const progress: ClueShareExportProgress[] = []
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId], onProgress: event => progress.push(event) })
    // An old snapshot is a partial export, never a silent complete one.
    expect(result.complete).toBe(false)
    expect(result.issues[0]).toMatchObject({ target: 'clue', category: 'source-missing' })
    expect(result.issues[0]!.reason).toContain(FETCHED_AT)
    expect(result.issues[0]!.reason).toMatch(/earlier snapshot/i)
    expect(result.stats.snapshots).toBe(1)
    expect(progress.find(event => event.key === 'clue-1')?.status).toBe('issue')
    const manifest = manifestOf(result.bytes) as unknown as { clues: Array<{ snapshot: { fetchedAt: string; encoding: string } }>; issues: Array<{ category: string }> }
    expect(manifest.clues[0]!.snapshot).toMatchObject({ fetchedAt: FETCHED_AT, encoding: 'json' })
    expect(manifest.issues).toEqual([expect.objectContaining({ category: 'source-missing' })])
    // The import confirmation sees the old acquisition time before committing.
    const preview = await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: result.bytes })
    expect(preview.items[0]!.snapshotFetchedAt).toBe(FETCHED_AT)
    expect(preview.warnings.join('\n')).toContain(FETCHED_AT)
    expect(preview.warnings.join('\n')).toMatch(/earlier snapshot/i)
  })
  it('lets the ZIP writer enforce the exact archive size limit', async () => {
    const f = fixture()
    const small = await ensureClue(f, 'a')
    await expect(exportPack(deps(f, { maxArchiveBytes: 32 }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [small] })).rejects.toThrowError(/zip archive exceeds the size limit/i)
    const text = 'a'.repeat(200_000)
    const compressible = await ensureClue(f, 'big')
    f.source.read = async () => ({ format: 'text/plain', data: { text }, text, fetchedAt: FETCHED_AT })
    // 200 KiB expands past this 4 KiB archive bound, but deflate shrinks the JSON well under it.
    const result = await exportPack(deps(f, { maxArchiveBytes: 4_096 }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [compressible] })
    expect(result.complete).toBe(true)
    expect(result.bytes.byteLength).toBeLessThanOrEqual(4_096)
    expect(readZip(result.bytes, { maxArchiveBytes: 4_096, maxEntryBytes: DEFAULT_MAX_SNAPSHOT_BYTES }).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH, 'content/clue-1.json'])
    const bytes = new Uint8Array(8_192)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 131 + 17) % 256
    const binary = await ensureClue(f, 'binary')
    let assetReads = 0
    f.source.read = async () => ({
      format: 'application/octet-stream', data: { kind: 'binary', path: '/virtual/asset.bin', size: bytes.length }, fetchedAt: FETCHED_AT,
      assets: [{ kind: 'download', path: '/virtual/asset.bin', mime: 'application/octet-stream', size: bytes.length }],
    })
    // The WRITER's exact archive check decides, not an expanded-bytes precheck.
    await expect(exportPack(deps(f, { maxArchiveBytes: 4_096, statFile: async () => ({ size: bytes.length, isFile: true }), readFileBytes: async () => { assetReads += 1; return bytes } }), {
      workspaceId: 'ws-1', mode: 'snapshot', clueIds: [binary],
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
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', packIds: [packA.pack.id, packB.pack.id] })
    const manifest = manifestOf(result.bytes) as unknown as { clues: Array<{ key: string; title: string }>; packs: Array<{ key: string; name: string; members: string[] }> }
    expect(manifest.clues.map(clue => clue.title)).toEqual(['A', 'B', 'C'])
    expect(manifest.packs.map(pack => pack.name)).toEqual(['Pack A', 'Pack B'])
    const keysByTitle = new Map(manifest.clues.map(clue => [clue.title, clue.key]))
    expect(manifest.packs[0]!.members).toEqual([keysByTitle.get('A'), keysByTitle.get('B')])
    expect(manifest.packs[1]!.members).toEqual([keysByTitle.get('B'), keysByTitle.get('C')])
    expect(result.stats).toMatchObject({ clues: 3, packs: 2 })
  })
  it('produces a portable empty pack name and sanitizes unsafe or over-long names', async () => {
    const f = fixture()
    const empty = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references' })
    expect(empty).toMatchObject({ complete: true, fileName: 'clues-20261017.cluepack' })
    expect(readZip(empty.bytes).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
    expect(manifestOf(empty.bytes)).toMatchObject({ clues: [], packs: [], sources: [] })
    const clueId = await ensureClue(f, 'a')
    const unsafe = await f.service.createPack({ workspaceId: 'ws-1', name: 'a/b:c*?.md', members: [clueId] })
    const sanitized = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', packIds: [unsafe.pack.id] })
    expect(sanitized.fileName).toBe('a-b-c--.md-20261017.cluepack')
    expect((manifestOf(sanitized.bytes) as unknown as { packs: Array<{ name: string }> }).packs[0]!.name).toBe('a/b:c*?.md')
    const emoji = await f.service.createPack({ workspaceId: 'ws-1', name: 'a' + '😀'.repeat(60), members: [clueId] })
    const preview = await previewExport(deps(f), { workspaceId: 'ws-1', mode: 'references', packIds: [emoji.pack.id] })
    expect(preview.fileName).toMatch(/^a(?:😀)+-\d{8}\.cluepack$/)
    // No unpaired surrogate reached the proposed name.
    expect(preview.fileName).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect([...preview.fileName].length).toBeLessThanOrEqual(100 + '-20261017.cluepack'.length)
    expect((await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', packIds: [emoji.pack.id] })).fileName).toBe(preview.fileName)
  })
  it('reports progress per clue and a final done event', async () => {
    const f = fixture()
    const first = await ensureClue(f, 'a')
    const second = await ensureClue(f, 'b')
    const events: ClueShareExportProgress[] = []
    await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [first, second], onProgress: event => events.push(event) })
    expect(events[0]).toMatchObject({ phase: 'collect', completed: 0, total: 2 })
    expect(events.filter(event => event.phase === 'read')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ phase: 'done', completed: 2, total: 2 })
  })
  it('refuses a cancelled export without producing bytes', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a')
    const controller = new AbortController()
    controller.abort()
    await expect(exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [clueId], signal: controller.signal })).rejects.toMatchObject({ category: 'cancelled' })
    expect(f.source.calls.read).toBe(0)
  })
})

describe('inspectExport (share confirmation)', () => {
  it('shows the exact portable locator without reading content', async () => {
    const f = fixture()
    const clueId = await ensureClue(f, 'a', '私有文档')
    f.source.portable = async () => ({ portable: true, locator: { url: 'https://example.invalid/private/资源?id=42' } })
    const inspection = await inspectExport(deps(f), { workspaceId: 'ws-1', mode: 'references', clueIds: [clueId] })
    expect(inspection.items).toHaveLength(1)
    expect(inspection.items[0]).toMatchObject({
      clueId, title: '私有文档', sourceId: TEST_SOURCE, portable: { portable: true, locator: { url: 'https://example.invalid/private/资源?id=42' } },
    })
    expect(inspection.sources[0]).toMatchObject({ sourceId: TEST_SOURCE })
    expect(inspection.fileName).toBe('clues-20261017.cluepack')
    expect(f.source.calls).toEqual({ read: 0, portable: 1 })
  })
  it('shows stored references and keeps per-item portable failures readable', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({
      workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: '离线记录',
      reason: SAFE_SOURCE_NOT_INSTALLED, portable: { portable: true, locator: { docId: 'doc-42' } },
    })
    const inspection = await inspectExport(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [imported.clue.id] })
    expect(inspection.items[0]).toMatchObject({ unresolved: SAFE_SOURCE_NOT_INSTALLED, portable: { portable: true, locator: { docId: 'doc-42' } }, snapshotMode: true })
    expect(inspection.warnings.join('\n')).toMatch(/not installed/i)
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
    const failing = fixture()
    const clueId = await ensureClue(failing, 'a')
    failing.source.portable = async () => { throw new ClueError('auth-required', 'the source requires authorization') }
    const failedInspection = await inspectExport(deps(failing), { workspaceId: 'ws-1', mode: 'references', clueIds: [clueId] })
    expect(failedInspection.items[0]!.portable).toMatchObject({ portable: false, reason: SAFE_FAILURE_REASONS['auth-required'] })
    expect(failedInspection.warnings.join('\n')).toMatch(/authorization/i)
    expect(failing.source.calls.read).toBe(0)
  })
})

describe('stored snapshot selection', () => {
  it('picks the newest snapshot by timestamp instant, not by string order', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: 'Offline', reason: 'source is not installed' })
    // 23:00+08:00 is 15:00Z; 16:00Z is later as an instant but lexicographically smaller.
    await f.service.putSnapshot('ws-1', { clueId: imported.clue.id, format: 'text/plain', fetchedAt: '2026-10-16T23:00:00+08:00', data: { text: 'older content' }, text: 'older content' })
    await f.service.putSnapshot('ws-1', { clueId: imported.clue.id, format: 'text/plain', fetchedAt: '2026-10-16T16:00:00Z', data: { text: 'newer content' }, text: 'newer content' })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [imported.clue.id] })
    const manifest = manifestOf(result.bytes) as unknown as { clues: Array<{ snapshot: { fetchedAt: string; path: string } }> }
    expect(manifest.clues[0]!.snapshot.fetchedAt).toBe('2026-10-16T16:00:00Z')
    const content = readZip(result.bytes).find(entry => entry.name === manifest.clues[0]!.snapshot.path)!
    expect(JSON.parse(new TextDecoder().decode(content.data))).toMatchObject({ text: 'newer content' })
  })
})

describe('export limits match the importer', () => {
  it('publishes the reader defaults and enforces every export limit before assembly', async () => {
    expect([DEFAULT_MAX_SNAPSHOT_BYTES, DEFAULT_MAX_ARCHIVE_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_MAX_MANIFEST_BYTES])
      .toEqual([DEFAULT_ZIP_LIMITS.maxEntryBytes, DEFAULT_ZIP_LIMITS.maxArchiveBytes, DEFAULT_ZIP_LIMITS.maxEntries, DEFAULT_ZIP_LIMITS.maxTotalBytes, MAX_MANIFEST_BYTES])
    // S1 accepts a 10,000-member pack; the archive must be able to hold it.
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThanOrEqual(10_001)
    const f = fixture()
    const first = await ensureClue(f, 'a')
    const second = await ensureClue(f, 'b')
    const third = await ensureClue(f, 'c')
    await expect(exportPack(deps(f, { maxEntries: 1 }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [first] })).rejects.toThrowError(/entry limit/i)
    await expect(exportPack(deps(f, { maxManifestBytes: 16 }), { workspaceId: 'ws-1', mode: 'references', clueIds: [first] })).rejects.toThrowError(/manifest exceeds/i)
    await expect(exportPack(deps(f, { maxTotalBytes: 16, maxManifestBytes: 1_000_000 }), { workspaceId: 'ws-1', mode: 'references', clueIds: [first, second, third] })).rejects.toThrowError(/expanded size limit/i)
    // A references pack has exactly one ZIP entry; the old pre-check counted clues+1.
    expect((await exportPack(deps(f, { maxEntries: 2 }), { workspaceId: 'ws-1', mode: 'references', clueIds: [first, second] })).complete).toBe(true)
    await expect(exportPack(deps(f, { maxEntries: 2 }), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [first, second] })).rejects.toThrowError(/entry limit/i)
    expect(readZip((await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [first] })).bytes).map(entry => entry.name))
      .toEqual([CLUEPACK_MANIFEST_PATH, 'content/clue-1.json'])
  })
})

describe('snapshot mode with unresolved clues', () => {
  it('re-shares stored JSON and binary snapshots instead of reporting a missing source', async () => {
    const f = fixture()
    const jsonRow = await f.service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: '离线记录', reason: 'source is not installed' })
    await f.service.putSnapshot('ws-1', { clueId: jsonRow.clue.id, format: 'text/plain', fetchedAt: FETCHED_AT, data: { text: 'stored body' }, text: 'stored body' })
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 0, 13, 10])
    const binaryRow = await f.service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: '离线资产', reason: 'source is not installed' })
    await f.service.putSnapshot('ws-1', {
      clueId: binaryRow.clue.id, format: 'image/png', fetchedAt: FETCHED_AT,
      data: { kind: 'binary', mediaType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'base64', base64: Buffer.from(bytes).toString('base64') },
    })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [jsonRow.clue.id, binaryRow.clue.id] })
    expect(result).toMatchObject({ complete: true, stats: { snapshots: 2 } })
    const [jsonSnapshot, binarySnapshot] = (manifestOf(result.bytes) as unknown as {
      clues: Array<{ snapshot: { path: string; encoding: string; format: string; fetchedAt: string; sha256: string; bytes: number; mediaType: string } }>
    }).clues.map(clue => clue.snapshot)
    expect(jsonSnapshot).toMatchObject({ path: 'content/clue-1.json', encoding: 'json', format: 'text/plain', fetchedAt: FETCHED_AT })
    const jsonContent = readZip(result.bytes).find(entry => entry.name === jsonSnapshot!.path)!
    expect([jsonContent.data.byteLength, createHash('sha256').update(jsonContent.data).digest('hex')]).toEqual([jsonSnapshot!.bytes, jsonSnapshot!.sha256])
    expect(JSON.parse(new TextDecoder().decode(jsonContent.data))).toEqual({ format: 'text/plain', data: { text: 'stored body' }, text: 'stored body' })
    expect(binarySnapshot).toMatchObject({ encoding: 'raw', mediaType: 'image/png', format: 'image/png' })
    expect(readZip(result.bytes).find(entry => entry.name === binarySnapshot!.path)!.data).toEqual(bytes)
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
  })
  it('still reports a source-missing issue when the unresolved clue has no snapshot', async () => {
    const f = fixture()
    const imported = await f.service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: {}, title: '无快照', reason: 'source is not installed' })
    const result = await exportPack(deps(f), { workspaceId: 'ws-1', mode: 'snapshot', clueIds: [imported.clue.id] })
    expect(result.complete).toBe(false)
    expect(result.issues[0]).toMatchObject({ target: 'clue', category: 'source-missing' })
    expect(result.stats.snapshots).toBe(0)
  })
})