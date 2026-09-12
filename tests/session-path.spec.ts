import { describe, expect, it } from 'vitest'
import { resolveSessionPath } from '../src/session-path.ts'

const WSL_CWD = '\\\\wsl.localhost\\archlinux\\home\\zdaar\\project'
const WINDOWS_CWD = 'C:\\Users\\zdaar\\project'

describe('resolveSessionPath', () => {
  it('maps a Linux absolute path into the WSL distro root on win32', () => {
    expect(resolveSessionPath(WSL_CWD, '/home/zdaar/project/src/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\home\\zdaar\\project\\src\\a.ts')
  })

  it('maps a path outside the workspace into the same distro before containment checks', () => {
    expect(resolveSessionPath(WSL_CWD, '/tmp/dsh-issue.md', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\tmp\\dsh-issue.md')
  })

  it('normalizes Linux dot segments without escaping the distro share root', () => {
    expect(resolveSessionPath(WSL_CWD, '/home/zdaar/project/../other/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\home\\zdaar\\other\\a.ts')
    expect(resolveSessionPath(WSL_CWD, '/../etc/hosts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\etc\\hosts')
  })

  it('preserves Windows drive paths in a WSL session', () => {
    const target = 'C:\\Users\\zdaar\\file.md'
    expect(resolveSessionPath(WSL_CWD, target, 'win32')).toBe(target)
  })

  it('preserves UNC paths in a WSL session', () => {
    const backslash = '\\\\server\\share\\file.md'
    const forwardSlash = '//server/share/file.md'
    expect(resolveSessionPath(WSL_CWD, backslash, 'win32')).toBe(backslash)
    expect(resolveSessionPath(WSL_CWD, forwardSlash, 'win32')).toBe(forwardSlash)
  })

  it('maps Git Bash / MSYS drive paths for ordinary Windows sessions', () => {
    expect(resolveSessionPath(WINDOWS_CWD, '/e/project/foo.py', 'win32'))
      .toBe('E:\\project\\foo.py')
    expect(resolveSessionPath(WINDOWS_CWD, '/c/Users/zdaar/file.md', 'win32'))
      .toBe('C:\\Users\\zdaar\\file.md')
    expect(resolveSessionPath(WINDOWS_CWD, '/E/', 'win32')).toBe('E:\\')
  })

  it('keeps WSL path semantics ahead of MSYS drive mapping', () => {
    expect(resolveSessionPath(WSL_CWD, '/e/project/foo.py', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\e\\project\\foo.py')
  })

  it('does not reinterpret other slash-rooted paths for ordinary Windows sessions', () => {
    expect(resolveSessionPath(WINDOWS_CWD, '/tmp/a.ts', 'win32')).toBe('/tmp/a.ts')
    expect(resolveSessionPath(WINDOWS_CWD, '/ab/cd', 'win32')).toBe('/ab/cd')
    expect(resolveSessionPath(WINDOWS_CWD, '/e', 'win32')).toBe('/e')
    expect(resolveSessionPath('\\\\server\\share\\project', '/tmp/a.ts', 'win32')).toBe('/tmp/a.ts')
  })

  it('does not reinterpret paths on non-Windows hosts', () => {
    expect(resolveSessionPath('/home/zdaar/project', '/tmp/a.ts', 'linux')).toBe('/tmp/a.ts')
    expect(resolveSessionPath('/home/zdaar/project', '/e/project/a.ts', 'linux')).toBe('/e/project/a.ts')
    expect(resolveSessionPath('/Users/zdaar/project', '/tmp/a.ts', 'darwin')).toBe('/tmp/a.ts')
  })

  it('recognizes wsl.localhost case-insensitively and with forward-slash cwd spelling', () => {
    expect(resolveSessionPath('//WSL.LOCALHOST/Ubuntu/home/me/project', '/home/me/project/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\project\\a.ts')
  })
})
