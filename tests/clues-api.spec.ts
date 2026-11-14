/**
 * S1 clue API surface: payload validation, fixed caller/abort forwarding, and
 * the host dispatcher fallback.
 *
 * - `registerCluesApi` claims every S1 method; malformed payloads fail as typed
 *   `ClueError`s before reaching a source or the store; the caller is always
 *   `'ui'` and the request signal is forwarded.
 * - The ONE `/sidebar/api` dispatcher fallback (`apply`): an unknown method
 *   owned by the clue service is served through `invokeApi` on the existing
 *   fenced route — no second route — and an actually unknown method answers 404.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { installClues } from '../src/clues/index.ts'
import { createCluesService, type ClueSourceRegistration, type CluesService } from '../src/clues/service.ts'
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

/** A temp base with a profile home, a workspace and a clue service on it. */
function fixture(seed = { file: 'a.md', body: '# hello\n' }): { home: string; workspace: string; service: CluesService } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-api-'))
  roots.push(base)
  const home = join(base, 'home')
  const workspace = join(base, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, seed.file), seed.body)
  let next = 0
  const service = createCluesService({
    root: join(base, 'store'), now: () => '2026-10-17T00:00:00.000Z', newId: kind => `${kind}-${++next}`,
    builtinSources: [createLocalFileSource()], resolveWorkspacePath: id => (id === 'ws-1' ? workspace : undefined),
  })
  return { home, workspace, service }
}

/** One MCP source with custom operations (wire-seam tests only). */
function mcpSource(
  sourceId: string,
  operations: NonNullable<ClueSourceRegistration['operations']>,
  options: { filters?: ClueSourceRegistration['descriptor']['filters']; capabilities?: Partial<ClueSourceRegistration['descriptor']['capabilities']> } = {},
): ClueSourceRegistration {
  const typeId = `${sourceId}.text`
  return {
    descriptor: {
      sourceId, name: sourceId, order: 10, pluginId: 'test', types: [typeId], transport: 'mcp',
      capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false, ...options.capabilities },
      ...(options.filters === undefined ? {} : { filters: options.filters }),
    },
    types: [{ typeId, sourceId, formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations,
  }
}

describe('clue API handlers', () => {
  it('claims every documented S1 method and releases them on dispose', () => {
    const { service } = fixture()
    const dispose = registerCluesApi(service)
    for (const method of CLUES_API_METHODS) expect(service.hasApi(method), method).toBe(true)
    dispose()
    for (const method of CLUES_API_METHODS) expect(service.hasApi(method), method).toBe(false)
  })
  it('answers the wire catalogue with builtin descriptors and source filter declarations', async () => {
    const { service } = fixture()
    const filters = [{ scopeKey: 'state', defaultOptionId: 'open', options: [{ id: 'open', value: 'open' }, { id: 'closed', value: 'closed' }, { id: 'all', value: 'all' }] }]
    service.registerSource(mcpSource('test.filters', {}, { filters, capabilities: { list: true } }))
    registerCluesApi(service)
    const result = await service.invokeApi('clues.sources', {}) as { sources: unknown[]; types: unknown[] }
    expect(result.sources).toMatchObject([
      { sourceId: 'builtin.files', transport: 'files', types: ['builtin.files.markdown', 'builtin.files.text', 'builtin.files.binary', 'builtin.files.directory'] },
      { sourceId: 'test.filters', filters },
    ])
    expect(result.types).toHaveLength(5)
  })
  it('dispatches list/ensure/read/clues and persists display metadata', async () => {
    const { service } = fixture()
    registerCluesApi(service)
    const listing = await service.invokeApi('clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files' }) as { items: ClueCandidate[] }
    expect(listing.items.map(item => item.title)).toEqual(['a.md'])

    const ensure = {
      workspaceId: 'ws-1', sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown,
      locator: listing.items[0]!.locator, title: 'a.md', subtitle: 'Markdown file',
      info: { state: 'active', path: 'a.md', labels: ['docs'], updatedAt: '2026-10-17T00:00:00Z' },
    }
    const ensured = await service.invokeApi('clues.ensure', ensure) as {
      created: boolean
      clue: { id: string; subtitle?: string; info?: Record<string, unknown> }
    }
    expect(ensured.created).toBe(true)
    expect(ensured.clue.subtitle).toBe('Markdown file')
    expect(ensured.clue.info).toEqual({ state: 'active', path: 'a.md', labels: ['docs'], updatedAt: '2026-10-17T00:00:00.000Z' })
    expect(await service.invokeApi('clues.clues', { workspaceId: 'ws-1' }))
      .toMatchObject({ clues: [{ subtitle: 'Markdown file', info: ensured.clue.info }] })
    expect(await service.invokeApi('clues.read', { workspaceId: 'ws-1', clueId: ensured.clue.id }))
      .toMatchObject({ format: 'text/markdown', text: '# hello\n' })
  })
  it('serves pins, packs, bindings and snapshots on the same payload shapes', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.txt'), 'a\n')
    registerCluesApi(service)
    const ensured = await service.invokeApi('clues.ensure', {
      workspaceId: 'ws-1', sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.text,
      locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'a.txt', dialect: HOST_DIALECT }, title: 'a.txt',
    }) as { clue: { id: string } }
    const clueId = ensured.clue.id

    expect(await service.invokeApi('clues.pins.add', { workspaceId: 'ws-1', clueId })).toMatchObject({ pins: [{ clueId }] })
    expect(await service.invokeApi('clues.pins.remove', { workspaceId: 'ws-1', clueId })).toMatchObject({ pins: [] })

    const pack = await service.invokeApi('clues.packs.create', { workspaceId: 'ws-1', name: 'Pack', members: [clueId] }) as { pack: { id: string } }
    expect(pack.pack).toMatchObject({ members: [clueId] })
    expect(await service.invokeApi('clues.packs.rename', { workspaceId: 'ws-1', packId: pack.pack.id, name: 'Renamed' }))
      .toMatchObject({ pack: { name: 'Renamed' } })
    expect(await service.invokeApi('clues.packs.removeMember', { workspaceId: 'ws-1', packId: pack.pack.id, clueId }))
      .toMatchObject({ pack: { members: [] } })
    expect(await service.invokeApi('clues.packs.delete', { workspaceId: 'ws-1', packId: pack.pack.id }))
      .toMatchObject({ deleted: true, packs: [] })

    expect(await service.invokeApi('clues.bindings.add', { workspaceId: 'ws-1', target: { kind: 'clue', clueId } }))
      .toMatchObject({ bindings: [{ target: { kind: 'clue', clueId } }] })
    expect(await service.invokeApi('clues.bindings.remove', { workspaceId: 'ws-1', target: { kind: 'clue', clueId } }))
      .toMatchObject({ bindings: [] })
    await expect(service.invokeApi('clues.snapshots.read', { workspaceId: 'ws-1', snapshotId: 'missing' }))
      .rejects.toMatchObject({ category: 'not-found' })
  })
  it('rejects malformed payloads as typed clue failures before dispatching', async () => {
    const { service } = fixture()
    registerCluesApi(service)
    const ensure = (extra: Record<string, unknown>) => ({ workspaceId: 'ws-1', sourceId: 'builtin.files', typeId: 'builtin.files.text', ...extra })
    const cases: Array<[string, unknown]> = [
      ['clues.resolve', null],
      ['clues.resolve', {}],
      ['clues.resolve', { workspaceId: 'ws-1', text: '   ' }],
      ['clues.list', { workspaceId: 'ws-1', sourceId: 7 }],
      ['clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files', limit: 0 }],
      ['clues.search', { workspaceId: 'ws-1', sourceId: 'builtin.files' }],
      ['clues.read', { workspaceId: 'ws-1' }],
      ['clues.loadEdit', { workspaceId: 'ws-1', clueId: 1 }],
      ['clues.saveEdit', { workspaceId: 'ws-1', clueId: 'c' }],
      ['clues.portable', { workspaceId: 'ws-1' }],
      ['clues.ensure', ensure({ title: 'x' })],
      ['clues.ensure', ensure({ locator: 'nope', title: 'x' })],
      ['clues.ensure', ensure({ locator: {}, title: 'x', info: 'nope' })],
      ['clues.ensure', ensure({ locator: {}, title: 'x', subtitle: 7 })],
      ['clues.pins.add', { workspaceId: 'ws-1' }],
      ['clues.packs.create', { workspaceId: 'ws-1', name: 'x', members: 'nope' }],
      ['clues.packs.create', { workspaceId: 'ws-1', name: 'x', expectedRevision: -1 }],
      ['clues.packs.rename', { workspaceId: 'ws-1', packId: 'p' }],
      ['clues.packs.delete', { workspaceId: 'ws-1' }],
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
  it('fixes the caller to "ui", forwards the signal, and keeps source categories on the wire', async () => {
    const { service } = fixture()
    const seen: Array<{ caller: string; hasSignal: boolean }> = []
    service.registerSource(mcpSource('test.caller', {
      async read(_input, context) {
        seen.push({ caller: context.caller, hasSignal: context.signal !== undefined })
        return { format: 'text/plain', data: { text: 'x' }, fetchedAt: 'now' }
      },
    }))
    service.registerSource(mcpSource('test.fail', { async read() { throw new Error('Authorization: Bearer top-secret') } }))
    registerCluesApi(service)
    await service.invokeApi('clues.read', {
      workspaceId: 'ws-1', sourceId: 'test.caller', typeId: 'test.caller.text', locator: { id: 'x' },
    }, { caller: 'agent', signal: new AbortController().signal })
    expect(seen).toEqual([{ caller: 'ui', hasSignal: true }])

    const failure: unknown = await service.invokeApi('clues.read', {
      workspaceId: 'ws-1', sourceId: 'test.fail', typeId: 'test.fail.text', locator: { id: 'x' },
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ClueError)
    expect((failure as ClueError).category).toBe('failed')
    expect((failure as ClueError).message).not.toContain('top-secret')
  })
  it('normalizes registered API handler failures and preserves intentional categories', async () => {
    const { service } = fixture()
    service.registerApi('test.leak', () => { throw new Error('Authorization: Bearer top-secret-token; stdout: command failed') })
    service.registerApi('test.auth', () => { throw new ClueError('auth-required', 'sign in first') })
    const leaked: unknown = await service.invokeApi('test.leak', {}).then(() => undefined, (error: unknown) => error)
    expect(leaked).toBeInstanceOf(ClueError)
    expect((leaked as ClueError).category).toBe('failed')
    expect((leaked as ClueError).message).not.toContain('top-secret')
    expect((leaked as ClueError).message).not.toContain('stdout')
    // A handler that raises a real ClueError keeps its category and message.
    await expect(service.invokeApi('test.auth', {})).rejects.toMatchObject({ category: 'auth-required', message: 'sign in first' })
  })
})

/** One fake install context that parks effect cleanups. */
function installCtx(home: string, get: (key: string) => unknown): { ctx: unknown; cleanup: () => void } {
  const cleanups: Array<() => void> = []
  const ctx = {
    profileContext: { home }, logger: { warn: () => {} }, get,
    effect: (fn: () => void | (() => void)) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  }
  return { ctx, cleanup: () => { for (const fn of cleanups.reverse()) fn() } }
}
type Captured = { status: number; body: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }
/** POST one method through a captured route and return the decoded envelope. */
async function post(route: SidebarWebRoute, method: string, payload: unknown): Promise<Captured> {
  const body = JSON.stringify(payload)
  const req = { url: `/sidebar/api/${method}`, method: 'POST', headers: {}, async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> { yield Buffer.from(body) } } as unknown as SidebarHttpRequest
  let status = 0
  let raw = ''
  const res = {
    statusCode: 0, headersSent: false,
    writeHead(code: number) { status = code; res.statusCode = code; res.headersSent = true },
    write() { return true },
    end(chunk?: string | Uint8Array) { raw += chunk === undefined ? '' : String(chunk) },
    // No socket in the fixture: the dispatcher's close listener is a no-op.
    destroy() {}, once() {}, off() {},
  }
  await route.handler(req, res as unknown as SidebarHttpResponse)
  return { status, body: JSON.parse(raw) as Captured['body'] }
}

describe('installClues dependency lifecycle', () => {
  it('defers a late workspaceRegistry to the first operation and installs core-owned builtins', async () => {
    const { home, workspace } = fixture({ file: 'a.md', body: '# late\n' })
    // At install time the registry is not there yet: the plugin must still
    // install (dependencies arrive later in Cordis), and every operation must
    // re-read it instead of snapshotting it at install.
    let registry: { get(id: string): { path?: string } | undefined } | undefined
    const { ctx, cleanup } = installCtx(home, key => (key === 'workspaceRegistry' ? registry : undefined))
    try {
      const service = installClues(ctx as never)
      expect(service.getSources().map(source => source.sourceId)).toContain('builtin.files')
      registry = { get: id => (id === 'ws-1' ? { path: workspace } : undefined) }
      const listing = await service.list({ workspaceId: 'ws-1', sourceId: 'builtin.files' })
      expect(listing.items.map(item => item.title)).toEqual(['a.md'])
    } finally { cleanup() }

    // The total assembly supplies core-owned builtins; the public registration
    // path still refuses a built-in id.
    const builtin: ClueSourceRegistration = {
      descriptor: {
        sourceId: 'builtin.github.issues', name: 'GitHub Issues', order: 20, pluginId: 'dsh-better-sidebar',
        types: ['builtin.github.issue'], transport: 'cli',
        capabilities: { resolve: false, list: false, search: false, read: false, edit: false, portable: false },
      },
      types: [{ typeId: 'builtin.github.issue', sourceId: 'builtin.github.issues', formats: ['text/markdown'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    }
    const second = installCtx(home, () => undefined)
    try {
      const service = installClues(second.ctx as never, { builtinSources: [builtin] })
      expect(service.getSources().map(source => source.sourceId)).toContain('builtin.github.issues')
      expect(() => service.registerSource(builtin)).toThrow(/reserved/)
    } finally { second.cleanup() }
  })
})

describe('/sidebar/api clue dispatcher fallback', () => {
  it('serves owned clue methods through the one fenced route and leaves unknown methods 404', async () => {
    const { home, workspace } = fixture({ file: 'a.md', body: '# dispatched\n' })
    const provided = new Map<string, unknown>()
    const effects: Array<() => void | (() => void)> = []
    const routes: SidebarWebRoute[] = []
    const registry = { get: (id: string) => (id === 'ws-1' ? { path: workspace } : undefined) }
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: { register: (route: SidebarWebRoute) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
      sessions: { get: () => undefined },
      tools: { register: () => () => {} },
      effect: (fn: () => void | (() => void)) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
      inject: () => () => {},
      on: () => () => {},
      get: (key: string) => (key === 'betterSidebarClues' ? provided.get(key) : key === 'workspaceRegistry' ? registry : undefined),
      provide: (name: string, value: unknown) => { provided.set(name, value) },
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
      expect((sources.body.value as { sources: Array<{ sourceId: string }> }).sources[0]?.sourceId).toBe('builtin.files')
      // A clue payload error keeps its category AND is a client error (400),
      // not an internal 500.
      const invalid = await post(route!, 'clues.list', { workspaceId: 'ws-1', sourceId: 'builtin.files', cursor: 'not-a-cursor' })
      expect(invalid.status).toBe(400)
      expect(invalid.body).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
      // The clue EDIT document is not bound by the 1 MiB control-payload cap:
      // a 1.5 MiB source document must load AND save back through this route,
      // and the durable store is rooted under the profile home.
      writeFileSync(join(workspace, 'big.txt'), 'x'.repeat(1_500_000))
      const big = await post(route!, 'clues.ensure', {
        workspaceId: 'ws-1', sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.text,
        locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'big.txt', dialect: HOST_DIALECT }, title: 'big.txt',
      })
      expect(big.status).toBe(200)
      const bigId = (big.body.value as { clue: { id: string } }).clue.id
      expect(existsSync(join(home, 'better-sidebar-data', 'clues', 'workspaces', 'ws-1', 'state.json'))).toBe(true)
      const document = (await post(route!, 'clues.loadEdit', { workspaceId: 'ws-1', clueId: bigId })).body.value as { format: string; data: { text: string }; baseRevision: string }
      const replacement = 'y'.repeat(1_500_000)
      expect((await post(route!, 'clues.saveEdit', {
        workspaceId: 'ws-1', clueId: bigId,
        document: { format: document.format, data: { text: replacement }, baseRevision: document.baseRevision },
      })).status).toBe(200)
      expect(readFileSync(join(workspace, 'big.txt'), 'utf8')).toBe(replacement)
      // Every OTHER JSON method keeps the tight 1 MiB bound.
      const oversized = await post(route!, 'clues.resolve', { workspaceId: 'ws-1', text: 'z'.repeat(1_500_000) })
      expect(oversized.status).toBe(413)
      expect(oversized.body).toMatchObject({ ok: false, error: { code: 'too-large' } })
      // A registered handler's raw failure is normalized before the 500 envelope.
      const clueService = provided.get('betterSidebarClues') as CluesService
      clueService.registerApi('test.leak', () => { throw new Error('Authorization: Bearer top-secret-token') })
      const leaked = await post(route!, 'test.leak', {})
      expect(leaked.status).toBe(500)
      expect(leaked.body).toMatchObject({ ok: false, error: { code: 'failed' } })
      expect(leaked.body.error?.message).not.toContain('top-secret')
      // Only a STRING `sessionId` is forwarded (never coerced).
      clueService.registerApi('test.session', (_payload, context) => context.sessionId ?? null)
      expect((await post(route!, 'test.session', { sessionId: 'sess-1' })).body).toMatchObject({ ok: true, value: 'sess-1' })
      expect((await post(route!, 'test.session', { sessionId: 42 })).body).toMatchObject({ ok: true, value: null })
      // A method NO service owns is still a 404 — the fallback is not a catch-all.
      const unknown = await post(route!, 'definitely.not.a.method', {})
      expect(unknown.status).toBe(404)
      expect(unknown.body).toMatchObject({ ok: false, error: { code: 'not-found' } })
    } finally { for (const cleanup of effects.reverse()) cleanup() }
    // The install effect unmounts the clue service: cleanup disposes the API seam.
    expect((provided.get('betterSidebarClues') as CluesService).hasApi('clues.sources')).toBe(false)
  })
})