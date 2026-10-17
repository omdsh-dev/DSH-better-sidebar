/**
 * S1 clue API surface: payload validation, fixed caller/abort forwarding, and
 * the host dispatcher fallback.
 *
 * Two layers are pinned here:
 * - the handlers themselves (`registerCluesApi`): every S1 method is claimed,
 *   malformed payloads fail as typed `ClueError`s before reaching a source or
 *   the store, the caller is always `'ui'` and the request signal is forwarded;
 * - the ONE `/sidebar/api` dispatcher fallback (`apply`): an unknown method
 *   owned by the clue service is served through `invokeApi` on the existing
 *   fenced route — no second route, and an actually unknown method still
 *   answers 404.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { installClues } from '../src/clues/index.ts'
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import { createLocalFileSource, LOCAL_FILE_TYPE_IDS } from '../src/clues/local-files.ts'
import { CLUES_API_METHODS, registerCluesApi } from '../src/clues/api.ts'
import { ClueError, type ClueCandidate } from '../src/clues/types.ts'
import type { SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

/** The host platform's own path dialect (workspace locators are created in it). */
const HOST_DIALECT = process.platform === 'win32' ? 'win32' : 'posix'

/** A temp base with a workspace + durable store. */
function fixture(): { base: string; workspace: string; service: CluesService } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-api-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let next = 0
  const service = createCluesService({
    root: join(base, 'store'),
    now: () => '2026-10-17T00:00:00.000Z',
    newId: kind => `${kind}-${++next}`,
    builtinSources: [createLocalFileSource()],
    resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
  })
  return { base, workspace, service }
}

describe('clue API handlers', () => {
  it('claims every documented S1 method and releases them on dispose', () => {
    const { service } = fixture()
    const dispose = registerCluesApi(service)
    for (const method of CLUES_API_METHODS) expect(service.hasApi(method), method).toBe(true)
    dispose()
    for (const method of CLUES_API_METHODS) expect(service.hasApi(method), method).toBe(false)
  })

  it('answers the source catalogue with serializable descriptors and type rows', async () => {
    const { service } = fixture()
    registerCluesApi(service)
    const result = await service.invokeApi('clues.sources', {})
    expect(result).toMatchObject({
      sources: [{
        sourceId: 'builtin.files',
        transport: 'files',
        types: ['builtin.files.markdown', 'builtin.files.text', 'builtin.files.binary'],
      }],
    })
    expect((result as { types: unknown[] }).types).toHaveLength(3)
  })

  it('dispatches list/ensure/read/clues through the wire payloads', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# hello\n')
    registerCluesApi(service)

    const listing = await service.invokeApi('clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files' }) as {
      items: ClueCandidate[]
    }
    expect(listing.items.map(item => item.title)).toEqual(['a.md'])

    const ensured = await service.invokeApi('clues.ensure', {
      workspaceId: 'ws-1',
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.markdown,
      locator: listing.items[0]!.locator,
      title: 'a.md',
    }) as { clue: { id: string }; created: boolean }
    expect(ensured.created).toBe(true)

    const read = await service.invokeApi('clues.read', { workspaceId: 'ws-1', clueId: ensured.clue.id }) as {
      format: string
      text: string
    }
    expect(read).toMatchObject({ format: 'text/markdown', text: '# hello\n' })

    const library = await service.invokeApi('clues.clues', { workspaceId: 'ws-1' }) as { clues: unknown[] }
    expect(library.clues).toHaveLength(1)
  })

  it('serves pins, packs, bindings and snapshots on the same payload shapes', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.txt'), 'a\n')
    registerCluesApi(service)
    const ensured = await service.invokeApi('clues.ensure', {
      workspaceId: 'ws-1',
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.text,
      locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'a.txt', dialect: HOST_DIALECT },
      title: 'a.txt',
    }) as { clue: { id: string } }
    const clueId = ensured.clue.id

    const pinned = await service.invokeApi('clues.pins.add', { workspaceId: 'ws-1', clueId }) as { pins: unknown[] }
    expect(pinned.pins).toHaveLength(1)
    expect(await service.invokeApi('clues.pins.remove', { workspaceId: 'ws-1', clueId }))
      .toMatchObject({ pins: [] })

    const pack = await service.invokeApi('clues.packs.create', {
      workspaceId: 'ws-1',
      name: 'Pack',
      members: [clueId],
    }) as { pack: { id: string; members: string[] } }
    expect(pack.pack.members).toEqual([clueId])
    expect(await service.invokeApi('clues.packs.rename', {
      workspaceId: 'ws-1',
      packId: pack.pack.id,
      name: 'Renamed',
    })).toMatchObject({ pack: { name: 'Renamed' } })
    expect(await service.invokeApi('clues.packs.removeMember', {
      workspaceId: 'ws-1',
      packId: pack.pack.id,
      clueId,
    })).toMatchObject({ pack: { members: [] } })
    expect(await service.invokeApi('clues.packs.delete', { workspaceId: 'ws-1', packId: pack.pack.id }))
      .toMatchObject({ deleted: true, packs: [] })

    const binding = await service.invokeApi('clues.bindings.add', {
      workspaceId: 'ws-1',
      target: { kind: 'clue', clueId },
    }) as { bindings: unknown[] }
    expect(binding.bindings).toHaveLength(1)
    expect(await service.invokeApi('clues.bindings.remove', {
      workspaceId: 'ws-1',
      target: { kind: 'clue', clueId },
    })).toMatchObject({ bindings: [] })

    await service.invokeApi('clues.snapshots.read', { workspaceId: 'ws-1', snapshotId: 'missing' })
      .then(() => { throw new Error('expected a failure') }, (error: unknown) => {
        expect(error).toMatchObject({ category: 'not-found' })
      })
  })

  it('rejects malformed payloads as typed clue failures before dispatching', async () => {
    const { service } = fixture()
    registerCluesApi(service)
    const cases: Array<[string, unknown]> = [
      ['clues.resolve', {}],
      ['clues.resolve', null],
      ['clues.resolve', { workspaceId: 'ws-1' }],
      ['clues.resolve', { workspaceId: 'ws-1', text: '   ' }],
      ['clues.list', []],
      ['clues.list', { workspaceId: 'ws-1', sourceId: 7 }],
      ['clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files', limit: 0 }],
      ['clues.search', { workspaceId: 'ws-1', sourceId: 'builtin.files' }],
      ['clues.read', { workspaceId: 'ws-1' }],
      ['clues.loadEdit', { workspaceId: 'ws-1', clueId: 1 }],
      ['clues.saveEdit', { workspaceId: 'ws-1', clueId: 'c' }],
      ['clues.portable', { workspaceId: 'ws-1' }],
      ['clues.ensure', { workspaceId: 'ws-1', sourceId: 'builtin.files', typeId: 'builtin.files.text', title: 'x' }],
      ['clues.ensure', {
        workspaceId: 'ws-1',
        sourceId: 'builtin.files',
        typeId: 'builtin.files.text',
        locator: 'nope',
        title: 'x',
      }],
      ['clues.pins.add', { workspaceId: 'ws-1' }],
      ['clues.pins.remove', { workspaceId: 'ws-1', clueId: 7 }],
      ['clues.packs.create', { workspaceId: 'ws-1', name: 'x', members: 'nope' }],
      ['clues.packs.create', { workspaceId: 'ws-1', name: 'x', expectedRevision: -1 }],
      ['clues.packs.rename', { workspaceId: 'ws-1', packId: 'p' }],
      ['clues.packs.addMember', { workspaceId: 'ws-1', packId: 'p' }],
      ['clues.packs.removeMember', { workspaceId: 'ws-1', packId: 'p', clueId: 'c', expectedRevision: 1.5 }],
      ['clues.packs.delete', { workspaceId: 'ws-1' }],
      ['clues.bindings.list', {}],
      ['clues.bindings.add', { workspaceId: 'ws-1' }],
      ['clues.bindings.add', { workspaceId: 'ws-1', target: { kind: 'nope' } }],
      ['clues.bindings.remove', { workspaceId: 'ws-1', target: { kind: 'clue' } }],
      ['clues.snapshots.list', { workspaceId: '' }],
      ['clues.snapshots.read', { workspaceId: 'ws-1' }],
    ]
    for (const [method, payload] of cases) {
      const failure: unknown = await service.invokeApi(method, payload).then(() => undefined, (error: unknown) => error)
      expect(failure, `${method} ${JSON.stringify(payload)}`).toBeInstanceOf(ClueError)
      expect((failure as ClueError).category, method).toBe('invalid-request')
    }
  })

  it('fixes the caller to "ui" and forwards the abort signal to the source', async () => {
    const { service } = fixture()
    const seen: Array<{ caller: string; hasSignal: boolean }> = []
    service.registerSource({
      descriptor: {
        sourceId: 'test.caller',
        name: 'caller test',
        order: 10,
        pluginId: 'test',
        types: ['test.caller.text'],
        transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false },
      },
      types: [{
        typeId: 'test.caller.text',
        sourceId: 'test.caller',
        formats: ['text/plain'],
        capabilities: { read: true, edit: false },
      }],
      operations: {
        async read(_input, context) {
          seen.push({ caller: context.caller, hasSignal: context.signal !== undefined })
          return { format: 'text/plain', data: { text: 'x' }, fetchedAt: 'now' }
        },
      },
    })
    registerCluesApi(service)
    const controller = new AbortController()
    await service.invokeApi('clues.read', {
      workspaceId: 'ws-1',
      sourceId: 'test.caller',
      typeId: 'test.caller.text',
      locator: { id: 'x' },
    }, { caller: 'ui', signal: controller.signal })
    expect(seen).toEqual([{ caller: 'ui', hasSignal: true }])
  })

  it('normalizes a source failure to its clue category on the wire seam', async () => {
    const { service } = fixture()
    service.registerSource({
      descriptor: {
        sourceId: 'test.fail',
        name: 'fail',
        order: 10,
        pluginId: 'test',
        types: ['test.fail.text'],
        transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false },
      },
      types: [{
        typeId: 'test.fail.text',
        sourceId: 'test.fail',
        formats: ['text/plain'],
        capabilities: { read: true, edit: false },
      }],
      operations: {
        async read() {
          throw new Error('Authorization: Bearer top-secret')
        },
      },
    })
    registerCluesApi(service)
    const failure: unknown = await service.invokeApi('clues.read', {
      workspaceId: 'ws-1',
      sourceId: 'test.fail',
      typeId: 'test.fail.text',
      locator: { id: 'x' },
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ClueError)
    expect((failure as ClueError).category).toBe('failed')
    expect((failure as ClueError).message).not.toContain('top-secret')
  })

  it('normalizes registered API handler failures and preserves intentional categories', async () => {
    const { service } = fixture()
    service.registerApi('test.leak', () => {
      throw new Error('Authorization: Bearer top-secret-token; stdout: command failed')
    })
    service.registerApi('test.auth', () => {
      throw new ClueError('auth-required', 'sign in first')
    })

    const leaked: unknown = await service.invokeApi('test.leak', {})
      .then(() => undefined, (error: unknown) => error)
    expect(leaked).toBeInstanceOf(ClueError)
    expect((leaked as ClueError).category).toBe('failed')
    expect((leaked as ClueError).message).not.toContain('top-secret')
    expect((leaked as ClueError).message).not.toContain('stdout')

    // A handler that raises a real ClueError keeps its category (the fixed
    // categories are the contract external sources express).
    await expect(service.invokeApi('test.auth', {})).rejects.toMatchObject({
      category: 'auth-required',
      message: 'sign in first',
    })
  })
})

/** One structural fake of the host context the `/sidebar/api` dispatcher needs. */
interface FakeContext {
  connection: { requestRejection: () => undefined }
  webServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: () => () => void
  }
  sessions: { get: () => undefined }
  tools: unknown
  effect: (fn: () => void | (() => void), label?: string) => void
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
  on: () => () => void
  get: (key: string) => unknown
  provide: (name: string, value?: unknown) => void
  profileContext: { home: string }
  workspaceRegistry: { get: (id: string) => { path: string } | undefined }
  logger: { warn: () => void; info: () => void }
}

/** One captured response of the `/sidebar/api` route. */
interface CapturedResponse {
  status: number
  body: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

/** POST one method through a captured route and return the decoded envelope. */
async function post(route: SidebarWebRoute, method: string, payload: unknown): Promise<CapturedResponse> {
  const body = JSON.stringify(payload)
  const req = {
    url: `/sidebar/api/${method}`,
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      yield Buffer.from(body)
    },
  } as unknown as SidebarHttpRequest
  let status = 0
  let raw = ''
  const res = {
    statusCode: 0,
    headersSent: false,
    writeHead(code: number) { status = code; res.statusCode = code; res.headersSent = true },
    write() { return true },
    end(chunk?: string | Uint8Array) { raw += chunk === undefined ? '' : String(chunk) },
    destroy() { /* no socket in the fixture */ },
    // The dispatcher attaches a close listener only for cancellable methods
    // (clues.* included); the fixture has no socket to close.
    once() { /* no-op */ },
    off() { /* no-op */ },
  }
  await route.handler(req, res as unknown as SidebarHttpResponse)
  return { status, body: JSON.parse(raw) as CapturedResponse['body'] }
}

describe('installClues dependency lifecycle', () => {
  it('uses a workspaceRegistry that arrives AFTER install on the first operation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-clues-late-registry-'))
    roots.push(base)
    const home = join(base, 'home')
    const workspace = join(base, 'workspace')
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.md'), '# late\n')

    // At install time the registry is not there yet: the plugin must still
    // install (dependencies arrive later in Cordis), and every operation must
    // re-read the service instead of snapshotting it at install.
    let registry: { get(id: string): { path?: string } | undefined } | undefined
    const cleanups: Array<() => void> = []
    const ctx = {
      profileContext: { home },
      logger: { warn: () => {} },
      get: (key: string) => (key === 'workspaceRegistry' ? registry : undefined),
      effect: (fn: () => void | (() => void)) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
    }
    const service = installClues(ctx as never)
    try {
      // Install succeeded WITHOUT the registry (dependencies may arrive
      // later); the registry appears before the FIRST read.
      expect(service.getSources().map(source => source.sourceId)).toContain('builtin.files')
      registry = { get: id => (id === 'ws-1' ? { path: workspace } : undefined) }

      const listing = await service.list({ workspaceId: 'ws-1', sourceId: 'builtin.files' })
      expect(listing.items.map(item => item.title)).toEqual(['a.md'])
    } finally {
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  })
})

describe('/sidebar/api clue dispatcher fallback', () => {
  it('serves owned clue methods through the one fenced route and leaves unknown methods 404', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-clues-dispatch-'))
    roots.push(base)
    const home = join(base, 'home')
    const workspace = join(base, 'workspace')
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.md'), '# dispatched\n')

    const provided = new Map<string, unknown>()
    const effects: Array<() => void | (() => void)> = []
    const routes: SidebarWebRoute[] = []
    const registry = {
      get: (id: string) => (id === 'ws-1' ? { path: workspace } : undefined),
    }
    const ctx: FakeContext = {
      connection: { requestRejection: () => undefined },
      webServer: {
        register: (route) => { routes.push(route); return () => {} },
        registerUpgrade: () => () => {},
      },
      sessions: { get: () => undefined },
      tools: { register: () => () => {} },
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') effects.push(cleanup)
      },
      inject: () => () => {},
      on: () => () => {},
      get: (key) => {
        if (key === 'betterSidebarClues') return provided.get(key)
        if (key === 'workspaceRegistry') return registry
        return undefined
      },
      provide: (name, value) => { provided.set(name, value) },
      profileContext: { home },
      workspaceRegistry: registry,
      logger: { warn: () => {}, info: () => {} },
    }
    try {
      apply(ctx as never)
      const route = routes.find(candidate => candidate.path === '/sidebar/api')
      expect(route).toBeDefined()
      expect(provided.get('betterSidebarClues')).toBeDefined()

      const sources = await post(route!, 'clues.sources', {})
      expect(sources.status).toBe(200)
      expect(sources.body.ok).toBe(true)
      expect((sources.body.value as { sources: Array<{ sourceId: string }> }).sources[0]?.sourceId).toBe('builtin.files')

      const list = await post(route!, 'clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files' })
      expect(list.status).toBe(200)
      const items = (list.body.value as { items: ClueCandidate[] }).items
      expect(items.map(item => item.title)).toEqual(['a.md'])

      const ensure = await post(route!, 'clues.ensure', {
        workspaceId: 'ws-1',
        sourceId: 'builtin.files',
        typeId: LOCAL_FILE_TYPE_IDS.markdown,
        locator: items[0]!.locator,
        title: 'a.md',
      })
      expect(ensure.status).toBe(200)
      const clueId = (ensure.body.value as { clue: { id: string } }).clue.id

      // The durable store is rooted under the profile home, not the workspace.
      expect(existsSync(join(home, 'better-sidebar-data', 'clues', 'workspaces', encodeURIComponent('ws-1'), 'state.json')))
        .toBe(true)

      const read = await post(route!, 'clues.read', { workspaceId: 'ws-1', clueId })
      expect(read.body).toMatchObject({ ok: true, value: { text: '# dispatched\n' } })

      // A clue payload error keeps its clue category on the wire AND is a
      // client error (400), not an internal 500: the request is malformed,
      // the plugin is not failing.
      const invalid = await post(route!, 'clues.packs.create', { workspaceId: 'ws-1', members: 'nope' })
      expect(invalid.status).toBe(400)
      expect(invalid.body).toMatchObject({ ok: false, error: { code: 'invalid-request' } })

      // A resolve without a selector is a malformed request, not an empty
      // candidate list.
      const emptyResolve = await post(route!, 'clues.resolve', { workspaceId: 'ws-1' })
      expect(emptyResolve.status).toBe(400)
      expect(emptyResolve.body).toMatchObject({ ok: false, error: { code: 'invalid-request' } })

      // A zero page limit fails in the service's shared validator and must
      // reach the wire as 400 too.
      const invalidLimit = await post(route!, 'clues.list', {
        workspaceId: 'ws-1',
        sourceId: 'builtin.files',
        limit: 0,
      })
      expect(invalidLimit.status).toBe(400)
      expect(invalidLimit.body).toMatchObject({ ok: false, error: { code: 'invalid-request' } })

      // The clue EDIT document is not bound by the 1 MiB control-payload cap:
      // a 1.5 MiB source document must load AND save back through this route.
      const bigText = 'x'.repeat(1_500_000)
      writeFileSync(join(workspace, 'big.txt'), bigText)
      const bigEnsure = await post(route!, 'clues.ensure', {
        workspaceId: 'ws-1',
        sourceId: 'builtin.files',
        typeId: LOCAL_FILE_TYPE_IDS.text,
        locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'big.txt', dialect: HOST_DIALECT },
        title: 'big.txt',
      })
      expect(bigEnsure.status).toBe(200)
      const bigId = (bigEnsure.body.value as { clue: { id: string } }).clue.id
      const bigEdit = await post(route!, 'clues.loadEdit', { workspaceId: 'ws-1', clueId: bigId })
      expect(bigEdit.status).toBe(200)
      const bigDocument = bigEdit.body.value as { format: string; data: { text: string }; baseRevision: string }
      const replacement = 'y'.repeat(1_500_000)
      const bigSave = await post(route!, 'clues.saveEdit', {
        workspaceId: 'ws-1',
        clueId: bigId,
        document: {
          format: bigDocument.format,
          data: { text: replacement },
          baseRevision: bigDocument.baseRevision,
        },
      })
      expect(bigSave.status).toBe(200)
      expect(readFileSync(join(workspace, 'big.txt'), 'utf8')).toBe(replacement)

      // Every OTHER JSON method keeps the tight 1 MiB bound.
      const oversized = await post(route!, 'clues.resolve', {
        workspaceId: 'ws-1',
        text: 'z'.repeat(1_500_000),
      })
      expect(oversized.status).toBe(400)
      expect(oversized.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })

      // A registered API handler's raw failure is normalized before it can
      // reach the 500 envelope (no transport output / tokens on the wire).
      const clueService = provided.get('betterSidebarClues') as CluesService
      clueService.registerApi('test.leak', () => {
        throw new Error('Authorization: Bearer top-secret-token')
      })
      const leaked = await post(route!, 'test.leak', {})
      expect(leaked.status).toBe(500)
      expect(leaked.body).toMatchObject({ ok: false, error: { code: 'failed' } })
      expect(leaked.body.error?.message).not.toContain('top-secret')

      // A method NO service owns is still a 404 — the fallback is not a
      // catch-all.
      const unknown = await post(route!, 'definitely.not.a.method', {})
      expect(unknown.status).toBe(404)
      expect(unknown.body).toMatchObject({ ok: false, error: { code: 'not-found' } })
    } finally {
      for (const cleanup of effects.reverse()) cleanup()
    }

    // The install effect is what unmounts the clue service: after its cleanup
    // the API seam is disposed (the fake context models the same lifecycle the
    // real plugin-mount lane exercises at the deployment layer).
    expect((provided.get('betterSidebarClues') as CluesService).hasApi('clues.sources')).toBe(false)
  })
})
