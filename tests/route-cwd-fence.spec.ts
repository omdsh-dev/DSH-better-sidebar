/**
 * The cwd fence on the routes that READ the filesystem: `/sidebar/api`
 * (fs.*, git, search) and `/sidebar/file`.
 *
 * Every scoped sidebar call carries an optional client `cwd`. While one
 * harness served one workspace, letting it stand in for the session's own
 * directory only chose a folder. Under one dsh serving many customer sites,
 * ONE process has every site mounted — so an unchecked client `cwd` reads
 * another tenant's files, and the process cwd fallback reads the harness's.
 *
 * These tests drive the real route handlers against real directories, and
 * assert on the OUTCOME of the operation: a refusal must return an error AND
 * no byte of the foreign file. A guard whose unit tests pass while the route
 * still reads is exactly the failure this suite exists to catch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

const SECRET = 'another tenant\'s data'

let root: string
let workspace: string
let foreign: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-cwd-fence-'))
  workspace = join(root, 'wpdemo')
  foreign = join(root, 'siteb')
  mkdirSync(workspace)
  mkdirSync(foreign)
  writeFileSync(join(workspace, 'own.txt'), 'my own file')
  writeFileSync(join(foreign, 'secret.txt'), SECRET)
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** Mount the plugin against a session store that may or may not know a cwd. */
function mount(
  sessionCwd?: string,
  persistence?: unknown,
): { api: SidebarWebRoute; file: SidebarWebRoute } {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
    },
    sessions: { get: () => (sessionCwd === undefined ? undefined : { header: { cwd: sessionCwd } }) },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    get: (key: string) => (key === 'sessionPersistence' ? persistence : undefined),
    provide: () => {},
    // The session/agent event feeds: nothing emits in these tests.
    on: () => () => {},
  }
  apply(ctx as never)
  return {
    api: routes.find(route => route.path === '/sidebar/api')!,
    file: routes.find(route => route.path === '/sidebar/file')!,
  }
}

/** Call one `/sidebar/api` method. */
async function callApi(route: SidebarWebRoute, method: string, payload: unknown): Promise<{
  ok: boolean
  value?: { content?: string }
  error?: { code?: string; message: string }
}> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  let out = ''
  const res = { writeHead: () => {}, end: (chunk: unknown) => { out += String(chunk ?? '') } } as never
  await route.handler(req, res)
  return JSON.parse(out) as { ok: boolean; value?: { content?: string }; error?: { code?: string; message: string } }
}

/** Call `/sidebar/file` with a query string. */
async function callFile(route: SidebarWebRoute, query: string): Promise<{ status: number; body: string }> {
  const req = { method: 'GET', url: `/sidebar/file?${query}`, headers: { host: '127.0.0.1:3080' } } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += chunk === undefined ? '' : String(chunk) },
  } as never
  await route.handler(req, res)
  return out
}

describe('/sidebar/api — the client cwd cannot leave the session workspace', () => {
  it('accepts a cwd inside the workspace and reads normally', async () => {
    const { api } = mount(workspace)
    const result = await callApi(api, 'fs.read', { sessionId: 's1', cwd: workspace, path: join(workspace, 'own.txt') })
    expect(result.ok).toBe(true)
    expect(result.value?.content).toBe('my own file')
  })

  it('refuses a foreign site and reads NOTHING', async () => {
    const { api } = mount(workspace)
    const result = await callApi(api, 'fs.read', { sessionId: 's1', cwd: foreign, path: join(foreign, 'secret.txt') })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('forbidden')
    // The proof the read did not happen: not one byte of the other tenant's file.
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('refuses a listing of a foreign site', async () => {
    const { api } = mount(workspace)
    const result = await callApi(api, 'fs.tree', { sessionId: 's1', cwd: foreign, path: foreign })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret.txt')
  })

  it('refuses when the harness names no workspace, whatever the client sent', async () => {
    // The only fence on this path. dsh-passwords admits a seat to fs.read and
    // fs.write and checks allowed_folders against its GRANT's cwd, not against
    // the `cwd`/`path` in the body — so a client directory accepted here is a
    // read of any absolute path for a seat that holds one legitimate grant.
    const { api } = mount()
    const named = await callApi(api, 'fs.read', { sessionId: 's1', cwd: foreign, path: join(foreign, 'secret.txt') })
    expect(named.ok).toBe(false)
    expect(named.error?.message).toMatch(/no workspace directory/)
    expect(JSON.stringify(named)).not.toContain(SECRET)
    // And with nothing named at all, still no process cwd.
    const bare = await callApi(api, 'fs.read', { sessionId: 's1', path: 'own.txt' })
    expect(bare.ok).toBe(false)
    expect(bare.error?.message).toMatch(/no workspace directory/)
  })
})

describe('/sidebar/file — the same fence on the media route', () => {
  it('serves a file inside the workspace', async () => {
    const { file } = mount(workspace)
    const result = await callFile(file, `sessionId=s1&cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, 'own.txt'))}`)
    expect(result.status).toBe(200)
    expect(result.body).toBe('my own file')
  })

  it('refuses a foreign site and serves NO bytes', async () => {
    const { file } = mount(workspace)
    const result = await callFile(file, `sessionId=s1&cwd=${encodeURIComponent(foreign)}&path=${encodeURIComponent(join(foreign, 'secret.txt'))}`)
    expect(result.status).toBe(403)
    expect(result.body).not.toContain(SECRET)
  })

  it('refuses when the harness names no workspace', async () => {
    const { file } = mount()
    const named = await callFile(file, `sessionId=s1&cwd=${encodeURIComponent(foreign)}&path=${encodeURIComponent(join(foreign, 'secret.txt'))}`)
    expect(named.status).toBe(400)
    expect(named.body).not.toContain(SECRET)
    const bare = await callFile(file, `sessionId=s1&path=${encodeURIComponent(join(foreign, 'secret.txt'))}`)
    expect(bare.status).toBe(400)
    expect(bare.body).not.toContain(SECRET)
  })
})

/** A persistence face over the 0.1.5+ read-handle API, recording what it was asked. */
function handlePersistence(headers: Record<string, { cwd?: string }>, log: { opened: string[]; closed: number; read: number }) {
  return {
    open: async (id: string, access: string) => {
      log.opened.push(`${id}:${access}`)
      const header = headers[id]
      if (header === undefined) throw new Error(`no such session ${id}`)
      return {
        header,
        read: async () => { log.read += 1; return { events: [] } },
        close: async () => { log.closed += 1 },
      }
    },
  }
}

describe('a cold session resolves its workspace from the persistence read handle', () => {
  // DSH 0.1.5 replaced `inspect`/`stat` with `open(id, 'read')` + `handle.header`.
  // The fence reads the header only: the event log is never pulled for a cwd.
  it('reads the header through a read handle and closes it', async () => {
    const log = { opened: [] as string[], closed: 0, read: 0 }
    const { api } = mount(undefined, handlePersistence({ cold: { cwd: workspace } }, log))
    const result = await callApi(api, 'fs.read', { sessionId: 'cold', path: join(workspace, 'own.txt') })
    expect(result.ok).toBe(true)
    expect(result.value?.content).toBe('my own file')
    expect(log.opened).toEqual(['cold:read'])
    expect(log.closed).toBe(1)
    expect(log.read).toBe(0)
  })

  it('answers "no workspace" — not a crash — when the index has no such session', async () => {
    const log = { opened: [] as string[], closed: 0, read: 0 }
    const { api } = mount(undefined, handlePersistence({}, log))
    const result = await callApi(api, 'fs.read', { sessionId: 'cold', path: join(workspace, 'own.txt') })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/no workspace directory/)
  })

  it('answers "no workspace" when the host publishes no read handle at all', async () => {
    const { api } = mount(undefined, { flush: async () => {} })
    const result = await callApi(api, 'fs.read', { sessionId: 'cold', path: join(workspace, 'own.txt') })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/no workspace directory/)
    expect(result.error?.message).not.toMatch(/is not a function/)
  })

  it('asks the index with the id it was given, verbatim', async () => {
    // The id the client sends is the STORAGE id — `session-<uuid>` — and the
    // index only answers to that. A hand-run probe that stripped the prefix is
    // what produced the "this dsh records no cwd anywhere" reading on 06/09,
    // and a fence was widened on the strength of it. Pin the shape.
    const log = { opened: [] as string[], closed: 0, read: 0 }
    const { api } = mount(undefined, handlePersistence({ 'session-abc': { cwd: workspace } }, log))
    const result = await callApi(api, 'fs.read', { sessionId: 'session-abc', path: join(workspace, 'own.txt') })
    expect(log.opened).toEqual(['session-abc:read'])
    expect(result.ok).toBe(true)
  })

  it('still fences the cold workspace it resolved', async () => {
    const log = { opened: [] as string[], closed: 0, read: 0 }
    const { api } = mount(undefined, handlePersistence({ cold: { cwd: workspace } }, log))
    const result = await callApi(api, 'fs.read', { sessionId: 'cold', cwd: foreign, path: join(foreign, 'secret.txt') })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
