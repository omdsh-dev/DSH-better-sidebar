/**
 * Smoke spec: mounts the host plugin against a minimal fake context and
 * exercises the real integrations — route registration, git against the
 * actual repository, and a real directory listing. Runs with `pnpm test`.
 */
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, mediaTypeForPath } from '../src/index.ts'
import * as git from '../src/git.ts'
import { listDirectory } from '../src/fs-tree.ts'
import { defaultShell, PtyManager, type SidebarPty } from '../src/pty-manager.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

interface FakeContext {
  webRuntime: { trustedHosts: readonly string[] }
  webServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: (route: SidebarWebUpgradeRoute) => () => void
  }
  sessions: { get: (id: string) => { header: { cwd?: string } } | undefined }
  tools: { register: (tool: unknown) => () => void }
  effect: (fn: () => void | (() => void), label?: string) => void
  /** The settings service never appears in the smoke context: the inject
   *  callback must never run (mirror of cordis' service-less inject). */
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
  /** Optional services (jobs/agents) are read lazily; absent → undefined. */
  get: (key: string) => undefined
}

/**
 * The login-shell test spawns a real pty whose bash may still be writing to
 * the temp HOME (history files, etc.) when `disposeAll()` returns — `close()`
 * only requests the kill and the process exit lands asynchronously in
 * `onExit`. Deleting the directory immediately then races the shell and
 * fails with ENOTEMPTY on CI. Wait for the spawned handle to report `exited`
 * (bounded), then remove with a short retry loop as a belt-and-braces
 * fallback for any straggler fd.
 */
async function rmTempDirAfterPtyExit(handle: { exited: boolean }, dir: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !handle.exited) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'ENOTEMPTY' || (error as NodeJS.ErrnoException).code === 'EBUSY'
      if (!busy || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
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
    expect(upgrades.map(route => route.path)).toEqual(['/sidebar/ws/terminal', '/sidebar/ws/agent-terminals'])
    // Teardown runs without throwing (pty manager has nothing open).
    for (const cleanup of effects) cleanup()
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

  it('pty manager releases the quota on close and respawns after exit', async () => {
    const manager = new PtyManager(defaultShell(), 3)
    try {
      const first = manager.open('s1', 't1', process.cwd(), 80, 24)
      expect(manager.keysOf('s1')).toHaveLength(1)
      // Tab-close semantics (close frame): quota released immediately.
      manager.scheduleClose(first.key, 0)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(manager.keysOf('s1')).toHaveLength(0)
      // Reopen spawns a fresh process.
      const second = manager.open('s1', 't1', process.cwd(), 80, 24)
      expect(second).not.toBe(first)
      expect(manager.keysOf('s1')).toHaveLength(1)
      // After the shell exits, a reconnect respawns instead of reusing the dead handle.
      second.pty.write('exit\r')
      const deadline = Date.now() + 5000
      while (!second.exited && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(second.exited).toBe(true)
      const third = manager.open('s1', 't1', process.cwd(), 80, 24)
      expect(third.exited).toBe(false)
      expect(third).not.toBe(second)
    } finally {
      manager.disposeAll()
    }
  })

  it('pty manager: exited zombie handles do not consume the quota', async () => {
    const manager = new PtyManager(defaultShell(), 1)
    try {
      const first = manager.open('s3', 't1', process.cwd(), 80, 24)
      first.pty.write('exit\r')
      const deadline = Date.now() + 5000
      while (!first.exited && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(first.exited).toBe(true)
      // Quota is 1; the exited handle is swept, so a NEW tab can still spawn.
      const second = manager.open('s3', 't2', process.cwd(), 80, 24)
      expect(second.exited).toBe(false)
      expect(manager.keysOf('s3')).toHaveLength(1)
    } finally {
      manager.disposeAll()
    }
  })

  it('pty manager: a reconnect within the grace period cancels the pending close', async () => {
    const manager = new PtyManager(defaultShell(), 3)
    try {
      const handle = manager.open('s2', 't1', process.cwd(), 80, 24)
      manager.scheduleClose(handle.key, 200)
      manager.open('s2', 't1', process.cwd(), 80, 24)
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(manager.get(handle.key)).toBeDefined()
    } finally {
      manager.disposeAll()
    }
  })

  it('pty manager: reopening with a different cwd respawns in the new directory', async () => {
    const manager = new PtyManager(defaultShell(), 3)
    // A real second directory: os.tmpdir() exists on every platform ('/tmp'
    // does not exist on Windows).
    const other = tmpdir()
    try {
      const first = manager.open('s4', 't1', process.cwd(), 80, 24)
      // The hydrate race: the first connect fell back to the process cwd,
      // the reconnect carries the session's real cwd — the shell must move.
      const second = manager.open('s4', 't1', other, 80, 24)
      expect(second).not.toBe(first)
      expect(second.cwd).toBe(other)
      expect(manager.keysOf('s4')).toHaveLength(1)
      // A same-cwd reconnect reattaches without respawning.
      const third = manager.open('s4', 't1', other, 80, 24)
      expect(third).toBe(second)
      expect(manager.keysOf('s4')).toHaveLength(1)
    } finally {
      manager.disposeAll()
    }
  })

  it.skipIf(process.platform === 'win32')('spawns the shell as a login shell (loads ~/.profile)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-sidebar-login-'))
    const previousHome = process.env.HOME
    let handle: SidebarPty | undefined
    try {
      // A login bash reads ~/.profile (a non-login interactive bash reads
      // ~/.bashrc instead), so this marker proves the spawn used a login
      // argv — the terminal-emulator behavior the tab should match.
      writeFileSync(join(home, '.profile'), 'export DSH_LOGIN_MARKER=loaded-from-profile\n')
      process.env.HOME = home
      const manager = new PtyManager('/bin/bash', 3)
      try {
        handle = manager.open('s5', 't1', process.cwd(), 80, 24)
        handle.pty.write('echo $DSH_LOGIN_MARKER\r')
        const deadline = Date.now() + 5000
        while (!handle.transcript.includes('loaded-from-profile') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        expect(handle.transcript).toContain('loaded-from-profile')
      } finally {
        manager.disposeAll()
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rmTempDirAfterPtyExit(handle ?? { exited: true }, home)
    }
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
  }

  const mount = (overrides: CtxOverrides = {}): SidebarWebRoute => {
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
      // No jobs/agents services in the smoke context: the routes degrade.
      get: () => undefined,
    }
    apply(ctx as never)
    return routes.find(route => route.path === '/sidebar/api')!
  }

  const invoke = async (
    route: SidebarWebRoute,
    method: string,
    payload: unknown,
  ): Promise<{ ok: boolean; value?: { cwd: string }; error?: { message: string } }> => {
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
    return JSON.parse(out.body) as { ok: boolean; value?: { cwd: string }; error?: { message: string } }
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

  it('pty.close releases a terminal key (and rejects a missing tab)', async () => {
    const route = mount()
    const result = await invoke(route, 'pty.close', { sessionId: 's-pty', tab: 't1' })
    expect(result.ok).toBe(true)
    const missing = await invoke(route, 'pty.close', { sessionId: 's-pty' })
    expect(missing.ok).toBe(false)
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
})

describe('side card settings routes', () => {
  /** A minimal settings seam: register/describe/update with the revision guard. */
  const createFakeSettings = (pre?: Record<string, Record<string, unknown>>) => {
    const namespaces = new Map<string, {
      schema: unknown
      value: Record<string, unknown> | undefined
      revision: number
    }>()
    for (const [ns, value] of Object.entries(pre ?? {})) {
      namespaces.set(ns, { schema: (input: unknown) => input, value, revision: 0 })
    }
    const resolve = (entry: { schema: unknown; value: Record<string, unknown> | undefined }): unknown => {
      const schema = entry.schema as (input: unknown) => unknown
      return entry.value === undefined ? schema(undefined) : schema(entry.value)
    }
    return {
      register(ns: string, schema: unknown) {
        namespaces.set(ns, { schema, value: undefined, revision: 0 })
        return { get: () => ({}), watch: () => () => {}, update: async () => {}, replace: async () => {} }
      },
      describe() {
        return [...namespaces.entries()].map(([ns, entry]) => ({
          ns,
          value: resolve(entry),
          applies: 'live' as const,
          revision: entry.revision,
        }))
      },
      async update(ns: string, patch: Record<string, unknown>, expectedRevision?: number) {
        const entry = namespaces.get(ns)
        if (entry === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
        if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
          throw new SettingsConflictError(settingsNamespace(ns), expectedRevision, entry.revision)
        }
        entry.value = { ...entry.value, ...patch }
        entry.revision += 1
      },
    }
  }

  const mountWithSettings = (settings?: unknown): SidebarWebRoute => {
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
      // No jobs/agents services: the jobs routes degrade to a 503.
      get: () => undefined,
    }
    apply(ctx as never)
    return routes.find(route => route.path === '/sidebar/api')!
  }

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

  it('serves the schema defaults when the settings service is absent', async () => {
    const route = mountWithSettings(undefined)
    const result = await invoke(route, 'settings.get', {})
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ value: undefined, revision: undefined, externalDisable: false })
  })

  it('reports externalDisable false when the aionui namespace is absent', async () => {
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

  it('serves the effective terminal shell and its display name', async () => {
    const route = mountWithSettings(undefined)
    const result = await invoke(route, 'shell.get', {})
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      shell: expect.any(String),
      name: expect.any(String),
    })
    expect(String((result.value as { name: unknown }).name).length).toBeGreaterThan(0)
  })

  it('reads the resolved prefs and writes a patch through the seam', async () => {
    const route = mountWithSettings(createFakeSettings())
    const read = await invoke(route, 'settings.get', {})
    expect(read.ok).toBe(true)
    expect(read.value).toEqual({
      value: {
        openByDefault: false,
        defaultWidthPercent: 35,
        autoOpenSubagent: true,
        autoOpenJobs: true,
        agentTerminalTools: false,
        bottomPanelAutoTerminal: true,
        terminalFontFamily: '',
        terminalFontSize: 13,
        interceptOpenPath: true,
        editorExplorer: false,
        terminalShell: '',
        terminalShellArgs: '',
        titleBarCompat: false,
        titleBarStripPx: 40,
        htmlViewerNoSandbox: false,
        htmlViewerDefaultUnsafe: false,
        browserNoSandbox: false,
        browserInterceptLinks: true,
        browserInterceptHttp: true,
        browserInterceptHttps: false,
        // The enable-switch maps default to {} (everything on).
        tabsEnabled: {},
        viewersEnabled: {},
        // The plugin-owned settings map defaults to {} too.
        pluginSettings: {},
      },
      revision: 0,
      externalDisable: false,
    })

    const written = await invoke(route, 'settings.update', { patch: { openByDefault: true } })
    expect(written.ok).toBe(true)
    const view = written.value as { value: { openByDefault: boolean; defaultWidthPercent: number }; revision: number }
    expect(view.value.openByDefault).toBe(true)
    expect(view.value.defaultWidthPercent).toBe(35)
    expect(view.revision).toBe(1)
  })

  it('refuses a stale write with settings-conflict (409)', async () => {
    const route = mountWithSettings(createFakeSettings())
    await invoke(route, 'settings.update', { patch: { openByDefault: false } })
    // The second write carries the pre-write revision: the seam refuses it.
    const stale = await invoke(route, 'settings.update', {
      patch: { defaultWidthPercent: 40 },
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
  /** Fake fetch responses shaped like what the route consumes. */
  const respond = (status: number, headers: Record<string, string>): Response =>
    ({ status, url: 'https://site.example/', headers: new Headers(headers) }) as unknown as Response

  it('reports X-Frame-Options and frame-ancestors from the target headers', async () => {
    const route = mountWithSettings(undefined)
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, {
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    })))
    try {
      const result = await invoke(route, 'browser.probe', { url: 'https://arxiv.org/' })
      expect(result.ok).toBe(true)
      expect(result.value).toEqual({
        reachable: true,
        url: 'https://site.example/',
        status: 200,
        xFrameOptions: 'SAMEORIGIN',
        frameAncestors: ["'none'"],
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries a 405 HEAD as GET', async () => {
    const route = mountWithSettings(undefined)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(405, {}))
      .mockResolvedValueOnce(respond(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await invoke(route, 'browser.probe', { url: 'https://example.com/' })
      expect(result.ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result.value).toMatchObject({ reachable: true, status: 200 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports an unreachable target as reachable:false', async () => {
    const route = mountWithSettings(undefined)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND') }))
    try {
      const result = await invoke(route, 'browser.probe', { url: 'https://example.com/' })
      expect(result.ok).toBe(true)
      expect(result.value).toEqual({ reachable: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses non-http(s) and loopback URLs', async () => {
    const route = mountWithSettings(undefined)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://127.0.0.1:8080/', 'http://localhost/']) {
      const result = await invoke(route, 'browser.probe', { url })
      expect(result.ok, url).toBe(false)
      expect(result.error?.code, url).toBe('bad-request')
    }
  })
})


describe('agent terminal tool gating', () => {
  it('injects the eight tools only when the side-card setting is enabled (default off)', () => {
    let registered = 0
    let disposed = 0
    // The tools currently registered (registered minus disposed).
    const live = (): number => registered - disposed
    // A ref container: the watch callback is only assigned inside a closure,
    // which TypeScript's control-flow analysis ignores (the bare variable
    // would narrow to null and refuse the optional call).
    const watcherRef: { current: (() => void) | null } = { current: null }
    let enabled = false
    const settings = {
      register() {
        return {
          get: () => ({ agentTerminalTools: enabled }),
          watch: (callback: () => void) => { watcherRef.current = callback; return () => {} },
          update: async () => {},
          replace: async () => {},
        }
      },
      describe: () => [],
      async update() {},
    }
    const ctx = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: (route: SidebarWebRoute) => { void route; return () => {} },
        registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
      },
      sessions: { get: () => undefined },
      tools: { register: () => { registered += 1; return () => { disposed += 1 } } },
      effect: (fn: () => void | (() => void)) => { fn() },
      inject: (deps: readonly string[], callback: (sctx: { settings: unknown }) => void) => {
        if (deps.includes('settings')) callback({ settings })
        return () => {}
      },
      // No jobs/agents services: the jobs routes degrade to a 503.
      get: () => undefined,
    }
    apply(ctx as never)
    // Default off: no tools are registered even though the settings service is mounted.
    expect(live()).toBe(0)
    // Flipping the setting on registers all eight tools.
    enabled = true
    watcherRef.current?.()
    expect(live()).toBe(8)
    expect(disposed).toBe(0)
    // Flipping it back off unregisters them (and releases any agent terminals).
    enabled = false
    watcherRef.current?.()
    expect(live()).toBe(0)
    expect(disposed).toBe(8)
    // And a redundant toggle registers them fresh (no double-registration per
    // flip: the guard only skips when the tools are already live).
    enabled = true
    watcherRef.current?.()
    expect(live()).toBe(8)
    expect(registered).toBe(16)
  })


})
