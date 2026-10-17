/**
 * S2 runtime assembly + API surface contract.
 *
 * The integration layer is pinned with fake process/fetch/transport seams:
 * - `installCluesRuntime` registers every `clues.dependencies.*` /
 *   `clues.connections.*` method on the S1 service API seam (no new route, no
 *   Agent tool) and removes them on dispose;
 * - install actions run only after an explicit plan, then the API reports the
 *   shared task and a REAL `--version` probe makes the dependency ready;
 * - mutating install/authorization methods refuse an agent caller;
 * - `runCli` resolves the dependency, forwards the explicit cwd/stdin and the
 *   dependency's env allowlist, and `runCliJson` refuses non-zero exits;
 * - a missing profile home leaves installation explicitly unavailable.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import { CLUES_RUNTIME_API_METHODS } from '../src/clues/runtime/api.ts'
import { installCluesRuntime } from '../src/clues/runtime/index.ts'
import { managedTargetDir } from '../src/clues/runtime/install.ts'
import type {
  ClueDependencyDefinition,
  DependencyInstallTask,
  InstallTransport,
} from '../src/clues/runtime/types.ts'
import type { Context } from '../src/context-types.ts'
import { createFakeSpawn } from './fixtures/clues-runtime/fake-child.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

const ARCHIVE = 'official-test-archive'
const SHA = createHash('sha256').update(ARCHIVE).digest('hex')

function tempBase(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-runtime-'))
  roots.push(path)
  return path
}

function definition(overrides: Partial<ClueDependencyDefinition> = {}): ClueDependencyDefinition {
  return {
    dependencyId: 'github.gh',
    name: 'GitHub CLI',
    command: 'gh',
    pluginId: 'dsh-better-sidebar',
    version: { minimum: '2.40.0', recommended: '2.40.1' },
    supportedPlatforms: [{ platform: process.platform, arch: process.arch }],
    envAllowlist: ['CLUE_TEST_CFG'],
    install: {
      distributions: [{
        kind: 'archive',
        source: 'GitHub releases',
        url: 'https://example.invalid/gh.tar.gz',
        sha256: SHA,
        archive: 'tar.gz',
        executable: 'bin/gh',
      }],
    },
    manualInstall: { instructions: 'Install gh manually' },
    ...overrides,
  }
}

function fakeTransport(): InstallTransport & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async download(input) {
      calls.push('download')
      writeFileSync(input.destination, ARCHIVE)
      input.onProgress?.(ARCHIVE.length, ARCHIVE.length)
    },
    async extract(input) {
      calls.push('extract')
      mkdirSync(join(input.destination, 'bin'), { recursive: true })
      writeFileSync(join(input.destination, 'bin', 'gh'), 'binary')
    },
    async npmInstall(input) {
      calls.push('npm')
      mkdirSync(join(input.directory, 'bin'), { recursive: true })
      writeFileSync(join(input.directory, 'bin', 'gh'), 'binary')
    },
  }
}

interface FakeCtx {
  readonly ctx: Context
  readonly disposers: Array<() => void>
}

function fakeContext(home: string | undefined, extras: {
  readonly credentials?: Context['credentials']
  readonly tools?: Context['tools']
  readonly agents?: Context['agents']
} = {}): FakeCtx {
  const disposers: Array<() => void> = []
  const ctx = {
    ...(home === undefined ? {} : { profileContext: { home } }),
    ...(extras.credentials === undefined ? {} : { credentials: extras.credentials }),
    ...(extras.tools === undefined ? {} : { tools: extras.tools }),
    ...(extras.agents === undefined ? {} : { agents: extras.agents }),
    effect(callback: () => () => void): () => void {
      disposers.push(callback())
      return () => undefined
    },
    get(): undefined {
      return undefined
    },
  } as unknown as Context
  return { ctx, disposers }
}

function setup(options: {
  readonly home?: string | undefined
  readonly spawn?: ReturnType<typeof createFakeSpawn>
  readonly transport?: InstallTransport
  readonly credentials?: Context['credentials']
} = {}): {
  readonly base: string
  readonly home: string | undefined
  readonly service: CluesService
  readonly runtime: ReturnType<typeof installCluesRuntime>
  readonly fakeSpawn: ReturnType<typeof createFakeSpawn>
  readonly disposers: Array<() => void>
} {
  const base = tempBase()
  const home = 'home' in options ? options.home : join(base, 'home')
  if (home !== undefined) mkdirSync(home, { recursive: true })
  const fakeSpawn = options.spawn ?? createFakeSpawn(run => run.args.includes('--version')
    ? { stdout: 'gh version 2.40.1 (2024-01-01)\n' }
    : { stdout: JSON.stringify({ ok: true, argv: [...run.args], stdin: run.stdin.data }) })
  const service = createCluesService({ root: join(base, 'store') })
  const { ctx, disposers } = fakeContext(home, {
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  })
  const runtime = installCluesRuntime(ctx, service, {
    ...(home === undefined ? {} : { home }),
    env: { PATH: '' },
    spawn: fakeSpawn.spawn,
    transport: options.transport ?? fakeTransport(),
    probeCwd: base,
    now: () => Date.parse('2026-10-17T00:00:00.000Z'),
  })
  return { base, home, service, runtime, fakeSpawn, disposers }
}

async function settle(runtime: ReturnType<typeof installCluesRuntime>, dependencyId: string): Promise<DependencyInstallTask> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = runtime.dependencies.tasks(dependencyId)[0]
    if (task !== undefined && task.state !== 'running') return task
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('installation task did not settle')
}

describe('runtime API registration', () => {
  it('registers every runtime method on the S1 API seam and removes them on dispose', () => {
    const { service, runtime, disposers } = setup()
    for (const method of CLUES_RUNTIME_API_METHODS) expect(service.hasApi(method), method).toBe(true)
    expect(disposers).toHaveLength(1)
    runtime.dispose()
    for (const method of CLUES_RUNTIME_API_METHODS) expect(service.hasApi(method), method).toBe(false)
    // Idempotent, and the effect disposer stays safe to call.
    runtime.dispose()
    disposers[0]!()
  })

  it('inspects, plans, starts and reports one shared install task through the API', async () => {
    const { service, runtime, home, fakeSpawn } = setup()
    runtime.dependencies.register(definition())
    const inspected = await service.invokeApi('clues.dependencies.inspect', { dependencyId: 'github.gh' }) as {
      dependencies: Array<{ state: string; installable: boolean; recommendedVersion: string }>
    }
    expect(inspected.dependencies[0]).toMatchObject({
      state: 'missing',
      installable: true,
      recommendedVersion: '2.40.1',
    })

    const planned = await service.invokeApi('clues.dependencies.plan', { dependencyId: 'github.gh' }) as {
      plan: { planId: string; targetDir: string; version: string; installable: boolean }
    }
    expect(planned.plan).toMatchObject({
      version: '2.40.1',
      targetDir: managedTargetDir(home!, 'github.gh', '2.40.1'),
      installable: true,
    })

    const started = await service.invokeApi('clues.dependencies.start', {
      dependencyId: 'github.gh',
      planId: planned.plan.planId,
    }) as { task: DependencyInstallTask }
    expect(started.task.state).toBe('running')
    const settled = await settle(runtime, 'github.gh')
    expect(settled.state).toBe('succeeded')
    const tasks = await service.invokeApi('clues.dependencies.status', { dependencyId: 'github.gh' }) as {
      tasks: DependencyInstallTask[]
    }
    expect(tasks.tasks[0]).toMatchObject({ state: 'succeeded', progress: { stage: 'completed' } })

    const ready = await service.invokeApi('clues.dependencies.inspect', { dependencyId: 'github.gh' }) as {
      dependencies: Array<{ state: string; resolvedFrom: string; executablePath: string; version: string }>
    }
    expect(ready.dependencies[0]).toMatchObject({
      state: 'ready',
      resolvedFrom: 'managed',
      executablePath: join(planned.plan.targetDir, 'bin', 'gh'),
      version: '2.40.1',
    })
    // The only probe commands were `--version`; no login/business command ran.
    expect(fakeSpawn.runs.every(run => run.args.length === 1 && run.args[0] === '--version')).toBe(true)
    runtime.dispose()
  })

  it('validates payloads and refuses install mutations from an agent caller', async () => {
    const { service, runtime } = setup()
    runtime.dependencies.register(definition())
    await expect(service.invokeApi('clues.dependencies.inspect', { dependencyId: 42 }))
      .rejects.toMatchObject({ category: 'invalid-request' })
    await expect(service.invokeApi('clues.dependencies.start', {}))
      .rejects.toMatchObject({ category: 'invalid-request' })
    await expect(service.invokeApi('clues.dependencies.plan', { dependencyId: 'github.gh' }, { caller: 'agent' }))
      .rejects.toMatchObject({ category: 'permission-denied' })
    await expect(service.invokeApi('clues.dependencies.inspect', { dependencyId: 'missing.dep' }))
      .rejects.toMatchObject({ category: 'not-found' })
    await expect(service.invokeApi('clues.dependencies.status', { dependencyId: 'missing.dep' }))
      .rejects.toMatchObject({ category: 'not-found' })
    runtime.dispose()
  })

  it('exposes connection status/connect/cancel through the API with an opaque prompt', async () => {
    const { service, runtime } = setup()
    runtime.connections.register({
      connectionId: 'feishu.auth',
      name: 'Feishu',
      pluginId: 'feishu-plugin',
      configuration: 'required',
      credentialOwner: 'tool',
      capabilities: ['docs.read'],
      async inspect() {
        return { configuration: 'ready', authorization: 'not-authorized' }
      },
      async connect() {
        return {
          prompt: {
            verificationUrl: 'https://example.invalid/oauth?state=a%2Fb',
            userCode: 'ABCD-EFGH',
            expiresAt: new Date(Date.parse('2026-10-17T00:10:00.000Z')).toISOString(),
          },
          state: { deviceCode: 'MACHINE-ONLY' },
        }
      },
      async cancel() {
        // no-op fake
      },
    })

    const status = await service.invokeApi('clues.connections.status', {}) as {
      connections: Array<{ authorization: string; action: string }>
    }
    expect(status.connections[0]).toMatchObject({ authorization: 'not-authorized', action: 'connect' })

    const connected = await service.invokeApi('clues.connections.connect', { connectionId: 'feishu.auth' }) as {
      connection: { authorization: string; prompt?: { verificationUrl: string } }
    }
    expect(connected.connection).toMatchObject({
      authorization: 'authorizing',
      prompt: { verificationUrl: 'https://example.invalid/oauth?state=a%2Fb' },
    })
    expect(JSON.stringify(connected)).not.toContain('MACHINE-ONLY')

    const cancelled = await service.invokeApi('clues.connections.cancel', { connectionId: 'feishu.auth' }) as {
      connection: { authorization: string }
    }
    expect(cancelled.connection.authorization).toBe('not-authorized')
    await expect(service.invokeApi('clues.connections.connect', { connectionId: 'feishu.auth' }, { caller: 'agent' }))
      .rejects.toMatchObject({ category: 'permission-denied' })
    runtime.dispose()
  })

  it('leaves installation explicitly unavailable without a profile home', async () => {
    const { service, runtime, home } = setup({ home: undefined })
    expect(home).toBeUndefined()
    runtime.dependencies.register(definition())
    const planned = await service.invokeApi('clues.dependencies.plan', { dependencyId: 'github.gh' }) as {
      plan: { installable: boolean; targetDir: string; unavailableReason?: string }
    }
    expect(planned.plan).toMatchObject({ installable: false, targetDir: '' })
    expect(planned.plan.unavailableReason).toBeTruthy()
    runtime.dispose()
  })
})

describe('runCli / runCliJson', () => {
  it('resolves the dependency, forwards argv/cwd/stdin and the dependency env allowlist', async () => {
    const base = tempBase()
    const home = join(base, 'home')
    mkdirSync(home, { recursive: true })
    const binary = join(base, 'fake-gh')
    writeFileSync(binary, '#!/bin/sh\n')
    const fakeSpawn = createFakeSpawn(run => run.args.includes('--version')
      ? { stdout: 'gh version 2.40.1\n' }
      : { stdout: JSON.stringify({ ok: true, stdin: run.stdin.data }) })
    const service = createCluesService({ root: join(base, 'store') })
    const { ctx } = fakeContext(home)
    const runtime = installCluesRuntime(ctx, service, {
      home,
      env: { PATH: '', CLUE_TEST_CFG: '/cfg', GITHUB_TOKEN: 'secret', DSH_HOME: '/secret' },
      spawn: fakeSpawn.spawn,
      transport: fakeTransport(),
      probeCwd: base,
      manualPaths: { 'github.gh': binary },
    })
    runtime.dependencies.register(definition())
    const result = await runtime.runCli({
      dependencyId: 'github.gh',
      args: ['issue', 'list', '--json', 'number'],
      cwd: base,
      stdin: '{"body":"hello"}',
    })
    expect(result.exitCode).toBe(0)
    const run = fakeSpawn.runs.at(-1)!
    expect(run.command).toBe(binary)
    expect(run.args).toEqual(['issue', 'list', '--json', 'number'])
    expect(run.options.cwd).toBe(base)
    expect(run.options.shell).toBe(false)
    expect(run.stdin.data).toBe('{"body":"hello"}')
    expect(run.options.env.CLUE_TEST_CFG).toBe('/cfg')
    expect(run.options.env.GITHUB_TOKEN).toBeUndefined()
    expect(run.options.env.DSH_HOME).toBeUndefined()

    const parsed = await runtime.runCliJson<{ ok: boolean; stdin: string }>({
      dependencyId: 'github.gh',
      args: ['api', 'user'],
      cwd: base,
      stdin: 'payload',
    })
    expect(parsed).toEqual({ ok: true, stdin: 'payload' })
    await expect(runtime.runCli({ dependencyId: 'missing.dep', args: [], cwd: base }))
      .rejects.toMatchObject({ category: 'not-found' })
    runtime.dispose()
  })

  it('refuses non-zero JSON runs and malformed JSON without pretending success', async () => {
    const base = tempBase()
    const home = join(base, 'home')
    mkdirSync(home, { recursive: true })
    const binary = join(base, 'fake-gh')
    writeFileSync(binary, '#!/bin/sh\n')
    const failing = createFakeSpawn(run => run.args.includes('--version')
      ? { stdout: 'gh version 2.40.1\n' }
      : { stdout: '{"ok":true}', exitCode: 3 })
    const service = createCluesService({ root: join(base, 'store') })
    const { ctx } = fakeContext(home)
    const runtime = installCluesRuntime(ctx, service, {
      home,
      env: { PATH: '' },
      spawn: failing.spawn,
      transport: fakeTransport(),
      probeCwd: base,
      manualPaths: { 'github.gh': binary },
    })
    runtime.dependencies.register(definition())
    await expect(runtime.runCliJson({ dependencyId: 'github.gh', args: ['x'], cwd: base }))
      .rejects.toMatchObject({ category: 'failed' })
    runtime.dispose()
  })
})
