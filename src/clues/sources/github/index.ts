/**
 * S3 install surface: `createGithubSources({ runtime: () => ClueRuntime })`.
 *
 * It returns everything S9 registers, and performs no registration itself:
 * - the two source registrations (issues/pulls) for
 *   `createCluesService({ builtinSources })`;
 * - the shared `github.gh` dependency definition and the shared
 *   `github.gh.auth` account connection for S2's runtime;
 * - a `dispose()` that aborts in-flight login attempts (idempotent).
 *
 * The runtime is a LAZY getter on purpose: the S1 service (and its built-in
 * sources) is constructed before S2's runtime exists, so an eager instance
 * would be a circular dependency. S9 builds the sources first, installs the
 * service, then installs the runtime and registers the definitions returned
 * here.
 */
import type { ClueTypeDescriptor } from '../../types.ts'
import type { ClueSourceRegistration } from '../../service.ts'
import type {
  ClueConnectionDefinition,
  ClueDependencyDefinition,
  ClueRuntime,
} from '../../runtime/types.ts'
import { createGithubGhClient } from './gh.ts'
import { createGithubAuthAdapter } from './connection.ts'
import { githubGhDependency } from './dependency.ts'
import { GITHUB_CONNECTION_ID, GITHUB_DEPENDENCY_ID } from './ids.ts'
import { createGithubSourceRegistrations } from './sources.ts'

export * from './ids.ts'
export * from './url.ts'
export * from './scope.ts'
export * from './revision.ts'
export * from './errors.ts'
export * from './gh.ts'
export * from './dependency.ts'
export * from './connection.ts'
export * from './sources.ts'

/** Options of {@link createGithubSources}. */
export interface GithubSourcesOptions {
  /** Lazy accessor for the ONE shared S2 runtime (installed after the sources). */
  readonly runtime: () => ClueRuntime
  /** Millisecond clock (prompt expiry/ids); defaults to `Date.now`. */
  readonly now?: () => number
  /** Explicit absolute working directory for every gh call. */
  readonly cwd?: string
  /** Attempt-id generator (tests). */
  readonly newId?: () => string
}

/** What S9 registers: sources, definitions and the adapter disposer. */
export interface GithubSourcesInstall {
  readonly registrations: readonly ClueSourceRegistration[]
  readonly dependency: ClueDependencyDefinition
  readonly connection: ClueConnectionDefinition
  /** The ids the registrations reference, for settings wiring/assertions. */
  readonly dependencyIds: readonly string[]
  readonly connectionId: string
  readonly typeIds: readonly string[]
  /** Abort in-flight login attempts and clear adapter state (idempotent). */
  dispose(): void
}

/**
 * Build the built-in GitHub sources.
 * @param options - lazy runtime + clock/cwd/id seams.
 */
export function createGithubSources(options: GithubSourcesOptions): GithubSourcesInstall {
  const nowMs = options.now ?? (() => Date.now())
  const nowIso = (): string => new Date(nowMs()).toISOString()
  const client = createGithubGhClient({
    runtime: options.runtime,
    now: nowIso,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
  const registrations = createGithubSourceRegistrations({ client, now: nowIso })
  const auth = createGithubAuthAdapter({
    runtime: options.runtime,
    now: nowMs,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })
  const typeIds: readonly string[] = registrations
    .flatMap(registration => registration.types.map((type: ClueTypeDescriptor) => type.typeId))
  return {
    registrations,
    dependency: githubGhDependency(),
    connection: auth.definition,
    dependencyIds: [GITHUB_DEPENDENCY_ID],
    connectionId: GITHUB_CONNECTION_ID,
    typeIds,
    dispose: () => auth.dispose(),
  }
}
