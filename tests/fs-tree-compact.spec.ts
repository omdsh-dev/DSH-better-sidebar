/**
 * fs-tree compact marking: a directory row whose contents are EXACTLY one
 * real directory child gets `compact` so the explorer can fold singleton
 * chains into one breadcrumb row. Mixed/empty/file-only levels and
 * symlink-only children stay unmarked (a self-referential link would
 * otherwise fold forever).
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectory } from '../src/fs-tree.ts'

/** Mirror of the symlink spec's capability probe (symlinks need privileges on Windows). */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-compact-probe-'))
  try {
    symlinkSync('target', join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** A scratch level covering every compact/not-compact shape. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-compact-'))
  // Singleton chain a/b/c ending in a real file.
  mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true })
  writeFileSync(join(dir, 'a', 'b', 'c', 'leaf.txt'), 'leaf')
  // Dir + file together: not a singleton.
  mkdirSync(join(dir, 'mixed', 'child'), { recursive: true })
  writeFileSync(join(dir, 'mixed', 'note.txt'), 'note')
  // Empty dir: not a singleton.
  mkdirSync(join(dir, 'empty'))
  // Lone FILE child: not a directory singleton.
  mkdirSync(join(dir, 'lone-file'))
  writeFileSync(join(dir, 'lone-file', 'only.txt'), 'only')
  return dir
}

describe('fs-tree compact marking', () => {
  it('marks every link of a singleton directory chain', async () => {
    const dir = makeFixture()
    try {
      const root = await listDirectory(dir)
      expect(root.entries.find(entry => entry.name === 'a')).toMatchObject({ isDir: true, compact: true })
      const levelA = await listDirectory(join(dir, 'a'))
      expect(levelA.entries.find(entry => entry.name === 'b')).toMatchObject({ isDir: true, compact: true })
      const levelB = await listDirectory(join(dir, 'a', 'b'))
      expect(levelB.entries.find(entry => entry.name === 'c')).toMatchObject({ isDir: true, compact: true })
      // The chain ends where the level stops being a dir singleton.
      const levelC = await listDirectory(join(dir, 'a', 'b', 'c'))
      expect(levelC.entries.find(entry => entry.name === 'leaf.txt')?.compact).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves mixed and empty levels unmarked; marks the terminal singleton', async () => {
    const dir = makeFixture()
    try {
      const root = await listDirectory(dir)
      for (const name of ['mixed', 'empty']) {
        expect(root.entries.find(entry => entry.name === name)?.compact, name).toBeUndefined()
      }
      // The terminal link (sole FILE child) is marked too: the client
      // preloads it so the fold label never shifts on expansion.
      expect(root.entries.find(entry => entry.name === 'lone-file')).toMatchObject({ isDir: true, compact: true })
      // File rows never carry the mark.
      const mixed = await listDirectory(join(dir, 'mixed'))
      expect(mixed.entries.find(entry => entry.name === 'note.txt')?.compact).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('never marks a dir whose only child is a symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-compact-link-'))
    try {
      mkdirSync(join(dir, 'wrapper'))
      mkdirSync(join(dir, 'target'))
      symlinkSync(join(dir, 'target'), join(dir, 'wrapper', 'link'))
      const listing = await listDirectory(join(dir, 'wrapper'))
      expect(listing.entries.find(entry => entry.name === 'link')).toMatchObject({ isDir: true, isSymlink: true })
      expect(listing.entries.find(entry => entry.name === 'link')?.compact).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores hidden (dot-prefixed) entries when counting children', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-compact-hidden-'))
    try {
      // Finder junk beside the sole dir child: still a fold singleton.
      mkdirSync(join(dir, 'chain', 'inner'), { recursive: true })
      writeFileSync(join(dir, 'chain', '.DS_Store'), 'junk')
      // Any hidden file beside the sole FILE child (terminal link): marked.
      mkdirSync(join(dir, 'terminal'))
      writeFileSync(join(dir, 'terminal', 'only.txt'), 'only')
      writeFileSync(join(dir, 'terminal', '.gitignore'), 'ignored')
      // Hidden DIR children never count either.
      mkdirSync(join(dir, 'hidden-dir', 'child'), { recursive: true })
      mkdirSync(join(dir, 'hidden-dir', '.cache'))
      // Hidden beside TWO real entries: not a singleton.
      mkdirSync(join(dir, 'crowded', 'child'), { recursive: true })
      writeFileSync(join(dir, 'crowded', 'note.txt'), 'note')
      writeFileSync(join(dir, 'crowded', '.DS_Store'), 'junk')
      // Hidden alone is NOT a singleton (zero effective children).
      mkdirSync(join(dir, 'hidden-only'))
      writeFileSync(join(dir, 'hidden-only', '.DS_Store'), 'junk')
      const listing = await listDirectory(dir)
      expect(listing.entries.find(entry => entry.name === 'chain')).toMatchObject({ isDir: true, compact: true })
      expect(listing.entries.find(entry => entry.name === 'terminal')).toMatchObject({ isDir: true, compact: true })
      expect(listing.entries.find(entry => entry.name === 'hidden-dir')).toMatchObject({ isDir: true, compact: true })
      expect(listing.entries.find(entry => entry.name === 'crowded')?.compact).toBeUndefined()
      expect(listing.entries.find(entry => entry.name === 'hidden-only')?.compact).toBeUndefined()
      // Hidden rows themselves still list (dimmed) and never carry the mark.
      const chain = await listDirectory(join(dir, 'chain'))
      expect(chain.entries.find(entry => entry.name === '.DS_Store')).toMatchObject({ isDir: false, hidden: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
