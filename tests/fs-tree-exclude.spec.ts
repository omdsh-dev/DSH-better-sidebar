/**
 * fs-tree exclude filtering: the explorerExclude pref compiles into a probe
 * that listDirectory and the singleton-fold probe share. Matched entries
 * vanish from the listing (VS Code files.exclude semantics), never occupy a
 * row or an overflow slot, and never block a breadcrumb fold.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileExcludePatterns } from '../src/exclude-patterns.ts'
import { listDirectory } from '../src/fs-tree.ts'

/** A scratch tree exercising name, path-anchored and deep patterns. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-exclude-'))
  writeFileSync(join(dir, '.DS_Store'), 'junk')
  writeFileSync(join(dir, 'keep.txt'), 'keep')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'dep')
  mkdirSync(join(dir, 'build', 'out'), { recursive: true })
  writeFileSync(join(dir, 'build', 'out', 'app.js'), 'artifact')
  writeFileSync(join(dir, 'build', 'main.ts'), 'source')
  mkdirSync(join(dir, 'src', 'out'), { recursive: true })
  writeFileSync(join(dir, 'src', 'out', 'gen.ts'), 'generated')
  // Singleton chain with excluded junk beside the sole child.
  mkdirSync(join(dir, 'chain', 'inner'), { recursive: true })
  mkdirSync(join(dir, 'chain', 'node_modules'), { recursive: true })
  // Terminal link with an excluded file beside the sole FILE child.
  mkdirSync(join(dir, 'terminal'))
  writeFileSync(join(dir, 'terminal', 'only.txt'), 'only')
  writeFileSync(join(dir, 'terminal', 'debug.log'), 'log')
  return dir
}

describe('fs-tree exclude filtering', () => {
  it('drops matched entries from the listing (bare names at any depth)', async () => {
    const dir = makeFixture()
    try {
      const exclude = compileExcludePatterns(['.DS_Store', 'node_modules'], dir)
      const root = await listDirectory(dir, 1000, exclude)
      const names = root.entries.map(entry => entry.name)
      expect(names).not.toContain('.DS_Store')
      expect(names).not.toContain('node_modules')
      expect(names).toContain('keep.txt')
      expect(names).toContain('build')
      // The same bare name vanishes wherever it appears.
      const chain = await listDirectory(join(dir, 'chain'), 1000, exclude)
      expect(chain.entries.map(entry => entry.name)).toEqual(['inner'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('path-anchored patterns match the full cwd-relative path only', async () => {
    const dir = makeFixture()
    try {
      const exclude = compileExcludePatterns(['build/out'], dir)
      // The anchored level: `build/out` drops as one row, its sibling stays.
      const root = await listDirectory(dir, 1000, exclude)
      expect(root.entries.map(entry => entry.name)).toContain('build')
      const build = await listDirectory(join(dir, 'build'), 1000, exclude)
      expect(build.entries.map(entry => entry.name)).toEqual(['main.ts'])
      // The same tail shape elsewhere is NOT excluded (no anchor match).
      const src = await listDirectory(join(dir, 'src'), 1000, exclude)
      expect(src.entries.map(entry => entry.name)).toEqual(['out'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a doublestar-slash pattern matches at any depth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-exclude-deep-'))
    try {
      mkdirSync(join(dir, 'logs'))
      mkdirSync(join(dir, 'nested', 'logs'), { recursive: true })
      writeFileSync(join(dir, 'nested', 'keep.txt'), 'keep')
      const exclude = compileExcludePatterns(['**/logs'], dir)
      expect((await listDirectory(dir, 1000, exclude)).entries.map(entry => entry.name)).toEqual(['nested'])
      const nested = await listDirectory(join(dir, 'nested'), 1000, exclude)
      expect(nested.entries.map(entry => entry.name)).toEqual(['keep.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('excluded entries never block the singleton fold probe', async () => {
    const dir = makeFixture()
    try {
      const exclude = compileExcludePatterns(['node_modules', '*.log'], dir)
      const root = await listDirectory(dir, 1000, exclude)
      // Excluded dir beside the sole child: still a fold singleton.
      expect(root.entries.find(entry => entry.name === 'chain')).toMatchObject({ isDir: true, compact: true })
      // Excluded file beside the sole FILE child (terminal link): marked.
      expect(root.entries.find(entry => entry.name === 'terminal')).toMatchObject({ isDir: true, compact: true })
      // Without the probe the junk entries break the fold.
      const unfiltered = await listDirectory(dir)
      expect(unfiltered.entries.find(entry => entry.name === 'chain')?.compact).toBeUndefined()
      expect(unfiltered.entries.find(entry => entry.name === 'terminal')?.compact).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('excluded rows neither render nor count toward the level cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-exclude-cap-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      writeFileSync(join(dir, 'b.txt'), 'b')
      writeFileSync(join(dir, 'junk.log'), 'junk')
      const exclude = compileExcludePatterns(['*.log'], dir)
      const result = await listDirectory(dir, 2, exclude)
      expect(result.truncated).toBe(false)
      expect(result.entries.map(entry => entry.name)).toEqual(['a.txt', 'b.txt'])
      // Same level without the probe: the cap trips.
      expect((await listDirectory(dir, 2)).truncated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an undefined probe leaves the listing untouched', async () => {
    const dir = makeFixture()
    try {
      const names = (await listDirectory(dir)).entries.map(entry => entry.name)
      expect(names).toContain('.DS_Store')
      expect(names).toContain('node_modules')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
