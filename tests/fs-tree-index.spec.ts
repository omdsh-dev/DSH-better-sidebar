/**
 * The bounded workspace index scan: walks the tree level by level, skips
 * heavyweight directories (node_modules etc.), stops at the entry-count and
 * depth caps, never descends into symlinked directories, and reports whether
 * a bound cut the scan short.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexDirectory, INDEX_SKIP_DIRS } from '../src/fs-tree.ts'

/** Build one scratch tree; returns the root and a cleanup. */
function fixture(layout: Record<string, string | null>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-index-'))
  for (const [rel, content] of Object.entries(layout)) {
    const target = join(root, rel)
    if (content === null) {
      mkdirSync(target, { recursive: true })
    } else {
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content)
    }
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('indexDirectory', () => {
  it('collects every entry of a small tree (files and directories)', async () => {
    const { root, cleanup } = fixture({
      'a.ts': '1',
      'src/b.ts': '2',
      'src/deep/c.ts': '3',
      'lib/': null,
      'README.md': 'x',
    })
    try {
      const { paths, truncated } = await indexDirectory(root, { maxEntries: 1000, maxDepth: 12 })
      expect(truncated).toBe(false)
      expect(paths).toContain(join(root, 'a.ts'))
      expect(paths).toContain(join(root, 'src'))
      expect(paths).toContain(join(root, 'src', 'b.ts'))
      expect(paths).toContain(join(root, 'src', 'deep'))
      expect(paths).toContain(join(root, 'src', 'deep', 'c.ts'))
      expect(paths).toContain(join(root, 'lib'))
      expect(paths).toContain(join(root, 'README.md'))
      // a.ts + src + src/b.ts + src/deep + src/deep/c.ts + lib + README.md
      expect(paths).toHaveLength(7)
    } finally {
      cleanup()
    }
  })

  it('skips heavyweight directories entirely', async () => {
    const { root, cleanup } = fixture({
      'node_modules/pkg/index.js': 'x',
      'dist/bundle.js': 'x',
      'src/a.ts': 'x',
      '.git/config': 'x',
    })
    try {
      const { paths, truncated } = await indexDirectory(root, { maxEntries: 1000, maxDepth: 12 })
      expect(truncated).toBe(false)
      expect(paths.some(p => p.includes('node_modules'))).toBe(false)
      expect(paths.some(p => p.includes(join('dist')))).toBe(false)
      expect(paths.some(p => p.includes('.git'))).toBe(false)
      expect(paths.some(p => p.endsWith('a.ts'))).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('stops at the entry-count cap and reports truncated', async () => {
    const { root, cleanup } = fixture({
      'a1.ts': 'x', 'a2.ts': 'x', 'a3.ts': 'x', 'a4.ts': 'x', 'a5.ts': 'x',
      'b1.ts': 'x', 'b2.ts': 'x', 'b3.ts': 'x', 'b4.ts': 'x', 'b5.ts': 'x',
    })
    try {
      const { paths, truncated } = await indexDirectory(root, { maxEntries: 4, maxDepth: 12 })
      expect(truncated).toBe(true)
      expect(paths.length).toBeLessThanOrEqual(4)
    } finally {
      cleanup()
    }
  })

  it('stops at the depth cap and reports truncated', async () => {
    const { root, cleanup } = fixture({
      'l1/l2/l3/l4/l5/deep.ts': 'x',
    })
    try {
      const { paths, truncated } = await indexDirectory(root, { maxEntries: 1000, maxDepth: 2 })
      expect(truncated).toBe(true)
      expect(paths.some(p => p.endsWith('deep.ts'))).toBe(false)
      expect(paths.some(p => p.endsWith('l2'))).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('records a symlinked directory but never descends into it (cycle safety)', async () => {
    const { root, cleanup } = fixture({ 'real/inner.ts': 'x' })
    try {
      const link = join(root, 'loop')
      try {
        symlinkSync(root, link)  // self-referential
      } catch {
        return  // symlink unsupported on this platform — skip
      }
      const { paths, truncated } = await indexDirectory(root, { maxEntries: 1000, maxDepth: 12 })
      expect(truncated).toBe(false)
      expect(paths).toContain(link)
      expect(paths.filter(p => p.startsWith(link))).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('tolerates an unreadable root (best-effort empty index)', async () => {
    const { paths, truncated } = await indexDirectory(join(tmpdir(), 'dsh-sidebar-index-missing-' + Date.now()), { maxEntries: 1000, maxDepth: 12 })
    expect(truncated).toBe(false)
    expect(paths).toEqual([])
  })

  it('exposes the skip list for tests/docs', () => {
    expect(INDEX_SKIP_DIRS.has('node_modules')).toBe(true)
    expect(INDEX_SKIP_DIRS.has('.git')).toBe(true)
  })
})
