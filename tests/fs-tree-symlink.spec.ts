/**
 * fs-tree symlink listing: the explorer must show a symlink as what it
 * points at (a symlink to a directory expands like a directory) and flag
 * links whose target is missing. The host listing keeps the probe cheap:
 * only entries that are actually symlinks are stat'ed.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectory } from '../src/fs-tree.ts'

/**
 * Symlink creation needs extra privileges on Windows; skip the suite there
 * rather than fail (mirror of the smoke spec's platform-tolerant fixtures).
 */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-symlink-probe-'))
  try {
    symlinkSync('target', join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** A scratch level with real entries plus three symlinks (dir/file/dangling). */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-symlink-'))
  mkdirSync(join(dir, 'real-dir'))
  writeFileSync(join(dir, 'real-file.txt'), 'content')
  symlinkSync(join(dir, 'real-dir'), join(dir, 'link-to-dir'))
  symlinkSync(join(dir, 'real-file.txt'), join(dir, 'link-to-file'))
  symlinkSync(join(dir, 'missing-target'), join(dir, 'broken-link'))
  return dir
}

describe.skipIf(!canSymlink)('fs-tree symlink listing', () => {
  it('reports a symlink to a directory as an expandable directory', async () => {
    const dir = makeFixture()
    try {
      const listing = await listDirectory(dir)
      const row = listing.entries.find(entry => entry.name === 'link-to-dir')
      expect(row).toMatchObject({ isDir: true, isSymlink: true, broken: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a symlink to a file as a file with a link badge', async () => {
    const dir = makeFixture()
    try {
      const listing = await listDirectory(dir)
      const row = listing.entries.find(entry => entry.name === 'link-to-file')
      expect(row).toMatchObject({ isDir: false, isSymlink: true, broken: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a dangling symlink as broken', async () => {
    const dir = makeFixture()
    try {
      const listing = await listDirectory(dir)
      const row = listing.entries.find(entry => entry.name === 'broken-link')
      expect(row).toMatchObject({ isDir: false, isSymlink: true, broken: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves regular entries unmarked and sorts symlinked dirs with the directories', async () => {
    const dir = makeFixture()
    try {
      const listing = await listDirectory(dir)
      const realDir = listing.entries.find(entry => entry.name === 'real-dir')
      const realFile = listing.entries.find(entry => entry.name === 'real-file.txt')
      expect(realDir).toMatchObject({ isDir: true, isSymlink: false, broken: false })
      expect(realFile).toMatchObject({ isDir: false, isSymlink: false, broken: false })
      // Directory-first ordering counts a symlinked directory as a directory.
      const dirs = listing.entries.filter(entry => entry.isDir).map(entry => entry.name)
      expect(dirs).toEqual(['link-to-dir', 'real-dir'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies every row correctly across a symlink-heavy level (bounded probe)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-symlink-many-'))
    mkdirSync(join(dir, 'real-dir'))
    writeFileSync(join(dir, 'real-file.txt'), 'content')
    try {
      // More links than the probe concurrency cap exercises the worker pool;
      // every directory link must still classify as a directory and every
      // file link as a file (order is already checked by the sort assertion).
      for (let index = 0; index < 48; index += 1) {
        symlinkSync(join(dir, 'real-dir'), join(dir, `dir-link-${index}`))
        symlinkSync(join(dir, 'real-file.txt'), join(dir, `file-link-${index}`))
      }
      const listing = await listDirectory(dir)
      for (let index = 0; index < 48; index += 1) {
        expect(listing.entries.find(entry => entry.name === `dir-link-${index}`))
          .toMatchObject({ isDir: true, isSymlink: true, broken: false })
        expect(listing.entries.find(entry => entry.name === `file-link-${index}`))
          .toMatchObject({ isDir: false, isSymlink: true, broken: false })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
