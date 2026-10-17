/**
 * The S2 one-click installation pipeline.
 *
 * Responsibilities (approved spec §6):
 * - build an EXPLICIT plan first: fixed version, platform/arch, official
 *   distribution, target directory, existing system install and the exact
 *   actions; plans expire and are bound to the pinned version, so a start can
 *   never silently install a newer release than the one the user confirmed;
 * - install into `$DSH_HOME/tools/<dependencyId>/<version>/` only — never over
 *   a system CLI, never a global npm install, never a PATH edit;
 * - download/integrity-check/extract into a staging directory, then replace the
 *   managed copy atomically; a failure or cancellation keeps the previous
 *   working copy and only removes this task's staging directory;
 * - one in-flight task per dependency (multiple views subscribe to the same
 *   snapshot), stage-based progress (a percentage only when a byte total is
 *   known), cancellation propagated to the transport, and a REAL `--version`
 *   probe after the swap. Only a ready probe settles as `succeeded`.
 *
 * The distribution transport is injectable: tests never touch the network, and
 * a source provider may supply its own extractor. The core still owns every
 * safety step around it (staging, sha256 verification, confinement, rollback).
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ClueError, isClueError } from '../error.ts'
import type {
  ClueDependencyDefinition,
  CliRunner,
  ClueFetch,
  DependencyDistribution,
  DependencyInstallPlan,
  DependencyInstallProgress,
  DependencyInstallState,
  DependencyInstallTask,
  DependencyInstallTaskSummary,
  DependencySystemInstall,
  InstallTransport,
  RuntimeErrorInfo,
} from './types.ts'

/** Whether an optional signal has been aborted (opaque to TS narrowing). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Plan lifetime: after this the user must confirm a fresh plan. */
export const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000
/** Bound of retained plans (a settings page may re-open a few, not unbounded). */
const MAX_RETAINED_PLANS = 64

/** Whether a string is an exact release version (never a tag or a range). */
export function isPinnedVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

/** Path of the managed copy for one dependency version. */
export function managedTargetDir(home: string, dependencyId: string, version: string): string {
  return join(home, 'tools', dependencyId, version)
}

/**
 * Resolve a relative executable path INSIDE a root, refusing absolute paths,
 * drive letters and `..` escapes. A malformed distribution is a programming
 * error in trusted source code, so this throws a plain Error at plan time.
 */
export function confinedPath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new Error('[clues] a distribution needs a non-empty relative executable path')
  }
  if (isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new Error('[clues] a distribution executable path must be relative to its managed root')
  }
  const parts = relativePath.split(/[\\/]+/)
  if (parts.includes('..')) {
    throw new Error('[clues] a distribution executable path must not escape its managed root')
  }
  const absolute = resolve(root, ...parts.filter(part => part !== ''))
  const rel = relative(root, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('[clues] a distribution executable path must stay inside its managed root')
  }
  return absolute
}

/** Whether one distribution serves the given platform/arch. */
function distributionServes(distribution: DependencyDistribution, platform: string, arch: string): boolean {
  if (distribution.platforms === undefined || distribution.platforms.length === 0) return true
  return distribution.platforms.some(target => target.platform === platform && target.arch === arch)
}

/** The distribution a target can install, if the definition has one. */
export function selectDistribution(
  definition: ClueDependencyDefinition,
  platform: string,
  arch: string,
): DependencyDistribution | undefined {
  return definition.install?.distributions.find(distribution => distributionServes(distribution, platform, arch))
}

/** The relative executable path a managed copy of this dependency exposes. */
export function managedExecutablePath(
  definition: ClueDependencyDefinition,
  platform: string,
  arch: string,
): string | undefined {
  return selectDistribution(definition, platform, arch)?.executable
}

/** Whether the host target is in the definition's verified support matrix. */
export function targetSupported(
  definition: ClueDependencyDefinition,
  platform: string,
  arch: string,
): boolean {
  return definition.supportedPlatforms.some(target => target.platform === platform && target.arch === arch)
}

/** Copy one task so callers can never observe in-place mutation. */
export function snapshotTask(task: DependencyInstallTask): DependencyInstallTask {
  return {
    ...task,
    ...(task.progress === undefined ? {} : { progress: { ...task.progress } }),
    ...(task.error === undefined ? {} : { error: { ...task.error } }),
  }
}

/** Compact task row for a dependency status. */
export function taskSummary(task: DependencyInstallTask): DependencyInstallTaskSummary {
  return {
    taskId: task.taskId,
    state: task.state,
    ...(task.progress === undefined ? {} : { stage: task.progress.stage }),
    version: task.version,
    startedAt: task.startedAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
  }
}

/** Bound of archive entries inspected before extraction (defense in depth). */
const MAX_ARCHIVE_ENTRIES = 200_000
/** Bound of a decompressed tar inspected for path safety (official CLI bundles). */
const MAX_TAR_INSPECT_BYTES = 128 << 20

/** Whether an archive entry name would escape the extraction directory. */
export function unsafeArchiveName(name: string): boolean {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) return true
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true
  return normalized.split('/').some(part => part === '..')
}

/** Decode one NUL-terminated tar header field. */
function tarField(header: Buffer, offset: number, length: number): string {
  const end = header.indexOf(0, offset)
  const stop = end === -1 || end > offset + length ? offset + length : end
  return header.subarray(offset, stop).toString('utf8')
}

/** Octal size field; a base-256/large variant is refused (unsupported archive). */
function tarSize(header: Buffer): number {
  const text = tarField(header, 124, 12).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new ClueError('failed', 'the archive uses an unsupported entry size encoding')
  }
  return Number.parseInt(text, 8)
}

/** Validate a decompressed tar stream: no absolute/`..` paths, no links. */
function validateTarBytes(raw: Buffer): void {
  let offset = 0
  let entries = 0
  let longName: string | undefined
  let paxPath: string | undefined
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return
    const type = String.fromCharCode(header[156] ?? 0)
    const size = tarSize(header)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > raw.length) {
      throw new ClueError('failed', 'the archive is truncated')
    }
    entries += 1
    if (entries > MAX_ARCHIVE_ENTRIES) {
      throw new ClueError('failed', 'the archive contains too many entries')
    }
    const data = raw.subarray(dataStart, dataEnd)
    if (type === 'L') {
      longName = tarField(data, 0, data.length)
    } else if (type === 'x') {
      const match = /^path=(.*)$/m.exec(data.toString('utf8'))
      if (match !== null) paxPath = match[1]
    } else if (type === 'K' || type === '1' || type === '2') {
      // A link entry can point outside the extraction root and a later entry
      // could write through it. Official CLI bundles do not need links.
      throw new ClueError('failed', 'the archive contains a link entry')
    } else if (type === '0' || type === '\0' || type === '5' || type === '7') {
      const prefix = tarField(header, 345, 155)
      const shortName = tarField(header, 0, 100)
      const name = longName ?? paxPath ?? (prefix === '' ? shortName : `${prefix}/${shortName}`)
      if (unsafeArchiveName(name)) {
        throw new ClueError('failed', 'the archive contains an entry outside its target directory')
      }
      longName = undefined
      paxPath = undefined
    } else {
      // Other metadata types carry no extractable path.
      longName = undefined
      paxPath = undefined
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  throw new ClueError('failed', 'the archive is truncated')
}

/** Find the Zip end-of-central-directory record. */
function findZipEocd(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

/** Validate a zip central directory (no absolute/`..` names, no encryption). */
function validateZipBytes(raw: Buffer): void {
  const eocd = findZipEocd(raw)
  if (eocd < 0) throw new ClueError('failed', 'the archive is not a valid zip file')
  const entries = raw.readUInt16LE(eocd + 10)
  const centralSize = raw.readUInt32LE(eocd + 12)
  const centralOffset = raw.readUInt32LE(eocd + 16)
  if (entries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new ClueError('failed', 'the archive uses an unsupported zip64 layout')
  }
  if (entries > MAX_ARCHIVE_ENTRIES) {
    throw new ClueError('failed', 'the archive contains too many entries')
  }
  if (centralOffset + centralSize > raw.length) {
    throw new ClueError('failed', 'the archive has an invalid central directory')
  }
  let offset = centralOffset
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > raw.length || raw.readUInt32LE(offset) !== 0x02014b50) {
      throw new ClueError('failed', 'the archive has an invalid central directory')
    }
    const flags = raw.readUInt16LE(offset + 8)
    if ((flags & 0x1) !== 0) {
      throw new ClueError('failed', 'the archive contains an encrypted entry')
    }
    const nameLength = raw.readUInt16LE(offset + 28)
    const extraLength = raw.readUInt16LE(offset + 30)
    const commentLength = raw.readUInt16LE(offset + 32)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > raw.length) throw new ClueError('failed', 'the archive has an invalid central directory')
    const name = raw.subarray(nameStart, nameEnd).toString('utf8')
    if (unsafeArchiveName(name)) {
      throw new ClueError('failed', 'the archive contains an entry outside its target directory')
    }
    // A local header can disagree with the central directory; validate the
    // local name too so no extractor can be tricked by the mismatch.
    const localOffset = raw.readUInt32LE(offset + 42)
    if (localOffset + 30 <= raw.length && raw.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = raw.readUInt16LE(localOffset + 26)
      const localNameStart = localOffset + 30
      if (localNameStart + localNameLength > raw.length) {
        throw new ClueError('failed', 'the archive has an invalid local header')
      }
      const localName = raw.subarray(localNameStart, localNameStart + localNameLength).toString('utf8')
      if (unsafeArchiveName(localName)) {
        throw new ClueError('failed', 'the archive contains an entry outside its target directory')
      }
    }
    offset = nameEnd + extraLength + commentLength
  }
}

/**
 * Validate an archive's entry names BEFORE any extractor runs. The core cannot
 * trust a system `tar`/`unzip` to confine a hostile archive, so absolute paths,
 * `..` segments, links and encrypted entries are refused here.
 */
export function validateArchiveEntries(archive: 'zip' | 'tar.gz', data: Uint8Array): void {
  try {
    if (archive === 'zip') {
      validateZipBytes(Buffer.from(data))
      return
    }
    const raw = gunzipSync(Buffer.from(data), { maxOutputLength: MAX_TAR_INSPECT_BYTES })
    validateTarBytes(raw)
  } catch (error) {
    if (isClueError(error)) throw error
    throw new ClueError('failed', 'the archive could not be validated')
  }
}

/** Default integrity hasher (streaming sha256, lowercase hex). */
export async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', rejectHash)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** Whether a path exists (any type). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Remove one path recursively, ignoring absence. */
async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Sanitized failure info: never carries transport output or a filesystem dump. */
function installErrorInfo(error: unknown): RuntimeErrorInfo {
  if (isClueError(error)) return { category: error.category, message: error.message }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { category: error.name === 'TimeoutError' ? 'timeout' : 'cancelled', message: 'the installation was cancelled' }
  }
  return { category: 'failed', message: 'the installation failed' }
}

/** One plan record retained until its TTL. */
interface PlanRecord {
  readonly plan: DependencyInstallPlan
  readonly expiresAt: number
  readonly version: string
}

/** One live task plus its controller and settlement promise. */
interface RunningTask {
  readonly controller: AbortController
  readonly promise: Promise<DependencyInstallTask>
}

/** The install manager seam consumed by the dependency runtime. */
export interface InstallManager {
  plan(definition: ClueDependencyDefinition): Promise<DependencyInstallPlan>
  start(definition: ClueDependencyDefinition, planId: string, signal?: AbortSignal): Promise<DependencyInstallTask>
  /** Latest task of one dependency (running or settled). */
  latest(dependencyId: string): DependencyInstallTask | undefined
  /** Every known task (one per dependency), newest first. */
  list(): readonly DependencyInstallTask[]
  cancel(dependencyId: string, taskId?: string): Promise<DependencyInstallTask>
  /** Abort in-flight transports and forget plans (HMR unmount). */
  dispose(): void
}

/** Options of {@link createInstallManager}. */
export interface InstallManagerOptions {
  /** Profile home (`$DSH_HOME`); undefined means installing is unavailable. */
  readonly home: string | undefined
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly now?: () => number
  readonly newId?: () => string
  readonly planTtlMs?: number
  /** Dependency runtime's transport (tests pass a fake). */
  readonly transport?: InstallTransport
  /** Integrity verifier (defaults to streaming sha256). */
  readonly hashFile?: (path: string) => Promise<string>
  /** Probe the just-installed executable at the managed path. */
  readonly probeExecutable: (
    executablePath: string,
    definition: ClueDependencyDefinition,
  ) => Promise<{ readonly version?: string; readonly compatible: boolean; readonly error?: RuntimeErrorInfo }>
  /** Detect an unrelated PATH/system copy for the plan's context row. */
  readonly detectSystemInstall: (
    definition: ClueDependencyDefinition,
  ) => Promise<DependencySystemInstall | undefined>
  /** Called after a successful swap so the probe cache is invalidated. */
  readonly onInstalled?: (dependencyId: string) => void
}

/**
 * Create the install manager.
 * @param options - home/platform/transport/probe seams.
 */
export function createInstallManager(options: InstallManagerOptions): InstallManager {
  const now = options.now ?? (() => Date.now())
  let sequence = 0
  const newId = options.newId ?? (() => `${now().toString(36)}-${++sequence}`)
  const planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS
  const hashFile = options.hashFile ?? sha256File
  const defaultTransport = options.transport
  const plans = new Map<string, PlanRecord>()
  const tasks = new Map<string, DependencyInstallTask>()
  const running = new Map<string, RunningTask>()
  const latestTask = new Map<string, string>()
  let disposed = false

  const prunePlans = (): void => {
    const timestamp = now()
    for (const [planId, record] of plans) {
      if (record.expiresAt <= timestamp) plans.delete(planId)
    }
    while (plans.size > MAX_RETAINED_PLANS) {
      const oldest = plans.keys().next().value
      if (oldest === undefined) break
      plans.delete(oldest)
    }
  }

  const buildPlan = async (definition: ClueDependencyDefinition): Promise<DependencyInstallPlan> => {
    const version = definition.version.recommended
    const platform = options.platform
    const arch = options.arch
    const targetDir = options.home === undefined
      ? ''
      : managedTargetDir(options.home, definition.dependencyId, version)
    const distribution = selectDistribution(definition, platform, arch)
    const supported = targetSupported(definition, platform, arch)
    const systemInstall = await options.detectSystemInstall(definition)
    let installable = true
    let unavailableReason: string | undefined
    if (options.home === undefined) {
      installable = false
      unavailableReason = 'the DSH profile home is unknown; configure a manual path or install the CLI yourself'
    } else if (!supported) {
      installable = false
      unavailableReason = `this platform (${platform}/${arch}) is not in the verified support matrix`
    } else if (distribution === undefined) {
      installable = false
      unavailableReason = `no official distribution is declared for ${platform}/${arch}`
    } else if (!isPinnedVersion(version)) {
      installable = false
      unavailableReason = 'the recommended version is not a fixed release version'
    }
    if (distribution?.kind === 'npm') {
      if (
        distribution.packageName === undefined
        || distribution.packageVersion !== version
        || !isPinnedVersion(distribution.packageVersion)
      ) {
        installable = false
        unavailableReason = 'the npm distribution must pin the same exact version as the dependency'
      }
    }
    if (distribution?.kind === 'archive') {
      if (distribution.url === undefined || !distribution.url.startsWith('https://')
        || distribution.sha256 === undefined || !/^[a-f0-9]{64}$/.test(distribution.sha256)
        || distribution.archive === undefined) {
        installable = false
        unavailableReason = 'the archive distribution needs an https URL, a sha256 digest and a format'
      }
    }
    let executablePath = ''
    if (distribution !== undefined && targetDir !== '') {
      try {
        executablePath = confinedPath(targetDir, distribution.executable)
      } catch {
        installable = false
        unavailableReason = 'the distribution executable path is not confined to the managed directory'
      }
    }
    const actions: string[] = []
    if (distribution?.kind === 'archive') {
      actions.push(`download the official ${distribution.archive} archive`)
      actions.push('verify its sha256 integrity')
      actions.push('extract it into a staging directory')
    } else if (distribution?.kind === 'npm') {
      actions.push(`install ${distribution.packageName}@${distribution.packageVersion} locally (no lifecycle scripts)`)
    }
    actions.push('probe the new executable with --version')
    actions.push(`atomically replace ${targetDir === '' ? 'the managed copy' : targetDir}`)
    const createdAt = now()
    const plan: DependencyInstallPlan = {
      planId: `plan-${newId()}`,
      dependencyId: definition.dependencyId,
      name: definition.name,
      command: definition.command,
      version,
      platform,
      arch,
      distribution: distribution === undefined
        ? { kind: 'archive', source: 'unavailable' }
        : {
            kind: distribution.kind,
            source: distribution.source,
            ...(distribution.url === undefined ? {} : { url: distribution.url }),
            ...(distribution.sha256 === undefined ? {} : { sha256: distribution.sha256 }),
            ...(distribution.archive === undefined ? {} : { archive: distribution.archive }),
            ...(distribution.packageName === undefined ? {} : { packageName: distribution.packageName }),
            ...(distribution.packageVersion === undefined ? {} : { packageVersion: distribution.packageVersion }),
            ...(distribution.sizeBytes === undefined ? {} : { sizeBytes: distribution.sizeBytes }),
          },
      targetDir,
      executablePath,
      ...(systemInstall === undefined ? {} : { systemInstall }),
      ...(definition.manualInstall === undefined ? {} : { manualInstall: definition.manualInstall }),
      installable,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      actions,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + planTtlMs).toISOString(),
    }
    plans.set(plan.planId, { plan, expiresAt: createdAt + planTtlMs, version })
    prunePlans()
    return plan
  }

  const updateProgress = (
    task: DependencyInstallTask,
    progress: DependencyInstallProgress,
  ): DependencyInstallTask => {
    const next: DependencyInstallTask = { ...task, progress }
    tasks.set(task.taskId, next)
    return next
  }

  const settle = (
    task: DependencyInstallTask,
    patch: Partial<DependencyInstallTask> & { state: DependencyInstallState },
  ): DependencyInstallTask => {
    const next: DependencyInstallTask = {
      ...task,
      ...patch,
      finishedAt: new Date(now()).toISOString(),
    }
    tasks.set(task.taskId, next)
    if (patch.state === 'succeeded') options.onInstalled?.(task.dependencyId)
    return next
  }

  /**
   * Move the staged payload into place, keeping the previous managed copy until
   * the new executable passes its probe. Returns `ok: false` after rolling back.
   */
  const commitPayload = async (
    task: DependencyInstallTask,
    definition: ClueDependencyDefinition,
    distribution: DependencyDistribution,
    payloadDir: string,
    hadPrevious: boolean,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: RuntimeErrorInfo }> => {
    if (signal.aborted) {
      return { ok: false, error: { category: 'cancelled', message: 'the installation was cancelled' } }
    }
    const targetDir = task.targetDir
    const executablePath = confinedPath(targetDir, distribution.executable)
    await mkdir(resolve(targetDir, '..'), { recursive: true })
    const backupDir = `${targetDir}.previous-${task.taskId}`
    if (hadPrevious) {
      try {
        await rename(targetDir, backupDir)
      } catch {
        return { ok: false, error: { category: 'failed', message: 'the previous managed copy could not be moved aside' } }
      }
    }
    try {
      await rename(payloadDir, targetDir)
    } catch {
      if (hadPrevious) await rename(backupDir, targetDir).catch(() => undefined)
      return { ok: false, error: { category: 'failed', message: 'the staged payload could not be moved into place' } }
    }
    const probe = await options.probeExecutable(executablePath, definition)
    if (signal.aborted) {
      // Cancellation arrived while the swap was being probed: restore the old
      // copy rather than reporting a completed upgrade the user cancelled.
      await removePath(targetDir).catch(() => undefined)
      if (hadPrevious) await rename(backupDir, targetDir).catch(() => undefined)
      return { ok: false, error: { category: 'cancelled', message: 'the installation was cancelled' } }
    }
    if (!probe.compatible) {
      // Never report success for a copy the real probe rejects: restore the old.
      await removePath(targetDir).catch(() => undefined)
      if (hadPrevious) await rename(backupDir, targetDir).catch(() => undefined)
      return {
        ok: false,
        error: probe.error ?? {
          category: 'dependency-incompatible',
          message: 'the installed executable did not pass its version probe',
        },
      }
    }
    if (hadPrevious) await removePath(backupDir).catch(() => undefined)
    return { ok: true }
  }

  /** The actual worker; every failure becomes a settled task, never a throw. */
  const execute = async (
    task: DependencyInstallTask,
    definition: ClueDependencyDefinition,
    distribution: DependencyDistribution,
    controller: AbortController,
  ): Promise<DependencyInstallTask> => {
    const stagingRoot = options.home === undefined
      ? undefined
      : join(options.home, 'tools', definition.dependencyId, `.staging-${task.taskId}`)
    if (stagingRoot === undefined) {
      return settle(task, {
        state: 'failed',
        error: { category: 'unsupported', message: 'the DSH profile home is unknown' },
      })
    }
    const hadPrevious = await pathExists(task.targetDir)
    try {
      if (controller.signal.aborted) throw new ClueError('cancelled', 'the installation was cancelled')
      await mkdir(stagingRoot, { recursive: true })
      let current = updateProgress(task, { stage: 'queued' })
      const throwIfAborted = (): void => {
        if (controller.signal.aborted) throw new ClueError('cancelled', 'the installation was cancelled')
      }
      const transport = definition.install?.transport ?? defaultTransport
      if (transport === undefined) {
        throw new ClueError('unsupported', 'no installation transport is available for this distribution')
      }
      const payloadDir = join(stagingRoot, 'payload')
      await mkdir(payloadDir, { recursive: true })

      if (distribution.kind === 'archive') {
        current = updateProgress(current, { stage: 'downloading' })
        const archivePath = join(stagingRoot, 'archive')
        let lastProgressAt = 0
        await transport.download({
          url: distribution.url!,
          destination: archivePath,
          signal: controller.signal,
          onProgress: (receivedBytes, totalBytes) => {
            // Coalesce noisy progress callbacks; the stage is always explicit.
            const timestamp = now()
            if (timestamp - lastProgressAt < 50 && receivedBytes !== totalBytes) return
            lastProgressAt = timestamp
            current = updateProgress(current, {
              stage: 'downloading',
              receivedBytes,
              ...(totalBytes === undefined || totalBytes <= 0 ? {} : {
                totalBytes,
                fraction: Math.min(1, receivedBytes / totalBytes),
              }),
            })
          },
        })
        throwIfAborted()
        current = updateProgress(current, { stage: 'verifying' })
        const digest = await hashFile(archivePath)
        if (digest.toLowerCase() !== distribution.sha256!.toLowerCase()) {
          throw new ClueError('failed', 'the downloaded archive did not match its official sha256 digest')
        }
        throwIfAborted()
        current = updateProgress(current, { stage: 'extracting' })
        await transport.extract({
          archivePath,
          archive: distribution.archive!,
          destination: payloadDir,
          stripComponents: distribution.stripComponents ?? 0,
          signal: controller.signal,
        })
      } else {
        current = updateProgress(current, { stage: 'installing' })
        await transport.npmInstall({
          packageName: distribution.packageName!,
          packageVersion: distribution.packageVersion!,
          directory: payloadDir,
          signal: controller.signal,
        })
      }
      throwIfAborted()
      // The executable must exist inside the staged payload before the swap.
      const stagedExecutable = confinedPath(payloadDir, distribution.executable)
      if (!(await pathExists(stagedExecutable))) {
        throw new ClueError('failed', 'the installed payload does not contain the expected executable')
      }
      current = updateProgress(current, { stage: 'probing' })
      const commit = await commitPayload(current, definition, distribution, payloadDir, hadPrevious, controller.signal)
      if (!commit.ok) {
        const cancelled = controller.signal.aborted
        return settle(current, {
          state: cancelled ? 'cancelled' : 'failed',
          error: cancelled
            ? { category: 'cancelled', message: 'the installation was cancelled' }
            : commit.error,
          ...(hadPrevious ? { preservedPrevious: true } : {}),
        })
      }
      return settle(current, { state: 'succeeded', progress: { stage: 'completed' } })
    } catch (error) {
      const cancelled = controller.signal.aborted
      return settle(task, {
        state: cancelled ? 'cancelled' : 'failed',
        error: cancelled
          ? { category: 'cancelled', message: 'the installation was cancelled' }
          : installErrorInfo(error),
        ...(hadPrevious ? { preservedPrevious: true } : {}),
      })
    } finally {
      // Only THIS task's staging directory is cleaned up.
      await removePath(stagingRoot).catch(() => undefined)
      running.delete(task.dependencyId)
    }
  }

  const plan = async (definition: ClueDependencyDefinition): Promise<DependencyInstallPlan> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    return await buildPlan(definition)
  }

  const start = async (
    definition: ClueDependencyDefinition,
    planId: string,
    signal?: AbortSignal,
  ): Promise<DependencyInstallTask> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    prunePlans()
    const existing = running.get(definition.dependencyId)
    if (existing !== undefined) {
      const taskId = latestTask.get(definition.dependencyId)
      const task = taskId === undefined ? undefined : tasks.get(taskId)
      if (task === undefined) return snapshotTask(await existing.promise)
      const requested = plans.get(planId)
      if (requested !== undefined && requested.version !== task.version) {
        throw new ClueError(
          'conflict',
          `dependency "${definition.dependencyId}" is already installing version ${task.version}`,
        )
      }
      // Multiple views share the SAME in-flight task instead of starting another.
      return snapshotTask(task)
    }
    const record = plans.get(planId)
    if (record === undefined) {
      throw new ClueError('conflict', 'the installation plan expired or does not exist; create a new plan')
    }
    if (record.plan.dependencyId !== definition.dependencyId) {
      throw new ClueError('conflict', 'the installation plan belongs to another dependency')
    }
    if (record.version !== definition.version.recommended) {
      throw new ClueError('conflict', 'the dependency version changed; confirm a new installation plan')
    }
    if (!record.plan.installable) {
      throw new ClueError('unsupported', record.plan.unavailableReason ?? 'automatic installation is unavailable')
    }
    const distribution = selectDistribution(definition, options.platform, options.arch)
    if (distribution === undefined) {
      throw new ClueError('unsupported', 'no distribution is available for this platform')
    }
    const timestamp = now()
    const task: DependencyInstallTask = {
      taskId: `install-${newId()}`,
      dependencyId: definition.dependencyId,
      planId,
      version: record.version,
      platform: options.platform,
      arch: options.arch,
      targetDir: record.plan.targetDir,
      state: 'running',
      progress: { stage: 'queued' },
      startedAt: new Date(timestamp).toISOString(),
    }
    tasks.set(task.taskId, task)
    latestTask.set(definition.dependencyId, task.taskId)
    const controller = new AbortController()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const promise = execute(task, definition, distribution, controller)
    running.set(definition.dependencyId, { controller, promise })
    // The API answers with the started snapshot immediately; the worker owns
    // the settlement.
    return snapshotTask(task)
  }

  const latest = (dependencyId: string): DependencyInstallTask | undefined => {
    const taskId = latestTask.get(dependencyId)
    const task = taskId === undefined ? undefined : tasks.get(taskId)
    return task === undefined ? undefined : snapshotTask(task)
  }

  const list = (): readonly DependencyInstallTask[] => {
    const rows: DependencyInstallTask[] = []
    for (const taskId of latestTask.values()) {
      const task = tasks.get(taskId)
      if (task !== undefined) rows.push(snapshotTask(task))
    }
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  const cancel = async (dependencyId: string, taskId?: string): Promise<DependencyInstallTask> => {
    const active = running.get(dependencyId)
    const wanted = taskId ?? latestTask.get(dependencyId)
    if (wanted === undefined) {
      throw new ClueError('not-found', `dependency "${dependencyId}" has no installation task`)
    }
    const task = tasks.get(wanted)
    if (task === undefined) {
      throw new ClueError('not-found', `installation task "${wanted}" does not exist`)
    }
    if (task.state !== 'running' || active === undefined) return snapshotTask(task)
    active.controller.abort()
    return snapshotTask(await active.promise)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const active of running.values()) active.controller.abort()
    running.clear()
    plans.clear()
  }

  return { plan, start, latest, list, cancel, dispose }
}

// ── Default node transport ─────────────────────────────────────────────────

/** The command/argv shape used to extract one archive (pure, testable). */
export function archiveExtractCommand(
  platform: NodeJS.Platform,
  archive: 'zip' | 'tar.gz',
  archivePath: string,
  destination: string,
  stripComponents: number,
): { command: string; args: string[] } | undefined {
  const strip = stripComponents > 0 ? [`--strip-components=${stripComponents}`] : []
  if (archive === 'tar.gz') {
    return { command: 'tar', args: ['-xzf', archivePath, '-C', destination, ...strip] }
  }
  // bsdtar (macOS / Windows 10+) reads zip; GNU tar on Linux does not.
  if (platform === 'darwin' || platform === 'win32') {
    return { command: 'tar', args: ['-xf', archivePath, '-C', destination, ...strip] }
  }
  if (stripComponents > 0) return undefined
  return { command: 'unzip', args: ['-q', archivePath, '-d', destination] }
}

/** Exact local-only npm argv (never `-g`, never a profile dependency tree). */
export function npmInstallArgs(packageName: string, packageVersion: string, directory: string): string[] {
  return [
    'install',
    '--prefix',
    directory,
    '--no-save',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `${packageName}@${packageVersion}`,
  ]
}

/** Options of {@link createNodeInstallTransport}. */
export interface NodeInstallTransportOptions {
  readonly fetch: ClueFetch
  /** Shared CLI runner (timeout/cancel/env/redaction contract). */
  readonly runner: CliRunner
  readonly platform?: NodeJS.Platform
}

/**
 * The production transport: host `fetch` for downloads and the shared CLI
 * runner for `tar`/`unzip`/`npm`. It only moves bytes/builds a tree inside the
 * staging directory it is handed; integrity/atomicity/confirmation stay in the
 * manager above.
 */
export function createNodeInstallTransport(options: NodeInstallTransportOptions): InstallTransport {
  const platform = options.platform ?? process.platform

  const runChecked = async (
    command: string,
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
    failure: string,
  ): Promise<void> => {
    let result
    try {
      result = await options.runner.run({
        command,
        args,
        cwd,
        signal,
        timeoutMs: 120_000,
        maxOutputBytes: 64 << 10,
      })
    } catch (error) {
      if (isClueError(error) && error.category === 'dependency-missing') {
        throw new ClueError('unsupported', `${command} is not available on this host`)
      }
      throw error
    }
    if (result.exitCode !== 0) throw new ClueError('failed', failure)
  }

  return {
    async download(input): Promise<void> {
      if (isAborted(input.signal)) throw new ClueError('cancelled', 'the download was cancelled')
      let response
      try {
        response = await options.fetch(input.url, {
          method: 'GET',
          headers: {},
          redirect: 'follow',
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      } catch (error) {
        if (isAborted(input.signal)) throw new ClueError('cancelled', 'the download was cancelled')
        if (isClueError(error)) throw error
        throw new ClueError('failed', 'the official distribution could not be downloaded')
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ClueError('failed', `the official distribution download answered HTTP ${response.status}`)
      }
      const headerLength = response.headers.get('content-length')
      const parsedLength = headerLength === null ? Number.NaN : Number.parseInt(headerLength, 10)
      const totalBytes = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : undefined
      const file = await open(input.destination, 'w')
      let receivedBytes = 0
      try {
        if (response.body !== undefined && response.body !== null) {
          const reader = response.body.getReader()
          while (true) {
            if (isAborted(input.signal)) {
              await reader.cancel().catch(() => undefined)
              throw new ClueError('cancelled', 'the download was cancelled')
            }
            const { done, value } = await reader.read()
            if (done) break
            if (value !== undefined) {
              await file.write(value)
              receivedBytes += value.byteLength
              input.onProgress?.(receivedBytes, totalBytes)
            }
          }
        } else if (response.text !== undefined) {
          const text = await response.text()
          const buffer = Buffer.from(text, 'utf8')
          await file.write(buffer)
          receivedBytes = buffer.length
          input.onProgress?.(receivedBytes, totalBytes)
        } else {
          throw new ClueError('failed', 'the official distribution returned no body')
        }
      } finally {
        await file.close()
      }
    },

    async extract(input): Promise<void> {
      let archiveBytes: Buffer
      try {
        archiveBytes = await readFile(input.archivePath)
      } catch {
        throw new ClueError('failed', 'the downloaded archive could not be read')
      }
      validateArchiveEntries(input.archive, archiveBytes)
      const command = archiveExtractCommand(
        platform,
        input.archive,
        input.archivePath,
        input.destination,
        input.stripComponents,
      )
      if (command === undefined) {
        throw new ClueError('unsupported', `extracting ${input.archive} archives is not supported on this platform`)
      }
      await runChecked(command.command, command.args, input.destination, input.signal, 'the archive could not be extracted')
    },

    async npmInstall(input): Promise<void> {
      if (!isPinnedVersion(input.packageVersion)) {
        throw new ClueError('invalid-request', 'npm installation requires an exact package version')
      }
      await runChecked(
        'npm',
        npmInstallArgs(input.packageName, input.packageVersion, input.directory),
        input.directory,
        input.signal,
        'the local npm installation failed',
      )
    },
  }
}
