/**
 * S2 install pipeline contract (fake transport; NO network, NO system tool).
 * - a plan is pinned (version/target/actions) and expires;
 * - downloads stage under the profile home, sha256 is verified and the payload
 *   is confined before the target is replaced;
 * - one in-flight task per dependency; cancellation reaches the transport and
 *   the probe; failure/cancel PRESERVES the old copy;
 * - the post-swap `--version` probe decides success and rolls back mismatches;
 * - npm installs are local-only (never `-g`) and no PATH/system directory is
 *   written and no auth/business command runs.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveExtractCommand, createInstallManager, createNodeInstallTransport, managedTargetDir,
  npmInstallArgs, npmLaunch, unsafeArchiveName, validateArchiveEntries, type InstallManager,
} from '../src/clues/runtime/install.ts'
import type {
  CliCommandRequest, CliRunner, ClueDependencyDefinition, ClueFetch, DependencyInstallTask,
  InstallExtractInput, InstallNpmInput, InstallTransport,
} from '../src/clues/runtime/types.ts'
import { createCliRunner, createNodeSpawn } from '../src/clues/runtime/cli.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) removeTree(path) })

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-install-')); roots.push(path)
  return path
}

const ARCHIVE_CONTENT = 'official-archive-bytes'
const SHA = createHash('sha256').update(ARCHIVE_CONTENT).digest('hex')
const EXE = 'bin/gh'

function definition(overrides: Partial<ClueDependencyDefinition> = {}): ClueDependencyDefinition {
  return {
    dependencyId: 'github.gh', name: 'GitHub CLI', command: 'gh', pluginId: 'dsh-better-sidebar', version: { minimum: '2.40.0', recommended: '2.40.1' },
    supportedPlatforms: [{ platform: process.platform, arch: process.arch }],
    install: { distributions: [{ kind: 'archive', source: 'GitHub releases', url: 'https://example.invalid/gh.tar.gz', sha256: SHA, archive: 'tar.gz', executable: EXE }] },
    manualInstall: { instructions: 'Install gh manually', url: 'https://cli.github.com' }, ...overrides,
  }
}

function npmDefinition(packageVersion: string): ClueDependencyDefinition {
  return definition({ install: { distributions: [{ kind: 'npm', source: 'npm', packageName: 'lark-cli', packageVersion, executable: EXE }] } })
}

interface TransportLog { calls: string[]; downloadDestinations: string[]; extractInputs: InstallExtractInput[]; npmInputs: InstallNpmInput[] }

/** Reject with an AbortError as soon as `signal` aborts (never resolves otherwise). */
function abortOn(signal?: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal?.aborted === true) fail(); else signal?.addEventListener('abort', fail, { once: true })
  })
}

function fakeTransport(options: { content?: string; gate?: Promise<void>; waitForAbort?: boolean } = {}): InstallTransport & { log: TransportLog } {
  const log: TransportLog = { calls: [], downloadDestinations: [], extractInputs: [], npmInputs: [] }, content = options.content ?? ARCHIVE_CONTENT
  return {
    log,
    async download(input) {
      log.calls.push('download'); log.downloadDestinations.push(input.destination)
      if (options.gate !== undefined) await options.gate
      if (options.waitForAbort === true) await abortOn(input.signal)
      writeFileSync(input.destination, content)
      input.onProgress?.(content.length, content.length)
    },
    async extract(input) {
      log.calls.push('extract'); log.extractInputs.push({ ...input })
      mkdirSync(join(input.destination, 'bin'), { recursive: true }); writeFileSync(join(input.destination, EXE), 'installed-binary')
    },
    async npmInstall(input) {
      log.calls.push('npm'); log.npmInputs.push({ ...input })
      mkdirSync(join(input.directory, 'bin'), { recursive: true }); writeFileSync(join(input.directory, EXE), 'npm-installed-binary')
    },
  }
}

async function setup(options: {
  transport?: InstallTransport
  probe?: (path: string, signal?: AbortSignal) => Promise<{ compatible: boolean; version?: string }>
  now?: () => number; planTtlMs?: number; definition?: ClueDependencyDefinition; home?: string | undefined
} = {}): Promise<{ manager: InstallManager; home: string; probes: string[]; plan: Awaited<ReturnType<InstallManager['plan']>> }> {
  const home = 'home' in options ? (options.home as string) : tempHome(), probes: string[] = []
  const manager = createInstallManager({
    home, platform: process.platform, arch: process.arch,
    ...(options.now === undefined ? {} : { now: options.now }), ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    probeExecutable: async (path, _definition, signal) => {
      probes.push(path)
      return options.probe === undefined ? { compatible: true, version: '2.40.1' } : await options.probe(path, signal)
    },
    detectSystemInstall: async () => undefined,
  })
  return { manager, home, probes, plan: await manager.plan(options.definition ?? definition()) }
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
}

function seedPreviousCopy(plan: { targetDir: string }): void {
  mkdirSync(join(plan.targetDir, 'bin'), { recursive: true })
  writeFileSync(join(plan.targetDir, EXE), 'old-working-binary')
}
describe('install plan', () => {
  it('pins version, target and actions and refuses stale or changed plans', async () => {
    const home = tempHome(), transport = fakeTransport()
    const { manager, plan } = await setup({ home, transport })
    expect(plan).toMatchObject({
      dependencyId: 'github.gh', version: '2.40.1', platform: process.platform, arch: process.arch,
      targetDir: managedTargetDir(home, 'github.gh', '2.40.1'),
      distribution: { kind: 'archive', source: 'GitHub releases', url: 'https://example.invalid/gh.tar.gz', sha256: SHA, archive: 'tar.gz' },
      installable: true,
    })
    expect(plan.actions.join('\n')).toMatch(/sha256[\s\S]*atomically replace/)
    expect(plan.actionIds).toEqual(['download-archive', 'verify-sha256', 'extract-archive', 'probe-version', 'replace-managed-copy'])
    expect(existsSync(join(home, 'tools'))).toBe(false); expect(transport.log.calls).toEqual([])
    manager.dispose()

    let timestamp = 1_000
    const stale = await setup({ now: () => timestamp, planTtlMs: 1_000 })
    timestamp += 5_000
    await expect(stale.manager.start(definition(), stale.plan.planId)).rejects.toMatchObject({ category: 'conflict' })
    expect(stale.manager.latest('github.gh')).toBeUndefined()
    stale.manager.dispose()

    const rebound = await setup()
    const original = definition().install!.distributions[0]!
    const changed = definition({ install: { distributions: [{ ...original, url: 'https://example.invalid/gh-other.tar.gz', sha256: 'b'.repeat(64) }] } })
    await expect(rebound.manager.start(changed, rebound.plan.planId)).rejects.toMatchObject({
      category: 'conflict', message: expect.stringMatching(/distribution changed/),
    })
    rebound.manager.dispose()
  })

  it.each([
    ['an unknown profile home', { home: undefined }, definition(), ''],
    ['an unpinned npm version', {}, npmDefinition('1.0.0'), undefined],
    ['an unsupported platform', {}, definition({ supportedPlatforms: [{ platform: 'aix', arch: 'ppc64' }] }), undefined],
  ] as const)('is not installable for %s and refuses to start', async (_name, extra, current, targetDir) => {
    const { manager, plan } = await setup({ ...extra, definition: current })
    expect(plan).toMatchObject({ installable: false, actions: [], actionIds: [] })
    if (targetDir !== undefined) expect(plan.targetDir).toBe(targetDir)
    if (current.install?.distributions[0]?.kind === 'npm') expect(plan.unavailableReason).toMatch(/exact version/)
    expect(plan.manualInstall).toBeDefined()
    await expect(manager.start(current, plan.planId)).rejects.toMatchObject({ category: 'unsupported' })
    manager.dispose()
  })
})

describe('install execution', () => {
  it('stages, verifies sha256, extracts and atomically installs without touching PATH', async () => {
    const home = tempHome(), transport = fakeTransport(), pathBefore = process.env.PATH
    const { manager, plan, probes } = await setup({ home, transport })
    await manager.start(definition(), plan.planId)
    expect(await settle(manager, 'github.gh')).toMatchObject({ state: 'succeeded', progress: { stage: 'completed' } })
    expect(transport.log.calls).toEqual(['download', 'extract'])
    expect(transport.log.downloadDestinations[0]).toContain(join(home, 'tools', 'github.gh', '.staging-'))
    expect(transport.log.extractInputs[0]?.destination).toContain(join(home, 'tools', 'github.gh', '.staging-'))
    expect(readFileSync(join(plan.targetDir, EXE), 'utf8')).toBe('installed-binary')
    expect(probes).toEqual([join(plan.targetDir, EXE)])
    expect(readdirSync(home)).toEqual(['tools'])
    expect(readdirSync(join(home, 'tools', 'github.gh'))).toEqual(['2.40.1'])
    expect(process.env.PATH).toBe(pathBefore)
    manager.dispose()
  })

  it.each([
    { name: 'rejects a corrupted archive before extraction', category: 'failed', content: 'tampered-bytes', pattern: /sha256/, calls: ['download'] },
    { name: 'rolls back a rejected new copy', probe: async () => ({ compatible: false }), category: 'dependency-incompatible' },
    { name: 'rolls back another compatible version', probe: async () => ({ compatible: true, version: '2.41.0' }), category: 'dependency-incompatible', message: '2.41.0' },
    { name: 'accepts build metadata on the planned version', probe: async () => ({ compatible: true, version: '2.40.1+official.7' }) },
  ])('the install $name', async ({ content, probe, category, message, pattern, calls }) => {
    const transport = fakeTransport(content === undefined ? {} : { content })
    const { manager, plan } = await setup({ transport, ...(probe === undefined ? {} : { probe }) })
    seedPreviousCopy(plan)
    await manager.start(definition(), plan.planId)
    const task = await settle(manager, 'github.gh')
    if (category === undefined) expect(task.state).toBe('succeeded')
    else {
      expect(task).toMatchObject({ state: 'failed', preservedPrevious: true, error: { category } })
      if (message !== undefined) expect(task.error?.message).toContain(message)
      if (pattern !== undefined) expect(task.error?.message).toMatch(pattern)
      if (calls !== undefined) expect(transport.log.calls).toEqual(calls)
      expect(readFileSync(join(plan.targetDir, EXE), 'utf8')).toBe('old-working-binary')
    }
    manager.dispose()
  })

  it('propagates cancellation to the transport and the post-swap probe and restores the previous copy', async () => {
    let probeSignal: AbortSignal | undefined
    let started!: () => void
    const probeStarted = new Promise<void>((resolve) => { started = resolve })
    const probing = await setup({
      transport: fakeTransport(),
      probe: async (_path, signal) => { probeSignal = signal; started(); await abortOn(signal); return { compatible: true, version: '2.40.1' } },
    })
    seedPreviousCopy(probing.plan)
    await probing.manager.start(definition(), probing.plan.planId)
    await probeStarted
    const probeTask = await probing.manager.cancel('github.gh')
    expect(probeSignal?.aborted).toBe(true)
    expect(probeTask).toMatchObject({ state: 'cancelled', preservedPrevious: true })
    expect(readFileSync(join(probing.plan.targetDir, EXE), 'utf8')).toBe('old-working-binary')
    probing.manager.dispose()

    const transport = fakeTransport({ waitForAbort: true })
    const downloading = await setup({ transport })
    seedPreviousCopy(downloading.plan)
    await downloading.manager.start(definition(), downloading.plan.planId)
    await waitFor(() => transport.log.calls.includes('download'))
    const transportTask = await downloading.manager.cancel('github.gh')
    expect(transportTask).toMatchObject({ state: 'cancelled', preservedPrevious: true })
    expect(readFileSync(join(downloading.plan.targetDir, EXE), 'utf8')).toBe('old-working-binary')
    downloading.manager.dispose()

    const aborted = await setup(), controller = new AbortController()
    controller.abort()
    await aborted.manager.start(definition(), aborted.plan.planId, controller.signal)
    expect((await settle(aborted.manager, 'github.gh')).state).toBe('cancelled')
    aborted.manager.dispose()
    const empty = (await setup()).manager
    await expect(empty.cancel('github.gh')).rejects.toMatchObject({ category: 'not-found' })
    empty.dispose()
  })

  it('shares one in-flight task between repeated clicks and views', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transport = fakeTransport({ gate })
    const { manager, plan } = await setup({ transport })
    const first = await manager.start(definition(), plan.planId)
    await waitFor(() => transport.log.calls.length > 0)
    expect((await manager.start(definition(), plan.planId)).taskId).toBe(first.taskId)
    release()
    expect((await settle(manager, 'github.gh')).state).toBe('succeeded')
    expect(transport.log.calls).toEqual(['download', 'extract'])
    manager.dispose()
  })

  it('installs npm packages locally (no -g, no lifecycle scripts) inside the managed staging dir', async () => {
    const transport = fakeTransport(), npm = npmDefinition('2.40.1')
    const { manager, plan } = await setup({ transport, definition: npm })
    await manager.start(npm, plan.planId)
    expect((await settle(manager, 'github.gh')).state).toBe('succeeded')
    expect(transport.log.calls).toEqual(['npm'])
    expect(transport.log.npmInputs[0]).toMatchObject({ packageName: 'lark-cli', packageVersion: '2.40.1' })
    expect(transport.log.npmInputs[0]?.directory).toContain('.staging-')
    manager.dispose()
  })
})

function tarHeader(name: string, type: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8'); header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12); header.write('00000000000\0', 136, 12)
  header.write('        ', 148, 8); header.write(type, 156, 1); header.write('ustar\0', 257, 6); header.write('00', 263, 2)
  let checksum = 0; for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

function tarGz(entries: ReadonlyArray<{ name: string; type?: string; data?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '', 'utf8')
    blocks.push(tarHeader(entry.name, entry.type ?? '0', data.length))
    if (data.length > 0) { const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512); data.copy(padded); blocks.push(padded) }
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks))
}

function zipBytes(names: readonly string[], options: { encrypted?: boolean; declaredEntries?: number; unixMode?: number } = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  const host = options.unixMode === undefined ? 0 : 3, attributes = options.unixMode === undefined ? 0 : ((options.unixMode << 16) >>> 0)
  for (const name of names) {
    const encoded = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(options.encrypted === true ? 1 : 0, 6); local.writeUInt16LE(encoded.length, 26)
    locals.push(local, encoded)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((host << 8) | 20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(options.encrypted === true ? 1 : 0, 8); central.writeUInt16LE(encoded.length, 28)
    central.writeUInt32LE(attributes, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, encoded)
    offset += local.length + encoded.length
  }
  const localBuffer = Buffer.concat(locals)
  const centralBuffer = Buffer.concat(centrals)
  const declared = options.declaredEntries ?? names.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(declared, 8); eocd.writeUInt16LE(declared, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12); eocd.writeUInt32LE(localBuffer.length, 16)
  return Buffer.concat([localBuffer, centralBuffer, eocd])
}

describe('archive entry validation before extraction', () => {
  it('accepts safe layouts and refuses traversal, links, special files, encryption and corrupt data', () => {
    expect(() => validateArchiveEntries('tar.gz', tarGz([{ name: 'bin/gh', data: '#!/bin/sh\n' }, { name: 'LICENSE' }]))).not.toThrow()
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh.exe', 'LICENSE']))).not.toThrow()
    for (const name of ['../escape', '/etc/passwd', 'C:\\Windows\\x']) expect(unsafeArchiveName(name)).toBe(true)
    expect(unsafeArchiveName('bin/gh')).toBe(false)
    const refused: ReadonlyArray<readonly ['zip' | 'tar.gz', Buffer]> = [
      ['tar.gz', tarGz([{ name: '../escape' }])],
      ['tar.gz', tarGz([{ name: '/absolute/file' }])],
      ['tar.gz', tarGz([{ name: 'link', type: '2', data: '/etc/passwd' }])],
      ['tar.gz', Buffer.from('not a gzip stream')],
      ['zip', zipBytes(['../escape'])],
      ['zip', zipBytes(['/absolute'])],
      ['zip', zipBytes(['bin/gh'], { encrypted: true })],
      ['zip', Buffer.from('not a zip file')],
      // An EOCD under-report must not hide a traversal entry from validation.
      ['zip', zipBytes(['bin/gh', '../escape'], { declaredEntries: 1 })],
      ['zip', zipBytes(['../escape', 'bin/gh'], { declaredEntries: 1 })],
      ['zip', zipBytes(['bin/gh'], { unixMode: 0o120777 })],
      ['zip', zipBytes(['bin/gh'], { unixMode: 0o020644 })],
      ['zip', zipBytes(['bin/gh'], { unixMode: 0o060644 })],
    ]
    for (const [format, bytes] of refused) expect(() => validateArchiveEntries(format, bytes)).toThrow(expect.objectContaining({ category: 'failed' }))
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/gh'], { unixMode: 0o100755 }))).not.toThrow()
    expect(() => validateArchiveEntries('zip', zipBytes(['bin/'], { unixMode: 0o040755 }))).not.toThrow()
    for (const type of ['2', '3', '4', '5', '6', 'S', 'D', 'M', 'N', 'V', 'K', 'A', 'Z']) {
      expect(() => validateArchiveEntries('tar.gz', tarGz([{ name: '../escape', type }]))).toThrow(expect.objectContaining({ category: 'failed' }))
    }
    expect(() => validateArchiveEntries('tar.gz', tarGz([{ name: 'pax', type: 'x', data: 'path=../escape\n' }, { name: 'bin/gh', data: 'x' }]))).toThrow(expect.objectContaining({ category: 'failed' }))
  })
})

function headerBag(headers: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  return { get: name => lower.get(name.toLowerCase()) ?? null }
}

function stubRunner(calls?: CliCommandRequest[]): CliRunner {
  return {
    async run(request) {
      calls?.push(request); return { exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 }
    },
    async runJson(): Promise<never> { throw new Error('the install transport must never parse JSON') },
  }
}

/** A fetch whose body streams from `read` and reports cancellation. */
function streamFetch(options: {
  headers?: Record<string, string>
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  cancel?: () => void
}): ClueFetch {
  return async () => ({
    status: 200, headers: headerBag(options.headers ?? {}), body: { getReader: () => ({ read: options.read, cancel: async () => { options.cancel?.() } }) },
  })
}

const unusedFetch: ClueFetch = async () => { throw new Error('unused') }

describe('default download transport', () => {
  it('enforces the byte cap and timeouts and cancels the reader', async () => {
    const dir = tempHome(), make = (fetch: ClueFetch, limits: { downloadMaxBytes?: number; downloadTimeoutMs?: number } = {}): ReturnType<typeof createNodeInstallTransport> =>
      createNodeInstallTransport({ fetch, runner: stubRunner(), ...limits })
    const download = (transport: ReturnType<typeof createNodeInstallTransport>, destination: string): Promise<void> =>
      transport.download({ url: 'https://example.invalid/asset', destination: join(dir, destination) })

    let cancelled = false
    const capped = make(streamFetch({ read: async () => ({ done: false, value: Buffer.alloc(8) }), cancel: () => { cancelled = true } }), { downloadMaxBytes: 16, downloadTimeoutMs: 5_000 })
    await expect(download(capped, 'asset')).rejects.toMatchObject({ category: 'failed', message: expect.stringMatching(/download limit/) })
    expect(cancelled).toBe(true)

    let readerRequested = false
    const declared = make(async () => ({
      status: 200, headers: headerBag({ 'content-length': '1000' }),
      body: {
        getReader: () => {
          readerRequested = true
          return { read: async () => ({ done: true as const }), cancel: async () => undefined }
        },
      },
    }), { downloadMaxBytes: 16 })
    await expect(download(declared, 'asset-length')).rejects.toMatchObject({ category: 'failed', message: expect.stringMatching(/download limit/) })
    expect(readerRequested).toBe(false)

    const stalledFetch: ClueFetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    await expect(download(make(stalledFetch, { downloadTimeoutMs: 5 }), 'asset-a')).rejects.toMatchObject({ category: 'timeout' })


    let stalledCancelled = false
    const stalledBody = make(streamFetch({ read: () => new Promise<{ done: boolean }>(() => undefined), cancel: () => { stalledCancelled = true } }), { downloadTimeoutMs: 5 })
    await expect(download(stalledBody, 'asset-b')).rejects.toMatchObject({ category: 'timeout' })
    expect(stalledCancelled).toBe(true)
  })
})

describe('npm launch and argv', () => {
  it('resolves the launcher and passes the exact local-only argv through the transport', async () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const cli = win32.join(win32.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    expect(npmLaunch({ platform: 'win32', env: {}, nodeExecutable: node, exists: path => path === cli })).toEqual({ command: node, args: [cli] })
    expect(npmLaunch({ platform: 'win32', env: {}, nodeExecutable: 'C:\\node\\node.exe', exists: () => false })).toEqual({ command: 'npm.cmd', args: [] })
    expect(npmLaunch({ platform: 'linux', env: {} })).toEqual({ command: 'npm', args: [] })
    expect(npmLaunch({ platform: 'darwin', env: {} })).toEqual({ command: 'npm', args: [] })

    const winCalls: CliCommandRequest[] = [], winTransport = createNodeInstallTransport({
      fetch: unusedFetch, runner: stubRunner(winCalls), platform: 'win32', env: {},
      nodeExecutable: 'C:\\node\\node.exe', npmCliExists: path => path.endsWith('npm-cli.js'),
    })
    await winTransport.npmInstall({ packageName: 'lark-cli', packageVersion: '1.2.3', directory: 'C:\\managed\\dir' })
    expect(winCalls[0]?.command).toBe('C:\\node\\node.exe')
    expect(winCalls[0]?.args[0]).toBe(win32.join('C:\\node', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    expect(winCalls[0]?.args.slice(1)).toEqual(npmInstallArgs('lark-cli', '1.2.3', 'C:\\managed\\dir'))

    const posixCalls: CliCommandRequest[] = [], posixTransport = createNodeInstallTransport({ fetch: unusedFetch, runner: stubRunner(posixCalls), platform: 'linux', env: {} })
    await posixTransport.npmInstall({ packageName: 'lark-cli', packageVersion: '1.2.3', directory: '/managed/dir' })
    expect(posixCalls[0]?.command).toBe('npm')
    expect(posixCalls[0]?.args).toEqual(npmInstallArgs('lark-cli', '1.2.3', '/managed/dir'))
  })

  it('never performs a global npm install and builds confined extraction argv', () => {
    const args = npmInstallArgs('lark-cli', '1.2.3', '/managed/dir')
    expect(args).toContain('--ignore-scripts')
    expect(args).toContain('lark-cli@1.2.3')
    expect(args).not.toContain('-g'); expect(args).not.toContain('--global')
    expect(archiveExtractCommand('linux', 'tar.gz', '/a.tar.gz', '/dest', 1)).toEqual({ command: 'tar', args: ['-xzf', '/a.tar.gz', '-C', '/dest', '--strip-components=1'] })
    expect(archiveExtractCommand('darwin', 'zip', '/a.zip', '/dest', 0)).toEqual({ command: 'tar', args: ['-xf', '/a.zip', '-C', '/dest'] })
    expect(archiveExtractCommand('linux', 'zip', '/a.zip', '/dest', 0)).toEqual({ command: 'unzip', args: ['-q', '/a.zip', '-d', '/dest'] })
    expect(archiveExtractCommand('linux', 'zip', '/a.zip', '/dest', 1)).toBeUndefined()
  })
})

describe('real archive extraction', () => {
  it('extracts a validated tar.gz through the system tar', async () => {
    const dir = tempHome(), archivePath = join(dir, 'asset.tar.gz')
    writeFileSync(archivePath, tarGz([{ name: 'bin/gh', data: '#!/bin/sh\necho ok\n' }]))
    const destination = join(dir, 'out')
    mkdirSync(destination)
    const transport = createNodeInstallTransport({
      fetch: async () => { throw new Error('the extract path must not fetch') },
      runner: createCliRunner({ spawn: createNodeSpawn(), env: process.env }), platform: process.platform,
    })
    await transport.extract({ archivePath, archive: 'tar.gz', destination, stripComponents: 0 })
    expect(readFileSync(join(destination, 'bin', 'gh'), 'utf8')).toBe('#!/bin/sh\necho ok\n')
  })
})

describe('state bounds and containment', () => {
  it('refuses a relative profile home and an escaping dependency id', async () => {
    expect(() => createInstallManager({
      home: 'relative/home', platform: process.platform, arch: process.arch,
      probeExecutable: async () => ({ compatible: true, version: '2.40.1' }), detectSystemInstall: async () => undefined })).toThrow(/absolute path/)
    const { manager } = await setup()
    await expect(manager.plan(definition({ dependencyId: '../../../../tmp/evil' }))).rejects.toThrow(/safe path segment/)
    manager.dispose()
  })

  it('refuses to share a running task with another dependency or a changed version', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { manager, plan } = await setup({ transport: fakeTransport({ gate }) })
    await manager.start(definition(), plan.planId)
    const otherPlan = await manager.plan(definition({ dependencyId: 'lark.cli', command: 'lark-cli' }))
    await expect(manager.start(definition(), otherPlan.planId)).rejects.toMatchObject({ category: 'conflict', message: expect.stringMatching(/another dependency/) })
    const upgraded = definition({ version: { minimum: '2.40.0', recommended: '2.41.0' } })
    await expect(manager.start(upgraded, plan.planId)).rejects.toMatchObject({ category: 'conflict' })
    release()
    expect((await settle(manager, 'github.gh')).state).toBe('succeeded')
    manager.dispose()
  })

  it('retains a bounded number of latest tasks', async () => {
    const { manager } = await setup({ transport: fakeTransport() })
    for (let index = 0; index < 66; index += 1) {
      const current = definition({ dependencyId: `dep.${index}`, command: `gh${index}` })
      await manager.start(current, (await manager.plan(current)).planId); await settle(manager, current.dependencyId)
    }
    expect(manager.list().length).toBeLessThanOrEqual(64)
    expect(manager.latest('dep.0')).toBeUndefined()
    expect(manager.latest('dep.65')).toMatchObject({ state: 'succeeded' })
    manager.dispose()
  })
})
