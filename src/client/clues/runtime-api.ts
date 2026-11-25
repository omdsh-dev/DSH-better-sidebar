/**
 * Typed client wrapper of the S2 runtime methods (S8 owns this file).
 *
 * Dependency/connection configuration must NOT invent a second store or RPC:
 * the handlers live on S1's ONE clue API seam (`CluesService.registerApi`,
 * registered by S2's `registerCluesRuntimeApi`) and are served by the plugin's
 * single fenced `/sidebar/api` transport. Status reads share the bounded clue
 * cache until an explicit refresh or the action that changes them invalidates
 * exactly that status family.
 * Envelope handling, reverse-proxy URL resolution and the `SidebarApiError`
 * code contract still stay in one place through the shared `call()`.
 *
 * Node-free by construction: the DTOs are imported TYPE-ONLY from S2's
 * node-free `clues/runtime/types.ts` (every `node:*` import lives in the
 * sibling runtime implementation files), so the browser bundle never pulls a
 * process module in.
 *
 * Secrets: these shapes are the sanitized projections (paths, versions,
 * stages, authorization prompts). Raw stdout/stderr, tokens, device-code
 * handles and host credential values never cross this wrapper by contract —
 * the UI must render only the named fields.
 */
import { call } from '../api.ts'
import {
  cachedClueRequest,
  invalidateClueRequests,
  invalidateClueRequestsForAuth,
  notifyClueDataChange,
  peekClueRequest,
} from './request-cache.ts'
import type {
  ConnectionStatusProjection,
  DependencyInstallPlan,
  DependencyInstallTask,
  DependencyStatus,
} from '../../clues/runtime/types.ts'

/** One dependency inspection request (both fields optional). */
export interface DependencyInspectInput {
  readonly dependencyId?: string
  /** Bypass S2's probe cache (the explicit "recheck" action). */
  readonly refresh?: boolean
}

/** The typed dependency/connection face consumed by the settings UI. */
export interface ClueRuntimeApi {
  /** `clues.dependencies.inspect` — probe (explicit request only; no timer). */
  dependenciesInspect(
    input?: DependencyInspectInput,
    signal?: AbortSignal,
  ): Promise<readonly DependencyStatus[]>
  /** `clues.dependencies.plan` — build an expiring install plan (never starts work). */
  dependenciesPlan(dependencyId: string, signal?: AbortSignal): Promise<DependencyInstallPlan>
  /** `clues.dependencies.start` — start the confirmed plan (human caller only). */
  dependenciesStart(
    dependencyId: string,
    planId: string,
    signal?: AbortSignal,
  ): Promise<DependencyInstallTask>
  /** `clues.dependencies.status` — latest task per dependency. */
  dependenciesStatus(
    dependencyId?: string,
    signal?: AbortSignal,
  ): Promise<readonly DependencyInstallTask[]>
  /** `clues.dependencies.cancel` — cancel the running install task. */
  dependenciesCancel(
    dependencyId: string,
    taskId?: string,
    signal?: AbortSignal,
  ): Promise<DependencyInstallTask>
  /** `clues.dependencies.setPath` — explicit executable override (highest precedence). */
  dependenciesSetPath(
    dependencyId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<DependencyStatus>
  /** `clues.dependencies.clearPath` — drop the override and re-resolve. */
  dependenciesClearPath(dependencyId: string, signal?: AbortSignal): Promise<DependencyStatus>
  /** `clues.connections.status` — explicit observation read (never a timer). */
  connectionsStatus(
    connectionId?: string,
    signal?: AbortSignal,
    refresh?: boolean,
  ): Promise<readonly ConnectionStatusProjection[]>
  /** `clues.connections.connect` — explicit user authorization action. */
  connectionsConnect(connectionId: string, signal?: AbortSignal, capabilities?: readonly string[]): Promise<ConnectionStatusProjection>
  /**
   * `clues.connections.poll` — one device-code check. The runtime never
   * schedules it; the settings page repeats this same call while the attempt
   * it started is authorizing (see SourceConfigPage's auto-check).
   */
  connectionsPoll(connectionId: string, signal?: AbortSignal): Promise<ConnectionStatusProjection>
  /** `clues.connections.cancel` — abandon the attempt, keep existing login state. */
  connectionsCancel(connectionId: string, signal?: AbortSignal): Promise<ConnectionStatusProjection>
}

/** Runtime actions can change CLI/auth access even when they fail partway through. */
const DEPENDENCY_READS = ['clues.dependencies.inspect'] as const
const CONNECTION_READS = ['clues.connections.status'] as const
const RUNTIME_STATUS_PREFIXES = ['clues.dependencies.', 'clues.connections.'] as const

/**
 * Auth identity/capability changes make every business body stale. Drop all
 * retained business families while keeping the runtime status families warm:
 * status checking itself must not cascade into a page-pack-library nuke.
 */
function invalidateBusinessReads(): void {
  // A business entry from the previous identity/executable is useless: abort
  // and reject attached pending readers now, not after the 5 s detach grace.
  invalidateClueRequestsForAuth(entry =>
    !RUNTIME_STATUS_PREFIXES.some(prefix => entry.method.startsWith(prefix)))
  // Cache first, event second: consumers that react immediately see empty
  // old-identity data and can fetch under the new identity.
  notifyClueDataChange({ kind: 'auth' })
}

/**
 * Stable account/authorization/capability identity of one connection. Volatile
 * observation fields (timestamps, prompts, display copy) are excluded so an
 * ordinary re-check of the SAME account keeps every business read warm.
 */
function connectionAuthSignature(connection: ConnectionStatusProjection): string {
  return JSON.stringify([
    connection.connectionId,
    connection.configuration,
    connection.authorization,
    connection.credentialOwner,
    connection.account ?? null,
    Array.isArray(connection.capabilities) ? [...connection.capabilities].sort() : [],
    connection.action,
    connection.error?.category ?? null,
  ])
}

/** Last observed auth identity per connection (module lifetime, bounded by ids). */
const connectionSignatures = new Map<string, string>()
/** Connections whose current auth failure was already reported to the bus. */
const connectionAuthFailures = new Set<string>()

/** Drop the auth baselines (new plugin activation or an isolated test). */
export function resetClueRuntimeAuthTracking(): void {
  connectionSignatures.clear()
  connectionAuthFailures.clear()
}

/** Only the FIRST auth-required observation of one connection publishes. */
function markAuthFailure(connectionId: string | undefined): boolean {
  const key = connectionId ?? '*'
  if (connectionAuthFailures.has(key)) return false
  connectionAuthFailures.add(key)
  return true
}

/**
 * Public observation hook for the runtime-state bus: a status published by
 * another view can be the first place an account/capability change is seen.
 */
export function observeClueConnectionStatuses(
  connections: readonly ConnectionStatusProjection[],
): boolean {
  return observeConnectionStatuses(connections)
}

/**
 * Observe fresh status projections. Returns true when an actual auth identity,
 * authorization or capability transition (or an auth-required observation)
 * happened; that is the only status-read case that evicts business bodies.
 */
function observeConnectionStatuses(connections: readonly ConnectionStatusProjection[]): boolean {
  if (!Array.isArray(connections)) return false
  let transition = false
  for (const connection of connections) {
    const signature = connectionAuthSignature(connection)
    const previous = connectionSignatures.get(connection.connectionId)
    connectionSignatures.set(connection.connectionId, signature)
    if (connection.error?.category === 'auth-required') {
      // A repeated auth-required status is the same failure: publish only the
      // first observation so a detail onAuth status refetch cannot loop.
      const firstFailure = previous === undefined || previous !== signature
      markAuthFailure(connection.connectionId)
      if (firstFailure) transition = true
    } else {
      connectionAuthFailures.delete(connection.connectionId)
      if (previous !== undefined && previous !== signature) transition = true
    }
  }
  if (transition) invalidateBusinessReads()
  return transition
}

/**
 * Invalidate exactly the runtime status family one action can change; explicit
 * auth/executable mutations additionally clear every business read because the
 * previously read data may belong to the old identity or executable.
 */
async function mutateRuntime<T>(
  method: string,
  payload: Record<string, unknown>,
  reads: readonly string[],
  signal?: AbortSignal,
  business = false,
): Promise<T> {
  try { return await call<T>(method, payload, signal) }
  finally {
    invalidateClueRequests(undefined, reads)
    if (business) invalidateBusinessReads()
  }
}

/** Synchronous peek of one cached dependency inspection (no probe). */
export function peekClueDependencies(
  dependencyId?: string,
): readonly DependencyStatus[] | undefined {
  const payload: Record<string, unknown> = {}
  if (dependencyId !== undefined) payload.dependencyId = dependencyId
  return peekClueRequest<readonly DependencyStatus[]>('clues.dependencies.inspect', undefined, payload)
}

/** Synchronous peek of one cached connection observation (no probe). */
export function peekClueConnections(
  connectionId?: string,
): readonly ConnectionStatusProjection[] | undefined {
  const payload: Record<string, unknown> = {}
  if (connectionId !== undefined) payload.connectionId = connectionId
  return peekClueRequest<readonly ConnectionStatusProjection[]>('clues.connections.status', undefined, payload)
}

/** The single instance shares read freshness through the bounded clue cache. */
export const clueRuntimeApi: ClueRuntimeApi = {
  async dependenciesInspect(input, signal) {
    const payload: Record<string, unknown> = {}
    if (input?.dependencyId !== undefined) payload.dependencyId = input.dependencyId
    const refresh = input?.refresh === true
    return cachedClueRequest('clues.dependencies.inspect', undefined, payload, async wireSignal => {
      const result = await call<{ dependencies: readonly DependencyStatus[] }>(
        'clues.dependencies.inspect',
        refresh ? { ...payload, refresh: true } : payload,
        wireSignal,
      )
      return result.dependencies
    }, signal, { force: refresh })
  },

  async dependenciesPlan(dependencyId, signal) {
    const result = await call<{ plan: DependencyInstallPlan }>(
      'clues.dependencies.plan',
      { dependencyId },
      signal,
    )
    return result.plan
  },

  async dependenciesStart(dependencyId, planId, signal) {
    const result = await mutateRuntime<{ task: DependencyInstallTask }>(
      'clues.dependencies.start',
      { dependencyId, planId },
      DEPENDENCY_READS,
      signal,
    )
    return result.task
  },

  async dependenciesStatus(dependencyId, signal) {
    const payload: Record<string, unknown> = {}
    if (dependencyId !== undefined) payload.dependencyId = dependencyId
    const result = await call<{ tasks: readonly DependencyInstallTask[] }>(
      'clues.dependencies.status',
      payload,
      signal,
    )
    return result.tasks
  },

  async dependenciesCancel(dependencyId, taskId, signal) {
    const payload: Record<string, unknown> = { dependencyId }
    if (taskId !== undefined) payload.taskId = taskId
    const result = await mutateRuntime<{ task: DependencyInstallTask }>(
      'clues.dependencies.cancel',
      payload,
      DEPENDENCY_READS,
      signal,
    )
    return result.task
  },

  async dependenciesSetPath(dependencyId, path, signal) {
    const result = await mutateRuntime<{ dependency: DependencyStatus }>(
      'clues.dependencies.setPath',
      { dependencyId, path },
      DEPENDENCY_READS,
      signal,
      // The executable backing a source changed: keep no business body that
      // might have been produced by the previous binary.
      true,
    )
    return result.dependency
  },

  async dependenciesClearPath(dependencyId, signal) {
    const result = await mutateRuntime<{ dependency: DependencyStatus }>(
      'clues.dependencies.clearPath',
      { dependencyId },
      DEPENDENCY_READS,
      signal,
      true,
    )
    return result.dependency
  },

  async connectionsStatus(connectionId, signal, refresh = false) {
    const payload: Record<string, unknown> = {}
    if (connectionId !== undefined) payload.connectionId = connectionId
    return cachedClueRequest('clues.connections.status', undefined, payload, async wireSignal => {
      try {
        const result = await call<{ connections: readonly ConnectionStatusProjection[] }>(
          'clues.connections.status',
          payload,
          wireSignal,
        )
        observeConnectionStatuses(result.connections)
        connectionAuthFailures.delete('*')
        return result.connections
      } catch (error) {
        // A failed auth observation invalidates bodies read under the old
        // identity instead of letting the next account reuse them. Only the
        // first failure publishes; a status retry must not echo the auth event.
        if ((error as { code?: string } | undefined)?.code === 'auth-required') {
          const key = typeof payload.connectionId === 'string' ? payload.connectionId : '*'
          if (markAuthFailure(key)) invalidateBusinessReads()
        }
        throw error
      }
    }, signal, { force: refresh })
  },

  async connectionsConnect(connectionId, signal, capabilities) {
    const result = await mutateRuntime<{ connection: ConnectionStatusProjection }>(
      'clues.connections.connect',
      { connectionId, ...(capabilities === undefined ? {} : { capabilities }) },
      CONNECTION_READS,
      signal,
      // The explicit connect/reconnect gesture may target another account;
      // never let the new account observe the old account's cached bodies.
      true,
    )
    observeConnectionStatuses([result.connection])
    return result.connection
  },

  async connectionsPoll(connectionId, signal) {
    try {
      const result = await mutateRuntime<{ connection: ConnectionStatusProjection }>(
        'clues.connections.poll',
        { connectionId },
        CONNECTION_READS,
        signal,
      )
      // A completed poll evicts only when the identity/capability actually
      // changed; repeated polling of the same ready account stays warm.
      observeConnectionStatuses([result.connection])
      return result.connection
    } catch (error) {
      // An expired/required auth poll is an identity boundary exactly like an
      // auth-required status read. The first failure publishes; retries do not.
      if ((error as { code?: string } | undefined)?.code === 'auth-required'
        && markAuthFailure(connectionId)) {
        invalidateBusinessReads()
      }
      throw error
    }
  },

  async connectionsCancel(connectionId, signal) {
    const result = await mutateRuntime<{ connection: ConnectionStatusProjection }>(
      'clues.connections.cancel',
      { connectionId },
      CONNECTION_READS,
      signal,
      // Cancelling/abandoning an authorization attempt is an explicit auth
      // lifecycle change; conservative eviction is cheaper than old-account data.
      true,
    )
    observeConnectionStatuses([result.connection])
    return result.connection
  },
}
