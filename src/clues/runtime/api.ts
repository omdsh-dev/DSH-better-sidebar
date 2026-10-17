/**
 * `clues.dependencies.*` / `clues.connections.*`: the S2 wire methods.
 *
 * These handlers are registered on the S1 service's ONE API seam
 * ({@link CluesService.registerApi}); the plugin's existing `/sidebar/api`
 * dispatcher serves them, so S2 adds no HTTP route and no Agent tool.
 *
 * The payload is validated HERE so a malformed request fails as a typed
 * `invalid-request` before it reaches a process, a plan or a connection. The
 * caller identity comes from the API context: every install/authorization
 * MUTATION refuses an agent caller (`permission-denied`) — the approved spec
 * gives agents no write or install interface. Read-only inspection remains
 * available for diagnostics.
 */
import { ClueError } from '../types.ts'
import type { ClueApiContext, ClueApiHandler } from '../types.ts'
import type { CluesService } from '../service.ts'
import type { ClueRuntime, DependencyInstallPlan, DependencyInstallTask, DependencyStatus, ConnectionStatusProjection } from './types.ts'

/** Every API method name this module registers (single source for tests). */
export const CLUES_RUNTIME_API_METHODS = [
  'clues.dependencies.inspect',
  'clues.dependencies.plan',
  'clues.dependencies.start',
  'clues.dependencies.status',
  'clues.dependencies.cancel',
  'clues.dependencies.setPath',
  'clues.dependencies.clearPath',
  'clues.connections.status',
  'clues.connections.connect',
  'clues.connections.poll',
  'clues.connections.cancel',
] as const

/** One API method name. */
export type CluesRuntimeApiMethod = (typeof CLUES_RUNTIME_API_METHODS)[number]

type Payload = Record<string, unknown>

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Payload {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The payload object or a typed failure. */
function requireRecord(payload: unknown): Payload {
  if (!isRecord(payload)) throw new ClueError('invalid-request', 'the clue runtime request payload must be a JSON object')
  return payload
}

/** One required, non-empty string field. */
function requireString(payload: Payload, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClueError('invalid-request', `"${key}" must be a non-empty string`)
  }
  return value
}

/** One optional, non-empty string field. */
function optionalString(payload: Payload, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClueError('invalid-request', `"${key}" must be a non-empty string`)
  }
  return value
}

/** Refuse a mutating runtime action requested by an agent context. */
function requireHuman(context: ClueApiContext, what: string): void {
  if (context.caller === 'agent') {
    throw new ClueError('permission-denied', `${what} is available only to an interactive user request`)
  }
}

/** Forward the caller signal to the runtime. */
function signalOf(context: ClueApiContext): { readonly signal?: AbortSignal } {
  return context.signal === undefined ? {} : { signal: context.signal }
}

/** The request payload's dependency id. */
function dependencyIdOf(payload: unknown): string {
  return requireString(requireRecord(payload), 'dependencyId')
}

/**
 * Build every S2 API handler over one installed runtime.
 * @param runtime - the dependency/connection/transport runtime.
 */
export function cluesRuntimeApiHandlers(runtime: ClueRuntime): Record<CluesRuntimeApiMethod, ClueApiHandler> {
  return {
    'clues.dependencies.inspect': async (payload, context) => {
      const record = requireRecord(payload)
      const dependencyId = optionalString(record, 'dependencyId')
      const dependencies: readonly DependencyStatus[] = await runtime.dependencies.inspect(
        dependencyId,
        { ...signalOf(context), ...(record.refresh === true ? { refresh: true } : {}) },
      )
      return { dependencies }
    },

    'clues.dependencies.plan': async (payload, context) => {
      requireHuman(context, 'dependency installation planning')
      const plan: DependencyInstallPlan = await runtime.dependencies.plan(
        dependencyIdOf(payload),
        signalOf(context),
      )
      return { plan }
    },

    'clues.dependencies.start': async (payload, context) => {
      requireHuman(context, 'dependency installation')
      const record = requireRecord(payload)
      const task: DependencyInstallTask = await runtime.dependencies.start(
        {
          dependencyId: requireString(record, 'dependencyId'),
          planId: requireString(record, 'planId'),
        },
        signalOf(context),
      )
      return { task }
    },

    'clues.dependencies.status': async (payload) => {
      const record = requireRecord(payload)
      const dependencyId = optionalString(record, 'dependencyId')
      if (dependencyId !== undefined && runtime.dependencies.getDefinition(dependencyId) === undefined) {
        throw new ClueError('not-found', `dependency "${dependencyId}" is not registered`)
      }
      const tasks: readonly DependencyInstallTask[] = runtime.dependencies.tasks(dependencyId)
      return { tasks }
    },

    'clues.dependencies.cancel': async (payload, context) => {
      requireHuman(context, 'dependency installation cancellation')
      const record = requireRecord(payload)
      const task: DependencyInstallTask = await runtime.dependencies.cancel(
        requireString(record, 'dependencyId'),
        optionalString(record, 'taskId'),
        signalOf(context),
      )
      return { task }
    },

    'clues.dependencies.setPath': async (payload, context) => {
      requireHuman(context, 'dependency path configuration')
      const record = requireRecord(payload)
      const dependency: DependencyStatus = await runtime.dependencies.setManualPath(
        requireString(record, 'dependencyId'),
        requireString(record, 'path'),
      )
      return { dependency }
    },

    'clues.dependencies.clearPath': async (payload, context) => {
      requireHuman(context, 'dependency path configuration')
      const dependency: DependencyStatus = await runtime.dependencies.clearManualPath(
        dependencyIdOf(payload),
      )
      return { dependency }
    },

    'clues.connections.status': async (payload, context) => {
      const record = requireRecord(payload)
      const connectionId = optionalString(record, 'connectionId')
      const connections: readonly ConnectionStatusProjection[] = await runtime.connections.status(
        connectionId,
        signalOf(context),
      )
      return { connections }
    },

    'clues.connections.connect': async (payload, context) => {
      requireHuman(context, 'connection authorization')
      const connection: ConnectionStatusProjection = await runtime.connections.connect(
        requireString(requireRecord(payload), 'connectionId'),
        signalOf(context),
      )
      return { connection }
    },

    'clues.connections.poll': async (payload, context) => {
      requireHuman(context, 'connection authorization polling')
      const connection: ConnectionStatusProjection = await runtime.connections.poll(
        requireString(requireRecord(payload), 'connectionId'),
        signalOf(context),
      )
      return { connection }
    },

    'clues.connections.cancel': async (payload, context) => {
      requireHuman(context, 'connection authorization cancellation')
      const connection: ConnectionStatusProjection = await runtime.connections.cancel(
        requireString(requireRecord(payload), 'connectionId'),
        signalOf(context),
      )
      return { connection }
    },
  }
}

/**
 * Register every S2 method on the clue service's API seam.
 * @param clues - the host clue service.
 * @param runtime - the installed runtime.
 * @returns a disposer removing exactly these registrations.
 */
export function registerCluesRuntimeApi(clues: CluesService, runtime: ClueRuntime): () => void {
  const disposers = Object.entries(cluesRuntimeApiHandlers(runtime)).map(([name, handler]) =>
    clues.registerApi(name, handler))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
