/**
 * S2 install pipeline contract (fake transport; NO network, NO system tool).
 *
 * Pins the approved §6 rules:
 * - a plan is explicit and pinned (fixed version/platform/target/actions) and
 *   expires; start refuses a stale plan;
 * - downloads go to a staging directory under the profile home, the sha256 is
 *   verified, the payload is confined, and only then is the target replaced;
 * - one in-flight task per dependency (multiple views share it), cancellation
 *   propagates to the transport, and failure/cancel PRESERVES the old copy;
 * - the post-swap `--version` probe decides success; a rejected probe rolls
 *   back to the previous copy;
 * - npm installs are local to the managed directory only (never `-g`);
 * - no PATH/system directory is written and no auth/business command runs.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveExtractCommand,
  createInstallManager,
  managedTargetDir,
  npmInstallArgs,
  type InstallManager,
} from '../src/clues/runtime/install.ts'
import type {
  ClueDependencyDefinition,
  DependencyInstallTask,
  InstallExtractInput,
  InstallNpmInput,
  InstallTransport,
} from '../src/clues/runtime/types.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-install-'))
  roots.push(path)
  return path
}

const ARCHIVE_CONTENT = 'official-archive-bytes'
const SHA = createHash('sha256').update(ARCHIVE_CONTENT).digest('hex')
const EXE = 'bin/gh'

function definition(overrides: Partial<ClueDependencyDefinition> = {}): ClueDependencyDefinition {
  return {
    dependencyId: 'github.gh',
    name: 'GitHub CLI',
    command: 'gh',
    pluginId: 'dsh-better-sidebar',
    version: { minimum: '2.40.0', recommended: '2.40.1' },
    supportedPlatforms: [{ platform: process.platform, arch: process.arch }],
    install: {
      distributions: [{
        kind: 'archive',
        source: 'GitHub releases',
        url: 'https://example.invalid/gh.tar.gz',
        sha256: SHA,
        archive: 'tar.gz',
        executable: EXE,
      }],
    },
    manualInstall: { instructions: 'Install gh manually', url: 'https://cli.github.com' },
    ...overrides,
  }
}

interface TransportLog {
  readonly calls: string[]
  readonly downloadDestinations: string[]
  readonly extractInputs: InstallExtractInput[]
  readonly npmInputs: InstallNpmInput[]
}

function fakeTransport(options: {
  readonly content?: string
  readonly gate?: Promise<void>
  readonly waitForAbort?: boolean
  readonly onExtract?: (input: InstallExtractInput) => Promise<void>
} = {}): InstallTransport & { readonly log: TransportLog } {
  const log: TransportLog = { calls: [], downloadDestinations: [], extractInputs: [], npmInputs: [] }
  return {
    log,
    async download(input): Promise<void> {
      log.calls.push('download')
      log.downloadDestinations.push(input.destination)
      if (options.gate !== undefined) await options.gate
      if (options.waitForAbort === true) {
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (input.signal?.aborted === true) fail()
          else input.signal?.addEventListener('abort', fail, { once: true })
        })
      }
      writeFileSync(input.destination, options.content ?? ARCHIVE_CONTENT)
      input.onProgress?.((options.content ?? ARCHIVE_CONTENT).length, (options.content ?? ARCHIVE_CONTENT).length)
    },
    async extract(input): Promise<void> {
      log.calls.push('extract')
      log.extractInputs.push({ ...input })
      if (options.onExtract !== undefined) {
        await options.onExtract(input)
        return
      }
      mkdirSync(join(input.destination, 'bin'), { recursive: true })
      writeFileSync(join(input.destination, EXE), 'installed-binary')
    },
    async npmInstall(input): Promise<void> {
      log.calls.push('npm')
      log.npmInputs.push({ ...input })
      mkdirSync(join(input.directory, 'bin'), { recursive: true })
      writeFileSync(join(input.directory, EXE), 'npm-installed-binary')
    },
  }
}

interface ManagerHarness {
  readonly manager: InstallManager
  readonly home: string
  readonly probes: string[]
  readonly plan: Awaited<ReturnType<InstallManager['plan']>>
}

async function setup(options: {
  readonly transport?: InstallTransport
  readonly probe?: (path: string) => Promise<{ compatible: boolean; version?: string }>
  readonly now?: () => number
  readonly planTtlMs?: number
  readonly definition?: ClueDependencyDefinition
  readonly home?: string | undefined
} = {}): Promise<ManagerHarness> {
  const home = 'home' in options ? (options.home as string) : tempHome()
  const probes: string[] = []
  const manager = createInstallManager({
    home,
    platform: process.platform,
    arch: process.arch,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    probeExecutable: async path => {
      probes.push(path)
      if (options.probe !== undefined) return await options.probe(path)
      return { compatible: true, version: '2.40.1' }
    },
    detectSystemInstall: async () => undefined,
  })
  const plan = await manager.plan(options.definition ?? definition())
  return { manager, home, probes, plan }
}

/** Wait for the background worker to settle (tasks are deliberately non-blocking). */
async function settle(manager: InstallManager, dependencyId: string): Promise<DependencyInstallTask> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = manager.latest(dependencyId)
    if (task !== undefined && task.state !== 'running') return task
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('installation task did not settle')
}

describe('install plan', () => {
  it('describes the fixed version, target, actions and system-install row without touching disk', async () => {
    const home = tempHome()
    const transport = fakeTransport()
    const { manager, plan } = await setup({ home, transport })
    expect(plan).toMatchObject({
      dependencyId: 'github.gh',
      version: '2.40.1',
      platform: process.platform,
      arch: process.arch,
      targetDir: managedTargetDir(home, 'github.gh', '2.40.1'),
      distribution: {
        kind: 'archive',
        source: 'GitHub releases',
        url: 'https://example.invalid/gh.tar.gz',
        sha256: SHA,
        archive: 'tar.gz',
      },
      installable: true,
    })
    expect(plan.actions.join('\n')).toMatch(/sha256/)
    expect(plan.actions.join('\n')).toMatch(/atomically replace/)
    expect(existsSync(join(home, 'tools'))).toBe(false)
    expect(transport.log.calls).toEqual([])
    manager.dispose()
  })

  it('keeps a plan bound to the version and refuses a stale plan', async () => {
    let timestamp = 1_000
    const { manager, plan } = await setup({ now: () => timestamp, planTtlMs: 1_000 })
    timestamp += 5_000
    await expect(manager.start(definition(), plan.planId)).rejects.toMatchObject({ category: 'conflict' })
    expect(manager.latest('github.gh')).toBeUndefined()
    manager.dispose()
  })

  it('refuses installation when the profile home is unknown', async () => {
    const { manager, plan } = await setup({ home: undefined })
    expect(plan.installable).toBe(false)
    expect(plan.targetDir).toBe('')
    await expect(manager.start(definition(), plan.planId)).rejects.toMatchObject({ category: 'unsupported' })
    manager.dispose()
  })

  it('refuses an npm distribution whose package version is not the pinned recommendation', async () => {
    const npmDefinition = definition({
      install: {
        distributions: [{
          kind: 'npm',
          source: 'npm',
          packageName: 'lark-cli',
          packageVersion: '1.0.0',
          executable: EXE,
        }],
      },
    })
    const { manager, plan } = await setup({ definition: npmDefinition })
    expect(plan.installable).toBe(false)
    expect(plan.unavailableReason).toMatch(/exact version/)
    await expect(manager.start(npmDefinition, plan.planId)).rejects.toMatchObject({ category: 'unsupported' })
    manager.dispose()
  })
})

describe('install execution', () => {
  it('downloads into staging, verifies sha256, extracts and atomically installs the managed copy', async () => {
    const home = tempHome()
    const transport = fakeTransport()
    const { manager, plan, probes } = await setup({ home, transport })
    const started = await manager.start(definition(), plan.planId)
    expect(started.state).toBe('running')
    const task = await settle(manager, 'github.gh')
    expect(task.state).toBe('succeeded')
    expect(task.progress?.stage).toBe('completed')
    expect(transport.log.calls).toEqual(['download', 'extract'])
    // The transport only ever saw a staging destination under the profile home.
    expect(transport.log.downloadDestinations[0]).toContain(join(home, 'tools', 'github.gh', '.staging-'))
    expect(transport.log.extractInputs[0]?.destination).toContain(join(home, 'tools', 'github.gh', '.staging-'))
    // The managed copy exists and contains the extracted executable.
    expect(readFileSync(join(plan.targetDir, EXE), 'utf8')).toBe('installed-binary')
    expect(probes).toEqual([join(plan.targetDir, EXE)])
    // Only the version directory remains (staging was cleaned up).
    expect(readdirSync(join(home, 'tools', 'github.gh'))).toEqual(['2.40.1'])
    manager.dispose()
  })

  it('rejects a corrupted archive and keeps the previous working copy', async () => {
    const home = tempHome()
    const transport = fakeTransport({ content: 'tampered-bytes' })
    const { manager, plan } = await setup({ home, transport })
    const oldDir = plan.targetDir
    mkdirSync(join(oldDir, 'bin'), { recursive: true })
    writeFileSync(join(oldDir, EXE), 'old-working-binary')
    const task = await (async () => {
      await manager.start(definition(), plan.planId)
      return await settle(manager, 'github.gh')
    })()
    expect(task.state).toBe('failed')
    expect(task.error?.message).toMatch(/sha256/)
    expect(task.preservedPrevious).toBe(true)
    expect(readFileSync(join(oldDir, EXE), 'utf8')).toBe('old-working-binary')
    expect(transport.log.calls).toEqual(['download'])
    expect(readdirSync(join(home, 'tools', 'github.gh'))).toEqual(['2.40.1'])
    manager.dispose()
  })

  it('rolls back when the post-swap version probe rejects the new copy', async () => {
    const home = tempHome()
    const transport = fakeTransport()
    const oldDir = managedTargetDir(home, 'github.gh', '2.40.1')
    mkdirSync(join(oldDir, 'bin'), { recursive: true })
    writeFileSync(join(oldDir, EXE), 'old-working-binary')
    const { manager, plan } = await setup({
      home,
      transport,
      probe: async () => ({
        compatible: false,
      }),
    })
    await manager.start(definition(), plan.planId)
    const task = await settle(manager, 'github.gh')
    expect(task.state).toBe('failed')
    expect(task.error?.category).toBe('dependency-incompatible')
    expect(task.preservedPrevious).toBe(true)
    expect(readFileSync(join(oldDir, EXE), 'utf8')).toBe('old-working-binary')
    expect(readdirSync(join(home, 'tools', 'github.gh'))).toEqual(['2.40.1'])
    manager.dispose()
  })

  it('shares one in-flight task between repeated clicks and views', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const transport = fakeTransport({ gate })
    const { manager, plan } = await setup({ transport })
    const first = await manager.start(definition(), plan.planId)
    for (let attempt = 0; attempt < 100 && transport.log.calls.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const second = await manager.start(definition(), plan.planId)
    expect(second.taskId).toBe(first.taskId)
    release()
    const task = await settle(manager, 'github.gh')
    expect(task.state).toBe('succeeded')
    expect(transport.log.calls).toEqual(['download', 'extract'])
    manager.dispose()
  })

  it('cancels the transport, settles as cancelled and keeps the old copy', async () => {
    const home = tempHome()
    const transport = fakeTransport({ waitForAbort: true })
    const { manager, plan } = await setup({ home, transport })
    mkdirSync(join(plan.targetDir, 'bin'), { recursive: true })
    writeFileSync(join(plan.targetDir, EXE), 'old-working-binary')
    await manager.start(definition(), plan.planId)
    // Let the worker reach the transport before cancelling.
    for (let attempt = 0; attempt < 100 && transport.log.calls.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const cancelled = await manager.cancel('github.gh')
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.preservedPrevious).toBe(true)
    expect(readFileSync(join(plan.targetDir, EXE), 'utf8')).toBe('old-working-binary')
    expect(readdirSync(join(home, 'tools', 'github.gh'))).toEqual(['2.40.1'])
    manager.dispose()
  })

  it('installs npm packages locally (no -g, no lifecycle scripts) inside the managed staging dir', async () => {
    const transport = fakeTransport()
    const npmDefinition = definition({
      install: {
        distributions: [{
          kind: 'npm',
          source: 'npm',
          packageName: 'lark-cli',
          packageVersion: '2.40.1',
          executable: EXE,
        }],
      },
    })
    const { manager, plan } = await setup({ transport, definition: npmDefinition })
    await manager.start(npmDefinition, plan.planId)
    const task = await settle(manager, 'github.gh')
    expect(task.state).toBe('succeeded')
    expect(transport.log.calls).toEqual(['npm'])
    const input = transport.log.npmInputs[0]!
    expect(input.packageName).toBe('lark-cli')
    expect(input.packageVersion).toBe('2.40.1')
    expect(input.directory).toContain('.staging-')
    manager.dispose()
  })
})

describe('default transport argv', () => {
  it('never performs a global npm install and always targets the managed directory', () => {
    const args = npmInstallArgs('lark-cli', '1.2.3', '/managed/dir')
    expect(args).toContain('--prefix')
    expect(args).toContain('/managed/dir')
    expect(args).toContain('--ignore-scripts')
    expect(args).toContain('lark-cli@1.2.3')
    expect(args).not.toContain('-g')
    expect(args).not.toContain('--global')
  })

  it('builds confined extraction argv with the host platform tool', () => {
    expect(archiveExtractCommand('linux', 'tar.gz', '/a.tar.gz', '/dest', 1)).toEqual({
      command: 'tar',
      args: ['-xzf', '/a.tar.gz', '-C', '/dest', '--strip-components=1'],
    })
    expect(archiveExtractCommand('darwin', 'zip', '/a.zip', '/dest', 0)).toEqual({
      command: 'tar',
      args: ['-xf', '/a.zip', '-C', '/dest'],
    })
    expect(archiveExtractCommand('linux', 'zip', '/a.zip', '/dest', 0)).toEqual({
      command: 'unzip',
      args: ['-q', '/a.zip', '-d', '/dest'],
    })
    expect(archiveExtractCommand('linux', 'zip', '/a.zip', '/dest', 1)).toBeUndefined()
  })
})

describe('cancellation edge cases', () => {
  it('fails the task without throwing when the caller signal is already aborted', async () => {
    const { manager, plan } = await setup()
    const controller = new AbortController()
    controller.abort()
    await manager.start(definition(), plan.planId, controller.signal)
    const task = await settle(manager, 'github.gh')
    expect(task.state).toBe('cancelled')
    manager.dispose()
  })

  it('implements the fixed clue error categories for unknown tasks', async () => {
    const { manager } = await setup()
    await expect(manager.cancel('github.gh')).rejects.toMatchObject({ category: 'not-found' })
    manager.dispose()
  })
})
