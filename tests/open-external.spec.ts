/**
 * Host external-open helpers: per-platform opener commands (pure, injected
 * platform) and the URL validation that guards the spawn route. The actual
 * spawns are not exercised — the route runs in the DSH host process and the
 * OS outcome is not testable here.
 */
import { describe, expect, it } from 'vitest'
import {
  externalSpawnOptions,
  launchExternal,
  revealCommand,
  urlCommand,
  validateExternalUrl,
} from '../src/open-external.ts'
import { SidebarError } from '../src/wire.ts'

describe('revealCommand', () => {
  it('darwin: `open -R <path>` selects the file in Finder', () => {
    expect(revealCommand('/a/b.txt', 'darwin')).toEqual({ command: 'open', args: ['-R', '/a/b.txt'] })
  })

  it('win32: quotes only the Explorer reveal path and keeps special characters literal', () => {
    expect(revealCommand('C:\\work\\two words (x) & y\\file #x.txt', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/select,"C:\\work\\two words (x) & y\\file #x.txt"'],
    })
  })

  it('linux: `xdg-open` opens the containing directory (no common select protocol)', () => {
    expect(revealCommand('/a/b.txt', 'linux')).toEqual({ command: 'xdg-open', args: ['/a'] })
    expect(revealCommand('/', 'linux')).toEqual({ command: 'xdg-open', args: ['/'] })
  })
})

describe('externalSpawnOptions', () => {
  it('win32 reveal: preserves the path-only Explorer quotes verbatim', () => {
    expect(externalSpawnOptions('reveal', 'win32')).toEqual({
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    })
  })

  it('keeps Node argv quoting for URL opens and non-Windows reveals', () => {
    expect(externalSpawnOptions('url', 'win32')).toEqual({ detached: true, stdio: 'ignore' })
    expect(externalSpawnOptions('reveal', 'darwin')).toEqual({ detached: true, stdio: 'ignore' })
    expect(externalSpawnOptions('reveal', 'linux')).toEqual({ detached: true, stdio: 'ignore' })
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

describe('launchExternal validation (pre-spawn)', () => {
  it('rejects relative reveal paths before anything is spawned', () => {
    expect(() => launchExternal('reveal', 'relative/path')).toThrow(SidebarError)
  })

  it('rejects invalid URLs before anything is spawned', () => {
    expect(() => launchExternal('url', 'https://example.com')).toThrow(SidebarError)
  })
})
