import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureWorkspaceWritePath } from '../src/path-security.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('fs.write resolves session-relative paths (#646)', () => {
  it('resolves a relative write path against the session cwd', async () => {
    const dir = join(tmpdir(), 'dshm-646-a')
    dirs.push(dir)
    mkdirSync(join(dir, 'pastes'), { recursive: true })
    const result = await ensureWorkspaceWritePath(dir, 'pastes/test.txt', false)
    expect(result).toContain('pastes')
    expect(result).toContain('test.txt')
  })

  it('keeps an absolute write path unchanged', async () => {
    const dir = join(tmpdir(), 'dshm-646-b')
    dirs.push(dir)
    mkdirSync(dir, { recursive: true })
    const abs = join(dir, 'abs.txt')
    const result = await ensureWorkspaceWritePath(dir, abs, false)
    expect(result).toContain('abs.txt')
  })

  it('still fences a write outside the workspace', async () => {
    const dir = join(tmpdir(), 'dshm-646-c')
    dirs.push(dir)
    mkdirSync(join(dir, 'inside'), { recursive: true })
    const outside = join(tmpdir(), 'dshm-646-outside')
    mkdirSync(outside, { recursive: true })
    dirs.push(outside)
    await expect(ensureWorkspaceWritePath(dir, join(outside, 'x.txt'), true))
      .rejects.toThrow()
  })
})
