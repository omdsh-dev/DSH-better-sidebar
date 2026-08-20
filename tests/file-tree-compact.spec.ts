/**
 * Explorer breadcrumb folding logic: the fold chain walks successive sole
 * directory children while each link's level is loaded and healthy, and the
 * load-target scan finds the collapsed singleton dirs whose levels must load
 * ahead of expansion so chains can extend.
 */
import { describe, expect, it } from 'vitest'
import type { FsEntry } from '../src/client/api.ts'
import { MAX_COMPACT_DEPTH, compactChain, compactLoadTargets, type CompactLevel } from '../src/client/file-tree-compact.ts'

/** A directory row; `compact` marks a singleton-dir level (host flag).
 *  `hidden` mirrors the host: dot-prefixed names are hidden rows. */
function dir(path: string, compact = false): FsEntry {
  const name = path.split('/').pop()!
  return {
    name,
    path,
    isDir: true,
    hidden: name.startsWith('.'),
    isSymlink: false,
    broken: false,
    ...(compact ? { compact: true } : {}),
  }
}

/** A file row. */
function file(path: string): FsEntry {
  const name = path.split('/').pop()!
  return { name, path, isDir: false, hidden: name.startsWith('.'), isSymlink: false, broken: false }
}

describe('compactChain', () => {
  it('walks a loaded singleton chain to its end', () => {
    // The terminal link carries the host mark too (sole FILE child), but the
    // chain only extends through directory links.
    const levels: Record<string, CompactLevel> = {
      '/a': { entries: [dir('/a/b', true)] },
      '/a/b': { entries: [dir('/a/b/c', true)] },
      '/a/b/c': { entries: [file('/a/b/c/leaf.txt')] },
    }
    const chain = compactChain(dir('/a', true), path => levels[path])
    expect(chain.map(entry => entry.path)).toEqual(['/a', '/a/b', '/a/b/c'])
  })

  it('pauses at an unloaded link (the caller keeps loading)', () => {
    const levels: Record<string, CompactLevel> = {
      '/a': { entries: [dir('/a/b', true)] },
    }
    const chain = compactChain(dir('/a', true), path => levels[path])
    expect(chain.map(entry => entry.path)).toEqual(['/a', '/a/b'])
  })

  it('pauses at a failed level', () => {
    const levels: Record<string, CompactLevel> = {
      '/a': { entries: [dir('/a/b', true)] },
      '/a/b': { error: 'cannot list' },
    }
    const chain = compactChain(dir('/a', true), path => levels[path])
    expect(chain.map(entry => entry.path)).toEqual(['/a', '/a/b'])
  })

  it('ignores hidden entries (macOS .DS_Store & co.) beside the sole child', () => {
    // The host marked `compact` with the same filter: hidden rows beside the
    // sole directory child must not snap the chain open on the client either.
    const levels: Record<string, CompactLevel> = {
      '/a': { entries: [file('/a/.DS_Store'), dir('/a/b', true)] },
      '/a/b': { entries: [dir('/a/b/c'), file('/a/b/.DS_Store'), file('/a/b/.gitignore')] },
      '/a/b/c': { entries: [file('/a/b/c/leaf.txt')] },
    }
    const chain = compactChain(dir('/a', true), path => levels[path])
    expect(chain.map(entry => entry.path)).toEqual(['/a', '/a/b', '/a/b/c'])
  })

  it('does not extend through a hidden sole child', () => {
    // A dir whose only non-hidden view is a hidden dir is never compact on
    // the host; a stale mark must stop at the hidden child anyway.
    const levels: Record<string, CompactLevel> = {
      '/a': { entries: [dir('/a/.git', true)] },
    }
    expect(compactChain(dir('/a', true), path => levels[path]).map(entry => entry.path)).toEqual(['/a'])
  })

  it('stops when a stale compact flag meets a multi-entry level', () => {
    const levels: Record<string, CompactLevel> = {
      '/a': { entries: [dir('/a/b'), file('/a/late.txt')] },
    }
    const chain = compactChain(dir('/a', true), path => levels[path])
    expect(chain.map(entry => entry.path)).toEqual(['/a'])
  })

  it('refuses broken or file-shaped sole children', () => {
    const broken: Record<string, CompactLevel> = { '/a': { entries: [{ ...dir('/a/b'), broken: true }] } }
    expect(compactChain(dir('/a', true), path => broken[path])).toHaveLength(1)
    const fileOnly: Record<string, CompactLevel> = { '/a': { entries: [file('/a/b.txt')] } }
    expect(compactChain(dir('/a', true), path => fileOnly[path])).toHaveLength(1)
  })

  it('never revisits a path (stale-cache cycle guard)', () => {
    const levels: Record<string, CompactLevel> = {
      '/a': { entries: [dir('/a', true)] },
    }
    const chain = compactChain(dir('/a', true), path => levels[path])
    expect(chain.map(entry => entry.path)).toEqual(['/a'])
  })

  it('bounds one chain at the depth cap', () => {
    // A synthetic chain longer than the cap: every link loaded and compact.
    const levels: Record<string, CompactLevel> = {}
    for (let index = 0; index < MAX_COMPACT_DEPTH + 8; index += 1) {
      levels[`/${'x'.repeat(index + 1)}`] = { entries: [dir(`/${'x'.repeat(index + 2)}`, true)] }
    }
    const chain = compactChain(dir('/x', true), path => levels[path])
    expect(chain).toHaveLength(MAX_COMPACT_DEPTH)
  })

  it('returns a non-compact entry unchanged', () => {
    const chain = compactChain(dir('/a'), () => ({ entries: [dir('/a/b', true)] }))
    expect(chain.map(entry => entry.path)).toEqual(['/a'])
  })
})

describe('compactLoadTargets', () => {
  it('collects unloaded compact dir entries across loaded levels', () => {
    const levels: Record<string, CompactLevel> = {
      '/root': { entries: [dir('/root/a', true), file('/root/readme.md'), dir('/root/normal')] },
      '/root/a': { entries: [dir('/root/a/b', true), dir('/root/a/c', true)] },
      // Already in flight (FileTree stores {} while loading): not collected again.
      '/root/a/b': {},
    }
    // Only marked, not-yet-loaded dirs qualify: files and plain dirs never do.
    expect(compactLoadTargets(levels)).toEqual(['/root/a/c'])
  })

  it('skips already-loaded paths and dedupes repeat appearances', () => {
    const row = dir('/root/a', true)
    const levels: Record<string, CompactLevel> = {
      '/root': { entries: [row] },
      '/alt': { entries: [row] },
      '/root/a': { entries: [] },
    }
    expect(compactLoadTargets(levels)).toEqual([])
  })
})
