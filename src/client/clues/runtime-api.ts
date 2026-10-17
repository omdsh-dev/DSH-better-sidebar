/**
 * Typed client wrapper of the S2 runtime methods (S8 owns this file).
 *
 * Dependency/connection configuration must NOT invent a second store or RPC:
 * the handlers live on S1's ONE clue API seam (`CluesService.registerApi`,
 * registered by S2's `registerCluesRuntimeApi`) and are served by the plugin's
 * single fenced `/sidebar/api` transport. This module only names the methods,
 * types their payloads/results and routes them through the shared `call()`, so
 * envelope handling, reverse-proxy URL resolution and the `SidebarApiError`
 * code contract stay in one place.
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
  ): Promise<readonly ConnectionStatusProjection[]>
  /** `clues.connections.connect` — explicit user authorization action. */
  connectionsConnect(connectionId: string, signal?: AbortSignal): Promise<ConnectionStatusProjection>
  /** `clues.connections.poll` — explicit device-code check (never scheduled). */
  connectionsPoll(connectionId: string, signal?: AbortSignal): Promise<ConnectionStatusProjection>
  /** `clues.connections.cancel` — abandon the attempt, keep existing login state. */
  connectionsCancel(connectionId: string, signal?: AbortSignal): Promise<ConnectionStatusProjection>
}

/** The single stateless instance (safe to share across views). */
export const clueRuntimeApi: ClueRuntimeApi = {
  async dependenciesInspect(input, signal) {
    const payload: Record<string, unknown> = {}
    if (input?.dependencyId !== undefined) payload.dependencyId = input.dependencyId
    if (input?.refresh === true) payload.refresh = true
    const result = await call<{ dependencies: readonly DependencyStatus[] }>(
      'clues.dependencies.inspect',
      payload,
      signal,
    )
    return result.dependencies
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
    const result = await call<{ task: DependencyInstallTask }>(
      'clues.dependencies.start',
      { dependencyId, planId },
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
    const result = await call<{ task: DependencyInstallTask }>(
      'clues.dependencies.cancel',
      payload,
      signal,
    )
    return result.task
  },

  async dependenciesSetPath(dependencyId, path, signal) {
    const result = await call<{ dependency: DependencyStatus }>(
      'clues.dependencies.setPath',
      { dependencyId, path },
      signal,
    )
    return result.dependency
  },

  async dependenciesClearPath(dependencyId, signal) {
    const result = await call<{ dependency: DependencyStatus }>(
      'clues.dependencies.clearPath',
      { dependencyId },
      signal,
    )
    return result.dependency
  },

  async connectionsStatus(connectionId, signal) {
    const payload: Record<string, unknown> = {}
    if (connectionId !== undefined) payload.connectionId = connectionId
    const result = await call<{ connections: readonly ConnectionStatusProjection[] }>(
      'clues.connections.status',
      payload,
      signal,
    )
    return result.connections
  },

  async connectionsConnect(connectionId, signal) {
    const result = await call<{ connection: ConnectionStatusProjection }>(
      'clues.connections.connect',
      { connectionId },
      signal,
    )
    return result.connection
  },

  async connectionsPoll(connectionId, signal) {
    const result = await call<{ connection: ConnectionStatusProjection }>(
      'clues.connections.poll',
      { connectionId },
      signal,
    )
    return result.connection
  },

  async connectionsCancel(connectionId, signal) {
    const result = await call<{ connection: ConnectionStatusProjection }>(
      'clues.connections.cancel',
      { connectionId },
      signal,
    )
    return result.connection
  },
}
