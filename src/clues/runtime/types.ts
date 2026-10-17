/**
 * S2 runtime vocabulary: CLI dependencies, one-click installs, connections and
 * the HTTP / CLI / DSH-MCP execution boundaries.
 *
 * This module is node-free (every `node:*` import lives in the sibling
 * implementation files), so the settings UI may import these DTOs type-only
 * with `types: []`; every shape that crosses `/sidebar/api` or the source
 * adapters' code is plain JSON: statuses, plans, tasks and connection
 * projections must survive one JSON round trip, while raw stdout/stderr,
 * tokens, environment maps and device-code handles never appear in them.
 *
 * Ownership (approved S2 spec):
 * - the runtime owns the dependency/connection STATE MACHINES and the install
 *   pipeline; S3/S4 own the concrete GitHub/Feishu dependency and connection
 *   definitions they register here;
 * - a dependency is shared by sources (Issues and PRs both use gh), a
 *   connection is shared by sources of one provider (Feishu docs + tasks);
 * - definitions come from trusted installed source plugins only. Agent output,
 *   clue content and `.cluepack` archives are never executable input.
 */
import type {
  ClueCaller,
  ClueErrorCategory,
  JsonValue,
} from '../types.ts'

// ── Failures ───────────────────────────────────────────────────────────────

/**
 * A sanitized runtime failure. `message` is user-renderable and never carries
 * raw CLI output, request headers, tokens or environment values.
 */
export interface RuntimeErrorInfo {
  readonly category: ClueErrorCategory
  readonly message: string
}

// ── Dependency identity ────────────────────────────────────────────────────

/**
 * Dependency lifecycle of the S2 spec:
 * `unknown` (not inspected yet), `missing` (no executable), `incompatible`
 * (an executable exists but its version is below the verified minimum),
 * `ready`, `installing`, `failed` (an explicit path is broken / probing
 * failed). Installing overlays the resolved state while a task is in flight.
 */
export type DependencyState = 'unknown' | 'missing' | 'incompatible' | 'ready' | 'installing' | 'failed'

/** Which resolver won. Never inferred from a version string. */
export type DependencyResolvedFrom = 'manual' | 'managed' | 'path'

/**
 * Node's platform vocabulary, restated locally so this module stays free of
 * the `NodeJS` namespace: the settings UI consumes these DTOs type-only with
 * `types: []` + `skipLibCheck: false` (see scripts/check-consumer-types.sh).
 */
export type NodePlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

/** One platform/architecture pair, using Node's platform vocabulary. */
export interface DependencyTarget {
  readonly platform: NodePlatform
  readonly arch: string
}

/**
 * Version contract. `minimum` is the lowest verified-compatible release and
 * `recommended` is a FIXED, verified release the installer may place — never a
 * dist-tag (`latest`, `next`) and never a range.
 */
export interface DependencyVersionRequirement {
  readonly minimum: string
  readonly recommended: string
}

/** Official manual-install guidance shown when automatic install cannot run. */
export interface DependencyManualInstall {
  readonly instructions: string
  readonly url?: string
}

/** One platform's official precompiled (or local-npm) distribution. */
export interface DependencyDistribution {
  readonly kind: 'archive' | 'npm'
  /** Human-readable official source label (`GitHub releases`, `npm`). Never a token. */
  readonly source: string
  /** Platform/arch pairs this asset serves; absent means every supported target. */
  readonly platforms?: readonly DependencyTarget[]
  /** Archive URL (https). Required for `archive`. */
  readonly url?: string
  /** Integrity digest of the official asset (lowercase hex sha256). Required for `archive`. */
  readonly sha256?: string
  /** Archive format the extract transport must understand. */
  readonly archive?: 'zip' | 'tar.gz'
  /** Executable path RELATIVE to the extracted/installed root (forward slashes). */
  readonly executable: string
  /** Leading directory levels the archive contains (default 0). */
  readonly stripComponents?: number
  /** Best-effort download size for progress reporting (never invented). */
  readonly sizeBytes?: number
  /** npm package name. Required for `npm`. */
  readonly packageName?: string
  /** Exact npm package version. Required for `npm` and must equal `version.recommended`. */
  readonly packageVersion?: string
  /**
   * npm lifecycle scripts. Only `false` is supported: a distribution that
   * needs install scripts must state them in its manual guidance instead of
   * running them silently inside the managed directory.
   */
  readonly runScripts?: false
}

/**
 * A trusted source plugin's install capability. The actual transport is
 * injectable so tests never touch the network and a provider can ship an
 * extractor for an archive format the core does not know.
 */
export interface DependencyInstallDefinition {
  /** Platform distributions; a target with no entry has no automatic install. */
  readonly distributions: readonly DependencyDistribution[]
  /** Optional per-dependency transport override (trusted code, never serialized). */
  readonly transport?: InstallTransport
}

/** A trusted, registered CLI dependency (never derived from model output). */
export interface ClueDependencyDefinition {
  /** Stable id shared by every source that needs this tool (`github.gh`). */
  readonly dependencyId: string
  readonly name: string
  /** Command name looked up on PATH (`gh`, `lark-cli`). */
  readonly command: string
  /** Plugin that registered the definition, for attribution. */
  readonly pluginId: string
  /** Verified compatibility contract. */
  readonly version: DependencyVersionRequirement
  /** Target entries this plugin has verified; an unlisted host cannot auto-install. */
  readonly supportedPlatforms: readonly DependencyTarget[]
  /**
   * Extra environment variable NAMES this CLI may inherit (in addition to the
   * fixed safe allowlist). Secret-looking names are always refused.
   */
  readonly envAllowlist?: readonly string[]
  /** Optional one-click install capability. */
  readonly install?: DependencyInstallDefinition
  /** Manual guidance retained when install is absent/unsupported. */
  readonly manualInstall?: DependencyManualInstall
}

/** One inspected dependency, safe for settings UI and the wire. */
export interface DependencyStatus {
  readonly dependencyId: string
  readonly name: string
  readonly command: string
  readonly state: DependencyState
  readonly platform: string
  readonly arch: string
  /** Whether this host target appears in the definition's verified matrix. */
  readonly supported: boolean
  /** Whether an automatic install can be offered for this exact target. */
  readonly installable: boolean
  readonly minimumVersion: string
  readonly recommendedVersion: string
  /** Version actually parsed from `--version` (only when ready/incompatible). */
  readonly version?: string
  /** Absolute executable path in use, or the explicit path that failed. */
  readonly executablePath?: string
  readonly resolvedFrom?: DependencyResolvedFrom
  /** The explicit override, whether or not it resolved. */
  readonly manualPath?: string
  /** The managed-copy path considered for the pinned version. */
  readonly managedPath?: string
  /** A PATH copy seen while resolving (diagnostic only; never auto-selected). */
  readonly pathCommand?: string
  readonly lastCheckedAt?: string
  readonly error?: RuntimeErrorInfo
  /** Live installation overlay, when a task exists for this dependency. */
  readonly installation?: DependencyInstallTaskSummary
  readonly manualInstall?: DependencyManualInstall
}

/** Compact installation row embedded in a dependency status. */
export interface DependencyInstallTaskSummary {
  readonly taskId: string
  readonly state: DependencyInstallState
  readonly stage?: DependencyInstallStage
  readonly version: string
  readonly startedAt: string
  readonly finishedAt?: string
}

// ── Installation plan / task ───────────────────────────────────────────────

/** Stages are explicitly stage-based; a fraction exists only with a byte total. */
export type DependencyInstallStage =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'probing'
  | 'completed'

/** A task is `running` until it settles exactly once. */
export type DependencyInstallState = 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * Stable ids of the plan's ordered actions. `actions` carries the same text
 * for diagnostics, but a settings UI localizes from these ids instead of
 * guessing from English prose.
 */
export type DependencyInstallActionId =
  | 'download-archive'
  | 'verify-sha256'
  | 'extract-archive'
  | 'install-npm-local'
  | 'probe-version'
  | 'replace-managed-copy'

/** Progress that never fabricates a percentage when no total is known. */
export interface DependencyInstallProgress {
  readonly stage: DependencyInstallStage
  readonly fraction?: number
  readonly receivedBytes?: number
  readonly totalBytes?: number
}

/** What the plan shows before the user confirms it. */
export interface DependencyInstallDistributionProjection {
  readonly kind: 'archive' | 'npm' | 'none'
  readonly source: string
  readonly url?: string
  readonly sha256?: string
  readonly archive?: 'zip' | 'tar.gz'
  readonly packageName?: string
  readonly packageVersion?: string
  readonly sizeBytes?: number
}

/** A PATH/system copy detected while planning (reported, never overwritten). */
export interface DependencySystemInstall {
  readonly executablePath: string
  readonly version?: string
  readonly compatible: boolean
}

/**
 * A confirmed-install plan. Plans expire (`expiresAt`) and are bound to the
 * dependency's pinned version: changing the target version requires a NEW plan
 * and a new human confirmation.
 */
export interface DependencyInstallPlan {
  readonly planId: string
  readonly dependencyId: string
  readonly name: string
  readonly command: string
  readonly version: string
  readonly platform: string
  readonly arch: string
  readonly distribution: DependencyInstallDistributionProjection
  /** `$DSH_HOME/tools/<dependencyId>/<version>` (host path dialect). */
  readonly targetDir: string
  /** Executable the install must produce (absolute, inside `targetDir`). */
  readonly executablePath: string
  /** Existing PATH copy, shown for context; the managed copy never overwrites it. */
  readonly systemInstall?: DependencySystemInstall
  readonly manualInstall?: DependencyManualInstall
  /** `false` + `unavailableReason` when this platform/asset cannot auto-install. */
  readonly installable: boolean
  readonly unavailableReason?: string
  /** Ordered human-readable actions the confirmed plan will perform. */
  readonly actions: readonly string[]
  /** Stable ids of {@link actions} for localization (same order). */
  readonly actionIds: readonly DependencyInstallActionId[]
  readonly createdAt: string
  readonly expiresAt: string
}

/** One install task snapshot. Snapshots are copies; callers never see mutation. */
export interface DependencyInstallTask {
  readonly taskId: string
  readonly dependencyId: string
  readonly planId: string
  readonly version: string
  readonly platform: string
  readonly arch: string
  readonly targetDir: string
  readonly state: DependencyInstallState
  readonly progress?: DependencyInstallProgress
  readonly startedAt: string
  readonly finishedAt?: string
  readonly error?: RuntimeErrorInfo
  /** A previously ready managed copy was preserved (failed/cancelled upgrade). */
  readonly preservedPrevious?: boolean
}

// ── Installer transport (injectable; tests never touch the network) ────────

/** Download one official asset into `destination` (exact absolute file path). */
export interface InstallDownloadInput {
  readonly url: string
  readonly destination: string
  readonly signal?: AbortSignal
  readonly onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void
}

/** Extract one verified archive into a confined staging directory. */
export interface InstallExtractInput {
  readonly archivePath: string
  readonly archive: 'zip' | 'tar.gz'
  readonly destination: string
  readonly stripComponents: number
  readonly signal?: AbortSignal
}

/** Install one npm package locally inside the managed staging directory. */
export interface InstallNpmInput {
  readonly packageName: string
  readonly packageVersion: string
  readonly directory: string
  readonly signal?: AbortSignal
}

/**
 * The distribution execution seam. The core owns staging, integrity checking,
 * atomic replacement, cancellation and re-probing; a transport only moves
 * bytes/builds a tree inside the directory it is handed.
 */
export interface InstallTransport {
  download(input: InstallDownloadInput): Promise<void>
  extract(input: InstallExtractInput): Promise<void>
  npmInstall(input: InstallNpmInput): Promise<void>
}

// ── CLI boundary ───────────────────────────────────────────────────────────

/** One resolved CLI invocation. `command` is an absolute executable path. */
export interface CliCommandRequest {
  readonly command: string
  /** Argument vector; never a shell string. */
  readonly args: readonly string[]
  /** Explicit, absolute working directory (never the session's implicit cwd). */
  readonly cwd: string
  /** Structured stdin payload (large bodies stay out of argv). */
  readonly stdin?: string | Uint8Array
  /** Kill the child and answer `timeout` when exceeded (default 30s). */
  readonly timeoutMs?: number
  /** Per-stream capture bound (default 1 MiB). Exceeding it is explicit. */
  readonly maxOutputBytes?: number
  /** Extra environment values; only names accepted by the allowlist survive. */
  readonly env?: Readonly<Record<string, string>>
  /** Dependency-declared extra variable NAMES allowed through. */
  readonly envAllowlist?: readonly string[]
  readonly signal?: AbortSignal
}

/** Outcome of one process run. A non-zero exit is never presented as success. */
export interface CliResult {
  readonly exitCode: number
  readonly stdout: string
  /** Sanitized (redacted, ANSI-stripped) stderr; raw secrets never leave here. */
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly durationMs: number
}

/** `ClueRuntime.runCli`: resolve the dependency first, then run it. */
export interface CliRunRequest extends Omit<CliCommandRequest, 'command' | 'envAllowlist'> {
  readonly dependencyId: string
}

/** The structural spawn seam (node:child_process satisfies it). */
export interface CliSpawnOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
  readonly shell: false
  readonly windowsHide: boolean
}

/** One process's readable stream. */
export interface CliReadable {
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  /**
   * Release the underlying pipe. Required to settle a timed-out run when a
   * surviving grandchild inherited the stream and `close` never fires.
   */
  destroy?(): void
}

/** One process's writable stdin. */
export interface CliWritable {
  write(chunk: string | Uint8Array): boolean
  end(): void
  on?(event: 'error', listener: (error: Error) => void): unknown
  /** Emitted once `end()` flushed every buffered byte to the OS pipe. */
  on?(event: 'finish', listener: () => void): unknown
  /** Release the pipe (see {@link CliReadable.destroy}). */
  destroy?(): void
}

/** The subset of node:child_process.ChildProcess the CLI runner consumes. */
export interface CliChildProcess {
  readonly stdout: CliReadable | null
  readonly stderr: CliReadable | null
  readonly stdin: CliWritable | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown
  kill(signal?: string): boolean
}

/** Injectable spawn (tests pass a fake; production wraps node:child_process). */
export type CliSpawn = (command: string, args: readonly string[], options: CliSpawnOptions) => CliChildProcess

/** Runner used by probes / install transports as well as source operations. */
export interface CliRunner {
  run(request: CliCommandRequest): Promise<CliResult>
  /**
   * Run a JSON-producing command. Non-zero exit, empty output, truncated
   * output and malformed JSON all throw: a parse failure never becomes `[]`.
   */
  runJson<T = JsonValue>(request: CliCommandRequest): Promise<T>
}

// ── HTTP boundary ──────────────────────────────────────────────────────────

/** A host credential reference resolved per operation (never cached/copied). */
export interface ClueHttpCredential {
  /** Named host credential (`ctx.credentials.resolve`); a name, never a value. */
  readonly ref: string
  /** Header name (default `authorization`). */
  readonly header?: string
  /** Value prefix (default `Bearer `). */
  readonly prefix?: string
}

/** One HTTP request over the plugin's fetch boundary. */
export interface ClueHttpRequest {
  readonly url: string
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  /**
   * Exact hosts this request (and its redirects) may contact, written as
   * `host` or `host:port`. A port-less entry covers only the scheme's default
   * port. REQUIRED when `credential` is set (a credential must never be sent
   * to an undeclared host).
   */
  readonly allowedHosts?: readonly string[]
  /** Per-operation host credential (resolved once per request, never stored). */
  readonly credential?: ClueHttpCredential
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxRedirects?: number
  readonly signal?: AbortSignal
}

/** One HTTP response with the SAFE header projection and an explicit cap flag. */
export interface ClueHttpResult {
  readonly status: number
  /** Final URL after same-origin redirects. */
  readonly url: string
  /** Safe response headers only (content-type/link/rate-limit/…), never cookies. */
  readonly headers: Readonly<Record<string, string>>
  readonly text: string
  /** The body exceeded `maxResponseBytes`; the prefix is not the whole body. */
  readonly truncated: boolean
  readonly redirects: number
}

/** The structural fetch seam (global fetch satisfies it). */
export interface ClueFetchResponse {
  readonly status: number
  readonly statusText?: string
  readonly headers: { get(name: string): string | null }
  readonly body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<void>
    }
  } | null
  text?(): Promise<string>
}

/** The structural fetch options this runtime sets. */
export interface ClueFetchInit {
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string | Uint8Array
  readonly redirect: 'manual' | 'follow'
  readonly signal?: AbortSignal
}

/** Injectable fetch (tests pass a fake; production uses global fetch). */
export type ClueFetch = (url: string, init: ClueFetchInit) => Promise<ClueFetchResponse>

/** The HTTP boundary exposed on {@link ClueRuntime}. */
export interface ClueHttpClient {
  request(request: ClueHttpRequest, options?: { readonly signal?: AbortSignal }): Promise<ClueHttpResult>
}

// ── DSH-internal MCP boundary ──────────────────────────────────────────────

/** One MCP invocation request. */
export interface McpCallRequest {
  readonly toolName: string
  /** Lossless JSON arguments, forwarded verbatim to the host tool. */
  readonly arguments: JsonValue
  /**
   * Whether the host may ask for approval before executing. Defaults to
   * `true` (fail closed): an idle UI request without a live agent then answers
   * `approval-required` instead of running unapproved.
   */
  readonly requiresApproval?: boolean
  /** Session whose live agent carries the call (never fabricated). */
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

/** The three explicit outcomes of a guarded host-tool call. */
export type McpCallResult =
  | { readonly status: 'completed'; readonly value: JsonValue }
  | { readonly status: 'approval-required'; readonly message: string }
  | { readonly status: 'operation-unavailable'; readonly message: string }

/** The DSH-MCP bridge exposed on {@link ClueRuntime}. */
export interface ClueMcpBridge {
  callTool(
    request: McpCallRequest,
    context: { readonly caller: ClueCaller; readonly sessionId?: string; readonly signal?: AbortSignal },
  ): Promise<McpCallResult>
}

// ── Connections ────────────────────────────────────────────────────────────

/** Step one: is the non-secret application configuration present? */
export type ConnectionConfigurationState = 'unknown' | 'missing' | 'ready' | 'not-required'

/** Step two: is the user's authorization usable? */
export type ConnectionAuthorizationState =
  | 'unknown'
  | 'not-authorized'
  | 'authorizing'
  | 'ready'
  | 'expired'
  | 'denied'
  | 'scope-insufficient'

/** Who owns the secret (mirrors the approved responsibility table). */
export type ConnectionCredentialOwner = 'host-credentials' | 'tool' | 'mcp' | 'none'

/** The next human action a settings row may offer. */
export type ConnectionAction = 'none' | 'configure' | 'connect' | 'reconnect' | 'grant-scope'

/** What the adapter observed. Never contains a secret or machine handle. */
export interface ConnectionInspection {
  readonly configuration: ConnectionConfigurationState
  readonly authorization: ConnectionAuthorizationState
  /** Non-secret account/workspace summary shown to the user. */
  readonly account?: string
  /** Adapter-declared capability ids actually available after auth. */
  readonly capabilities?: readonly string[]
  /** Safe one-line explanation (never a raw response body). */
  readonly detail?: string
}

/**
 * The human-facing authorization projection. `verificationUrl` is OPAQUE and
 * is never re-parsed/re-encoded by the core; the QR payload is the same opaque
 * string for a client-side encoder.
 */
export interface ConnectionAuthorizationPrompt {
  readonly verificationUrl?: string
  readonly userCode?: string
  readonly expiresAt: string
  readonly pollAfterMs?: number
  readonly qr?: { readonly uri: string }
  readonly instructions?: string
}

/** Result of explicitly beginning authorization. Machine state stays host-side. */
export interface ConnectionConnectStart {
  readonly inspection?: ConnectionInspection
  /** Stable id of this attempt; never projected to the client. */
  readonly authorizationId?: string
  readonly prompt?: ConnectionAuthorizationPrompt
  /** Opaque adapter-owned handle for poll/cancel; NEVER crosses the API. */
  readonly state?: JsonValue
}

/** Result of an explicit device-code poll (there is no periodic probe). */
export interface ConnectionPollResult {
  readonly inspection?: ConnectionInspection
  readonly prompt?: ConnectionAuthorizationPrompt
  readonly complete?: boolean
}

/** Context handed to an adapter's connection verbs. */
export interface ConnectionAdapterContext {
  readonly signal?: AbortSignal
  readonly now: () => string
  /** Resolve a host credential for one operation (per call, never cached). */
  resolveCredential(ref: string): Promise<string | undefined>
  /** Publish an observation (normal resource requests update state this way). */
  report(inspection: ConnectionInspection): void
}

/** Input of `connection.connect`. */
export interface ConnectionConnectInput {
  readonly signal?: AbortSignal
}

/** Input of `connection.poll`. */
export interface ConnectionPollInput {
  readonly authorizationId: string
  readonly state?: JsonValue
  readonly prompt?: ConnectionAuthorizationPrompt
  readonly signal?: AbortSignal
}

/** Input of `connection.cancel`. */
export interface ConnectionCancelInput {
  readonly authorizationId: string
  readonly state?: JsonValue
  readonly signal?: AbortSignal
}

/** One trusted connection definition registered by a source plugin. */
export interface ClueConnectionDefinition {
  /** Stable id shared by sources (`feishu.auth`). */
  readonly connectionId: string
  readonly name: string
  readonly pluginId: string
  /** Whether an application/client configuration step exists. */
  readonly configuration: 'required' | 'not-required'
  readonly credentialOwner: ConnectionCredentialOwner
  /** Host credential reference name (only for `host-credentials`). */
  readonly credentialRef?: string
  /** Capability ids this connection can grant. */
  readonly capabilities?: readonly string[]
  /**
   * Observe configuration/authorization WITHOUT an account request. The
   * runtime calls this only for an explicit status request, never on a timer.
   */
  inspect(input: ConnectionConnectInput, context: ConnectionAdapterContext): Promise<ConnectionInspection>
  /**
   * Explicit user action. Normally begins authorization; when the application
   * `configuration` is missing it may run the adapter's own setup flow and
   * answer a `missing`/`ready` inspection. The runtime projects the resulting
   * state and never invents a provider-specific configuration protocol.
   */
  connect?(input: ConnectionConnectInput, context: ConnectionAdapterContext): Promise<ConnectionConnectStart>
  /** Explicit user action: poll an in-flight device-code authorization. */
  poll?(input: ConnectionPollInput, context: ConnectionAdapterContext): Promise<ConnectionPollResult>
  /** Explicit user action: cancel an in-flight authorization. */
  cancel?(input: ConnectionCancelInput, context: ConnectionAdapterContext): Promise<void>
}

/** One connection as the settings UI sees it (no secrets, no handles). */
export interface ConnectionStatusProjection {
  readonly connectionId: string
  readonly name: string
  readonly pluginId: string
  readonly configuration: ConnectionConfigurationState
  readonly authorization: ConnectionAuthorizationState
  readonly credentialOwner: ConnectionCredentialOwner
  readonly capabilities: readonly string[]
  readonly account?: string
  readonly detail?: string
  readonly action: ConnectionAction
  /** Present only while `authorization === 'authorizing'`. */
  readonly prompt?: ConnectionAuthorizationPrompt
  readonly lastCheckedAt: string
  /** Observation failure (sanitized); the projection still renders. */
  readonly error?: RuntimeErrorInfo
}

// ── Runtime faces ──────────────────────────────────────────────────────────

/** One resolved executable handed to a source adapter. */
export interface ResolvedDependency {
  readonly dependencyId: string
  readonly executablePath: string
  readonly version: string
  readonly resolvedFrom: DependencyResolvedFrom
}

/** Registration + inspection + install operations of the dependency runtime. */
export interface ClueDependenciesRuntime {
  register(definition: ClueDependencyDefinition): () => void
  getDefinition(dependencyId: string): ClueDependencyDefinition | undefined
  getDefinitions(): readonly ClueDependencyDefinition[]
  /** Inspect one dependency or all of them (single-flight probe cache). */
  inspect(dependencyId?: string, options?: { readonly refresh?: boolean; readonly signal?: AbortSignal }): Promise<readonly DependencyStatus[]>
  /** Resolve an executable for a source operation (throws dependency-missing/incompatible). */
  resolve(dependencyId: string, options?: { readonly signal?: AbortSignal }): Promise<ResolvedDependency>
  /** Build a fresh, expiring install plan (never starts work). */
  plan(dependencyId: string, options?: { readonly signal?: AbortSignal }): Promise<DependencyInstallPlan>
  /** Start the confirmed plan; a second start for the same dependency shares the task. */
  start(input: { readonly dependencyId: string; readonly planId: string }, options?: { readonly signal?: AbortSignal }): Promise<DependencyInstallTask>
  /** The latest task per dependency (or just one dependency's latest). */
  tasks(dependencyId?: string): readonly DependencyInstallTask[]
  cancel(dependencyId: string, taskId?: string, options?: { readonly signal?: AbortSignal }): Promise<DependencyInstallTask>
  /** Explicit override: takes precedence over managed/PATH and never falls back silently. */
  setManualPath(dependencyId: string, path: string): Promise<DependencyStatus>
  clearManualPath(dependencyId: string): Promise<DependencyStatus>
  /** Invalidate probe caches (an adapter observed a changed install). */
  invalidate(dependencyId?: string): void
  dispose(): void
}

/** Registration + explicit status/authorization operations of the connection runtime. */
export interface ClueConnectionsRuntime {
  register(definition: ClueConnectionDefinition): () => void
  getDefinition(connectionId: string): ClueConnectionDefinition | undefined
  getDefinitions(): readonly ClueConnectionDefinition[]
  /** Explicit status read; the only path that calls `inspect` (no timers). */
  status(connectionId?: string, options?: { readonly signal?: AbortSignal }): Promise<readonly ConnectionStatusProjection[]>
  connect(connectionId: string, options?: { readonly signal?: AbortSignal }): Promise<ConnectionStatusProjection>
  /** Explicit device-code poll; never scheduled by the runtime. */
  poll(connectionId: string, options?: { readonly signal?: AbortSignal }): Promise<ConnectionStatusProjection>
  cancel(connectionId: string, options?: { readonly signal?: AbortSignal }): Promise<ConnectionStatusProjection>
  /** Adapter observation from a normal resource request. */
  report(connectionId: string, inspection: ConnectionInspection): void
  dispose(): void
}

/** The whole S2 runtime returned by `installCluesRuntime`. */
export interface ClueRuntime {
  readonly dependencies: ClueDependenciesRuntime
  readonly connections: ClueConnectionsRuntime
  readonly http: ClueHttpClient
  readonly mcp: ClueMcpBridge
  /** Resolve `dependencyId`, then run it with the dependency's env allowlist. */
  runCli(request: CliRunRequest): Promise<CliResult>
  /** `runCli` + strict JSON parsing (non-zero/empty/malformed/truncated → throws). */
  runCliJson<T = JsonValue>(request: CliRunRequest): Promise<T>
  dispose(): void
}
