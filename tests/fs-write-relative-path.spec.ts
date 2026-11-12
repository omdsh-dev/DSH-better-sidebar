import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTarget } from '../src/path-security.ts'
import { removeTree } from './temp-tree.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTree(d) })

describe('fs.write resolves session-relative paths (#646)', () => {
  it('resolves a relative write path against the session cwd', async () => {
    const dir = join(tmpdir(), 'dshm-646-a')
    dirs.push(dir)
    mkdirSync(join(dir, 'pastes'), { recursive: true })
    const result = resolveTarget(dir, 'pastes/test.txt')
    expect(result).toContain('pastes')
    expect(result).toContain('test.txt')
  })

  it('keeps an absolute write path unchanged', async () => {
    const dir = join(tmpdir(), 'dshm-646-b')
    dirs.push(dir)
    mkdirSync(dir, { recursive: true })
    const abs = join(dir, 'abs.txt')
    const result = resolveTarget(dir, abs)
    expect(result).toContain('abs.txt')
  })

  it('keeps a write outside the workspace (containment was removed with the path-security rewrite)', async () => {
    const dir = join(tmpdir(), 'dshm-646-c')
    dirs.push(dir)
    mkdirSync(join(dir, 'inside'), { recursive: true })
    const outside = join(tmpdir(), 'dshm-646-outside')
    mkdirSync(outside, { recursive: true })
    dirs.push(outside)
    const target = join(outside, 'x.txt')
    expect(resolveTarget(dir, target)).toBe(target)
  })

  it('expands a ~ home path instead of joining it under the cwd (#713)', async () => {
    const dir = join(tmpdir(), 'dshm-713')
    dirs.push(dir)
    mkdirSync(dir, { recursive: true })
    const { homedir } = await import('node:os')
    const result = resolveTarget(dir, '~/notes/x.txt')
    expect(result.startsWith(homedir())).toBe(true)
    expect(result).toContain(join('notes', 'x.txt'))
  })
})
