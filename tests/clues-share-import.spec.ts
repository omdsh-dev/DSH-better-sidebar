/**
 * S7 import contract: `previewImport` has no side effects; `importPack`
 * commits through S1 (`ensure` / `importUnresolved` / `putSnapshot`) and
 * creates packs LAST.
 *
 * Pinned semantics:
 * - preview never reads a source, installs a plugin/CLI, starts auth or writes;
 * - a missing source keeps a first-class unresolved clue (read answers
 *   `source-missing`) and its snapshot stays readable offline;
 * - a registered source reuses the canonical local clue through `ensure`
 *   (never a second id for the same resource), and importing a snapshot next
 *   to an existing live reference does not change the live locator/read mode;
 * - a duplicate pack name creates a separate pack, never an overwrite;
 * - malicious/traversing paths, checksum mismatches, unknown versions and
 *   oversized archives are refused before the first write;
 * - pack creation failure is reported as a partial result with a readable
 *   reason, never as success;
 * - bindings/pins are untouched, and no source read/portable operation runs
 *   during import.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import {
  ClueError,
  type CluePortableRef,
  type JsonValue,
} from '../src/clues/types.ts'
import {
  importPack,
  previewImport,
  type ClueShareImportProgress,
  type ClueShareImportResult,
} from '../src/clues/share/import.ts'
import {
  CLUEPACK_FORMAT,
  serializeCluepackManifest,
  type CluepackClue,
  type CluepackIssue,
  type CluepackManifest,
  type CluepackMode,
  type CluepackPack,
  type CluepackSnapshot,
  type CluepackSource,
} from '../src/clues/share/manifest.ts'
import { createZip } from '../src/clues/share/zip.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const TEST_SOURCE = 'test.source'
const TEST_TYPE = 'test.source.text'
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/cluepack-v1/', import.meta.url))

const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

interface Fixture {
  base: string
  workspace: string
  service: CluesService
  source: { calls: { read: number; portable: number } }
}

/**
 * The one test source used by every fixture. Extracted so tests can also
 * register it publicly and later remove it (the "source was uninstalled but
 * its clue is still resolved" case).
 */
function testSourceRegistration(
  source: Fixture['source'],
): ClueSourceRegistration {
  return {
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
    operations: {
      async read() {
        source.calls.read += 1
        return { format: 'text/plain', data: { text: 'live content' }, text: 'live content', fetchedAt: NOW }
      },
      async portable() {
        source.calls.portable += 1
        return { portable: true, locator: { id: 'a' } }
      },
      normalizeLocator(locator) {
        return { id: String(locator.id ?? '') }
      },
      locatorKey(locator) {
        return `id:${String(locator.id)}`
      },
    },
  }
}

/** A service with one registered source and deterministic ids. */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-import-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
  const source = { calls: { read: 0, portable: 0 } }
  const service = createCluesService({
    root: join(base, 'store'),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
    resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
    builtinSources: [testSourceRegistration(source)],
  })
  return { base, workspace, service, source }
}

/** Ensure one clue of the test source and return its id. */
async function ensureClue(service: CluesService, id = 'a', title = 'Live clue'): Promise<string> {
  const result = await service.ensure({
    workspaceId: 'ws-1',
    sourceId: TEST_SOURCE,
    typeId: TEST_TYPE,
    locator: { id },
    title,
  })
  return result.clue.id
}

/** One snapshot spec for the package builder. */
interface SnapshotSpec {
  content: Uint8Array
  encoding?: 'json' | 'raw'
  format?: string
  mediaType?: string
  fetchedAt?: string
  sourceVersion?: string
  /** Override the recorded digest (checksum-mismatch cases). */
  sha256?: string
  /** Override the recorded byte count. */
  bytes?: number
  path?: string
}

/** One clue spec for the package builder. */
interface ClueSpec {
  key: string
  sourceId?: string
  typeId?: string
  title?: string
  portable?: CluePortableRef
  snapshot?: SnapshotSpec
}

/** Options of the package builder. */
interface BuildOptions {
  mode?: CluepackMode
  packs?: Array<{ key?: string; name: string; members: string[] }>
  issues?: CluepackIssue[]
  exportedAt?: string
  /** Serialize this instead of the assembled manifest (invalid-version cases). */
  rawManifest?: unknown
}

/** Digest helper used by the package builder. */
function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Assemble one archive from the given clues. */
function buildPack(clues: ClueSpec[], options: BuildOptions = {}): { bytes: Buffer; manifest: CluepackManifest } {
  const sourceIds = [...new Set(clues.map(clue => clue.sourceId ?? TEST_SOURCE))]
  const sources: CluepackSource[] = sourceIds.map((sourceId, index) => ({
    key: `source-${index + 1}`,
    sourceId,
  }))
  const sourceKeyOf = (sourceId: string): string => sources.find(source => source.sourceId === sourceId)!.key
  const entries: Array<{ name: string; data: Uint8Array }> = []
  const clueRecords: CluepackClue[] = clues.map((clue) => {
    let snapshot: CluepackSnapshot | undefined
    if (clue.snapshot !== undefined) {
      const encoding = clue.snapshot.encoding ?? 'json'
      const path = clue.snapshot.path
        ?? `content/${clue.key}.${encoding === 'json' ? 'json' : 'bin'}`
      snapshot = {
        path,
        encoding,
        mediaType: clue.snapshot.mediaType ?? (encoding === 'json' ? 'application/json' : 'application/octet-stream'),
        format: clue.snapshot.format ?? 'text/plain',
        bytes: clue.snapshot.bytes ?? clue.snapshot.content.byteLength,
        sha256: clue.snapshot.sha256 ?? sha256Of(clue.snapshot.content),
        fetchedAt: clue.snapshot.fetchedAt ?? '2026-10-16T12:00:00.000Z',
        ...(clue.snapshot.sourceVersion === undefined ? {} : { sourceVersion: clue.snapshot.sourceVersion }),
      }
      entries.push({ name: path, data: clue.snapshot.content })
    }
    return {
      key: clue.key,
      sourceKey: sourceKeyOf(clue.sourceId ?? TEST_SOURCE),
      typeId: clue.typeId ?? TEST_TYPE,
      title: clue.title ?? `Title ${clue.key}`,
      portable: clue.portable ?? { portable: true, locator: { id: clue.key } },
      ...(snapshot === undefined ? {} : { snapshot }),
    }
  })
  const packs: CluepackPack[] = (options.packs ?? []).map((pack, index) => ({
    key: pack.key ?? `pack-${index + 1}`,
    name: pack.name,
    members: pack.members,
  }))
  const manifest: CluepackManifest = {
    formatVersion: 1,
    format: CLUEPACK_FORMAT,
    exportedAt: options.exportedAt ?? NOW,
    mode: options.mode ?? 'references',
    sources,
    clues: clueRecords,
    packs,
    issues: options.issues ?? [],
  }
  const manifestBytes = options.rawManifest === undefined
    ? serializeCluepackManifest(manifest)
    : Buffer.from(JSON.stringify(options.rawManifest), 'utf8')
  return {
    bytes: createZip([
      { name: 'manifest.json', data: manifestBytes },
      ...entries,
    ], { modifiedAt: new Date(NOW) }),
    manifest,
  }
}

/** Build the static v1 fixture archive (manifest + content). */
function fixturePack(): Buffer {
  return createZip([
    { name: 'manifest.json', data: readFileSync(join(FIXTURE_DIR, 'manifest.json')) },
    { name: 'content/clue-1.json', data: readFileSync(join(FIXTURE_DIR, 'content', 'clue-1.json')) },
  ], { modifiedAt: new Date(NOW) })
}

/** JSON content bytes of one structured snapshot. */
function jsonContent(data: JsonValue, text?: string): Uint8Array {
  return Buffer.from(JSON.stringify({
    format: 'text/plain',
    data,
    ...(text === undefined ? {} : { text }),
  }), 'utf8')
}

/** Rename one ZIP entry in place (both headers) for malicious-path cases. */
function renameZipEntry(zip: Buffer, from: string, to: string): Buffer {
  const source = Buffer.from(from, 'utf8')
  const target = Buffer.from(to, 'utf8')
  if (source.length !== target.length) throw new Error('renameZipEntry needs equal lengths')
  const copy = Buffer.from(zip)
  let offset = copy.indexOf(source)
  if (offset === -1) throw new Error(`entry "${from}" not found`)
  while (offset !== -1) {
    target.copy(copy, offset)
    offset = copy.indexOf(source, offset + target.length)
  }
  return copy
}

/** All clue ids currently in the workspace library. */
async function libraryIds(service: CluesService): Promise<string[]> {
  return (await service.listClues('ws-1')).clues.map(clue => clue.id)
}

describe('previewImport', () => {
  it('summarizes an archive without reading a source or writing the library', async () => {
    const f = fixture()
    const pack = buildPack([
      { key: 'clue-1', title: '设计与实现', snapshot: { content: jsonContent({ text: 'archived' }, 'archived') } },
    ], { mode: 'snapshot', packs: [{ name: '发布材料', members: ['clue-1'] }] })
    const preview = await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(preview).toMatchObject({
      mode: 'snapshot',
      packNames: ['发布材料'],
      snapshotCount: 1,
      unresolvedCount: 0,
      missingSources: [],
    })
    expect(preview.packs[0]).toMatchObject({ name: '发布材料', members: 1, snapshotMembers: 1 })
    expect(preview.items[0]).toMatchObject({ title: '设计与实现', portable: true, snapshot: true, willBeUnresolved: false })
    expect(preview.sources[0]).toMatchObject({ sourceId: TEST_SOURCE, installed: true, missingTypeIds: [] })
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
    expect(await libraryIds(f.service)).toEqual([])
    expect((await f.service.listPacks('ws-1')).packs).toEqual([])
  })

  it('labels missing sources and missing types without failing the preview', async () => {
    const f = fixture()
    const pack = buildPack([
      { key: 'clue-1', sourceId: 'missing.source', title: 'Missing source' },
    ])
    const preview = await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(preview.missingSources).toEqual(['missing.source'])
    expect(preview.unresolvedCount).toBe(1)
    expect(preview.items[0]!.willBeUnresolved).toBe(true)
    expect(preview.warnings.join('\n')).toMatch(/not installed/i)
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
  })
})

describe('importPack references mode', () => {
  it('imports clues and the pack, and re-importing reuses canonical clashes', async () => {
    const f = fixture()
    const pack = buildPack([
      { key: 'clue-1', title: 'First' },
      { key: 'clue-2', title: 'Second' },
    ], { packs: [{ name: 'Imported pack', members: ['clue-1', 'clue-2'] }] })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: true, partial: false, mode: 'references' })
    expect(result.clues.map(clue => clue.created)).toEqual([true, true])
    expect(result.packs).toHaveLength(1)
    expect(result.packs[0]!.members).toBe(2)
    expect(result.issues).toEqual([])
    const library = await f.service.listClues('ws-1')
    expect(library.clues.map(clue => clue.title)).toEqual(['First', 'Second'])
    const packs = await f.service.listPacks('ws-1')
    expect(packs.packs).toHaveLength(1)
    expect(packs.packs[0]).toMatchObject({ name: 'Imported pack', members: library.clues.map(clue => clue.id) })
    expect((await f.service.listPins('ws-1')).pins).toEqual([])
    expect((await f.service.listBindings('ws-1')).bindings).toEqual([])
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })

    const again = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(again.clues.map(clue => clue.created)).toEqual([false, false])
    expect(again.clues.map(clue => clue.clueId)).toEqual(result.clues.map(clue => clue.clueId))
    expect(await libraryIds(f.service)).toHaveLength(2)
    const packsAfter = await f.service.listPacks('ws-1')
    expect(packsAfter.packs).toHaveLength(2)
    expect(packsAfter.packs.every(pack => pack.name === 'Imported pack')).toBe(true)
  })

  it('imports the static v1 fixture without changes', async () => {
    const f = fixture()
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: fixturePack() })
    expect(result.complete).toBe(true)
    expect(result.clues).toHaveLength(1)
    expect(result.snapshots).toHaveLength(1)
    const record = await f.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: result.snapshots[0]!.snapshotId })
    expect(record.content.text).toBe('fixture content')
    expect(record.meta).toMatchObject({
      format: 'text/plain',
      fetchedAt: '2026-10-16T12:00:00.000Z',
      sourceVersion: 'rev-fixture',
      integrity: 'verified',
    })
    expect((await f.service.listPacks('ws-1')).packs[0]!.name).toBe('Fixture pack')
  })
})

describe('importPack with missing sources and snapshots', () => {
  it('keeps a missing-source clue unresolved and remaps it after the source appears', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1', sourceId: 'missing.source', title: 'Orphan' }])
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result.clues[0]).toMatchObject({ created: true, unresolved: true })
    const clue = (await f.service.listClues('ws-1')).clues[0]!
    expect(clue.unresolved?.reason).toMatch(/not installed/i)
    await expect(f.service.read({ workspaceId: 'ws-1', clueId: clue.id }))
      .rejects.toMatchObject({ category: 'source-missing' })
    // The row is a normal clue: it can join a pack.
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(0)
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })

    // A later registration remaps the SAME row instead of minting a new one.
    f.service.registerSource({
      descriptor: {
        sourceId: 'missing.source',
        name: 'Late source',
        order: 30,
        pluginId: 'plugin.late',
        types: ['missing.source.doc'],
        transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: false, edit: false, portable: false },
      },
      types: [{
        typeId: 'missing.source.doc',
        sourceId: 'missing.source',
        formats: ['text/plain'],
        capabilities: { read: false, edit: false, concurrency: 'none' },
      }],
    })
    const remapped = await f.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'missing.source',
      typeId: 'missing.source.doc',
      locator: { id: 'clue-1' },
      title: 'Orphan',
    })
    expect(remapped.clue.id).toBe(clue.id)
    expect(remapped.clue.unresolved).toBeUndefined()
  })

  it('stores an offline JSON snapshot that stays readable without the source', async () => {
    const f = fixture()
    const pack = buildPack([{
      key: 'clue-1',
      sourceId: 'missing.source',
      title: 'Archived',
      snapshot: { content: jsonContent({ text: 'archived body' }, 'archived body') },
    }], { mode: 'snapshot', packs: [{ name: 'Archive pack', members: ['clue-1'] }] })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result.complete).toBe(true)
    expect(result.snapshots).toHaveLength(1)
    const clue = (await f.service.listClues('ws-1')).clues[0]!
    await expect(f.service.read({ workspaceId: 'ws-1', clueId: clue.id }))
      .rejects.toMatchObject({ category: 'source-missing' })
    const record = await f.service.readSnapshot({
      workspaceId: 'ws-1',
      snapshotId: result.snapshots[0]!.snapshotId,
    })
    expect(record.meta.clueId).toBe(clue.id)
    expect(record.meta.fetchedAt).toBe('2026-10-16T12:00:00.000Z')
    expect(record.content).toMatchObject({ format: 'text/plain', data: { text: 'archived body' }, text: 'archived body' })
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(1)
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
  })

  it('preserves raw binary snapshot bytes exactly', async () => {
    const f = fixture()
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 0, 13, 10])
    const pack = buildPack([{
      key: 'clue-1',
      title: 'Binary asset',
      snapshot: { content: bytes, encoding: 'raw', mediaType: 'image/png' },
    }], { mode: 'snapshot' })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result.snapshots).toHaveLength(1)
    const record = await f.service.readSnapshot({
      workspaceId: 'ws-1',
      snapshotId: result.snapshots[0]!.snapshotId,
    })
    expect(record.content.format).toBe('text/plain')
    expect(record.content.data).toMatchObject({
      kind: 'binary',
      mediaType: 'image/png',
      size: bytes.length,
      sha256: sha256Of(bytes),
      encoding: 'base64',
    })
    const data = record.content.data as { base64: string }
    expect(new Uint8Array(Buffer.from(data.base64, 'base64'))).toEqual(bytes)
  })

  it('reuses an existing live reference and keeps live reads live', async () => {
    const f = fixture()
    const liveId = await ensureClue(f.service, 'a', 'Live title')
    const pack = buildPack([{
      key: 'clue-1',
      title: 'Imported old title',
      portable: { portable: true, locator: { id: 'a' } },
      snapshot: { content: jsonContent({ text: 'old archived body' }, 'old archived body') },
    }], { mode: 'snapshot' })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result.clues[0]).toMatchObject({ clueId: liveId, created: false, unresolved: false })
    expect(await libraryIds(f.service)).toEqual([liveId])
    const library = await f.service.listClues('ws-1')
    expect(library.clues[0]).toMatchObject({ title: 'Live title', locator: { id: 'a' } })
    expect(library.clues[0]!.unresolved).toBeUndefined()
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
    // Live reads still hit the source; the imported snapshot is separate.
    const live = await f.service.read({ workspaceId: 'ws-1', clueId: liveId })
    expect(live.text).toBe('live content')
    expect(f.source.calls.read).toBe(1)
    const record = await f.service.readSnapshot({
      workspaceId: 'ws-1',
      snapshotId: result.snapshots[0]!.snapshotId,
    })
    expect(record.meta.clueId).toBe(liveId)
    expect(record.content.text).toBe('old archived body')
  })
})

describe('importPack safety boundary', () => {
  it('rejects a traversing archive path before writing anything', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }])
    const malicious = renameZipEntry(pack.bytes, 'manifest.json', 'content/../aaa.json'.slice(0, 13))
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: malicious }))
      .rejects.toThrowError(/unsafe archive entry name/i)
    expect(await libraryIds(f.service)).toEqual([])
    expect((await f.service.listPacks('ws-1')).packs).toEqual([])
  })

  it('rejects a checksum mismatch before writing anything', async () => {
    const f = fixture()
    const pack = buildPack([{
      key: 'clue-1',
      snapshot: { content: jsonContent({ text: 'x' }), sha256: 'a'.repeat(64) },
    }], { mode: 'snapshot' })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes }))
      .rejects.toThrowError(/checksum/i)
    expect(await libraryIds(f.service)).toEqual([])
  })

  it('rejects a missing content entry, an unknown version and a truncated archive', async () => {
    const f = fixture()
    const missing = buildPack([{
      key: 'clue-1',
      snapshot: { content: jsonContent({ text: 'x' }), path: 'content/clue-1.json' },
    }], { mode: 'snapshot' })
    const withoutContent = createZip([{ name: 'manifest.json', data: serializeCluepackManifest(missing.manifest) }])
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: withoutContent }))
      .rejects.toThrowError(/missing/i)

    const unknown = buildPack([{ key: 'clue-1' }], {
      rawManifest: {
        formatVersion: 2,
        format: CLUEPACK_FORMAT,
        exportedAt: NOW,
        mode: 'references',
        sources: [],
        clues: [],
        packs: [],
        issues: [],
      },
    })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: unknown.bytes }))
      .rejects.toMatchObject({ category: 'unsupported' })

    const valid = buildPack([{ key: 'clue-1' }])
    await expect(importPack({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: valid.bytes.subarray(0, valid.bytes.length - 8),
    })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(await libraryIds(f.service)).toEqual([])
  })

  it('enforces injected ZIP limits before writing anything', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }])
    await expect(importPack({ clues: f.service, zipLimits: { maxEntryBytes: 16 } }, {
      workspaceId: 'ws-1',
      bytes: pack.bytes,
    })).rejects.toThrowError(/size limit/i)
    expect(await libraryIds(f.service)).toEqual([])
  })

  it('refuses a cancelled import before the first write', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }])
    const controller = new AbortController()
    controller.abort()
    await expect(importPack({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: pack.bytes,
      signal: controller.signal,
    })).rejects.toMatchObject({ category: 'cancelled' })
    expect(await libraryIds(f.service)).toEqual([])
  })
})

describe('importPack partial results', () => {
  it('reports the exporter issues of a partial pack and never claims completeness', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }], {
      packs: [{ name: 'Partial pack', members: ['clue-1'] }],
      issues: [{ target: 'clue', key: 'clue-1', category: 'unsupported', reason: 'content was not fetched' }],
    })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: false, partial: true })
    expect(result.manifestIssues).toHaveLength(1)
    expect(result.reasons).toEqual(['content was not fetched'])
    expect(await libraryIds(f.service)).toHaveLength(1)
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(1)
  })

  it('keeps imported clues when pack creation fails and reports the readable reason', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }], { packs: [{ name: 'Uncreatable', members: ['clue-1'] }] })
    const failing = {
      ...f.service,
      createPack: async () => {
        throw new ClueError('failed', 'the pack store is unavailable')
      },
    } as CluesService
    const result: ClueShareImportResult = await importPack({ clues: failing }, {
      workspaceId: 'ws-1',
      bytes: pack.bytes,
    })
    expect(result).toMatchObject({ complete: false, partial: true })
    expect(result.clues).toHaveLength(1)
    expect(result.packs).toEqual([])
    expect(result.reasons).toContain('the pack store is unavailable')
    expect(await libraryIds(f.service)).toHaveLength(1)
  })

  it('keeps the clue when a snapshot write fails and reports a partial import', async () => {
    const f = fixture()
    const pack = buildPack([{
      key: 'clue-1',
      snapshot: { content: jsonContent({ text: 'x' }) },
    }], { mode: 'snapshot' })
    const failing = {
      ...f.service,
      putSnapshot: async () => {
        throw new ClueError('failed', 'the snapshot store is unavailable')
      },
    } as CluesService
    const result = await importPack({ clues: failing }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: false, partial: true })
    expect(result.clues[0]).toMatchObject({ unresolved: false })
    expect(result.snapshots).toEqual([])
    expect(result.reasons).toContain('the snapshot store is unavailable')
  })
})

describe('importPack progress and edge shapes', () => {
  it('reports validate/clue/pack/done progress', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }], { packs: [{ name: 'P', members: ['clue-1'] }] })
    const events: ClueShareImportProgress[] = []
    await importPack({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: pack.bytes,
      onProgress: event => events.push(event),
    })
    expect(events[0]).toMatchObject({ phase: 'validate', completed: 0, total: 1 })
    expect(events.some(event => event.phase === 'clue')).toBe(true)
    expect(events.some(event => event.phase === 'pack')).toBe(true)
    expect(events.at(-1)).toMatchObject({ phase: 'done', status: 'ok' })
  })

  it('imports an empty pack and preserves long non-ASCII titles/names', async () => {
    const f = fixture()
    const empty = await importPack({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: buildPack([], {}).bytes,
    })
    expect(empty).toMatchObject({ complete: true, partial: false })
    expect(empty.clues).toEqual([])
    expect(empty.packs).toEqual([])

    const longTitle = '很长的中文标题'.repeat(20)
    const longPack = '中文包名'.repeat(40)
    const pack = buildPack([{ key: 'clue-1', title: longTitle }], {
      packs: [{ name: longPack, members: ['clue-1'] }],
    })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result.complete).toBe(true)
    expect((await f.service.listClues('ws-1')).clues[0]!.title).toBe(longTitle)
    expect((await f.service.listPacks('ws-1')).packs[0]!.name).toBe(longPack.slice(0, 200))
  })
})

describe('importPack cancellation', () => {
  it('never reports success when the abort lands on the last clue', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }])
    const controller = new AbortController()
    await expect(importPack({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: pack.bytes,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'clue') controller.abort()
      },
    })).rejects.toMatchObject({ category: 'cancelled' })
    // The write happened; the point is that the caller never sees a success
    // result after an abort (the BLOCKER the review found).
    expect(await libraryIds(f.service)).toHaveLength(1)
  })

  it('never reports success when the abort lands on the last pack', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }], { packs: [{ name: 'P', members: ['clue-1'] }] })
    const controller = new AbortController()
    await expect(importPack({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: pack.bytes,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'pack') controller.abort()
      },
    })).rejects.toMatchObject({ category: 'cancelled' })
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(1)
  })

  it('stops between items and returns the committed rows explicitly (no bare throw)', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }, { key: 'clue-2' }])
    const controller = new AbortController()
    const result = await importPack({ clues: f.service }, {
      workspaceId: 'ws-1',
      bytes: pack.bytes,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'clue' && event.completed === 1) controller.abort()
      },
    })
    // S1 has no rollback; the half-import is reported as an explicit partial
    // result the user must accept, never as success and never as a bare throw.
    expect(result).toMatchObject({
      complete: false,
      partial: true,
      cancelled: true,
      requiresAcceptance: true,
    })
    expect(result.clues.map(clue => clue.clueKey)).toEqual(['clue-1'])
    expect(result.reasons.join('\n')).toMatch(/cancelled after committing 1 of 2 clues/i)
    expect(await libraryIds(f.service)).toEqual([result.clues[0]!.clueId])
  })
})

describe('importPack with a locally resolved clue whose source is gone', () => {
  it('previews and imports it as resolved with the same id', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-import-'))
    roots.push(base)
    const workspace = join(base, 'workspace')
    mkdirSync(workspace, { recursive: true })
    let next = 0
    const source = { calls: { read: 0, portable: 0 } }
    const service = createCluesService({
      root: join(base, 'store'),
      now: () => NOW,
      newId: kind => `${kind}-${++next}`,
      resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
    })
    const unregister = service.registerSource(testSourceRegistration(source))
    const ensured = await service.ensure({
      workspaceId: 'ws-1',
      sourceId: TEST_SOURCE,
      typeId: TEST_TYPE,
      locator: { id: 'a' },
      title: 'Live title',
    })
    // The source is gone, but the row it minted is still a RESOLVED clue.
    unregister()
    const pack = buildPack([{
      key: 'clue-1',
      title: 'Imported old title',
      portable: { portable: true, locator: { id: 'a' } },
    }])
    const preview = await previewImport({ clues: service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(preview.items[0]!.willBeUnresolved).toBe(false)
    expect(preview.unresolvedCount).toBe(0)

    const result = await importPack({ clues: service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result.clues[0]).toMatchObject({
      clueId: ensured.clue.id,
      created: false,
      unresolved: false,
    })
    const library = await service.listClues('ws-1')
    expect(library.clues).toHaveLength(1)
    expect(library.clues[0]!.unresolved).toBeUndefined()
    expect(library.clues[0]!.title).toBe('Live title')
    expect(source.calls).toEqual({ read: 0, portable: 0 })
  })
})
