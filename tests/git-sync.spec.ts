/**
 * Sync spec: git push / pull / fetch / upstream tracking against a local
 * bare remote — no network, no global git config (identity comes from the
 * fixture environment, mirroring smoke.spec.ts).
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git from '../src/git.ts'

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

/** A bare remote + a worktree clone of it, both under one temp dir. The bare
 *  HEAD is pinned to `refs/heads/main` so clones start on `main` directly
 *  (no master/main ambiguity), and `core.autocrlf` is off so CRLF never
 *  sneaks into content assertions on Windows. */
const makeSyncFixture = (): { root: string; remote: string; clone: string } => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-sync-'))
  const remote = join(root, 'remote.git')
  const clone = join(root, 'clone')
  gitRun(root, ['init', '-q', '--bare', remote])
  gitRun(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  gitRun(root, ['clone', '-q', remote, clone])
  gitRun(clone, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(clone, 'a.txt'), 'one\n')
  gitRun(clone, ['add', '-A'])
  gitRun(clone, ['commit', '-q', '-m', 'base'])
  gitRun(clone, ['push', '-q', '-u', 'origin', 'main'])
  return { root, remote, clone }
}

describe('git upstream tracking', () => {
  it('returns null before any upstream is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upstream-'))
    try {
      gitRun(root, ['init', '-q'])
      writeFileSync(join(root, 'x.txt'), 'x\n')
      gitRun(root, ['add', '-A'])
      gitRun(root, ['commit', '-q', '-m', 'init'])
      expect(await git.upstreamInfo(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports remote / branch and ahead-behind counts', async () => {
    const { root, clone } = makeSyncFixture()
    try {
      const info = await git.upstreamInfo(clone)
      expect(info).not.toBeNull()
      expect(info!.remote).toBe('origin')
      expect(info!.branch).toBe('main')
      expect(info!.ahead).toBe(0)
      expect(info!.behind).toBe(0)

      writeFileSync(join(clone, 'a.txt'), 'one\ntwo\n')
      gitRun(clone, ['add', '-A'])
      gitRun(clone, ['commit', '-q', '-m', 'local'])
      const ahead = await git.upstreamInfo(clone)
      expect(ahead!.ahead).toBe(1)
      expect(ahead!.behind).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('git push / pull / fetch', () => {
  it('push publishes local commits to the remote (ahead drops to 0)', async () => {
    const { root, clone } = makeSyncFixture()
    try {
      writeFileSync(join(clone, 'b.txt'), 'b\n')
      gitRun(clone, ['add', '-A'])
      gitRun(clone, ['commit', '-q', '-m', 'feature'])
      expect((await git.upstreamInfo(clone))!.ahead).toBe(1)
      await git.push(clone)
      expect((await git.upstreamInfo(clone))!.ahead).toBe(0)
      const remoteHead = gitRun(join(root, 'remote.git'), ['log', '--oneline', '-1'])
      expect(remoteHead).toContain('feature')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pull fast-forwards local commits from the remote', async () => {
    const { root, clone } = makeSyncFixture()
    try {
      const other = join(root, 'other')
      gitRun(root, ['clone', '-q', join(root, 'remote.git'), other])
      gitRun(other, ['config', 'core.autocrlf', 'false'])
      writeFileSync(join(other, 'c.txt'), 'c\n')
      gitRun(other, ['add', '-A'])
      gitRun(other, ['commit', '-q', '-m', 'remote-work'])
      gitRun(other, ['push', '-q', 'origin', 'main'])

      // Without a fetch the local remote-tracking ref is stale, so `behind`
      // is 0 by design; `pull` itself fetches, then fast-forwards.
      expect(gitRun(clone, ['log', '--oneline', '-1'])).toContain('base')
      await git.pull(clone)
      expect(gitRun(clone, ['log', '--oneline', '-1'])).toContain('remote-work')
      expect((await git.upstreamInfo(clone))!.behind).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fetch updates the remote-tracking ref without moving HEAD', async () => {
    const { root, clone } = makeSyncFixture()
    try {
      const other = join(root, 'other')
      gitRun(root, ['clone', '-q', join(root, 'remote.git'), other])
      gitRun(other, ['config', 'core.autocrlf', 'false'])
      writeFileSync(join(other, 'd.txt'), 'd\n')
      gitRun(other, ['add', '-A'])
      gitRun(other, ['commit', '-q', '-m', 'fetched-work'])
      gitRun(other, ['push', '-q', 'origin', 'main'])

      const localHeadBefore = gitRun(clone, ['rev-parse', 'HEAD'])
      await git.fetchRemote(clone)
      expect(gitRun(clone, ['rev-parse', 'HEAD']).trim()).toBe(localHeadBefore.trim())
      expect((await git.upstreamInfo(clone))!.behind).toBe(1)
      expect(gitRun(clone, ['log', '--oneline', '-1', 'origin/main'])).toContain('fetched-work')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('force push uses --force-with-lease and refuses to clobber unseen remote commits', async () => {
    const { root, clone } = makeSyncFixture()
    try {
      const other = join(root, 'other')
      gitRun(root, ['clone', '-q', join(root, 'remote.git'), other])
      gitRun(other, ['checkout', '-q', 'main'])
      writeFileSync(join(other, 'e.txt'), 'e\n')
      gitRun(other, ['add', '-A'])
      gitRun(other, ['commit', '-q', '-m', 'someone-else'])
      gitRun(other, ['push', '-q', 'origin', 'main'])

      // Rewrite history locally WITHOUT fetching: the lease is stale, so the
      // forced push must be refused — the safety guarantee of the button.
      writeFileSync(join(clone, 'a.txt'), 'rewritten\n')
      gitRun(clone, ['add', '-A'])
      gitRun(clone, ['commit', '-q', '--amend', '-m', 'rewritten'])
      await expect(git.push(clone, true)).rejects.toThrow()
      // The remote still holds the other side's commit.
      expect(gitRun(join(root, 'remote.git'), ['log', '--oneline', '-1'])).toContain('someone-else')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
