/**
 * The host's "new file" mutation (`fs.createFile` route → createWorkspaceFile):
 * the happy path against a real temporary filesystem, the shared
 * single-segment/existence rules, the two Windows-only refusals a file name
 * must survive (illegal characters, reserved device names), and the promise
 * that an existing destination is REFUSED and never truncated.
 *
 * The workspace fence is GONE (like rename/mkdir): a parent outside the
 * session workspace is accepted like any other directory the host user can
 * write, and an unwritable one surfaces the filesystem's own refusal.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceFile } from '../src/fs-operations.ts'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-create-file-'))
})

afterEach(async () => {
  await chmod(root, 0o700).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

/** The wire code of a rejected call (the route maps it to an HTTP status). */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code'
  }
  return 'resolved'
}

/** The message of a rejected call (the strip shows this text verbatim). */
async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  return 'resolved'
}

describe('createWorkspaceFile', () => {
  it('creates one EMPTY file inside the named row and returns its absolute path', async () => {
    await mkdir(join(root, 'sub'))
    const result = await createWorkspaceFile({ cwd: root, path: join(root, 'sub'), name: 'fresh.txt' })
    // Lexical: the path comes back exactly as composed (no realpath — on macOS
    // /var would otherwise be reported as /private/var).
    expect(result.path).toBe(join(root, 'sub', 'fresh.txt'))
    expect(await readdir(join(root, 'sub'))).toEqual(['fresh.txt'])
    expect(await readFile(join(root, 'sub', 'fresh.txt'), 'utf8')).toBe('')
  })

  it('accepts the workspace root itself as the parent', async () => {
    const result = await createWorkspaceFile({ cwd: root, path: root, name: 'top.ts' })
    expect(result.path).toBe(join(root, 'top.ts'))
    expect(await readdir(root)).toEqual(['top.ts'])
  })

  it('refuses a name that is not a single path segment (empty, dots, separators, traversal)', async () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', '../escape', '..\\escape', 'sub/../../escape']) {
      expect(await codeOf(() => createWorkspaceFile({ cwd: root, path: root, name })), name).toBe('bad-request')
    }
    // Nothing was created by any of the refusals.
    expect(await readdir(root)).toEqual([])
  })

  it('refuses the characters Windows cannot store in a file name', async () => {
    for (const name of ['a:b', 'a?b', 'a*b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0000b', 'a\u001fb', 'lead<ing']) {
      expect(await codeOf(() => createWorkspaceFile({ cwd: root, path: root, name })), JSON.stringify(name)).toBe('bad-request')
    }
    // The message names the offending character, so the strip is actionable.
    expect(await messageOf(() => createWorkspaceFile({ cwd: root, path: root, name: 'a:b' }))).toContain('":"')
    expect(await readdir(root)).toEqual([])
  })

  it('refuses Windows device names, with or without an extension, and accepts near misses', async () => {
    for (const name of ['CON', 'con', 'Con.txt', 'NUL', 'nul.tar.gz', 'AUX', 'PRN', 'COM1', 'com9.log', 'LPT1', 'lpt9.txt']) {
      expect(await codeOf(() => createWorkspaceFile({ cwd: root, path: root, name })), name).toBe('bad-request')
    }
    expect(await messageOf(() => createWorkspaceFile({ cwd: root, path: root, name: 'CON' }))).toContain('reserved device name')
    // Names that merely START with a device name are ordinary files.
    for (const name of ['console.txt', 'conx', 'COM10', 'LPT', 'null.md', 'auxiliary']) {
      await expect(createWorkspaceFile({ cwd: root, path: root, name })).resolves.toEqual({ path: join(root, name) })
    }
    // `readdir` order is filesystem-defined (Windows returns a different order than
    // ext4/APFS), so compare the sorted name set instead of the raw listing.
    expect((await readdir(root)).sort()).toEqual(['COM10', 'LPT', 'auxiliary', 'console.txt', 'conx', 'null.md'])
  })

  it('refuses an existing destination with the same conflict code as rename and mkdir', async () => {
    await writeFile(join(root, 'taken.txt'), 'keep me')
    expect(await codeOf(() => createWorkspaceFile({ cwd: root, path: root, name: 'taken.txt' }))).toBe('fs-error')
    expect(await messageOf(() => createWorkspaceFile({ cwd: root, path: root, name: 'taken.txt' }))).toContain('already exists')
    // ⚠️ The refusal must NOT truncate: the create uses `wx`, not `w`.
    expect(await readFile(join(root, 'taken.txt'), 'utf8')).toBe('keep me')
  })

  it('refuses a destination that is a DIRECTORY (a row of either kind occupies the name)', async () => {
    await mkdir(join(root, 'both'))
    expect(await codeOf(() => createWorkspaceFile({ cwd: root, path: root, name: 'both' }))).toBe('fs-error')
  })

  it('reports an unwritable parent directory as an fs-error carrying the filesystem message', async () => {
    // POSIX only: Windows has no mode bits, and root bypasses them everywhere.
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const locked = join(root, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)
    try {
      expect(await codeOf(() => createWorkspaceFile({ cwd: root, path: locked, name: 'nope.txt' }))).toBe('fs-error')
      expect(await messageOf(() => createWorkspaceFile({ cwd: root, path: locked, name: 'nope.txt' }))).toContain('cannot create "nope.txt"')
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('creates a file under a parent outside the workspace (fence removed)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
    try {
      const result = await createWorkspaceFile({ cwd: root, path: outside, name: 'allowed.txt' })
      expect(result.path).toBe(join(outside, 'allowed.txt'))
      expect(await readdir(outside)).toEqual(['allowed.txt'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

/**
 * The ROUTE, not just the operation: `fs.createFile` must exist in the route
 * table, take `path`/`name` off the payload, resolve `cwd` from the session,
 * and map the two refusal classes to their HTTP statuses (409 for a taken
 * destination, 400 for a broken name) — the wire contract the client's inline
 * editor reads.
 */
interface FakeContext {
  webRuntime: { trustedHosts: readonly string[] }
  webServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: () => () => void
  }
  sessions: { get: (id: string) => { header: { cwd?: string } } | undefined }
  tools: { register: () => () => void }
  effect: (fn: () => void | (() => void)) => void
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
  on: () => () => void
  get: (key: string) => undefined
}

/** Mount the plugin against a fake context whose session cwd is `workspace`. */
function mountApi(workspace: string): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx: FakeContext = {
    webRuntime: { trustedHosts: [] },
    webServer: { register: (route) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: () => ({ header: { cwd: workspace } }) },
    tools: { register: () => () => {} },
    effect: (fn) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never, {})
  return routes.find(route => route.path === '/sidebar/api')!
}

interface Invoked {
  ok: boolean
  status: number
  value?: { path?: string }
  error?: { code?: string; message?: string }
}

async function invoke(route: SidebarWebRoute, method: string, payload: unknown): Promise<Invoked> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Invoked, status: out.status }
}

describe('fs.createFile route', () => {
  it('creates the empty file the payload names and answers with its path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-create-route-'))
    try {
      const route = mountApi(workspace)
      const result = await invoke(route, 'fs.createFile', { sessionId: 's', path: workspace, name: 'made.txt' })
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.value?.path).toBe(join(workspace, 'made.txt'))
      expect(await readFile(join(workspace, 'made.txt'), 'utf8')).toBe('')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('maps a taken destination to 409/fs-error and a broken name to 400/bad-request', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-create-route-'))
    try {
      const route = mountApi(workspace)
      await writeFile(join(workspace, 'taken.txt'), 'keep')
      const taken = await invoke(route, 'fs.createFile', { sessionId: 's', path: workspace, name: 'taken.txt' })
      expect(taken.status).toBe(409)
      expect(taken.error?.code).toBe('fs-error')
      expect(taken.error?.message).toContain('already exists')
      expect(await readFile(join(workspace, 'taken.txt'), 'utf8')).toBe('keep')

      const reserved = await invoke(route, 'fs.createFile', { sessionId: 's', path: workspace, name: 'CON' })
      expect(reserved.status).toBe(400)
      expect(reserved.error?.code).toBe('bad-request')

      const traversal = await invoke(route, 'fs.createFile', { sessionId: 's', path: workspace, name: '../escape' })
      expect(traversal.status).toBe(400)
      expect(traversal.error?.code).toBe('bad-request')
      expect(await readdir(workspace)).toEqual(['taken.txt'])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
