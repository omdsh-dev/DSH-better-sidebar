import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeWorktreeRootOf } from '../src/active-worktree.ts'
import { pinSessionRoot, unpinSessionRoot } from '../src/session-root.ts'
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

/**
 * A live session face with a MUTABLE event cursor: `seq` moves when an event
 * is appended, exactly like the host's. `scans` counts real snapshot reads, so
 * a cache hit that only compared the cursor costs zero.
 */
function cursorSessionCtx(
  cwd: string,
  calls: Array<Record<string, unknown>>,
  initialSeq = 5,
): { ctx: Context; scans: () => number; append: () => void } {
  let scans = 0
  let seq = initialSeq
  const ctx = {
    sessions: {
      get: () => {
        return {
          header: { cwd },
          seq,
          snapshotEvents: () => {
            scans += 1
            return calls.map((data, index) => ({ type: 'tool/call', seq: index, time: index, data }))
          },
        }
      },
    },
    get: () => undefined,
  } as never
  return { ctx: ctx as Context, scans: () => scans, append: () => { seq += 1 } }
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
      // The root is the session cwd with no repository-top lift; the realpath
      // canonicalization (a macOS tmpdir's `/var` → `/private/var`) is
      // independent of that and matches every other resolved root here.
      await expect(activeWorktreeRootOf(ctx, 's-no-worktree', repo)).resolves.toBe(realpathSync.native(repo))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A relative link (`tools/a.md`) is resolved against this root, so lifting it
  // to the repository top level opens `<repo>/tools/a.md` instead of
  // `<repo>/<subdir>/tools/a.md`. ASCII, CJK, and CJK-in-NFD are three separate
  // cases on purpose: they must fail TOGETHER, which is what separates a
  // git-top-level lift from a Unicode normalization artifact — normalization
  // could only move the non-ASCII spelling, and it could never drop a whole
  // path segment.
  for (const [label, sessionId, subdirectory] of [
    ['an ASCII', 's-subdir-ascii', 'sub-en'],
    ['a non-ASCII', 's-subdir-cjk', '社媒运营'],
    // A name with a REAL canonical decomposition: `café` NFD is `e` + U+0301,
    // so this case would move under normalization while the two above cannot.
    ['a canonically decomposed (NFD) non-ASCII', 's-subdir-nfd', 'café'.normalize('NFD')],
  ] as const) {
    it(`keeps ${label} subdirectory session cwd instead of lifting it to the repository top level`, async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-active-root-')))
      const repo = join(root, 'repo')
      const base = join(repo, subdirectory)
      try {
        initRepo(repo, 'a.txt')
        mkdirSync(join(base, 'tools'), { recursive: true })
        writeFileSync(join(base, 'tools', 'a.md'), '# a\n')
        const ctx = sessionCtx(base, [])
        await expect(activeWorktreeRootOf(ctx, sessionId, base)).resolves.toBe(base)
        // The reported symptom, asserted on the resolved path itself.
        expect(readFileSync(join(await activeWorktreeRootOf(ctx, sessionId, base), 'tools', 'a.md'), 'utf8'))
          .toBe('# a\n')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('still follows a linked worktree when the session cwd is a subdirectory', async () => {
    // The subdirectory root must not cost the worktree-following feature: a
    // session that MOVED into a linked worktree is still followed.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-active-root-')))
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    try {
      initRepo(repo, 'a.txt')
      mkdirSync(join(repo, 'src'), { recursive: true })
      git(repo, ['worktree', 'add', '-q', '-b', 'agent', worktree])
      const ctx = sessionCtx(join(repo, 'src'), [{ cwd: worktree, path: join(worktree, 'a.txt') }])
      await expect(activeWorktreeRootOf(ctx, 's-subdir-worktree', join(repo, 'src')))
        .resolves.toBe(realpathSync.native(worktree))
    } finally {
      removeTree(root)
    }
  })

  /**
   * The explicit pin (the explorer's root picker) outranks every inference —
   * including the environment override, which is process-wide and therefore the
   * wrong tool when one session must be brought back to a checkout the reader
   * chose. `ignorePin` is what the picker's own read uses to show what
   * "automatic" would resolve to.
   */
  it('serves an explicit pin over the inference and the environment override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')
    const worktreeB = join(root, 'worktree-b')
    const sessionId = 's-pinned'
    try {
      initRepo(repoA, 'a.txt')
      initRepo(repoB, 'b.txt')
      git(repoB, ['worktree', 'add', '-q', '-b', 'agent', worktreeB])
      const ctx = sessionCtx(repoA, [{ cwd: worktreeB, path: join(worktreeB, 'b.txt') }])
      pinSessionRoot(sessionId, realpathSync.native(repoA))
      await expect(activeWorktreeRootOf(ctx, sessionId, repoA)).resolves.toBe(realpathSync.native(repoA))
      // The picker's read still sees the inference …
      await expect(activeWorktreeRootOf(ctx, sessionId, repoA, { ignorePin: true })).resolves.toBe(realpathSync.native(worktreeB))
      // … and the process-wide override cannot take the session away from it.
      const previous = process.env.DSH_SIDEBAR_WORKTREE_ROOT
      process.env.DSH_SIDEBAR_WORKTREE_ROOT = realpathSync.native(repoB)
      try {
        await expect(activeWorktreeRootOf(ctx, sessionId, repoA)).resolves.toBe(realpathSync.native(repoA))
      } finally {
        if (previous === undefined) delete process.env.DSH_SIDEBAR_WORKTREE_ROOT
        else process.env.DSH_SIDEBAR_WORKTREE_ROOT = previous
      }
      // Clearing the pin hands the session straight back to the inference.
      unpinSessionRoot(sessionId)
      await expect(activeWorktreeRootOf(ctx, sessionId, repoA)).resolves.toBe(realpathSync.native(worktreeB))
    } finally {
      unpinSessionRoot(sessionId)
      removeTree(root)
    }
  })

  it('drops a pin whose checkout was removed and falls back to the inference', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    const sessionId = 's-pin-gone'
    try {
      initRepo(repo, 'a.txt')
      const pinned = join(root, 'ghost-checkout')
      mkdirSync(pinned)
      // The route stores what `git worktree list` reports, i.e. a canonical
      // path (macOS tmpdirs live under the `/var` → `/private/var` symlink).
      const canonical = realpathSync.native(pinned)
      const ctx = sessionCtx(repo, [{ cwd: join(repo, 'src') }])
      pinSessionRoot(sessionId, canonical)
      await expect(activeWorktreeRootOf(ctx, sessionId, repo)).resolves.toBe(canonical)
      rmSync(pinned, { recursive: true, force: true })
      await expect(activeWorktreeRootOf(ctx, sessionId, repo)).resolves.toBe(realpathSync.native(repo))
    } finally {
      unpinSessionRoot(sessionId)
      removeTree(root)
    }
  })

  // A workspace registered at `<repo>/<subdir>` (a plain subdirectory, not a
  // linked worktree) must keep that subdirectory as the root: a relative link
  // such as `tools/a.md` is resolved against it, so lifting the root to
  // `<repo>` opens `<repo>/tools/a.md` and ENOENTs (#1024 / #1080). The ASCII
  // and Chinese names are separate cases on purpose: a Unicode normalization
  // artifact can move a spelling, but it cannot drop a whole path segment.
  for (const [label, subdirectory, sessionId] of [
    ['an ASCII', 'sub-en', 's-subdir-en'],
    ['a Chinese', '社媒运营', 's-subdir-zh'],
  ] as const) {
    it(`keeps ${label} subdirectory session cwd instead of lifting it to the repository top level`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
      const repo = join(root, 'repo')
      const base = join(repo, subdirectory)
      try {
        initRepo(repo, 'a.txt')
        mkdirSync(join(base, 'tools'), { recursive: true })
        writeFileSync(join(base, 'tools', 'a.md'), '# a\n')
        const ctx = sessionCtx(base, [])
        const resolved = await activeWorktreeRootOf(ctx, sessionId, base)
        expect(resolved).toBe(realpathSync.native(base))
        // The reported symptom, asserted on a real read through the root: the
        // file exists one level below the repository top level.
        expect(readFileSync(join(resolved, 'tools', 'a.md'), 'utf8')).toBe('# a\n')
      } finally {
        removeTree(root)
      }
    })
  }

  it('keeps a session cwd that is a SUBDIRECTORY of the repository', async () => {
    // A workspace registered at `<repo>/workspace` (a plain subdirectory, not a
    // linked worktree) must stay the root: replacing it with the repository
    // toplevel makes every relative path resolve one level too high.
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    const subdir = join(repo, 'workspace')
    try {
      initRepo(repo, 'a.txt')
      mkdirSync(subdir)
      const ctx = sessionCtx(subdir, [])
      await expect(activeWorktreeRootOf(ctx, 's-subdir', subdir)).resolves.toBe(realpathSync.native(subdir))
    } finally {
      removeTree(root)
    }
  })

  it('answers a detached session with its base and never reads the stored log', async () => {
    // A detached session has no live events; folding the STORED log would decode
    // the whole artifact for a follow-the-agent nicety the workspace address
    // already answers. The guard must return before any persistence read or git
    // probe — this is what removes the startup read storm.
    const opened: string[] = []
    probed.length = 0
    const ctx = {
      sessions: { get: () => undefined },
      get: (key: string) => key === 'sessionPersistence'
        ? { open: async (id: string) => { opened.push(id); throw new Error('a detached session must not be read') } }
        : undefined,
    } as never
    await expect(activeWorktreeRootOf(ctx, 's-detached', '/tmp/workspace-address')).resolves.toBe('/tmp/workspace-address')
    expect(opened, 'no persistence read for a detached session').toEqual([])
    expect(probed, 'no git probe once the base is the answer').toEqual([])
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
   * A TTL miss is not automatically a rescan: the entry is only invalid because
   * wall time passed, and the resolver reads the event log (up to 4000 events
   * + git probes, measured 9.6–44.7 ms). When the session's cursor has not
   * moved, nothing it reads can have changed — re-arm the TTL instead of
   * snapshotting the log again. This is the idle 5 s poll's hot path.
   */
  it('does not re-scan the event log after the TTL when the session cursor is unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    try {
      initRepo(repo, 'a.txt')
      mkdirSync(join(repo, 'src'))
      const { ctx, scans, append } = cursorSessionCtx(repo, [{ cwd: join(repo, 'src') }])
      const first = await activeWorktreeRootOf(ctx, 's-cursor', repo)
      expect(first).toBe(realpathSync.native(repo))
      expect(scans()).toBe(1)

      probed.length = 0
      const started = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(started + 60_000)
      try {
        await expect(activeWorktreeRootOf(ctx, 's-cursor', repo)).resolves.toBe(first)
        expect(scans(), 'an idle TTL expiry must not snapshot the log').toBe(1)
        expect(probed).toEqual([])

        // A new event moves the cursor: the next expiry re-scans (inside the
        // re-armed TTL the cached root still wins — the 15 s follow bound).
        append()
        clock.mockReturnValue(started + 120_000)
        await expect(activeWorktreeRootOf(ctx, 's-cursor', repo)).resolves.toBe(first)
        expect(scans(), 'a moved cursor re-scans').toBe(2)
      } finally {
        clock.mockRestore()
      }
    } finally {
      removeTree(root)
    }
  })

  /**
   * A cache entry whose base probe found NO repository (or failed) must keep
   * the wall-clock re-probe even when the event cursor is idle: `git init` in
   * a parent, a transient spawn failure, or a mount that comes back are all
   * invisible to the event log. Only a resolved git top may be re-armed.
   */
  it('keeps re-probing a non-repository base after the TTL with an idle cursor', async () => {
    // A plain directory: `git rev-parse` fails, so the answer is the base.
    const base = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    try {
      const { ctx, scans } = cursorSessionCtx(base, [])
      probed.length = 0
      await expect(activeWorktreeRootOf(ctx, 's-norepo', base)).resolves.toBe(base)
      expect(probed).toEqual([base])
      expect(scans()).toBe(0)

      probed.length = 0
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
      try {
        await expect(activeWorktreeRootOf(ctx, 's-norepo', base)).resolves.toBe(base)
        expect(probed, 'a negative repository answer must not be re-armed forever').toEqual([base])
      } finally {
        clock.mockRestore()
      }
    } finally {
      removeTree(base)
    }
  })

  /**
   * The fallback: hosts (and detached sessions) without a live cursor expose no
   * `seq`, so the TTL keeps its old meaning — expire means re-scan.
   */
  it('re-scans after the TTL when the host exposes no event cursor', async () => {
    probed.length = 0
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    try {
      initRepo(repo, 'a.txt')
      const { ctx, scans } = countingSessionCtx(repo, [{ cwd: join(repo, 'src') }])
      await activeWorktreeRootOf(ctx, 's-no-cursor', repo)
      expect(scans()).toBe(1)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
      try {
        await activeWorktreeRootOf(ctx, 's-no-cursor', repo)
        expect(scans()).toBe(2)
      } finally {
        clock.mockRestore()
      }
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
    // Probe calls are module-wide; this case counts them from a clean slate.
    probed.length = 0
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

  it('does not adopt a nested repository worktree that lives INSIDE the workspace (#952)', async () => {
    // A container workspace (itself a repo) holding sub-projects is normal
    // content: re-rooting the explorer into `W/nested/wt` hides every sibling.
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const container = join(root, 'W')
    const nested = join(container, 'nested')
    const nestedWt = join(nested, 'wt')
    try {
      initRepo(container, 'a.txt')
      initRepo(nested, 'b.txt')
      git(nested, ['worktree', 'add', '-q', '-b', 'feat', nestedWt])
      const ctx = sessionCtx(container, [{ cwd: nestedWt, file_path: join(nestedWt, 'b.txt') }])
      // The workspace root is the answer, not the nested checkout.
      await expect(activeWorktreeRootOf(ctx, 's-nested', container)).resolves.toBe(realpathSync.native(container))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not adopt the worktrees of a nested BARE repository (#952, reported layout)', async () => {
    // The reporter's real shape: `W/paper_downloader` is a bare repo and
    // `W/paper_downloader/{main,local}` are its linked worktrees.
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const container = join(root, 'W')
    const seed = join(root, 'seed')
    const bare = join(container, 'paper_downloader')
    const bareMain = join(bare, 'main')
    try {
      initRepo(container, 'a.txt')
      initRepo(seed, 'b.txt')
      git(root, ['clone', '--bare', '-q', seed, bare])
      // `-b wt`: the bare clone's own HEAD already owns `main`, and one branch
      // cannot be checked out in two worktrees.
      git(bare, ['worktree', 'add', '-q', bareMain, '-b', 'wt'])
      const ctx = sessionCtx(container, [{ cwd: bareMain, path: join(bareMain, 'b.txt') }])
      await expect(activeWorktreeRootOf(ctx, 's-bare', container)).resolves.toBe(realpathSync.native(container))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still follows the SAME repository worktree inside the workspace (#802 / #947 layout)', async () => {
    // `.worktrees/<branch>` of the session's own repo IS the session moving.
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    const worktree = join(repo, 'frontend', '.worktrees', 'wt')
    try {
      initRepo(repo, 'a.txt')
      mkdirSync(join(repo, 'frontend', '.worktrees'), { recursive: true })
      git(repo, ['worktree', 'add', '-q', '-b', 'agent', worktree])
      const ctx = sessionCtx(repo, [{ cwd: worktree, path: join(worktree, 'a.txt') }])
      await expect(activeWorktreeRootOf(ctx, 's-same-repo', repo)).resolves.toBe(realpathSync.native(worktree))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still follows a worktree of the same repository OUTSIDE the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-active-root-'))
    const repo = join(root, 'repo')
    const worktree = join(root, 'outside-wt')
    try {
      initRepo(repo, 'a.txt')
      git(repo, ['worktree', 'add', '-q', '-b', 'agent', worktree])
      const ctx = sessionCtx(repo, [{ cwd: worktree, path: join(worktree, 'a.txt') }])
      await expect(activeWorktreeRootOf(ctx, 's-outside', repo)).resolves.toBe(realpathSync.native(worktree))
    } finally {
      rmSync(root, { recursive: true, force: true })
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
