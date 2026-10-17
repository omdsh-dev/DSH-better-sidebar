/**
 * S3 dependency and account-connection contract (fake runtime; no real gh,
 * account, keyring or network).
 *
 * Pins the approved S3/S2 integration:
 * - one `github.gh` dependency pinned to the executed version (2.102.0), a
 *   verified platform matrix with official checksums and manual guidance for
 *   everything else — nothing invented;
 * - one shared `github.gh.auth` connection with gh-owned credentials and no
 *   token projection;
 * - `inspect`/`auth status` runs ONLY for an explicit status/connect/poll;
 *   registering sources, listing or reading never probes auth;
 * - `connect` is the only path that starts `gh auth login --web`, returns the
 *   fixed human prompt (official URL, expiry, poll hint) and never leaks the
 *   process handle or stdout;
 * - a completed login polls into `ready`, cancellation is reachable and
 *   disposal aborts every in-flight login.
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import {
  createConnectionsRuntime,
  createDependenciesRuntime,
  type CliCommandRequest,
  type CliResult,
  type CliRunner,
  type CliRunRequest,
  type ClueRuntime,
} from '../src/clues/runtime/index.ts'
import { createGithubSources } from '../src/clues/sources/github/index.ts'
import {
  GITHUB_CONNECTION_ID,
  GITHUB_DEPENDENCY_ID,
  GITHUB_DEVICE_URL,
} from '../src/clues/sources/github/ids.ts'
import { projectLoginPrompt } from '../src/clues/sources/github/connection.ts'
import { removeTree } from './temp-tree.ts'

const NOW_MS = Date.parse('2026-10-17T00:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-github-conn-'))
  roots.push(path)
  return path
}

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/clues-github/${name}`, import.meta.url), 'utf8')
}

function cliResult(overrides: Partial<CliResult> = {}): CliResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  }
}

interface FakeRuntime {
  readonly runtime: ClueRuntime
  readonly runs: CliRunRequest[]
}

function fakeRuntime(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): FakeRuntime {
  const runs: CliRunRequest[] = []
  const unused = async (): Promise<never> => { throw new Error('not used') }
  const runtime = {
    dependencies: {
      register: () => () => undefined,
      getDefinition: () => undefined,
      getDefinitions: () => [],
      inspect: unused,
      resolve: unused,
      plan: unused,
      start: unused,
      tasks: () => [],
      cancel: unused,
      setManualPath: unused,
      clearManualPath: unused,
      invalidate: () => undefined,
      dispose: () => undefined,
    },
    connections: {
      register: () => () => undefined,
      getDefinition: () => undefined,
      getDefinitions: () => [],
      status: unused,
      connect: unused,
      poll: unused,
      cancel: unused,
      report: () => undefined,
      dispose: () => undefined,
    },
    http: { request: unused },
    mcp: { callTool: unused },
    runCli: async (request: CliRunRequest): Promise<CliResult> => {
      runs.push(request)
      return await handler(request)
    },
    runCliJson: unused,
    dispose: () => undefined,
  } as unknown as ClueRuntime
  return { runtime, runs }
}

function isAuthStatus(request: CliRunRequest): boolean {
  return request.args[0] === 'auth' && request.args[1] === 'status'
}

function isLogin(request: CliRunRequest): boolean {
  return request.args[0] === 'auth' && request.args[1] === 'login'
}

describe('github.gh dependency definition', () => {
  it('pins the executed version and lists only verified official assets', () => {
    const fake = fakeRuntime(() => cliResult())
    const install = createGithubSources({ runtime: () => fake.runtime, now: () => NOW_MS })
    const dependency = install.dependency
    expect(dependency.dependencyId).toBe(GITHUB_DEPENDENCY_ID)
    expect(dependency.command).toBe('gh')
    expect(dependency.pluginId).toBe('dsh-better-sidebar')
    expect(dependency.version).toEqual({ minimum: '2.40.0', recommended: '2.102.0' })
    expect(install.dependencyIds).toEqual([GITHUB_DEPENDENCY_ID])
    expect(install.connectionId).toBe(GITHUB_CONNECTION_ID)
    expect(dependency.manualInstall?.url).toBe('https://github.com/cli/cli/releases/tag/v2.102.0')

    const targets = dependency.supportedPlatforms
    expect(targets).toEqual([
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'darwin', arch: 'amd64' },
      { platform: 'linux', arch: 'amd64' },
      { platform: 'linux', arch: 'arm64' },
      { platform: 'win32', arch: 'amd64' },
    ])
    const distributions = dependency.install?.distributions ?? []
    expect(distributions).toHaveLength(targets.length)
    for (const [index, distribution] of distributions.entries()) {
      expect(distribution.kind).toBe('archive')
      expect(distribution.url?.startsWith('https://github.com/cli/cli/releases/download/v2.102.0/')).toBe(true)
      expect(distribution.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(distribution.platforms).toEqual([targets[index]])
      expect(distribution.executable).toBe(targets[index]?.platform === 'win32' ? 'bin/gh.exe' : 'bin/gh')
      expect(distribution.stripComponents).toBe(targets[index]?.platform === 'win32' ? 0 : 1)
    }
    // Building the sources must not probe, log in or install anything.
    expect(fake.runs).toHaveLength(0)
  })

  it('resolves and plans a verified target through the real S2 dependency runtime', async () => {
    const home = tempRoot()
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const executable = join(bin, 'gh')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    const probes: CliCommandRequest[] = []
    const runner: CliRunner = {
      async run(request) {
        probes.push(request)
        return cliResult({ stdout: 'gh version 2.102.0 (2026-09-30)\nhttps://github.com/cli/cli/releases/tag/v2.102.0\n' })
      },
      async runJson() { throw new Error('not used') },
    }
    const dependencies = createDependenciesRuntime({
      home,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/nonexistent' },
      runProcess: runner,
      manualPaths: { [GITHUB_DEPENDENCY_ID]: executable },
      now: () => NOW_MS,
    })
    const install = createGithubSources({ runtime: () => fakeRuntime(() => cliResult()).runtime, now: () => NOW_MS })
    const dispose = dependencies.register(install.dependency)
    const [status] = await dependencies.inspect(GITHUB_DEPENDENCY_ID)
    expect(status).toMatchObject({
      dependencyId: GITHUB_DEPENDENCY_ID,
      state: 'ready',
      version: '2.102.0',
      supported: true,
      installable: true,
      resolvedFrom: 'manual',
      executablePath: executable,
    })
    expect(probes[0]?.args).toEqual(['--version'])
    expect(probes[0]?.command).toBe(executable)

    const plan = await dependencies.plan(GITHUB_DEPENDENCY_ID)
    expect(plan.installable).toBe(true)
    expect(plan.version).toBe('2.102.0')
    expect(plan.distribution).toMatchObject({
      kind: 'archive',
      source: 'GitHub releases',
      sha256: 'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e',
    })
    expect(plan.executablePath).toBe(join(home, 'tools', GITHUB_DEPENDENCY_ID, '2.102.0', 'bin', 'gh'))
    expect(plan.actionIds).toContain('verify-sha256')
    dispose()
  })

  it('reports an older gh as incompatible and a non-matrix host as manual-only', async () => {
    const home = tempRoot()
    const executable = join(home, 'gh')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    const oldRunner: CliRunner = {
      async run() { return cliResult({ stdout: 'gh version 2.30.0 (2024-01-01)' }) },
      async runJson() { throw new Error('not used') },
    }
    const oldDeps = createDependenciesRuntime({
      home,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/nonexistent' },
      runProcess: oldRunner,
      manualPaths: { [GITHUB_DEPENDENCY_ID]: executable },
      now: () => NOW_MS,
    })
    const install = createGithubSources({ runtime: () => fakeRuntime(() => cliResult()).runtime, now: () => NOW_MS })
    oldDeps.register(install.dependency)
    const [old] = await oldDeps.inspect(GITHUB_DEPENDENCY_ID)
    expect(old).toMatchObject({ state: 'incompatible', version: '2.30.0', supported: true })

    const otherRunner: CliRunner = {
      async run() { return cliResult({ stdout: 'gh version 2.102.0' }) },
      async runJson() { throw new Error('not used') },
    }
    const otherDeps = createDependenciesRuntime({
      home,
      platform: 'aix',
      arch: 'ppc64',
      env: { PATH: '/nonexistent' },
      runProcess: otherRunner,
      manualPaths: { [GITHUB_DEPENDENCY_ID]: executable },
      now: () => NOW_MS,
    })
    otherDeps.register(install.dependency)
    const other = (await otherDeps.inspect(GITHUB_DEPENDENCY_ID))[0]!
    expect(other).toMatchObject({ supported: false, installable: false, state: 'ready' })
    expect(other.manualInstall?.url).toContain('github.com/cli/cli/releases')
  })
})

describe('github.gh.auth connection', () => {
  /** A real S2 connection runtime with the S3 definition registered. */
  function connectionSetup(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>) {
    const fake = fakeRuntime(handler)
    const install = createGithubSources({
      runtime: () => fake.runtime,
      now: () => NOW_MS,
      cwd: '/tmp/clues-github-connection',
    })
    const connections = createConnectionsRuntime({ now: () => NOW_MS, newId: () => 'auth-attempt-1' })
    const dispose = connections.register(install.connection)
    return { fake, install, connections, dispose }
  }

  it('shares gh-owned credentials and projects the account + capabilities only', async () => {
    const { fake, connections } = connectionSetup(() => cliResult({ stdout: fixture('auth-status.json') }))
    expect(connections.getDefinition(GITHUB_CONNECTION_ID)).toMatchObject({
      connectionId: GITHUB_CONNECTION_ID,
      configuration: 'not-required',
      credentialOwner: 'tool',
    })
    const [row] = await connections.status(GITHUB_CONNECTION_ID)
    expect(row).toMatchObject({
      connectionId: GITHUB_CONNECTION_ID,
      configuration: 'not-required',
      authorization: 'ready',
      credentialOwner: 'tool',
      account: 'octocat',
      action: 'none',
    })
    expect(row?.capabilities).toEqual(expect.arrayContaining(['issues.read', 'issues.write', 'pulls.read', 'pulls.write']))
    expect(row?.lastCheckedAt).toBeDefined()
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain('gho_')
    expect(serialized).not.toContain('AB12-CD34')
    // Explicit status is the ONLY thing that ran: exactly one auth status.
    expect(fake.runs).toHaveLength(1)
    expect(isAuthStatus(fake.runs[0]!)).toBe(true)
    expect(fake.runs[0]!.args).toEqual(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'])
  })

  it('answers not-authorized / expired without throwing and never probes on registration', async () => {
    const anonymous = fakeRuntime(() => cliResult({ stdout: '{"hosts":{}}' }))
    const install = createGithubSources({ runtime: () => anonymous.runtime, now: () => NOW_MS })
    const connections = createConnectionsRuntime({ now: () => NOW_MS })
    connections.register(install.connection)
    expect(anonymous.runs).toHaveLength(0)
    const [row] = await connections.status(GITHUB_CONNECTION_ID)
    expect(row).toMatchObject({ authorization: 'not-authorized', action: 'connect' })

    const { connections: expiredConnections } = connectionSetup(() => cliResult({
      exitCode: 1,
      stdout: '{"message":"Bad credentials","status":"401"}',
      stderr: 'gh: Bad credentials (HTTP 401)',
    }))
    const [expired] = await expiredConnections.status(GITHUB_CONNECTION_ID)
    expect(expired).toMatchObject({ authorization: 'expired', action: 'reconnect' })
    expect(JSON.stringify(expired)).not.toContain('Bad credentials')

    const missing = fakeRuntime(() => {
      throw new ClueError('dependency-missing', 'the GitHub CLI is not installed')
    })
    const missingInstall = createGithubSources({ runtime: () => missing.runtime, now: () => NOW_MS })
    const missingConnections = createConnectionsRuntime({ now: () => NOW_MS })
    missingConnections.register(missingInstall.connection)
    const [broken] = await missingConnections.status(GITHUB_CONNECTION_ID)
    expect(broken?.error?.category).toBe('dependency-missing')
    // S2 projects the dependency layer's own fixed message; the adapter never
    // appends CLI output to it.
    expect(broken?.error?.message).toBe('the GitHub CLI is not installed')
  })

  it('starts gh auth login only from an explicit connect and completes through a poll', async () => {
    let loginStarted = false
    const { fake, install, connections } = connectionSetup((request) => {
      if (isLogin(request)) {
        loginStarted = true
        return cliResult({ stdout: fixture('login-output.txt') })
      }
      return cliResult({ stdout: loginStarted ? fixture('auth-status.json') : '{"hosts":{}}' })
    })
    void install
    expect(fake.runs).toHaveLength(0)

    const started = await connections.connect(GITHUB_CONNECTION_ID)
    expect(started.authorization).toBe('authorizing')
    expect(started.prompt?.verificationUrl).toBe(GITHUB_DEVICE_URL)
    expect(started.prompt?.expiresAt).toBe(new Date(NOW_MS + 10 * 60 * 1000).toISOString())
    expect(started.prompt?.pollAfterMs).toBe(5_000)
    expect(started.prompt?.instructions).toContain('clipboard')
    // The prompt is a fixed whitelist: no attempt handle, token or process.
    for (const key of Object.keys(started.prompt ?? {})) {
      expect(['verificationUrl', 'userCode', 'expiresAt', 'pollAfterMs', 'instructions', 'qr']).toContain(key)
    }
    expect(JSON.stringify(started)).not.toContain('token')

    // The login argv is explicit and non-shell.
    const login = fake.runs.find(isLogin)!
    expect(login.args).toEqual([
      'auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--clipboard',
    ])
    expect(login.cwd).toBe('/tmp/clues-github-connection')
    // A second click while the attempt is active shares it: one login only.
    await connections.connect(GITHUB_CONNECTION_ID)
    expect(fake.runs.filter(isLogin)).toHaveLength(1)

    const done = await connections.poll(GITHUB_CONNECTION_ID)
    expect(done).toMatchObject({ authorization: 'ready', account: 'octocat', action: 'none' })
  })

  it('does not start a device flow when the account is already signed in', async () => {
    const { fake, connections } = connectionSetup(() => cliResult({ stdout: fixture('auth-status.json') }))
    const projection = await connections.connect(GITHUB_CONNECTION_ID)
    expect(projection).toMatchObject({ authorization: 'ready', account: 'octocat' })
    expect(fake.runs.filter(isLogin)).toHaveLength(0)
  })

  it('cancels an in-flight login and aborts its child', async () => {
    let loginRequest: CliRunRequest | undefined
    const { connections } = connectionSetup(async (request) => {
      if (isLogin(request)) {
        loginRequest = request
        return await new Promise<CliResult>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new ClueError('cancelled', 'the CLI operation was cancelled'))
          }, { once: true })
        })
      }
      return cliResult({ stdout: '{"hosts":{}}' })
    })
    const started = await connections.connect(GITHUB_CONNECTION_ID)
    expect(started.authorization).toBe('authorizing')
    const cancelled = await connections.cancel(GITHUB_CONNECTION_ID)
    expect(cancelled.authorization).toBe('not-authorized')
    expect(loginRequest?.signal?.aborted).toBe(true)
  })

  it('aborts every in-flight login when the install is disposed', async () => {
    let loginRequest: CliRunRequest | undefined
    const { install, connections } = connectionSetup(async (request) => {
      if (isLogin(request)) {
        loginRequest = request
        return await new Promise<CliResult>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new ClueError('cancelled', 'the CLI operation was cancelled'))
          }, { once: true })
        })
      }
      return cliResult({ stdout: '{"hosts":{}}' })
    })
    await connections.connect(GITHUB_CONNECTION_ID)
    install.dispose()
    install.dispose()
    expect(loginRequest?.signal?.aborted).toBe(true)
  })

  it('projects a login output through a fixed whitelist (URL + one-time code only)', () => {
    const prompt = projectLoginPrompt(fixture('login-output.txt'), { now: () => NOW_MS })
    expect(prompt).toMatchObject({
      verificationUrl: 'https://github.com/login/device',
      userCode: 'AB12-CD34',
      expiresAt: new Date(NOW_MS + 10 * 60 * 1000).toISOString(),
      pollAfterMs: 5_000,
    })
    const hostile = projectLoginPrompt(
      'token: gho_supersecret\n! One-time code (ZZ99-ZZ99) copied to clipboard\n'
      + 'Open this URL to continue in your web browser: https://github.com/login/device\n',
      { now: () => NOW_MS },
    )
    expect(hostile?.userCode).toBe('ZZ99-ZZ99')
    expect(JSON.stringify(hostile)).not.toContain('gho_supersecret')
    expect(projectLoginPrompt('nothing to project here')).toBeUndefined()
  })
})
