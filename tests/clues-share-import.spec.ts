/**
 * S7 import contract: `previewImport` has no side effects; `importPack`
 * commits through S1 (`ensure` / `importUnresolved` / `putSnapshot`) and
 * creates packs LAST.
 *
 * Pinned semantics: preview never reads a source or writes; a missing source
 * keeps a first-class unresolved clue (read answers `source-missing`) whose
 * snapshot stays readable offline; a registered source reuses the canonical
 * local clue through `ensure` and never disturbs a live locator/read mode; a
 * duplicate pack name creates a separate pack; traversing paths, checksum
 * mismatches, unknown versions and oversized archives are refused before the
 * first write; a v2 discussion entry is verified and validated before the
 * first write while v1/descriptor-less archives yield an explicit
 * `not-captured` page; pack creation failure is a partial result with a
 * readable reason; bindings/pins are untouched and import never reads a
 * source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { createLocalFileSource, LOCAL_FILE_TYPE_IDS } from '../src/clues/local-files.ts'
import {
  ClueError, type ClueDiscussionPage, type CluePortableRef, type ClueReadResult, type JsonValue, type Locator,
} from '../src/clues/types.ts'
import { importPack, previewImport, type ClueShareImportProgress, type ClueShareImportResult } from '../src/clues/share/import.ts'
import { SAFE_FAILURE_REASONS, SAFE_SOURCE_NOT_INSTALLED } from '../src/clues/share/reasons.ts'
import {
  CLUEPACK_FORMAT, serializeCluepackManifest, type CluepackClue, type CluepackIssue, type CluepackManifest,
  type CluepackMode, type CluepackPack, type CluepackSnapshot, type CluepackSource,
} from '../src/clues/share/manifest.ts'
import { createZip, readZip } from '../src/clues/share/zip.ts'
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
  source: { calls: { read: number; portable: number }; read?: () => Promise<ClueReadResult> }
}
/** The one test source used by every fixture (also registerable later). */
function testSourceRegistration(source: Fixture['source']): ClueSourceRegistration {
  return {
    descriptor: {
      sourceId: TEST_SOURCE, name: 'Share test source', order: 20, pluginId: 'plugin.test', types: [TEST_TYPE], transport: 'mcp', connectionId: 'conn-a',
      capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: true },
    },
    types: [{ typeId: TEST_TYPE, sourceId: TEST_SOURCE, formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations: {
      async read() {
        source.calls.read += 1
        return source.read?.() ?? { format: 'text/plain', data: { text: 'live content' }, text: 'live content', fetchedAt: NOW }
      },
      async portable() {
        source.calls.portable += 1
        return { portable: true, locator: { id: 'a' } }
      },
      normalizeLocator(locator) { return { id: String(locator.id ?? '') } },
      locatorKey(locator) { return 'id:' + String(locator.id) },
    },
  }
}
/** A source that is installed but offers neither the read nor the archived type. */
function externalSource(sourceId: string, typeId: string, operations?: ClueSourceRegistration['operations']): ClueSourceRegistration {
  return {
    descriptor: {
      sourceId, name: sourceId, order: 30, pluginId: 'plugin.late', types: [typeId], transport: 'mcp',
      capabilities: { resolve: false, list: false, search: false, read: false, edit: false, portable: false },
    },
    types: [{ typeId, sourceId, formats: ['text/plain'], capabilities: { read: false, edit: false, concurrency: 'none' } }],
    ...(operations === undefined ? {} : { operations }),
  }
}
/** A service with one registered source and deterministic ids. */
function fixture(options: { extraBuiltinSources?: ClueSourceRegistration[]; withSource?: boolean } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-import-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
  const source: Fixture['source'] = { calls: { read: 0, portable: 0 } }
  const service = createCluesService({
    root: join(base, 'store'), now: () => NOW, newId: kind => kind + '-' + (++next),
    resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
    builtinSources: options.withSource === false ? (options.extraBuiltinSources ?? []) : [testSourceRegistration(source), ...(options.extraBuiltinSources ?? [])],
  })
  return { base, workspace, service, source }
}
/** Ensure one clue of the test source and return its id. */
async function ensureClue(service: CluesService, id = 'a', title = 'Live clue'): Promise<string> {
  return (await service.ensure({ workspaceId: 'ws-1', sourceId: TEST_SOURCE, typeId: TEST_TYPE, locator: { id }, title })).clue.id
}
/** One snapshot spec for the package builder. */
interface SnapshotSpec {
  content: Uint8Array
  encoding?: 'json' | 'raw'
  format?: string
  mediaType?: string
  fetchedAt?: string
  sourceVersion?: string
  /** Override the recorded digest/byte count (integrity cases). */
  sha256?: string
  bytes?: number
  path?: string
  assets?: Array<{ content: Uint8Array; path?: string; kind?: 'download' | 'open'; mediaType?: string; sha256?: string; bytes?: number }>
  /** Optional v2 discussion entry stored beside the primary payload. */
  discussion?: { content: Uint8Array; path?: string; sha256?: string; bytes?: number }
}
interface ClueSpec { key: string; sourceId?: string; typeId?: string; title?: string; portable?: CluePortableRef; snapshot?: SnapshotSpec }
interface BuildOptions {
  mode?: CluepackMode
  packs?: Array<{ key?: string; name: string; members: string[] }>
  issues?: CluepackIssue[]
  exportedAt?: string
  formatVersion?: 1 | 2
  /** Serialize this instead of the assembled manifest (invalid-version cases). */
  rawManifest?: unknown
}
function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
/** Assemble one archive from the given clues. */
function buildPack(clues: ClueSpec[], options: BuildOptions = {}): { bytes: Buffer; manifest: CluepackManifest } {
  const sourceIds = [...new Set(clues.map(clue => clue.sourceId ?? TEST_SOURCE))]
  const sources: CluepackSource[] = sourceIds.map((sourceId, index) => ({ key: 'source-' + (index + 1), sourceId }))
  const entries: Array<{ name: string; data: Uint8Array }> = []
  const clueRecords: CluepackClue[] = clues.map((clue) => {
    let snapshot: CluepackSnapshot | undefined
    if (clue.snapshot !== undefined) {
      const spec = clue.snapshot
      const encoding = spec.encoding ?? 'json'
      const path = spec.path ?? 'content/' + clue.key + (encoding === 'json' ? '.json' : '.bin')
      const assets = (spec.assets ?? []).map((asset, index) => {
        const assetPath = asset.path ?? 'content/' + clue.key + '.asset-' + (index + 1) + '.bin'
        entries.push({ name: assetPath, data: asset.content })
        return {
          path: assetPath, kind: asset.kind ?? 'download', mediaType: asset.mediaType ?? 'application/octet-stream',
          bytes: asset.bytes ?? asset.content.byteLength, sha256: asset.sha256 ?? sha256Of(asset.content),
        }
      })
      let discussion: CluepackSnapshot['discussion']
      if (spec.discussion !== undefined) {
        const discussionPath = spec.discussion.path ?? 'content/' + clue.key + '.discussion.json'
        entries.push({ name: discussionPath, data: spec.discussion.content })
        discussion = {
          path: discussionPath, bytes: spec.discussion.bytes ?? spec.discussion.content.byteLength,
          sha256: spec.discussion.sha256 ?? sha256Of(spec.discussion.content),
        }
      }
      snapshot = {
        path, encoding,
        mediaType: spec.mediaType ?? (encoding === 'json' ? 'application/json' : 'application/octet-stream'),
        format: spec.format ?? 'text/plain', bytes: spec.bytes ?? spec.content.byteLength, sha256: spec.sha256 ?? sha256Of(spec.content),
        fetchedAt: spec.fetchedAt ?? '2026-10-16T12:00:00.000Z',
        ...(spec.sourceVersion === undefined ? {} : { sourceVersion: spec.sourceVersion }),
        ...(assets.length === 0 ? {} : { assets }),
        ...(discussion === undefined ? {} : { discussion }),
      }
      entries.push({ name: path, data: spec.content })
    }
    return {
      key: clue.key, sourceKey: sources[sourceIds.indexOf(clue.sourceId ?? TEST_SOURCE)]!.key,
      typeId: clue.typeId ?? TEST_TYPE, title: clue.title ?? 'Title ' + clue.key,
      portable: clue.portable ?? { portable: true, locator: { id: clue.key } },
      ...(snapshot === undefined ? {} : { snapshot }),
    }
  })
  const packs: CluepackPack[] = (options.packs ?? []).map((pack, index) => ({ key: pack.key ?? 'pack-' + (index + 1), name: pack.name, members: pack.members }))
  const manifest: CluepackManifest = {
    formatVersion: options.formatVersion ?? 1, format: CLUEPACK_FORMAT, exportedAt: options.exportedAt ?? NOW,
    mode: options.mode ?? 'references', sources, clues: clueRecords, packs, issues: options.issues ?? [],
  }
  const manifestBytes = options.rawManifest === undefined
    ? serializeCluepackManifest(manifest)
    : Buffer.from(JSON.stringify(options.rawManifest), 'utf8')
  return { bytes: createZip([{ name: 'manifest.json', data: manifestBytes }, ...entries], { modifiedAt: new Date(NOW) }), manifest }
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
  return Buffer.from(JSON.stringify({ format: 'text/plain', data, ...(text === undefined ? {} : { text }) }), 'utf8')
}
/** One complete discussion page with a comment, a native reply and a review. */
function discussionPage(overrides: Partial<ClueDiscussionPage> = {}): ClueDiscussionPage {
  return {
    status: 'ok',
    items: [
      {
        id: 'comment-1', kind: 'comment', format: 'text/markdown', body: 'A comment',
        author: { id: 'user-1', name: 'Ada' }, createdAt: NOW, replyCount: 1, resolved: false,
        anchor: { kind: 'text', quote: 'quoted', locator: { path: 'docs/a.md', line: 2 } },
      },
      { id: 'reply-1', kind: 'reply', format: 'text/plain', body: 'A reply', replyToId: 'comment-1' },
      { id: 'review-1', kind: 'review', format: 'text/markdown', body: 'Reviewed', reviewState: 'approved' },
    ],
    fetchedAt: '2026-10-16T12:00:00.000Z', total: 3, complete: true, coverage: 'document', ...overrides,
  }
}
function discussionContent(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8')
}
/** The explicit page import writes when the archive carries no discussion. */
function notCapturedPage(fetchedAt: string): ClueDiscussionPage {
  return { status: 'not-captured', items: [], fetchedAt, complete: false, coverage: 'document' }
}
/** The public putSnapshot input with the UI19 discussion field under test. */
type ObservedSnapshotInput = Parameters<CluesService['putSnapshot']>[1] & { discussion?: ClueDiscussionPage }
/** Spy on putSnapshot to observe the exact input while delegating the real write. */
function captureSnapshotInputs(service: CluesService): { service: CluesService; inputs: ObservedSnapshotInput[] } {
  const inputs: ObservedSnapshotInput[] = []
  const original = service.putSnapshot.bind(service)
  vi.spyOn(service, 'putSnapshot').mockImplementation(async (workspaceId, input) => {
    inputs.push(input as ObservedSnapshotInput)
    return original(workspaceId, input)
  })
  return { service, inputs }
}
/** Rename one ZIP entry in place (both headers) for malicious-path cases. */
function renameZipEntry(zip: Buffer, from: string, to: string): Buffer {
  const source = Buffer.from(from, 'utf8')
  const target = Buffer.from(to, 'utf8')
  if (source.length !== target.length) throw new Error('renameZipEntry needs equal lengths')
  const copy = Buffer.from(zip)
  let offset = copy.indexOf(source)
  if (offset === -1) throw new Error('entry "' + from + '" not found')
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
  it('summarizes an archive without reading, writing or guessing missing sources', async () => {
    const f = fixture()
    const pack = buildPack([
      { key: 'clue-1', title: '设计与实现', snapshot: { content: jsonContent({ text: 'archived' }, 'archived') } },
      { key: 'clue-2', sourceId: 'missing.source', title: 'Missing source' },
    ], { mode: 'snapshot', packs: [{ name: '发布材料', members: ['clue-1', 'clue-2'] }] })
    const preview = await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(preview).toMatchObject({
      mode: 'snapshot', packNames: ['发布材料'], snapshotCount: 1, unresolvedCount: 1, missingSources: ['missing.source'],
    })
    expect(preview.packs[0]).toMatchObject({ name: '发布材料', members: 2, snapshotMembers: 1 })
    expect(preview.items[0]).toMatchObject({ title: '设计与实现', portable: true, snapshot: true, willBeUnresolved: false })
    expect(preview.items[1]).toMatchObject({ title: 'Missing source', willBeUnresolved: true })
    expect(preview.items[1]!.unresolvedReason).toMatch(/not installed/i)
    expect(preview.warnings.join('\n')).toMatch(/not installed/i)
    expect(preview.sources.find(source => source.sourceId === TEST_SOURCE))
      .toMatchObject({ installed: true, connectionId: 'conn-a', missingTypeIds: [] })
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
    expect(await libraryIds(f.service)).toEqual([])
    expect((await f.service.listPacks('ws-1')).packs).toEqual([])
  })
  it('honors an abort that lands while the local library is being read', async () => {
    const f = fixture()
    const controller = new AbortController()
    const aborting = {
      ...f.service,
      listClues: async (workspaceId: string) => {
        const result = await f.service.listClues(workspaceId)
        controller.abort()
        return result
      },
    } as CluesService
    await expect(previewImport({ clues: aborting }, { workspaceId: 'ws-1', bytes: buildPack([{ key: 'clue-1' }]).bytes, signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
  })
})
describe('importPack references mode', () => {
  it('imports references, reuses canonical clashes and leaves pins/bindings alone', async () => {
    const f = fixture()
    const liveId = await ensureClue(f.service, 'a', 'Live')
    await f.service.addPin({ workspaceId: 'ws-1', clueId: liveId })
    await f.service.addBinding({ workspaceId: 'ws-1', target: { kind: 'clue', clueId: liveId } })
    const pack = buildPack([
      { key: 'clue-1', title: 'First', portable: { portable: true, locator: { id: 'a' } } },
      { key: 'clue-2', title: 'Second' },
    ], { packs: [{ name: 'Imported pack', members: ['clue-1', 'clue-2'] }] })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: true, partial: false, mode: 'references', issues: [] })
    expect(result.clues.map(clue => [clue.clueId, clue.created])).toEqual([[liveId, false], [expect.any(String), true]])
    expect(result.packs).toHaveLength(1)
    expect(result.packs[0]!.members).toBe(2)
    const library = await f.service.listClues('ws-1')
    expect(library.clues.map(clue => clue.title)).toEqual(['Live', 'Second'])
    expect((await f.service.listPacks('ws-1')).packs[0]).toMatchObject({ name: 'Imported pack', members: library.clues.map(clue => clue.id) })
    expect((await f.service.listPins('ws-1')).pins).toEqual([expect.objectContaining({ clueId: liveId })])
    expect((await f.service.listBindings('ws-1')).bindings).toEqual([expect.objectContaining({ target: { kind: 'clue', clueId: liveId } })])
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
    // A duplicate pack name creates a separate pack, never an overwrite.
    const again = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(again.clues.map(clue => clue.created)).toEqual([false, false])
    expect(again.clues.map(clue => clue.clueId)).toEqual(result.clues.map(clue => clue.clueId))
    expect(await libraryIds(f.service)).toHaveLength(2)
    const packsAfter = await f.service.listPacks('ws-1')
    expect([packsAfter.packs.length, packsAfter.packs.every(pack => pack.name === 'Imported pack')]).toEqual([2, true])
  })
  it('imports the static v1 fixture without changes', async () => {
    const f = fixture()
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: fixturePack() })
    expect(result).toMatchObject({ complete: true, snapshots: [{ clueKey: 'clue-1' }] })
    const record = await f.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: result.snapshots[0]!.snapshotId })
    expect(record.content.text).toBe('fixture content')
    expect(record.meta).toMatchObject({ format: 'text/plain', fetchedAt: '2026-10-16T12:00:00.000Z', sourceVersion: 'rev-fixture', integrity: 'verified' })
    expect((await f.service.listPacks('ws-1')).packs[0]!.name).toBe('Fixture pack')
  })
})
describe('importPack with missing sources and snapshots', () => {
  it('keeps a missing-source clue unresolved and remaps the same row once the source appears', async () => {
    const f = fixture()
    const pack = buildPack([{
      key: 'clue-1', sourceId: 'missing.source', typeId: 'missing.source.doc', title: 'Orphan',
      portable: { portable: true, locator: { id: 'a' } },
    }])
    const first = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(first.clues[0]).toMatchObject({ created: true, unresolved: true })
    const rowId = first.clues[0]!.clueId
    const row = (await f.service.listClues('ws-1')).clues[0]!
    expect(row.unresolved?.reason).toMatch(/not installed/i)
    await expect(f.service.read({ workspaceId: 'ws-1', clueId: row.id })).rejects.toMatchObject({ category: 'source-missing' })
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
    // A receiver remap persists the hint on the SAME row while the source is still missing.
    const second = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes, remap: [{ clueKey: 'clue-1', locator: { id: 'a' } }] })
    expect(second.clues[0]!.clueId).toBe(rowId)
    const hinted = (await f.service.listClues('ws-1')).clues
    expect([hinted.length, hinted[0]!.unresolved?.portable?.locator]).toEqual([1, { id: 'a' }])
    // Installing the source later reuses that row and clears the unresolved state.
    f.service.registerSource(externalSource('missing.source', 'missing.source.doc'))
    const resolved = await f.service.ensure({ workspaceId: 'ws-1', sourceId: 'missing.source', typeId: 'missing.source.doc', locator: { id: 'a' }, title: 'Orphan' })
    expect(resolved.clue).toMatchObject({ id: rowId })
    expect(resolved.clue.unresolved).toBeUndefined()
  })
  it('stores an offline snapshot that stays readable when the live read fails', async () => {
    const f = fixture()
    const missing = buildPack([{
      key: 'clue-1', sourceId: 'missing.source', title: 'Archived',
      snapshot: { content: jsonContent({ text: 'archived body' }, 'archived body') },
    }], { mode: 'snapshot', packs: [{ name: 'Archive pack', members: ['clue-1'] }] })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: missing.bytes })
    expect(result).toMatchObject({ complete: true, snapshots: [{ clueKey: 'clue-1' }] })
    const clue = (await f.service.listClues('ws-1')).clues[0]!
    await expect(f.service.read({ workspaceId: 'ws-1', clueId: clue.id })).rejects.toMatchObject({ category: 'source-missing' })
    const record = await f.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: result.snapshots[0]!.snapshotId })
    expect(record.meta).toMatchObject({ clueId: clue.id, fetchedAt: '2026-10-16T12:00:00.000Z' })
    expect(record.content).toMatchObject({ format: 'text/plain', data: { text: 'archived body' }, text: 'archived body' })
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(1)
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
    // An installed source that really answers auth-required is no different: the snapshot stays readable.
    const live = fixture()
    const liveResult = await importPack({ clues: live.service }, { workspaceId: 'ws-1', bytes: buildPack([{
      key: 'clue-1', title: 'Authorized once', portable: { portable: true, locator: { id: 'a' } },
      snapshot: { content: jsonContent({ text: 'offline snapshot body' }, 'offline snapshot body') },
    }], { mode: 'snapshot' }).bytes })
    live.source.read = async () => { throw new ClueError('auth-required', 'the installed source requires authorization') }
    await expect(live.service.read({ workspaceId: 'ws-1', clueId: liveResult.clues[0]!.clueId })).rejects.toMatchObject({ category: 'auth-required' })
    const authRecord = await live.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: liveResult.snapshots[0]!.snapshotId })
    expect(authRecord.content).toMatchObject({ format: 'text/plain', text: 'offline snapshot body' })
  })
  it('preserves raw binary snapshot bytes exactly', async () => {
    const f = fixture()
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 0, 13, 10])
    const pack = buildPack([{ key: 'clue-1', title: 'Binary asset', snapshot: { content: bytes, encoding: 'raw', mediaType: 'image/png' } }], { mode: 'snapshot' })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    const record = await f.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: result.snapshots[0]!.snapshotId })
    expect(record.content).toMatchObject({ format: 'text/plain' })
    expect(record.content.data).toMatchObject({
      kind: 'binary', mediaType: 'image/png', size: bytes.length, sha256: sha256Of(bytes), encoding: 'base64',
    })
    expect(new Uint8Array(Buffer.from((record.content.data as { base64: string }).base64, 'base64'))).toEqual(bytes)
  })
  it('stores the body and every asset of a multi-part snapshot', async () => {
    const f = fixture()
    const first = new Uint8Array([1, 2, 3, 4])
    const second = new Uint8Array([9, 8, 7])
    const pack = buildPack([{
      key: 'clue-1', title: 'Body plus assets',
      snapshot: {
        content: jsonContent({ text: 'body text' }, 'body text'),
        assets: [{ content: first, kind: 'download', mediaType: 'image/png' }, { content: second, kind: 'open', mediaType: 'image/png' }],
      },
    }], { mode: 'snapshot' })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    const record = await f.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: result.snapshots[0]!.snapshotId })
    expect(record.content).toMatchObject({ format: 'text/plain', text: 'body text' })
    expect(record.content.data).toMatchObject({ kind: 'cluepack-snapshot-bundle', version: 1, primary: { encoding: 'json', data: { text: 'body text' } } })
    const assets = (record.content.data as { assets: Array<{ kind: string; base64: string }> }).assets
    expect(assets.map(asset => asset.kind)).toEqual(['download', 'open'])
    expect(new Uint8Array(Buffer.from(assets[0]!.base64, 'base64'))).toEqual(first)
    expect(new Uint8Array(Buffer.from(assets[1]!.base64, 'base64'))).toEqual(second)
  })
  it('rejects a missing or checksum-mismatched asset before writing anything', async () => {
    const f = fixture()
    const first = new Uint8Array([1, 2, 3])
    const pack = buildPack([{
      key: 'clue-1', snapshot: { content: jsonContent({ text: 'body' }, 'body'), assets: [{ content: first, path: 'content/clue-1.asset-1.bin' }] },
    }], { mode: 'snapshot' })
    const withoutAsset = createZip(readZip(pack.bytes).filter(entry => entry.name !== 'content/clue-1.asset-1.bin'), { modifiedAt: new Date(NOW) })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: withoutAsset })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(await libraryIds(f.service)).toEqual([])
    const badPack = buildPack([{
      key: 'clue-1', snapshot: { content: jsonContent({ text: 'body' }, 'body'), assets: [{ content: first, sha256: 'a'.repeat(64) }] },
    }], { mode: 'snapshot' })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: badPack.bytes })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(await libraryIds(f.service)).toEqual([])
  })
  it('reuses a live reference, keeps live reads live and mints an independent snapshot per import', async () => {
    const f = fixture()
    const liveId = await ensureClue(f.service, 'a', 'Live title')
    const pack = buildPack([{
      key: 'clue-1', title: 'Imported old title', portable: { portable: true, locator: { id: 'a' } },
      snapshot: { content: jsonContent({ text: 'old archived body' }, 'old archived body') },
    }], { mode: 'snapshot' })
    const first = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(first.clues[0]).toMatchObject({ clueId: liveId, created: false, unresolved: false, title: 'Live title' })
    expect(await libraryIds(f.service)).toEqual([liveId])
    expect((await f.service.listClues('ws-1')).clues[0]).toMatchObject({ title: 'Live title', locator: { id: 'a' } })
    const live = await f.service.read({ workspaceId: 'ws-1', clueId: liveId })
    expect([live.text, f.source.calls.read]).toEqual(['live content', 1])
    const firstRecord = await f.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: first.snapshots[0]!.snapshotId })
    expect([firstRecord.meta.clueId, firstRecord.content.text]).toEqual([liveId, 'old archived body'])
    const second = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(second.clues[0]!.clueId).toBe(liveId)
    expect(second.snapshots[0]!.snapshotId).not.toBe(first.snapshots[0]!.snapshotId)
    for (const imported of [first, second]) {
      const record = await f.service.readSnapshot({ workspaceId: 'ws-1', snapshotId: imported.snapshots[0]!.snapshotId })
      expect([record.content.text, record.meta.clueId]).toEqual(['old archived body', liveId])
    }
    expect(f.source.calls).toEqual({ read: 1, portable: 0 })
  })
  it('imports a locally resolved clue whose source is gone without minting a second row', async () => {
    const f = fixture({ withSource: false })
    const unregister = f.service.registerSource(testSourceRegistration(f.source))
    const ensured = await f.service.ensure({ workspaceId: 'ws-1', sourceId: TEST_SOURCE, typeId: TEST_TYPE, locator: { id: 'a' }, title: 'Live title' })
    // The source is gone, but the row it minted is still a RESOLVED clue.
    unregister()
    const pack = buildPack([{ key: 'clue-1', title: 'Imported old title', portable: { portable: true, locator: { id: 'a' } } }])
    const preview = await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect([preview.items[0]!.willBeUnresolved, preview.unresolvedCount]).toEqual([false, 0])
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result.clues[0]).toMatchObject({ clueId: ensured.clue.id, created: false, unresolved: false })
    const library = await f.service.listClues('ws-1')
    expect([library.clues.length, library.clues[0]!.title, library.clues[0]!.unresolved]).toEqual([1, 'Live title', undefined])
    expect(f.source.calls).toEqual({ read: 0, portable: 0 })
  })
})
describe('importPack v2 discussion snapshots', () => {
  it('imports a complete discussion beside the body and preserves reply/review fields', async () => {
    const f = fixture()
    const { service, inputs } = captureSnapshotInputs(f.service)
    const page = discussionPage()
    const withExtensions = { ...page, unknownPageKey: 'ignored', items: page.items.map(item => ({ ...item, unknownItemKey: 'ignored' })) }
    const pack = buildPack([{
      key: 'clue-1', snapshot: { content: jsonContent({ text: 'archived body' }, 'archived body'), discussion: { content: discussionContent(withExtensions) } },
    }], { mode: 'snapshot', formatVersion: 2 })
    const result = await importPack({ clues: service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: true, partial: false, snapshots: [{ clueKey: 'clue-1' }] })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.discussion).toEqual(page)
    expect(inputs[0]!.discussion!.items.map(item => item.kind)).toEqual(['comment', 'reply', 'review'])
    expect(inputs[0]!.discussion!.items[1]).toMatchObject({ replyToId: 'comment-1', body: 'A reply' })
    expect(inputs[0]!.discussion!.items[2]).toMatchObject({ reviewState: 'approved', body: 'Reviewed' })
  })
  it('projects a missing or v1 discussion descriptor as explicit not-captured', async () => {
    const fetchedAt = '2026-10-16T12:00:00.000Z'
    const cases = [
      { formatVersion: 1 as const, descriptor: false },
      { formatVersion: 2 as const, descriptor: false },
      { formatVersion: 1 as const, descriptor: true },
    ]
    for (const testCase of cases) {
      const f = fixture()
      const { service, inputs } = captureSnapshotInputs(f.service)
      const pack = buildPack([{
        key: 'clue-1', snapshot: {
          content: jsonContent({ text: 'legacy body' }, 'legacy body'), fetchedAt,
          ...(testCase.descriptor ? { discussion: { content: discussionContent(discussionPage()) } } : {}),
        },
      }], { mode: 'snapshot', formatVersion: testCase.formatVersion })
      const result = await importPack({ clues: service }, { workspaceId: 'ws-1', bytes: pack.bytes })
      expect(result.complete).toBe(true)
      // The v1 serializer drops the unknown descriptor; the unreferenced entry must not be applied.
      if (testCase.descriptor) expect(pack.manifest.clues[0]!.snapshot!.discussion).toBeDefined()
      expect(inputs[0]!.discussion).toEqual(notCapturedPage(fetchedAt))
      expect([inputs[0]!.discussion!.complete, inputs[0]!.discussion!.status]).toEqual([false, 'not-captured'])
    }
  })
  it('rejects missing, mismatched or malformed discussion entries before writing anything', async () => {
    const page = discussionContent(discussionPage())
    const cases: Array<{ name: string; pack: () => Buffer; message: RegExp }> = [
      {
        name: 'missing entry',
        pack: () => {
          const built = buildPack([{
            key: 'clue-1', snapshot: { content: jsonContent({ text: 'body' }), discussion: { content: page } },
          }], { mode: 'snapshot', formatVersion: 2 })
          return createZip(readZip(built.bytes).filter(entry => entry.name !== 'content/clue-1.discussion.json'), { modifiedAt: new Date(NOW) })
        },
        message: /discussion.*missing/i,
      },
      {
        name: 'declared size mismatch',
        pack: () => buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'body' }), discussion: { content: page, bytes: 99_999 } } }], { mode: 'snapshot', formatVersion: 2 }).bytes,
        message: /discussion.*declared size/i,
      },
      {
        name: 'checksum mismatch',
        pack: () => buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'body' }), discussion: { content: page, sha256: 'a'.repeat(64) } } }], { mode: 'snapshot', formatVersion: 2 }).bytes,
        message: /discussion.*checksum/i,
      },
      {
        name: 'invalid JSON',
        pack: () => buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'body' }), discussion: { content: Buffer.from('{', 'utf8') } } }], { mode: 'snapshot', formatVersion: 2 }).bytes,
        message: /discussion.*UTF-8 JSON/i,
      },
      {
        name: 'invalid page shape',
        pack: () => buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'body' }), discussion: { content: discussionContent({ status: 'ok', items: [] }) } } }], { mode: 'snapshot', formatVersion: 2 }).bytes,
        message: /discussion page/i,
      },
    ]
    for (const testCase of cases) {
      const f = fixture()
      await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: testCase.pack() }), testCase.name).rejects.toThrowError(testCase.message)
      expect(await libraryIds(f.service), testCase.name).toEqual([])
      expect((await f.service.listPacks('ws-1')).packs, testCase.name).toEqual([])
    }
    // Two clues: the second invalid page must block the first valid snapshot's write.
    const f = fixture()
    const pack = buildPack([
      { key: 'clue-1', snapshot: { content: jsonContent({ text: 'first body' }), discussion: { content: page } } },
      { key: 'clue-2', snapshot: { content: jsonContent({ text: 'second body' }), discussion: { content: discussionContent({ status: 'ok', items: [] }) } } },
    ], { mode: 'snapshot', formatVersion: 2 })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })).rejects.toThrowError(/discussion page/i)
    expect([await libraryIds(f.service), (await f.service.listPacks('ws-1')).packs]).toEqual([[], []])
  })
  it('accepts the aggregate item bound and rejects one item above it', async () => {
    const items = (count: number): ClueDiscussionPage['items'] => Array.from({ length: count }, (_, index) => ({
      id: 'comment-' + index, kind: 'comment' as const, format: 'text/plain' as const, body: '',
    }))
    const f = fixture()
    const { service, inputs } = captureSnapshotInputs(f.service)
    const atLimit = buildPack([{ key: 'clue-1', snapshot: {
      content: jsonContent({ text: 'body' }), discussion: { content: discussionContent(discussionPage({ items: items(10_000) })) },
    } }], { mode: 'snapshot', formatVersion: 2 })
    await importPack({ clues: service }, { workspaceId: 'ws-1', bytes: atLimit.bytes })
    expect(inputs[0]!.discussion!.items).toHaveLength(10_000)
    const overLimit = fixture()
    const tooMany = buildPack([{ key: 'clue-1', snapshot: {
      content: jsonContent({ text: 'body' }), discussion: { content: discussionContent(discussionPage({ items: items(10_001) })) },
    } }], { mode: 'snapshot', formatVersion: 2 })
    await expect(importPack({ clues: overLimit.service }, { workspaceId: 'ws-1', bytes: tooMany.bytes })).rejects.toThrowError(/at most 10000 comments/i)
    expect(await libraryIds(overLimit.service)).toEqual([])
  })
})
describe('importPack safety boundary', () => {
  it('rejects a traversing archive entry or snapshot path before writing anything', async () => {
    const f = fixture()
    const malicious = renameZipEntry(buildPack([{ key: 'clue-1' }]).bytes, 'manifest.json', 'content/../aaa.json'.slice(0, 13))
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: malicious })).rejects.toThrowError(/unsafe archive entry name/i)
    expect(await libraryIds(f.service)).toEqual([])
    const rawManifest = {
      formatVersion: 1, format: CLUEPACK_FORMAT, exportedAt: NOW, mode: 'snapshot', sources: [{ key: 'source-1', sourceId: TEST_SOURCE }],
      clues: [{
        key: 'clue-1', sourceKey: 'source-1', typeId: TEST_TYPE, title: 'Escape', portable: { portable: true, locator: { id: 'a' } },
        snapshot: { path: 'content/../escape.json', encoding: 'json', mediaType: 'application/json', format: 'text/plain', bytes: 2, sha256: 'a'.repeat(64), fetchedAt: NOW },
      }],
      packs: [], issues: [],
    }
    const bytes = createZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(rawManifest), 'utf8') }])
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes })).rejects.toThrowError(/unsafe archive entry name/i)
    expect([await libraryIds(f.service), (await f.service.listPacks('ws-1')).packs]).toEqual([[], []])
  })
  it('rejects a checksum mismatch, missing content, unknown version and truncated archive before writing', async () => {
    const f = fixture()
    const badChecksum = buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'x' }), sha256: 'a'.repeat(64) } }], { mode: 'snapshot' })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: badChecksum.bytes })).rejects.toThrowError(/checksum/i)
    const missing = buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'x' }) } }], { mode: 'snapshot' })
    const withoutContent = createZip([{ name: 'manifest.json', data: serializeCluepackManifest(missing.manifest) }])
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: withoutContent })).rejects.toThrowError(/missing/i)
    const unknown = buildPack([{ key: 'clue-1' }], { rawManifest: {
      formatVersion: 3, format: CLUEPACK_FORMAT, exportedAt: NOW, mode: 'references', sources: [], clues: [], packs: [], issues: [],
    } })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: unknown.bytes })).rejects.toMatchObject({ category: 'unsupported' })
    const valid = buildPack([{ key: 'clue-1' }])
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: valid.bytes.subarray(0, valid.bytes.length - 8) }))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(await libraryIds(f.service)).toEqual([])
  })
  it('enforces injected ZIP limits and refuses a pre-cancelled import before writing', async () => {
    const f = fixture()
    const content = new Uint8Array(4_096)
    const pack = buildPack([{ key: 'clue-1', snapshot: { content, encoding: 'raw' } }], { mode: 'snapshot' })
    // Above the manifest but below the content entry, so the limit really hits a payload.
    await expect(importPack({ clues: f.service, zipLimits: { maxEntryBytes: 2_048 } }, { workspaceId: 'ws-1', bytes: pack.bytes }))
      .rejects.toThrowError(/content\/clue-1\.bin.*size limit/i)
    expect(await libraryIds(f.service)).toEqual([])
    const controller = new AbortController()
    controller.abort()
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: buildPack([{ key: 'clue-1' }]).bytes, signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
    expect(await libraryIds(f.service)).toEqual([])
  })
})
describe('importPack partial results', () => {
  it('imports a confirmed partial export completely and keeps the sender issues separate', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }], {
      packs: [{ name: 'Partial pack', members: ['clue-1'] }],
      issues: [{ target: 'clue', key: 'clue-1', category: 'unsupported', reason: 'content was not fetched' }],
    })
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    // The SENDER's missing content is a property of the archive, not a local commit failure.
    expect(result).toMatchObject({ complete: true, partial: false, requiresAcceptance: false, issues: [], reasons: [] })
    expect(result.manifestIssues).toHaveLength(1)
    expect(await libraryIds(f.service)).toHaveLength(1)
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(1)
  })
  it('keeps committed rows when pack or snapshot creation fails and reports a partial import', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'x' }) } }], {
      mode: 'snapshot', packs: [{ name: 'Uncreatable', members: ['clue-1'] }],
    })
    const failingPack = { ...f.service, createPack: async () => { throw new ClueError('failed', 'the pack store is unavailable') } } as CluesService
    const packFailure = await importPack({ clues: failingPack }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(packFailure).toMatchObject({ complete: false, partial: true, requiresAcceptance: true, packs: [] })
    expect(packFailure.clues).toHaveLength(1)
    expect(packFailure.reasons).toContain(SAFE_FAILURE_REASONS.failed)
    expect(await libraryIds(f.service)).toHaveLength(1)
    const g = fixture()
    const snapshotPack = buildPack([{ key: 'clue-1', snapshot: { content: jsonContent({ text: 'x' }) } }], { mode: 'snapshot' })
    const failingSnapshot = { ...g.service, putSnapshot: async () => { throw new ClueError('failed', 'the snapshot store is unavailable') } } as CluesService
    const snapshotFailure = await importPack({ clues: failingSnapshot }, { workspaceId: 'ws-1', bytes: snapshotPack.bytes })
    expect(snapshotFailure).toMatchObject({ complete: false, partial: true, requiresAcceptance: true, snapshots: [] })
    expect(snapshotFailure.clues[0]).toMatchObject({ unresolved: false })
    expect(snapshotFailure.reasons).toContain(SAFE_FAILURE_REASONS.failed)
  })
  it('keeps an auth-required commit failure as an unresolved row and a partial import', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1', portable: { portable: true, locator: { id: 'a' } } }])
    const failing = { ...f.service, ensure: async () => { throw new ClueError('auth-required', 'the source requires authorization') } } as CluesService
    const result: ClueShareImportResult = await importPack({ clues: failing }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: false, partial: true, requiresAcceptance: true })
    expect(result.clues[0]).toMatchObject({ created: true, unresolved: true })
    expect(result.issues).toContainEqual(expect.objectContaining({ target: 'clue', key: 'clue-1', category: 'auth-required' }))
    const row = (await f.service.listClues('ws-1')).clues[0]!
    expect(row.unresolved?.reason).toMatch(/authorization/)
  })
})
describe('explicit receiver remap', () => {
  it('previews and commits a JSON-safe remap and refuses a foreign connection', async () => {
    const f = fixture()
    const remote = buildPack([{ key: 'clue-1', title: 'External clue', portable: { portable: false, locator: { url: 'https://sender.invalid/private' } } }])
    const remap = [{ clueKey: 'clue-1', locator: { id: 'a' } }]
    const preview = await previewImport({ clues: f.service }, { workspaceId: 'ws-1', bytes: remote.bytes, remap })
    expect([preview.items[0]!.willBeUnresolved, preview.unresolvedCount]).toEqual([false, 0])
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: remote.bytes, remap })
    expect(result.clues[0]).toMatchObject({ created: true, unresolved: false })
    const clue = (await f.service.listClues('ws-1')).clues[0]!
    expect([clue.locator, clue.unresolved]).toEqual([{ id: 'a' }, undefined])
    // A same-named connection is not assumed to belong to the receiver.
    const g = fixture()
    const pack = buildPack([{ key: 'clue-1' }])
    const mismatch = await importPack({ clues: g.service }, {
      workspaceId: 'ws-1', bytes: pack.bytes, remap: [{ clueKey: 'clue-1', locator: { id: 'a' }, connectionId: 'sender-connection' }],
    })
    expect(mismatch.clues[0]!.unresolved).toBe(true)
    expect((await g.service.listClues('ws-1')).clues[0]!.unresolved?.reason).toMatch(/connection.*not available/i)
    const matched = await importPack({ clues: g.service }, {
      workspaceId: 'ws-1', bytes: pack.bytes, remap: [{ clueKey: 'clue-1', locator: { id: 'a' }, connectionId: 'conn-a' }],
    })
    expect(matched.clues[0]!.unresolved).toBe(false)
  })
  it('refuses a deeply nested remap locator and a stale remap key', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1' }])
    let locator: Record<string, unknown> = { value: 1 }
    for (let depth = 0; depth < 100; depth += 1) locator = { nested: locator }
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes, remap: [{ clueKey: 'clue-1', locator: locator as never }] }))
      .rejects.toMatchObject({ category: 'invalid-request' })
    await expect(importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes, remap: [{ clueKey: 'clue-gone', locator: { id: 'a' } }] }))
      .rejects.toThrowError(/unknown clue/i)
    expect(await libraryIds(f.service)).toEqual([])
  })
  it('reports a conflict instead of adopting a row that already owns the remap target', async () => {
    for (const testCase of [
      { sourceId: 'missing.source', typeId: 'missing.source.doc' },
      { sourceId: TEST_SOURCE, typeId: 'test.source.not-offered' },
    ]) {
      const f = fixture()
      const pack = buildPack([{
        key: 'clue-1', sourceId: testCase.sourceId, typeId: testCase.typeId, title: 'First import',
        portable: { portable: true, locator: { id: 'a' } },
      }])
      const first = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
      expect(first.clues[0]).toMatchObject({ created: true, unresolved: true })
      const priorId = first.clues[0]!.clueId
      const occupied = await f.service.importUnresolved({
        workspaceId: 'ws-1', sourceId: testCase.sourceId, typeId: testCase.typeId, locator: {}, title: 'Occupying row',
        reason: SAFE_SOURCE_NOT_INSTALLED, portable: { portable: true, locator: { id: 'b' } },
      })
      const before = (await f.service.listClues('ws-1')).clues
      const second = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes, remap: [{ clueKey: 'clue-1', locator: { id: 'b' } }] })
      // S1's dedupe must not silently adopt the occupying row and leave the old unresolved row behind.
      expect(second).toMatchObject({ complete: false, partial: true, requiresAcceptance: true, clues: [] })
      expect(second.issues).toContainEqual(expect.objectContaining({ target: 'clue', key: 'clue-1', category: 'conflict' }))
      const after = (await f.service.listClues('ws-1')).clues
      expect(after.map(clue => clue.id)).toEqual(before.map(clue => clue.id))
      const priorRow = after.find(clue => clue.id === priorId)!
      expect([priorRow.title, priorRow.unresolved?.portable?.locator]).toEqual(['First import', { id: 'a' }])
      const occupiedRow = after.find(clue => clue.id === occupied.clue.id)!
      expect([occupiedRow.title, occupiedRow.unresolved?.portable?.locator]).toEqual(['Occupying row', { id: 'b' }])
    }
  })
  it('never seeds or rewrites a row when a normalized remap target is already occupied', async () => {
    for (const typeOffered of [false, true]) {
      const f = fixture({ extraBuiltinSources: [createLocalFileSource()] })
      const files = 'builtin.files'
      const markdown = LOCAL_FILE_TYPE_IDS.markdown
      const locatorOf = (path: string): Locator => ({ root: { kind: 'workspace', workspaceId: 'ws-1' }, path, dialect: 'posix' })
      const prior = await f.service.importUnresolved({
        workspaceId: 'ws-1', sourceId: files, typeId: markdown, locator: {}, title: 'Prior note',
        reason: SAFE_SOURCE_NOT_INSTALLED, portable: { portable: true, locator: locatorOf('notes/a.md') },
      })
      const occupied = await f.service.ensure({ workspaceId: 'ws-1', sourceId: files, typeId: markdown, locator: locatorOf('a.md'), title: 'Occupying file' })
      const pack = buildPack([{
        key: 'clue-1', sourceId: files, typeId: typeOffered ? markdown : 'builtin.files.not-offered', title: 'Prior note',
        portable: { portable: true, locator: locatorOf('notes/a.md') },
      }])
      // The target normalizes to the occupied a.md; a raw-key guard would seed first and notice later.
      const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes, remap: [{ clueKey: 'clue-1', locator: locatorOf('docs/../a.md') }] })
      expect(result.complete).toBe(false)
      expect(result.issues).toContainEqual(expect.objectContaining({ key: 'clue-1', category: 'conflict' }))
      const rows = (await f.service.listClues('ws-1')).clues
      expect(rows).toHaveLength(2)
      const priorRow = rows.find(clue => clue.id === prior.clue.id)!
      expect([priorRow.title, priorRow.unresolved?.portable?.locator]).toEqual(['Prior note', locatorOf('notes/a.md')])
      expect(rows.find(clue => clue.id === occupied.clue.id)!.title).toBe('Occupying file')
    }
  })
  it('records an issue when the unresolved fallback cannot store the address', async () => {
    const f = fixture()
    f.service.registerSource(externalSource('reject.source', 'reject.source.other', {
      normalizeLocator() { throw new ClueError('invalid-request', 'this source rejects that address form') },
      locatorKey(locator) { return JSON.stringify(locator) },
    }))
    const pack = buildPack([{ key: 'clue-1', sourceId: 'reject.source', typeId: 'reject.source.not-offered', portable: { portable: true, locator: { id: 'a' } } }])
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: false, partial: true })
    expect(result.issues).toContainEqual(expect.objectContaining({ key: 'clue-1', category: 'unsupported', reason: expect.stringMatching(/could not be stored/i) }))
    const row = (await f.service.listClues('ws-1')).clues[0]!
    expect(row.unresolved).toBeDefined()
    expect(row.unresolved?.portable?.locator).toBeUndefined()
  })
})
describe('importPack progress and edge shapes', () => {
  it('reports validate/clue/pack/done progress and imports an empty pack', async () => {
    const f = fixture()
    const events: ClueShareImportProgress[] = []
    await importPack({ clues: f.service }, {
      workspaceId: 'ws-1', bytes: buildPack([{ key: 'clue-1' }], { packs: [{ name: 'P', members: ['clue-1'] }] }).bytes,
      onProgress: event => events.push(event),
    })
    expect(events[0]).toMatchObject({ phase: 'validate', completed: 0, total: 1 })
    expect(events.some(event => event.phase === 'clue')).toBe(true)
    expect(events.some(event => event.phase === 'pack')).toBe(true)
    expect(events.at(-1)).toMatchObject({ phase: 'done', status: 'ok' })
    const empty = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: buildPack([], {}).bytes })
    expect(empty).toMatchObject({ complete: true, partial: false, clues: [], packs: [] })
  })
  it('preserves long non-ASCII titles and shortens an over-long emoji pack name safely', async () => {
    const f = fixture()
    const longTitle = '很长的中文标题'.repeat(20)
    const longPack = '中文包名'.repeat(40)
    const result = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: buildPack([{ key: 'clue-1', title: longTitle }], { packs: [{ name: longPack, members: ['clue-1'] }] }).bytes })
    expect(result.complete).toBe(true)
    expect((await f.service.listClues('ws-1')).clues[0]!.title).toBe(longTitle)
    expect([(await f.service.listPacks('ws-1')).packs[0]!.name, result.packs[0]!.name]).toEqual([longPack.slice(0, 200), longPack.slice(0, 200)])
    // 199 ASCII units + one emoji (2 units) = 201 units; a code-unit slice would leave a lone high surrogate.
    const name = 'a'.repeat(199) + '😀'
    const emoji = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: buildPack([{ key: 'clue-1' }], { packs: [{ name, members: ['clue-1'] }] }).bytes })
    expect(emoji).toMatchObject({ complete: false, partial: true })
    expect(emoji.issues).toContainEqual(expect.objectContaining({ target: 'pack', key: 'pack-1', category: 'unsupported' }))
    const stored = (await f.service.listPacks('ws-1')).packs.find(pack => pack.name.startsWith('a'.repeat(199)))!.name
    expect(stored).toBe('a'.repeat(199))
    expect(stored).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
describe('importPack cancellation', () => {
  it('returns an explicit late-cancelled result after the last write', async () => {
    const cases = [
      { phase: 'clue' as const, bytes: buildPack([{ key: 'clue-1' }]).bytes, packs: 0 },
      { phase: 'pack' as const, bytes: buildPack([{ key: 'clue-1' }], { packs: [{ name: 'P', members: ['clue-1'] }] }).bytes, packs: 1 },
    ]
    for (const testCase of cases) {
      const f = fixture()
      const controller = new AbortController()
      const result = await importPack({ clues: f.service }, {
        workspaceId: 'ws-1', bytes: testCase.bytes, signal: controller.signal,
        onProgress: event => { if (event.phase === testCase.phase) controller.abort() },
      })
      // Every write completed, so this is a fully applied import with an explicit late-cancel flag.
      expect(result).toMatchObject({ complete: true, partial: false, cancelled: true, requiresAcceptance: false })
      expect([result.clues.length, result.packs.length, (await libraryIds(f.service)).length]).toEqual([1, testCase.packs, 1])
    }
  })
  it('stops between items and returns the committed rows explicitly', async () => {
    for (const mode of ['progress', 'import-unresolved'] as const) {
      const f = fixture()
      const pack = buildPack([{ key: 'clue-1', sourceId: 'missing.source' }, { key: 'clue-2', sourceId: 'missing.source' }])
      const controller = new AbortController()
      let calls = 0
      const service = mode === 'progress' ? f.service : {
        ...f.service,
        importUnresolved: async (params: Parameters<CluesService['importUnresolved']>[0], options?: Parameters<CluesService['importUnresolved']>[1]) => {
          const result = await f.service.importUnresolved(params, options)
          calls += 1
          if (calls === 1) controller.abort()
          return result
        },
      } as CluesService
      const result = await importPack({ clues: service }, {
        workspaceId: 'ws-1', bytes: pack.bytes, signal: controller.signal,
        ...(mode === 'progress' ? { onProgress: (event: ClueShareImportProgress) => { if (event.phase === 'clue' && event.completed === 1) controller.abort() } } : {}),
      })
      // S1 has no rollback; the half-import is an explicit partial result, never success or a bare throw.
      expect(result).toMatchObject({ complete: false, partial: true, cancelled: true, requiresAcceptance: true })
      expect(result.clues.map(clue => clue.clueKey)).toEqual(['clue-1'])
      expect(result.reasons.join('\n')).toMatch(/cancelled after committing 1 of 2 clues/i)
      expect(await libraryIds(f.service)).toEqual([result.clues[0]!.clueId])
    }
  })
  it('counts the remap adoption seed write and returns partial when cancellation lands after it', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1', portable: { portable: false, locator: { id: 'a' } } }])
    const first = await importPack({ clues: f.service }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(first.clues[0]!.unresolved).toBe(true)
    const priorId = first.clues[0]!.clueId
    const controller = new AbortController()
    let seedCalls = 0
    const seedThenAbort = {
      ...f.service,
      importUnresolved: async (params: Parameters<CluesService['importUnresolved']>[0], options?: Parameters<CluesService['importUnresolved']>[1]) => {
        const result = await f.service.importUnresolved(params, options)
        seedCalls += 1
        if (seedCalls === 1) controller.abort()
        return result
      },
    } as CluesService
    const result = await importPack({ clues: seedThenAbort }, {
      workspaceId: 'ws-1', bytes: pack.bytes, signal: controller.signal, remap: [{ clueKey: 'clue-1', locator: { id: 'b' } }],
    })
    // The seed write is durable even though the clue list stayed empty.
    expect(result).toMatchObject({ complete: false, partial: true, cancelled: true, requiresAcceptance: true, clues: [] })
    expect(result.reasons.join('\n')).toMatch(/existing unresolved reference updated in place/i)
    const rows = (await f.service.listClues('ws-1')).clues
    expect(rows).toHaveLength(1)
    expect([rows[0]!.id, rows[0]!.unresolved?.portable?.locator]).toEqual([priorId, { id: 'b' }])
  })
  it('converts a non-cancellation commit failure after a write into an explicit partial result', async () => {
    const f = fixture()
    const pack = buildPack([{ key: 'clue-1', sourceId: 'missing.source' }, { key: 'clue-2', sourceId: 'missing.source' }])
    let calls = 0
    const failing = {
      ...f.service,
      importUnresolved: async (params: Parameters<CluesService['importUnresolved']>[0], options?: Parameters<CluesService['importUnresolved']>[1]) => {
        calls += 1
        if (calls === 2) throw new ClueError('failed', 'the second clue could not be committed')
        return f.service.importUnresolved(params, options)
      },
    } as CluesService
    const result = await importPack({ clues: failing }, { workspaceId: 'ws-1', bytes: pack.bytes })
    expect(result).toMatchObject({ complete: false, partial: true, cancelled: false, requiresAcceptance: true })
    expect(result.clues.map(clue => clue.clueKey)).toEqual(['clue-1'])
    expect(result.reasons.join('\n')).toMatch(/failed after committing 1 of 2 clues/i)
    expect(result.issues.find(issue => issue.key === 'clue-2')?.reason).toBe(SAFE_FAILURE_REASONS.failed)
    expect(await libraryIds(f.service)).toEqual([result.clues[0]!.clueId])
  })
})