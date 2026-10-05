/**
 * Host external-open helpers: per-platform opener commands (pure, injected
 * platform) and the URL validation that guards the spawn route. The actual
 * OS handlers are not launched in unit tests.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  editorCommand,
  externalProcessEnv,
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

  it('android (Termux): `termux-open` hands the parent dir to the Android chooser', () => {
    expect(revealCommand('/a/b.txt', 'android')).toEqual({ command: 'termux-open', args: ['/a'] })
    expect(revealCommand('/', 'android')).toEqual({ command: 'termux-open', args: ['/'] })
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

  it('android (Termux): `termux-open-url <url>` dispatches the Android intent', () => {
    expect(urlCommand('vscode://file/x', 'android')).toEqual({ command: 'termux-open-url', args: ['vscode://file/x'] })
  })

  it('wsl: dispatches custom schemes through the absolute Windows URL handler', () => {
    expect(urlCommand('zed://file//home/u/f.ts', 'linux', wslCommands)).toEqual({
      command: '/windows/System32/rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'zed://file//home/u/f.ts'],
    })
  })
})

describe('editorCommand', () => {
  it.each([
    ['vscode', 'C:\\Program Files\\Microsoft VS Code\\Code.exe'],
    ['cursor', 'C:\\Users\\u\\AppData\\Local\\Programs\\Cursor\\Cursor.exe'],
  ] as const)('win32: starts %s with the native file path', (editor, executable) => {
    const filePath = 'C:\\Users\\u\\project\\a.ts'
    expect(editorCommand(editor, filePath, 'win32', {
      lookupExecutable: () => executable,
    })).toEqual({ command: executable, args: [filePath] })
  })

  it('falls back to the Windows protocol handler when no executable is found', () => {
    expect(editorCommand('vscode', 'C:\\Users\\u\\a.ts', 'win32', {
      lookupExecutable: () => undefined,
    })).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'vscode://file/C:/Users/u/a.ts'],
    })
  })
})

describe('externalProcessEnv', () => {
  it('removes Electron Node mode and preserves the remaining environment', () => {
    const source = { ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\bin', HOME: 'C:\\Users\\u' }
    expect(externalProcessEnv(source)).toEqual({ PATH: 'C:\\bin', HOME: 'C:\\Users\\u' })
    expect(source.ELECTRON_RUN_AS_NODE).toBe('1')
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
    expect(() => launchExternal({ action: 'reveal', path: 'relative/path' })).toThrow(SidebarError)
  })

  it('rejects invalid URLs before anything is spawned', () => {
    expect(() => launchExternal({ action: 'url', url: 'https://example.com' })).toThrow(SidebarError)
  })

  it('cleans the environment for reveal and URL launches', async () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\bin', HOME: 'C:\\Users\\u' }
    for (const request of [
      { action: 'reveal', path: 'C:\\Users\\u\\a.ts' },
      { action: 'url', url: 'zed://file/a.ts' },
    ] as const) {
      const child = new EventEmitter()
      const spawnMock = vi.fn((
        _command: string,
        _args: string[],
        _options?: import('node:child_process').SpawnOptions,
      ) => Object.assign(child, { unref: vi.fn() }))
      const pending = launchExternal(request, {
        platform: 'win32', env,
        spawn: spawnMock as unknown as typeof import('node:child_process').spawn,
      })
      child.emit('spawn')
      await expect(pending).resolves.toEqual({ started: true })
      expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
        env: { PATH: 'C:\\bin', HOME: 'C:\\Users\\u' },
      })
      expect(spawnMock.mock.calls[0]?.[2]?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    }
  })

  it('cleans the Desktop environment when launching a Windows editor', async () => {
    const child = new EventEmitter()
    const fakeSpawn = vi.fn(() => Object.assign(child, { unref: vi.fn() })) as unknown as typeof import('node:child_process').spawn
    const filePath = 'C:\\Users\\u\\project\\a.ts'
    const pending = launchExternal({ action: 'editor', editor: 'vscode', path: filePath }, {
      platform: 'win32',
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\bin' },
      lookupEditorExecutable: () => 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      spawn: fakeSpawn,
    })
    child.emit('spawn')
    await expect(pending).resolves.toEqual({ started: true })
    expect(fakeSpawn).toHaveBeenCalledWith('C:\\Program Files\\Microsoft VS Code\\Code.exe', [filePath], expect.objectContaining({
      env: { PATH: 'C:\\bin' },
    }))
  })

  it('keeps Remote-WSL editor URLs on the Windows protocol handler', async () => {
    const child = new EventEmitter()
    const fakeSpawn = vi.fn(() => Object.assign(child, { unref: vi.fn() })) as unknown as typeof import('node:child_process').spawn
    const pending = launchExternal({ action: 'editor', editor: 'cursor', path: '/home/u/a.ts' }, {
      platform: 'linux',
      wsl: true,
      distroName: 'Ubuntu-22.04',
      commandOptions: { windowsExecutable: () => '/mnt/c/Windows/System32/rundll32.exe' },
      spawn: fakeSpawn,
    })
    child.emit('spawn')
    await expect(pending).resolves.toEqual({ started: true })
    expect(fakeSpawn).toHaveBeenCalledWith('/mnt/c/Windows/System32/rundll32.exe', [
      'url.dll,FileProtocolHandler',
      'cursor://vscode-remote/wsl+Ubuntu-22.04/home/u/a.ts',
    ], expect.any(Object))
  })

  it('reports editor, fallback command and the spawn error when lookup and fallback fail', async () => {
    const child = new EventEmitter()
    const spawnMock = vi.fn(() => Object.assign(child, { unref: vi.fn() })) as unknown as typeof import('node:child_process').spawn
    const pending = launchExternal({ action: 'editor', editor: 'vscode', path: 'C:\\Users\\u\\a.ts' }, {
      platform: 'win32',
      lookupEditorExecutable: () => undefined,
      spawn: spawnMock,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('vscode via "rundll32.exe": spawn rundll32.exe ENOENT'),
    })
    child.emit('error', Object.assign(new Error('spawn rundll32.exe ENOENT'), { code: 'ENOENT' }))
    await assertion
  })

  it('includes the editor, command and spawn error when a launch fails', async () => {
    const child = new EventEmitter()
    const unref = vi.fn()
    const fakeSpawn = vi.fn(() => Object.assign(child, { unref })) as unknown as typeof import('node:child_process').spawn
    const pending = launchExternal({ action: 'editor', editor: 'cursor', path: 'C:\\Users\\u\\a.ts' }, {
      platform: 'win32',
      lookupEditorExecutable: () => 'C:\\Cursor\\Cursor.exe',
      spawn: fakeSpawn,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('cursor via "C:\\Cursor\\Cursor.exe": spawn C:\\Cursor\\Cursor.exe ENOENT'),
    })

    child.emit('error', Object.assign(new Error('spawn C:\\Cursor\\Cursor.exe ENOENT'), { code: 'ENOENT' }))

    await assertion
    expect(unref).toHaveBeenCalledTimes(1)
  })
})
