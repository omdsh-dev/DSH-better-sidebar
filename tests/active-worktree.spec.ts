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
 * Count actual event-log snapshots, not cheap session scans. Alpha.5 reads the
 * live cursor to invalidate explicit directory changes, even on a cache hit;
 * that must not copy or rescan the log during the TTL window.
 */
function countingSessionCtx(cwd: string, calls: Array<Record<string, unknown>>): { ctx: Context; scans: () => number } {
  let scans = 0
  const ctx = {
    sessions: {
      get: () => {
        return {
          header: { cwd },
          snapshotEvents: () => {
            scans += 1
            return calls.map((data, index) => ({ type: 'tool/call', seq: index, time: index, data }))
          },
        }
      },
    },
    get: () => undefined,
  } as never
  return { ctx: ctx as Context, scans: () => scans }
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
      const { ctx, scans } = countingSessionCtx(repo, [])
      probed.length = 0
      const answers = await Promise.all(
        Array.from({ length: 8 }, () => activeWorktreeRootOf(ctx, 's-burst', repo)),
      )
      expect(probed).toEqual([repo])
      // The whole resolution is shared, not just the spawn: the event log is
      // read (and scanned) once for the burst.
      expect(scans()).toBe(1)
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
      const { ctx, scans } = countingSessionCtx(repo, [])
      probed.length = 0
      await Promise.all(
        Array.from({ length: 6 }, (_unused, index) => activeWorktreeRootOf(ctx, `s-shared-${index}`, repo)),
      )
      expect(probed).toEqual([repo])
      expect(scans()).toBe(6)
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
      const { ctx, scans } = countingSessionCtx(repo, [{ cwd: join(repo, 'src') }])
      const first = await activeWorktreeRootOf(ctx, 's-ttl', repo)
      expect(first).toBe(realpathSync.native(repo))
      expect(scans()).toBe(1)
      expect(probed.length).toBeGreaterThan(0)

      probed.length = 0
      await expect(activeWorktreeRootOf(ctx, 's-ttl', repo)).resolves.toBe(first)
      // No spawn AND no event-log snapshot/scan, despite checking the live cursor.
      expect(probed).toEqual([])
      expect(scans()).toBe(1)
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
      const { ctx, scans } = countingSessionCtx(repo, [])
      const first = await activeWorktreeRootOf(ctx, 's-ttl-span', repo)
      probed.length = 0
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
      try {
        await expect(activeWorktreeRootOf(ctx, 's-ttl-span', repo)).resolves.toBe(first)
      } finally {
        clock.mockRestore()
      }
      expect(probed).toEqual([])
      expect(scans()).toBe(1)
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
})
