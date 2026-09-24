/**
 * Smoke spec: mounts the host plugin against a minimal fake context and
 * exercises the real integrations — route registration, git against the
 * actual repository, and a real directory listing. Runs with `pnpm test`.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { SettingsConflictError, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, mediaTypeForPath } from '../src/index.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { encodeHtmlUrl } from '../src/html-route.ts'
import * as git from '../src/git.ts'
import { listDirectory } from '../src/fs-tree.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

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
    rmSync(dir, { recursive: true, force: true })
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

describe('host plugin smoke', () => {
  it('serves PDF with the browser-native content type', () => {
    expect(mediaTypeForPath('/work/report.PDF')).toBe('application/pdf')
    expect(mediaTypeForPath('/work/archive.bin')).toBe('application/octet-stream')
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
      '/sidebar/bundle',
      '/sidebar/file',
      '/sidebar/html',
    ])
    expect(upgrades.map(route => route.path)).toEqual(['/sidebar/ws/agent-opens', '/sidebar/ws/fs-watch'])
    // Teardown runs without throwing.
    for (const cleanup of effects) cleanup()
  })

  it('serves HTML previews as UTF-8 without changing the file bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sidebar-html-utf8-'))
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
      const req = {
        method: 'GET',
        url: encodeHtmlUrl('s-html', path),
        headers: { host: '127.0.0.1:3080' },
      } as never
      const response: { status?: number; headers?: Record<string, string>; chunks: Buffer[] } = { chunks: [] }
      const res = {
        writeHead: (status: number, headers?: Record<string, string>) => {
          response.status = status
          response.headers = headers
        },
        end: (chunk?: string | Buffer) => {
          if (chunk !== undefined) response.chunks.push(Buffer.from(chunk))
        },
      } as never

      await route.handler(req, res)

      expect(response.status).toBe(200)
      expect(Buffer.concat(response.chunks)).toEqual(source)
      expect(response.headers?.['content-type']).toBe('text/html; charset=utf-8')
    } finally {
      for (const cleanup of effects) cleanup()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('runs git status/log/branches against this repository', async () => {
    const cwd = process.cwd()
    const status = await git.status(cwd)
    expect(status.isRepo).toBe(true)
    expect(typeof status.branch).toBe('string')
    expect(Array.isArray(status.entries)).toBe(true)
    const log = await git.log(cwd)
    expect(log.length).toBeGreaterThan(0)
    expect(log[0]!.hash).toMatch(/^[0-9a-f]{7,}$/)
    const branches = await git.branches(cwd)
    expect(branches.names).toContain(branches.current)
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
 * Destructive git operations (discard / revert / cherry-pick) run against a
 * throwaway repository under the OS temp dir — never the plugin repo. The
 * fixture's commit identity comes from the GIT_AUTHOR / GIT_COMMITTER
 * environment variables, confined to the fixture process: no git config is
 * touched anywhere (the plugin never sets an identity, and neither does its
 * test fixture).
 */
describe('git destructive operations (scratch repository)', () => {
  const FIXTURE_IDENTITY = {
    GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
    GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
    GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
    GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
  }

  const gitRun = (cwd: string, args: string[]): string => {
    const result = spawnSync('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...FIXTURE_IDENTITY },
    })
    if (result.status !== 0) {
      throw new Error(result.stderr || `git ${args[0] ?? ''} exited with ${String(result.status)}`)
    }
    return result.stdout
  }

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
      rmSync(dir, { recursive: true, force: true })
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
      rmSync(dir, { recursive: true, force: true })
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
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a failing destructive operation as a GitCommandError', async () => {
    const dir = makeScratchRepo()
    try {
      // An unknown revision fails before touching anything.
      await expect(git.revert(dir, 'deadbeef00000000000000000000000000000000')).rejects.toThrow()
      await expect(git.cherryPick(dir, 'deadbeef00000000000000000000000000000000')).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
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

  const invoke = async (
    route: SidebarWebRoute,
    method: string,
    payload: unknown,
  ): Promise<{ ok: boolean; status: number; value?: { cwd: string }; error?: { code?: string; message: string } }> => {
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
    const out: { status: number; body: string } = { status: 200, body: '' }
    const req = { method: 'GET', url, headers: { host: '127.0.0.1:3080' } } as never
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (chunk: unknown) => { out.body += String(chunk ?? '') },
    } as never
    await route.handler(req, res)
    return out
  }

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

  it('rejects repo-root-relative fs.read paths outside a nested session workspace', async () => {
    const route = mount({
      sessions: {
        get: () => ({ header: { cwd: join(process.cwd(), 'src') } }),
      },
    })
    const result = await invoke(route, 'fs.read', { sessionId: 's-sub', path: 'package.json' })
    expect(result).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } })
  })

  it('rejects fs.tree paths outside the session workspace', async () => {
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
      expect(tree).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects fs.read paths outside the session workspace', async () => {
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
      expect(read).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects fs.write paths outside the session workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    try {
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const write = await invoke(route, 'fs.write', { sessionId: 'security', path: join(outside, 'written.txt'), content: 'hack' })
      expect(write).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects media and HTML reads through a workspace symlink', async () => {
    if (!canCreateSymlink) return
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-route-symlink-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const mediaPath = join(outside, 'secret.png')
    const htmlPath = join(outside, 'secret.html')
    writeFileSync(mediaPath, 'not an image')
    writeFileSync(htmlPath, '<p>secret</p>')
    try {
      symlinkSync(outside, join(workspace, 'link'))
      const routes = mountAll({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const media = routes.find(route => route.path === '/sidebar/file')!
      const html = routes.find(route => route.path === '/sidebar/html')!
      const mediaResult = await invokeGet(media, `/sidebar/file?sessionId=security&path=${encodeURIComponent(join(workspace, 'link', 'secret.png'))}`)
      // Use the production encoder so the URL is well-formed on every
      // platform (a Windows drive path needs the leading slash separator
      // that a naive join-without-separator drops).
      const htmlResult = await invokeGet(html, encodeHtmlUrl('security', join(workspace, 'link', 'secret.html')))
      expect(mediaResult).toMatchObject({ status: 403 })
      expect(JSON.parse(mediaResult.body)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(htmlResult).toMatchObject({ status: 403 })
      expect(JSON.parse(htmlResult.body)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!canCreateSymlink)('rejects workspace symlinks that resolve outside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-symlink-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      symlinkSync(outside, join(workspace, 'link'))
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const tree = await invoke(route, 'fs.tree', { sessionId: 'security', path: join(workspace, 'link') })
      expect(tree).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!canCreateSymlink)('rejects fs.read through a workspace symlink', async () => {
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
      expect(read).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!canCreateSymlink)('rejects fs.write through a workspace symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fs-symlink-security-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    try {
      symlinkSync(outside, join(workspace, 'link'))
      const route = mount({ sessions: { get: () => ({ header: { cwd: workspace } }) } })
      const write = await invoke(route, 'fs.write', { sessionId: 'security', path: join(workspace, 'link', 'new.txt'), content: 'hack' })
      expect(write).toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
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
      workspaceFence: true,
      // These title-bar fields are declared without a schema default on
      // purpose, so a document predating them migrates rather than flips.
      titleBarCompat: false,
      titleBarStripPx: 40,
      htmlViewerNoSandbox: false,
      htmlViewerDefaultUnsafe: false,
      // The enable-switch maps default to {} (everything on).
      tabsEnabled: {},
      viewersEnabled: {},
      // The plugin-owned settings map defaults to {} too.
      pluginSettings: {},
    })

    const written = await invoke(route, 'settings.update', { patch: { agentOpenTools: true } })
    expect(written.ok).toBe(true)
    const after = written.value as { value: { agentOpenTools: boolean; titleBarStripPx: number }; revision: number }
    expect(after.value.agentOpenTools).toBe(true)
    expect(after.value.titleBarStripPx).toBe(40)
    expect(after.revision).toBe(1)
  })

  it('imports a pre-0.1.7 settings.yaml section once, keeping only declared fields', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-sidebar-legacy-prefs-'))
    // DSH renames the retired document to `.imported` before importing any
    // section, and it re-imports by SAME id — this section is keyed by the
    // package name, which never matches the row id, so it is left behind. The
    // unknown fields are the ones this release no longer declares; forwarding
    // them would reject the whole patch and lose the preferences.
    writeFileSync(join(home, 'settings.yaml.imported'), [
      'dsh-better-sidebar:',
      '  agentOpenTools: true',
      '  titleBarStripPx: 22',
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
      expect(row?.value).toMatchObject({ agentOpenTools: true, titleBarStripPx: 22 })
      expect(row?.value).not.toHaveProperty('terminalFontSize')
      expect(row?.value).not.toHaveProperty('browserInterceptHttp')
      expect(row?.revision).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
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
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('disarms the workspace fence for the fs routes when the pref is off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fence-off-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'global instructions')
    try {
      const route = mountWithSettings(createFakeSettings())
      // Default (fence on): the outside read is refused as usual…
      const refused = await invoke(route, 'fs.read', { sessionId: 'fence', cwd: workspace, path: join(outside, 'secret.txt') })
      expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      // …then the settings-page switch (or the fence notice's one-click off)
      // disarms every fs route for paths outside the workspace.
      const off = await invoke(route, 'settings.update', { patch: { workspaceFence: false } })
      expect(off.ok).toBe(true)
      const read = await invoke(route, 'fs.read', { sessionId: 'fence', cwd: workspace, path: join(outside, 'secret.txt') })
      expect(read).toMatchObject({ ok: true, value: { kind: 'text', content: 'global instructions' } })
      const tree = await invoke(route, 'fs.tree', { sessionId: 'fence', cwd: workspace, path: outside })
      expect(tree).toMatchObject({ ok: true })
      const write = await invoke(route, 'fs.write', { sessionId: 'fence', cwd: workspace, path: join(outside, 'written.txt'), content: 'ok' })
      expect(write).toMatchObject({ ok: true })
      expect(readFileSync(join(outside, 'written.txt'), 'utf8')).toBe('ok')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a stale write with settings-conflict (409)', async () => {
    const route = mountWithSettings(createFakeSettings())
    await invoke(route, 'settings.update', { patch: { agentOpenTools: false } })
    // The second write carries the pre-write revision: the seam refuses it.
    const stale = await invoke(route, 'settings.update', {
      patch: { titleBarStripPx: 15 },
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
