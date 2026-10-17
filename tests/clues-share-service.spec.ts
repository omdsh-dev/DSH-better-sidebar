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
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import {
  CLUES_SHARE_ROUTE_PATHS,
  cluepackDisposition,
  createCluesShareRoutes,
  installCluesShare,
  type CluesShareService,
} from '../src/clues/share/index.ts'
import { CLUEPACK_MANIFEST_PATH } from '../src/clues/share/manifest.ts'
import { readZip } from '../src/clues/share/zip.ts'
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
}

/** A minimal ServerResponse face. */
function fakeResponse(): FakeResponse {
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
}

/** A real service with one clue and one Chinese-named pack. */
async function fixture(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-share-service-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
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
        return { format: 'text/plain', data: { text: 'hello' }, text: 'hello', fetchedAt: NOW }
      },
      async portable() {
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
  return { service, clueId: clue.clue.id, packId: pack.pack.id, cleanups: [] }
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
    expect(f.service.hasApi('clues.share.importPreview')).toBe(true)
    const preview = await f.service.invokeApi('clues.share.exportPreview', {
      workspaceId: 'ws-1',
      mode: 'references',
      packIds: [f.packId],
    }) as { items: unknown[]; fileName: string }
    expect(preview.fileName).toBe('中文包名-20261017.cluepack')
    expect(preview.items).toHaveLength(1)

    const exported = await share.exportPack({ workspaceId: 'ws-1', mode: 'references', clueIds: [f.clueId] })
    const importPreview = await f.service.invokeApi('clues.share.importPreview', {
      workspaceId: 'ws-1',
      archiveBase64: exported.bytes.toString('base64'),
    }) as { items: unknown[]; unresolvedCount: number }
    expect(importPreview.items).toHaveLength(1)
    expect(importPreview.unresolvedCount).toBe(0)

    for (const cleanup of f.cleanups.splice(0)) cleanup()
    expect(f.service.hasApi('clues.share.exportPreview')).toBe(false)
    expect(f.service.hasApi('clues.share.importPreview')).toBe(false)
    // Persisted data survives the unmount.
    expect((await f.service.listClues('ws-1')).clues).toHaveLength(1)
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
})

describe('createCluesShareRoutes', () => {
  it('returns the four exact paths for S9 registration', async () => {
    const f = await fixture()
    const share = installCluesShare(fakeContext(f.cleanups), f.service, { now: () => NOW })
    const routes = createCluesShareRoutes(share, () => true)
    expect(routes.routes.map(route => [route.kind, route.path])).toEqual([
      ['exact', CLUES_SHARE_ROUTE_PATHS.exportPreview],
      ['exact', CLUES_SHARE_ROUTE_PATHS.export],
      ['exact', CLUES_SHARE_ROUTE_PATHS.importPreview],
      ['exact', CLUES_SHARE_ROUTE_PATHS.import],
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
})
