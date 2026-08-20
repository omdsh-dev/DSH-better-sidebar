/**
 * Unit tests for the explorer file operations (src/fs-ops.ts): directory
 * creation, rename validation/conflicts, trash-first removal (with the
 * DSH_SIDEBAR_TRASH_DIR override) and the permanent-delete fallback, and
 * the recursive name/content search with its caps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidebarError } from '../src/wire.ts'
import {
  createDirectory,
  removeEntry,
  renameEntry,
  searchDirectory,
  trashDirectory,
  validateEntryName,
} from '../src/fs-ops.ts'

/** Fail the NEXT fs rename with EXDEV (trash on another volume). */
const renameGate = vi.hoisted(() => ({ exdevOnce: false }))

// node:fs/promises is an external ESM namespace — it cannot be spied on
// in place, so the EXDEV fallback test mocks the module and delegates every
// call to the real implementation except the gated rename.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => {
      if (renameGate.exdevOnce) {
        renameGate.exdevOnce = false
        return Promise.reject(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }))
      }
      return actual.rename(...args)
    }),
  }
})

/** A scratch workspace + trash dir per test, cleaned up afterwards. */
let work: string
let trash: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dsh-fsops-'))
  trash = mkdtempSync(join(tmpdir(), 'dsh-fsops-trash-'))
  process.env.DSH_SIDEBAR_TRASH_DIR = trash
})

afterEach(() => {
  delete process.env.DSH_SIDEBAR_TRASH_DIR
  rmSync(work, { recursive: true, force: true })
  rmSync(trash, { recursive: true, force: true })
})

describe('trashDirectory', () => {
  it('honors the DSH_SIDEBAR_TRASH_DIR override', () => {
    expect(trashDirectory()).toBe(trash)
  })
})

describe('validateEntryName', () => {
  it('accepts plain names and trims whitespace', () => {
    expect(validateEntryName('  notes.md ')).toBe('notes.md')
    expect(validateEntryName('my dir')).toBe('my dir')
  })

  it('rejects empty, separator, and dot names', () => {
    for (const bad of ['', '  ', 'a/b', 'a\\b', '.', '..']) {
      expect(() => validateEntryName(bad)).toThrow(SidebarError)
    }
  })
})

describe('createDirectory', () => {
  it('creates the directory', async () => {
    const target = join(work, 'new-dir')
    await expect(createDirectory(target)).resolves.toEqual({ path: target })
    expect(existsSync(target)).toBe(true)
  })

  it('reports an existing directory as a conflict', async () => {
    mkdirSync(join(work, 'taken'))
    await expect(createDirectory(join(work, 'taken'))).rejects.toThrow(/目录已存在/)
  })
})

describe('renameEntry', () => {
  it('renames a file and returns the destination', async () => {
    const source = join(work, 'old.txt')
    writeFileSync(source, 'x')
    const result = await renameEntry(source, 'new.txt')
    expect(result.dest).toBe(join(work, 'new.txt'))
    expect(existsSync(result.dest)).toBe(true)
    expect(existsSync(source)).toBe(false)
  })

  it('renames a directory', async () => {
    const source = join(work, 'old-dir')
    mkdirSync(source)
    writeFileSync(join(source, 'inner.txt'), 'y')
    const { dest } = await renameEntry(source, 'new-dir')
    expect(existsSync(join(dest, 'inner.txt'))).toBe(true)
  })

  it('rejects invalid names before touching the filesystem', async () => {
    const source = join(work, 'a.txt')
    writeFileSync(source, 'x')
    await expect(renameEntry(source, 'bad/name')).rejects.toThrow(SidebarError)
    expect(existsSync(source)).toBe(true)
  })

  it('reports a missing source', async () => {
    await expect(renameEntry(join(work, 'ghost'), 'x.txt')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('reports a name collision', async () => {
    const source = join(work, 'a.txt')
    writeFileSync(source, 'x')
    writeFileSync(join(work, 'b.txt'), 'y')
    await expect(renameEntry(source, 'b.txt')).rejects.toThrow(/同名/)
  })
})

describe('removeEntry', () => {
  it('moves a file into the configured trash', async () => {
    const target = join(work, 'bye.txt')
    writeFileSync(target, 'data')
    const result = await removeEntry(target)
    expect(result).toMatchObject({ path: target, trashed: true })
    expect(existsSync(target)).toBe(false)
    expect(existsSync(join(trash, 'bye.txt'))).toBe(true)
    expect(readFileSync(join(trash, 'bye.txt'), 'utf8')).toBe('data')
  })

  it('moves a directory tree into the trash', async () => {
    const target = join(work, 'dir')
    mkdirSync(target)
    writeFileSync(join(target, 'inner.txt'), 'i')
    const result = await removeEntry(target)
    expect(result.trashed).toBe(true)
    expect(existsSync(join(trash, 'dir', 'inner.txt'))).toBe(true)
  })

  it('suffixes colliding trash names (name 2)', async () => {
    const target = join(work, 'dup.txt')
    writeFileSync(target, 'new')
    writeFileSync(join(trash, 'dup.txt'), 'old')
    const result = await removeEntry(target)
    expect(result.trashed).toBe(true)
    expect(existsSync(join(trash, 'dup.txt'))).toBe(true)
    expect(readFileSync(join(trash, 'dup 2.txt'), 'utf8')).toBe('new')
  })

  it('falls back to permanent deletion on a cross-device trash move', async () => {
    const target = join(work, 'cross.txt')
    writeFileSync(target, 'data')
    renameGate.exdevOnce = true
    const result = await removeEntry(target)
    expect(result).toMatchObject({ path: target, trashed: false })
    expect(existsSync(target)).toBe(false)
    expect(existsSync(join(trash, 'cross.txt'))).toBe(false)
  })

  it('reports a missing target as not-found', async () => {
    await expect(removeEntry(join(work, 'ghost'))).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('searchDirectory', () => {
  it('returns nothing for an empty query without walking', async () => {
    const outcome = await searchDirectory(work, '   ')
    expect(outcome).toEqual({ path: work, query: '', results: [], truncated: false })
  })

  it('matches file names case-insensitively', async () => {
    writeFileSync(join(work, 'Alpha.js'), 'x')
    mkdirSync(join(work, 'beta'))
    const outcome = await searchDirectory(work, 'ALPHA')
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]).toMatchObject({ name: 'Alpha.js', type: 'file', matchLine: null })
  })

  it('matches file contents and returns the matching line', async () => {
    writeFileSync(join(work, 'a.txt'), 'line one\nneedle here\nline three')
    const outcome = await searchDirectory(work, 'needle')
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]).toMatchObject({ name: 'a.txt', type: 'file', matchLine: 'needle here' })
  })

  it('recurses into subdirectories and reports relative paths', async () => {
    mkdirSync(join(work, 'src', 'nested'), { recursive: true })
    writeFileSync(join(work, 'src', 'nested', 'deep.txt'), 'unique-token')
    const outcome = await searchDirectory(work, 'unique-token')
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]?.rel).toBe('src/nested/deep.txt')
  })

  it('skips binary files for content matching', async () => {
    writeFileSync(join(work, 'bin.dat'), Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]))
    const outcome = await searchDirectory(work, 'needle')
    expect(outcome.results).toHaveLength(0)
  })

  it('does not follow directory symlinks (no cycles)', async () => {
    mkdirSync(join(work, 'real'))
    writeFileSync(join(work, 'real', 'token.txt'), 'loop-token')
    // Symlink may fail on some platforms; skip then.
    try {
      symlinkSync(work, join(work, 'loop'), 'dir')
    } catch {
      return
    }
    const outcome = await searchDirectory(work, 'loop-token')
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0]?.path).toBe(join(work, 'real', 'token.txt'))
  })
})
