/**
 * S2 dependency runtime contract.
 *
 * Pinned with fake process probes and an injected PATH existence seam (no real
 * user CLI, HOME or Keychain is touched):
 * - precedence is explicit path > managed copy > compatible PATH command, and
 *   an invalid explicit path NEVER silently falls back;
 * - discovery runs exactly `<executable> --version` once per probe, with the
 *   dependency's env allowlist and an absolute probe cwd;
 * - the six states (unknown/missing/incompatible/ready/installing/failed) are
 *   derived from real probe results, not from file existence alone;
 * - concurrent inspections share one in-flight probe, the TTL cache is reused
 *   and `refresh` bypasses it; install success / manual changes invalidate it;
 * - platform/arch support only controls whether automatic install is offered;
 * - install plans are bound to the fixed recommended version and a target
 *   outside every system directory.
 */
import { describe, expect, it } from 'vitest'
import { join, posix, win32 } from 'node:path'
import { ClueError } from '../src/clues/error.ts'
import {
  createDependenciesRuntime,
  parseDependencyVersion,
  pathCommandCandidates,
  versionAtLeast,
} from '../src/clues/runtime/dependencies.ts'
import { managedTargetDir } from '../src/clues/runtime/install.ts'
import type {
  CliCommandRequest,
  CliResult,
  CliRunner,
  ClueDependencyDefinition,
  DependencyStatus,
  InstallTransport,
} from '../src/clues/runtime/types.ts'

const HOME = process.platform === 'win32' ? 'C:\\dsh-home' : '/dsh-home'
const IS_WIN = process.platform === 'win32'


/** A fake CLI runner recording every probe command. */
function fakeRunner(answer: (request: CliCommandRequest) => Partial<CliResult> | Error): CliRunner & {
  readonly calls: CliCommandRequest[]
} {
  const calls: CliCommandRequest[] = []
  return {
    calls,
    async run(request: CliCommandRequest): Promise<CliResult> {
      calls.push(request)
      const result = answer(request)
      if (result instanceof Error) throw result
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        stdoutTruncated: result.stdoutTruncated ?? false,
        stderrTruncated: result.stderrTruncated ?? false,
        durationMs: result.durationMs ?? 1,
      }
    },
    async runJson(): Promise<never> {
      throw new Error('the dependency probe must never parse JSON')
    },
  }
}

/** A PATH/managed existence seam. */
function fakeExists(paths: readonly string[]): (path: string) => Promise<boolean> {
  const set = new Set(paths)
  return async path => set.has(path)
}

function definition(overrides: Partial<ClueDependencyDefinition> = {}): ClueDependencyDefinition {
  return {
    dependencyId: 'github.gh',
    name: 'GitHub CLI',
    command: 'gh',
    pluginId: 'dsh-better-sidebar',
    version: { minimum: '2.40.0', recommended: '2.40.1' },
    supportedPlatforms: [{ platform: process.platform, arch: process.arch }],
    envAllowlist: ['GH_CONFIG_DIR'],
    install: {
      distributions: [{
        kind: 'archive',
        source: 'GitHub releases',
        url: 'https://example.invalid/gh.tar.gz',
        sha256: 'a'.repeat(64),
        archive: 'tar.gz',
        executable: IS_WIN ? 'bin/gh.exe' : 'bin/gh',
      }],
    },
    manualInstall: { instructions: 'Install gh from the official site', url: 'https://cli.github.com' },
    ...overrides,
  }
}

const PATH_GH = IS_WIN ? 'C:\\tools\\gh.exe' : '/usr/local/bin/gh'
const ENV = { PATH: IS_WIN ? 'C:\\tools' : '/usr/local/bin' }

interface HarnessOptions {
  readonly paths?: readonly string[]
  readonly answer?: (request: CliCommandRequest) => Partial<CliResult> | Error
  readonly home?: string | undefined
  readonly now?: () => number
  readonly manualPaths?: Record<string, string>
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly transport?: InstallTransport
}

function harness(options: HarnessOptions = {}): {
  runtime: ReturnType<typeof createDependenciesRuntime>
  runner: ReturnType<typeof fakeRunner>
} {
  const runner = fakeRunner(options.answer ?? (() => ({ stdout: 'gh version 2.40.1 (2024-01-01)' })))
  const runtime = createDependenciesRuntime({
    home: 'home' in options ? options.home : HOME,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    env: ENV,
    runProcess: runner,
    probeCwd: HOME,
    pathExists: fakeExists(options.paths ?? []),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.manualPaths === undefined ? {} : { manualPaths: options.manualPaths }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  })
  runtime.register(definition())
  return { runtime, runner }
}

async function statusOf(runtime: ReturnType<typeof createDependenciesRuntime>, refresh = false): Promise<DependencyStatus> {
  const [status] = await runtime.inspect('github.gh', refresh ? { refresh: true } : {})
  if (status === undefined) throw new Error('no status')
  return status
}

describe('version helpers', () => {
  it('parses reported versions and compares minimums', () => {
    expect(parseDependencyVersion('gh version 2.40.1 (2024-01-01)')).toBe('2.40.1')
    expect(parseDependencyVersion('lark-cli v1.2.3')).toBe('1.2.3')
    expect(parseDependencyVersion('no version here')).toBeUndefined()
    expect(versionAtLeast('2.40.1', '2.40.0')).toBe(true)
    expect(versionAtLeast('2.40.0', '2.40.0')).toBe(true)
    expect(versionAtLeast('2.39.9', '2.40.0')).toBe(false)
    expect(versionAtLeast('2.40.0-rc.1', '2.40.0')).toBe(false)
    expect(versionAtLeast('3.0.0', '2.40.0')).toBe(true)
  })

  it('derives PATH candidates in the argument platform dialect', () => {
    expect(pathCommandCandidates('gh', 'win32', { PATH: 'C:\\a;C:\\b' })).toEqual([
      win32.join('C:\\a', 'gh'), win32.join('C:\\a', 'gh.exe'),
      win32.join('C:\\a', 'gh.cmd'), win32.join('C:\\a', 'gh.bat'),
      win32.join('C:\\b', 'gh'), win32.join('C:\\b', 'gh.exe'),
      win32.join('C:\\b', 'gh.cmd'), win32.join('C:\\b', 'gh.bat'),
    ])
    // Windows exposes the variable as `Path`; both spellings are accepted.
    expect(pathCommandCandidates('gh', 'win32', { Path: 'C:\\tools' }))
      .toEqual([win32.join('C:\\tools', 'gh'), win32.join('C:\\tools', 'gh.exe'),
        win32.join('C:\\tools', 'gh.cmd'), win32.join('C:\\tools', 'gh.bat')])
    expect(pathCommandCandidates('gh', 'linux', { PATH: '/a:/b' }))
      .toEqual([posix.join('/a', 'gh'), posix.join('/b', 'gh')])
    // Relative PATH entries would yield a non-absolute executable path: skip.
    expect(pathCommandCandidates('gh', 'linux', { PATH: '.:/a' })).toEqual([posix.join('/a', 'gh')])
    expect(pathCommandCandidates('gh', 'win32', { PATH: '.\\bin;C:\\a' }))
      .toEqual([win32.join('C:\\a', 'gh'), win32.join('C:\\a', 'gh.exe'),
        win32.join('C:\\a', 'gh.cmd'), win32.join('C:\\a', 'gh.bat')])
  })
})

describe('dependency resolution', () => {
  it('reports missing, incompatible and ready from real --version probes', async () => {
    const missing = harness()
    expect((await statusOf(missing.runtime)).state).toBe('missing')
    expect(missing.runner.calls).toHaveLength(0)

    const incompatible = harness({
      paths: [PATH_GH],
      answer: () => ({ stdout: 'gh version 2.30.0' }),
    })
    const incompatibleStatus = await statusOf(incompatible.runtime)
    expect(incompatibleStatus.state).toBe('incompatible')
    expect(incompatibleStatus.version).toBe('2.30.0')
    expect(incompatibleStatus.error?.category).toBe('dependency-incompatible')

    const ready = harness({ paths: [PATH_GH] })
    const readyStatus = await statusOf(ready.runtime)
    expect(readyStatus).toMatchObject({
      state: 'ready',
      version: '2.40.1',
      resolvedFrom: 'path',
      executablePath: PATH_GH,
      supported: true,
      installable: true,
    })
    // Discovery: exactly `--version`, explicit cwd, dependency env names only.
    expect(ready.runner.calls).toHaveLength(1)
    expect(ready.runner.calls[0]).toMatchObject({
      command: PATH_GH,
      args: ['--version'],
      cwd: HOME,
      envAllowlist: ['GH_CONFIG_DIR'],
    })
  })

  it('prefers an explicit path and never probes PATH afterwards', async () => {
    const manual = IS_WIN ? 'C:\\Users\\me\\gh.exe' : '/Users/me/bin/gh'
    const { runtime, runner } = harness({ paths: [manual, PATH_GH], manualPaths: { 'github.gh': manual } })
    const status = await statusOf(runtime)
    expect(status).toMatchObject({ state: 'ready', resolvedFrom: 'manual', executablePath: manual })
    expect(runner.calls.map(call => call.command)).toEqual([manual])
  })

  it('reports a broken explicit path as failed without falling back to PATH', async () => {
    const missingPath = IS_WIN ? 'C:\\Users\\me\\missing.exe' : '/Users/me/bin/missing'
    const { runtime, runner } = harness({ paths: [PATH_GH], manualPaths: { 'github.gh': missingPath } })
    const status = await statusOf(runtime)
    expect(status.state).toBe('failed')
    expect(status.resolvedFrom).toBe('manual')
    expect(status.error?.category).toBe('dependency-missing')
    expect(status.executablePath).toBe(missingPath)
    expect(runner.calls).toHaveLength(0)
  })

  it('refuses a relative manual path at the API and reports a stored one as failed', async () => {
    const runtime = harness({ paths: [PATH_GH] }).runtime
    await expect(runtime.setManualPath('github.gh', 'relative/gh')).rejects.toMatchObject({
      category: 'invalid-request',
    })
    runtime.dispose()

    const stored = harness({ paths: [PATH_GH], manualPaths: { 'github.gh': 'relative/gh' } }).runtime
    const status = await statusOf(stored)
    expect(status.state).toBe('failed')
    expect(status.error?.category).toBe('invalid-request')
    stored.dispose()
  })

  it('prefers the managed copy over PATH and reports a broken managed copy instead of switching', async () => {
    // managedTargetDir + distribution executable ('bin/gh') resolved by the runtime.
    const managedPath = join(managedTargetDir(HOME, 'github.gh', '2.40.1'), 'bin', IS_WIN ? 'gh.exe' : 'gh')
    const { runtime, runner } = harness({ paths: [managedPath, PATH_GH] })
    const status = await statusOf(runtime)
    expect(status).toMatchObject({ state: 'ready', resolvedFrom: 'managed', executablePath: managedPath })
    expect(runner.calls.map(call => call.command)).toEqual([managedPath])
    runtime.dispose()

    const broken = harness({
      paths: [managedPath, PATH_GH],
      answer: request => request.command === managedPath
        ? { exitCode: 1, stderr: 'broken install token=secret-value' }
        : { stdout: 'gh version 2.40.1' },
    })
    const brokenStatus = await statusOf(broken.runtime)
    expect(brokenStatus.state).toBe('failed')
    expect(brokenStatus.resolvedFrom).toBe('managed')
    expect(broken.runner.calls.map(call => call.command)).toEqual([managedPath])
    broken.runtime.dispose()
  })

  it('shares one in-flight probe, reuses the TTL cache and refreshes on demand', async () => {
    let timestamp = 1_000
    const { runtime, runner } = harness({
      paths: [PATH_GH],
      now: () => timestamp,
    })
    const [first, second] = await Promise.all([statusOf(runtime), statusOf(runtime)])
    expect(first.state).toBe('ready')
    expect(second.state).toBe('ready')
    expect(runner.calls).toHaveLength(1)
    expect((await statusOf(runtime)).state).toBe('ready')
    expect(runner.calls).toHaveLength(1)
    expect((await statusOf(runtime, true)).state).toBe('ready')
    expect(runner.calls).toHaveLength(2)
    timestamp += 60_000
    await statusOf(runtime)
    expect(runner.calls).toHaveLength(3)
    runtime.dispose()
  })

  it('lets one caller cancel without cancelling the shared probe for others', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: CliCommandRequest[] = []
    const runner: CliRunner = {
      async run(probe): Promise<CliResult> {
        calls.push(probe)
        await gate
        return {
          exitCode: 0,
          stdout: 'gh version 2.40.1',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
        }
      },
      async runJson(): Promise<never> {
        throw new Error('the dependency probe must never parse JSON')
      },
    }
    const runtime = createDependenciesRuntime({
      home: HOME,
      platform: process.platform,
      arch: process.arch,
      env: ENV,
      runProcess: runner,
      probeCwd: HOME,
      pathExists: fakeExists([PATH_GH]),
    })
    runtime.register(definition())
    const controller = new AbortController()
    const first = runtime.inspect('github.gh', { signal: controller.signal })
    for (let attempt = 0; attempt < 100 && calls.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const second = runtime.inspect('github.gh')
    controller.abort()
    await expect(first).rejects.toMatchObject({ category: 'cancelled' })
    release()
    const [status] = await second
    expect(status).toMatchObject({ state: 'ready', resolvedFrom: 'path' })
    expect(calls).toHaveLength(1)
    runtime.dispose()
  })

  it('offers no automatic install on an unsupported platform but still reports a ready PATH copy', async () => {
    const runtime = createDependenciesRuntime({
      home: HOME,
      platform: process.platform,
      arch: process.arch,
      env: ENV,
      runProcess: fakeRunner(() => ({ stdout: 'gh version 2.40.1' })),
      probeCwd: HOME,
      pathExists: fakeExists([PATH_GH]),
    })
    runtime.register(definition({ supportedPlatforms: [{ platform: 'aix', arch: 'ppc64' }] }))
    const [status] = await runtime.inspect()
    expect(status).toMatchObject({ state: 'ready', supported: false, installable: false })
    runtime.dispose()
  })

  it('maps a probe timeout to a failed status without leaking output', async () => {
    const { runtime } = harness({
      paths: [PATH_GH],
      answer: () => new ClueError('timeout', 'the CLI operation timed out'),
    })
    const status = await statusOf(runtime)
    expect(status.state).toBe('failed')
    expect(status.error?.category).toBe('timeout')
    expect(JSON.stringify(status)).not.toContain('timed out')
  })
})

describe('install planning through the dependency runtime', () => {
  it('plans the fixed version, managed target and detects a system copy', async () => {
    const { runtime } = harness({ paths: [PATH_GH] })
    const plan = await runtime.plan('github.gh')
    expect(plan).toMatchObject({
      dependencyId: 'github.gh',
      version: '2.40.1',
      platform: process.platform,
      arch: process.arch,
      targetDir: managedTargetDir(HOME, 'github.gh', '2.40.1'),
      distribution: { kind: 'archive', source: 'GitHub releases' },
      systemInstall: { executablePath: PATH_GH, version: '2.40.1', compatible: true },
      installable: true,
    })
    expect(plan.actions.join('\n')).toContain('sha256')
    expect(plan.expiresAt > plan.createdAt).toBe(true)

    const stale = await runtime.plan('github.gh')
    void stale
    runtime.dispose()
  })

  it('marks installing unavailable when the profile home is unknown', async () => {
    const { runtime } = harness({ home: undefined, paths: [PATH_GH] })
    const plan = await runtime.plan('github.gh')
    expect(plan.installable).toBe(false)
    expect(plan.targetDir).toBe('')
    expect(plan.unavailableReason).toContain('profile home')
    await expect(runtime.start({ dependencyId: 'github.gh', planId: plan.planId })).rejects.toMatchObject({
      category: 'unsupported',
    })
    runtime.dispose()
  })

  it('rejects a stale plan instead of installing after its TTL', async () => {
    let timestamp = 1_000
    const { runtime } = harness({ paths: [], now: () => timestamp })
    const plan = await runtime.plan('github.gh')
    timestamp += 11 * 60 * 1000
    await expect(runtime.start({ dependencyId: 'github.gh', planId: plan.planId })).rejects.toMatchObject({
      category: 'conflict',
    })
    runtime.dispose()
  })

  it('notifies manual path persistence and clears the override', async () => {
    const saved: Array<Readonly<Record<string, string>>> = []
    const manual = IS_WIN ? 'C:\\Users\\me\\gh.exe' : '/Users/me/bin/gh'
    const runner = fakeRunner(() => ({ stdout: 'gh version 2.40.1' }))
    const runtime = createDependenciesRuntime({
      home: HOME,
      platform: process.platform,
      arch: process.arch,
      env: ENV,
      runProcess: runner,
      probeCwd: HOME,
      pathExists: fakeExists([manual, PATH_GH]),
      onManualPathsChanged: paths => saved.push(paths),
    })
    runtime.register(definition())
    const status = await runtime.setManualPath('github.gh', manual)
    expect(status.resolvedFrom).toBe('manual')
    expect(saved.at(-1)).toEqual({ 'github.gh': manual })
    const cleared = await runtime.clearManualPath('github.gh')
    expect(cleared.resolvedFrom).toBe('path')
    expect(saved.at(-1)).toEqual({})
    runtime.dispose()
  })

  it('rejects duplicate/invalid definitions and unregisters with a disposer', () => {
    const runtime = harness().runtime
    expect(() => runtime.register(definition())).toThrow(/already registered/)
    expect(() => runtime.register(definition({
      dependencyId: 'bad.version',
      version: { minimum: 'latest', recommended: 'latest' },
    }))).toThrow(/exact minimum\/recommended versions/)
    const dispose = runtime.register(definition({ dependencyId: 'lark.cli', command: 'lark-cli' }))
    expect(runtime.getDefinitions().map(entry => entry.dependencyId)).toContain('lark.cli')
    dispose()
    expect(runtime.getDefinitions().map(entry => entry.dependencyId)).not.toContain('lark.cli')
    runtime.dispose()
  })
})
