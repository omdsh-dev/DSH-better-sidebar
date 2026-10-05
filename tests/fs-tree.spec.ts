import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { compareEntries, isWithin, invalidateDirectoryCache, listDirectory, parentOf, requireAbsolute, rootLabel } from '../src/fs-tree.ts'
import { isWin32 } from './platform.ts'

describe('fs-tree', () => {
  it('sorts directories first, then names case-insensitively', () => {
    const rows = [
      { name: 'b.txt', path: '/x/b.txt', isDir: false, hidden: false, isSymlink: false, broken: false },
      { name: 'A', path: '/x/A', isDir: true, hidden: false, isSymlink: false, broken: false },
      { name: 'a.txt', path: '/x/a.txt', isDir: false, hidden: false, isSymlink: false, broken: false },
      { name: '.hidden', path: '/x/.hidden', isDir: false, hidden: true, isSymlink: false, broken: false },
    ]
    expect(rows.sort(compareEntries).map(row => row.name)).toEqual(['A', '.hidden', 'a.txt', 'b.txt'])
  })

  it('derives root labels and parents (POSIX-style)', () => {
    // POSIX-style inputs behave identically on both platforms (win32 parses '/'
    // as a separator), so these assertions are platform-independent.
    expect(rootLabel('/Users/me/code')).toBe('code')
    expect(rootLabel('/')).toBe('/')
    expect(parentOf('/Users/me/code')).toBe('/Users/me')
    expect(parentOf('/')).toBeUndefined()
  })

  it.skipIf(!isWin32)('derives root labels and parents for Windows drives', () => {
    expect(rootLabel('C:\\')).toBe('C:\\')
    expect(parentOf('C:\\')).toBeUndefined()
    expect(rootLabel('C:\\Users\\me')).toBe('me')
    expect(parentOf('C:\\Users\\me')).toBe('C:\\Users')
  })

  it('accepts POSIX absolute paths and rejects relative ones', () => {
    // resolve() is platform-native: '/a/b' roots to the current drive on win32.
    expect(requireAbsolute('/a/b')).toBe(resolve('/a/b'))
    expect(() => requireAbsolute('a/b')).toThrow(/not an absolute path/)
    expect(() => requireAbsolute('../a')).toThrow(/not an absolute path/)
  })

  // Windows-only path semantics — skipped (not silently passing) on POSIX:
  // drive letters and UNC shares are absolute on win32, drive-relative 'C:foo'
  // is not.
  describe.skipIf(!isWin32)('win32 path semantics', () => {
    it('accepts drive letters and normalizes their separators', () => {
      expect(requireAbsolute('C:/proj')).toBe('C:\\proj')
      expect(requireAbsolute('C:\\proj')).toBe('C:\\proj')
      // A drive path resolves against its own drive, never a bare root.
      expect(resolve('/a/b')).toMatch(/^[A-Za-z]:/)
    })

    it('accepts UNC network shares in both separator styles', () => {
      expect(requireAbsolute('\\\\server\\share\\proj')).toBe('\\\\server\\share\\proj')
      expect(requireAbsolute('//server/share/proj')).toBe('\\\\server\\share\\proj')
    })

    it('rejects drive-relative paths', () => {
      expect(() => requireAbsolute('C:proj')).toThrow(/not an absolute path/)
    })
  })

  // POSIX-only path semantics — the reverse branch of the win32 suite: forms
  // the host can never access must be refused loudly instead of mangled.
  describe.skipIf(isWin32)('POSIX path semantics', () => {
    it('rejects Windows drive paths', () => {
      expect(() => requireAbsolute('C:/proj')).toThrow(/not an absolute path/)
      expect(() => requireAbsolute('C:\\proj')).toThrow(/not an absolute path/)
    })

    it('rejects backslash UNC paths (not absolute on POSIX)', () => {
      expect(() => requireAbsolute('\\\\server\\share\\proj')).toThrow(/not an absolute path/)
    })
  })

  it('isWithin tolerates separators and (on win32) letter case', () => {
    expect(isWithin('/work/proj', '/work/proj/src/a.ts')).toBe(true)
    expect(isWithin('/work/proj', '/work/proj')).toBe(true)
    expect(isWithin('/work/proj', '/work/proj2/a.ts')).toBe(false)
    expect(isWithin('/work/proj', '/other/a.ts')).toBe(false)
    // Mixed separators normalize on every platform.
    expect(isWithin('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe(true)
    // Case sensitivity follows the platform's filesystem semantics (the
    // platform parameter makes both branches assertable on any host).
    expect(isWithin('C:\\Users\\Me', 'c:/users/me/file.png', 'win32')).toBe(true)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'win32')).toBe(true)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'linux')).toBe(false)
    expect(isWithin('/Users/Me', '/users/me/file.png', 'darwin')).toBe(false)
    // Windows drive-root containment.
    expect(isWithin('C:\\', 'C:\\Users\\me\\a.png', 'win32')).toBe(true)
    expect(isWithin('c:\\users', 'C:/USERS/me/b.png', 'win32')).toBe(true)
    // UNC network-share containment: the '//' share prefix must not defeat
    // the prefix test, and a sibling share must stay outside. The platform
    // parameter is injected, so these win32-semantics assertions run on
    // every host without any platform guard.
    expect(isWithin('\\\\server\\share\\proj', '\\\\server\\share\\proj\\src\\a.ts', 'win32')).toBe(true)
    expect(isWithin('\\\\server\\share\\proj', '\\\\server\\share\\proj2\\a.ts', 'win32')).toBe(false)
    expect(isWithin('\\\\server\\share\\proj', '\\\\other\\share\\a.ts', 'win32')).toBe(false)
  })
})

describe('listDirectory (capped rows + cache)', () => {
  const roots: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-list-'))
    roots.push(dir)
    return dir
  }
  afterEach(() => {
    invalidateDirectoryCache()
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('caps the rows and flags truncated', async () => {
    const dir = tempDir()
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(join(dir, `file-${String(index).padStart(2, '0')}.txt`), 'x')
    }
    mkdirSync(join(dir, 'zz-dir'))
    const listing = await listDirectory(dir, 10)
    expect(listing.path).toBe(dir)
    // The cap is the row budget of one level; `truncated` is true whenever the
    // level held MORE rows than the budget (regardless of which ones survived).
    expect(listing.entries).toHaveLength(10)
    expect(listing.truncated).toBe(true)
    for (const entry of listing.entries) {
      expect(entry.path).toBe(`${dir}${sep}${entry.name}`)
      expect(entry.hidden).toBe(entry.name.startsWith('.'))
    }
  })

  it('sorts directories first within the returned rows', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'Dir-A'))
    mkdirSync(join(dir, 'dir-b'))
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'B.txt'), 'b')
    const listing = await listDirectory(dir, 10)
    // Directories first, then case-insensitive names (the comparator's contract
    // applied to real rows).
    expect(listing.entries.map(entry => entry.name)).toEqual(['Dir-A', 'dir-b', 'a.txt', 'B.txt'])
    expect(listing.truncated).toBe(false)
  })

  it('does not flag truncated when the level fits', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'a')
    const listing = await listDirectory(dir, 10)
    expect(listing.entries.map(entry => entry.name)).toEqual(['a.txt'])
    expect(listing.truncated).toBe(false)
  })

  it('composes row paths with the platform separator', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'a')
    const listing = await listDirectory(dir, 10)
    expect(listing.entries[0]!.path).toBe(`${dir}${sep}a.txt`)
  })

  it('serves a repeat listing from the TTL cache and re-reads after invalidation', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'a')
    const first = await listDirectory(dir, 10)
    // A file created behind the plugin's back is invisible until the cache
    // expires or an invalidation arrives (the writers call it explicitly).
    writeFileSync(join(dir, 'b.txt'), 'b')
    const cached = await listDirectory(dir, 10)
    expect(cached).toBe(first)
    expect(cached.entries.map(entry => entry.name)).toEqual(['a.txt'])
    invalidateDirectoryCache(dir)
    const fresh = await listDirectory(dir, 10)
    expect(fresh).not.toBe(first)
    expect(fresh.entries.map(entry => entry.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('keys the cache by cap as well as by directory', async () => {
    const dir = tempDir()
    for (let index = 0; index < 5; index += 1) writeFileSync(join(dir, `f${index}.txt`), 'x')
    const capped = await listDirectory(dir, 2)
    const full = await listDirectory(dir, 10)
    expect(capped.entries).toHaveLength(2)
    expect(full.entries).toHaveLength(5)
  })

  it('invalidateDirectoryCache() with no argument clears every level', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'a')
    const first = await listDirectory(dir, 10)
    invalidateDirectoryCache()
    const second = await listDirectory(dir, 10)
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  })

  it('throws fs-error for a missing directory', async () => {
    const dir = tempDir()
    await expect(listDirectory(join(dir, 'nope'), 10)).rejects.toMatchObject({ code: 'fs-error' })
  })
})
