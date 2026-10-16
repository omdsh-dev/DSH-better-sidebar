/**
 * Smoke spec: mounts the host plugin against a minimal fake context and
 * exercises the real integrations — route registration, git against the
 * actual repository, and a real directory listing. Runs with `pnpm test`.
 */
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { SettingsConflictError, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { WebSocket } from 'ws'
import { apply, FS_TREES_MAX_PATHS, mediaTypeForPath, previewTypeForPath } from '../src/index.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { encodeHtmlUrl } from '../src/html-route.ts'
import { encodeText } from '../src/text-encoding.ts'
import { downloadUrl, htmlUrl } from '../src/client/api.ts'
import * as git from '../src/git.ts'
import { listDirectory } from '../src/fs-tree.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'

/**
 * The probe-budget factory is spied on so a batch's gate SHARING is asserted
 * rather than assumed: `fs.trees` lists many levels at once and must build ONE
 * gate per request, or the per-level probe bounds multiply. Everything else
 * about the module stays real, so this file's own `listDirectory` calls (and
 * every other route) behave exactly as before.
 */
const probeGateCalls = vi.hoisted(() => [] as unknown[][])
vi.mock('../src/fs-tree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fs-tree.ts')>()
  return {
    ...actual,
    createProbeGate: (...args: Parameters<typeof actual.createProbeGate>) => {
      probeGateCalls.push(args)
      return actual.createProbeGate(...args)
    },
  }
})

/** Symlink creation may require elevated privileges on Windows. */
const canCreateSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-security-probe-'))
  try {
    mkdirSync(join(dir, 'target'))
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    removeTree(dir)
  }
})()

interface FakeContext {
  webRuntime: { trustedHosts: readonly string[] }
  webServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: (route: SidebarWebUpgradeRoute) => () => void
  }
  sessions: { get: (id: string) => { header: { cwd?: string } } | undefined }
  tools: { register: (tool: unknown) => () => void }
  effect: (fn: () => void | (() => void), label?: string) => void
  /** The session/agent event feeds: nothing emits in these tests. */
  on: (event: string, listener: (payload: never) => void) => () => void
  /** The settings service never appears in the smoke context: the inject
   *  callback must never run (mirror of cordis' service-less inject). */
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
  /** Optional services (jobs/agents) are read lazily; absent → undefined. */
  get: (key: string) => undefined
}

/**
 * The routes the MOST RECENT mount registered, whichever helper produced them.
 *
 * The editor save moved from a JSON method on `/sidebar/api` to its own raw
 * route (`/sidebar/write`, with the document as the request body). Every call
 * site here still says `invoke(route, 'fs.write', ...)`, so the dispatcher
 * needs a way back to the mount that produced `route` — recording the last one
 * is far less noise than threading a second route reference through every
 * case, and BOTH mount helpers write it so neither can leave a stale entry
 * behind the other.
 */
let lastMountedRoutes: SidebarWebRoute[] = []

describe('host plugin smoke', () => {
  it('serves PDF with the browser-native content type', () => {
    expect(mediaTypeForPath('/work/report.PDF')).toBe('application/pdf')
    expect(mediaTypeForPath('/work/archive.bin')).toBe('application/octet-stream')
  })

  it('resolves preview-only web asset types without touching the media map (#959)', () => {
    // The previewer answers the document and every relative asset it pulls; the
    // media route keeps its byte-for-byte behaviour (unknown extensions and every
    // non-image type stay application/octet-stream there), so a stylesheet still
    // DOWNLOADS when asked for as a file and only RENDERS inside a preview.
    expect(previewTypeForPath('/w/css/style.css')).toBe('text/css')
    expect(previewTypeForPath('/w/js/app.JS')).toBe('text/javascript')
    expect(previewTypeForPath('/w/js/module.mjs')).toBe('text/javascript')
    expect(previewTypeForPath('/w/data/x.json')).toBe('application/json')
    expect(previewTypeForPath('/w/subs/captions.vtt')).toBe('text/vtt')
    expect(previewTypeForPath('/w/fonts/x.woff2')).toBe('font/woff2')
    expect(previewTypeForPath('/w/x.wasm')).toBe('application/wasm')
    // Falls through to the shared map: the images/PDF/HTML contracts are the same
    // objects the media route hands out, and unknowns keep the binary-safe fallback.
    expect(previewTypeForPath('/w/img/pic.png')).toBe('image/png')
    expect(previewTypeForPath('/w/doc.pdf')).toBe('application/pdf')
    expect(previewTypeForPath('/w/archive.bin')).toBe('application/octet-stream')
    expect(mediaTypeForPath('/w/css/style.css')).toBe('application/octet-stream')
    expect(mediaTypeForPath('/w/archive.bin')).toBe('application/octet-stream')
  })

  it('mounts the fenced routes', () => {
    const routes: SidebarWebRoute[] = []
    const upgrades: SidebarWebUpgradeRoute[] = []
    const effects: Array<() => void | (() => void)> = []
    const ctx: FakeContext = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: (route) => { routes.push(route); return () => {} },
        registerUpgrade: (route) => { upgrades.push(route); return () => {} },
      },
      sessions: { get: () => undefined },
      tools: { register: () => () => {} },
      // The DSH-vendored cordis runs the registration effect immediately and
      // keeps its cleanup for disposal.
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') effects.push(cleanup)
      },
      // No settings service in the smoke context: the registration callback
      // never runs (cordis' service-less inject behaves the same).
      inject: () => () => {},
      on: () => () => {},
      // No jobs/agents services: the jobs routes degrade to a 503.
      get: () => undefined,
    }
    apply(ctx as never)
    expect(routes.map(route => route.path)).toEqual([
      '/sidebar/api',
      '/sidebar/upload',
      '/sidebar/write',
      '/sidebar/bundle',
      '/sidebar/archive',
      '/sidebar/file',
      '/sidebar/html',
    ])
    expect(upgrades.map(route => route.path)).toEqual([
      '/sidebar/ws/agent-opens',
      '/sidebar/ws/fs-watch',
      '/sidebar/ws/sidechat',
    ])
    // Teardown runs without throwing.
    for (const cleanup of effects) cleanup()
  })

  /**
   * Teardown must release the ACCEPTED sockets, not merely stop accepting new
   * ones: `WebSocketServer.close()` on a `noServer` server does not terminate
   * an already-upgraded socket under ws@8 (it sets `_shouldEmitClose` and
   * waits), so without the explicit `wss.clients` close every fs-watch
   * `fs.watch` handle and the agent-opens subscriber set survives the plugin
   * unmount until the browser disconnects. The client here is a REAL ws
   * connection through the registered upgrade handler.
   */
  it('closes the accepted push sockets on teardown', async () => {
    const upgrades: SidebarWebUpgradeRoute[] = []
    const effects: Array<() => void | (() => void)> = []
    const ctx: FakeContext = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: () => () => {},
        registerUpgrade: (route) => { upgrades.push(route); return () => {} },
      },
      sessions: { get: () => undefined },
      tools: { register: () => () => {} },
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') effects.push(cleanup)
      },
      inject: () => () => {},
      on: () => () => {},
      get: () => undefined,
    }
    apply(ctx as never)
    const upgrade = upgrades.find(route => route.path === '/sidebar/ws/agent-opens')!
    const { createServer } = await import('node:http')
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      upgrade.handler(req as never, socket as never, head as never)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test setup: no server port')
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/sidebar/ws/agent-opens?sessionId=s-teardown`)
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => { resolve() })
        client.once('error', reject)
      })
      const closed = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { resolve(false) }, 3_000)
        client.once('close', () => { clearTimeout(timer); resolve(true) })
      })
      for (const cleanup of effects) cleanup()
      expect(await closed).toBe(true)
    } finally {
      client.terminate()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('serves HTML previews as UTF-8 without changing the file bytes', async () => {    const directory = mkdtempSync(join(tmpdir(), 'dsh-sidebar-html-utf8-'))
    const path = join(directory, 'fragment.html')
    const source = Buffer.from('<div>排序算法可视化</div>', 'utf8')
    writeFileSync(path, source)
    const routes: SidebarWebRoute[] = []
    const effects: Array<() => void | (() => void)> = []
    const ctx: FakeContext = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: (route) => { routes.push(route); return () => {} },
        registerUpgrade: () => () => {},
      },
      sessions: { get: () => ({ header: { cwd: directory } }) },
      tools: { register: () => () => {} },
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') effects.push(cleanup)
      },
      inject: () => () => {},
      on: () => () => {},
      get: () => undefined,
    }
    try {
      apply(ctx as never)
      const route = routes.find(candidate => candidate.path === '/sidebar/html')!
      // Over a real socket: the route STREAMS its bytes now
      // (`createReadStream` → `pipeline` into the response), which a
      // plain-object response stub cannot accept as a Writable.
      const { createServer } = await import('node:http')
      const server = createServer((req, res) => { void route.handler(req as never, res as never) })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test setup: no server port')
      let response: Response
      try {
        response = await fetch(`http://127.0.0.1:${address.port}${encodeHtmlUrl('s-html', path)}`)
      } finally {
        await new Promise<void>(resolve => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
      }

      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(source)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    } finally {
      for (const cleanup of effects) cleanup()
      removeTree(directory)
    }
  })

  it('runs git status/log/branches against this repository', async () => {
    const cwd = process.cwd()
    const status = await git.status(cwd)
    expect(status.isRepo).toBe(true)
    // PR checkouts have a detached HEAD; compare the native ref rather than
    // invent a branch. The status read answers branch identity itself now
    // (porcelain v2 `--branch`), so detached is an explicit flag.
    const head = spawnSync('git', ['-C', cwd, 'rev-parse', '--symbolic-full-name', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const branch = head === 'HEAD' ? undefined : head.replace(/^refs\/heads\//, '')
    expect(status.detached).toBe(head === 'HEAD')
    expect(status.branch).toBe(branch)
    expect(Array.isArray(status.entries)).toBe(true)
    const log = await git.log(cwd)
    expect(log.length).toBeGreaterThan(0)
    expect(log[0]!.hash).toMatch(/^[0-9a-f]{7,}$/)
    const branches = await git.branches(cwd)
    expect(branches.current).toBe(branch ?? '')
    expect(Array.isArray(branches.names)).toBe(true)
    if (branch !== undefined) expect(branches.names).toContain(branch)
  })

  it('enriches the log (full hash + refs) and renders commit diffs', async () => {
    const cwd = process.cwd()
    const log = await git.log(cwd)
    const first = log[0]!
    expect(first.hashFull).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof first.refs).toBe('string')
    const patch = await git.commitDiff(cwd, first.hashFull)
    expect(patch).toContain('diff --git')
  })

  it('pages the log lazily with skip/count', async () => {
    const cwd = process.cwd()
    const first = await git.log(cwd, 5, 0)
    expect(first).toHaveLength(5)
    const second = await git.log(cwd, 5, 5)
    expect(second).toHaveLength(5)
    // The pages are disjoint windows over the same ordered history.
    expect(first[0]!.hashFull).not.toBe(second[0]!.hashFull)
    const all = await git.log(cwd, 10, 0)
    expect(all.slice(0, 5)).toEqual(first)
    expect(all.slice(5)).toEqual(second)
    // A skip past the end returns an empty page (the lazy loader's stop sign).
    expect(await git.log(cwd, 5, 10_000)).toEqual([])
  })

  it('lists the repository root level', async () => {
    const listing = await listDirectory(process.cwd(), 1000)
    expect(listing.entries.some(entry => entry.name === 'src' && entry.isDir)).toBe(true)
    expect(listing.entries.some(entry => entry.name === 'package.json' && !entry.isDir)).toBe(true)
    expect(listing.truncated).toBe(false)
  })
})

/**
 * Scratch-repository harness shared by the git tests. The fixture's commit
 * identity comes from the GIT_AUTHOR / GIT_COMMITTER environment variables,
 * confined to the fixture process: no git config is touched anywhere (the
 * plugin never sets an identity, and neither does its test fixture).
 */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

/** Run one git command inside a fixture repository (throws on a non-zero exit). */
const gitRun = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...FIXTURE_IDENTITY },
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0] ?? ''} exited with ${String(result.status)}`)
  }
  return result.stdout
}

/**
 * A fresh repo on branch `main` holding the SAME file name at two levels:
 * `README.md` and `pkg/README.md`, committed at `root-v1` / `pkg-v1` and then
 * dirtied to `root-DIRTY` / `pkg-DIRTY`. This is the #765 collision — a
 * session whose cwd is `<repo>/pkg` sends the repository-root-relative status
 * path `README.md`, which also names a file one level below it.
 */
const makeNestedScratchRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-nested-'))
  gitRun(dir, ['init', '-q'])
  // The same eol pin `makeScratchRepo` documents: the content assertions in
  // the nested-cwd tests are byte-exact too.
  gitRun(dir, ['config', 'core.autocrlf', 'false'])
  gitRun(dir, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), 'root-v1\n')
  mkdirSync(join(dir, 'pkg'))
  writeFileSync(join(dir, 'pkg', 'README.md'), 'pkg-v1\n')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'base'])
  writeFileSync(join(dir, 'README.md'), 'root-DIRTY\n')
  writeFileSync(join(dir, 'pkg', 'README.md'), 'pkg-DIRTY\n')
  return dir
}

/**
 * Destructive git operations (discard / revert / cherry-pick) run against a
 * throwaway repository under the OS temp dir — never the plugin repo.
 */
describe('git destructive operations (scratch repository)', () => {
  /** A fresh repo on branch `main` with one committed file `a.txt`. */
  const makeScratchRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-'))
    gitRun(dir, ['init', '-q'])
    // Pin the eol policy: Git for Windows defaults to core.autocrlf=true
    // (system gitconfig on the CI runner, and many dev machines), which
    // smudges LF→CRLF on every index restore and breaks the byte-exact
    // assertions below. The destructive-op behavior under test is orthogonal
    // to the machine's eol policy.
    gitRun(dir, ['config', 'core.autocrlf', 'false'])
    gitRun(dir, ['checkout', '-q', '-b', 'main'])
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    gitRun(dir, ['add', '-A'])
    gitRun(dir, ['commit', '-q', '-m', 'base'])
    return dir
  }

  it('discard restores the worktree file from the index (staged changes kept)', async () => {
    const dir = makeScratchRepo()
    try {
      // Unstaged-only changes: fully reverts to the committed content.
      writeFileSync(join(dir, 'a.txt'), 'one\nCHANGED\nthree\n')
      await git.discard(dir, 'a.txt')
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
      // Staged changes: the worktree snaps back to the STAGED content and
      // the index is untouched (`git checkout -- <path>` restores from the
      // index — VSCode's "Discard Changes" semantics).
      writeFileSync(join(dir, 'a.txt'), 'one\nCHANGED\nthree\n')
      gitRun(dir, ['add', '-A'])
      await git.discard(dir, 'a.txt')
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\nCHANGED\nthree\n')
      const staged = await git.diff(dir, 'a.txt', true)
      expect(staged).toContain('-two')
      expect(staged).toContain('+CHANGED')
    } finally {
      removeTree(dir)
    }
  })

  it('discards the repo-root file, not the same-named one under the session cwd (#765)', async () => {
    // The changes tree's rows carry REPOSITORY-root-relative paths, so a
    // session whose cwd is `<repo>/pkg` still means `<repo>/README.md` when
    // its row says `README.md`. Resolving that name session-relative first
    // restored the same-named file one level down and left the file the row
    // actually named dirty (the destructive half of #765).
    const dir = makeNestedScratchRepo()
    try {
      const route = mountWithSettings()
      const result = await invoke(route, 'git.discard', {
        sessionId: 's-nested',
        cwd: join(dir, 'pkg'),
        path: 'README.md',
      })
      expect(result.ok).toBe(true)
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('root-v1\n')
      // The same-named file under the session cwd was never the target.
      expect(readFileSync(join(dir, 'pkg', 'README.md'), 'utf8')).toBe('pkg-DIRTY\n')
      expect(gitRun(dir, ['status', '--porcelain'])).toBe(' M pkg/README.md\n')
    } finally {
      removeTree(dir)
    }
  })

  it('revert creates a revert commit', async () => {
    const dir = makeScratchRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
      gitRun(dir, ['add', '-A'])
      gitRun(dir, ['commit', '-q', '-m', 'change'])
      const featureHash = (await git.log(dir))[0]!.hashFull
      await git.revert(dir, featureHash)
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
      expect((await git.log(dir))[0]!.subject).toBe('Revert "change"')
    } finally {
      removeTree(dir)
    }
  })

  it('cherry-pick applies a commit from another branch', async () => {
    const dir = makeScratchRepo()
    try {
      gitRun(dir, ['checkout', '-q', '-b', 'feature'])
      writeFileSync(join(dir, 'b.txt'), 'feature work\n')
      gitRun(dir, ['add', '-A'])
      gitRun(dir, ['commit', '-q', '-m', 'feature work'])
      const featureHash = (await git.log(dir))[0]!.hashFull
      gitRun(dir, ['checkout', '-q', 'main'])
      await git.cherryPick(dir, featureHash)
      expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('feature work\n')
      expect((await git.log(dir))[0]!.subject).toBe('feature work')
    } finally {
      removeTree(dir)
    }
  })

  it('reports a failing destructive operation as a GitCommandError', async () => {
    const dir = makeScratchRepo()
    try {
      // An unknown revision fails before touching anything.
      await expect(git.revert(dir, 'deadbeef00000000000000000000000000000000')).rejects.toThrow()
      await expect(git.cherryPick(dir, 'deadbeef00000000000000000000000000000000')).rejects.toThrow()
    } finally {
      removeTree(dir)
    }
  })

  it('never parses a revision-shaped operand as a git option', async () => {
    const dir = makeScratchRepo()
    try {
      const hash = (await git.log(dir))[0]!.hashFull
      // Every revision form the UI actually sends must keep working.
      await expect(git.show(dir, 'HEAD', 'a.txt')).resolves.toContain('one')
      await expect(git.show(dir, hash, 'a.txt')).resolves.toContain('one')
      await expect(git.commitDiff(dir, hash)).resolves.toContain('a.txt')
      // Operand-shaped option strings must NOT be honoured as flags. Before
      // --end-of-options, `show(dir, '--stat', ...)` was consumed as a flag and
      // returned empty, blanking the Changes tab's diff/blame panes.
      for (const hostile of ['--stat', '--output=nul', '-n', '--no-color']) {
        const content = await git.show(dir, hostile, 'a.txt')
        expect(content, hostile).toBeNull()
      }
      await expect(git.commitDiff(dir, '--stat')).rejects.toThrow()
      await expect(git.revert(dir, '--abort')).rejects.toThrow()
      await expect(git.cherryPick(dir, '--abort')).rejects.toThrow()
    } finally {
      removeTree(dir)
    }
  })

  it('keeps the index revision selector (:0) working', async () => {
    // `:0` is git's own index syntax and the UI uses it for the worktree side
    // of a diff, so the operand guard must not reject it.
    const dir = makeScratchRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'staged-change\n')
      gitRun(dir, ['add', 'a.txt'])
      await expect(git.show(dir, ':0', 'a.txt')).resolves.toContain('staged-change')
    } finally {
      removeTree(dir)
    }
  })
})

describe('session cwd resolution over the API route', () => {
  interface CtxOverrides {
    sessions?: { get: (id: string) => { header: { cwd?: string } } | undefined }
    sessionPersistence?: { open: (id: string, access: 'read' | 'write') => Promise<{ header: { cwd?: string }; read: () => Promise<{ events: never[] }>; close: () => Promise<void> }> }
  }

  const mountAll = (overrides: CtxOverrides = {}): SidebarWebRoute[] => {
    const routes: SidebarWebRoute[] = []
    lastMountedRoutes = routes
    const ctx = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
        registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
      },
      sessions: overrides.sessions ?? { get: () => undefined },
      tools: { register: () => () => {} },
      // The vendored cordis runs registration effects immediately.
      effect: (fn: () => void | (() => void)) => { fn() },
      // No settings service: the namespace registration never runs.
      inject: () => () => {},
      // The session/agent event feeds: nothing emits in these tests.
      on: () => () => {},
      // No jobs/agents services in the smoke context: the routes degrade.
      get: (key: string) => key === 'sessionPersistence' ? overrides.sessionPersistence : undefined,
    }
    apply(ctx as never)
    return routes
  }

  const mount = (overrides: CtxOverrides = {}): SidebarWebRoute => mountAll(overrides).find(route => route.path === '/sidebar/api')!

  /** One save through the raw route (see the module-level `invokeRawWrite`). */
  const invokeWrite = invokeRawWrite

  const invoke = async (
    route: SidebarWebRoute,
    method: string,
    payload: unknown,
  ): Promise<{ ok: boolean; status: number; value?: { cwd: string }; error?: { code?: string; message: string } }> => {
    if (method === 'fs.write') {
      return await invokeWrite(payload) as unknown as { ok: boolean; status: number; value?: { cwd: string } }
    }
    const body = Buffer.from(JSON.stringify(payload))
    const req = {
      method: 'POST',
      url: `/sidebar/api/${method}`,
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () { yield body },
    } as never
    const out: { status: number; body: string } = { status: 200, body: '' }
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (chunk: unknown) => { out.body += String(chunk ?? '') },
    } as never
    await route.handler(req, res)
    return { ...JSON.parse(out.body) as { ok: boolean; value?: { cwd: string }; error?: { code?: string; message: string } }, status: out.status }
  }

  const invokeGet = async (route: SidebarWebRoute, url: string): Promise<{ status: number; body: string }> => {
    return (await invokeGetFull(route, url))
  }

  /**
   * invokeGet plus the response headers (for header contracts).
   *
   * Served over a REAL node:http server rather than a plain-object stub: the
   * media and html routes STREAM now (`createReadStream` → `pipeline` into the
   * response), and a fake response object with only `writeHead`/`end` cannot
   * be a Writable. Going through a real socket also means the header
   * assertions exercise node's own header validation, which is what caught the
   * non-latin1 `Content-Disposition` case in the first place.
   */
  const invokeGetFull = async (route: SidebarWebRoute, url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> => {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => { void route.handler(req as never, res as never) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test setup: no server port')
      // The callers spell their URLs two ways (a bare path, and an absolute
      // `http://dsh.internal/...` from the route helpers); only the path and
      // query are meaningful against this ephemeral port.
      const target = new URL(url, 'http://dsh.internal')
      const response = await fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, { redirect: 'manual' })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      return { status: response.status, body: await response.text(), headers }
    } finally {
      // undici keeps the connection alive, and a plain `close()` waits for it:
      // without dropping the sockets first, each call would block until the
      // client's keep-alive timeout and the whole case would crawl past the
      // suite's test timeout.
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }

  it('loads branches and history when switching child repositories and their linked checkouts', async () => {
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'sidebar-multi-repo-')))
    const cwd = join(scratch, 'workspace')
    mkdirSync(cwd)
    const run = (dir: string, args: string[]): void => {
      const result = spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@dsh.invalid', ...args], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
    const a = join(cwd, 'a')
    const b = join(cwd, 'b')
    const linked = join(scratch, 'b-linked')
    const unrelated = join(scratch, 'unrelated')
    try {
      for (const [path, branch] of [[a, 'a-main'], [b, 'b-main'], [unrelated, 'other']]) {
        run(scratch, ['init', '-q', path!])
        run(path!, ['checkout', '-q', '-b', branch!])
        run(path!, ['commit', '-q', '--allow-empty', '-m', branch!])
      }
      run(b, ['worktree', 'add', '-q', '-b', 'b-linked', linked])
      const route = mount({ sessions: { get: () => ({ header: { cwd } }) } })
      const base = { sessionId: 'multi', cwd }
      expect(await invoke(route, 'git.log', base)).toMatchObject({ ok: true, value: [{ subject: 'a-main' }] })
      // Match the UI: inventory first, then both repoRoot and worktree on
      // derived requests. Switching back used to fail just like switching away.
      for (const [repoRoot, worktree, branch, subject] of [
        [b, b, 'b-main', 'b-main'],
        [a, a, 'a-main', 'a-main'],
        [b, linked, 'b-linked', 'b-main'],
      ]) {
        expect(await invoke(route, 'git.worktrees', { ...base, repoRoot })).toMatchObject({ ok: true })
        const payload = { ...base, repoRoot, worktree }
        // Primary status omits worktree, but must still select the child.
        const statusPayload = worktree === repoRoot ? { ...base, repoRoot } : payload
        expect(await invoke(route, 'git.status', statusPayload)).toMatchObject({ ok: true, value: { branch } })
        expect(await invoke(route, 'git.branch', payload)).toMatchObject({ ok: true, value: { current: branch } })
        expect(await invoke(route, 'git.log', { ...payload, count: 1, skip: 0 })).toMatchObject({ ok: true, value: [{ subject }] })
        expect(await invoke(route, 'git.log', { ...payload, count: 1, skip: 1 })).toMatchObject({ ok: true, value: [] })
      }
      for (const worktree of [a, unrelated]) {
        expect(await invoke(route, 'git.log', { ...base, repoRoot: b, worktree })).toMatchObject({ ok: false })
      }
    } finally {
      removeTree(scratch)
    }
  })

  it('git.graph routes selected repositories and worktrees and maps stale cursors', async () => {
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'sidebar-graph-route-')))
    const cwd = join(scratch, 'workspace')
    mkdirSync(cwd)
    const run = (dir: string, args: string[]): void => {
      const result = spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@dsh.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
    const a = join(cwd, 'a')
    const b = join(cwd, 'b')
    const linked = join(scratch, 'linked')
    try {
      for (const path of [a, b]) {
        run(scratch, ['init', '-q', '-b', 'main', path])
        run(path, ['commit', '-q', '--allow-empty', '-m', path === a ? 'a-root' : 'b-root'])
      }
      run(b, ['worktree', 'add', '-q', '--detach', linked])
      run(linked, ['commit', '-q', '--allow-empty', '-m', 'detached-linked'])
      const route = mount({ sessions: { get: () => ({ header: { cwd } }) } })
      const base = { sessionId: 'graph-route', cwd }
      // `git rev-parse --show-toplevel` answers in git's own spelling — the
      // resolved path joined by '/' — while `join()` produced the host
      // separator and (on Windows) Windows' case-insensitive drive/comparison
      // rules apply. Compare path identity, then the rows that selection
      // produced, so the assertion stays about WHICH checkout was selected.
      const pathKey = (path: string): string => {
        const slashed = path.replaceAll('\\', '/').replace(/\/+$/, '')
        return process.platform === 'win32' ? slashed.toLowerCase() : slashed
      }
      const reportedRoot = (result: { value?: { cwd: string } }): string =>
        pathKey((result.value as unknown as { root: string }).root)
      const basePage = await invoke(route, 'git.graph', base)
      expect(basePage).toMatchObject({ ok: true, value: { entries: [{ subject: 'a-root' }] } })
      expect(reportedRoot(basePage)).toBe(pathKey(a))
      const childPage = await invoke(route, 'git.graph', { ...base, repoRoot: b })
      expect(childPage).toMatchObject({ ok: true, value: { entries: [{ subject: 'b-root' }] } })
      expect(reportedRoot(childPage)).toBe(pathKey(b))
      const payload = { ...base, repoRoot: b, worktree: linked, count: 1 }
      const first = await invoke(route, 'git.graph', payload)
      expect(first).toMatchObject({ ok: true, value: { entries: [{ subject: 'detached-linked' }], hasMore: true } })
      expect(reportedRoot(first)).toBe(pathKey(linked))
      const cursor = (first.value as unknown as { nextCursor: string }).nextCursor
      expect(typeof cursor).toBe('string')
      expect(await invoke(route, 'git.graph', { ...payload, cursor })).toMatchObject({ ok: true, value: { entries: [{ subject: 'b-root' }], hasMore: false } })
      run(linked, ['commit', '-q', '--allow-empty', '-m', 'HEAD moved'])
      expect(await invoke(route, 'git.graph', { ...payload, cursor })).toMatchObject({ ok: false, status: 409, error: { code: 'graph-stale' } })
      expect(await invoke(route, 'git.graph', { ...payload, branch: '--all' })).toMatchObject({ ok: false, status: 400, error: { code: 'bad-request' } })
      expect(await invoke(route, 'git.graph', { ...payload, worktree: a })).toMatchObject({ ok: false })
    } finally {
      // scratch is the canonical mkdtemp directory allocated by this test.
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('uses the client summary cwd while the session is detached', async () => {
    const route = mount()
    const result = await invoke(route, 'session.cwd', { sessionId: 's-detached', cwd: '/tmp/summary-cwd' })
    expect(result.ok).toBe(true)
    // The summary cwd passes through requireAbsolute (platform resolve), so
    // the expectation follows the platform's own normalization.
    expect(result.value?.cwd).toBe(resolvePath('/tmp/summary-cwd'))
  })

  it('falls back to the process cwd with no summary cwd', async () => {
    const route = mount()
    const result = await invoke(route, 'session.cwd', { sessionId: 's-unknown' })
    expect(result.ok).toBe(true)
    expect(result.value?.cwd).toBe(process.cwd())
  })

  it('answers 404 for Object.prototype member names instead of resolving them as methods', async () => {
    // The dispatch table is an object literal, so a bare lookup used to find
    // Object.prototype members and treat them as handlers: `constructor`
    // answered 200 {}, `toString` answered 200 "[object Undefined]", and
    // `valueOf` / `hasOwnProperty` answered 500. All must be the documented 404.
    const route = mount()
    for (const method of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const result = await invoke(route, method, {})
      expect(result, method).toMatchObject({ ok: false, status: 404, error: { code: 'not-found' } })
    }
    // A genuinely unknown method keeps its existing 404 contract.
    const unknown = await invoke(route, 'no-such-method', {})
    expect(unknown).toMatchObject({ ok: false, status: 404, error: { code: 'not-found' } })
  })

  it('reports a git failure as a 4xx git error, not an internal 500', async () => {
    // `GitCommandError` used to fall through to the generic branch and surface
    // as 500 "internal", which reads as a plugin crash and hid the localized
    // not-a-repository copy the client already renders. A non-repository cwd
    // must answer 409 not-repo.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-notrepo-'))
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: dir } }) } })
      const notRepo = await invoke(route, 'git.branch', { sessionId: 's', cwd: dir })
      expect(notRepo).toMatchObject({ ok: false, status: 409, error: { code: 'not-repo' } })
      expect(notRepo.error?.message).not.toContain('internal')
    } finally {
      removeTree(dir)
    }
  })

  it('resolves a cold (detached) session cwd through the persistence index', async () => {
    // Regression: a detached first request (session not yet attached, no
    // client cwd) must resolve the cwd from the session-persistence index
    // instead of the host process cwd. On Windows the host process cwd is
    // the DSH source root (dsh.cmd's `pushd`), so every user-project path
    // was misclassified as "outside workspace" by the realpath guard.
    const coldCwd = resolvePath('/cold-project-cwd')
    const route = mount({
      sessionPersistence: {
        open: async (id) => ({
          header: id === 's-cold' ? { cwd: coldCwd } : {},
          read: async () => ({ events: [] }),
          close: async () => {},
        }),
      },
    })
    const result = await invoke(route, 'session.cwd', { sessionId: 's-cold' })
    expect(result.ok).toBe(true)
    expect(result.value?.cwd).toBe(coldCwd)
  })

  it('rejects a relative cwd from the persistence index', async () => {
    // A buggy / corrupt persistence layer that stored a relative cwd must
    // be rejected by requireAbsolute instead of flowing into the workspace
    // guard, where it would be resolved against the host process cwd and
    // potentially recreate the original "outside workspace" misclassification.
    const route = mount({
      sessionPersistence: {
        open: async () => ({ header: { cwd: 'relative/path' }, read: async () => ({ events: [] }), close: async () => {} }),
      },
    })
    const result = await invoke(route, 'session.cwd', { sessionId: 's-bad' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/invalid working directory/)
  })

  it('falls back to the process cwd when persistence has no cwd for the session', async () => {
    const route = mount({
      sessionPersistence: {
        open: async () => ({ header: {}, read: async () => ({ events: [] }), close: async () => {} }),
      },
    })
    const result = await invoke(route, 'session.cwd', { sessionId: 's-blank' })
    expect(result.ok).toBe(true)
    expect(result.value?.cwd).toBe(process.cwd())
  })

  it('prefers the attached session header over the client summary', async () => {
    const route = mount({
      sessions: {
        get: (id) => id === 's-attached' ? { header: { cwd: '/attached-cwd' } } : undefined,
      },
    })
    const result = await invoke(route, 'session.cwd', { sessionId: 's-attached', cwd: '/tmp/summary-cwd' })
    expect(result.ok).toBe(true)
    expect(result.value?.cwd).toBe('/attached-cwd')
  })

  it('rejects a non-absolute client cwd', async () => {
    const route = mount()
    const result = await invoke(route, 'session.cwd', { sessionId: 's-detached', cwd: 'relative/path' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/invalid working directory/)
  })

  it('git.diff resolves repo-relative paths (session in a subdirectory)', async () => {
    // The plugin repo's status paths are relative to the repo top level
    // (e.g. `src/git.ts`); a session whose cwd sits inside the repo must
    // still load per-file diffs instead of failing with "not an absolute
    // path". The session header points INTO the repository.
    const route = mount({
      sessions: {
        get: () => ({ header: { cwd: join(process.cwd(), 'src') } }),
      },
    })
    const result = await invoke(route, 'git.diff', { sessionId: 's-sub', path: 'src/git.ts', staged: false })
    expect(result.ok).toBe(true)
    const value = result as unknown as { ok: boolean; value?: { diff: string } }
    expect(typeof value.value?.diff).toBe('string')
  })

  it('git.diff previews the repo-root file when the session cwd holds a same-named one (#765)', async () => {
    // Same rows, but the collision is real: `<repo>/pkg/README.md` EXISTS, so
    // a session-relative first resolution previewed that file's change while
    // the row named `<repo>/README.md` (the preview half of #765).
    const dir = makeNestedScratchRepo()
    try {
      const route = mount({
        sessions: {
          get: () => ({ header: { cwd: join(dir, 'pkg') } }),
        },
      })
      const result = await invoke(route, 'git.diff', { sessionId: 's-nested', path: 'README.md', staged: false })
      expect(result.ok).toBe(true)
      const diff = (result as unknown as { value?: { diff: string } }).value?.diff ?? ''
      expect(diff).toContain('a/README.md b/README.md')
      expect(diff).toContain('+root-DIRTY')
      expect(diff).not.toContain('pkg-DIRTY')
    } finally {
      removeTree(dir)
    }
  })

  it('fs.read resolves repo-relative paths (untracked diff fallback)', async () => {
    const route = mount({
      sessions: {
        get: () => ({ header: { cwd: join(process.cwd(), 'src') } }),
      },
    })
    const result = await invoke(route, 'fs.read', { sessionId: 's-sub', path: 'src/git.ts' })
    expect(result.ok).toBe(true)
    const value = result as unknown as { ok: boolean; value?: { kind: string; content: string } }
    expect(value.value?.kind).toBe('text')
    expect(value.value?.content).toContain('runGit')
  })

  it('reads repo-root-relative paths outside a nested session workspace (fence removed)', async () => {
    const route = mount({
      sessions: {
        get: () => ({ header: { cwd: join(process.cwd(), 'src') } }),
      },
    })
    // ⚠️ PERMISSION CHANGE: `package.json` sits ABOVE the nested session cwd.
    // The containment guard is gone, so this now reads like any other path.
    const result = await invoke(route, 'fs.read', { sessionId: 's-sub', path: 'package.json' })
    expect(result.ok).toBe(true)
    expect((result.value as { content?: string } | undefined)?.content).toContain('"name"')
  })

  it('lists a directory outside the session workspace (fence removed)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'secret')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const tree = await invoke(route, 'fs.tree', { sessionId: 'security', path: outside })
      expect(tree.ok).toBe(true)
      const value = tree.value as unknown as { path: string; entries: Array<{ name: string }> }
      expect(value.path).toBe(outside)
      expect(value.entries.map(entry => entry.name)).toEqual(['secret.txt'])
    } finally {
      removeTree(root)
    }
  })

  it('reads a file outside the session workspace (fence removed)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'secret')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const read = await invoke(route, 'fs.read', { sessionId: 'security', path: outsideFile })
      expect(read.ok).toBe(true)
      expect((read.value as unknown as { kind: string; content: string }).content).toBe('secret')
    } finally {
      removeTree(root)
    }
  })

  it('writes a file outside the session workspace (fence removed)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const written = join(outside, 'written.txt')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const write = await invoke(route, 'fs.write', { sessionId: 'security', path: written, content: 'hack' })
      expect(write.ok).toBe(true)
      expect(readFileSync(written, 'utf8')).toBe('hack')
    } finally {
      removeTree(root)
    }
  })

  it('serves relative previews and assets without rewriting external absolute paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-preview-paths-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(join(workspace, 'pages'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(workspace, 'pages', 'report.html'), '<link rel="stylesheet" href="./style.css"><p>workspace</p>')
    writeFileSync(join(workspace, 'pages', 'style.css'), 'body { color: red; }')
    const external = join(outside, 'report.html')
    writeFileSync(external, '<p>external</p>')
    // A shadow at the old fallback destination must never win.
    const shadow = join(workspace, external.replace(/^[\\/]+/, ''))
    if (process.platform !== 'win32') {
      mkdirSync(dirname(shadow), { recursive: true })
      writeFileSync(shadow, '<p>wrong shadow</p>')
    }
    try {
      const routes = mountAll({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const html = routes.find(route => route.path === '/sidebar/html')!
      const file = routes.find(route => route.path === '/sidebar/file')!
      const scope = { sessionId: 'preview', cwd: workspace }
      const page = htmlUrl(scope, 'pages/report.html')
      expect(await invokeGet(html, page)).toMatchObject({ status: 200, body: expect.stringContaining('workspace') })
      const asset = new URL('./style.css', new URL(page, 'http://localhost')).pathname
      expect(await invokeGet(html, asset)).toMatchObject({ status: 200, body: 'body { color: red; }' })
      // Missing cwd exercises the server's relative-only fallback.
      expect(await invokeGet(file, downloadUrl({ sessionId: scope.sessionId }, 'pages/report.html')))
        .toMatchObject({ status: 200, body: expect.stringContaining('workspace') })
      expect(await invokeGet(html, htmlUrl(scope, external)))
        .toMatchObject({ status: 200, body: '<p>external</p>' })
      expect(await invokeGet(file, downloadUrl(scope, external)))
        .toMatchObject({ status: 200, body: '<p>external</p>' })
      rmSync(external)
      // A path that cannot be opened is the route's own 4xx now, not a bare
      // stat() rejection escaping as an internal 500: the stream helper opens
      // the file BEFORE committing the response precisely so this stays a
      // usable error envelope.
      expect((await invokeGet(html, htmlUrl(scope, external))).status).toBe(400)
      expect((await invokeGet(file, downloadUrl(scope, external))).status).toBe(400)
    } finally {
      removeTree(root)
    }
  })

  it('concurrent fs.write calls to the same path do not corrupt each other', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-concurrent-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const target = join(workspace, 'notes.txt')
      const draftA = 'A'.repeat(200000)
      const draftB = 'B'.repeat(200000)
      // Two editors of the same file ("open to the side" mints a second tab
      // for one path) saving within the temp→rename window. Guards the
      // contract: every concurrent save succeeds and the published file is
      // one complete draft (never byte-mixed, never a failed rename).
      const results = await Promise.allSettled([
        invoke(route, 'fs.write', { sessionId: 'concurrent', path: target, content: draftA }),
        invoke(route, 'fs.write', { sessionId: 'concurrent', path: target, content: draftB }),
      ])
      for (const result of results) expect(result.status).toBe('fulfilled')
      const written = readFileSync(target, 'utf8')
      expect([draftA, draftB]).toContain(written)
    } finally {
      removeTree(root)
    }
  })

  it('fs.write keeps the on-disk encoding of a GBK file (#523)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-encoding-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const target = join(workspace, 'legacy.cmd')
      const text = '@echo off\r\necho 中文测试\r\n'
      writeFileSync(target, encodeText(text, 'gbk'))
      const read = await invoke(route, 'fs.read', { sessionId: 'encoding', path: target })
      const value = read.value as { kind?: string; content?: string } | undefined
      // The CP936 bytes decode to the text the file means, not to mojibake.
      expect(value?.kind).toBe('text')
      expect(value?.content).toBe(text)
      // Saving that text back must not silently convert the file to UTF-8.
      const write = await invoke(route, 'fs.write', { sessionId: 'encoding', path: target, content: value?.content })
      expect(write.ok).toBe(true)
      expect(readFileSync(target).equals(encodeText(text, 'gbk'))).toBe(true)
    } finally {
      removeTree(root)
    }
  })

  it('fs.read answers a CJK UTF-8 file past the editable threshold as too-large (#523)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-readcap-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const target = join(workspace, 'big.txt')
      // This file used to be read with a 512 KiB cap that landed two bytes
      // into a three-byte character; the GBK probe accepted that partial tail,
      // so the read came back as 涓枃-style mojibake. There is no capped read
      // any more — an over-limit document is refused as a document and served
      // through the paged preview instead, which is what removes the whole
      // class of bug: no truncated buffer ever reaches a decoder.
      // Past the 5 MiB editable threshold (3 bytes per character, so a little
      // over 1.75 M characters), which is what routes it to the paged preview.
      const content = '中'.repeat(1_800_000)
      expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(5 * 1024 * 1024)
      writeFileSync(target, Buffer.from(content, 'utf8'))
      const result = await invoke(route, 'fs.read', { sessionId: 'readcap', path: target })
      const value = result.value as { kind?: string; size?: number; content?: string; head?: string } | undefined
      expect(value?.kind).toBe('too-large')
      expect(value?.size).toBe(Buffer.byteLength(content, 'utf8'))
      // No document rides along — that is the point.
      expect(value?.content).toBeUndefined()
      // The 4 KiB sniff head still does, and it is valid UTF-8 including a
      // whole number of characters (the reader takes a byte prefix, and the
      // paged route is what reassembles text).
      expect(typeof value?.head).toBe('string')
      expect(Buffer.from(value!.head!, 'base64').length).toBe(4096)
    } finally {
      removeTree(root)
    }
  })

  it('serves a home-relative media path (the ~ marker reaches the shared resolver, #713)', async () => {
    // A real file under the user's home: the ~ expansion must happen on the
    // ROUTE side (resolveTarget), not be pre-joined onto the session cwd.
    const dirName = `.dsh-sidebar-selftest-${process.pid.toString(36)}`
    const dir = join(homedir(), dirName)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'note.txt')
    writeFileSync(target, 'home sweet home')
    try {
      const routes = mountAll({ sessions: { get: () => ({ header: { cwd: dir } }) } })
      const file = routes.find(route => route.path === '/sidebar/file')!
      expect(await invokeGet(file, downloadUrl({ sessionId: 'home' }, `~/${dirName}/note.txt`)))
        .toMatchObject({ status: 200, body: 'home sweet home' })
    } finally {
      removeTree(dir)
    }
  })

  it('serves media and HTML through a workspace symlink (fence removed)', async () => {
    if (!canCreateSymlink) return
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-route-symlink-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const mediaPath = join(outside, 'pic.png')
    const htmlPath = join(outside, 'page.html')
    // A real 1x1 PNG: the media route sniffs the magic bytes, a text file
    // would be refused as "not a file or too large" for the wrong reason.
    writeFileSync(mediaPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))
    writeFileSync(htmlPath, '<p>outside</p>')
    try {
      symlinkSync(outside, join(workspace, 'link'))
      const routes = mountAll({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const media = routes.find(route => route.path === '/sidebar/file')!
      const html = routes.find(route => route.path === '/sidebar/html')!
      const mediaResult = await invokeGet(media, `/sidebar/file?sessionId=security&path=${encodeURIComponent(join(workspace, 'link', 'pic.png'))}`)
      // Use the production encoder so the URL is well-formed on every
      // platform (a Windows drive path needs the leading slash separator
      // that a naive join-without-separator drops).
      const htmlResult = await invokeGet(html, encodeHtmlUrl('security', join(workspace, 'link', 'page.html')))
      expect(mediaResult).toMatchObject({ status: 200 })
      expect(htmlResult).toMatchObject({ status: 200 })
      expect(htmlResult.body).toContain('outside')
    } finally {
      removeTree(root)
    }
  })

  it('serves an SVG with a sandboxing CSP so a direct navigation cannot run its script', async () => {
    // An SVG is a scriptable document. Served bare on the GUI origin, opening
    // this URL directly runs its <script> with same-origin access to
    // /sidebar/api/*. The html route already sandboxes; the media route must
    // match. <img> embedding is unaffected (CSP applies to documents).
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-svg-security-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const svgPath = join(workspace, 'logo.svg')
    writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    try {
      const routes = mountAll({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const media = routes.find(route => route.path === '/sidebar/file')!
      const res = await invokeGetFull(media, `/sidebar/file?sessionId=security&path=${encodeURIComponent(svgPath)}`)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('image/svg+xml')
      expect(res.headers['content-security-policy']).toContain('sandbox')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    } finally {
      removeTree(root)
    }
  })

  it('serves a preview document and its relative assets with usable content types (#959)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-html-assets-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    mkdirSync(join(workspace, 'css'))
    mkdirSync(join(workspace, 'js'))
    const page = join(workspace, 'index.html')
    const stylesheet = join(workspace, 'css', 'style.css')
    const script = join(workspace, 'js', 'app.js')
    writeFileSync(page, '<link rel="stylesheet" href="css/style.css"><script src="js/app.js"></script>')
    writeFileSync(stylesheet, 'body { color: #c00 }')
    writeFileSync(script, 'console.log("preview")')
    try {
      const routes = mountAll({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const html = routes.find(route => route.path === '/sidebar/html')!
      const media = routes.find(route => route.path === '/sidebar/file')!
      const document = await invokeGetFull(html, encodeHtmlUrl('assets', page))
      expect(document.status).toBe(200)
      expect(document.headers['content-type']).toBe('text/html; charset=utf-8')
      const css = await invokeGetFull(html, encodeHtmlUrl('assets', stylesheet))
      expect(css.status).toBe(200)
      expect(css.headers['content-type']).toBe('text/css')
      const js = await invokeGetFull(html, encodeHtmlUrl('assets', script))
      expect(js.status).toBe(200)
      expect(js.headers['content-type']).toBe('text/javascript')
      // Blast radius: the MEDIA route must not start rendering these either —
      // /sidebar/file still hands the same file over as bytes (forced download),
      // so the new types exist only inside the previewer.
      const mediaCss = await invokeGetFull(media, `/sidebar/file?sessionId=assets&path=${encodeURIComponent(stylesheet)}`)
      expect(mediaCss.status).toBe(200)
      expect(mediaCss.headers['content-type']).toBe('application/octet-stream')
    } finally {
      removeTree(root)
    }
  })

  it('leaves an ordinary image response free of the SVG sandbox headers', async () => {
    // The guard is scoped to the scriptable type: a PNG must not gain a
    // sandbox directive (nothing to sandbox, and it would be a behaviour
    // change for existing image previews).
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-png-security-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const pngPath = join(workspace, 'pixel.png')
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    try {
      const routes = mountAll({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const media = routes.find(route => route.path === '/sidebar/file')!
      const res = await invokeGetFull(media, `/sidebar/file?sessionId=security&path=${encodeURIComponent(pngPath)}`)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['content-security-policy']).toBeUndefined()
    } finally {
      removeTree(root)
    }
  })

  it('keeps fs.tree missing-path failures as fs errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-security-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const tree = await invoke(route, 'fs.tree', { sessionId: 'security', path: join(workspace, 'missing') })
      expect(tree).toMatchObject({ ok: false, status: 400, error: { code: 'fs-error' } })
    } finally {
      removeTree(root)
    }
  })

  it('fs.trees returns every requested level in one batch, errors in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-trees-'))
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'a')
    writeFileSync(join(workspace, 'src', 'deep', 'b.ts'), 'b')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const result = await invoke(route, 'fs.trees', {
        sessionId: 's-tree',
        // A relative path, an absolute path and one that does not exist: the
        // batch answers all three, the failure only on its own level.
        paths: ['src', join(workspace, 'src', 'deep'), join(workspace, 'missing')],
      })
      expect(result.ok).toBe(true)
      const levels = (result.value as unknown as { levels: Array<{ path: string; entries: Array<{ name: string }>; truncated: boolean; error?: string }> }).levels
      expect(levels).toHaveLength(3)
      expect(levels[0]).toMatchObject({ path: join(workspace, 'src'), truncated: false })
      expect(levels[0]!.entries.map(entry => entry.name)).toEqual(['deep', 'a.ts'])
      expect(levels[1]!.entries.map(entry => entry.name)).toEqual(['b.ts'])
      expect(levels[1]!.error).toBeUndefined()
      expect(levels[2]!.path).toBe(join(workspace, 'missing'))
      expect(levels[2]!.entries).toEqual([])
      expect(levels[2]!.truncated).toBe(false)
      expect(levels[2]!.error).toMatch(/missing/)
    } finally {
      removeTree(root)
    }
  })

  it('fs.trees warms the same cache fs.tree reads (and vice versa)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-trees-cache-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'a.txt'), 'a')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const batch = await invoke(route, 'fs.trees', { sessionId: 's-tree', paths: [workspace] })
      expect(batch.ok).toBe(true)
      const level = (batch.value as unknown as { levels: Array<{ entries: Array<{ name: string }> }> }).levels[0]!
      // A file created after the batch is invisible to the single-path route
      // too — proof the two routes share one cache entry.
      writeFileSync(join(workspace, 'b.txt'), 'b')
      const single = await invoke(route, 'fs.tree', { sessionId: 's-tree', path: workspace })
      expect((single.value as unknown as { entries: Array<{ name: string }> }).entries.map(entry => entry.name))
        .toEqual(level.entries.map(entry => entry.name))
    } finally {
      removeTree(root)
    }
  })

  it('fs.trees and fs.search apply the request exclude patterns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-exclude-'))
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, 'third_party', 'pkg'), { recursive: true })
    writeFileSync(join(workspace, '.DS_Store'), 'junk')
    writeFileSync(join(workspace, 'src', 'index.ts'), 'code')
    writeFileSync(join(workspace, 'third_party', 'index.ts'), 'dep')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      // `fs.trees` is the file tree's REAL entry (one POST per mount/expand):
      // the exclude list has to reach this route or the pref does nothing.
      const batch = await invoke(route, 'fs.trees', {
        sessionId: 's-tree',
        paths: [workspace],
        exclude: ['.DS_Store', 'third_party'],
      })
      expect(batch.ok).toBe(true)
      const levels = (batch.value as unknown as { levels: Array<{ entries: Array<{ name: string }> }> }).levels
      expect(levels[0]!.entries.map(entry => entry.name)).toEqual(['src'])
      // The search shares the one compiled matcher: excluded names never match
      // and are never descended (a directory hit disappears with them).
      const search = await invoke(route, 'fs.search', {
        sessionId: 's-tree',
        query: 'index',
        exclude: ['third_party'],
      })
      expect((search.value as unknown as { matches: string[] }).matches).toEqual(['src/index.ts'])
      // No exclude on the request → the unfiltered fast path, unchanged.
      const plain = await invoke(route, 'fs.trees', { sessionId: 's-tree', paths: [workspace] })
      const plainLevels = (plain.value as unknown as { levels: Array<{ entries: Array<{ name: string }> }> }).levels
      expect(plainLevels[0]!.entries.map(entry => entry.name)).toEqual(['src', 'third_party', '.DS_Store'])
    } finally {
      removeTree(root)
    }
  })

  // #879: a pasted absolute path is an open-this-file gesture, not a name
  // filter. The route returns the stat'ed target as the single hit (the
  // client resolves absolute match rows straight to the editor), and a
  // missing target is an immediate empty result instead of a walk that burns
  // its whole visit budget to report the same nothing.
  it('fs.search stats an absolute query into a single direct-open hit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-search-path-'))
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'index.ts'), 'code')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const target = join(workspace, 'src', 'index.ts')
      const hit = await invoke(route, 'fs.search', { sessionId: 's-search', query: target })
      expect(hit.value).toEqual({ matches: [target], dirs: [], truncated: false })
      const miss = await invoke(route, 'fs.search', { sessionId: 's-search', query: join(workspace, 'gone.ts') })
      expect(miss.value).toEqual({ matches: [], dirs: [], truncated: false })
      // A relative fragment searches the workspace tree by PATH (the name
      // walk can never match a separator-carrying query), and a dot-anchored
      // spelling resolves against the session cwd like fs.read does.
      const fragment = await invoke(route, 'fs.search', { sessionId: 's-search', query: 'src/index' })
      expect(fragment.value).toEqual({ matches: ['src/index.ts'], dirs: [], truncated: false })
      const anchored = await invoke(route, 'fs.search', { sessionId: 's-search', query: './src/index.ts' })
      expect(anchored.value).toEqual({ matches: [join(workspace, 'src', 'index.ts')], dirs: [], truncated: false })
    } finally {
      removeTree(root)
    }
  })

  it('fs.trees rejects an empty list and an oversized batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-trees-guard-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const empty = await invoke(route, 'fs.trees', { sessionId: 's-tree', paths: [] })
      expect(empty).toMatchObject({ ok: false, status: 400, error: { code: 'bad-request' } })
      const tooMany = await invoke(route, 'fs.trees', {
        sessionId: 's-tree',
        paths: Array.from({ length: FS_TREES_MAX_PATHS + 1 }, () => workspace),
      })
      expect(tooMany).toMatchObject({ ok: false, status: 400, error: { code: 'bad-request' } })
    } finally {
      removeTree(root)
    }
  })

  it('fs.trees shares ONE probe gate across the batch levels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-trees-gate-'))
    const workspace = join(root, 'workspace')
    const level = join(workspace, 'level')
    mkdirSync(level, { recursive: true })
    for (let index = 0; index < 3; index += 1) {
      mkdirSync(join(level, `only-${index}`))
      writeFileSync(join(level, `only-${index}`, 'child.txt'), 'x')
    }
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const before = probeGateCalls.length
      const answer = await invoke(route, 'fs.trees', { sessionId: 's-tree-gate', paths: [workspace, level] })
      expect(answer.ok).toBe(true)
      // ONE gate for the whole request: a per-level gate would let each level's
      // probe pool run at full width, which is the runaway this bounds.
      expect(probeGateCalls.length - before).toBe(1)
      // The shared budget changed nothing about what the levels report. (The
      // local `invoke` types `value` as its cwd probe, hence the double cast.)
      const levels = (answer.value as unknown as {
        levels: { path: string; entries: { compact?: boolean }[] }[]
      }).levels
      expect(levels.find(entry => entry.path === level)?.entries.filter(row => row.compact === true)).toHaveLength(3)
    } finally {
      removeTree(root)
    }
  })

  it('fs.tree builds one probe gate for its single level', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-tree-gate-'))
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'only'), { recursive: true })
    writeFileSync(join(workspace, 'only', 'child.txt'), 'x')
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const before = probeGateCalls.length
      const answer = await invoke(route, 'fs.tree', { sessionId: 's-tree-single-gate', path: workspace })
      expect(answer.ok).toBe(true)
      // The single-layer route is a probe-bounded request too: it lists ONE
      // level, but that level runs the same per-row probes (`fs.trees` passes
      // a gate for exactly this reason), so it must build one as well.
      expect(probeGateCalls.length - before).toBe(1)
      const entries = (answer.value as unknown as { entries: { compact?: boolean }[] }).entries
      expect(entries.filter(entry => entry.compact === true)).toHaveLength(1)
    } finally {
      removeTree(root)
    }
  })

  it.skipIf(!canCreateSymlink)('lists a workspace symlink that resolves outside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-symlink-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      symlinkSync(outside, join(workspace, 'link'))
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      // No realpath: the link is followed like any other directory.
      const tree = await invoke(route, 'fs.tree', { sessionId: 'security', path: join(workspace, 'link') })
      expect(tree.ok).toBe(true)
      expect((tree.value as unknown as { entries: Array<{ name: string }> }).entries.map(entry => entry.name)).toEqual(['secret.txt'])
    } finally {
      removeTree(root)
    }
  })

  it.skipIf(!canCreateSymlink)('reads through a workspace symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-symlink-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      symlinkSync(outside, join(workspace, 'link'))
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const read = await invoke(route, 'fs.read', { sessionId: 'security', path: join(workspace, 'link', 'secret.txt') })
      expect(read.ok).toBe(true)
      expect((read.value as unknown as { content: string }).content).toBe('secret')
    } finally {
      removeTree(root)
    }
  })

  it.skipIf(!canCreateSymlink)('writes through a workspace symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-symlink-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    try {
      symlinkSync(outside, join(workspace, 'link'))
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const write = await invoke(route, 'fs.write', { sessionId: 'security', path: join(workspace, 'link', 'new.txt'), content: 'hack' })
      expect(write.ok).toBe(true)
      // The write landed on the link's TARGET (the link is not replaced).
      expect(readFileSync(join(outside, 'new.txt'), 'utf8')).toBe('hack')
    } finally {
      removeTree(root)
    }
  })
})
/**
 * One save through `POST /sidebar/write`, resolved against the most recent
 * mount (see {@link lastMountedRoutes}).
 * @param payload - `{ sessionId, cwd?, path, content, expectedMtimeMs? }`.
 * @returns the parsed envelope.
 */
const invokeRawWrite = async (payload: unknown): Promise<{
  ok: boolean
  value?: unknown
  error?: { code?: string; message: string }
}> => {
  const route = lastMountedRoutes.find(candidate => candidate.path === '/sidebar/write')
  if (route === undefined) throw new Error('test setup: no /sidebar/write route was mounted')
  const record = payload as { sessionId: string; cwd?: string; path: string; content?: unknown; expectedMtimeMs?: number }
  const params = new URLSearchParams({ sessionId: record.sessionId, path: record.path })
  if (record.cwd !== undefined) params.set('cwd', record.cwd)
  if (record.expectedMtimeMs !== undefined) params.set('expectedMtimeMs', String(record.expectedMtimeMs))
  const body = Buffer.from(String(record.content ?? ''), 'utf8')
  const req = {
    method: 'POST',
    url: `/sidebar/write?${params.toString()}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out: { status: number; body: string } = { status: 200, body: '' }
  const res = {
    headersSent: false,
    writeHead: (status: number) => { out.status = status },
    write: () => true,
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return JSON.parse(out.body) as { ok: boolean; error?: { code?: string; message: string } }
}

/**
 * Invoke one `/sidebar/api/<method>` route against a fake Socket-ish pair.
 * @param route - the mounted prefix route.
 * @param method - the API method name.
 * @param payload - the JSON request body.
 * @returns the parsed envelope.
 */
const invoke = async (route: SidebarWebRoute, method: string, payload: unknown): Promise<{
  ok: boolean
  value?: unknown
  error?: { code?: string; message: string }
}> => {
  // The editor save is its own raw route now (the document IS the body), so it
  // is dispatched rather than posted to `/sidebar/api`. Both `invoke` helpers
  // in this file do this; see `lastMountedRoutes` for how the route is found.
  if (method === 'fs.write') return await invokeRawWrite(payload)
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out: { status: number; body: string } = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return JSON.parse(out.body) as { ok: boolean; value?: unknown; error?: { code?: string; message: string } }
}

/** The Loader entry id this plugin's row is mounted under in these tests. */
const ENTRY_ID = 'better-sidebar'
/** The fiber that row owns; the plugin matches it by identity. */
const PLUGIN_FIBER = { name: 'dsh-better-sidebar' }

/**
 * A minimal settings FORMS seam: `describe`/`update`/`configure` over one
 * entry, with the revision guard. DSH 0.1.7 replaced the registrable namespace
 * with exactly this shape, so the plugin no longer owns the schema — it
 * reports what `describe` gives it and writes through `update`.
 * @param pre - user-layer values staged per entry id before the plugin mounts.
 */
const createFakeSettings = (pre?: Record<string, Record<string, unknown>>) => {
  // The plugin's own row always exists in a real profile — it IS the row that
  // mounted the plugin — so its form is addressable before anything is written.
  const rows = new Map<string, { value: Record<string, unknown>; revision: number }>([
    [ENTRY_ID, { value: {}, revision: 0 }],
  ])
  for (const [ns, value] of Object.entries(pre ?? {})) rows.set(ns, { value, revision: 0 })
  return {
    describe(options?: { redactSecrets?: boolean }) {
      return [...rows.entries()].map(([ns, row]) => ({
        ns,
        value: { ...SIDEBAR_PREFS_DEFAULTS, ...row.value },
        revision: row.revision,
        ...(options?.redactSecrets === true ? {} : { user: row.value }),
      }))
    },
    async update(ns: string, patch: Record<string, unknown>, expectedRevision?: number) {
      const row = rows.get(ns)
      if (row === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
      if (expectedRevision !== undefined && expectedRevision !== row.revision) {
        throw new SettingsConflictError(ns as SettingsNamespace, expectedRevision, row.revision)
      }
      row.value = { ...row.value, ...patch }
      row.revision += 1
    },
    configure() {
      return () => {}
    },
  }
}

/**
 * Mount the host plugin against a fake context carrying a settings seam.
 * @param settings - the settings forms fake; omit to simulate a deployment with none.
 * @param home - a harness home holding a retired `settings.yaml`, when the test wants the legacy import to run.
 * @returns the mounted `/sidebar/api` route.
 */
const mountWithSettings = (settings?: unknown, home?: string): SidebarWebRoute => {
  const routes: SidebarWebRoute[] = []
  lastMountedRoutes = routes
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
    },
    sessions: { get: () => undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: (deps: string[], callback: (sctx: { settings: unknown }) => void) => {
      if (deps.includes('settings') && settings !== undefined) callback({ settings })
      return () => {}
    },
    // The session/agent event feeds: nothing emits in these tests.
    on: () => () => {},
    // No jobs/agents services: the jobs routes degrade to a 503.
    get: () => undefined,
    fiber: PLUGIN_FIBER,
    // The plugin discovers its own settings entry id from the loader, so a
    // fake without these entries has NO settings face at all.
    loader: {
      entries: () => [{ options: { id: ENTRY_ID, name: 'dsh-better-sidebar' }, fiber: PLUGIN_FIBER }],
          // The real loader settles before a form is addressable; the fake
          // resolves immediately so the import runs on the same tick.
          await: () => Promise.resolve(),
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    ...(home === undefined ? {} : { profileContext: { home } }),
  }
  apply(ctx as never)
  return routes.find(route => route.path === '/sidebar/api')!
}

describe('open.external route', () => {
  it('rejects an unknown action with bad-request (before anything spawns)', async () => {
    const route = mountWithSettings()
    const result = await invoke(route, 'open.external', { action: 'open-ish', path: '/tmp/a.txt' })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('rejects http(s) URLs and relative reveal paths before spawning', async () => {
    const route = mountWithSettings()
    const https = await invoke(route, 'open.external', { action: 'url', url: 'https://example.com' })
    expect(https).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const relative = await invoke(route, 'open.external', { action: 'reveal', path: 'relative/path' })
    expect(relative).toMatchObject({ ok: false, error: { code: 'fs-error' } })
    // A missing field never reaches launchExternal either.
    const empty = await invoke(route, 'open.external', { action: 'url' })
    expect(empty).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
})

describe('side card settings routes', () => {
  it('serves the schema defaults when the settings service is absent', async () => {
    const route = mountWithSettings(undefined)
    const result = await invoke(route, 'settings.get', {})
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ value: undefined, revision: undefined, externalDisable: false })
  })

  it('reports externalDisable false when the aionui entry is absent', async () => {
    const route = mountWithSettings(createFakeSettings())
    const result = await invoke(route, 'settings.get', {})
    expect(result.ok).toBe(true)
    expect((result.value as { externalDisable?: boolean }).externalDisable).toBe(false)
  })

  it('reports externalDisable true while the aionui provider is selected', async () => {
    const route = mountWithSettings(createFakeSettings({ 'aionui-panel': { rightPanel: 'aionui-panel' } }))
    const result = await invoke(route, 'settings.get', {})
    expect(result.ok).toBe(true)
    expect((result.value as { externalDisable?: boolean }).externalDisable).toBe(true)
  })

  it('passes the entry form through and writes a patch back into it', async () => {
    const route = mountWithSettings(createFakeSettings())
    const read = await invoke(route, 'settings.get', {})
    expect(read.ok).toBe(true)
    const view = read.value as { value: Record<string, unknown>; revision: number }
    expect(view.revision).toBe(0)
    // The form belongs to the ENTRY, so what the route reports is exactly the
    // field set this plugin's own preference contract declares.
    expect(Object.keys(view.value).sort()).toEqual(Object.keys(SIDEBAR_PREFS_DEFAULTS).sort())
    expect(view.value).toMatchObject({
      autoOpenSubagent: true,
      autoOpenJobs: true,
      agentOpenTools: false,
      editorExplorer: false,
      customCss: '',
      htmlViewerNoSandbox: false,
      htmlViewerDefaultUnsafe: false,
      // The enable-switch maps default to {} (everything on).
      tabsEnabled: {},
      viewersEnabled: {},
      // The plugin-owned settings map defaults to {} too.
      pluginSettings: {},
    })
    // The retired title-bar keys are no longer part of the form at all.
    for (const retired of ['titleBarScheme', 'titleBarPresetId', 'titleBarCompat', 'titleBarStripPx']) {
      expect(view.value).not.toHaveProperty(retired)
    }

    const written = await invoke(route, 'settings.update', { patch: { agentOpenTools: true } })
    expect(written.ok).toBe(true)
    const after = written.value as { value: { agentOpenTools: boolean; customCss: string }; revision: number }
    expect(after.value.agentOpenTools).toBe(true)
    expect(after.value.customCss).toBe('')
    expect(after.revision).toBe(1)
  })

  it('imports a pre-0.1.7 settings.yaml section once, keeping only declared fields', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-sidebar-legacy-prefs-'))
    // DSH renames the retired document to `.imported` before importing any
    // section, and it re-imports by SAME id — this section is keyed by the
    // package name, which never matches the row id, so it is left behind. The
    // unknown fields are the ones this release no longer declares (the
    // title-bar keys joined that set when the whole strip mechanism was
    // removed); forwarding them would reject the whole patch and lose the
    // preferences.
    writeFileSync(join(home, 'settings.yaml.imported'), [
      'dsh-better-sidebar:',
      '  agentOpenTools: true',
      '  titleBarStripPx: 22',
      '  titleBarScheme: custom',
      '  terminalFontSize: 13',
      '  browserInterceptHttp: false',
      'other-plugin:',
      '  irrelevant: true',
      '',
    ].join('\n'))
    try {
      const settings = createFakeSettings()
      mountWithSettings(settings, home)
      // The import is fire-and-forget so a file read can never block loading;
      // let its read and microtasks settle before asserting.
      await new Promise(resolve => setTimeout(resolve, 100))
      const row = settings.describe().find(candidate => candidate.ns === ENTRY_ID)
      // The declared field comes across; every retired key is dropped rather
      // than forwarded (a forwarded unknown key is what would reject the
      // patch and lose the whole section).
      expect(row?.value).toMatchObject({ agentOpenTools: true })
      expect(row?.value).not.toHaveProperty('titleBarStripPx')
      expect(row?.value).not.toHaveProperty('titleBarScheme')
      expect(row?.value).not.toHaveProperty('terminalFontSize')
      expect(row?.value).not.toHaveProperty('browserInterceptHttp')
      expect(row?.revision).toBe(1)
    } finally {
      removeTree(home)
    }
  })

  it('leaves a row that already has user values alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-sidebar-legacy-skip-'))
    writeFileSync(join(home, 'settings.yaml'), 'dsh-better-sidebar:\n  agentOpenTools: true\n')
    try {
      const settings = createFakeSettings({ [ENTRY_ID]: { editorExplorer: true } })
      mountWithSettings(settings, home)
      await new Promise(resolve => setTimeout(resolve, 100))
      const row = settings.describe().find(candidate => candidate.ns === ENTRY_ID)
      // The row's own user layer wins: the import must never overwrite a value
      // set after the upgrade.
      expect(row?.value).toMatchObject({ editorExplorer: true, agentOpenTools: false })
      expect(row?.revision).toBe(0)
    } finally {
      removeTree(home)
    }
  })

  it('reaches outside the workspace with no pref set (the fence is gone)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fence-off-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'global instructions')
    try {
      // ⚠️ PERMISSION CHANGE: the default is now "no containment", and there
      // is no switch to arm it — the routes read/write wherever the host user
      // can. (`workspaceFence` in an old profile is simply an unknown key.)
      const route = mountWithSettings(createFakeSettings())
      const read = await invoke(route, 'fs.read', { sessionId: 'fence', cwd: workspace, path: join(outside, 'secret.txt') })
      expect(read).toMatchObject({ ok: true, value: { kind: 'text', content: 'global instructions' } })
      const tree = await invoke(route, 'fs.tree', { sessionId: 'fence', cwd: workspace, path: outside })
      expect(tree).toMatchObject({ ok: true })
      const write = await invoke(route, 'fs.write', { sessionId: 'fence', cwd: workspace, path: join(outside, 'written.txt'), content: 'ok' })
      expect(write, JSON.stringify(write)).toMatchObject({ ok: true })
      expect(readFileSync(join(outside, 'written.txt'), 'utf8')).toBe('ok')
      // A legacy `workspaceFence: true` patch is just an unknown prefs key now
      // (the schema no longer declares it): it must not fail the write and must
      // not re-arm anything.
      const legacy = await invoke(route, 'settings.update', { patch: { workspaceFence: true } })
      expect(legacy.ok).toBe(true)
      const stillOpen = await invoke(route, 'fs.read', { sessionId: 'fence', cwd: workspace, path: join(outside, 'secret.txt') })
      expect(stillOpen).toMatchObject({ ok: true })
    } finally {
      removeTree(root)
    }
  })

  it('refuses a stale write with settings-conflict (409)', async () => {
    const route = mountWithSettings(createFakeSettings())
    await invoke(route, 'settings.update', { patch: { agentOpenTools: false } })
    // The second write carries the pre-write revision: the seam refuses it.
    const stale = await invoke(route, 'settings.update', {
      patch: { agentOpenTools: true },
      expectedRevision: 0,
    })
    expect(stale.ok).toBe(false)
    expect(stale.error?.code).toBe('settings-conflict')
    expect(stale.error?.message).toMatch(/changed since it was read/)
  })

  it('rejects a non-object patch as bad-request', async () => {
    const route = mountWithSettings(createFakeSettings())
    const result = await invoke(route, 'settings.update', { patch: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/plain object/)
  })
})

describe('agent sidebar-open tool gating', () => {
  /**
   * DSH 0.1.7 emits its settings change on the settings service's own context,
   * which is not an ancestor of this plugin's fiber, so the gate cannot watch
   * an event. It is re-evaluated whenever the client re-reads the form instead
   * — which is exactly what the fenced `settings.get` route below does, and
   * what the Side card page does on every `settings/document-updated` push.
   */
  const gatingCtx = (enabled: () => boolean, routes: SidebarWebRoute[]) => {
    let registered = 0
    let disposed = 0
    const settings = {
      describe: () => [{
        ns: ENTRY_ID,
        value: { ...SIDEBAR_PREFS_DEFAULTS, agentOpenTools: enabled() },
        revision: 0,
      }],
      async update() {},
      configure: () => () => {},
    }
    const ctx = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
        registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
      },
      sessions: { get: () => undefined },
      tools: { register: () => { registered += 1; return () => { disposed += 1 } } },
      effect: (fn: () => void | (() => void)) => { fn() },
      inject: (deps: readonly string[], callback: (sctx: { settings: unknown }) => void) => {
        if (deps.includes('settings')) callback({ settings })
        return () => {}
      },
      on: () => () => {},
      get: () => undefined,
      fiber: PLUGIN_FIBER,
      loader: {
        entries: () => [{ options: { id: ENTRY_ID, name: 'dsh-better-sidebar' }, fiber: PLUGIN_FIBER }],
          // The real loader settles before a form is addressable; the fake
          // resolves immediately so the import runs on the same tick.
          await: () => Promise.resolve(),
      },
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    }
    return { ctx, live: () => registered - disposed, registrations: () => registered, disposals: () => disposed }
  }

  it('injects the one open tool only when the side-card setting is enabled (default off)', async () => {
    let enabled = false
    const routes: SidebarWebRoute[] = []
    const harness = gatingCtx(() => enabled, routes)
    apply(harness.ctx as never)
    const route = routes.find(candidate => candidate.path === '/sidebar/api')!
    // Default off: no open tool is registered even though settings is mounted.
    expect(harness.live()).toBe(0)
    // Switching the setting on and re-reading the form registers the one tool.
    enabled = true
    await invoke(route, 'settings.get', {})
    expect(harness.live()).toBe(1)
    expect(harness.disposals()).toBe(0)
    // Switching it back off unregisters it (and drains the undelivered queue).
    enabled = false
    await invoke(route, 'settings.get', {})
    expect(harness.live()).toBe(0)
    expect(harness.disposals()).toBe(1)
    // A redundant re-read registers it fresh (no double-registration).
    enabled = true
    await invoke(route, 'settings.get', {})
    expect(harness.live()).toBe(1)
    await invoke(route, 'settings.get', {})
    expect(harness.live()).toBe(1)
    expect(harness.registrations()).toBe(2)
  })
})
