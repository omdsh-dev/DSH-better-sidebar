/**
 * S2 host assembly: `installCluesRuntime(ctx, clues, options)`.
 *
 * It builds the one runtime shared by every source plugin and wires it to the
 * S1 clue service's API seam:
 * - dependency registry/probe cache + the one-click install manager;
 * - the connection registry with its explicit authorization lifecycle;
 * - the HTTP / CLI / DSH-MCP boundaries, with secrets resolved per operation
 *   from the host credential seam and tools dispatched through the host's own
 *   execution pipeline;
 * - `clues.dependencies.*` / `clues.connections.*` handlers (no new route, no
 *   Agent tool).
 *
 * Source plugins obtain the runtime through this function's return value
 * (S9 calls it once) or through the host context they are given; they never
 * construct a second runtime, so multiple views/Tabs share one probe cache and
 * one install task (approved spec §5).
 */
import { ClueError } from '../error.ts'
import type { Context } from '../../context-types.ts'
import type {
  CliResult,
  CliRunRequest,
  ClueFetch,
  ClueFetchInit,
  ClueFetchResponse,
  ClueRuntime,
  InstallTransport,
} from './types.ts'
import type { JsonValue } from '../types.ts'
import type { CluesService } from '../service.ts'
import { createCliRunner, createNodeSpawn } from './cli.ts'
import { createDependenciesRuntime, type DependenciesRuntime } from './dependencies.ts'
import { createConnectionsRuntime, type ConnectionsRuntime } from './connections.ts'
import { createHttpClient } from './http.ts'
import { createMcpBridge } from './mcp.ts'
import { createNodeInstallTransport } from './install.ts'
import { registerCluesRuntimeApi } from './api.ts'

// The runtime subpath is the S3/S4 integration surface: definitions/types and
// the injectable factories are exported together so a source plugin imports one
// module instead of reaching into internal files.
export * from './types.ts'
export { createCliRunner, createNodeSpawn } from './cli.ts'
export {
  createDependenciesRuntime,
  parseDependencyVersion,
  pathCommandCandidates,
  versionAtLeast,
  type DependenciesRuntime,
} from './dependencies.ts'
export { createConnectionsRuntime, type ConnectionsRuntime } from './connections.ts'
export { createHttpClient, requireHttpOk } from './http.ts'
export { createMcpBridge, type McpBridgeOptions } from './mcp.ts'
export {
  archiveExtractCommand,
  confinedPath,
  createInstallManager,
  createNodeInstallTransport,
  managedTargetDir,
  npmInstallArgs,
  selectDistribution,
  sha256File,
  type InstallManager,
} from './install.ts'
export { CLUES_RUNTIME_API_METHODS, registerCluesRuntimeApi } from './api.ts'

/** Options of {@link installCluesRuntime}. Every seam is injectable for tests. */
export interface InstallCluesRuntimeOptions {
  /** Profile home (`$DSH_HOME`); defaults to `ctx.profileContext.home`. */
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly env?: NodeJS.ProcessEnv
  /** Probe working directory; never a session/workspace cwd. */
  readonly probeCwd?: string
  /** Explicit CLI path overrides (persistence belongs to the settings layer). */
  readonly manualPaths?: Readonly<Record<string, string>>
  readonly onManualPathsChanged?: (paths: Readonly<Record<string, string>>) => void
  /** Host spawn used by CLI + default install transport. */
  readonly spawn?: import('./types.ts').CliSpawn
  /** Host fetch used by HTTP + default install transport. */
  readonly fetch?: ClueFetch
  /** Distribution transport override (tests / provider-specific extractors). */
  readonly transport?: InstallTransport
  readonly hashFile?: (path: string) => Promise<string>
  readonly credentials?: import('../../context-types.ts').SidebarCredentialProvider
  readonly tools?: import('../../context-types.ts').SidebarToolsService
  readonly agents?: import('../../context-types.ts').SidebarAgentsService
  readonly now?: () => number
  readonly newId?: () => string
  readonly probeTtlMs?: number
  readonly planTtlMs?: number
}

/**
 * Wrap the host's global fetch in the structural seam. A deployment without a
 * fetch answers `unsupported` instead of crashing plugin assembly.
 */
function hostFetchOf(injected: ClueFetch | undefined): ClueFetch {
  if (injected !== undefined) return injected
  return async (url: string, init: ClueFetchInit): Promise<ClueFetchResponse> => {
    const implementation = (globalThis as { fetch?: typeof globalThis.fetch }).fetch
    if (typeof implementation !== 'function') {
      throw new ClueError('unsupported', 'the host fetch implementation is not available')
    }
    return await implementation(url, init as RequestInit) as unknown as ClueFetchResponse
  }
}

/** Lazily read one optional Cordis service without assuming the deployment. */
function lazyService<T>(ctx: Context, name: string, direct: T | undefined): T | undefined {
  if (direct !== undefined) return direct
  const value = (ctx as unknown as Record<string, unknown>)[name]
  if (value !== undefined) return value as T
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Install the S2 runtime and register its API methods.
 * @param ctx - the plugin context (profile home + optional host services).
 * @param clues - the S1 clue service whose API seam receives the handlers.
 * @param options - test/provider seams.
 * @returns the live runtime (shared by every source plugin).
 */
export function installCluesRuntime(
  ctx: Context,
  clues: CluesService,
  options: InstallCluesRuntimeOptions = {},
): ClueRuntime {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const home = options.home ?? ctx.profileContext?.home
  const now = options.now ?? (() => Date.now())

  const credentials = (): import('../../context-types.ts').SidebarCredentialProvider | undefined =>
    lazyService(ctx, 'credentials', options.credentials)
  const tools = (): import('../../context-types.ts').SidebarToolsService | undefined =>
    lazyService(ctx, 'tools', options.tools)
  const agents = (): import('../../context-types.ts').SidebarAgentsService | undefined =>
    lazyService(ctx, 'agents', options.agents)

  /** Resolve a secret for exactly one operation (never cached in the runtime). */
  const resolveCredential = async (ref: string): Promise<string | undefined> => {
    const provider = credentials()
    if (provider === undefined) return undefined
    try {
      return (await provider.resolve(ref))?.value
    } catch {
      return undefined
    }
  }

  const spawn = options.spawn ?? createNodeSpawn()
  const cli = createCliRunner({ spawn, env })
  const fetch = hostFetchOf(options.fetch)
  const transport = options.transport ?? createNodeInstallTransport({ fetch, runner: cli, platform })

  const dependencies: DependenciesRuntime = createDependenciesRuntime({
    ...(home === undefined ? {} : { home }),
    platform,
    arch,
    env,
    runProcess: cli,
    ...(options.probeCwd === undefined ? {} : { probeCwd: options.probeCwd }),
    ...(options.manualPaths === undefined ? {} : { manualPaths: options.manualPaths }),
    ...(options.onManualPathsChanged === undefined ? {} : { onManualPathsChanged: options.onManualPathsChanged }),
    ...(options.probeTtlMs === undefined ? {} : { probeTtlMs: options.probeTtlMs }),
    ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    ...(options.hashFile === undefined ? {} : { hashFile: options.hashFile }),
    transport,
    now,
  })

  const connections: ConnectionsRuntime = createConnectionsRuntime({
    resolveCredential,
    now,
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })

  const http = createHttpClient({ fetch, resolveCredential })
  const mcp = createMcpBridge({
    getTools: tools,
    getAgents: agents,
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })

  let disposed = false
  let disposeApi: () => void = () => undefined

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    disposeApi()
    connections.dispose()
    dependencies.dispose()
  }

  const cliRequest = async (request: CliRunRequest): Promise<import('./types.ts').CliCommandRequest> => {
    const definition = dependencies.getDefinition(request.dependencyId)
    if (definition === undefined) {
      throw new ClueError('not-found', `dependency "${request.dependencyId}" is not registered`)
    }
    const resolved = await dependencies.resolve(request.dependencyId)
    const { dependencyId: _dependencyId, env: extraEnv, ...rest } = request
    return {
      ...rest,
      command: resolved.executablePath,
      ...(definition.envAllowlist === undefined ? {} : { envAllowlist: definition.envAllowlist }),
      ...(extraEnv === undefined ? {} : { env: extraEnv }),
    }
  }

  const runtime: ClueRuntime = {
    dependencies,
    connections,
    http,
    mcp,
    async runCli(request: CliRunRequest): Promise<CliResult> {
      return await cli.run(await cliRequest(request))
    },
    async runCliJson<T = JsonValue>(request: CliRunRequest): Promise<T> {
      return await cli.runJson<T>(await cliRequest(request))
    },
    dispose,
  }

  disposeApi = registerCluesRuntimeApi(clues, runtime)

  // HMR/mount cleanup when the real Cordis context owns effects. The runtime is
  // idempotent, so S9 may dispose it as well.
  const effect = (ctx as unknown as {
    effect?: (callback: () => () => void, label?: string) => unknown
  }).effect
  if (typeof effect === 'function') {
    effect.call(ctx, () => () => dispose(), 'dsh-better-sidebar: clue runtime')
  }

  return runtime
}
