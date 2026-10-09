import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeWorktreeRootOf } from '../src/active-worktree.ts'
import type { Context } from '../src/context-types.ts'

/** Every cwd handed to the plugin's own git probe, in call order. */
const probed = vi.hoisted(() => [] as string[])

// Records (and delegates to) the real spawn so the case-folding regression is
// visible on case-insensitive hosts too.
vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.ts')>()
  return {
    ...actual,
    runGit: (cwd: string, args: string[], timeoutMs?: number) => {
      probed.push(cwd)
      return actual.runGit(cwd, args, timeoutMs)
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
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
    }
  })
})
