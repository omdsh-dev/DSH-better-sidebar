import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseWorktreeList, resolveWorktree, status, worktrees } from '../src/git.ts'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

describe('linked Git worktrees', () => {
  it('parses porcelain records with spaces in checkout paths', () => {
    expect(parseWorktreeList([
      'worktree C:/repo/main checkout',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/agent checkout',
      'HEAD def',
      'detached',
      '',
    ].join('\n'))).toEqual([
      { path: 'C:/repo/main checkout', branch: 'main', locked: false, prunable: false },
      { path: 'C:/repo/agent checkout', branch: 'HEAD', locked: false, prunable: false },
    ])
  })

  it('preserves locked metadata and marks stale records prunable', () => {
    expect(parseWorktreeList([
      'worktree C:/repo/locked',
      'HEAD abc',
      'branch refs/heads/locked',
      'locked in use',
      '',
      'worktree C:/repo/missing',
      'HEAD def',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\0'))).toEqual([
      { path: 'C:/repo/locked', branch: 'locked', locked: true, prunable: false },
      { path: 'C:/repo/missing', branch: 'HEAD', locked: false, prunable: true },
    ])
  })

  it('discovers dirty linked checkouts and fences selected targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-worktrees-'))
    const main = join(root, 'main')
    const agent = join(root, 'agent worktree')
    try {
      git(root, ['init', '-q', main])
      git(main, ['checkout', '-q', '-b', 'main'])
      writeFileSync(join(main, 'tracked.txt'), 'base\n')
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'base'])
      git(main, ['worktree', 'add', '-q', '-b', 'agent', agent])
      writeFileSync(join(agent, 'tracked.txt'), 'changed by agent\n')

      const listed = await worktrees(main)
      expect(listed).toHaveLength(2)
      expect(listed.find(entry => entry.current)).toMatchObject({ branch: 'main', changes: 0 })
      expect(listed.find(entry => !entry.current)).toMatchObject({ branch: 'agent', changes: 1 })
      expect(resolve(await resolveWorktree(main, agent))).toBe(resolve(agent))
      expect((await status(await resolveWorktree(main, agent))).entries).toEqual([
        { path: 'tracked.txt', xy: ' M' },
      ])
      await expect(resolveWorktree(main, root)).rejects.toThrow('unknown linked worktree')

      // Git retains administrative metadata after a checkout directory is
      // deleted, reporting the record as prunable. It must disappear from both
      // the selector inventory and the accepted command-target allowlist.
      rmSync(agent, { recursive: true, force: true })
      const remaining = await worktrees(main)
      expect(remaining).toHaveLength(1)
      expect(resolve(remaining[0]!.path)).toBe(resolve(main))
      expect(remaining[0]!.current).toBe(true)
      await expect(resolveWorktree(main, agent)).rejects.toThrow('unknown linked worktree')
    } finally {
      try { git(main, ['worktree', 'remove', '--force', agent]) } catch { /* fixture may not be fully initialized */ }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
