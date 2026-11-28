/**
 * S7 integration surface: `installCluesShare` lifecycle and the raw route
 * handlers S9 mounts. The routes are the byte-carrying boundary: the fence
 * runs first (403), methods are POST-only (405), request bodies are bounded
 * (413), and the archive download carries an RFC 5987 disposition. The two
 * preview methods are available on the `clues.*` API seam and disappear with
 * the mount's disposer while the persisted clue library stays intact.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { CluesStore } from '../src/clues/store.ts'
import { ClueError, type CluePortableRef, type ClueReadResult } from '../src/clues/types.ts'
import {
  CLUES_SHARE_ROUTE_PATHS, DEFAULT_MAX_API_IMPORT_BYTES, cluepackDisposition, CLUES_SHARE_API_METHODS,
  createCluesShareExportProgressStore, createCluesShareImportProgressStore, createCluesShareRoutes,
  createCluesShareService, installCluesShare, type CluesShareService,
} from '../src/clues/share/index.ts'
import { CLUEPACK_FORMAT, CLUEPACK_MANIFEST_PATH, serializeCluepackManifest, type CluepackManifest } from '../src/clues/share/manifest.ts'
import { SAFE_FAILURE_REASONS } from '../src/clues/share/reasons.ts'
import { createZip, readZip } from '../src/clues/share/zip.ts'
import type { Context, SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'
const NOW = '2026-10-17T00:00:00.000Z'
const TEST_SOURCE = 'test.share'
const TEST_TYPE = 'test.share.text'
const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})
interface FakeResponse extends SidebarHttpResponse {
  headers: Record<string, string>
  chunks: Buffer[]
  ended: boolean
  destroyed: boolean
  once(event: string, listener: () => void): void
  off(event: string, listener: () => void): void
  /** Test-only: fire one response event (e.g. 'close'). */
  emit(event: string): void
}
/** A minimal ServerResponse face. */
function fakeResponse(): FakeResponse {
  const events = new Map<string, Set<() => void>>()
  const res: FakeResponse = {
    statusCode: 0, headersSent: false, headers: {}, chunks: [], ended: false, destroyed: false,
    writeHead(status: number, headers?: Record<string, string>) { res.statusCode = status; res.headers = headers ?? {}; res.headersSent = true },
    write(chunk: string | Uint8Array) { res.chunks.push(Buffer.from(chunk)); return true },
    end(chunk?: string | Uint8Array) { if (chunk !== undefined) res.chunks.push(Buffer.from(chunk)); res.ended = true },
    destroy() { res.destroyed = true },
    once(event, listener) { const listeners = events.get(event) ?? new Set(); listeners.add(listener); events.set(event, listeners) },
    off(event, listener) { events.get(event)?.delete(listener) },
    emit(event) { for (const listener of [...(events.get(event) ?? [])]) listener() },
  }
  return res
}
/** One minimal request face over an in-memory body. */
function fakeRequest(input: { url: string; method?: string; body?: Uint8Array | string; headers?: Record<string, string> }): SidebarHttpRequest {
  const body = input.body === undefined ? undefined : Buffer.from(input.body)
  return {
    url: input.url, method: input.method ?? 'POST', headers: input.headers ?? {},
    async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> { if (body !== undefined) yield body },
  }
}
function jsonBody(res: FakeResponse): Record<string, unknown> {
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8')) as Record<string, unknown>
}
/** Call one route handler and return its response. */
async function call(route: SidebarWebRoute, input: { url: string; method?: string; body?: Uint8Array | string }): Promise<FakeResponse> {
  const res = fakeResponse()
  await route.handler(fakeRequest(input), res)
  return res
}
interface Fixture {
  service: CluesService
  clueId: string
  packId: string
  cleanups: Array<() => void>
  /** Mutable behavior of the test source (snapshot failures etc.). */
  source: { read?: () => Promise<ClueReadResult>; portable?: () => Promise<CluePortableRef> }
}
/** A real service with one clue and one Chinese-named pack. */
async function fixture(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-service-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
  const source: Fixture['source'] = {}
  const registration: ClueSourceRegistration = {
    descriptor: {
      sourceId: TEST_SOURCE, name: 'Share test source', order: 10, pluginId: 'plugin.test', types: [TEST_TYPE], transport: 'mcp',
      capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: true },
    },
    types: [{ typeId: TEST_TYPE, sourceId: TEST_SOURCE, formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations: {
      async read() { return source.read?.() ?? { format: 'text/plain', data: { text: 'hello' }, text: 'hello', fetchedAt: NOW } },
      async portable() { return source.portable?.() ?? { portable: true, locator: { id: 'a' } } },
      normalizeLocator(locator) { return { id: String(locator.id ?? '') } },
      locatorKey(locator) { return 'id:' + String(locator.id) },
    },
  }
  const service = createCluesService({
    root: join(base, 'store'), now: () => NOW, newId: kind => kind + '-' + (++next),
    resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined), builtinSources: [registration],
  })
  const clue = await service.ensure({ workspaceId: 'ws-1', sourceId: TEST_SOURCE, typeId: TEST_TYPE, locator: { id: 'a' }, title: '共享线索' })
  const pack = await service.createPack({ workspaceId: 'ws-1', name: '中文包名', members: [clue.clue.id] })
  return { service, clueId: clue.clue.id, packId: pack.pack.id, cleanups: [], source }
}
/** A fake Cordis context that records effect disposers. */
function fakeContext(cleanups: Array<() => void>): Context {
  return { effect: (callback: () => void | (() => void)) => { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup) } } as unknown as Context
}
async function mount(options: { fence?: (req: SidebarHttpRequest) => boolean; routeOptions?: { maxImportBytes?: number } } = {}) {
  const f = await fixture()
  const share: CluesShareService = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
  return { ...f, share, routes: createCluesShareRoutes(share, options.fence ?? (() => true), options.routeOptions) }
}
const API_METHODS = [
  'clues.share.exportPreview', 'clues.share.exportInspect', 'clues.share.exportProgress',
  'clues.share.importPreview', 'clues.share.importProgress', 'clues.share.import',
]

describe('installCluesShare', () => {
  it('registers the JSON-safe API methods and releases them on dispose', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    expect(API_METHODS.map(name => f.service.hasApi(name))).toEqual([true, true, true, true, true, true])
    const preview = await f.service.invokeApi('clues.share.exportPreview', { workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] }) as { items: unknown[]; fileName: string }
    expect(preview.fileName).toBe('中文包名-20261017.cluepack')
    expect(preview.items).toHaveLength(1)
    const inspection = await f.service.invokeApi('clues.share.exportInspect', { workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] }) as { items: Array<{ portable: { portable: boolean; locator?: unknown } }>; sources: unknown[] }
    expect(inspection.items[0]!.portable).toMatchObject({ portable: true, locator: { id: 'a' } })
    expect(inspection.sources).toHaveLength(1)
    expect(await f.service.invokeApi('clues.share.exportProgress', { exportId: 'nope' })).toBeNull()
    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const importPreview = await f.service.invokeApi('clues.share.importPreview', { workspaceId: 'ws-1', archiveBase64: exported.bytes.toString('base64') }) as { items: unknown[]; unresolvedCount: number }
    expect(importPreview).toMatchObject({ unresolvedCount: 0 })
    expect(importPreview.items).toHaveLength(1)
    const imported = await f.service.invokeApi('clues.share.import', {
      workspaceId: 'ws-1', archiveBase64: exported.bytes.toString('base64'),
      remap: [{ clueKey: 'clue-1', locator: { id: 'a' } }], importId: 'api-import-1',
    }) as { complete: boolean; clues: Array<{ created: boolean }> }
    expect(imported.complete).toBe(true)
    expect(imported.clues[0]!.created).toBe(false)
    expect(await f.service.invokeApi('clues.share.importProgress', { importId: 'api-import-1' }))
      .toMatchObject({ done: true, outcome: { complete: true, clues: 1 } })
    for (const cleanup of f.cleanups.splice(0)) cleanup()
    expect(API_METHODS.map(name => f.service.hasApi(name))).toEqual([false, false, false, false, false, false])
    // Direct disposal is idempotent after the mount effect; persisted data survives.
    share.dispose()
    expect(API_METHODS.map(name => f.service.hasApi(name))).toEqual([false, false, false, false, false, false])
    expect((await f.service.listClues('ws-1')).clues).toHaveLength(1)
  })
  it('rejects malformed base64 and archives above the API cap explicitly', async () => {
    const custom = await fixture()
    installCluesShare(fakeContext(custom.cleanups), custom.service, { now: () => NOW, maxApiImportBytes: 8 })
    await expect(custom.service.invokeApi('clues.share.importPreview', { workspaceId: 'ws-1', archiveBase64: Buffer.alloc(64).toString('base64') }))
      .rejects.toMatchObject({ category: 'invalid-request' })
    const f = await fixture()
    installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    await expect(f.service.invokeApi('clues.share.importPreview', { workspaceId: 'ws-1', archiveBase64: '!!!not base64!!!' }))
      .rejects.toMatchObject({ category: 'invalid-request' })
    await expect(f.service.invokeApi('clues.share.importPreview', { workspaceId: 'ws-1', archiveBase64: Buffer.alloc(DEFAULT_MAX_API_IMPORT_BYTES + 1).toString('base64') }))
      .rejects.toThrowError(/raw import route/i)
    // The generic /sidebar/api dispatcher caps JSON bodies at 1 MiB, so the
    // advertised cap must stay below that ceiling or its own check is dead code.
    expect(DEFAULT_MAX_API_IMPORT_BYTES).toBe(512 * 1024)
    expect(DEFAULT_MAX_API_IMPORT_BYTES).toBeLessThan(Math.floor(((1 << 20) * 3) / 4))
  })
})

describe('export progress store', () => {
  it('keeps the latest per-item event and does not leak stale keys', () => {
    const store = createCluesShareExportProgressStore({ now: () => 0, ttlMs: 1_000, maxEntries: 2 })
    store.record('exp-1', { phase: 'read', completed: 0, total: 2, key: 'clue-1', status: 'ok' })
    expect(store.read('exp-1')).toMatchObject({ phase: 'read', completed: 0, total: 2, key: 'clue-1' })
    store.record('exp-1', { phase: 'archive', completed: 2, total: 2 })
    expect(store.read('exp-1')).toMatchObject({ phase: 'archive', completed: 2 })
    expect(store.read('exp-1')!.key).toBeUndefined()
    expect(store.read('missing')).toBeUndefined()
    store.record('ok', { phase: 'done', completed: 1, total: 1, status: 'ok' })
    store.finish('ok', {
      fileName: 'p.cluepack', bytes: Buffer.alloc(0), manifest: {} as never, mode: 'references', complete: false,
      issues: [{ target: 'clue', key: 'clue-1', reason: 'missing' }],
      stats: { clues: 1, packs: 0, sources: 1, snapshots: 0, bytes: 0 },
    })
    expect(store.read('ok')).toMatchObject({ done: true, phase: 'done', outcome: { complete: false, fileName: 'p.cluepack', issues: [{ key: 'clue-1' }] } })
    store.fail('bad', new ClueError('cancelled', 'the clue pack export was cancelled'))
    expect(store.read('bad')).toMatchObject({ done: true, failure: { category: 'cancelled', message: 'the clue pack export was cancelled' } })
  })
  it('never evicts or expires an in-flight entry, only settled ones', () => {
    let clock = 0
    const store = createCluesShareExportProgressStore({ now: () => clock, ttlMs: 1_000, maxEntries: 2 })
    store.record('a', { phase: 'collect', completed: 0, total: 1 })
    clock += 1
    store.record('b', { phase: 'collect', completed: 0, total: 1 })
    clock += 1
    store.record('c', { phase: 'collect', completed: 0, total: 1 })
    expect(['a', 'b', 'c'].map(key => store.read(key) !== undefined)).toEqual([true, true, true])
    clock += 5_000
    expect(['a', 'c'].map(key => store.read(key) !== undefined)).toEqual([true, true])
    store.fail('a', new Error('a failed'))
    store.fail('b', new Error('b failed'))
    store.record('d', { phase: 'collect', completed: 0, total: 1 })
    expect(['a', 'b', 'c', 'd'].map(key => store.read(key) !== undefined)).toEqual([false, true, true, true])
    store.fail('c', new Error('c failed'))
    clock += 1_000
    expect(['b', 'c', 'd'].map(key => store.read(key) !== undefined)).toEqual([false, false, true])
  })
})

describe('import progress store', () => {
  it('records progress, the partial outcome and terminal failures', () => {
    let clock = 0
    const store = createCluesShareImportProgressStore({ now: () => clock, ttlMs: 1_000, maxEntries: 2 })
    store.record('imp-1', { phase: 'clue', completed: 0, total: 2, key: 'clue-1', status: 'ok' })
    expect(store.read('imp-1')).toMatchObject({ phase: 'clue', key: 'clue-1', done: false })
    store.finish('imp-1', {
      workspaceId: 'ws-1', mode: 'references',
      clues: [{ clueKey: 'clue-1', clueId: 'clue-1', title: 'X', created: true, unresolved: false }], packs: [], snapshots: [],
      issues: [{ target: 'clue', key: 'clue-1', category: 'failed', reason: 'snapshot failed' }], manifestIssues: [],
      complete: false, partial: true, cancelled: false, requiresAcceptance: true, reasons: ['snapshot failed'],
    })
    expect(store.read('imp-1')).toMatchObject({ done: true, outcome: { complete: false, partial: true, requiresAcceptance: true, clues: 1 } })
    store.fail('imp-2', new ClueError('cancelled', 'the clue pack import was cancelled'))
    expect(store.read('imp-2')).toMatchObject({ done: true, failure: { category: 'cancelled' } })
    clock += 1_000
    expect(store.read('imp-1')).toBeUndefined()
  })
})

describe('createCluesShareRoutes', () => {
  it('returns the four exact paths for S9 registration', async () => {
    const { share } = await mount()
    const routes = createCluesShareRoutes(share, () => true)
    expect(routes.routes.map(route => [route.kind, route.path])).toEqual([
      ['exact', '/sidebar/clues/share/export-preview'], ['exact', '/sidebar/clues/share/export'],
      ['exact', '/sidebar/clues/share/import-preview'], ['exact', '/sidebar/clues/share/import'],
    ])
  })
  it('applies the fence and the POST-only method guard to every route', async () => {
    const { routes } = await mount({ fence: req => req.headers['x-test-fence'] !== 'deny' })
    for (const route of routes.routes) {
      const denied = fakeResponse()
      await route.handler(fakeRequest({ url: route.path, headers: { 'x-test-fence': 'deny' } }), denied)
      expect(denied.statusCode, route.path).toBe(403)
      const wrongMethod = fakeResponse()
      await route.handler(fakeRequest({ url: route.path, method: 'GET' }), wrongMethod)
      expect(wrongMethod.statusCode, route.path).toBe(405)
    }
  })
  it('serves the export preview as JSON and downloads a UTF-8-disposition archive', async () => {
    const f = await mount()
    const body = JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] })
    const preview = await call(f.routes.exportPreview, { url: CLUES_SHARE_ROUTE_PATHS.exportPreview, body })
    expect(preview.statusCode).toBe(200)
    const previewBody = jsonBody(preview) as { ok: boolean; value: { fileName: string; items: unknown[] } }
    expect(previewBody.ok).toBe(true)
    expect(previewBody.value.fileName).toBe('中文包名-20261017.cluepack')
    expect(previewBody.value.items).toHaveLength(1)
    const res = await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''" + encodeURIComponent('中文包名-20261017.cluepack'))
    expect(readZip(Buffer.concat(res.chunks)).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
  })
  it('serves import preview and import from raw ZIP bodies without writing on preview', async () => {
    const f = await mount()
    const exported = await f.share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const preview = await call(f.routes.importPreview, { url: CLUES_SHARE_ROUTE_PATHS.importPreview + '?workspaceId=ws-1', body: exported.bytes })
    expect(preview.statusCode).toBe(200)
    expect(jsonBody(preview)).toMatchObject({ ok: true, value: { items: [expect.anything()], snapshotCount: 0 } })
    expect((await f.service.listClues('ws-1')).clues).toHaveLength(1)
    const imported = await call(f.routes.import, { url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1', body: exported.bytes })
    expect(imported.statusCode).toBe(200)
    expect(jsonBody(imported)).toMatchObject({ ok: true, value: { complete: true, clues: [{ created: false }] } })
  })
  it('tracks a raw import with an importId and reports its terminal outcome', async () => {
    const f = await mount()
    const exported = await f.share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const imported = await call(f.routes.import, { url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1&importId=import-route-1', body: exported.bytes })
    expect(imported.statusCode).toBe(200)
    expect(await f.service.invokeApi('clues.share.importProgress', { importId: 'import-route-1' }))
      .toMatchObject({ done: true, outcome: { complete: true, clues: 1, snapshots: 0 } })
    const badId = await call(f.routes.import, { url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1&importId=not%20allowed!', body: exported.bytes })
    expect(badId.statusCode).toBe(400)
    expect(jsonBody(badId)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })
  it('forwards a response close to the import abort signal', async () => {
    const f = await mount()
    const exported = await f.share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const before = await f.service.listClues('ws-1')
    const beforePacks = (await f.service.listPacks('ws-1')).packs.length
    const beforeSnapshots = (await f.service.listSnapshots('ws-1')).length
    const res = fakeResponse()
    const wrapped: CluesShareService = { ...f.share, importPack: async params => { res.emit('close'); return f.share.importPack(params) } }
    const routes = createCluesShareRoutes(wrapped, () => true)
    await routes.import.handler(fakeRequest({ url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1', body: exported.bytes }), res)
    expect(res.statusCode).toBe(499)
    expect(jsonBody(res)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const after = await f.service.listClues('ws-1')
    expect([after.clues.length, after.revision, (await f.service.listPacks('ws-1')).packs.length, await f.service.listSnapshots('ws-1').then(list => list.length)])
      .toEqual([1, before.revision, beforePacks, beforeSnapshots])
  })
  it('cancels every raw route when the connection closes while the body is still arriving', async () => {
    const f = await mount()
    const exported = await f.share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const before = await f.service.listClues('ws-1')
    const beforePacks = (await f.service.listPacks('ws-1')).packs.length
    const beforeSnapshots = (await f.service.listSnapshots('ws-1')).length
    const json = JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] })
    const cases: Array<{ route: SidebarWebRoute; url: string; body: Uint8Array | string }> = [
      { route: f.routes.exportPreview, url: CLUES_SHARE_ROUTE_PATHS.exportPreview, body: json },
      { route: f.routes.export, url: CLUES_SHARE_ROUTE_PATHS.export, body: json },
      { route: f.routes.importPreview, url: CLUES_SHARE_ROUTE_PATHS.importPreview + '?workspaceId=ws-1', body: exported.bytes },
      { route: f.routes.import, url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1', body: exported.bytes },
    ]
    for (const item of cases) {
      const res = fakeResponse()
      const body = Buffer.from(item.body)
      const request: SidebarHttpRequest = {
        url: item.url, method: 'POST', headers: {},
        async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
          // The connection closes BEFORE the body iterator finishes.
          res.emit('close')
          yield body
        },
      }
      await item.route.handler(request, res)
      expect(res.statusCode, item.route.path).toBe(499)
      expect(jsonBody(res), item.route.path).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    }
    const after = await f.service.listClues('ws-1')
    expect([after.revision, (await f.service.listPacks('ws-1')).packs.length, (await f.service.listSnapshots('ws-1')).length])
      .toEqual([before.revision, beforePacks, beforeSnapshots])
  })
  it('forwards an explicit JSON remap through the raw import route and the JSON preview API', async () => {
    const f = await mount()
    const exported = await f.share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const remap = [{ clueKey: 'clue-1', locator: { id: 'b' } }]
    const preview = await f.service.invokeApi('clues.share.importPreview', {
      workspaceId: 'ws-1', archiveBase64: exported.bytes.toString('base64'), remap,
    }) as { items: Array<{ willBeUnresolved: boolean }> }
    expect(preview.items[0]!.willBeUnresolved).toBe(false)
    const imported = await call(f.routes.import, { url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1&remap=' + encodeURIComponent(JSON.stringify(remap)), body: exported.bytes })
    expect(imported.statusCode).toBe(200)
    expect((await f.service.listClues('ws-1')).clues.some(clue => (clue.locator as { id?: string }).id === 'b')).toBe(true)
    const malformed = await call(f.routes.importPreview, { url: CLUES_SHARE_ROUTE_PATHS.importPreview + '?workspaceId=ws-1&remap=' + encodeURIComponent('{'), body: exported.bytes })
    expect(malformed.statusCode).toBe(400)
  })
  it('bounds the import body, requires workspaceId and rejects malformed JSON', async () => {
    const f = await mount({ routeOptions: { maxImportBytes: 16 } })
    const tooLarge = await call(f.routes.import, { url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1', body: Buffer.alloc(64) })
    expect(tooLarge.statusCode).toBe(413)
    expect(jsonBody(tooLarge)).toMatchObject({ ok: false, error: { code: 'too-large' } })
    const missingWorkspace = await call(f.routes.importPreview, { url: CLUES_SHARE_ROUTE_PATHS.importPreview, body: Buffer.alloc(4) })
    expect(missingWorkspace.statusCode).toBe(400)
    const badJson = await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body: '{' })
    expect(badJson.statusCode).toBe(400)
    expect(jsonBody(badJson)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
  it('builds an RFC 5987 disposition with an ASCII fallback', () => {
    const disposition = cluepackDisposition('报告-20261017.cluepack')
    expect(disposition).toContain("filename*=UTF-8''" + encodeURIComponent('报告-20261017.cluepack'))
    expect(disposition).toMatch(/filename="[^"]+\.cluepack"/)
    expect(cluepackDisposition('cluepack.cluepack')).toContain('filename="cluepack.cluepack"')
    // encodeURIComponent leaves !'()* unescaped; RFC 5987's attr-char excludes
    // only '()*; a lone surrogate must never turn the download into a 500.
    const attr = cluepackDisposition("a'b(c)*!.cluepack")
    expect(attr).toContain("filename*=UTF-8''a%27b%28c%29%2A!.cluepack")
    expect(attr).not.toMatch(/filename\*=UTF-8''[^;]*['()*]/)
    expect(cluepackDisposition('a\uD800b.cluepack')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
  it('ships the partial-state headers and a pollable outcome for the export route', async () => {
    const f = await mount()
    const complete = await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body: JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId], exportId: 'export-complete' }) })
    expect(complete.statusCode).toBe(200)
    expect([complete.headers['x-cluepack-complete'], complete.headers['x-cluepack-issues'], complete.headers['x-cluepack-clues']]).toEqual(['true', '0', '1'])
    expect(Number(complete.headers['content-length'])).toBe(Buffer.concat(complete.chunks).byteLength)
    expect(await f.service.invokeApi('clues.share.exportProgress', { exportId: 'export-complete' })).toMatchObject({ done: true, outcome: { complete: true } })
    f.source.read = async () => { throw new ClueError('auth-required', 'the source requires authorization') }
    const partial = await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body: JSON.stringify({ workspaceId: 'ws-1', mode: 'snapshot', clueIds: [f.clueId], exportId: 'export-partial' }) })
    expect(partial.statusCode).toBe(200)
    expect([partial.headers['x-cluepack-complete'], partial.headers['x-cluepack-issues']]).toEqual(['false', '1'])
    expect(await f.service.invokeApi('clues.share.exportProgress', { exportId: 'export-partial' }))
      .toMatchObject({ done: true, outcome: { complete: false, issues: [{ category: 'auth-required' }] } })
    await f.service.putSnapshot('ws-1', { clueId: f.clueId, format: 'text/plain', fetchedAt: NOW, data: { text: 'old body' }, text: 'old body' })
    const stale = await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body: JSON.stringify({ workspaceId: 'ws-1', mode: 'snapshot', clueIds: [f.clueId], exportId: 'export-stale' }) })
    expect([stale.headers['x-cluepack-complete'], stale.headers['x-cluepack-issues']]).toEqual(['false', '1'])
    const staleStatus = await f.service.invokeApi('clues.share.exportProgress', { exportId: 'export-stale' }) as { done: boolean; outcome: { complete: boolean; issues: Array<{ category: string; reason: string }> } }
    expect(staleStatus).toMatchObject({ done: true, outcome: { complete: false, issues: [{ category: 'auth-required' }] } })
    expect(staleStatus.outcome.issues[0]!.reason).toContain(NOW)
    // A failed export records a readable failure for the poller.
    await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body: JSON.stringify({ workspaceId: 'ws-1', mode: 'snapshot', clueIds: ['clue-missing'], exportId: 'export-failed' }) })
    expect(await f.service.invokeApi('clues.share.exportProgress', { exportId: 'export-failed' })).toMatchObject({ done: true, failure: { category: 'not-found' } })
  })
  it('rejects a malformed exportId and downloads an emoji pack name without a 500', async () => {
    const f = await mount()
    const badId = await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body: JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId], exportId: 'not allowed!' }) })
    expect(badId.statusCode).toBe(400)
    expect(jsonBody(badId)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    // S1 accepts this 121-code-unit name; a naive 100-unit slice must not 500.
    const emoji = await f.service.createPack({ workspaceId: 'ws-1', name: 'a' + '😀'.repeat(60), members: [f.clueId] })
    const download = await call(f.routes.export, { url: CLUES_SHARE_ROUTE_PATHS.export, body: JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [emoji.pack.id] }) })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''")
    expect(download.headers['content-disposition']).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(readZip(Buffer.concat(download.chunks)).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
  })
})

describe('S1 storage failure messages', () => {
  it('distinguishes a fresh store from a path blocked by a file', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-store-'))
    roots.push(base)
    const root = join(base, 'store')
    const store = new CluesStore({ root })
    await expect(store.read('ws-1')).resolves.toMatchObject({ revision: 0, clues: [] })
    await expect(store.listSnapshots('ws-1')).resolves.toEqual([])
    await expect(store.readSnapshotMeta('ws-1', 'missing')).rejects.toMatchObject({ category: 'not-found' })
    expect(existsSync(root)).toBe(false)

    writeFileSync(root, 'not a directory')
    await expect(store.read('ws-1')).rejects.toMatchObject({ category: 'failed' })
    await expect(store.listSnapshots('ws-1')).rejects.toMatchObject({ category: 'failed' })
    await expect(store.readSnapshotMeta('ws-1', 'missing')).rejects.toMatchObject({ category: 'failed' })
  })
  it('never echoes the absolute store path through preview, route or progress', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-store-error-'))
    roots.push(base)
    const root = join(base, 'store')
    // The underlying filesystem error may include the absolute store path.
    writeFileSync(root, 'not a directory', 'utf8')
    let next = 0
    const service = createCluesService({ root, now: () => NOW, newId: kind => kind + '-' + (++next) })
    const share = createCluesShareService({ clues: service })
    const manifest: CluepackManifest = {
      formatVersion: 1, format: CLUEPACK_FORMAT, exportedAt: NOW, mode: 'references',
      sources: [{ key: 'source-1', sourceId: 'missing.source', typeIds: ['missing.source.doc'] }],
      clues: [{ key: 'clue-1', sourceKey: 'source-1', typeId: 'missing.source.doc', title: 'X', portable: { portable: true, locator: { id: 'a' } } }],
      packs: [], issues: [],
    }
    const bytes = createZip([{ name: CLUEPACK_MANIFEST_PATH, data: serializeCluepackManifest(manifest) }])
    await expect(share.previewImport({ workspaceId: 'ws-1', bytes })).rejects.toMatchObject({ category: 'failed', message: SAFE_FAILURE_REASONS.failed })
    const routes = createCluesShareRoutes(share, () => true)
    const preview = await call(routes.importPreview, { url: CLUES_SHARE_ROUTE_PATHS.importPreview + '?workspaceId=ws-1', body: bytes })
    expect(preview.statusCode).toBe(500)
    expect(jsonBody(preview)).toMatchObject({ error: { message: SAFE_FAILURE_REASONS.failed } })
    expect((jsonBody(preview) as { error: { message: string } }).error.message).not.toContain(root)
    const imported = await call(routes.import, { url: CLUES_SHARE_ROUTE_PATHS.import + '?workspaceId=ws-1&importId=imp-path', body: bytes })
    expect(imported.statusCode).toBe(500)
    expect((jsonBody(imported) as { error: { message: string } }).error.message).not.toContain(root)
    expect(share.importProgress.read('imp-path')?.failure).toEqual({ category: 'failed', message: SAFE_FAILURE_REASONS.failed })
  })
  it('publishes the API method names S9 calls through the generic seam', () => {
    expect(Object.values(CLUES_SHARE_API_METHODS)).toEqual(API_METHODS)
  })
})
