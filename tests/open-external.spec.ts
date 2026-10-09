/**
 * Host external-open helpers: per-platform opener commands (pure, injected
 * platform) and the URL validation that guards the spawn route. The actual
 * OS handlers are not launched in unit tests.
 */
import { EventEmitter } from 'node:events'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  launchExternal,
  revealCommand,
  urlCommands,
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

describe('urlCommands', () => {
  it('darwin: `open <url>` launches the registered protocol handler', () => {
    expect(urlCommands('vscode://file/x', 'darwin')).toEqual([{ command: 'open', args: ['vscode://file/x'] }])
  })

  it('win32: `cmd /d /c start "" <url>` first, rundll32 as the fallback', () => {
    expect(urlCommands('cursor://file/x', 'win32')).toEqual([
      { command: 'cmd.exe', args: ['/d', '/c', 'start', '', 'cursor://file/x'] },
      { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'cursor://file/x'] },
    ])
  })

  it('win32: a URL with spaces stays ONE argv element (no shell string is built)', () => {
    expect(urlCommands('cursor://file/C:/Program Files/a.ts', 'win32')[0]).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/c', 'start', '', 'cursor://file/C:/Program Files/a.ts'],
    })
  })

  // `cmd /c` re-parses the command line after Node's quoting: an unskipped
  // metacharacter would be expanded (`%VAR%`), split (`&`/`|`), escaped (`^`)
  // or re-quoted (`"`) instead of reaching the handler verbatim.
  it.each([
    ['&', 'myapp://file/a&b.ts'],
    ['%', 'myapp://file/%PATH%/a.ts'],
    ['^', 'myapp://file/a^b.ts'],
    ['!', 'myapp://file/!x!/a.ts'],
    ['|', 'myapp://file/a|b.ts'],
    ['<', 'myapp://file/a<b.ts'],
    ['>', 'myapp://file/a>b.ts'],
    ['"', 'myapp://file/a"b.ts'],
  ])('win32: skips the cmd branch for a URL carrying %s (rundll32 only)', (_char, url) => {
    expect(urlCommands(url, 'win32')).toEqual([
      { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
    ])
  })

  it('win32: skips the cmd branch for a URL carrying a raw control character', () => {
    // `new URL` strips CR/LF, but validateExternalUrl returns the RAW string,
    // and cmd treats a newline as a command separator.
    const url = 'myapp://file/a\n--x'
    expect(urlCommands(url, 'win32').map(spec => spec.command)).toEqual(['rundll32.exe'])
  })

  it('win32: the opener names are injectable (the Windows-lane failure seam)', () => {
    expect(urlCommands('zed://file/x', 'win32', {
      cmdExecutable: 'missing-cmd-412.exe',
      rundll32Executable: 'missing-rundll-412.exe',
    })).toEqual([
      { command: 'missing-cmd-412.exe', args: ['/d', '/c', 'start', '', 'zed://file/x'] },
      { command: 'missing-rundll-412.exe', args: ['url.dll,FileProtocolHandler', 'zed://file/x'] },
    ])
  })

  it('linux: `xdg-open <url>` launches the registered protocol handler', () => {
    expect(urlCommands('zed://file/x', 'linux')).toEqual([{ command: 'xdg-open', args: ['zed://file/x'] }])
  })

  it('android (Termux): `termux-open-url <url>` dispatches the Android intent', () => {
    expect(urlCommands('vscode://file/x', 'android')).toEqual([{ command: 'termux-open-url', args: ['vscode://file/x'] }])
  })

  it('wsl: dispatches custom schemes through the absolute Windows URL handler', () => {
    expect(urlCommands('zed://file//home/u/f.ts', 'linux', wslCommands)).toEqual([{
      command: '/windows/System32/rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'zed://file//home/u/f.ts'],
    }])
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

/** One recorded spawn call plus the fake child it handed back. */
interface RecordedSpawn {
  command: string
  args: readonly string[]
  child: EventEmitter
}

/**
 * A `spawn` seam that records the argv of every ATTEMPT and never starts a
 * process: the caller decides each attempt's outcome with `settle()`, so the
 * chain's order, its fallback and its terminal error shape are all observable.
 */
function recordingSpawn(): {
  spawn: typeof import('node:child_process').spawn
  calls: RecordedSpawn[]
  unref: ReturnType<typeof vi.fn>
  settle: (index: number, outcome: 'spawn' | 'error', message?: string) => void
} {
  const calls: RecordedSpawn[] = []
  const unref = vi.fn()
  const spawnFn = ((command: string, args: readonly string[]) => {
    const child = new EventEmitter()
    Object.assign(child, { unref })
    calls.push({ command, args, child })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  const settle = (index: number, outcome: 'spawn' | 'error', message = 'spawn failed'): void => {
    const call = calls[index]
    if (call === undefined) throw new Error(`no spawn attempt #${index} (got ${calls.length})`)
    if (outcome === 'spawn') call.child.emit('spawn')
    else call.child.emit('error', Object.assign(new Error(message), { code: 'ENOENT' }))
  }
  return { spawn: spawnFn, calls, unref, settle }
}

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

describe('launchExternal Windows branch order and failure reporting', () => {
  const url = 'vscode://file/C:/a.ts'
  const win = { platform: 'win32' as const, wsl: false }

  it('spawns `cmd /d /c start "" <url>` first, with the URL as one argv element', () => {
    const fake = recordingSpawn()
    void launchExternal('url', url, { ...win, spawn: fake.spawn }).catch(() => {})
    expect(fake.calls.map(call => ({ command: call.command, args: call.args }))).toEqual([
      { command: 'cmd.exe', args: ['/d', '/c', 'start', '', url] },
    ])
  })

  it('falls through to rundll32 when the cmd branch cannot spawn', async () => {
    const fake = recordingSpawn()
    const pending = launchExternal('url', url, { ...win, spawn: fake.spawn })
    fake.settle(0, 'error', 'spawn cmd.exe ENOENT')
    expect(fake.calls.map(call => call.command)).toEqual(['cmd.exe', 'rundll32.exe'])
    fake.settle(1, 'spawn')
    await expect(pending).resolves.toEqual({ started: true })
    expect(fake.unref).toHaveBeenCalledTimes(2)
  })

  it('advances on a synchronous spawn throw as well', async () => {
    const fake = recordingSpawn()
    const calls: string[] = []
    const spawnFn = ((command: string, args: readonly string[]) => {
      calls.push(command)
      if (calls.length === 1) throw new Error('EINVAL: bad command line')
      return fake.spawn(command, args)
    }) as unknown as typeof import('node:child_process').spawn
    const pending = launchExternal('url', url, { ...win, spawn: spawnFn })
    expect(calls).toEqual(['cmd.exe', 'rundll32.exe'])
    fake.settle(0, 'spawn')
    await expect(pending).resolves.toEqual({ started: true })
  })

  it('skips the cmd branch for a `&` URL — the whole launch only tries rundll32', () => {
    const fake = recordingSpawn()
    void launchExternal('url', 'myapp://file/a&b.ts', { ...win, spawn: fake.spawn }).catch(() => {})
    expect(fake.calls.map(call => call.command)).toEqual(['rundll32.exe'])
    expect(fake.calls[0]?.args).toEqual(['url.dll,FileProtocolHandler', 'myapp://file/a&b.ts'])
  })

  it('rejects with a structured failure naming EVERY dead branch (never a silent success)', async () => {
    const fake = recordingSpawn()
    const pending = launchExternal('url', url, { ...win, spawn: fake.spawn })
    fake.settle(0, 'error', 'spawn cmd.exe ENOENT')
    fake.settle(1, 'error', 'spawn rundll32.exe EACCES')
    const error = await pending.then(() => null, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(SidebarError)
    const failure = error as SidebarError
    expect(failure.code).toBe('internal')
    expect(failure.status).toBe(500)
    expect(failure.message).toBe(
      'failed to launch external opener for the url: "cmd.exe" (spawn cmd.exe ENOENT); '
      + '"rundll32.exe" (spawn rundll32.exe EACCES)',
    )
    expect(fake.unref).toHaveBeenCalledTimes(2)
  })

  it('reports a reveal failure with the same shape (one branch, `path` subject)', async () => {
    const fake = recordingSpawn()
    // The path is normalized and its parent derived with the HOST path module,
    // so the fixture must be host-absolute too — a literal `/a/b.txt` is not an
    // absolute path on Windows (win32 resolves it against the current drive).
    const file = resolve('/', 'a', 'b.txt')
    const pending = launchExternal('reveal', file, {
      platform: 'linux',
      wsl: false,
      spawn: fake.spawn,
    })
    fake.settle(0, 'error', 'spawn xdg-open ENOENT')
    const error = await pending.then(() => null, (reason: unknown) => reason)

    expect(fake.calls.map(call => ({ command: call.command, args: call.args }))).toEqual([
      { command: 'xdg-open', args: [dirname(file)] },
    ])
    expect((error as SidebarError).message).toBe(
      'failed to launch external opener for the path: "xdg-open" (spawn xdg-open ENOENT)',
    )
  })
})
