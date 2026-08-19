import { describe, expect, it, vi } from 'vitest'

// Pin the passwd login shell to a non-bash value for the pty helpers tests:
// the CI runner's own login shell is /bin/bash, which the old hardcoded
// fallback would have satisfied by coincidence, so the fallback chain needs
// a mock passwd to be genuinely discriminating. No other test reads os.userInfo.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return {
    ...os,
    userInfo: () => ({ ...os.userInfo(), shell: '/usr/bin/zsh' }),
  }
})

import { resolveSidebarConfig } from '../src/config.ts'
import { defaultShell, ensureSpawnHelper, shellDisplayName, shellSpawnArgs } from '../src/pty-manager.ts'

describe('pty helpers', () => {
  it('prefers an explicit shell, then SHELL, then the account login shell on POSIX', () => {
    // The platform is injected so this chain also runs (and is asserted) on
    // non-POSIX developer machines. The userInfo mock at the top of the file
    // pins the passwd login shell to /usr/bin/zsh.
    expect(defaultShell({ platform: 'linux', env: { SHELL: '/explicit/zsh' } })).toBe('/explicit/zsh')
    // Surrounding whitespace must not leak into the spawned executable path.
    expect(defaultShell({ platform: 'linux', env: { SHELL: '  /explicit/zsh  ' } })).toBe('/explicit/zsh')
    expect(defaultShell({ platform: 'linux', env: { SHELL: '   ' } })).toBe('/usr/bin/zsh')
    expect(defaultShell({ platform: 'linux', env: {} })).toBe('/usr/bin/zsh')
  })

  it('Windows: explicit shell wins, then DSH_SIDEBAR_SHELL, then a probed pwsh.exe, then powershell.exe 5.1', () => {
    // The explicit shell (the `shell` config field) beats every automatic
    // source, and whitespace-only values count as unset.
    expect(defaultShell({ platform: 'win32', explicit: 'C:\\Tools\\pwsh.exe', env: { DSH_SIDEBAR_SHELL: 'pwsh.exe' } }))
      .toBe('C:\\Tools\\pwsh.exe')
    expect(defaultShell({ platform: 'win32', explicit: '   ', env: { DSH_SIDEBAR_SHELL: 'pwsh.exe' } }))
      .toBe('pwsh.exe')

    // PATH is probed entry by entry; the first directory containing pwsh.exe
    // wins and the returned value is the full resolved path. The candidate is
    // normalized to forward slashes before comparing so the assertion holds
    // under BOTH join() implementations: on the ubuntu runners node:path is
    // POSIX and joins 'C:\\other' + 'pwsh.exe' as 'C:\\other/pwsh.exe'.
    const fromPath = defaultShell({
      platform: 'win32',
      env: { PATH: 'C:\\tools;C:\\other' },
      exists: path => path.replaceAll('\\', '/') === 'C:/other/pwsh.exe',
    })
    expect(fromPath.replaceAll('\\', '/')).toBe('C:/other/pwsh.exe')

    // PATH misses fall through to the known install directories. On 32-bit
    // Node, ProgramW6432 is the real 64-bit Program Files and is preferred.
    const fromProgramW6432 = defaultShell({
      platform: 'win32',
      env: { ProgramW6432: 'C:\\PF64' },
      exists: path => path.replaceAll('\\', '/') === 'C:/PF64/PowerShell/7/pwsh.exe',
    })
    expect(fromProgramW6432.replaceAll('\\', '/')).toBe('C:/PF64/PowerShell/7/pwsh.exe')
    const fromProgramFiles = defaultShell({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      exists: path => path.replaceAll('\\', '/') === 'C:/PF/PowerShell/7/pwsh.exe',
    })
    expect(fromProgramFiles.replaceAll('\\', '/')).toBe('C:/PF/PowerShell/7/pwsh.exe')

    // Nothing installed: keep the inbox 5.1 fallback instead of breaking.
    expect(defaultShell({ platform: 'win32', env: {}, exists: () => false })).toBe('powershell.exe')
  })

  it('trims the configured shell and defaults it to auto for old documents', () => {
    expect(resolveSidebarConfig(undefined).shell).toBe('')
    expect(resolveSidebarConfig({ shell: '  pwsh.exe  ' }).shell).toBe('pwsh.exe')
    expect(resolveSidebarConfig({ shell: '/bin/zsh', shellArgs: ['--noprofile'] }).shellArgs).toEqual(['--noprofile'])
    expect(resolveSidebarConfig(undefined).shellArgs).toEqual([])
  })

  it('derives a short display name for terminal tab titles', () => {
    expect(shellDisplayName('/bin/zsh')).toBe('zsh')
    expect(shellDisplayName('/usr/bin/bash')).toBe('bash')
    expect(shellDisplayName('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell')
    expect(shellDisplayName('pwsh.exe')).toBe('pwsh')
    expect(shellDisplayName('/weird')).toBe('weird')
    expect(shellDisplayName('/')).toBe('/')
  })

  it('uses explicit shell args verbatim and keeps platform defaults when none are configured', () => {
    expect(shellSpawnArgs(['--noprofile', '--no-rc'])).toEqual(['--noprofile', '--no-rc'])
    expect(shellSpawnArgs([])).toEqual(process.platform === 'win32' ? [] : ['-l'])
  })

  it('restores the spawn-helper executable bit idempotently', () => {
    // node-pty's spawn-helper is a macOS-only artifact: binding.gyp builds
    // the executable only for OS=="mac", and no other platform ships one to
    // restore (linux uses forkpty directly). Skip elsewhere.
    if (process.platform !== 'darwin') return
    ensureSpawnHelper()
    ensureSpawnHelper()
    const { existsSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { dirname, join } = require('node:path') as typeof import('node:path')
    const { createRequire } = require('node:module') as typeof import('node:module')
    const entry = createRequire(import.meta.url).resolve('node-pty')
    const root = dirname(dirname(entry))
    // Prebuilt (tarball) or node-gyp-compiled (build/Release): mirror
    // ensureSpawnHelper's candidate list — either location is acceptable.
    const candidates = [
      join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'),
    ]
    const helper = candidates.find(existsSync)
    expect(helper).toBeTruthy()
    expect((statSync(helper!).mode & 0o111) !== 0).toBe(true)
  })
})
