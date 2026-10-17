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
import { join, win32 } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveExtractCommand,
  createInstallManager,
  createNodeInstallTransport,
  managedTargetDir,
  npmInstallArgs,
  npmLaunch,
  unsafeArchiveName,
  validateArchiveEntries,
  type InstallManager,
} from '../src/clues/runtime/install.ts'
import type {
  CliCommandRequest,
  CliResult,
  CliRunner,
  ClueDependencyDefinition,
  ClueFetch,
  DependencyInstallTask,
  InstallExtractInput,
  InstallNpmInput,
  InstallTransport,
} from '../src/clues/runtime/types.ts'
import { createCliRunner, createNodeSpawn } from '../src/clues/runtime/cli.ts'
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
  readonly probe?: (path: string, signal?: AbortSignal) => Promise<{ compatible: boolean; version?: string }>
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
    probeExecutable: async (path, _definition, signal) => {
      probes.push(path)
      if (options.probe !== undefined) return await options.probe(path, signal)
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
    expect(plan.actionIds).toEqual([
      'download-archive', 'verify-sha256', 'extract-archive', 'probe-version', 'replace-managed-copy',
    ])
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

  it('binds start to the confirmed distribution, not a re-registered definition', async () => {
    const { manager, plan } = await setup()
    const original = definition().install!.distributions[0]!
    const changed = definition({
      install: {
        distributions: [{
          ...original,
          url: 'https://example.invalid/gh-other.tar.gz',
          sha256: 'b'.repeat(64),
        }],
      },
    })
    await expect(manager.start(changed, plan.planId)).rejects.toMatchObject({
      category: 'conflict',
      message: expect.stringMatching(/distribution changed/),
    })
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

  it('rejects a compatible but different version than the plan promised', async () => {
    const home = tempHome()
    const transport = fakeTransport()
    const oldDir = managedTargetDir(home, 'github.gh', '2.40.1')
    mkdirSync(join(oldDir, 'bin'), { recursive: true })
    writeFileSync(join(oldDir, EXE), 'old-working-binary')
    const { manager, plan } = await setup({
      home,
      transport,
      probe: async () => ({ compatible: true, version: '2.41.0' }),
    })
    await manager.start(definition(), plan.planId)
    const task = await settle(manager, 'github.gh')
    expect(task.state).toBe('failed')
    expect(task.error?.category).toBe('dependency-incompatible')
    expect(task.error?.message).toContain('2.41.0')
    expect(task.preservedPrevious).toBe(true)
    expect(readFileSync(join(oldDir, EXE), 'utf8')).toBe('old-working-binary')
    expect(readdirSync(join(home, 'tools', 'github.gh'))).toEqual(['2.40.1'])
    manager.dispose()
  })

  it('accepts the planned version carrying build metadata', async () => {
    const home = tempHome()
    const transport = fakeTransport()
    const { manager, plan } = await setup({
      home,
      transport,
      probe: async () => ({ compatible: true, version: '2.40.1+official.7' }),
    })
    await manager.start(definition(), plan.planId)
    const task = await settle(manager, 'github.gh')
    expect(task.state).toBe('succeeded')
    manager.dispose()
  })

  it('propagates cancellation to the post-swap probe and restores the previous copy', async () => {
    const home = tempHome()
    const transport = fakeTransport()
    let signalProbeStarted!: () => void
    const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve })
    const { manager, plan } = await setup({
      home,
      transport,
      probe: async (_path, signal) => {
        signalProbeStarted()
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
        return { compatible: true, version: '2.40.1' }
      },
    })
    mkdirSync(join(plan.targetDir, 'bin'), { recursive: true })
    writeFileSync(join(plan.targetDir, EXE), 'old-working-binary')
    await manager.start(definition(), plan.planId)
    await probeStarted
    const task = await manager.cancel('github.gh')
    expect(task.state).toBe('cancelled')
    expect(readFileSync(join(plan.targetDir, EXE), 'utf8')).toBe('old-working-binary')
    expect(readdirSync(join(home, 'tools', 'github.gh'))).toEqual(['2.40.1'])
    manager.dispose()
  })

  it('cancels during the post-swap probe and restores the previous copy', async () => {
    const home = tempHome()
    const transport = fakeTransport()
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
    const { manager, plan, probes } = await setup({
      home,
      transport,
      probe: async () => {
        await probeGate
        return { compatible: true, version: '2.40.1' }
      },
    })
    mkdirSync(join(plan.targetDir, 'bin'), { recursive: true })
    writeFileSync(join(plan.targetDir, EXE), 'old-working-binary')
    await manager.start(definition(), plan.planId)
    for (let attempt = 0; attempt < 200 && probes.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(probes.length).toBeGreaterThan(0)
    const cancellation = manager.cancel('github.gh')
    releaseProbe()
    const task = await cancellation
    expect(task.state).toBe('cancelled')
    expect(readFileSync(join(plan.targetDir, EXE), 'utf8')).toBe('old-working-binary')
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

function tarHeader(name: string, type: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function tarGz(entries: ReadonlyArray<{ name: string; type?: string; data?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '', 'utf8')
    blocks.push(tarHeader(entry.name, entry.type ?? '0', data.length))
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
      data.copy(padded)
      blocks.push(padded)
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function zipBytes(
  names: readonly string[],
  options: {
    readonly encrypted?: boolean
    /** EOCD count to claim (defaults to the real number of central entries). */
    readonly declaredEntries?: number
    /** Unix st_mode (e.g. 0o120777 symlink) written to the external attributes. */
    readonly unixMode?: number
  } = {},
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const madeByHost = options.unixMode === undefined ? 0 : 3
  const externalAttributes = options.unixMode === undefined
    ? 0
    : ((options.unixMode << 16) >>> 0)
  for (const name of names) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(options.encrypted === true ? 1 : 0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((madeByHost << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(options.encrypted === true ? 1 : 0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(externalAttributes, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const localBuffer = Buffer.concat(locals)
  const declared = options.declaredEntries ?? names.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(declared, 8)
  eocd.writeUInt16LE(declared, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(localBuffer.length, 16)
  return Buffer.concat([localBuffer, centralBuffer, eocd])
}

describe('archive entry validation before extraction', () => {
  it('accepts safe tar.gz and zip layouts', () => {
    expect(() => validateArchiveEntries('tar.gz', tarGz([
      { name: 'bin/gh', data: '#!/bin/sh\n' },
      { name: 'LICENSE' },
    ]))).not.toThrow()
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh.exe', 'LICENSE']))).not.toThrow()
  })

  it('refuses path traversal and absolute entries in tar.gz archives', () => {
    expect(unsafeArchiveName('../escape')).toBe(true)
    expect(unsafeArchiveName('/etc/passwd')).toBe(true)
    expect(unsafeArchiveName('C:\\Windows\\x')).toBe(true)
    expect(unsafeArchiveName('bin/gh')).toBe(false)
    expect(() => validateArchiveEntries('tar.gz', tarGz([{ name: '../escape' }])))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('tar.gz', tarGz([{ name: '/absolute/file' }])))
      .toThrow(expect.objectContaining({ category: 'failed' }))
  })

  it('refuses link entries and corrupt gzip data in tar.gz archives', () => {
    expect(() => validateArchiveEntries('tar.gz', tarGz([{ name: 'link', type: '2', data: '/etc/passwd' }])))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('tar.gz', Buffer.from('not a gzip stream')))
      .toThrow(expect.objectContaining({ category: 'failed' }))
  })

  it('refuses traversal names and encrypted entries in zip archives', () => {
    expect(() => validateArchiveEntries('zip', zipBytes(['../escape'])))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('zip', zipBytes(['/absolute'])))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh'], { encrypted: true })))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('zip', Buffer.from('not a zip file')))
      .toThrow(expect.objectContaining({ category: 'failed' }))
  })

  it('validates every central entry even when the EOCD under-reports the count', () => {
    // The second entry is traversal; a count-driven validator would stop after
    // the first and let it through.
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh', '../escape'], { declaredEntries: 1 })))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('zip', zipBytes(['../escape', 'bin/gh'], { declaredEntries: 1 })))
      .toThrow(expect.objectContaining({ category: 'failed' }))
  })

  it('refuses zip symlink and device entries using Unix external attributes', () => {
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh'], { unixMode: 0o120777 })))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh'], { unixMode: 0o020644 })))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh'], { unixMode: 0o060644 })))
      .toThrow(expect.objectContaining({ category: 'failed' }))
    // A regular Unix file and a directory remain acceptable.
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh'], { unixMode: 0o100755 }))).not.toThrow()
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/'], { unixMode: 0o040755 }))).not.toThrow()
  })

  it('refuses every special or unknown tar entry type with a traversal name', () => {
    for (const type of ['3', '4', '6', 'S', 'D', 'M', 'N', 'V', 'K', 'A', 'Z']) {
      expect(
        () => validateArchiveEntries('tar.gz', tarGz([{ name: '../escape', type }])),
        `tar type ${type}`,
      ).toThrow(expect.objectContaining({ category: 'failed' }))
    }
    expect(() => validateArchiveEntries('tar.gz', tarGz([{ name: '../escape', type: '5' }])))
      .toThrow(expect.objectContaining({ category: 'failed' }))
  })

  it('refuses a pax header that rewrites the next entry path', () => {
    expect(() => validateArchiveEntries('tar.gz', tarGz([
      { name: 'pax', type: 'x', data: 'path=../escape\n' },
      { name: 'bin/gh', data: 'x' },
    ]))).toThrow(expect.objectContaining({ category: 'failed' }))
  })
})

function headerBag(headers: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  return { get: name => lower.get(name.toLowerCase()) ?? null }
}

function stubRunner(calls?: CliCommandRequest[]): CliRunner {
  return {
    async run(request): Promise<CliResult> {
      calls?.push(request)
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      }
    },
    async runJson(): Promise<never> {
      throw new Error('the install transport must never parse JSON')
    },
  }
}

describe('default download transport', () => {
  it('stops a streamed download past the byte cap and cancels the reader', async () => {
    const dir = tempHome()
    let cancelled = false
    const fetch: ClueFetch = async () => ({
      status: 200,
      headers: headerBag({}),
      body: {
        getReader: () => ({
          read: async () => ({ done: false as const, value: Buffer.alloc(8) }),
          cancel: async () => { cancelled = true },
        }),
      },
    })
    const transport = createNodeInstallTransport({
      fetch,
      runner: stubRunner(),
      downloadMaxBytes: 16,
      downloadTimeoutMs: 5_000,
    })
    await expect(transport.download({
      url: 'https://example.invalid/asset',
      destination: join(dir, 'asset'),
    })).rejects.toMatchObject({
      category: 'failed',
      message: expect.stringMatching(/download limit/),
    })
    expect(cancelled).toBe(true)
  })

  it('refuses a declared content-length above the byte cap before reading', async () => {
    const dir = tempHome()
    let readerRequested = false
    const fetch: ClueFetch = async () => ({
      status: 200,
      headers: headerBag({ 'content-length': '1000' }),
      body: {
        getReader: () => {
          readerRequested = true
          return { read: async () => ({ done: true as const }), cancel: async () => undefined }
        },
      },
    })
    const transport = createNodeInstallTransport({ fetch, runner: stubRunner(), downloadMaxBytes: 16 })
    await expect(transport.download({
      url: 'https://example.invalid/asset',
      destination: join(dir, 'asset'),
    })).rejects.toMatchObject({ category: 'failed', message: expect.stringMatching(/download limit/) })
    expect(readerRequested).toBe(false)
  })

  it('times out a stalled download and a stalled body read', async () => {
    const dir = tempHome()
    const stalledFetch: ClueFetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
    const fetchTransport = createNodeInstallTransport({
      fetch: stalledFetch,
      runner: stubRunner(),
      downloadTimeoutMs: 5,
    })
    await expect(fetchTransport.download({
      url: 'https://example.invalid/asset',
      destination: join(dir, 'asset-a'),
    })).rejects.toMatchObject({ category: 'timeout' })

    let cancelled = false
    const stalledBody: ClueFetch = async () => ({
      status: 200,
      headers: headerBag({}),
      body: {
        getReader: () => ({
          read: () => new Promise(() => undefined),
          cancel: async () => { cancelled = true },
        }),
      },
    })
    const bodyTransport = createNodeInstallTransport({
      fetch: stalledBody,
      runner: stubRunner(),
      downloadTimeoutMs: 5,
    })
    await expect(bodyTransport.download({
      url: 'https://example.invalid/asset',
      destination: join(dir, 'asset-b'),
    })).rejects.toMatchObject({ category: 'timeout' })
    expect(cancelled).toBe(true)
  })
})

describe('npm launch resolution', () => {
  it('runs the real npm-cli.js with the node executable on Windows when found', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const cli = win32.join(win32.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    expect(npmLaunch({
      platform: 'win32',
      env: {},
      nodeExecutable: node,
      exists: path => path === cli,
    })).toEqual({ command: node, args: [cli] })
  })

  it('falls back to the npm.cmd shim on Windows and uses npm on POSIX', () => {
    expect(npmLaunch({
      platform: 'win32',
      env: {},
      nodeExecutable: 'C:\\node\\node.exe',
      exists: () => false,
    })).toEqual({ command: 'npm.cmd', args: [] })
    expect(npmLaunch({ platform: 'linux', env: {} })).toEqual({ command: 'npm', args: [] })
    expect(npmLaunch({ platform: 'darwin', env: {} })).toEqual({ command: 'npm', args: [] })
  })

  it('passes the npm-cli.js path before the install args through the transport', async () => {
    const calls: CliCommandRequest[] = []
    const transport = createNodeInstallTransport({
      fetch: async () => { throw new Error('unused') },
      runner: stubRunner(calls),
      platform: 'win32',
      env: {},
      nodeExecutable: 'C:\\node\\node.exe',
      npmCliExists: path => path.endsWith('npm-cli.js'),
    })
    await transport.npmInstall({
      packageName: 'lark-cli',
      packageVersion: '1.2.3',
      directory: 'C:\\managed\\dir',
    })
    expect(calls[0]?.command).toBe('C:\\node\\node.exe')
    expect(calls[0]?.args[0]).toBe(win32.join('C:\\node', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    expect(calls[0]?.args.slice(1)).toEqual(npmInstallArgs('lark-cli', '1.2.3', 'C:\\managed\\dir'))
  })

  it('uses plain npm on POSIX with the exact local-only argv', async () => {
    const calls: CliCommandRequest[] = []
    const transport = createNodeInstallTransport({
      fetch: async () => { throw new Error('unused') },
      runner: stubRunner(calls),
      platform: 'linux',
      env: {},
    })
    await transport.npmInstall({
      packageName: 'lark-cli',
      packageVersion: '1.2.3',
      directory: '/managed/dir',
    })
    expect(calls[0]?.command).toBe('npm')
    expect(calls[0]?.args).toEqual(npmInstallArgs('lark-cli', '1.2.3', '/managed/dir'))
  })
})

describe('real archive extraction', () => {
  it('extracts a validated tar.gz through the system tar', async () => {
    const dir = tempHome()
    const archivePath = join(dir, 'asset.tar.gz')
    writeFileSync(archivePath, tarGz([{ name: 'bin/gh', data: '#!/bin/sh\necho ok\n' }]))
    const destination = join(dir, 'out')
    mkdirSync(destination)
    const transport = createNodeInstallTransport({
      fetch: async () => { throw new Error('the extract path must not fetch') },
      runner: createCliRunner({ spawn: createNodeSpawn(), env: process.env }),
      platform: process.platform,
    })
    await transport.extract({ archivePath, archive: 'tar.gz', destination, stripComponents: 0 })
    expect(readFileSync(join(destination, 'bin', 'gh'), 'utf8')).toBe('#!/bin/sh\necho ok\n')
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
