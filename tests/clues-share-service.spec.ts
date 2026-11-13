/**
 * S7 integration surface: `installCluesShare` lifecycle and the raw route
 * handlers S9 mounts.
 *
 * The routes are the byte-carrying boundary: the fence runs first (403),
 * methods are POST-only (405), request bodies are bounded (413), and the
 * archive download carries an RFC 5987 disposition. The two preview methods
 * are available on the `clues.*` API seam and disappear with the mount's
 * disposer while the persisted clue library stays intact.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { ClueError, type CluePortableRef, type ClueReadResult } from '../src/clues/types.ts'
import {
  CLUES_SHARE_ROUTE_PATHS,
  DEFAULT_MAX_API_IMPORT_BYTES,
  cluepackDisposition,
  CLUES_SHARE_API_METHODS,
  createCluesShareExportProgressStore,
  createCluesShareImportProgressStore,
  createCluesShareRoutes,
  createCluesShareService,
  installCluesShare,
  type CluesShareService,
} from '../src/clues/share/index.ts'
import {
  CLUEPACK_FORMAT,
  CLUEPACK_MANIFEST_PATH,
  serializeCluepackManifest,
  type CluepackManifest,
} from '../src/clues/share/manifest.ts'
import { SAFE_FAILURE_REASONS } from '../src/clues/share/reasons.ts'
import { createZip, readZip } from '../src/clues/share/zip.ts'
import type {
  Context,
  SidebarHttpRequest,
  SidebarHttpResponse,
  SidebarWebRoute,
} from '../src/context-types.ts'
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
  /** Test-only: fire one response event (e.g. `close`). */
  emit(event: string): void
}

/** A minimal ServerResponse face. */
function fakeResponse(): FakeResponse {
  const events = new Map<string, Set<() => void>>()
  const res: FakeResponse = {
    statusCode: 0,
    headersSent: false,
    headers: {},
    chunks: [],
    ended: false,
    destroyed: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status
      res.headers = headers ?? {}
      res.headersSent = true
    },
    write(chunk: string | Uint8Array) {
      res.chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) res.chunks.push(Buffer.from(chunk))
      res.ended = true
    },
    destroy() {
      res.destroyed = true
    },
    once(event, listener) {
      const listeners = events.get(event) ?? new Set()
      listeners.add(listener)
      events.set(event, listeners)
    },
    off(event, listener) {
      events.get(event)?.delete(listener)
    },
    emit(event) {
      for (const listener of [...(events.get(event) ?? [])]) listener()
    },
  }
  return res
}

/** One minimal request face over an in-memory body. */
function fakeRequest(input: {
  url: string
  method?: string
  body?: Uint8Array | string
  headers?: Record<string, string>
}): SidebarHttpRequest {
  const body = input.body === undefined
    ? undefined
    : typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body)
  return {
    url: input.url,
    method: input.method ?? 'POST',
    headers: input.headers ?? {},
    async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
      if (body !== undefined) yield body
    },
  }
}

/** Parse one JSON response body. */
function jsonBody(res: FakeResponse): Record<string, unknown> {
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8')) as Record<string, unknown>
}

/** Call one route handler and return its response. */
async function call(
  route: SidebarWebRoute,
  input: { url: string; method?: string; body?: Uint8Array | string },
): Promise<FakeResponse> {
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
      sourceId: TEST_SOURCE,
      name: 'Share test source',
      order: 10,
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
        return source.read?.() ?? {
          format: 'text/plain',
          data: { text: 'hello' },
          text: 'hello',
          fetchedAt: NOW,
        }
      },
      async portable() {
        return source.portable?.() ?? { portable: true, locator: { id: 'a' } }
      },
      normalizeLocator(locator) {
        return { id: String(locator.id ?? '') }
      },
      locatorKey(locator) {
        return `id:${String(locator.id)}`
      },
    },
  }
  const service = createCluesService({
    root: join(base, 'store'),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
    resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
    builtinSources: [registration],
  })
  const clue = await service.ensure({
    workspaceId: 'ws-1',
    sourceId: TEST_SOURCE,
    typeId: TEST_TYPE,
    locator: { id: 'a' },
    title: '共享线索',
  })
  const pack = await service.createPack({
    workspaceId: 'ws-1',
    name: '中文包名',
    members: [clue.clue.id],
  })
  return { service, clueId: clue.clue.id, packId: pack.pack.id, cleanups: [], source }
}

/** A fake Cordis context that records effect disposers. */
function fakeContext(cleanups: Array<() => void>): Context {
  return {
    effect: (callback: () => void | (() => void)) => {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  } as unknown as Context
}

describe('installCluesShare', () => {
  it('registers the JSON-safe API methods and releases them on dispose', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    expect(f.service.hasApi('clues.share.exportPreview')).toBe(true)
    expect(f.service.hasApi('clues.share.exportInspect')).toBe(true)
    expect(f.service.hasApi('clues.share.exportProgress')).toBe(true)
    expect(f.service.hasApi('clues.share.importPreview')).toBe(true)
    expect(f.service.hasApi('clues.share.import')).toBe(true)
    expect(f.service.hasApi('clues.share.importProgress')).toBe(true)
    const preview = await f.service.invokeApi('clues.share.exportPreview', {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [f.packId],
    }) as { items: unknown[]; fileName: string }
    expect(preview.fileName).toBe('中文包名-20261017.cluepack')
    expect(preview.items).toHaveLength(1)

    // Spec §3: the confirmation surface must show what will be shared.
    const inspection = await f.service.invokeApi('clues.share.exportInspect', {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [f.packId],
    }) as { items: Array<{ portable: { portable: boolean; locator?: unknown } }>; sources: unknown[] }
    expect(inspection.items[0]!.portable).toMatchObject({ portable: true, locator: { id: 'a' } })
    expect(inspection.sources).toHaveLength(1)

    // An unknown export id reads as JSON null, not as an error.
    expect(await f.service.invokeApi('clues.share.exportProgress', { exportId: 'nope' })).toBeNull()

    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const importPreview = await f.service.invokeApi('clues.share.importPreview', {
      workspaceId: 'ws-1',
      archiveBase64: exported.bytes.toString('base64'),
    }) as { items: unknown[]; unresolvedCount: number }
    expect(importPreview.items).toHaveLength(1)
    expect(importPreview.unresolvedCount).toBe(0)

    // JSON import: the remap list travels in the body, so it is not capped by
    // the raw route's query-string length.
    const imported = await f.service.invokeApi('clues.share.import', {
      workspaceId: 'ws-1',
      archiveBase64: exported.bytes.toString('base64'),
      remap: [{ clueKey: 'clue-1', locator: { id: 'a' } }],
      importId: 'api-import-1',
    }) as { complete: boolean; clues: Array<{ created: boolean }> }
    expect(imported.complete).toBe(true)
    expect(imported.clues[0]!.created).toBe(false)
    const importStatus = await f.service.invokeApi('clues.share.importProgress', {
      importId: 'api-import-1',
    }) as { done: boolean; outcome: { complete: boolean; clues: number } }
    expect(importStatus).toMatchObject({ done: true, outcome: { complete: true, clues: 1 } })

    for (const cleanup of f.cleanups.splice(0)) cleanup()
    expect(f.service.hasApi('clues.share.exportPreview')).toBe(false)
    expect(f.service.hasApi('clues.share.exportInspect')).toBe(false)
    expect(f.service.hasApi('clues.share.exportProgress')).toBe(false)
    expect(f.service.hasApi('clues.share.importPreview')).toBe(false)
    expect(f.service.hasApi('clues.share.import')).toBe(false)
    expect(f.service.hasApi('clues.share.importProgress')).toBe(false)
    // Persisted data survives the unmount.
    expect((await f.service.listClues('ws-1')).clues).toHaveLength(1)
  })

  it('releases the registered APIs when the service itself is disposed', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    expect(f.service.hasApi('clues.share.exportPreview')).toBe(true)
    // Direct disposal (not only the mount effect) must release every method;
    // leaving them registered made them throw "no longer mounted" instead.
    share.dispose()
    expect(f.service.hasApi('clues.share.exportPreview')).toBe(false)
    expect(f.service.hasApi('clues.share.importPreview')).toBe(false)
    expect(f.service.hasApi('clues.share.import')).toBe(false)
    // A later effect cleanup is idempotent.
    for (const cleanup of f.cleanups.splice(0)) cleanup()
    expect(f.service.hasApi('clues.share.exportPreview')).toBe(false)
  })

  it('refuses an oversized base64 archive in the API preview', async () => {
    const f = await fixture()
    installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW, maxApiImportBytes: 8 })
    const bytes = Buffer.alloc(64)
    await expect(f.service.invokeApi('clues.share.importPreview', {
      workspaceId: 'ws-1',
      archiveBase64: bytes.toString('base64'),
    })).rejects.toMatchObject({ category: 'invalid-request' })
  })

  it('rejects malformed base64 explicitly instead of letting Buffer silently drop it', async () => {
    const f = await fixture()
    installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    await expect(f.service.invokeApi('clues.share.importPreview', {
      workspaceId: 'ws-1',
      // Not base64 at all. Buffer.from(..., 'base64') would decode it to
      // empty/garbage bytes and the ZIP parser would report the wrong error.
      archiveBase64: '!!!not base64!!!',
    })).rejects.toMatchObject({ category: 'invalid-request' })
  })

  it('advertises an API cap that is actually reachable through the dispatcher', () => {
    // The generic /sidebar/api dispatcher caps ordinary JSON bodies at 1 MiB,
    // so ~768 KiB decoded is the physical ceiling. The advertised cap must be
    // BELOW that ceiling, otherwise the method's own check is dead code and a
    // too-large archive dies on the dispatcher's generic body error instead
    // of the explicit "use the raw route" message.
    expect(DEFAULT_MAX_API_IMPORT_BYTES).toBe(512 * 1024)
    expect(DEFAULT_MAX_API_IMPORT_BYTES).toBeLessThan(Math.floor(((1 << 20) * 3) / 4))
  })

  it('rejects an archive above the default API cap with a pointer at the raw route', async () => {
    const f = await fixture()
    installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    await expect(f.service.invokeApi('clues.share.importPreview', {
      workspaceId: 'ws-1',
      archiveBase64: Buffer.alloc(DEFAULT_MAX_API_IMPORT_BYTES + 1).toString('base64'),
    })).rejects.toThrowError(/raw import route/i)
  })
})

describe('export progress store', () => {
  it('keeps the latest per-item event and does not leak stale keys', () => {
    const clock = 0
    const store = createCluesShareExportProgressStore({ now: () => clock, ttlMs: 1_000, maxEntries: 2 })
    store.record('exp-1', { phase: 'read', completed: 0, total: 2, key: 'clue-1', status: 'ok' })
    expect(store.read('exp-1')).toMatchObject({ phase: 'read', completed: 0, total: 2, key: 'clue-1' })
    store.record('exp-1', { phase: 'archive', completed: 2, total: 2 })
    expect(store.read('exp-1')).toMatchObject({ phase: 'archive', completed: 2 })
    expect(store.read('exp-1')!.key).toBeUndefined()
    expect(store.read('missing')).toBeUndefined()
  })

  it('never evicts or expires an in-flight entry, only settled ones', () => {
    let clock = 0
    const store = createCluesShareExportProgressStore({ now: () => clock, ttlMs: 1_000, maxEntries: 2 })
    store.record('a', { phase: 'collect', completed: 0, total: 1 })
    clock += 1
    store.record('b', { phase: 'collect', completed: 0, total: 1 })
    clock += 1
    store.record('c', { phase: 'collect', completed: 0, total: 1 })
    // AGENTS: keys with a live request are never evicted, even above the bound.
    expect(store.read('a')).toBeDefined()
    expect(store.read('b')).toBeDefined()
    expect(store.read('c')).toBeDefined()
    // TTL does not drop a task that is still running.
    clock += 5_000
    expect(store.read('a')).toBeDefined()
    expect(store.read('c')).toBeDefined()

    // Settle the two oldest; a new entry now evicts only those settled keys.
    store.fail('a', new Error('a failed'))
    store.fail('b', new Error('b failed'))
    store.record('d', { phase: 'collect', completed: 0, total: 1 })
    // Only one settled outcome fits next to the two active keys; the oldest
    // settled entry ('a') goes, while the newest ('b') stays pollable.
    expect(store.read('a')).toBeUndefined()
    expect(store.read('b')).toBeDefined()
    expect(store.read('c')).toBeDefined()
    expect(store.read('d')).toBeDefined()

    // Once 'c' settles it may expire; the active 'd' remains readable.
    store.fail('c', new Error('c failed'))
    clock += 1_000
    expect(store.read('b')).toBeUndefined()
    expect(store.read('c')).toBeUndefined()
    expect(store.read('d')).toBeDefined()
  })

  it('records the terminal outcome and failure of one export', () => {
    const clock = 0
    const store = createCluesShareExportProgressStore({ now: () => clock })
    store.record('ok', { phase: 'done', completed: 1, total: 1, status: 'ok' })
    store.finish('ok', {
      fileName: 'p.cluepack',
      bytes: Buffer.alloc(0),
      manifest: {} as never,
      mode: 'references',
      complete: false,
      issues: [{ target: 'clue', key: 'clue-1', reason: 'missing' }],
      stats: { clues: 1, packs: 0, sources: 1, snapshots: 0, bytes: 0 },
    })
    expect(store.read('ok')).toMatchObject({
      done: true,
      phase: 'done',
      outcome: {
        complete: false,
        fileName: 'p.cluepack',
        issues: [{ key: 'clue-1' }],
      },
    })
    store.fail('bad', new ClueError('cancelled', 'the clue pack export was cancelled'))
    expect(store.read('bad')).toMatchObject({
      done: true,
      failure: { category: 'cancelled', message: 'the clue pack export was cancelled' },
    })
  })
})

describe('import progress store', () => {
  it('records progress, the partial outcome and terminal failures', () => {
    let clock = 0
    const store = createCluesShareImportProgressStore({ now: () => clock, ttlMs: 1_000, maxEntries: 2 })
    store.record('imp-1', { phase: 'clue', completed: 0, total: 2, key: 'clue-1', status: 'ok' })
    expect(store.read('imp-1')).toMatchObject({ phase: 'clue', key: 'clue-1', done: false })
    store.finish('imp-1', {
      workspaceId: 'ws-1',
      mode: 'references',
      clues: [{ clueKey: 'clue-1', clueId: 'clue-1', title: 'X', created: true, unresolved: false }],
      packs: [],
      snapshots: [],
      issues: [{ target: 'clue', key: 'clue-1', category: 'failed', reason: 'snapshot failed' }],
      manifestIssues: [],
      complete: false,
      partial: true,
      cancelled: false,
      requiresAcceptance: true,
      reasons: ['snapshot failed'],
    })
    expect(store.read('imp-1')).toMatchObject({
      done: true,
      outcome: { complete: false, partial: true, requiresAcceptance: true, clues: 1 },
    })
    store.fail('imp-2', new ClueError('cancelled', 'the clue pack import was cancelled'))
    expect(store.read('imp-2')).toMatchObject({ done: true, failure: { category: 'cancelled' } })
    clock += 1_000
    expect(store.read('imp-1')).toBeUndefined()
  })
})

describe('createCluesShareRoutes', () => {
  it('returns the four exact paths for S9 registration', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    // Literal paths, not the implementation's own constants: a typo in
    // CLUES_SHARE_ROUTE_PATHS must fail this S9 contract test.
    expect(routes.routes.map(route => [route.kind, route.path])).toEqual([
      ['exact', '/sidebar/clues/share/export-preview'],
      ['exact', '/sidebar/clues/share/export'],
      ['exact', '/sidebar/clues/share/import-preview'],
      ['exact', '/sidebar/clues/share/import'],
    ])
  })

  it('applies the fence and the POST-only method guard to every route', async () => {
    const f = await fixture()
    const share: CluesShareService = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, req => req.headers['x-test-fence'] !== 'deny')
    for (const route of routes.routes) {
      const denied = fakeResponse()
      await route.handler(fakeRequest({ url: route.path, headers: { 'x-test-fence': 'deny' } }), denied)
      expect(denied.statusCode, route.path).toBe(403)
      const wrongMethod = fakeResponse()
      await route.handler(fakeRequest({ url: route.path, method: 'GET' }), wrongMethod)
      expect(wrongMethod.statusCode, route.path).toBe(405)
    }
  })

  it('serves the export preview as JSON', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    const res = await call(routes.exportPreview, {
      url: CLUES_SHARE_ROUTE_PATHS.exportPreview,
      body: JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] }),
    })
    expect(res.statusCode).toBe(200)
    const body = jsonBody(res) as { ok: boolean; value: { fileName: string; items: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.value.fileName).toBe('中文包名-20261017.cluepack')
    expect(body.value.items).toHaveLength(1)
  })

  it('downloads the archive with a UTF-8 disposition', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    const res = await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''")
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('中文包名-20261017.cluepack'))
    const entries = readZip(Buffer.concat(res.chunks))
    expect(entries.map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
  })

  it('serves import preview and import from raw ZIP bodies without writing on preview', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })

    const preview = await call(routes.importPreview, {
      url: `${CLUES_SHARE_ROUTE_PATHS.importPreview}?workspaceId=ws-1`,
      body: exported.bytes,
    })
    expect(preview.statusCode).toBe(200)
    const previewBody = jsonBody(preview) as { ok: boolean; value: { items: unknown[]; snapshotCount: number } }
    expect(previewBody.ok).toBe(true)
    expect(previewBody.value.items).toHaveLength(1)
    expect((await f.service.listClues('ws-1')).clues).toHaveLength(1)

    const imported = await call(routes.import, {
      url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=ws-1`,
      body: exported.bytes,
    })
    expect(imported.statusCode).toBe(200)
    const importBody = jsonBody(imported) as { ok: boolean; value: { complete: boolean; clues: Array<{ created: boolean }> } }
    expect(importBody.ok).toBe(true)
    expect(importBody.value.complete).toBe(true)
    expect(importBody.value.clues[0]!.created).toBe(false)
  })

  it('tracks a raw import with an importId and reports its terminal outcome', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const imported = await call(routes.import, {
      url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=ws-1&importId=import-route-1`,
      body: exported.bytes,
    })
    expect(imported.statusCode).toBe(200)
    const status = await f.service.invokeApi('clues.share.importProgress', {
      importId: 'import-route-1',
    }) as { done: boolean; outcome: { complete: boolean; clues: number; snapshots: number } }
    expect(status).toMatchObject({ done: true, outcome: { complete: true, clues: 1, snapshots: 0 } })

    const badId = await call(routes.import, {
      url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=ws-1&importId=not%20allowed!`,
      body: exported.bytes,
    })
    expect(badId.statusCode).toBe(400)
    expect(jsonBody(badId)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('forwards a response close to the import abort signal', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const before = await f.service.listClues('ws-1')
    const beforePacks = (await f.service.listPacks('ws-1')).packs.length
    const beforeSnapshots = (await f.service.listSnapshots('ws-1')).length
    const res = fakeResponse()
    const wrapped: CluesShareService = {
      ...share,
      importPack: async (params) => {
        res.emit('close')
        return share.importPack(params)
      },
    }
    const routes = createCluesShareRoutes(wrapped, () => true)
    await routes.import.handler(fakeRequest({
      url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=ws-1`,
      body: exported.bytes,
    }), res)
    // A canceled import before the first write keeps its typed envelope; the
    // body must not be reported as a successful import after a disconnect.
    expect(res.statusCode).toBe(499)
    expect(jsonBody(res)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const after = await f.service.listClues('ws-1')
    expect(after.clues).toHaveLength(1)
    expect(after.revision).toBe(before.revision)
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(beforePacks)
    expect(await f.service.listSnapshots('ws-1')).toHaveLength(beforeSnapshots)
  })

  it('cancels every raw route when the connection closes while the body is still arriving', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const before = await f.service.listClues('ws-1')
    const beforePacks = (await f.service.listPacks('ws-1')).packs.length
    const beforeSnapshots = (await f.service.listSnapshots('ws-1')).length

    const cases: Array<{
      route: SidebarWebRoute
      url: string
      body: Uint8Array | string
    }> = [
      {
        route: routes.exportPreview,
        url: CLUES_SHARE_ROUTE_PATHS.exportPreview,
        body: JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] }),
      },
      {
        route: routes.export,
        url: CLUES_SHARE_ROUTE_PATHS.export,
        body: JSON.stringify({ workspaceId: 'ws-1', mode: 'references', packIds: [f.packId] }),
      },
      {
        route: routes.importPreview,
        url: `${CLUES_SHARE_ROUTE_PATHS.importPreview}?workspaceId=ws-1`,
        body: exported.bytes,
      },
      {
        route: routes.import,
        url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=ws-1`,
        body: exported.bytes,
      },
    ]
    for (const item of cases) {
      const res = fakeResponse()
      const body = typeof item.body === 'string' ? Buffer.from(item.body) : Buffer.from(item.body)
      const request: SidebarHttpRequest = {
        url: item.url,
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
          // The connection closes BEFORE the body iterator finishes. The
          // route must already be listening, then re-check the signal after
          // the read and answer 499 instead of committing the import.
          res.emit('close')
          yield body
        },
      }
      await item.route.handler(request, res)
      expect(res.statusCode, item.route.path).toBe(499)
      expect(jsonBody(res), item.route.path).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    }
    const after = await f.service.listClues('ws-1')
    expect(after.revision).toBe(before.revision)
    expect((await f.service.listPacks('ws-1')).packs).toHaveLength(beforePacks)
    expect(await f.service.listSnapshots('ws-1')).toHaveLength(beforeSnapshots)
  })

  it('forwards an explicit JSON remap through the raw import route and the JSON preview API', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const remap = [{ clueKey: 'clue-1', locator: { id: 'b' } }]

    const preview = await f.service.invokeApi('clues.share.importPreview', {
      workspaceId: 'ws-1',
      archiveBase64: exported.bytes.toString('base64'),
      remap,
    }) as { items: Array<{ willBeUnresolved: boolean }> }
    expect(preview.items[0]!.willBeUnresolved).toBe(false)

    const imported = await call(routes.import, {
      url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=ws-1&remap=${encodeURIComponent(JSON.stringify(remap))}`,
      body: exported.bytes,
    })
    expect(imported.statusCode).toBe(200)
    const library = await f.service.listClues('ws-1')
    expect(library.clues.some(clue => (clue.locator as { id?: string }).id === 'b')).toBe(true)

    const malformed = await call(routes.importPreview, {
      url: `${CLUES_SHARE_ROUTE_PATHS.importPreview}?workspaceId=ws-1&remap=${encodeURIComponent('{')}`,
      body: exported.bytes,
    })
    expect(malformed.statusCode).toBe(400)
  })

  it('bounds the import body, requires workspaceId and rejects malformed JSON', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true, { maxImportBytes: 16 })
    const tooLarge = await call(routes.import, {
      url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=ws-1`,
      body: Buffer.alloc(64),
    })
    expect(tooLarge.statusCode).toBe(413)
    expect(jsonBody(tooLarge)).toMatchObject({ ok: false, error: { code: 'too-large' } })

    const missingWorkspace = await call(routes.importPreview, {
      url: CLUES_SHARE_ROUTE_PATHS.importPreview,
      body: Buffer.alloc(4),
    })
    expect(missingWorkspace.statusCode).toBe(400)

    const badJson = await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: '{',
    })
    expect(badJson.statusCode).toBe(400)
    expect(jsonBody(badJson)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('builds an RFC 5987 disposition with an ASCII fallback', () => {
    const disposition = cluepackDisposition('报告-20261017.cluepack')
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('报告-20261017.cluepack')}`)
    expect(disposition).toMatch(/filename="[^"]+\.cluepack"/)
    expect(cluepackDisposition('cluepack.cluepack')).toContain('filename="cluepack.cluepack"')
  })

  it('percent-encodes the RFC 5987 attr-char exclusions and never throws on a lone surrogate', () => {
    // encodeURIComponent leaves !'()* unescaped; RFC 5987's attr-char excludes
    // '()* (it allows ! and .). Those three are encoded; ! stays literal
    // because it is a legal attr-char.
    const disposition = cluepackDisposition("a'b(c)*!.cluepack")
    expect(disposition).toContain('filename*=UTF-8\'\'a%27b%28c%29%2A!.cluepack')
    expect(disposition).not.toMatch(/filename\*=UTF-8''[^;]*['()*]/)
    // A lone surrogate (a legal S1 pack name is arbitrary text within 200
    // code units) must not turn the download into a 500.
    expect(() => cluepackDisposition('a\uD800b.cluepack')).not.toThrow()
    expect(cluepackDisposition('a\uD800b.cluepack')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('ships the partial-state headers and a pollable outcome for the export route', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)

    const complete = await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: JSON.stringify({
        workspaceId: 'ws-1',
        mode: 'references',
        packIds: [f.packId],
        exportId: 'export-complete',
      }),
    })
    expect(complete.statusCode).toBe(200)
    expect(complete.headers['x-cluepack-complete']).toBe('true')
    expect(complete.headers['x-cluepack-issues']).toBe('0')
    expect(complete.headers['x-cluepack-clues']).toBe('1')
    expect(Number(complete.headers['content-length'])).toBe(Buffer.concat(complete.chunks).byteLength)
    const finished = await f.service.invokeApi('clues.share.exportProgress', {
      exportId: 'export-complete',
    }) as { done: boolean; outcome: { complete: boolean; fileName: string } }
    expect(finished).toMatchObject({ done: true, outcome: { complete: true } })

    // A snapshot read failure is a PARTIAL export: the browser must be able to
    // mark the download incomplete even though the ZIP body itself is normal.
    f.source.read = async () => {
      throw new ClueError('auth-required', 'the source requires authorization')
    }
    const partial = await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: JSON.stringify({
        workspaceId: 'ws-1',
        mode: 'snapshot',
        clueIds: [f.clueId],
        exportId: 'export-partial',
      }),
    })
    expect(partial.statusCode).toBe(200)
    expect(partial.headers['x-cluepack-complete']).toBe('false')
    expect(partial.headers['x-cluepack-issues']).toBe('1')
    const partialStatus = await f.service.invokeApi('clues.share.exportProgress', {
      exportId: 'export-partial',
    }) as { done: boolean; outcome: { complete: boolean; issues: Array<{ category: string }> } }
    expect(partialStatus).toMatchObject({
      done: true,
      outcome: { complete: false, issues: [{ category: 'auth-required' }] },
    })

    // A stale stored snapshot is a PARTIAL export too: the live read failed,
    // so the download header must not claim completeness just because bytes
    // were produced from the old snapshot.
    await f.service.putSnapshot('ws-1', {
      clueId: f.clueId,
      format: 'text/plain',
      fetchedAt: NOW,
      data: { text: 'old body' },
      text: 'old body',
    })
    const stale = await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: JSON.stringify({
        workspaceId: 'ws-1',
        mode: 'snapshot',
        clueIds: [f.clueId],
        exportId: 'export-stale',
      }),
    })
    expect(stale.statusCode).toBe(200)
    expect(stale.headers['x-cluepack-complete']).toBe('false')
    expect(stale.headers['x-cluepack-issues']).toBe('1')
    const staleStatus = await f.service.invokeApi('clues.share.exportProgress', {
      exportId: 'export-stale',
    }) as { done: boolean; outcome: { complete: boolean; issues: Array<{ category: string; reason: string }> } }
    expect(staleStatus).toMatchObject({
      done: true,
      outcome: { complete: false, issues: [{ category: 'auth-required' }] },
    })
    expect(staleStatus.outcome.issues[0]!.reason).toContain(NOW)

    // A failed export records a readable failure for the poller.
    await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: JSON.stringify({
        workspaceId: 'ws-1',
        mode: 'snapshot',
        clueIds: ['clue-missing'],
        exportId: 'export-failed',
      }),
    })
    const failed = await f.service.invokeApi('clues.share.exportProgress', {
      exportId: 'export-failed',
    }) as { done: boolean; failure: { category: string } }
    expect(failed).toMatchObject({ done: true, failure: { category: 'not-found' } })
  })

  it('rejects a malformed exportId and downloads an emoji pack name without a 500', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    const badId = await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: JSON.stringify({
        workspaceId: 'ws-1',
        mode: 'references',
        packIds: [f.packId],
        exportId: 'not allowed!',
      }),
    })
    expect(badId.statusCode).toBe(400)
    expect(jsonBody(badId)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    // S1 accepts this name (121 code units); the download must not 500 on a
    // surrogate pair truncated by a naive 100-code-unit slice.
    const emoji = await f.service.createPack({
      workspaceId: 'ws-1',
      name: 'a' + '😀'.repeat(60),
      members: [f.clueId],
    })
    const download = await call(routes.export, {
      url: CLUES_SHARE_ROUTE_PATHS.export,
      body: JSON.stringify({
        workspaceId: 'ws-1',
        mode: 'references',
        packIds: [emoji.pack.id],
      }),
    })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''")
    expect(download.headers['content-disposition']).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(readZip(Buffer.concat(download.chunks)).map(entry => entry.name)).toEqual([CLUEPACK_MANIFEST_PATH])
  })
})

describe('S1 storage failure messages', () => {
  it('never echoes the absolute store path through preview, route or progress', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-store-error-'))
    roots.push(base)
    const root = join(base, 'store')
    const workspaceId = 'ws-1'
    // A file where the store root directory is expected makes every read fail
    // with ENOTDIR naming the absolute path, which S1 wraps verbatim.
    writeFileSync(root, 'not a directory', 'utf8')
    let next = 0
    const service = createCluesService({ root, now: () => NOW, newId: kind => `${kind}-${++next}` })
    const share = createCluesShareService({ clues: service })
    const manifest: CluepackManifest = {
      formatVersion: 1,
      format: CLUEPACK_FORMAT,
      exportedAt: NOW,
      mode: 'references',
      sources: [{ key: 'source-1', sourceId: 'missing.source', typeIds: ['missing.source.doc'] }],
      clues: [{
        key: 'clue-1',
        sourceKey: 'source-1',
        typeId: 'missing.source.doc',
        title: 'X',
        portable: { portable: true, locator: { id: 'a' } },
      }],
      packs: [],
      issues: [],
    }
    const bytes = createZip([
      { name: CLUEPACK_MANIFEST_PATH, data: serializeCluepackManifest(manifest) },
    ])

    const previewFailure = await share.previewImport({ workspaceId, bytes })
      .then(() => undefined, (error: unknown) => error)
    expect(previewFailure).toMatchObject({ category: 'failed', message: SAFE_FAILURE_REASONS.failed })

    const routes = createCluesShareRoutes(share, () => true)
    const preview = await call(routes.importPreview, {
      url: `${CLUES_SHARE_ROUTE_PATHS.importPreview}?workspaceId=${workspaceId}`,
      body: bytes,
    })
    expect(preview.statusCode).toBe(500)
    const previewBody = jsonBody(preview) as { error: { message: string } }
    expect(previewBody.error.message).toBe(SAFE_FAILURE_REASONS.failed)
    expect(previewBody.error.message).not.toContain(root)

    const imported = await call(routes.import, {
      url: `${CLUES_SHARE_ROUTE_PATHS.import}?workspaceId=${workspaceId}&importId=imp-path`,
      body: bytes,
    })
    expect(imported.statusCode).toBe(500)
    const importedBody = jsonBody(imported) as { error: { message: string } }
    expect(importedBody.error.message).toBe(SAFE_FAILURE_REASONS.failed)
    expect(importedBody.error.message).not.toContain(root)
    expect(share.importProgress.read('imp-path')?.failure).toEqual({
      category: 'failed',
      message: SAFE_FAILURE_REASONS.failed,
    })
  })

  it('publishes the API method names S9 calls through the generic seam', () => {
    expect(Object.values(CLUES_SHARE_API_METHODS)).toEqual([
      'clues.share.exportPreview',
      'clues.share.exportInspect',
      'clues.share.exportProgress',
      'clues.share.importPreview',
      'clues.share.importProgress',
      'clues.share.import',
    ])
  })
})
