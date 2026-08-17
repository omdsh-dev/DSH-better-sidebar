import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { compareEntries, isWithin, parentOf, requireAbsolute, rootLabel } from '../src/fs-tree.ts'
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
