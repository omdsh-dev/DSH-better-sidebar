/**
 * S8 source status derivation — pure, node-free, no probing.
 *
 * One registered clue source, one honest state. The inputs are S1's source
 * descriptor needs (`dependencyIds` + `connectionId`) and S2's sanitized
 * `DependencyStatus` / `ConnectionStatusProjection` DTOs; the output is the
 * state the settings row and the source config page render. This module never
 * calls the runtime — the UI performs the explicit `inspect`/`status` request
 * and feeds the answer in.
 *
 * The approved spec names six user-facing distinctions: missing dependency,
 * incompatible version, not configured, authorization expired, ready and
 * request failed. Two transient states are kept explicit instead of being
 * folded into "ready" (which would mislabel an unverified source):
 * - `unchecked`: no observation has completed yet;
 * - `installing`: S2 reports a live install task.
 *
 * `enabled` is a purely presentational preference and deliberately absent
 * from this derivation: a disabled source keeps its dependency/connection
 * configuration and its own row, and its stored @ preference is preserved.
 */
import type {
  ConnectionStatusProjection,
  DependencyStatus,
} from '../../../clues/runtime/types.ts'

/** The state one source row shows. */
export type ClueSourceStatusKind =
  | 'unchecked'
  | 'missing'
  | 'incompatible'
  | 'installing'
  | 'not-configured'
  | 'authorizing'
  | 'auth-expired'
  | 'request-failed'
  | 'ready'

/** Everything needed to derive one source's state. */
export interface ClueSourceStatusInput {
  /** Runtime dependencies the source declared (S1 descriptor). */
  readonly dependencyIds?: readonly string[]
  /** Shared connection identity the source rides (S1 descriptor). */
  readonly connectionId?: string
  /** Dependency statuses from `clues.dependencies.inspect` (may be partial). */
  readonly dependencies?: readonly DependencyStatus[]
  /** Connection projections from `clues.connections.status` (may be partial). */
  readonly connections?: readonly ConnectionStatusProjection[]
  /** The status request itself failed (network/wire) — never claim ready. */
  readonly requestFailed?: boolean
  /**
   * Whether an explicit observation has completed. An un-inspected source is
   * `unchecked`, NOT ready.
   */
  readonly checked?: boolean
}

/** One derived state plus the DTO it came from (for the config page details). */
export interface ClueSourceStatus {
  readonly kind: ClueSourceStatusKind
  readonly dependency?: DependencyStatus
  readonly connection?: ConnectionStatusProjection
  /** Sanitized one-line explanation from S2 (never raw CLI output). */
  readonly detail?: string
}

/**
 * The dependency that decides the row.
 * `unregistered` means the source declares a dependency the runtime never
 * registered — it cannot be resolved on this host, so it is reported as
 * missing without fabricating a full DTO.
 */
type DependencyVerdict =
  | { readonly kind: 'status'; readonly status: DependencyStatus }
  | { readonly kind: 'unregistered'; readonly dependencyId: string }

/** The dependency whose state decides the row (first non-ready in id order). */
function worstDependency(
  ids: readonly string[],
  statuses: readonly DependencyStatus[],
): DependencyVerdict | undefined {
  const byId = new Map(statuses.map(status => [status.dependencyId, status]))
  let installing: DependencyStatus | undefined
  let unchecked: DependencyStatus | undefined
  for (const id of ids) {
    const status = byId.get(id)
    if (status === undefined) return { kind: 'unregistered', dependencyId: id }
    if (status.state === 'failed') return { kind: 'status', status }
    if (status.state === 'missing') return { kind: 'status', status }
    if (status.state === 'incompatible') return { kind: 'status', status }
    if (status.state === 'installing') installing ??= status
    if (status.state === 'unknown') unchecked ??= status
  }
  const decided = installing ?? unchecked
  return decided === undefined ? undefined : { kind: 'status', status: decided }
}

/**
 * Derive the one state a source row/config page shows.
 * @param input - the source's declared needs plus the sanitized status DTOs.
 * @returns the derived state and the deciding DTO.
 */
export function deriveClueSourceStatus(input: ClueSourceStatusInput): ClueSourceStatus {
  if (input.requestFailed === true) return { kind: 'request-failed' }
  if (input.checked === false) return { kind: 'unchecked' }

  const dependencies = input.dependencies ?? []
  const ids = input.dependencyIds ?? []
  const verdict = ids.length === 0 ? undefined : worstDependency(ids, dependencies)
  const dependency = verdict?.kind === 'status' ? verdict.status : undefined

  if (verdict?.kind === 'unregistered') return { kind: 'missing' }

  if (verdict?.kind === 'status') {
    const decided = verdict.status
    if (decided.state === 'failed') {
      return {
        kind: 'request-failed',
        dependency: decided,
        ...(decided.error === undefined ? {} : { detail: decided.error.message }),
      }
    }
    if (decided.state === 'missing') {
      return {
        kind: 'missing',
        dependency: decided,
        ...(decided.error === undefined ? {} : { detail: decided.error.message }),
      }
    }
    if (decided.state === 'incompatible') {
      return {
        kind: 'incompatible',
        dependency: decided,
        ...(decided.error === undefined ? {} : { detail: decided.error.message }),
      }
    }
    if (decided.state === 'installing') return { kind: 'installing', dependency: decided }
    if (decided.state === 'unknown') return { kind: 'unchecked', dependency: decided }
    // Every declared dependency is ready: fall through to the connection half.
  }

  const connectionId = input.connectionId
  if (connectionId !== undefined) {
    const connection = (input.connections ?? []).find(item => item.connectionId === connectionId)
    // A declared connection the runtime never registered has no application
    // configuration on this machine: not configured, never ready.
    if (connection === undefined) {
      return { kind: 'not-configured', ...(dependency === undefined ? {} : { dependency }) }
    }
    const withDependency = dependency === undefined ? {} : { dependency }
    if (connection.error !== undefined) {
      return { kind: 'request-failed', connection, detail: connection.error.message, ...withDependency }
    }
    if (connection.configuration === 'missing') {
      return { kind: 'not-configured', connection, ...withDependency }
    }
    if (connection.configuration === 'unknown') {
      return { kind: 'unchecked', connection, ...withDependency }
    }
    switch (connection.authorization) {
      case 'expired':
        return { kind: 'auth-expired', connection, ...withDependency }
      case 'denied':
      case 'scope-insufficient':
        return { kind: 'request-failed', connection, ...withDependency }
      case 'authorizing':
        return { kind: 'authorizing', connection, ...withDependency }
      case 'not-authorized':
        return { kind: 'not-configured', connection, ...withDependency }
      case 'unknown':
        return { kind: 'unchecked', connection, ...withDependency }
      case 'ready':
        return { kind: 'ready', connection, ...withDependency }
    }
  }

  return dependency === undefined ? { kind: 'ready' } : { kind: 'ready', dependency }
}

/** Whether a derived state means the source can be used right now. */
export function isClueSourceUsable(status: ClueSourceStatus): boolean {
  return status.kind === 'ready'
}
