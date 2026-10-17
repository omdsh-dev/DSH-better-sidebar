/**
 * The S2 connection runtime.
 *
 * A connection has TWO independent facts (approved spec §5): application
 * `configuration` and user `authorization`. Installing a CLI or finishing the
 * application configuration never makes the projection `ready`; only an
 * adapter observation (`inspect`, an explicit poll, or `report` from a normal
 * resource request) can.
 *
 * Lifecycle rules implemented here:
 * - `inspect` runs ONLY for an explicit status request — this module schedules
 *   no timer, no interval and no background auth probe. A normal resource
 *   request updates state through `report` instead;
 * - authorization starts ONLY from an explicit `connect`; the machine handle
 *   (`authorizationId` / adapter `state` / device code) stays host-side and is
 *   never projected. The human URL/QR payload is copied opaquely (never parsed
 *   or re-encoded) and the QR payload is the same string for a client encoder;
 * - `poll` is explicit request/response for device-code flows; an expired
 *   attempt is reported as `expired` and cleared, not retried automatically;
 * - `cancel` clears the attempt and calls the adapter's cancellation, then
 *   re-projects the cached observation without performing a new auth probe;
 * - denied, expired and scope-insufficient stay distinct, and a failed
 *   observation renders as a sanitized `error` row instead of hiding the whole
 *   settings page.
 */
import { ClueError, isClueError } from '../types.ts'
import type { JsonValue } from '../types.ts'
import type {
  ClueConnectionDefinition,
  ConnectionAction,
  ConnectionAdapterContext,
  ConnectionAuthorizationPrompt,
  ConnectionAuthorizationState,
  ConnectionConfigurationState,
  ConnectionInspection,
  ConnectionStatusProjection,
  RuntimeErrorInfo,
} from './types.ts'

/** Default lifetime of one in-flight authorization attempt (device codes expire sooner). */
export const DEFAULT_AUTHORIZATION_TTL_MS = 10 * 60 * 1000

/** Host credential resolver seam (per operation, never cached here). */
export type ConnectionCredentialResolver = (ref: string) => Promise<string | undefined>

/** Options of {@link createConnectionsRuntime}. */
export interface ConnectionsRuntimeOptions {
  /** Explicit status read / no timer. Omitted disables credential resolution. */
  readonly resolveCredential?: ConnectionCredentialResolver
  readonly now?: () => number
  readonly newId?: () => string
  readonly defaultAuthorizationTtlMs?: number
}

/** One live authorization attempt (host-side only). */
interface AuthorizationSession {
  readonly authorizationId: string
  readonly state?: JsonValue
  prompt?: ConnectionAuthorizationPrompt
  readonly expiresAt: number
}

/** The connection runtime face consumed by `ClueRuntime` and source adapters. */
export interface ConnectionsRuntime {
  register(definition: ClueConnectionDefinition): () => void
  getDefinition(connectionId: string): ClueConnectionDefinition | undefined
  getDefinitions(): readonly ClueConnectionDefinition[]
  status(connectionId?: string, options?: { readonly signal?: AbortSignal }): Promise<readonly ConnectionStatusProjection[]>
  connect(connectionId: string, options?: { readonly signal?: AbortSignal }): Promise<ConnectionStatusProjection>
  poll(connectionId: string, options?: { readonly signal?: AbortSignal }): Promise<ConnectionStatusProjection>
  cancel(connectionId: string, options?: { readonly signal?: AbortSignal }): Promise<ConnectionStatusProjection>
  report(connectionId: string, inspection: ConnectionInspection): void
  dispose(): void
}

/** Whether an optional signal has been aborted (opaque to TS narrowing). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

const CONFIGURATION_STATES: ReadonlySet<string> = new Set(['unknown', 'missing', 'ready', 'not-required'])
const AUTHORIZATION_STATES: ReadonlySet<string> = new Set([
  'unknown',
  'not-authorized',
  'authorizing',
  'ready',
  'expired',
  'denied',
  'scope-insufficient',
])
const CREDENTIAL_OWNERS: ReadonlySet<string> = new Set(['host-credentials', 'tool', 'mcp', 'none'])

/** Normalize one adapter observation; unknown enum values degrade to `unknown`. */
function normalizeInspection(value: ConnectionInspection | undefined): ConnectionInspection | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const configuration = CONFIGURATION_STATES.has(value.configuration) ? value.configuration : 'unknown'
  const authorization = AUTHORIZATION_STATES.has(value.authorization) ? value.authorization : 'unknown'
  return {
    configuration: configuration as ConnectionConfigurationState,
    authorization: authorization as ConnectionAuthorizationState,
    ...(typeof value.account === 'string' && value.account !== '' ? { account: value.account } : {}),
    ...(Array.isArray(value.capabilities)
      ? { capabilities: value.capabilities.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
    ...(typeof value.detail === 'string' && value.detail !== '' ? { detail: value.detail } : {}),
  }
}

/** Sanitized adapter failure (never carries a raw response body or token). */
function normalizeConnectionError(error: unknown, what: string): RuntimeErrorInfo {
  if (isClueError(error)) return { category: error.category, message: error.message }
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return {
      category: name === 'TimeoutError' ? 'timeout' : 'cancelled',
      message: `the connection ${what} was cancelled`,
    }
  }
  return { category: 'failed', message: `the connection ${what} failed` }
}

/** Copy the human prompt (URL and QR payloads stay byte-for-byte opaque). */
function copyPrompt(prompt: ConnectionAuthorizationPrompt): ConnectionAuthorizationPrompt {
  return {
    ...prompt,
    ...(prompt.qr === undefined ? {} : { qr: { ...prompt.qr } }),
  }
}

/** Parse the prompt expiry, tolerating an adapter that omits/garbles it. */
function promptExpiry(prompt: ConnectionAuthorizationPrompt | undefined, fallback: number): number {
  if (prompt?.expiresAt !== undefined) {
    const parsed = Date.parse(prompt.expiresAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** The next human action for one projection state. */
function actionFor(
  configuration: ConnectionConfigurationState,
  authorization: ConnectionAuthorizationState,
): ConnectionAction {
  if (configuration === 'missing') return 'configure'
  if (authorization === 'not-authorized') return 'connect'
  if (authorization === 'unknown' && configuration === 'ready') return 'connect'
  if (authorization === 'expired' || authorization === 'denied') return 'reconnect'
  if (authorization === 'scope-insufficient') return 'grant-scope'
  return 'none'
}

/** Deep-enough copy of a trusted definition. */
function copyDefinition(definition: ClueConnectionDefinition): ClueConnectionDefinition {
  return {
    ...definition,
    ...(definition.capabilities === undefined ? {} : { capabilities: [...definition.capabilities] }),
  }
}

/** Programming-error validation of a trusted definition (registration time). */
function validateDefinition(definition: ClueConnectionDefinition): void {
  if (typeof definition.connectionId !== 'string' || definition.connectionId.trim() === '') {
    throw new Error('[clues] a connection registration needs a non-empty connectionId')
  }
  if (typeof definition.name !== 'string' || definition.name.trim() === '') {
    throw new Error(`[clues] connection "${definition.connectionId}" needs a non-empty name`)
  }
  if (typeof definition.pluginId !== 'string' || definition.pluginId.trim() === '') {
    throw new Error(`[clues] connection "${definition.connectionId}" needs a pluginId`)
  }
  if (definition.configuration !== 'required' && definition.configuration !== 'not-required') {
    throw new Error(`[clues] connection "${definition.connectionId}" needs a configuration mode`)
  }
  if (!CREDENTIAL_OWNERS.has(definition.credentialOwner)) {
    throw new Error(`[clues] connection "${definition.connectionId}" has an unknown credential owner`)
  }
  if (typeof definition.inspect !== 'function') {
    throw new Error(`[clues] connection "${definition.connectionId}" needs an inspect function`)
  }
}

/**
 * Create the connection runtime.
 * @param options - per-operation credential resolver + clock seams.
 */
export function createConnectionsRuntime(options: ConnectionsRuntimeOptions = {}): ConnectionsRuntime {
  const now = options.now ?? (() => Date.now())
  const defaultTtl = options.defaultAuthorizationTtlMs ?? DEFAULT_AUTHORIZATION_TTL_MS
  let sequence = 0
  const newId = options.newId ?? (() => `auth-${now().toString(36)}-${++sequence}`)
  const definitions = new Map<string, ClueConnectionDefinition>()
  const sessions = new Map<string, AuthorizationSession>()
  const observations = new Map<string, ConnectionInspection>()
  let disposed = false

  const iso = (): string => new Date(now()).toISOString()

  const requireDefinition = (connectionId: string): ClueConnectionDefinition => {
    const definition = definitions.get(connectionId)
    if (definition === undefined) {
      throw new ClueError('not-found', `connection "${connectionId}" is not registered`)
    }
    return definition
  }

  const adapterContext = (
    definition: ClueConnectionDefinition,
    signal: AbortSignal | undefined,
  ): ConnectionAdapterContext => ({
    ...(signal === undefined ? {} : { signal }),
    now: iso,
    async resolveCredential(ref: string): Promise<string | undefined> {
      if (options.resolveCredential === undefined) return undefined
      return await options.resolveCredential(ref)
    },
    report(inspection: ConnectionInspection): void {
      const normalized = normalizeInspection(inspection)
      if (normalized !== undefined) observations.set(definition.connectionId, normalized)
    },
  })

  const activeSession = (connectionId: string): AuthorizationSession | undefined => {
    const session = sessions.get(connectionId)
    if (session === undefined) return undefined
    if (session.expiresAt <= now()) {
      sessions.delete(connectionId)
      return undefined
    }
    return session
  }

  const project = (
    definition: ClueConnectionDefinition,
    inspection: ConnectionInspection | undefined,
    extras: {
      readonly session?: AuthorizationSession
      readonly expired?: boolean
      readonly error?: RuntimeErrorInfo
    } = {},
  ): ConnectionStatusProjection => {
    const configuration = inspection?.configuration
      ?? (definition.configuration === 'not-required' ? 'not-required' : 'unknown')
    let authorization = inspection?.authorization ?? 'unknown'
    let prompt: ConnectionAuthorizationPrompt | undefined
    if (extras.session !== undefined) {
      authorization = 'authorizing'
      if (extras.session.prompt !== undefined) prompt = copyPrompt(extras.session.prompt)
    } else if (
      extras.expired === true
      && authorization !== 'ready'
      && authorization !== 'denied'
      && authorization !== 'scope-insufficient'
    ) {
      authorization = 'expired'
    }
    const capabilities = inspection?.capabilities
      ?? (definition.capabilities === undefined ? [] : [...definition.capabilities])
    return {
      connectionId: definition.connectionId,
      name: definition.name,
      pluginId: definition.pluginId,
      configuration,
      authorization,
      credentialOwner: definition.credentialOwner,
      capabilities,
      ...(inspection?.account === undefined ? {} : { account: inspection.account }),
      ...(inspection?.detail === undefined ? {} : { detail: inspection.detail }),
      action: actionFor(configuration, authorization),
      ...(prompt === undefined ? {} : { prompt }),
      lastCheckedAt: iso(),
      ...(extras.error === undefined ? {} : { error: extras.error }),
    }
  }

  /** Explicit status: the ONLY path that calls `inspect` (never on a timer). */
  const statusOne = async (
    definition: ClueConnectionDefinition,
    signal: AbortSignal | undefined,
  ): Promise<ConnectionStatusProjection> => {
    if (isAborted(signal)) throw new ClueError('cancelled', 'the connection status request was cancelled')
    const hadSession = sessions.has(definition.connectionId)
    const session = activeSession(definition.connectionId)
    const sessionExpired = hadSession && session === undefined
    if (session !== undefined) {
      // While an explicit authorization attempt is in flight there is no
      // status probe: the prompt is the state, and polling is user-driven.
      return project(definition, observations.get(definition.connectionId), { session })
    }
    let inspection = observations.get(definition.connectionId)
    let error: RuntimeErrorInfo | undefined
    try {
      const observed = await definition.inspect({ ...(signal === undefined ? {} : { signal }) }, adapterContext(definition, signal))
      const normalized = normalizeInspection(observed)
      if (normalized !== undefined) {
        observations.set(definition.connectionId, normalized)
        inspection = normalized
      }
    } catch (caught) {
      if (isAborted(signal)) throw new ClueError('cancelled', 'the connection status request was cancelled')
      error = normalizeConnectionError(caught, 'status check')
    }
    return project(definition, inspection, {
      ...(error === undefined ? {} : { error }),
      ...(sessionExpired ? { expired: true } : {}),
    })
  }

  const status = async (
    connectionId?: string,
    statusOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly ConnectionStatusProjection[]> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    const targets = connectionId === undefined
      ? [...definitions.values()]
      : [requireDefinition(connectionId)]
    const rows: ConnectionStatusProjection[] = []
    for (const definition of targets) rows.push(await statusOne(definition, statusOptions.signal))
    return rows
  }

  const connect = async (
    connectionId: string,
    connectOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionStatusProjection> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    const definition = requireDefinition(connectionId)
    if (isAborted(connectOptions.signal)) throw new ClueError('cancelled', 'the connection request was cancelled')
    const existing = activeSession(connectionId)
    if (existing !== undefined) {
      // Repeated clicks share the SAME attempt; they must not start a second
      // device-code flow or fight over the adapter's state.
      return project(definition, observations.get(connectionId), { session: existing })
    }
    if (definition.connect === undefined) {
      throw new ClueError('unsupported', `connection "${definition.name}" has no interactive authorization`)
    }
    let result
    try {
      result = await definition.connect(
        { ...(connectOptions.signal === undefined ? {} : { signal: connectOptions.signal }) },
        adapterContext(definition, connectOptions.signal),
      )
    } catch (caught) {
      if (isAborted(connectOptions.signal)) throw new ClueError('cancelled', 'the connection request was cancelled')
      const info = normalizeConnectionError(caught, 'authorization start')
      throw new ClueError(info.category, info.message)
    }
    if (isAborted(connectOptions.signal)) throw new ClueError('cancelled', 'the connection request was cancelled')
    const observed = normalizeInspection(result.inspection)
    if (observed !== undefined) observations.set(connectionId, observed)
    const inspection = observations.get(connectionId)
    const configuration = observed?.configuration
      ?? inspection?.configuration
      ?? (definition.configuration === 'not-required' ? 'not-required' : 'unknown')
    // Configuration comes first: a missing application configuration never
    // leaves the projection in an authorizing state.
    if (definition.configuration === 'required' && configuration === 'missing') {
      return project(definition, inspection)
    }
    const prompt = result.prompt === undefined ? undefined : copyPrompt(result.prompt)
    const authorizationId = result.authorizationId
      ?? (prompt === undefined ? undefined : newId())
    if (authorizationId !== undefined) {
      sessions.set(connectionId, {
        authorizationId,
        ...(result.state === undefined ? {} : { state: result.state }),
        ...(prompt === undefined ? {} : { prompt }),
        expiresAt: promptExpiry(prompt, now() + defaultTtl),
      })
    }
    return project(definition, inspection, {
      ...(authorizationId === undefined ? {} : { session: sessions.get(connectionId) }),
    })
  }

  const poll = async (
    connectionId: string,
    pollOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionStatusProjection> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    const definition = requireDefinition(connectionId)
    const session = sessions.get(connectionId)
    if (session === undefined) {
      throw new ClueError('conflict', `connection "${definition.name}" has no authorization in progress`)
    }
    if (isAborted(pollOptions.signal)) throw new ClueError('cancelled', 'the authorization poll was cancelled')
    if (session.expiresAt <= now()) {
      sessions.delete(connectionId)
      // Expiry is a terminal fact of this attempt; the next explicit status
      // request may inspect again, but the poll itself never retries.
      return project(definition, observations.get(connectionId), { expired: true })
    }
    if (definition.poll === undefined) {
      return project(definition, observations.get(connectionId), { session })
    }
    let result
    try {
      result = await definition.poll({
        authorizationId: session.authorizationId,
        ...(session.state === undefined ? {} : { state: session.state }),
        ...(session.prompt === undefined ? {} : { prompt: session.prompt }),
        ...(pollOptions.signal === undefined ? {} : { signal: pollOptions.signal }),
      }, adapterContext(definition, pollOptions.signal))
    } catch (caught) {
      if (isAborted(pollOptions.signal)) throw new ClueError('cancelled', 'the authorization poll was cancelled')
      const info = normalizeConnectionError(caught, 'authorization poll')
      throw new ClueError(info.category, info.message)
    }
    if (isAborted(pollOptions.signal)) throw new ClueError('cancelled', 'the authorization poll was cancelled')
    const observed = normalizeInspection(result.inspection)
    if (observed !== undefined) observations.set(connectionId, observed)
    if (result.prompt !== undefined) session.prompt = copyPrompt(result.prompt)
    const authorization = observed?.authorization
    const terminal = result.complete === true
      || authorization === 'ready'
      || authorization === 'denied'
      || authorization === 'expired'
      || authorization === 'scope-insufficient'
    if (terminal) sessions.delete(connectionId)
    return project(definition, observations.get(connectionId), {
      ...(terminal ? {} : { session }),
    })
  }

  const cancel = async (
    connectionId: string,
    cancelOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionStatusProjection> => {
    if (disposed) throw new ClueError('failed', 'the clue runtime has been disposed')
    const definition = requireDefinition(connectionId)
    const session = sessions.get(connectionId)
    if (session === undefined) return await statusOne(definition, cancelOptions.signal)
    let error: RuntimeErrorInfo | undefined
    if (definition.cancel !== undefined) {
      try {
        await definition.cancel({
          authorizationId: session.authorizationId,
          ...(session.state === undefined ? {} : { state: session.state }),
          ...(cancelOptions.signal === undefined ? {} : { signal: cancelOptions.signal }),
        }, adapterContext(definition, cancelOptions.signal))
      } catch (caught) {
        error = normalizeConnectionError(caught, 'authorization cancellation')
      }
    }
    sessions.delete(connectionId)
    if (error !== undefined) {
      throw new ClueError(error.category, error.message)
    }
    // No new auth probe after cancellation: project the last observation. With
    // no observation yet, a cancelled attempt is a KNOWN not-authorized state —
    // never a fabricated `ready`.
    if (observations.get(connectionId) === undefined) {
      observations.set(connectionId, {
        configuration: definition.configuration === 'not-required' ? 'not-required' : 'unknown',
        authorization: 'not-authorized',
      })
    }
    return project(definition, observations.get(connectionId))
  }

  return {
    register(definition: ClueConnectionDefinition): () => void {
      if (disposed) throw new Error('[clues] cannot register a connection on a disposed runtime')
      validateDefinition(definition)
      if (definitions.has(definition.connectionId)) {
        throw new Error(`[clues] connection "${definition.connectionId}" is already registered`)
      }
      const stored = copyDefinition(definition)
      definitions.set(stored.connectionId, stored)
      return () => {
        if (definitions.get(stored.connectionId) !== stored) return
        definitions.delete(stored.connectionId)
        sessions.delete(stored.connectionId)
        observations.delete(stored.connectionId)
      }
    },
    getDefinition(connectionId: string): ClueConnectionDefinition | undefined {
      const definition = definitions.get(connectionId)
      return definition === undefined ? undefined : copyDefinition(definition)
    },
    getDefinitions(): readonly ClueConnectionDefinition[] {
      return [...definitions.values()].map(copyDefinition)
    },
    status,
    connect,
    poll,
    cancel,
    report(connectionId: string, inspection: ConnectionInspection): void {
      requireDefinition(connectionId)
      const normalized = normalizeInspection(inspection)
      if (normalized === undefined) return
      observations.set(connectionId, normalized)
      // A real resource request is authoritative: a terminal observation ends
      // any stale device-code attempt instead of keeping the UI in authorizing.
      if (
        normalized.authorization === 'ready'
        || normalized.authorization === 'denied'
        || normalized.authorization === 'expired'
        || normalized.authorization === 'scope-insufficient'
      ) {
        sessions.delete(connectionId)
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      definitions.clear()
      sessions.clear()
      observations.clear()
    },
  }
}
