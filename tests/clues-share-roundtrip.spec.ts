/**
 * S7 end-to-end round-trips with the REAL built-in file source.
 *
 * These cases pin what the isolated unit specs cannot: an exported pack is
 * importable into a DIFFERENT service/store/workspace, workspace-relative file
 * locators are remapped to the RECEIVING workspace (never the sender's), an
 * imported snapshot is historical content while the live reference keeps
 * reading the receiver's own resource, and a missing source still leaves an
 * offline-readable snapshot. Path dialects (posix/win32), Chinese/long names
 * and an empty pack all have defined results.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import { createLocalFileSource, LOCAL_FILE_TYPE_IDS } from '../src/clues/local-files.ts'
import { ClueError, type Locator } from '../src/clues/types.ts'
import { exportPack, previewExport } from '../src/clues/share/export.ts'
import { importPack, previewImport } from '../src/clues/share/import.ts'
import {
  CLUEPACK_FORMAT,
  serializeCluepackManifest,
  type CluepackManifest,
} from '../src/clues/share/manifest.ts'
import { createZip, readZip } from '../src/clues/share/zip.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const FILES = 'builtin.files'
const HOST_DIALECT = process.platform === 'win32' ? 'win32' : 'posix'

const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

interface WorkspaceFixture {
  base: string
  service: CluesService
  workspace: string
}

/** One service with the real built-in file source (optionally without it). */
function makeWorkspace(options: { workspaceId?: string; withFiles?: boolean } = {}): WorkspaceFixture {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-roundtrip-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
  const service = createCluesService({
    root: join(base, 'store'),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
    resolveWorkspacePath: id => (id === (options.workspaceId ?? 'ws-1') ? workspace : undefined),
    ...(options.withFiles === false ? {} : { builtinSources: [createLocalFileSource()] }),
  })
  return { base, service, workspace }
}

/**
 * Re-open the SAME store with a different source set (a plugin
 * unmount/re-mount or a profile that now has the built-in file source).
 */
function reopenWorkspace(
  fixture: WorkspaceFixture,
  workspaceId: string,
  options: { withFiles?: boolean } = {},
): CluesService {
  let next = 0
  return createCluesService({
    root: join(fixture.base, 'store'),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
    resolveWorkspacePath: id => (id === workspaceId ? fixture.workspace : undefined),
    ...(options.withFiles === false ? {} : { builtinSources: [createLocalFileSource()] }),
  })
}

/** Write one workspace file and return its absolute path. */
function writeWorkspaceFile(workspace: string, relativePath: string, content: string | Uint8Array): string {
  const path = join(workspace, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** Ensure one workspace-relative file clue and return its id. */
async function ensureWorkspaceFile(
  service: CluesService,
  workspaceId: string,
  relativePath: string,
  title?: string,
): Promise<string> {
  const typeId = relativePath.endsWith('.md') ? LOCAL_FILE_TYPE_IDS.markdown : LOCAL_FILE_TYPE_IDS.text
  const result = await service.ensure({
    workspaceId,
    sourceId: FILES,
    typeId,
    locator: {
      root: { kind: 'workspace', workspaceId },
      path: relativePath,
      dialect: HOST_DIALECT,
    },
    title: title ?? relativePath,
  })
  return result.clue.id
}

/** A one-clue pack with an arbitrary built-in files locator. */
function buildLocatorPack(input: {
  locator: Locator
  typeId?: string
  title?: string
  snapshot?: { content: Uint8Array; format?: string }
  sourceInstalledElsewhere?: boolean
}): Buffer {
  const snapshot = input.snapshot === undefined
    ? undefined
    : {
      path: 'content/clue-1.json',
      encoding: 'json' as const,
      mediaType: 'application/json',
      format: input.snapshot.format ?? 'text/markdown',
      bytes: input.snapshot.content.byteLength,
      sha256: createHash('sha256').update(input.snapshot.content).digest('hex'),
      fetchedAt: '2026-10-16T12:00:00.000Z',
    }
  const manifest: CluepackManifest = {
    formatVersion: 1,
    format: CLUEPACK_FORMAT,
    exportedAt: NOW,
    mode: snapshot === undefined ? 'references' : 'snapshot',
    sources: [{ key: 'source-1', sourceId: FILES, name: 'Local files' }],
    clues: [{
      key: 'clue-1',
      sourceKey: 'source-1',
      typeId: input.typeId ?? LOCAL_FILE_TYPE_IDS.markdown,
      title: input.title ?? 'Remapped clue',
      portable: { portable: true, locator: input.locator },
      ...(snapshot === undefined ? {} : { snapshot }),
    }],
    packs: [{ key: 'pack-1', name: 'Remapped pack', members: ['clue-1'] }],
    issues: [],
  }
  const entries: Array<{ name: string; data: Uint8Array }> = [
    { name: 'manifest.json', data: serializeCluepackManifest(manifest) },
  ]
  if (input.snapshot !== undefined) {
    const content = input.snapshot.content
    entries.push({ name: 'content/clue-1.json', data: content })
  }
  return createZip(entries, { modifiedAt: new Date(NOW) })
}

describe('references round-trip between workspaces', () => {
  it('preserves titles/membership and remaps file locators to the receiver workspace', async () => {
    const sender = makeWorkspace()
    writeWorkspaceFile(sender.workspace, 'a.md', '# sender A\n')
    writeWorkspaceFile(sender.workspace, '中文 文档.md', '发送方内容')
    const senderA = await ensureWorkspaceFile(sender.service, 'ws-1', 'a.md', '标题 A')
    const senderChinese = await ensureWorkspaceFile(sender.service, 'ws-1', '中文 文档.md', '中文标题')
    const pack = await sender.service.createPack({
      workspaceId: 'ws-1',
      name: '材料包',
      members: [senderA, senderChinese],
    })

    const receiver = makeWorkspace({ workspaceId: 'ws-2' })
    writeWorkspaceFile(receiver.workspace, 'a.md', '# receiver A\n')
    writeWorkspaceFile(receiver.workspace, '中文 文档.md', '接收方内容')

    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [pack.pack.id],
    })
    expect(exported.complete).toBe(true)
    expect(readZip(exported.bytes).map(entry => entry.name)).toEqual(['manifest.json'])

    const imported = await importPack({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: exported.bytes,
    })
    expect(imported.complete).toBe(true)
    expect(imported.packs[0]).toMatchObject({ name: '材料包', members: 2 })
    const library = await receiver.service.listClues('ws-2')
    expect(library.clues.map(clue => clue.title)).toEqual(['标题 A', '中文标题'])
    for (const clue of library.clues) {
      expect(clue.unresolved).toBeUndefined()
      expect(clue.locator.root).toMatchObject({ kind: 'workspace', workspaceId: 'ws-2' })
    }
    const a = library.clues.find(clue => clue.title === '标题 A')!
    const live = await receiver.service.read({ workspaceId: 'ws-2', clueId: a.id })
    expect(live.text).toBe('# receiver A\n')

    const preview = await previewImport({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: exported.bytes,
    })
    expect(preview.missingSources).toEqual([])
    expect(preview.items.every(item => !item.willBeUnresolved)).toBe(true)
    // Preview never wrote a second pack.
    expect((await receiver.service.listPacks('ws-2')).packs).toHaveLength(1)
  })

  it('keeps multiple packs sharing a clue ordered and de-duplicated', async () => {
    const sender = makeWorkspace()
    writeWorkspaceFile(sender.workspace, 'a.md', 'A')
    writeWorkspaceFile(sender.workspace, 'b.md', 'B')
    const a = await ensureWorkspaceFile(sender.service, 'ws-1', 'a.md', 'A')
    const b = await ensureWorkspaceFile(sender.service, 'ws-1', 'b.md', 'B')
    const first = await sender.service.createPack({ workspaceId: 'ws-1', name: 'First', members: [a, b] })
    const second = await sender.service.createPack({ workspaceId: 'ws-1', name: 'Second', members: [b] })
    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [first.pack.id, second.pack.id],
    })
    const receiver = makeWorkspace({ workspaceId: 'ws-2' })
    writeWorkspaceFile(receiver.workspace, 'a.md', 'A')
    writeWorkspaceFile(receiver.workspace, 'b.md', 'B')
    const imported = await importPack({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: exported.bytes,
    })
    expect(imported.clues).toHaveLength(2)
    const packs = (await receiver.service.listPacks('ws-2')).packs
    expect(packs.map(pack => pack.name)).toEqual(['First', 'Second'])
    expect(packs[0]!.members).toHaveLength(2)
    expect(packs[1]!.members).toEqual([packs[0]!.members[1]!])
    const preview = await previewExport({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [first.pack.id, second.pack.id],
    })
    expect(preview.totals).toMatchObject({ clues: 2, packs: 2 })
  })
})

describe('snapshot round-trip', () => {
  it('imports historical content that is readable offline next to a live reference', async () => {
    const sender = makeWorkspace()
    writeWorkspaceFile(sender.workspace, 'a.md', '# sender snapshot body\n')
    const clueId = await ensureWorkspaceFile(sender.service, 'ws-1', 'a.md', 'Snapshot source')
    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    expect(exported.complete).toBe(true)

    const receiver = makeWorkspace({ workspaceId: 'ws-2' })
    writeWorkspaceFile(receiver.workspace, 'a.md', '# receiver live body\n')
    const imported = await importPack({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: exported.bytes,
    })
    expect(imported.snapshots).toHaveLength(1)
    const receiverClue = (await receiver.service.listClues('ws-2')).clues[0]!
    const snapshot = await receiver.service.readSnapshot({
      workspaceId: 'ws-2',
      snapshotId: imported.snapshots[0]!.snapshotId,
    })
    expect(snapshot.meta.clueId).toBe(receiverClue.id)
    expect(snapshot.content).toMatchObject({ format: 'text/markdown', data: { text: '# sender snapshot body\n' } })
    expect(snapshot.meta.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(snapshot.meta.integrity).toBe('verified')
    const live = await receiver.service.read({ workspaceId: 'ws-2', clueId: receiverClue.id })
    expect(live.text).toBe('# receiver live body\n')
    // Importing never writes the snapshot back to the original resource.
    expect(readFileSync(join(sender.workspace, 'a.md'), 'utf8')).toBe('# sender snapshot body\n')
  })

  it('keeps the snapshot readable when the receiving side has no source at all', async () => {
    const sender = makeWorkspace()
    writeWorkspaceFile(sender.workspace, 'a.md', 'offline body')
    const clueId = await ensureWorkspaceFile(sender.service, 'ws-1', 'a.md', 'Offline source')
    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    const offline = makeWorkspace({ workspaceId: 'ws-3', withFiles: false })
    const imported = await importPack({ clues: offline.service }, {
      workspaceId: 'ws-3',
      bytes: exported.bytes,
    })
    expect(imported.clues[0]!.unresolved).toBe(true)
    const clue = (await offline.service.listClues('ws-3')).clues[0]!
    await expect(offline.service.read({ workspaceId: 'ws-3', clueId: clue.id }))
      .rejects.toMatchObject({ category: 'source-missing' })
    const snapshot = await offline.service.readSnapshot({
      workspaceId: 'ws-3',
      snapshotId: imported.snapshots[0]!.snapshotId,
    })
    expect(snapshot.content.data).toMatchObject({ text: 'offline body' })
    expect(imported.complete).toBe(true)
  })
})

describe('locator remapping and path dialects', () => {
  it('keeps an external absolute path unresolved unless the receiver remaps it', async () => {
    const sender = makeWorkspace()
    const externalPath = writeWorkspaceFile(sender.workspace, 'external.md', '# external\n')
    const externalLocator = { root: { kind: 'external' }, path: externalPath, dialect: HOST_DIALECT }
    const pack = buildLocatorPack({ locator: externalLocator, title: 'External clue' })

    const receiver = makeWorkspace({ workspaceId: 'ws-2' })
    const unresolved = await importPack({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: pack,
    })
    expect(unresolved.clues[0]!.unresolved).toBe(true)
    const clue = (await receiver.service.listClues('ws-2')).clues[0]!
    expect(clue.unresolved?.reason).toMatch(/remapping/i)

    const remappedWorkspace = makeWorkspace({ workspaceId: 'ws-4' })
    writeWorkspaceFile(remappedWorkspace.workspace, 'external.md', '# remapped\n')
    const remapped = await importPack({ clues: remappedWorkspace.service }, {
      workspaceId: 'ws-4',
      bytes: pack,
      remapLocator: ({ workspaceId }) => ({
        root: { kind: 'workspace', workspaceId },
        path: 'external.md',
        dialect: HOST_DIALECT,
      }),
    })
    expect(remapped.clues[0]!.unresolved).toBe(false)
    const remappedClue = (await remappedWorkspace.service.listClues('ws-4')).clues[0]!
    expect(remappedClue.locator).toMatchObject({
      root: { kind: 'workspace', workspaceId: 'ws-4' },
      path: 'external.md',
    })
    const live = await remappedWorkspace.service.read({ workspaceId: 'ws-4', clueId: remappedClue.id })
    expect(live.text).toBe('# remapped\n')
  })

  it('preserves a win32 workspace locator through the receiver remap', async () => {
    const receiver = makeWorkspace({ workspaceId: 'ws-2' })
    writeWorkspaceFile(receiver.workspace, 'docs/a.md', '# win path\n')
    const pack = buildLocatorPack({
      locator: {
        root: { kind: 'workspace', workspaceId: 'sender-workspace' },
        path: 'docs\\a.md',
        dialect: 'win32',
      },
      title: 'Win locator',
    })
    const imported = await importPack({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: pack,
    })
    expect(imported.clues[0]!.unresolved).toBe(false)
    const clue = (await receiver.service.listClues('ws-2')).clues[0]!
    expect(clue.locator).toMatchObject({
      root: { kind: 'workspace', workspaceId: 'ws-2' },
      path: 'docs\\a.md',
      dialect: 'win32',
    })
  })
})

describe('empty and partial packs', () => {
  it('round-trips an empty pack', async () => {
    const sender = makeWorkspace()
    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'references',
    })
    expect(exported.manifest.clues).toEqual([])
    const receiver = makeWorkspace({ workspaceId: 'ws-2' })
    const imported = await importPack({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: exported.bytes,
    })
    expect(imported).toMatchObject({ complete: true, partial: false })
    expect(imported.clues).toEqual([])
    expect(imported.packs).toEqual([])
  })

  it('imports a partial export with its issue list and no invented content', async () => {
    const sender = makeWorkspace()
    sender.service.registerSource({
      descriptor: {
        sourceId: 'test.failing',
        name: 'Failing source',
        order: 40,
        pluginId: 'plugin.failing',
        types: ['test.failing.doc'],
        transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: true },
      },
      types: [{
        typeId: 'test.failing.doc',
        sourceId: 'test.failing',
        formats: ['text/plain'],
        capabilities: { read: true, edit: false, concurrency: 'none' },
      }],
      operations: {
        async read() {
          throw new ClueError('auth-required', 'the source requires authorization')
        },
        async portable() {
          return { portable: true, locator: { id: 'secret-doc' } }
        },
        normalizeLocator(locator) {
          return { id: String(locator.id ?? '') }
        },
        locatorKey(locator) {
          return `id:${String(locator.id)}`
        },
      },
    })
    const clue = await sender.service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.failing',
      typeId: 'test.failing.doc',
      locator: { id: 'secret-doc' },
      title: '失败文档',
    })
    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clue.clue.id],
    })
    expect(exported.complete).toBe(false)
    expect(exported.issues[0]).toMatchObject({ category: 'auth-required' })

    const receiver = makeWorkspace({ workspaceId: 'ws-2' })
    const imported = await importPack({ clues: receiver.service }, {
      workspaceId: 'ws-2',
      bytes: exported.bytes,
    })
    expect(imported).toMatchObject({ complete: false, partial: true })
    expect(imported.clues[0]!.unresolved).toBe(true)
    expect(imported.snapshots).toEqual([])
    expect(imported.manifestIssues[0]).toMatchObject({ category: 'auth-required' })
    const library = await receiver.service.listClues('ws-2')
    expect(library.clues[0]!.title).toBe('失败文档')
    expect(library.clues[0]!.unresolved).toBeDefined()
  })
})

describe('receiver remapping fidelity', () => {
  it('persists the receiver-remapped locator so a later ensure reuses the same clue', async () => {
    const sender = makeWorkspace()
    writeWorkspaceFile(sender.workspace, 'a.md', '# sender A\n')
    const clueId = await ensureWorkspaceFile(sender.service, 'ws-1', 'a.md', '标题 A')
    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'references',
      clueIds: [clueId],
    })
    const offline = makeWorkspace({ workspaceId: 'ws-3', withFiles: false })
    const imported = await importPack({ clues: offline.service }, {
      workspaceId: 'ws-3',
      bytes: exported.bytes,
    })
    expect(imported.clues[0]!.unresolved).toBe(true)
    const row = (await offline.service.listClues('ws-3')).clues[0]!
    // The stored portable address is the RECEIVER's workspace root (ws-3),
    // never the sender's (ws-1): `ensure` dedupes an unresolved row by this
    // very locator, so keeping the sender form minted a second clue later.
    expect(row.unresolved?.portable).toMatchObject({
      portable: true,
      locator: {
        root: { kind: 'workspace', workspaceId: 'ws-3' },
        path: 'a.md',
        dialect: HOST_DIALECT,
      },
    })

    // The file source is re-mounted on the same store: ensuring the
    // RECEIVER address must resolve the SAME row instead of adding a clue.
    const reconnected = reopenWorkspace(offline, 'ws-3')
    const remapped = await reconnected.ensure({
      workspaceId: 'ws-3',
      sourceId: FILES,
      typeId: LOCAL_FILE_TYPE_IDS.markdown,
      locator: {
        root: { kind: 'workspace', workspaceId: 'ws-3' },
        path: 'a.md',
        dialect: HOST_DIALECT,
      },
      title: '标题 A',
    })
    expect(remapped.clue.id).toBe(row.id)
    expect(remapped.clue.unresolved).toBeUndefined()
    expect((await reconnected.listClues('ws-3')).clues).toHaveLength(1)
  })
})

describe('offline snapshot re-share', () => {
  it('re-exports an imported snapshot without the original source and keeps it readable', async () => {
    const sender = makeWorkspace()
    writeWorkspaceFile(sender.workspace, 'a.md', '# sender snapshot body\n')
    const clueId = await ensureWorkspaceFile(sender.service, 'ws-1', 'a.md', 'Snapshot source')
    const exported = await exportPack({ clues: sender.service, now: () => NOW }, {
      workspaceId: 'ws-1',
      mode: 'snapshot',
      clueIds: [clueId],
    })
    const offline = makeWorkspace({ workspaceId: 'ws-3', withFiles: false })
    const imported = await importPack({ clues: offline.service }, {
      workspaceId: 'ws-3',
      bytes: exported.bytes,
    })
    const offlineClue = (await offline.service.listClues('ws-3')).clues[0]!
    expect(offlineClue.unresolved).toBeDefined()
    expect(imported.snapshots).toHaveLength(1)
    const original = await offline.service.readSnapshot({
      workspaceId: 'ws-3',
      snapshotId: imported.snapshots[0]!.snapshotId,
    })

    // Re-share from the offline side: no source exists, only the snapshot.
    const reExported = await exportPack({ clues: offline.service, now: () => NOW }, {
      workspaceId: 'ws-3',
      mode: 'snapshot',
      clueIds: [offlineClue.id],
    })
    expect(reExported.complete).toBe(true)
    expect(reExported.stats.snapshots).toBe(1)
    expect(reExported.issues).toEqual([])

    const second = makeWorkspace({ workspaceId: 'ws-4', withFiles: false })
    const reimported = await importPack({ clues: second.service }, {
      workspaceId: 'ws-4',
      bytes: reExported.bytes,
    })
    expect(reimported.complete).toBe(true)
    expect(reimported.snapshots).toHaveLength(1)
    const record = await second.service.readSnapshot({
      workspaceId: 'ws-4',
      snapshotId: reimported.snapshots[0]!.snapshotId,
    })
    expect(record.meta.fetchedAt).toBe(original.meta.fetchedAt)
    expect(record.meta.format).toBe(original.meta.format)
    expect(record.meta.integrity).toBe('verified')
    expect(record.content).toMatchObject({
      format: original.content.format,
      data: original.content.data,
    })
  })
})
