/**
 * The S2 CLI dependency runtime.
 *
 * One registry owns every dependency definition (shared by several sources:
 * Issues/PRs both use gh), resolves an executable with a FIXED precedence —
 * explicit user path, then the plugin's managed copy, then a compatible PATH
 * command — and normalizes the six lifecycle states of the approved spec.
 *
 * Safety rules implemented here:
 * - discovery runs ONLY `<executable> --version` (never a business command, an
 *   auth call, `--dry-run` or a login flow) with a timeout, an output cap and
 *   the CLI boundary's env allowlist;
 * - an invalid explicit path is a hard `failed` state; it NEVER silently falls
 *   back to a managed/PATH copy with another account environment;
 * - a managed copy that exists but fails its probe is reported as failed (not
 *   silently replaced by a PATH binary);
 * - probes are single-flight per dependency and cached for a TTL; an install
 *   success / manual path change invalidates the cache and re-probes;
 * - platform/arch support decides whether an automatic install is offered,
 *   without pretending an unsupported platform can install.
 */
import { access } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { ClueError, isClueError } from '../error.ts'
import type {
  ClueDependencyDefinition,
  CliResult,
  CliRunner,
  DependencyDistribution,
  DependencyInstallPlan,
  DependencyInstallTask,
  DependencyInstallTaskSummary,
  DependencyResolvedFrom,
  DependencyState,
  DependencyStatus,
  DependencySystemInstall,
  InstallTransport,
  ResolvedDependency,
  RuntimeErrorInfo,
} from './types.ts'
import {
  confinedPath,
  createInstallManager,
  isPinnedVersion,
  managedExecutablePath,
  managedTargetDir,
  selectDistribution,
  targetSupported,
  taskSummary,
  type InstallManager,
} from './install.ts'

/** Whether an optional signal has been aborted (opaque to TS narrowing). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Default probe-cache lifetime (explicit refresh bypasses it). */
export const DEFAULT_PROBE_TTL_MS = 30_000
/** `--version` probe budget: a broken shim must not stall a settings page. */
const PROBE_TIMEOUT_MS = 5_000
/** `--version` output bound (diagnostics only). */
const PROBE_MAX_OUTPUT_BYTES = 64 << 10

/** Parse the first semantic version from `--version` output. */
export function parseDependencyVersion(output: string): string | undefined {
  const match = /(?:^|[^\dA-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(output)
  return match?.[1]
}

/** Numeric/prerelease comparison segments of one semantic version. */
function versionParts(version: string): { numbers: [number, number, number]; prerelease: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (match === null) return undefined
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Whether `version` is at least `minimum` (prerelease sorts below its release). */
export function versionAtLeast(version: string, minimum: string): boolean {
  const left = versionParts(version)
  const right = versionParts(minimum)
  if (left === undefined || right === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index]! !== right.numbers[index]!) {
      return left.numbers[index]! > right.numbers[index]!
    }
  }
  if (left.prerelease.length === 0) return true
  if (right.prerelease.length === 0) return false
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return false
    if (b === undefined) return true
    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined
    if (aNumber !== undefined && bNumber !== undefined) {
      if (aNumber !== bNumber) return aNumber > bNumber
      continue
    }
    if (aNumber !== undefined) return false
    if (bNumber !== undefined) return true
    if (a !== b) return a > b
  }
  return true
}

/** One probe outcome (never contains raw process output). */
interface ProbeOutcome {
  readonly version?: string
  readonly compatible: boolean
  /** The executable could not be run / answered failure. */
  readonly missing?: boolean
  readonly error?: RuntimeErrorInfo
}

/** One status cache entry. */
interface StatusCacheEntry {
  readonly status: DependencyStatus
  readonly expiresAt: number
}

/** Options of {@link createDependenciesRuntime}. */
export interface DependenciesRuntimeOptions {
  /** Profile/user data home; undefined disables managed installs. */
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly env?: NodeJS.ProcessEnv
  /** Shared CLI boundary used for every `--version` probe. */
  readonly runProcess: CliRunner
  readonly now?: () => number
  readonly newId?: () => string
  readonly probeTtlMs?: number
  readonly planTtlMs?: number
  /** Probe working directory; defaults to the user home (never a session cwd). */
  readonly probeCwd?: string
  readonly pathExists?: (path: string) => Promise<boolean>
  /** Distribution transport for installs (tests pass a fake). */
  readonly transport?: InstallTransport
  readonly hashFile?: (path: string) => Promise<string>
  readonly manualPaths?: Readonly<Record<string, string>>
  /** Persist manual overrides when the settings layer provides a store. */
  readonly onManualPathsChanged?: (paths: Readonly<Record<string, string>>) => void
}

/** The dependency runtime face consumed by `ClueRuntime` and source adapters. */
export interface DependenciesRuntime {
  register(definition: ClueDependencyDefinition): () => void
  getDefinition(dependencyId: string): ClueDependencyDefinition | undefined
  getDefinitions(): readonly ClueDependencyDefinition[]
  inspect(dependencyId?: string, options?: { readonly refresh?: boolean; readonly signal?: AbortSignal }): Promise<readonly DependencyStatus[]>
  resolve(dependencyId: string, options?: { readonly signal?: AbortSignal }): Promise<ResolvedDependency>
  plan(dependencyId: string, options?: { readonly signal?: AbortSignal }): Promise<DependencyInstallPlan>
  start(input: { readonly dependencyId: string; readonly planId: string }, options?: { readonly signal?: AbortSignal }): Promise<DependencyInstallTask>
  tasks(dependencyId?: string): readonly DependencyInstallTask[]
  cancel(dependencyId: string, taskId?: string, options?: { readonly signal?: AbortSignal }): Promise<DependencyInstallTask>
  setManualPath(dependencyId: string, path: string): Promise<DependencyStatus>
  clearManualPath(dependencyId: string): Promise<DependencyStatus>
  invalidate(dependencyId?: string): void
  dispose(): void
}

/** Deep-enough copy of a trusted definition (arrays/objects are not shared). */
function copyDefinition(definition: ClueDependencyDefinition): ClueDependencyDefinition {
  return {
    ...definition,
    version: { ...definition.version },
    supportedPlatforms: definition.supportedPlatforms.map(target => ({ ...target })),
    ...(definition.envAllowlist === undefined ? {} : { envAllowlist: [...definition.envAllowlist] }),
    ...(definition.manualInstall === undefined ? {} : { manualInstall: { ...definition.manualInstall } }),
    ...(definition.install === undefined ? {} : {
      install: {
        ...(definition.install.transport === undefined ? {} : { transport: definition.install.transport }),
        distributions: definition.install.distributions.map(distribution => ({
          ...distribution,
          ...(distribution.platforms === undefined ? {} : {
            platforms: distribution.platforms.map(target => ({ ...target })),
          }),
        })),
      },
    }),
  }
}

/** Programming-error validation of a trusted definition (registration time). */
function validateDefinition(definition: ClueDependencyDefinition): void {
  if (typeof definition.dependencyId !== 'string' || definition.dependencyId.trim() === '') {
    throw new Error('[clues] a dependency registration needs a non-empty dependencyId')
  }
  if (typeof definition.name !== 'string' || definition.name.trim() === '') {
    throw new Error(`[clues] dependency "${definition.dependencyId}" needs a non-empty name`)
  }
  if (typeof definition.command !== 'string' || definition.command.trim() === '') {
    throw new Error(`[clues] dependency "${definition.dependencyId}" needs a non-empty command`)
  }
  if (!isPinnedVersion(definition.version.minimum) || !isPinnedVersion(definition.version.recommended)) {
    throw new Error(`[clues] dependency "${definition.dependencyId}" needs exact minimum/recommended versions`)
  }
  if (!Array.isArray(definition.supportedPlatforms) || definition.supportedPlatforms.length === 0) {
    throw new Error(`[clues] dependency "${definition.dependencyId}" needs a supported platform matrix`)
  }
  for (const distribution of definition.install?.distributions ?? []) {
    if (distribution.kind === 'archive') {
      if (distribution.url === undefined || !distribution.url.startsWith('https://')) {
        throw new Error(`[clues] dependency "${definition.dependencyId}" archive distributions need an https URL`)
      }
      if (distribution.sha256 === undefined || !/^[a-f0-9]{64}$/.test(distribution.sha256)) {
        throw new Error(`[clues] dependency "${definition.dependencyId}" archive distributions need a sha256 digest`)
      }
      if (distribution.archive === undefined) {
        throw new Error(`[clues] dependency "${definition.dependencyId}" archive distributions need a format`)
      }
    }
    if (distribution.kind === 'npm') {
      if (
        distribution.packageName === undefined
        || distribution.packageVersion === undefined
        || distribution.packageVersion !== definition.version.recommended
      ) {
        throw new Error(`[clues] dependency "${definition.dependencyId}" npm distributions must pin the recommended version`)
      }
    }
    // Reject an escaping executable at registration, not only at install time.
    confinedPath('/managed-root', distribution.executable)
  }
}

/** PATH candidate paths for one command on the given target platform. */
export function pathCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const pathValue = env.PATH ?? env.Path ?? ''
  if (pathValue === '') return []
  const names = platform === 'win32'
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command]
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (!seen.has(candidate)) {
        seen.add(candidate)
        candidates.push(candidate)
      }
    }
  }
  return candidates
}

/**
 * Create the dependency runtime.
 * @param options - CLI runner, home/platform facts and test seams.
 */
export function createDependenciesRuntime(options: DependenciesRuntimeOptions): DependenciesRuntime {
  const now = options.now ?? (() => Date.now())
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = options.env ?? process.env
  const probeTtlMs = options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS
  const pathExists = options.pathExists ?? (async path => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  })
  const probeCwd = options.probeCwd ?? homedir() ?? tmpdir()
  const definitions = new Map<string, ClueDependencyDefinition>()
  const manualPaths = new Map<string, string>(Object.entries(options.manualPaths ?? {}))
  const cache = new Map<string, StatusCacheEntry>()
  const inflight = new Map<string, Promise<DependencyStatus>>()
  let generation = 0
  let disposed = false

  const iso = (): string => new Date(now()).toISOString()

  const requireDefinition = (dependencyId: string): ClueDependencyDefinition => {
    const definition = definitions.get(dependencyId)
    if (definition === undefined) {
      throw new ClueError('not-found', `dependency "${dependencyId}" is not registered`)
    }
    return definition
  }

  const installableFor = (definition: ClueDependencyDefinition): boolean =>
    options.home !== undefined
    && targetSupported(definition, platform, arch)
    && selectDistribution(definition, platform, arch) !== undefined
    && isPinnedVersion(definition.version.recommended)

  const baseStatus = (definition: ClueDependencyDefinition): DependencyStatus => {
    const manualPath = manualPaths.get(definition.dependencyId)
    const executable = managedExecutablePath(definition, platform, arch)
    const managedPath = options.home === undefined || executable === undefined
      ? undefined
      : confinedPathSafe(managedTargetDir(options.home, definition.dependencyId, definition.version.recommended), executable)
    return {
      dependencyId: definition.dependencyId,
      name: definition.name,
      command: definition.command,
      state: 'unknown',
      platform,
      arch,
      supported: targetSupported(definition, platform, arch),
      installable: installableFor(definition),
      minimumVersion: definition.version.minimum,
      recommendedVersion: definition.version.recommended,
      ...(manualPath === undefined ? {} : { manualPath }),
      ...(managedPath === undefined ? {} : { managedPath }),
      ...(definition.manualInstall === undefined ? {} : { manualInstall: definition.manualInstall }),
    }
  }

  const withTask = (definition: ClueDependencyDefinition, status: DependencyStatus): DependencyStatus => {
    const task = install.latest(definition.dependencyId)
    if (task === undefined) return status
    const summary: DependencyInstallTaskSummary = taskSummary(task)
    if (task.state === 'running') {
      return { ...status, state: 'installing', installation: summary, lastCheckedAt: iso() }
    }
    if (task.state === 'failed' && status.state !== 'ready') {
      return {
        ...status,
        state: 'failed',
        installation: summary,
        error: task.error ?? status.error ?? { category: 'failed', message: 'the installation failed' },
        lastCheckedAt: iso(),
      }
    }
    return { ...status, installation: summary }
  }

  /** Probe one executable with exactly `--version`. */
  const probeExecutable = async (
    definition: ClueDependencyDefinition,
    executablePath: string,
    signal: AbortSignal | undefined,
  ): Promise<ProbeOutcome> => {
    if (isAborted(signal)) throw new ClueError('cancelled', 'the dependency probe was cancelled')
    let result: CliResult
    try {
      result = await options.runProcess.run({
        command: executablePath,
        args: ['--version'],
        cwd: probeCwd,
        envAllowlist: definition.envAllowlist,
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (isAborted(signal)) throw new ClueError('cancelled', 'the dependency probe was cancelled')
      if (isClueError(error)) {
        if (error.category === 'dependency-missing') {
          return {
            compatible: false,
            missing: true,
            error: { category: 'dependency-missing', message: 'the executable could not be started' },
          }
        }
        return {
          compatible: false,
          error: {
            category: error.category === 'cancelled' ? 'failed' : error.category,
            message: 'the version probe failed',
          },
        }
      }
      return { compatible: false, error: { category: 'failed', message: 'the version probe failed' } }
    }
    if (result.exitCode !== 0) {
      return {
        compatible: false,
        error: { category: 'failed', message: 'the version probe exited with a non-zero status' },
      }
    }
    const version = parseDependencyVersion(`${result.stdout}\n${result.stderr}`)
    if (version === undefined) {
      return {
        compatible: false,
        error: {
          category: 'dependency-incompatible',
          message: 'the version probe did not report a version',
        },
      }
    }
    if (!versionAtLeast(version, definition.version.minimum)) {
      return {
        version,
        compatible: false,
        error: {
          category: 'dependency-incompatible',
          message: `${definition.name} ${version} is below the verified minimum ${definition.version.minimum}`,
        },
      }
    }
    return { version, compatible: true }
  }

  /** Probe the first existing PATH candidate; remembers the first rejected one. */
  const probePath = async (
    definition: ClueDependencyDefinition,
    signal: AbortSignal | undefined,
  ): Promise<{ outcome?: ProbeOutcome; executablePath?: string }> => {
    let rejected: { outcome: ProbeOutcome; executablePath: string } | undefined
    for (const candidate of pathCommandCandidates(definition.command, platform, env)) {
      if (!(await pathExists(candidate))) continue
      const outcome = await probeExecutable(definition, candidate, signal)
      if (outcome.compatible) return { outcome, executablePath: candidate }
      rejected = { outcome, executablePath: candidate }
    }
    return rejected === undefined ? {} : { outcome: rejected.outcome, executablePath: rejected.executablePath }
  }

  /** Resolve one dependency to a readable status (probe cache + single-flight). */
  const computeStatus = async (
    definition: ClueDependencyDefinition,
    signal: AbortSignal | undefined,
  ): Promise<DependencyStatus> => {
    if (isAborted(signal)) throw new ClueError('cancelled', 'the dependency inspection was cancelled')
    const base = baseStatus(definition)
    const manualPath = manualPaths.get(definition.dependencyId)
    if (manualPath !== undefined) {
      // An explicit override is authoritative: a broken path is reported as
      // failed and NEVER silently replaced by a managed or PATH copy.
      if (!isAbsolute(manualPath)) {
        return {
          ...base,
          state: 'failed',
          resolvedFrom: 'manual',
          executablePath: manualPath,
          error: { category: 'invalid-request', message: 'the configured dependency path must be absolute' },
          lastCheckedAt: iso(),
        }
      }
      if (!(await pathExists(manualPath))) {
        return {
          ...base,
          state: 'failed',
          resolvedFrom: 'manual',
          executablePath: manualPath,
          error: { category: 'dependency-missing', message: 'the configured dependency path does not exist' },
          lastCheckedAt: iso(),
        }
      }
      const probe = await probeExecutable(definition, manualPath, signal)
      return {
        ...base,
        state: probe.compatible ? 'ready' : probe.version === undefined ? 'failed' : 'incompatible',
        resolvedFrom: 'manual',
        executablePath: manualPath,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        ...(probe.error === undefined ? {} : { error: probe.error }),
        lastCheckedAt: iso(),
      }
    }
    // Managed copy first: it is the plugin-owned, verified version. A broken
    // managed copy is a failure to repair, not a reason to switch accounts.
    const managedRelative = managedExecutablePath(definition, platform, arch)
    if (options.home !== undefined && managedRelative !== undefined) {
      const managedPath = confinedPathSafe(
        managedTargetDir(options.home, definition.dependencyId, definition.version.recommended),
        managedRelative,
      )
      if (managedPath !== undefined && await pathExists(managedPath)) {
        const probe = await probeExecutable(definition, managedPath, signal)
        return {
          ...base,
          state: probe.compatible ? 'ready' : probe.version === undefined ? 'failed' : 'incompatible',
          resolvedFrom: 'managed',
          executablePath: managedPath,
          managedPath,
          ...(probe.version === undefined ? {} : { version: probe.version }),
          ...(probe.error === undefined ? {} : { error: probe.error }),
          lastCheckedAt: iso(),
        }
      }
    }
    const pathProbe = await probePath(definition, signal)
    if (pathProbe.outcome?.compatible === true) {
      return {
        ...base,
        state: 'ready',
        resolvedFrom: 'path',
        executablePath: pathProbe.executablePath,
        pathCommand: pathProbe.executablePath,
        ...(pathProbe.outcome.version === undefined ? {} : { version: pathProbe.outcome.version }),
        lastCheckedAt: iso(),
      }
    }
    if (pathProbe.outcome !== undefined) {
      return {
        ...base,
        state: pathProbe.outcome.version === undefined ? 'failed' : 'incompatible',
        ...(pathProbe.executablePath === undefined ? {} : {
          executablePath: pathProbe.executablePath,
          pathCommand: pathProbe.executablePath,
        }),
        ...(pathProbe.outcome.version === undefined ? {} : { version: pathProbe.outcome.version }),
        ...(pathProbe.outcome.error === undefined ? {} : { error: pathProbe.outcome.error }),
        lastCheckedAt: iso(),
      }
    }
    return { ...base, state: 'missing', lastCheckedAt: iso() }
  }

  /** Cache-aware status of one definition. */
  const statusOf = async (
    definition: ClueDependencyDefinition,
    refresh: boolean,
    signal: AbortSignal | undefined,
  ): Promise<DependencyStatus> => {
    const dependencyId = definition.dependencyId
    const task = install.latest(dependencyId)
    const cached = cache.get(dependencyId)
    if (task?.state === 'running') {
      const base = cached?.status ?? baseStatus(definition)
      return { ...withTask(definition, { ...base, state: 'installing', lastCheckedAt: iso() }), state: 'installing' }
    }
    if (!refresh && cached !== undefined && cached.expiresAt > now()) {
      return withTask(definition, cached.status)
    }
    const atGeneration = generation
    const key = `${dependencyId}:${generation}`
    let pending = inflight.get(key)
    if (pending === undefined) {
      pending = computeStatus(definition, signal).then(status => {
        if (generation === atGeneration) {
          cache.set(dependencyId, { status, expiresAt: now() + probeTtlMs })
        }
        return status
      })
      inflight.set(key, pending)
      void pending.finally(() => {
        if (inflight.get(key) === pending) inflight.delete(key)
      }).catch(() => undefined)
    }
    return withTask(definition, await pending)
  }

  const installManager: InstallManager = createInstallManager({
    home: options.home,
    platform,
    arch,
    now,
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.hashFile === undefined ? {} : { hashFile: options.hashFile }),
    probeExecutable: async (executablePath, definition) => {
      const outcome = await probeExecutable(definition, executablePath, undefined)
      return {
        compatible: outcome.compatible,
        ...(outcome.version === undefined ? {} : { version: outcome.version }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }
    },
    detectSystemInstall: async (definition): Promise<DependencySystemInstall | undefined> => {
      const pathProbe = await probePath(definition, undefined)
      if (pathProbe.outcome === undefined || pathProbe.executablePath === undefined) return undefined
      return {
        executablePath: pathProbe.executablePath,
        compatible: pathProbe.outcome.compatible,
        ...(pathProbe.outcome.version === undefined ? {} : { version: pathProbe.outcome.version }),
      }
    },
    onInstalled: dependencyId => invalidateLocal(dependencyId),
  })

  // Historical name used by the closure below; the install manager is created
  // after the probe helpers, so this indirection keeps the dependency one-way.
  const install: InstallManager = installManager

  const invalidateLocal = (dependencyId?: string): void => {
    generation += 1
    if (dependencyId === undefined) {
      cache.clear()
      inflight.clear()
      return
    }
    cache.delete(dependencyId)
    for (const key of inflight.keys()) {
      if (key.startsWith(`${dependencyId}:`)) inflight.delete(key)
    }
  }

  /** Hand out copies: a status row is metadata, not live registry state. */
  const copyStatus = (status: DependencyStatus): DependencyStatus => ({
    ...status,
    ...(status.error === undefined ? {} : { error: { ...status.error } }),
    ...(status.installation === undefined ? {} : { installation: { ...status.installation } }),
    ...(status.manualInstall === undefined ? {} : { manualInstall: { ...status.manualInstall } }),
  })

  const inspect = async (
    dependencyId?: string,
    inspectOptions: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<readonly DependencyStatus[]> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    const targets = dependencyId === undefined
      ? [...definitions.values()]
      : [requireDefinition(dependencyId)]
    const rows: DependencyStatus[] = []
    for (const definition of targets) {
      rows.push(copyStatus(await statusOf(definition, inspectOptions.refresh === true, inspectOptions.signal)))
    }
    return rows
  }

  const resolve = async (
    dependencyId: string,
    resolveOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<ResolvedDependency> => {
    const definition = requireDefinition(dependencyId)
    const [status] = await inspect(dependencyId, resolveOptions)
    if (status === undefined) throw new ClueError('failed', `dependency "${dependencyId}" could not be inspected`)
    if (status.state === 'ready' && status.executablePath !== undefined && status.version !== undefined) {
      return {
        dependencyId,
        executablePath: status.executablePath,
        version: status.version,
        resolvedFrom: status.resolvedFrom ?? 'path',
      }
    }
    if (status.state === 'installing') {
      throw new ClueError('dependency-missing', `dependency "${definition.name}" is being installed`)
    }
    if (status.state === 'missing') {
      throw new ClueError('dependency-missing', `dependency "${definition.name}" (${definition.command}) is not installed`)
    }
    if (status.state === 'incompatible') {
      throw new ClueError(
        'dependency-incompatible',
        status.error?.message ?? `dependency "${definition.name}" is not compatible`,
      )
    }
    throw new ClueError(
      status.error?.category ?? 'failed',
      status.error?.message ?? `dependency "${definition.name}" is not usable`,
    )
  }

  const plan = async (
    dependencyId: string,
    planOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<DependencyInstallPlan> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    if (isAborted(planOptions.signal)) throw new ClueError('cancelled', 'the installation plan was cancelled')
    return await install.plan(requireDefinition(dependencyId))
  }

  const start = async (
    input: { readonly dependencyId: string; readonly planId: string },
    startOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<DependencyInstallTask> => {
    return await install.start(requireDefinition(input.dependencyId), input.planId, startOptions.signal)
  }

  const tasks = (dependencyId?: string): readonly DependencyInstallTask[] => {
    if (dependencyId === undefined) return install.list()
    const latest = install.latest(dependencyId)
    return latest === undefined ? [] : [latest]
  }

  const cancel = async (
    dependencyId: string,
    taskId?: string,
    _cancelOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<DependencyInstallTask> => {
    requireDefinition(dependencyId)
    return await install.cancel(dependencyId, taskId)
  }

  const notifyManualPaths = (): void => {
    try {
      options.onManualPathsChanged?.(Object.fromEntries(manualPaths))
    } catch {
      // A persistence hook must not turn a successful explicit-path change
      // into a failed operation; the UI can retry its own save.
    }
  }

  const setManualPath = async (dependencyId: string, path: string): Promise<DependencyStatus> => {
    requireDefinition(dependencyId)
    const trimmed = typeof path === 'string' ? path.trim() : ''
    if (trimmed === '') throw new ClueError('invalid-request', 'a manual dependency path must not be empty')
    if (!isAbsolute(trimmed)) throw new ClueError('invalid-request', 'a manual dependency path must be absolute')
    manualPaths.set(dependencyId, trimmed)
    notifyManualPaths()
    invalidateLocal(dependencyId)
    const [status] = await inspect(dependencyId)
    if (status === undefined) throw new ClueError('failed', 'the dependency status could not be read')
    return status
  }

  const clearManualPath = async (dependencyId: string): Promise<DependencyStatus> => {
    requireDefinition(dependencyId)
    manualPaths.delete(dependencyId)
    notifyManualPaths()
    invalidateLocal(dependencyId)
    const [status] = await inspect(dependencyId)
    if (status === undefined) throw new ClueError('failed', 'the dependency status could not be read')
    return status
  }

  return {
    register(definition: ClueDependencyDefinition): () => void {
      if (disposed) throw new Error('[clues] cannot register a dependency on a disposed runtime')
      validateDefinition(definition)
      if (definitions.has(definition.dependencyId)) {
        throw new Error(`[clues] dependency "${definition.dependencyId}" is already registered`)
      }
      const stored = copyDefinition(definition)
      definitions.set(stored.dependencyId, stored)
      invalidateLocal(stored.dependencyId)
      return () => {
        if (definitions.get(stored.dependencyId) !== stored) return
        definitions.delete(stored.dependencyId)
        invalidateLocal(stored.dependencyId)
      }
    },
    getDefinition(dependencyId: string): ClueDependencyDefinition | undefined {
      const definition = definitions.get(dependencyId)
      return definition === undefined ? undefined : copyDefinition(definition)
    },
    getDefinitions(): readonly ClueDependencyDefinition[] {
      return [...definitions.values()].map(copyDefinition)
    },
    inspect,
    resolve,
    plan,
    start,
    tasks,
    cancel,
    setManualPath,
    clearManualPath,
    invalidate(dependencyId?: string): void {
      invalidateLocal(dependencyId)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      definitions.clear()
      cache.clear()
      inflight.clear()
      install.dispose()
    },
  }
}

/** Confinement helper that answers undefined instead of throwing in status reads. */
function confinedPathSafe(root: string, relativePath: string): string | undefined {
  try {
    return confinedPath(root, relativePath)
  } catch {
    return undefined
  }
}

// Re-exported for adapters that need to know the configured state names.
export type { DependencyDistribution, DependencyState, DependencyResolvedFrom }
