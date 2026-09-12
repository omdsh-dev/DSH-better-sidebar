/**
 * Host external-open helpers: per-platform opener commands (pure, injected
 * platform) and the URL validation that guards the spawn route. The actual
 * OS handlers are not launched in unit tests.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  launchExternal,
  revealCommand,
  urlCommand,
  validateExternalUrl,
  wslRemoteEditorUrl,
} from '../src/open-external.ts'
import { SidebarError } from '../src/wire.ts'

const wslCommands = {
  wsl: true,
  toWindowsPath: (path: string): string => path === '/a/b.txt' ? 'C:\\a\\b.txt' : path,
  windowsExecutable: (path: string): string => path.endsWith('explorer.exe')
    ? '/windows/explorer.exe'
    : '/windows/System32/rundll32.exe',
}

describe('revealCommand', () => {
  it('darwin: `open -R <path>` selects the file in Finder', () => {
    expect(revealCommand('/a/b.txt', 'darwin')).toEqual({ command: 'open', args: ['-R', '/a/b.txt'] })
  })

  it('win32: passes /select,<path> as one shell-free Explorer argument', () => {
    expect(revealCommand('C:\\work\\two words\\a.txt', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/select,C:\\work\\two words\\a.txt'],
    })
  })

  it('linux: `xdg-open` opens the containing directory (no common select protocol)', () => {
    expect(revealCommand('/a/b.txt', 'linux')).toEqual({ command: 'xdg-open', args: ['/a'] })
    expect(revealCommand('/', 'linux')).toEqual({ command: 'xdg-open', args: ['/'] })
  })

  it('wsl: translates the path and selects it with an absolute Windows Explorer command', () => {
    expect(revealCommand('/a/b.txt', 'linux', wslCommands)).toEqual({
      command: '/windows/explorer.exe',
      args: ['/select,C:\\a\\b.txt'],
    })
  })
})

describe('urlCommand', () => {
  it('darwin: `open <url>` launches the registered protocol handler', () => {
    expect(urlCommand('vscode://file/x', 'darwin')).toEqual({ command: 'open', args: ['vscode://file/x'] })
  })

  it('win32: rundll32 url.dll,FileProtocolHandler <url>', () => {
    expect(urlCommand('cursor://file/x', 'win32')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'cursor://file/x'],
    })
  })

  it('linux: `xdg-open <url>` launches the registered protocol handler', () => {
    expect(urlCommand('zed://file/x', 'linux')).toEqual({ command: 'xdg-open', args: ['zed://file/x'] })
  })

  it('wsl: dispatches custom schemes through the absolute Windows URL handler', () => {
    expect(urlCommand('zed://file//home/u/f.ts', 'linux', wslCommands)).toEqual({
      command: '/windows/System32/rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'zed://file//home/u/f.ts'],
    })
  })
})

describe('wslRemoteEditorUrl', () => {
  it('converts VS Code and Cursor POSIX file URLs to Remote-WSL URLs', () => {
    expect(wslRemoteEditorUrl('vscode://file//home/u/f.ts', 'Ubuntu-22.04'))
      .toBe('vscode://vscode-remote/wsl+Ubuntu-22.04/home/u/f.ts')
    expect(wslRemoteEditorUrl('cursor://file//mnt/d/dev/f.ts', 'Ubuntu-22.04'))
      .toBe('cursor://vscode-remote/wsl+Ubuntu-22.04/mnt/d/dev/f.ts')
  })

  it('leaves non-VSCode-family schemes unchanged', () => {
    expect(wslRemoteEditorUrl('zed://file//home/u/f.ts', 'Ubuntu-22.04'))
      .toBe('zed://file//home/u/f.ts')
  })

  it('rejects a Remote-WSL conversion when the distro name is unavailable', () => {
    expect(() => wslRemoteEditorUrl('vscode://file//home/u/f.ts', '')).toThrow(SidebarError)
  })
})

describe('validateExternalUrl', () => {
  it('accepts custom-scheme URLs (incl. the SSH-remote form)', () => {
    expect(validateExternalUrl('vscode://vscode-remote/ssh-remote+dev/home/u/f.ts'))
      .toBe('vscode://vscode-remote/ssh-remote+dev/home/u/f.ts')
    expect(validateExternalUrl('myapp://file/{path}')).toBe('myapp://file/{path}')
  })

  it('rejects http/https (only custom schemes make sense here)', () => {
    expect(() => validateExternalUrl('https://example.com')).toThrow(SidebarError)
    expect(() => validateExternalUrl('http://example.com')).toThrow(SidebarError)
  })

  it('rejects non-URL / non-`scheme://` strings', () => {
    expect(() => validateExternalUrl('/home/u/f.ts')).toThrow(SidebarError)
    expect(() => validateExternalUrl('a:file/x')).toThrow(SidebarError)
    expect(() => validateExternalUrl('')).toThrow(SidebarError)
  })
})

describe('launchExternal validation and spawn lifecycle', () => {
  it('rejects relative reveal paths before anything is spawned', () => {
    expect(() => launchExternal('reveal', 'relative/path')).toThrow(SidebarError)
  })

  it('rejects invalid URLs before anything is spawned', () => {
    expect(() => launchExternal('url', 'https://example.com')).toThrow(SidebarError)
  })

  it('rejects instead of reporting started when the opener emits a spawn error', async () => {
    const child = new EventEmitter()
    const unref = vi.fn()
    const fakeSpawn = vi.fn(() => Object.assign(child, { unref })) as unknown as typeof import('node:child_process').spawn
    const pending = launchExternal('url', 'zed://file//tmp/a.ts', {
      platform: 'linux',
      wsl: false,
      spawn: fakeSpawn,
    })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'internal' })

    child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }))

    await assertion
    expect(unref).toHaveBeenCalledTimes(1)
  })
})
