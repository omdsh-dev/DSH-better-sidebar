/**
 * The Git panel's remote routes over the real `/sidebar/api` surface:
 * `git.push` / `git.pull` against a real bare remote (fast-forward succeeds,
 * a diverged branch fails instead of opening a merge editor, a branch with no
 * upstream reports git's own message).
 *
 * The AI commit-message suggestion that landed in the same upstream PR is NOT
 * wired from here: this branch keeps the implementation merged from
 * `port/pr-642` (`src/commit-message.ts` + its own specs), so the duplicate
 * route contract those cases pinned (a folded `requestHeader()`, a 200-token
 * budget) no longer exists.
 *
 * The route is mounted exactly as the plugin mounts it (see smoke.spec.ts).
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** Fixture commit identity, confined to this process: no git config is touched. */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

/** Run one git command (throws on a non-zero exit). */
function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...FIXTURE_IDENTITY },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0] ?? ''} exited with ${String(result.status)}`)
  return result.stdout
}

/** A repo on `main` with one commit. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-remote-'))
  gitRun(dir, ['init', '-q'])
  // Pin the eol policy: Git for Windows defaults to core.autocrlf=true, which
  // would smudge the byte-exact diff assertions below.
  gitRun(dir, ['config', 'core.autocrlf', 'false'])
  gitRun(dir, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

/** A working clone, a bare `origin` it tracks, and a peer clone of the same remote. */
interface RemoteFixture {
  /** The scratch directory holding all three (the only thing to clean up). */
  scratch: string
  origin: string
  work: string
  peer: string
}

function makeRemoteFixture(): RemoteFixture {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-sidebar-origin-'))
  const origin = join(scratch, 'origin.git')
  const work = join(scratch, 'work')
  const peer = join(scratch, 'peer')
  gitRun(scratch, ['init', '-q', '--bare', origin])
  // A bare repo's HEAD defaults to the machine's init.defaultBranch, and a
  // clone whose HEAD names a branch that does not exist yet checks out
  // NOTHING. Pin it so both clones start on the branch the tests push.
  gitRun(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  gitRun(scratch, ['clone', '-q', origin, work])
  gitRun(work, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(work, 'a.txt'), 'one\n')
  gitRun(work, ['add', '-A'])
  gitRun(work, ['commit', '-q', '-m', 'base'])
  gitRun(work, ['push', '-q', '-u', 'origin', 'main'])
  gitRun(scratch, ['clone', '-q', origin, peer])
  gitRun(peer, ['config', 'core.autocrlf', 'false'])
  return { scratch, origin, work, peer }
}
/**
 * Mount the plugin's `/sidebar/api` route against a minimal fake context. The
 * session carries NO header cwd on purpose: the payload's cwd must win, which
 * is how the real client addresses a session's workspace.
 */
function mount(): { route: SidebarWebRoute } {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (_route: SidebarWebUpgradeRoute) => () => {},
    },
    sessions: { get: (_id: string) => ({ header: {}, snapshotEvents: () => [] }) },
    tools: { register: () => () => {} },
    // The vendored cordis runs registration effects immediately.
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  const route = routes.find(entry => entry.path === '/sidebar/api')
  if (route === undefined) throw new Error('the /sidebar/api route was not registered')
  return { route }
}
interface Invoked<T> {
  ok: boolean
  status: number
  value?: T
  error?: { code?: string; message: string }
}

async function invoke<T = unknown>(route: SidebarWebRoute, method: string, payload: unknown): Promise<Invoked<T>> {
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
  return { ...JSON.parse(out.body) as Invoked<T>, status: out.status }
}

describe('git remote routes (real repository + bare origin)', () => {
  it('pushes the current branch to its upstream', async () => {
    const fixture = makeRemoteFixture()
    try {
      writeFileSync(join(fixture.work, 'a.txt'), 'one\ntwo\n')
      gitRun(fixture.work, ['add', '-A'])
      gitRun(fixture.work, ['commit', '-q', '-m', 'second'])
      const local = gitRun(fixture.work, ['rev-parse', 'main']).trim()

      const { route } = mount()
      const result = await invoke(route, 'git.push', { sessionId: 's-push', cwd: fixture.work })

      expect(result).toMatchObject({ ok: true, value: { ok: true } })
      // The remote actually moved — the route ran a real `git push`.
      expect(gitRun(fixture.origin, ['rev-parse', 'main']).trim()).toBe(local)
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true })
    }
  })

  it('reports git\'s own failure for a branch with no upstream', async () => {
    const dir = makeRepo()
    try {
      const { route } = mount()
      const result = await invoke(route, 'git.push', { sessionId: 's-noup', cwd: dir })

      // git-error, never a silent success: the panel shows the message and the
      // user sets the tracking in a terminal.
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('git-error')
      expect(result.error?.message ?? '').not.toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pulls a fast-forward onto the peer\'s commit', async () => {
    const fixture = makeRemoteFixture()
    try {
      writeFileSync(join(fixture.peer, 'b.txt'), 'from peer\n')
      gitRun(fixture.peer, ['add', '-A'])
      gitRun(fixture.peer, ['commit', '-q', '-m', 'peer work'])
      gitRun(fixture.peer, ['push', '-q', 'origin', 'main'])

      const { route } = mount()
      const pulled = await invoke(route, 'git.pull', { sessionId: 's-pull', cwd: fixture.work })

      expect(pulled).toMatchObject({ ok: true, value: { ok: true } })
      expect(readFileSync(join(fixture.work, 'b.txt'), 'utf8')).toBe('from peer\n')
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true })
    }
  })

  it('refuses a diverged branch instead of merging, leaving no merge to resolve', async () => {
    const fixture = makeRemoteFixture()
    try {
      writeFileSync(join(fixture.work, 'local.txt'), 'local\n')
      gitRun(fixture.work, ['add', '-A'])
      gitRun(fixture.work, ['commit', '-q', '-m', 'local work'])
      writeFileSync(join(fixture.peer, 'peer.txt'), 'peer\n')
      gitRun(fixture.peer, ['add', '-A'])
      gitRun(fixture.peer, ['commit', '-q', '-m', 'peer work'])
      gitRun(fixture.peer, ['push', '-q', 'origin', 'main'])
      const headBefore = gitRun(fixture.work, ['rev-parse', 'HEAD']).trim()

      const { route } = mount()
      const diverged = await invoke(route, 'git.pull', { sessionId: 's-pull', cwd: fixture.work })

      // --ff-only: the failure is the point. A merge here would strand a
      // headless panel inside an editor nobody can answer.
      expect(diverged.ok).toBe(false)
      expect(diverged.error?.code).toBe('git-error')
      expect(gitRun(fixture.work, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
      expect(gitRun(fixture.work, ['status', '--porcelain'])).toBe('')
      expect(() => readFileSync(join(fixture.work, '.git', 'MERGE_HEAD'), 'utf8')).toThrow()
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true })
    }
  })
})
