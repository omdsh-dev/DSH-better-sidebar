import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diff, discard, repositories, stage, unstage } from '../src/git.ts'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-c', 'user.email=test@dsh.local',
    '-c', 'user.name=Test',
    ...args,
  ], { cwd, encoding: 'utf8' })
  return stdout
}

describe('nested Git repositories', () => {
  let workspace: string
  let nested: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'better-sidebar-nested-repos-'))
    nested = join(workspace, 'nested')

    await git(workspace, 'init', '-b', 'main')
    await writeFile(join(workspace, '.gitignore'), 'nested/\n')
    await writeFile(join(workspace, 'outer.txt'), 'outer baseline\n')
    await git(workspace, 'add', '.')
    await git(workspace, 'commit', '-m', 'outer baseline')

    await mkdir(nested)
    await git(nested, 'init', '-b', 'main')
    await writeFile(join(nested, 'inner.txt'), 'inner baseline\n')
    await git(nested, 'add', '.')
    await git(nested, 'commit', '-m', 'inner baseline')

    await writeFile(join(workspace, 'outer.txt'), 'outer changed\n')
    await writeFile(join(nested, 'inner.txt'), 'inner changed\n')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('lists the containing repository and ignored independent repositories', async () => {
    const result = await repositories(workspace)

    expect(result).toEqual([
      expect.objectContaining({ root: workspace, entries: [{ path: 'outer.txt', xy: ' M' }] }),
      expect.objectContaining({ root: nested, entries: [{ path: 'inner.txt', xy: ' M' }] }),
    ])
  })

  it('stages a path in the selected nested repository only', async () => {
    await stage(workspace, 'inner.txt', nested)

    const nestedIndex = await git(nested, 'diff', '--cached', '--name-only')
    const outerIndex = await git(workspace, 'diff', '--cached', '--name-only')
    expect(nestedIndex.trim()).toBe('inner.txt')
    expect(outerIndex.trim()).toBe('')
  })

  it('routes unstage, discard, and diff to the selected nested repository', async () => {
    await stage(workspace, 'inner.txt', nested)
    await unstage(workspace, 'inner.txt', nested)
    expect((await git(nested, 'diff', '--cached', '--name-only')).trim()).toBe('')

    expect(await diff(workspace, 'inner.txt', false, nested)).toContain('+inner changed')
    await discard(workspace, 'inner.txt', nested)
    expect((await git(nested, 'diff', '--name-only')).trim()).toBe('')
  })
})
