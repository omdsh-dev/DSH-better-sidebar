/**
 * Unit tests for the file-address grammar (src/client/resource-address.ts):
 * the plugin parses DSH's `dsh-resource://file/…` addresses itself (the
 * client bundle's purity gate forbids value-importing the upstream util), so
 * these tests pin the upstream shapes it must agree with — DSH 0.1.5-alpha.2
 * (`packages/util/workspace-path` in github.com/deepseek-ai/deepseek-harness).
 */
import { describe, expect, it } from 'vitest'
import {
  absoluteFileAddress,
  fileAddressFor,
  parseFileAddress,
  sessionFileAddress,
} from '../src/client/resource-address.ts'

describe('parseFileAddress', () => {
  it('reads a session-scoped address', () => {
    expect(parseFileAddress('dsh-resource://file/session/s1/src/a.ts')).toEqual({
      scope: 'session', sessionId: 's1', path: 'src/a.ts',
    })
  })

  it('reads a session-scoped address whose path is absolute inside the scope', () => {
    expect(parseFileAddress('dsh-resource://file/session/s1//outside/a.ts')).toEqual({
      scope: 'session', sessionId: 's1', path: '/outside/a.ts',
    })
  })

  it('reads an absolute address (POSIX, drive, UNC)', () => {
    expect(parseFileAddress('dsh-resource://file/absolute/home/me/notes.txt')).toEqual({
      scope: 'absolute', path: '/home/me/notes.txt',
    })
    expect(parseFileAddress('dsh-resource://file/absolute/C:/x/y.txt')).toEqual({
      scope: 'absolute', path: 'C:/x/y.txt',
    })
    expect(parseFileAddress('dsh-resource://file/absolute//server/share/x.txt')).toEqual({
      scope: 'absolute', path: '//server/share/x.txt',
    })
  })

  it('decodes per segment so #, ? and spaces survive', () => {
    expect(parseFileAddress('dsh-resource://file/session/s1/a%20b/c%23d.txt')).toEqual({
      scope: 'session', sessionId: 's1', path: 'a b/c#d.txt',
    })
  })

  it('strips a query or fragment suffix', () => {
    expect(parseFileAddress('dsh-resource://file/session/s1/src/a.ts? freshness=2')).toEqual({
      scope: 'session', sessionId: 's1', path: 'src/a.ts',
    })
    expect(parseFileAddress('dsh-resource://file/session/s1/src/a.ts#L12')).toEqual({
      scope: 'session', sessionId: 's1', path: 'src/a.ts',
    })
    // The first `?` or `#` ends the path; everything after is ignored.
    expect(parseFileAddress('dsh-resource://file/session/s1/src/a%3Fb.ts#c%3Fd')).toEqual({
      scope: 'session', sessionId: 's1', path: 'src/a?b.ts',
    })
  })

  it('refuses anything that is not a file address', () => {
    for (const address of [
      'sidebar://guide',
      'dsh-resource://attachment/session/s1/a.png',
      'dsh-resource://file/other/s1/a.ts',
      'dsh-resource://file/session/s1',
      // Empty session id (alpha.2: leading `/` is a path, not an empty id).
      'dsh-resource://file/session//a.ts',
      'dsh-resource://file/absolute/',
      'not a url',
      // Malformed percent escape: decodeURIComponent throws inside the try.
      'dsh-resource://file/session/s1/a%zz.ts',
    ]) {
      expect(parseFileAddress(address), address).toBeUndefined()
    }
  })
})

describe('address builders', () => {
  it('builds a session address and round-trips it', () => {
    const address = sessionFileAddress('s1', './src\\a b.ts')
    expect(address).toBe('dsh-resource://file/session/s1/src/a%20b.ts')
    expect(parseFileAddress(address)).toEqual({ scope: 'session', sessionId: 's1', path: 'src/a b.ts' })
  })

  it('keeps an absolute path absolute inside the session scope (round-trip)', () => {
    const address = sessionFileAddress('s1', '/outside/a.ts')
    expect(address).toBe('dsh-resource://file/session/s1//outside/a.ts')
    expect(parseFileAddress(address)).toEqual({ scope: 'session', sessionId: 's1', path: '/outside/a.ts' })
  })

  it('builds an absolute address and round-trips it', () => {
    for (const [path, address] of [
      ['/home/me/x.txt', 'dsh-resource://file/absolute/home/me/x.txt'],
      ['C:\\x\\y.txt', 'dsh-resource://file/absolute/C:/x/y.txt'],
      ['\\\\server\\share\\x.txt', 'dsh-resource://file/absolute//server/share/x.txt'],
    ] as const) {
      expect(absoluteFileAddress(path)).toBe(address)
      expect(parseFileAddress(address)?.path.replace(/\\/g, '/')).toBe(path.replace(/\\/g, '/'))
    }
  })

  it('keeps a drive colon literal', () => {
    expect(absoluteFileAddress('C:/x/y.txt')).toContain('C:')
    expect(absoluteFileAddress('C:/x/y.txt')).not.toContain('%3A')
  })
})

describe('fileAddressFor', () => {
  it('scopes a relative path to the session', () => {
    expect(fileAddressFor('s1', '/work', 'src/a.ts')).toBe('dsh-resource://file/session/s1/src/a.ts')
  })

  it('scopes an absolute path inside the workspace to the session', () => {
    expect(fileAddressFor('s1', '/work', '/work/src/a.ts')).toBe('dsh-resource://file/session/s1/src/a.ts')
  })

  it('scopes the workspace root itself to the session', () => {
    expect(fileAddressFor('s1', '/work', '/work')).toBe('dsh-resource://file/session/s1/')
  })

  it('keeps an absolute path outside the workspace session-scoped with its leading slash', () => {
    expect(fileAddressFor('s1', '/work', '/outside/a.ts')).toBe('dsh-resource://file/session/s1//outside/a.ts')
    expect(fileAddressFor('s1', undefined, '/outside/a.ts')).toBe('dsh-resource://file/session/s1//outside/a.ts')
  })
})
