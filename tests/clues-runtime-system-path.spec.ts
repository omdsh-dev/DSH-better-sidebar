/** Desktop PATH completion is deterministic and never runs shell/rc files. */
import { describe, expect, it, vi } from 'vitest'
import { systemPathEnvironment } from '../src/clues/runtime/system-path.ts'
import { pathCommandCandidates } from '../src/clues/runtime/dependencies.ts'
import { buildCliEnv } from '../src/clues/runtime/cli.ts'

describe('one startup PATH snapshot for discovery and CLI execution', () => {
  it('finds an npm CLI in NVM even when a desktop PATH omitted every Node directory', () => {
    const scan = vi.fn(() => ['v24.16.0', '../invalid', 'v22.0.0'])
    const inherited = { PATH: '/usr/bin:/bin', HOME: '/fixture/user' }
    const env = systemPathEnvironment(inherited, {
      platform: 'darwin', userHome: '/fixture/user', execPath: '/App/embedded/bin/node', readNvmVersions: scan,
    })
    expect(inherited.PATH).toBe('/usr/bin:/bin')
    expect(pathCommandCandidates('lark-cli', 'darwin', env)).toContain('/fixture/user/.nvm/versions/node/v24.16.0/bin/lark-cli')
    const child = buildCliEnv(env, undefined, undefined)
    expect(child.PATH).toBe(env.PATH)
    expect(child.PATH?.split(':')).toContain('/App/embedded/bin')
    expect(child.PATH?.split(':')).toContain('/fixture/user/.nvm/versions/node/v24.16.0/bin')
    expect(child.PATH).not.toContain('../invalid')
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('preserves inherited order and appends conventional bins without duplicates', () => {
    const env = systemPathEnvironment({ PATH: '/chosen/bin:/usr/bin:/chosen/bin:relative' }, {
      platform: 'linux', userHome: '/users/u', execPath: '/chosen/bin/node', readNvmVersions: () => [],
    })
    const paths = env.PATH!.split(':')
    expect(paths.slice(0, 2)).toEqual(['/chosen/bin', '/usr/bin'])
    expect(paths.filter(path => path === '/chosen/bin')).toHaveLength(1)
    expect(paths).toContain('/users/u/.local/share/pnpm')
    expect(paths).not.toContain('relative')
  })

  it('uses Windows path dialect and a single case-insensitive PATH field', () => {
    const scan = vi.fn(() => [])
    const env = systemPathEnvironment({ Path: 'C:\\Tools;C:\\WINDOWS;C:\\tools', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, {
      platform: 'win32', userHome: 'C:\\Users\\u', execPath: 'C:\\Program Files\\nodejs\\node.exe', readNvmVersions: scan,
    })
    expect(env.Path).toBeUndefined()
    expect(env.PATH!.split(';')).toContain('C:\\Program Files\\nodejs')
    expect(env.PATH!.split(';')).toContain('C:\\Users\\u\\AppData\\Roaming\\npm')
    expect(env.PATH!.split(';').filter(path => path.toLowerCase() === 'c:\\tools')).toHaveLength(1)
    expect(scan).not.toHaveBeenCalled()
  })

  it('bounds NVM additions even when an injected directory contains many versions', () => {
    const env = systemPathEnvironment({ PATH: '/usr/bin' }, {
      platform: 'darwin', userHome: '/u', execPath: '/node/bin/node',
      readNvmVersions: () => Array.from({ length: 1000 }, (_, n) => `v24.${n}.0`),
    })
    expect(env.PATH!.split(':').filter(path => path.includes('/versions/node/'))).toHaveLength(32)
  })
})
