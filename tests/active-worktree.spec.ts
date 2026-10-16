import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeWorktreeRootOf } from '../src/active-worktree.ts'
import type { Context } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'

/** The plugin's git probe seam: call order plus an optional canned answer. */
const seam = vi.hoisted(() => ({
  /** Every cwd handed to the plugin's own git probe, in call order. */
  probed: [] as string[],
  /**
   * Optional canned answer per probe. Set it to exercise the process-wide
   * caches (which are keyed per session) without paying one REAL git spawn per
   * key; `probed` still records every call the module made.
   */
  responder: null as null | ((cwd: string, args: string[]) => string),
}))

const probed = seam.probed

// Records (and delegates to) the real spawn so the case-folding regression is
// visible on case-insensitive hosts too.
vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.ts')>()
  return {
    ...actual,
    runGit: (cwd: string, args: string[], timeoutMs?: number) => {
      probed.push(cwd)
      const canned = seam.responder?.(cwd, args)
      return canned === undefined ? actual.runGit(cwd, args, timeoutMs) : Promise.resolve(canned)
    },
  }
})

/** The plugin's stat seam: fail the NEXT n stat() calls with a chosen errno. */
const statSeam = vi.hoisted(() => ({ failNext: 0, code: 'EPERM' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (statSeam.failNext > 0) {
        statSeam.failNext -= 1
        const error = new Error(statSeam.code + ': injected by the spec') as NodeJS.ErrnoException
        error.code = statSeam.code
        throw error
      }
      return actual.stat(...args)
    },
  }
})

const IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

function git(cwd: string, args: string[]): string {
  // `core.hooksPath=` keeps a developer's global commit-msg hook out of the scratch repos.
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

function initRepo(path: string, file: string): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q'])
  git(path, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(path, file), 'base\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'base'])
}

/** A minimal live-session face: header cwd plus the tool/call events to scan. */
function sessionCtx(cwd: string, calls: Array<Record<string, unknown>>): Context {
  return {
    sessions: {
      get: () => ({
        header: { cwd },
        snapshotEvents: () => calls.map((data, index) => ({ type: 'tool/call', seq: index, time: index, data })),
      }),
    },
    get: () => undefined,
  } as never
}

/**
 * The same live-session face with the session LOOKUP counted. The root cache is
 * consulted before the session is ever read, so `lookups()` is the observable
 * difference between "answered from the TTL cache" and "scanned the event log
 * again" — which is what makes the no-rescan assertion below discriminative.
 */
function countingSessionCtx(cwd: string, calls: Array<Record<string, unknown>>): { ctx: Context; lookups: () => number } {
  let lookups = 0
  const ctx = {
    sessions: {
      get: () => {
        lookups += 1
        return {
          header: { cwd },
          snapshotEvents: () => calls.map((data, index) => ({ type: 'tool/call', seq: index, time: index, data })),
        }
      },
    },
    get: () => undefined,
  } as never
  return { ctx: ctx as Context, lookups: () => lookups }
}

describe('active worktree root', () => {
  it('follows a linked worktree of a DIFFERENT repository named by the tool calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')
    const worktreeB = join(root, 'worktree-b')
    try {
      initRepo(repoA, 'a.txt')
      initRepo(repoB, 'b.txt')
      git(repoB, ['worktree', 'add', '-q', '-b', 'agent', worktreeB])
      // The session's header cwd is repo A, but its newest tool call works in
      // a linked worktree of repo B  the sidebar must follow that worktree.
      const ctx = sessionCtx(repoA, [{ cwd: worktreeB, path: join(worktreeB, 'b.txt') }])
      // The roots come back from `git rev-parse --show-toplevel`, i.e. already
      // canonical: compare against the real path (macOS tmpdirs live under the
      // `/var` → `/private/var` symlink; same convention as git-worktree.spec).
      await expect(activeWorktreeRootOf(ctx, 's-cross-repo', repoA)).resolves.toBe(realpathSync.native(worktreeB))
    } finally {
      removeTree(root)
    }
  })

  it('keeps the session cwd when no tool call points at a linked worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    try {
      initRepo(repo, 'a.txt')
      const ctx = sessionCtx(repo, [{ cwd: join(repo, 'src') }])
      await expect(activeWorktreeRootOf(ctx, 's-no-worktree', repo)).resolves.toBe(realpathSync.native(repo))
    } finally {
      removeTree(root)
    }
  })

  it('probes the REAL path, never its case-folded identity (Linux is case-sensitive)', async () => {
    // `addActivePath` keys candidates by a lowercased identity; probing that
    // KEY instead of the path silently drops every candidate whose path has an
    // uppercase letter. macOS and Windows fold case and never noticed it —
    // `Repo-A` / `WorkTree-B` below make the difference visible on every host.
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repoA = join(root, 'Repo-A')
    const repoB = join(root, 'Repo-B')
    const worktreeB = join(root, 'WorkTree-B')
    try {
      initRepo(repoA, 'a.txt')
      initRepo(repoB, 'b.txt')
      git(repoB, ['worktree', 'add', '-q', '-b', 'agent', worktreeB])
      probed.length = 0
      const ctx = sessionCtx(repoA, [{ cwd: worktreeB, path: join(worktreeB, 'b.txt') }])
      await expect(activeWorktreeRootOf(ctx, 's-case', repoA)).resolves.toBe(realpathSync.native(worktreeB))
      expect(probed).toContain(worktreeB)
      expect(probed).not.toContain(worktreeB.toLowerCase())
    } finally {
      removeTree(root)
    }
  })

  /**
   * Steady-state cost: twelve `/sidebar/*` route handlers funnel through
   * `cwdOf()`, so a burst of parallel calls for one session used to spawn one
   * `git rev-parse` per call. The in-flight maps collapse the whole
   * (session, base) resolution into one.
   */
  it('shares ONE base git spawn across a burst of concurrent asks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    try {
      initRepo(repo, 'a.txt')
      const { ctx, lookups } = countingSessionCtx(repo, [])
      probed.length = 0
      const answers = await Promise.all(
        Array.from({ length: 8 }, () => activeWorktreeRootOf(ctx, 's-burst', repo)),
      )
      expect(probed).toEqual([repo])
      // The whole resolution is shared, not just the spawn: the event log is
      // read (and scanned) once for the burst.
      expect(lookups()).toBe(1)
      // Every concurrent caller still gets the resolved answer.
      expect(new Set(answers)).toEqual(new Set([realpathSync.native(repo)]))
    } finally {
      removeTree(root)
    }
  })

  /**
   * Different sessions rooted in the SAME repository share the base probe:
   * without the per-path in-flight map, N tabs of one workspace spawn N
   * `git rev-parse` processes at once. Each session still resolves on its own
   * (its own event log decides its root).
   */
  it('shares ONE base probe across different sessions of one repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    try {
      initRepo(repo, 'a.txt')
      const { ctx, lookups } = countingSessionCtx(repo, [])
      probed.length = 0
      await Promise.all(
        Array.from({ length: 6 }, (_unused, index) => activeWorktreeRootOf(ctx, `s-shared-${index}`, repo)),
      )
      expect(probed).toEqual([repo])
      expect(lookups()).toBe(6)
    } finally {
      removeTree(root)
    }
  })

  /** The TTL is what makes the client's 5 s poll free; 3 s made every poll a miss. */
  it('answers a second ask inside the TTL without scanning or spawning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    try {
      initRepo(repo, 'a.txt')
      mkdirSync(join(repo, 'src'))
      // A tool call INSIDE the repository: scanning it costs a probe, and the
      // answer is the repository top level.
      const { ctx, lookups } = countingSessionCtx(repo, [{ cwd: join(repo, 'src') }])
      const first = await activeWorktreeRootOf(ctx, 's-ttl', repo)
      expect(first).toBe(realpathSync.native(repo))
      expect(lookups()).toBe(1)
      expect(probed.length).toBeGreaterThan(0)

      probed.length = 0
      await expect(activeWorktreeRootOf(ctx, 's-ttl', repo)).resolves.toBe(first)
      // No spawn AND no event-log scan (the cache is consulted before the
      // session is read, so the scan never starts).
      expect(probed).toEqual([])
      expect(lookups()).toBe(1)
    } finally {
      removeTree(root)
    }
  })

  /**
   * The client's per-tab poll is every 5 s, so a 3 s TTL made every poll a
   * miss. The cached root must survive past the old window (10 s in, still a
   * hit) — the clock is moved, not the test.
   */
  it('serves the cached root 10 s later (longer than the old 3 s TTL)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    try {
      initRepo(repo, 'a.txt')
      const { ctx, lookups } = countingSessionCtx(repo, [])
      const first = await activeWorktreeRootOf(ctx, 's-ttl-span', repo)
      probed.length = 0
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
      try {
        await expect(activeWorktreeRootOf(ctx, 's-ttl-span', repo)).resolves.toBe(first)
      } finally {
        clock.mockRestore()
      }
      expect(probed).toEqual([])
      expect(lookups()).toBe(1)
    } finally {
      removeTree(root)
    }
  })

  /**
   * The three process-wide maps are bounded LRUs. The module exposes no test
   * seam, so the bound is observed the only way it is observable from outside:
   * after `cap` distinct sessions, the OLDEST session's next ask is a miss
   * again (it was evicted) while the youngest ones still hit.
   */
  it('bounds the root cache: the oldest session is evicted past the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    try {
      // The canned answer keeps the 257 probes from being 257 real processes;
      // `probed` still counts every probe the module made.
      seam.responder = (cwd) => `${cwd}\n`
      const ctx = sessionCtx(root, [])
      const cap = 256
      for (let index = 0; index <= cap; index += 1) {
        await activeWorktreeRootOf(ctx, `lru-${index}`, root)
      }
      expect(probed).toHaveLength(cap + 1)

      probed.length = 0
      // The oldest SURVIVOR and the newest key are still cached: no probe.
      await activeWorktreeRootOf(ctx, 'lru-1', root)
      await activeWorktreeRootOf(ctx, `lru-${cap}`, root)
      expect(probed).toEqual([])
      // Inserted first, so it is the one the cap evicted: re-asked, it probes.
      await activeWorktreeRootOf(ctx, 'lru-0', root)
      expect(probed).toEqual([root])
    } finally {
      seam.responder = null
      removeTree(root)
    }
  })

  /**
   * A followed worktree can be deleted out from under a RUNNING session
   * (`git worktree remove`, or a plain folder delete). Both process-wide maps
   * used to answer from a cached path forever, so the sidebar stayed pinned to
   * a directory that no longer existed — file tree "folder not found", git
   * panel "not a git repository" — with no recovery short of a host restart
   * (issue #960).
   */
  it('falls back to the repository when the followed worktree is deleted (#960)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    try {
      initRepo(repo, 'a.txt')
      git(repo, ['worktree', 'add', '-q', '-b', 'agent', worktree])
      const calls = [{ cwd: worktree, path: join(worktree, 'a.txt') }]
      const ctx = sessionCtx(repo, calls)
      await expect(activeWorktreeRootOf(ctx, 's-deleted', repo)).resolves.toBe(realpathSync.native(worktree))
      // The worktree disappears while the session keeps running.
      removeTree(worktree)
      // (1) the root TTL cache must not keep serving the dead path…
      await expect(activeWorktreeRootOf(ctx, 's-deleted', repo)).resolves.toBe(realpathSync.native(repo))
      // (2) …and a fresh session must not resurrect it through the inner caches.
      await expect(activeWorktreeRootOf(ctx, 's-deleted-fresh', repo)).resolves.toBe(realpathSync.native(repo))
    } finally {
      removeTree(root)
    }
  })


  /**
   * Two cases the first revision of the #960 fix got wrong (found in review):
   *
   *  · a TRANSIENT stat failure on a directory that still exists (a locked handle,
   *    an antivirus pass, a hung SMB/UNC worktree: EPERM/EACCES/EBUSY/EIO) must not
   *    re-root the session — only ENOENT/ENOTDIR prove the directory is gone;
   *  · a worktree that is deleted and then CREATED AGAIN must be followed again: a
   *    negative produced by the invalidation re-probe must not be cached, because
   *    `pathTopCache` has no TTL and would pin the session away for good.
   */
  it('a transient stat failure on a live directory does not re-root the session (#960 review)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    try {
      initRepo(repo, 'a.txt')
      git(repo, ['worktree', 'add', '-q', '-b', 'agent', worktree])
      const calls = [{ cwd: worktree, path: join(worktree, 'a.txt') }]
      const ctx = sessionCtx(repo, calls)
      await expect(activeWorktreeRootOf(ctx, 's-flaky', repo)).resolves.toBe(realpathSync.native(worktree))
      // The directory is still there; its stat fails for the WHOLE ask the way a locked
      // handle, an antivirus pass or a hung SMB/UNC worktree behaves. Only
      // ENOENT/ENOTDIR may be read as "gone": anything else must leave the session where
      // it is, instead of re-rooting it (and, with the old rule, for good).
      for (const code of ['EPERM', 'EBUSY', 'EACCES', 'EIO']) {
        statSeam.code = code
        statSeam.failNext = 50
        await expect(activeWorktreeRootOf(ctx, 's-flaky', repo)).resolves.toBe(realpathSync.native(worktree))
        statSeam.failNext = 0
      }
    } finally {
      statSeam.failNext = 0
      removeTree(root)
    }
  })

  it('re-follows a worktree that comes back after being deleted (#960 review)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    try {
      initRepo(repo, 'a.txt')
      git(repo, ['worktree', 'add', '-q', '-b', 'agent', worktree])
      const calls = [{ cwd: worktree, path: join(worktree, 'a.txt') }]
      const ctx = sessionCtx(repo, calls)
      await expect(activeWorktreeRootOf(ctx, 's-back', repo)).resolves.toBe(realpathSync.native(worktree))
      removeTree(worktree)
      await expect(activeWorktreeRootOf(ctx, 's-back', repo)).resolves.toBe(realpathSync.native(repo))
      // `git worktree prune` because the directory was deleted by hand, not by git.
      git(repo, ['worktree', 'prune'])
      git(repo, ['worktree', 'add', '-q', '-b', 'agent2', worktree])
      // The session that fell back keeps the repository until its 15 s TTL expires
      // (documented behaviour), but a FRESH ask must pick the worktree up again: the
      // invalidation re-probe deliberately does not cache its negative.
      await expect(activeWorktreeRootOf(ctx, 's-back-fresh', repo)).resolves.toBe(realpathSync.native(worktree))
    } finally {
      removeTree(root)
    }
  })
})
