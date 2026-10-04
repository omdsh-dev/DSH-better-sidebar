/**
 * TEMPORARY diagnostic for the Linux-only failure of
 * `tests/active-worktree.spec.ts > follows a linked worktree of a DIFFERENT
 * repository named by the tool calls`. Deleted again once the cause is known;
 * every branch prints the raw value so one CI round trip is enough.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { activeWorktreeRootOf } from '../src/active-worktree.ts'
import { runGitRaw } from '../src/git.ts'
import type { Context } from '../src/context-types.ts'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

function git(cwd: string, args: string[]): string {
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

async function probe(label: string, run: () => Promise<string>): Promise<void> {
  try {
    console.error(`DIAG ${label} OK ${JSON.stringify(await run())}`)
  } catch (error) {
    console.error(`DIAG ${label} THREW ${String((error as Error).message)}`)
  }
}

describe('diagnostic', () => {
  it('prints every intermediate value of the cross-repo linked worktree scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-awt-diag-'))
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')
    const worktreeB = join(root, 'worktree-b')
    try {
      initRepo(repoA, 'a.txt')
      initRepo(repoB, 'b.txt')
      git(repoB, ['worktree', 'add', '-q', '-b', 'agent', worktreeB])
      console.error(`DIAG env git=${git(root, ['--version']).trim()}`)
      console.error(`DIAG paths root=${root} repoA=${repoA} worktreeB=${worktreeB}`)
      console.error(`DIAG realpath worktreeB=${realpathSync.native(worktreeB)} repoA=${realpathSync.native(repoA)}`)
      console.error(`DIAG isAbsolute repoA=${String(isAbsolute(repoA))} worktreeB=${String(isAbsolute(worktreeB))}`)
      await probe('plugin.show-toplevel(repoA)', () => runGitRaw(repoA, ['rev-parse', '--show-toplevel']))
      await probe('plugin.show-toplevel(worktreeB)', () => runGitRaw(worktreeB, ['rev-parse', '--show-toplevel']))
      await probe('plugin.dirs(worktreeB)', () => runGitRaw(worktreeB, ['rev-parse', '--absolute-git-dir', '--git-common-dir']))
      await probe('plugin.dirs(repoB)', () => runGitRaw(repoB, ['rev-parse', '--absolute-git-dir', '--git-common-dir']))
      await probe('plugin.show-toplevel(worktreeB/b.txt)', () => runGitRaw(join(worktreeB, 'b.txt'), ['rev-parse', '--show-toplevel']))
      await probe('spawnSync.show-toplevel(worktreeB)', async () => git(worktreeB, ['rev-parse', '--show-toplevel']))
      const ctx = sessionCtx(repoA, [{ cwd: worktreeB, path: join(worktreeB, 'b.txt') }])
      const active = await activeWorktreeRootOf(ctx, 's-diag', repoA)
      console.error(`DIAG activeWorktreeRootOf=${JSON.stringify(active)}`)
      const bare = await activeWorktreeRootOf(ctx, 's-diag-bare', worktreeB)
      console.error(`DIAG activeWorktreeRootOf(base=worktreeB)=${JSON.stringify(bare)}`)
      expect(active).toBe(realpathSync.native(worktreeB))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
