import { describe, expect, it } from 'vitest'
import { isAbsolutePath, relativeTo } from '../src/client/paths.ts'
import { resolveSidebarPath } from '../src/client/produced-files.ts'
import { htmlUrl } from '../src/client/api.ts'

describe('path helpers', () => {
  it('derives relative paths under the cwd (and "." for the cwd itself)', () => {
    expect(relativeTo('/Users/me/code', '/Users/me/code/src/main.ts')).toBe('src/main.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/code')).toBe('.')
    expect(relativeTo('/Users/me/code/', '/Users/me/code/src/a/b.ts')).toBe('src/a/b.ts')
  })

  it('falls back to the path unchanged when it lies outside the cwd', () => {
    expect(relativeTo('/Users/me/code', '/Users/other/x.ts')).toBe('/Users/other/x.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/codex/y.ts')).toBe('/Users/me/codex/y.ts')
  })

  it('handles windows roots and mixed separators', () => {
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\me\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me\\', 'C:\\Users\\me')).toBe('.')
  })

  it('containment is case-insensitive (windows/macOS case-insensitive volumes)', () => {
    expect(relativeTo('C:\\Users\\Me', 'c:/users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/Users/Me/code', '/users/me/code/src/main.ts')).toBe('src/main.ts')
    // The returned relative text keeps the caller's own casing.
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\Me\\SRC\\a.ts')).toBe('SRC/a.ts')
  })

  it('resolves produced paths against windows cwds', () => {
    expect(resolveSidebarPath('C:\\work\\proj', 'src/a.ts')).toBe('C:\\work\\proj\\src/a.ts')
    expect(resolveSidebarPath('C:\\work\\proj', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
    expect(resolveSidebarPath('C:\\work\\proj\\', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
  })

  it('keeps UNC produced paths absolute instead of joining them onto the cwd', () => {
    // Pure client function: UNC detection is platform-independent, so these
    // assertions run on every host without a platform guard.
    expect(resolveSidebarPath('C:\\work\\proj', '\\\\server\\share\\abs\\x.ts'))
      .toBe('\\\\server\\share\\abs\\x.ts')
    expect(resolveSidebarPath('C:\\work\\proj', '//server/share/abs/x.ts'))
      .toBe('//server/share/abs/x.ts')
    // A relative path under a UNC cwd joins with backslashes.
    expect(resolveSidebarPath('\\\\server\\share\\proj', 'src/a.ts'))
      .toBe('\\\\server\\share\\proj\\src/a.ts')
  })

  it('mirrors the host absolute-path notion without node:path', () => {
    expect(isAbsolutePath('/abs/x.ts')).toBe(true)
    expect(isAbsolutePath('C:\\abs\\x.ts')).toBe(true)
    expect(isAbsolutePath('C:/abs/x.ts')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\x.ts')).toBe(true)
    expect(isAbsolutePath('//server/share/x.ts')).toBe(true)
    expect(isAbsolutePath('C:relative.ts')).toBe(false)
    expect(isAbsolutePath('rel/x.ts')).toBe(false)
  })

  it('htmlUrl always marks UNC paths (platform-neutral marker)', () => {
    // The marker is platform-neutral now: the host resolves the decoded
    // '//server/share/...' form per-platform, so no cwd/OS signal is needed.
    expect(htmlUrl({ sessionId: 's' }, '\\\\server\\share\\proj\\a.html'))
      .toBe('/sidebar/html/s//server/share/proj/a.html')
    expect(htmlUrl({ sessionId: 's', cwd: '/home/me' }, '//server/share/a.html'))
      .toBe('/sidebar/html/s//server/share/a.html')
    expect(htmlUrl({ sessionId: 's', cwd: '/home/me' }, '/home/me/index.html'))
      .toBe('/sidebar/html/s/home/me/index.html')
  })
})
