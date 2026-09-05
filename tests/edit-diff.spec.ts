import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { deriveEditDiffTarget, buildEditDiffTab } from '../src/client/edit-diff.ts'
import type { GitStatusResult } from '../src/client/api.ts'
import * as git from '../src/git.ts'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

const normalizePath = (path: string): string => path.replaceAll('\\', '/')
const canonical = (path: string): string => normalizePath(realpathSync(path))

// Helpers for scratch repos (same identity as smoke)
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...FIXTURE_IDENTITY },
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0] ?? ''} exited with ${String(result.status)}`)
  }
  return result.stdout
}

function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-editdiff-'))
  gitRun(dir, ['init', '-q'])
  gitRun(dir, ['config', 'user.email', 'test@test'])
  gitRun(dir, ['config', 'user.name', 'test'])
  // ensure branch stable
  gitRun(dir, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

// ── Client derive/build ─────────────────────────────────────────────

describe('deriveEditDiffTarget', () => {
  const root = '/repo'
  const statusWith = (entries: GitStatusResult['entries'], isRepo = true, rootParam: string | undefined = root): GitStatusResult => ({
    isRepo,
    root: rootParam,
    entries,
  })
  const statusWithUndefinedRoot = (entries: GitStatusResult['entries']): GitStatusResult => ({
    isRepo: true,
    root: undefined,
    entries,
  })

  it('returns target when file is inside repo and has a status entry', () => {
    const absolute = join(root, 'src/a.ts')
    const status = statusWith([{ path: 'src/a.ts', xy: ' M' }])
    const target = deriveEditDiffTarget(absolute, status)
    expect(target).toEqual({ relative: 'src/a.ts', repoRoot: root, untracked: false })
  })

  it('returns null when file has no status entry', () => {
    const absolute = join(root, 'src/a.ts')
    const status = statusWith([{ path: 'src/b.ts', xy: ' M' }])
    expect(deriveEditDiffTarget(absolute, status)).toBeNull()
  })

  it('returns null when isRepo false', () => {
    const absolute = join(root, 'src/a.ts')
    const status: GitStatusResult = { isRepo: false, entries: [] }
    expect(deriveEditDiffTarget(absolute, status)).toBeNull()
  })

  it('returns null when root is undefined', () => {
    const absolute = join(root, 'src/a.ts')
    const status = statusWithUndefinedRoot([{ path: 'src/a.ts', xy: ' M' }])
    expect(deriveEditDiffTarget(absolute, status)).toBeNull()
  })

  it('marks untracked (??) as untracked:true', () => {
    const absolute = join(root, 'new.txt')
    const status = statusWith([{ path: 'new.txt', xy: '??' }])
    const target = deriveEditDiffTarget(absolute, status)!
    expect(target.untracked).toBe(true)
    expect(target.relative).toBe('new.txt')
  })

  it('returns null when file is outside repo root', () => {
    const absolute = '/other/src/a.ts'
    const status = statusWith([{ path: 'src/a.ts', xy: ' M' }])
    expect(deriveEditDiffTarget(absolute, status)).toBeNull()
  })

  it('returns null when absolute equals repo root', () => {
    const absolute = root
    const status = statusWith([{ path: 'src/a.ts', xy: ' M' }])
    expect(deriveEditDiffTarget(absolute, status)).toBeNull()
  })

  it('handles staged and modified xy codes', () => {
    const absolute = join(root, 'src/mod.ts')
    for (const xy of ['M ', 'AM', 'MM', 'R ', 'C ']) {
      const status = statusWith([{ path: 'src/mod.ts', xy }])
      const target = deriveEditDiffTarget(absolute, status)
      expect(target, xy).not.toBeNull()
      expect(target!.untracked).toBe(false)
    }
  })
})

describe('buildEditDiffTab', () => {
  it('builds id/title/diff ref with repoRoot transparent', () => {
    const tab = buildEditDiffTab('src/a.ts', '/repo', false)
    expect(tab.id).toBe('diff:w::u:src/a.ts')
    expect(tab.type).toBe('diff')
    expect(tab.title).toBe('a.ts')
    expect(tab.diff).toEqual({ kind: 'worktree', path: 'src/a.ts', staged: false, untracked: false, repoRoot: '/repo' })
  })

  it('preserves untracked flag', () => {
    const tab = buildEditDiffTab('new.txt', '/repo', true)
    expect((tab.diff as { untracked: boolean; staged: boolean }).untracked).toBe(true)
    expect((tab.diff as { untracked: boolean; staged: boolean }).staged).toBe(false)
  })

  it('handles nested paths for title', () => {
    const tab = buildEditDiffTab('a/b/c/deep.ts', '/repo', false)
    expect(tab.title).toBe('deep.ts')
    expect(tab.id).toBe('diff:w::u:a/b/c/deep.ts')
  })
})

// ── git.repoRootOf ─────────────────────────────────────────────────

describe('git.repoRootOf', () => {
  it('resolves repo root for a file inside a repo', async () => {
    const repo = makeScratchRepo()
    try {
      const file = join(repo, 'a.txt')
      const root = await git.repoRootOf(file)
      expect(root).toBeDefined()
      expect(canonical(root!)).toBe(canonical(repo))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resolves repo root for a nested file', async () => {
    const repo = makeScratchRepo()
    try {
      mkdirSync(join(repo, 'src', 'sub'), { recursive: true })
      const file = join(repo, 'src', 'sub', 'nested.ts')
      writeFileSync(file, 'x')
      const root = await git.repoRootOf(file)
      expect(canonical(root!)).toBe(canonical(repo))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resolves repo root when given the repo root directory itself', async () => {
    const repo = makeScratchRepo()
    try {
      const root = await git.repoRootOf(repo)
      expect(root).toBeDefined()
      expect(canonical(root!)).toBe(canonical(repo))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('returns undefined for a path outside any repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-editdiff-norepo-'))
    try {
      const file = join(dir, 'lonely.txt')
      writeFileSync(file, 'hello')
      const root = await git.repoRootOf(file)
      expect(root).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for non-existent path outside repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-editdiff-norepo2-'))
    try {
      const file = join(dir, 'missing.txt')
      const root = await git.repoRootOf(file)
      expect(root).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Server API helpers ──────────────────────────────────────────────

function mountApi(cwd: string, extraRoots: string[] = []): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] as readonly string[] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
    },
    sessions: { get: (id: string) => id === 's' ? { header: { cwd } } : undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never, { extraRoots })
  const api = routes.find(r => r.path === '/sidebar/api')
  if (!api) throw new Error('api route not mounted')
  return api
}

async function invoke(
  route: SidebarWebRoute,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number; value?: unknown; error?: { code?: string; message: string } }> {
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
  const parsed = JSON.parse(out.body) as { ok: boolean; value?: unknown; error?: { code?: string; message: string } }
  return { ...parsed, status: out.status }
}

// ── git.status-at route ────────────────────────────────────────────

describe('git.status-at route', () => {
  it('returns isRepo true for a file inside a repo', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-statusat-session-'))
    const repo = makeScratchRepo()
    try {
      // modify repo so status has entries
      writeFileSync(join(repo, 'a.txt'), 'modified\n')
      // also an untracked file
      writeFileSync(join(repo, 'untracked.txt'), 'new')
      const extraRoots = [repo]
      const api = mountApi(sessionRoot, extraRoots)
      const file = join(repo, 'a.txt')
      const result = await invoke(api, 'git.status-at', { sessionId: 's', cwd: sessionRoot, path: file })
      expect(result.ok).toBe(true)
      const value = result.value as GitStatusResult
      expect(value.isRepo).toBe(true)
      expect(value.root).toBeDefined()
      expect(canonical(value.root!)).toBe(canonical(repo))
      expect(value.entries.some(e => e.path === 'a.txt')).toBe(true)
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('returns isRepo false for a path not in a repo but inside allowed root', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-statusat-norepo-session-'))
    const allowed = mkdtempSync(join(tmpdir(), 'dsh-statusat-allowed-'))
    try {
      const file = join(allowed, 'plain.txt')
      writeFileSync(file, 'hello')
      const api = mountApi(sessionRoot, [allowed])
      const result = await invoke(api, 'git.status-at', { sessionId: 's', cwd: sessionRoot, path: file })
      expect(result.ok).toBe(true)
      const value = result.value as GitStatusResult
      expect(value.isRepo).toBe(false)
      expect(value.entries).toEqual([])
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(allowed, { recursive: true, force: true })
    }
  })

  it('rejects with 403 when path is outside workspace and extraRoots', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-statusat-forbidden-session-'))
    const allowed = mkdtempSync(join(tmpdir(), 'dsh-statusat-allowed2-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-statusat-outside-'))
    try {
      const file = join(outside, 'secret.txt')
      writeFileSync(file, 'secret')
      const api = mountApi(sessionRoot, [allowed])
      const result = await invoke(api, 'git.status-at', { sessionId: 's', cwd: sessionRoot, path: file })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error?.code).toBe('forbidden')
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(allowed, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('returns isRepo false for a workspace file not in a repo (no extraRoots needed)', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-statusat-workspace-plain-'))
    try {
      const file = join(sessionRoot, 'plain.txt')
      writeFileSync(file, 'x')
      const api = mountApi(sessionRoot, [])
      const result = await invoke(api, 'git.status-at', { sessionId: 's', cwd: sessionRoot, path: file })
      expect(result.ok).toBe(true)
      expect((result.value as GitStatusResult).isRepo).toBe(false)
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
    }
  })
})

// ── git.diff external repoRoot ─────────────────────────────────────

describe('git.diff external repoRoot', () => {
  it('returns diff for external repo when extraRoots allows it', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-diff-session-'))
    const external = makeScratchRepo()
    try {
      const rel = 'a.txt'
      // create an unstaged change
      writeFileSync(join(external, rel), 'one\nCHANGED\nthree\n')
      const api = mountApi(sessionRoot, [external])
      const result = await invoke(api, 'git.diff', { sessionId: 's', cwd: sessionRoot, path: rel, staged: false, repoRoot: external })
      expect(result.ok).toBe(true)
      const value = result.value as { diff: string }
      expect(value.diff).toContain('CHANGED')
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('rejects with 403 when external repoRoot is outside extraRoots', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-diff-session2-'))
    const external = makeScratchRepo()
    const otherExtra = mkdtempSync(join(tmpdir(), 'dsh-diff-extra-other-'))
    try {
      writeFileSync(join(external, 'a.txt'), 'one\nCHANGED\nthree\n')
      const api = mountApi(sessionRoot, [otherExtra])
      const result = await invoke(api, 'git.diff', { sessionId: 's', cwd: sessionRoot, path: 'a.txt', staged: false, repoRoot: external })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error?.code).toBe('forbidden')
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
      rmSync(otherExtra, { recursive: true, force: true })
    }
  })

  it('rejects when external repoRoot is not a git repo even if fenced', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-diff-session3-'))
    const notRepo = mkdtempSync(join(tmpdir(), 'dsh-diff-notrepo-'))
    try {
      writeFileSync(join(notRepo, 'file.txt'), 'x')
      const api = mountApi(sessionRoot, [notRepo])
      const result = await invoke(api, 'git.diff', { sessionId: 's', cwd: sessionRoot, path: 'file.txt', staged: false, repoRoot: notRepo })
      expect(result.ok).toBe(false)
      // GitCommandError surfaces as internal (writeError) or git-error depending on wiring
      expect(result.error).toBeDefined()
      expect(result.status).toBeGreaterThanOrEqual(400)
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  it('keeps old behavior for repoRoot inside discovered list', async () => {
    // workspace container with two child repos; session cwd is the container
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-diff-container-'))
    const first = join(workspace, 'first-repo')
    const second = join(workspace, 'second-repo')
    mkdirSync(first)
    mkdirSync(second)
    gitRun(first, ['init', '-q'])
    gitRun(first, ['config', 'user.email', 't@t'])
    gitRun(first, ['config', 'user.name', 't'])
    gitRun(first, ['commit', '-q', '--allow-empty', '-m', 'init'])

    gitRun(second, ['init', '-q'])
    gitRun(second, ['config', 'user.email', 't@t'])
    gitRun(second, ['config', 'user.name', 't'])
    gitRun(second, ['checkout', '-q', '-b', 'main'])
    writeFileSync(join(second, 'b.txt'), 'base\n')
    gitRun(second, ['add', '-A'])
    gitRun(second, ['commit', '-q', '-m', 'base'])
    writeFileSync(join(second, 'b.txt'), 'modified\n')

    try {
      // No extraRoots needed; second is discovered as child of workspace
      const api = mountApi(workspace, [])
      const result = await invoke(api, 'git.diff', { sessionId: 's', cwd: workspace, path: 'b.txt', staged: false, repoRoot: canonical(second) })
      expect(result.ok).toBe(true)
      const value = result.value as { diff: string }
      expect(value.diff).toContain('modified')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('resolves relative path against external repo root (not session cwd)', async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-diff-session-rel-'))
    const external = makeScratchRepo()
    // add nested file
    mkdirSync(join(external, 'src'), { recursive: true })
    writeFileSync(join(external, 'src', 'nested.ts'), 'orig\n')
    gitRun(external, ['add', '-A'])
    gitRun(external, ['commit', '-q', '-m', 'add nested'])
    writeFileSync(join(external, 'src', 'nested.ts'), 'changed\n')
    try {
      const api = mountApi(sessionRoot, [external])
      const result = await invoke(api, 'git.diff', { sessionId: 's', cwd: sessionRoot, path: 'src/nested.ts', staged: false, repoRoot: external })
      expect(result.ok).toBe(true)
      expect((result.value as { diff: string }).diff).toContain('changed')
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })
})
