/**
 * The clue service: the host-authoritative registry and domain operations of
 * S1 (published as the Cordis service `betterSidebarClues`).
 *
 * Responsibilities:
 * - **registration** — sources register their descriptor, type descriptors and
 *   operations through one API; duplicates are rejected explicitly, the
 *   returned disposer only removes runtime capability (never persisted data),
 *   so re-registering the same source id restores resolution of every existing
 *   reference;
 * - **dispatch** — resolve/list/search/read/loadEdit/saveEdit/portable are
 *   routed to the owning source with an abort signal and the caller identity;
 *   errors are normalized to the fixed {@link ClueError} categories without
 *   ever echoing transport output, tokens or environment secrets;
 * - **stable identity** — `ensureClue` is the only place that mints a durable
 *   reference: the source normalizes the locator, the normalized locator is
 *   the equality key, and re-ensuring the same resource returns the SAME id
 *   (the store's per-workspace transaction makes that true under concurrency);
 * - **library semantics** — pins and bindings are shortcut relations, packs are
 *   de-duplicated member sets; removing any of them never deletes a clue, and
 *   deleting a pack only removes that pack (its members and their other pack
 *   memberships stay);
 * - **extension seam** — later specs register their own API methods with
 *   {@link CluesService.registerApi}; the index.ts dispatcher always falls back
 *   here, so those specs never touch the dispatcher.
 */
import { randomUUID } from 'node:crypto'
import { CluesStore, type WorkspaceState } from './store.ts'
import {
  BUILTIN_SOURCE_IDS,
  CLUE_CODEC_SOURCE,
  PACK_CODEC_SOURCE,
  RESERVED_SOURCE_IDS,
  ClueError,
  isClueError,
  type Clue,
  type ClueApiContext,
  type ClueApiHandler,
  type ClueAsset,
  type ClueBinding,
  type ClueBindingTarget,
  type ClueCaller,
  type ClueCandidate,
  type ClueEditDocument,
  type ClueErrorCategory,
  type ClueListResult,
  type ClueLocatorContext,
  type ClueOperationContext,
  type CluesBindingMutationParams,
  type CluesBindingsResult,
  type CluesEnsureParams,
  type CluesEnsureResult,
  type CluesImportUnresolvedParams,
  type CluesLibraryResult,
  type CluesListParams,
  type CluesPackCreateParams,
  type CluesPackDeleteParams,
  type CluesPackDeleteResult,
  type CluesPackMemberParams,
  type CluesPackMutationResult,
  type CluesPackRenameParams,
  type CluesPacksResult,
  type CluesPinMutationParams,
  type CluesPinsResult,
  type CluesReadParams,
  type CluesResolveParams,
  type CluesSearchParams,
  type CluesSnapshotReadParams,
  type CluePack,
  type CluePin,
  type CluePortableRef,
  type ClueReadResult,
  type ClueSaveEditInput,
  type ClueSaveEditResult,
  type ClueSnapshotContent,
  type ClueSnapshotMeta,
  type ClueSnapshotRecord,
  type ClueSourceCapabilities,
  type ClueSourceDescriptor,
  type ClueTypeDescriptor,
  type ClueUnresolved,
  type JsonValue,
  type Locator,
} from './types.ts'

/** What a source's `resolve` receives (workspace identity lives in the context). */
export interface ClueResolveInput {
  readonly text?: string
  readonly locator?: Locator
  readonly typeId?: string
  /**
   * True when the caller named THIS source. Auto resolution gives every source
   * the same input, so a source that does not recognize a foreign locator
   * should answer "no candidate"; an explicit call may report the malformed
   * locator instead of returning an empty list.
   */
  readonly explicit?: boolean
}

/** What a source's `list`/`search` receives. */
export interface ClueSourceListInput {
  readonly scope?: JsonValue
  readonly cursor?: string
  readonly limit?: number
}

/** What a source's `search` receives. */
export interface ClueSourceSearchInput extends ClueSourceListInput {
  readonly query: string
}

/** What a source's `read` receives. */
export interface ClueSourceReadInput {
  readonly typeId: string
  readonly locator: Locator
  /** Explicit byte offset for pageable content. */
  readonly offset?: number
}

/** What a source's `saveEdit` receives. */
export interface ClueSourceSaveInput extends ClueSourceReadInput {
  readonly document: ClueSaveEditInput
}

/**
 * The operations one source implements. Every optional member must be
 * advertised in the descriptor's `capabilities`; the registry refuses to call
 * one that was not declared (and answers `unsupported` when absent).
 */
export interface ClueSourceOperations {
  /** Parse a user-supplied text or an existing locator into canonical candidates. */
  resolve?(input: ClueResolveInput, context: ClueOperationContext): Promise<ClueCandidate | readonly ClueCandidate[] | undefined>
  list?(input: ClueSourceListInput, context: ClueOperationContext): Promise<ClueListResult>
  search?(input: ClueSourceSearchInput, context: ClueOperationContext): Promise<ClueListResult>
  read?(input: ClueSourceReadInput, context: ClueOperationContext): Promise<ClueReadResult>
  loadEdit?(input: ClueSourceReadInput, context: ClueOperationContext): Promise<ClueEditDocument>
  saveEdit?(input: ClueSourceSaveInput, context: ClueOperationContext): Promise<ClueSaveEditResult>
  portable?(input: ClueSourceReadInput, context: ClueOperationContext): Promise<CluePortableRef>
  /** Canonicalize a locator (the source owns resource identity). */
  normalizeLocator?(locator: Locator, context: ClueLocatorContext): Locator
  /** Stable equality key of one (already normalized) locator. */
  locatorKey?(locator: Locator): string
}

/** One source registration; the disposer removes exactly this registration. */
export interface ClueSourceRegistration {
  readonly descriptor: ClueSourceDescriptor
  readonly types: readonly ClueTypeDescriptor[]
  readonly operations?: ClueSourceOperations
}

/** Caller-supplied context of one service operation. */
export interface ClueCallOptions {
  readonly caller?: ClueCaller
  readonly signal?: AbortSignal
  readonly sessionId?: string
}

/** Options of {@link createCluesService}. */
export interface CluesServiceOptions {
  /** Durable storage; omitted builds one from `root`. */
  readonly store?: CluesStore
  /** Plugin user-data directory (used when `store` is omitted). */
  readonly root?: string
  /**
   * The core's built-in sources, registered at construction time. This is the
   * ONLY path for a reserved built-in id (`builtin.files`, …): the public
   * {@link CluesService.registerSource} rejects every reserved id, so a
   * third-party registrant can never claim one before (or instead of) the
   * core's own source.
   */
  readonly builtinSources?: readonly ClueSourceRegistration[]
  /** Resolve the host workspace directory for an id (workspaceRegistry.get). */
  readonly resolveWorkspacePath?: (workspaceId: string) => string | undefined
  /** Clock injection (tests). */
  readonly now?: () => string
  /** Stable-id generator injection (tests). */
  readonly newId?: (kind: 'clue' | 'pack' | 'snapshot') => string
}

/** One registered source and its live operations. */
interface RegisteredSource {
  readonly descriptor: ClueSourceDescriptor
  readonly types: readonly ClueTypeDescriptor[]
  readonly operations?: ClueSourceOperations
}

interface RegisteredApi {
  readonly handler: ClueApiHandler
}

/** Snapshot input (S7 owns import policy; S1 owns storage/read). */
export interface ClueSnapshotInput {
  readonly clueId: string
  readonly format: string
  readonly data: JsonValue
  readonly text?: string
  readonly assets?: readonly ClueAsset[]
  readonly fetchedAt?: string
  readonly sourceVersion?: string
  readonly integrity?: 'verified' | 'unknown'
  /** Optional caller-chosen id (import may need one); generated otherwise. */
  readonly snapshotId?: string
}

/** The host clue service face (published as `betterSidebarClues`). */
export interface CluesService {
  // Registry
  registerSource(registration: ClueSourceRegistration): () => void
  getSources(): readonly ClueSourceDescriptor[]
  getSource(sourceId: string): ClueSourceDescriptor | undefined
  getTypes(sourceId?: string): readonly ClueTypeDescriptor[]

  // Source operations
  resolve(params: CluesResolveParams, options?: ClueCallOptions): Promise<readonly ClueCandidate[]>
  list(params: CluesListParams, options?: ClueCallOptions): Promise<ClueListResult>
  search(params: CluesSearchParams, options?: ClueCallOptions): Promise<ClueListResult>
  read(params: CluesReadParams, options?: ClueCallOptions): Promise<ClueReadResult>
  loadEdit(params: CluesReadParams, options?: ClueCallOptions): Promise<ClueEditDocument>
  saveEdit(
    params: CluesReadParams & { readonly document: ClueSaveEditInput },
    options?: ClueCallOptions,
  ): Promise<ClueSaveEditResult>
  portable(params: CluesReadParams, options?: ClueCallOptions): Promise<CluePortableRef>

  // Stable references and library
  ensure(params: CluesEnsureParams, options?: ClueCallOptions): Promise<CluesEnsureResult>
  /**
   * Core-only (S7 import): persist a stable reference whose source is not
   * available here. Not registered as an HTTP API method. Dedupes by
   * sourceId + locator key when a usable locator exists; an existing RESOLVED
   * clue wins (`created: false`), an existing unresolved row is updated in
   * place so its id stays stable.
   */
  importUnresolved(
    params: CluesImportUnresolvedParams,
    options?: ClueCallOptions,
  ): Promise<CluesEnsureResult>
  listClues(workspaceId: string): Promise<CluesLibraryResult>

  // Pins
  listPins(workspaceId: string): Promise<CluesPinsResult>
  addPin(params: CluesPinMutationParams, options?: ClueCallOptions): Promise<CluesPinsResult>
  removePin(params: CluesPinMutationParams, options?: ClueCallOptions): Promise<CluesPinsResult>

  // Packs
  listPacks(workspaceId: string): Promise<CluesPacksResult>
  createPack(params: CluesPackCreateParams, options?: ClueCallOptions): Promise<CluesPackMutationResult>
  renamePack(params: CluesPackRenameParams, options?: ClueCallOptions): Promise<CluesPackMutationResult>
  addPackMember(params: CluesPackMemberParams, options?: ClueCallOptions): Promise<CluesPackMutationResult>
  removePackMember(params: CluesPackMemberParams, options?: ClueCallOptions): Promise<CluesPackMutationResult>
  deletePack(params: CluesPackDeleteParams, options?: ClueCallOptions): Promise<CluesPackDeleteResult>

  // Bindings
  listBindings(workspaceId: string): Promise<CluesBindingsResult>
  addBinding(params: CluesBindingMutationParams, options?: ClueCallOptions): Promise<CluesBindingsResult>
  removeBinding(params: CluesBindingMutationParams, options?: ClueCallOptions): Promise<CluesBindingsResult>

  // Snapshots (content survives source unload; S7 owns import)
  putSnapshot(workspaceId: string, input: ClueSnapshotInput): Promise<ClueSnapshotMeta>
  readSnapshot(params: CluesSnapshotReadParams): Promise<ClueSnapshotRecord>
  listSnapshots(workspaceId: string): Promise<readonly ClueSnapshotMeta[]>

  // API method seam (later specs register here instead of editing index.ts)
  registerApi(name: string, handler: ClueApiHandler): () => void
  hasApi(name: string): boolean
  invokeApi(name: string, payload: unknown, context?: ClueApiContext): Promise<unknown>

  /** Release every registration. Persisted data is untouched (HMR-safe). */
  dispose(): void

  /** Public identity constants clients/other specs need (never duplicated). */
  readonly codecs: { readonly clues: typeof CLUE_CODEC_SOURCE; readonly packs: typeof PACK_CODEC_SOURCE }
  /** Built-in identity list, mirroring {@link BUILTIN_SOURCE_IDS}. */
  readonly builtinSourceIds: readonly string[]
}

/** Default page bound accepted from a caller (sources may impose smaller ones). */
const DEFAULT_PAGE_LIMIT = 100
/** Upper bound of one caller page request (explicit; never silently shrunk). */
const MAX_PAGE_LIMIT = 500
/** Name length bound of a pack (a title, not an identifier). */
const MAX_PACK_NAME = 200
/** Maximum number of pack members accepted in one create call. */
const MAX_PACK_MEMBERS = 10_000

/**
 * Failures that mean a source does not own the input rather than "the
 * resource failed": auto resolution (no explicit `sourceId`) keeps asking the
 * later sources. A missing source dependency is the same kind of miss for the
 * caller — the resource may well belong to another source.
 *
 * Everything else (auth-required, permission-denied, rate-limited, failed,
 * timeout, cancelled, conflict) is about a recognized resource, so it
 * propagates instead of silently producing "no candidates".
 */
const AUTO_RESOLVE_MISS_CATEGORIES: ReadonlySet<ClueErrorCategory> = new Set([
  'not-found',
  'unsupported',
  'dependency-missing',
  'dependency-incompatible',
])

/** Whether a thrown value looks like an aborted operation. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** Stable, order-independent JSON text used as the default locator key. */
export function stableLocatorKey(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableLocatorKey(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableLocatorKey(value[key]!)}`).join(',')}}`
}

/** Validate a raw locator/value as a plain JSON object. */
function requireLocator(value: unknown, what = 'locator'): Locator {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClueError('invalid-request', `clue ${what} must be a JSON object`)
  }
  try {
    JSON.stringify(value)
  } catch {
    throw new ClueError('invalid-request', `clue ${what} is not JSON-serializable`)
  }
  return value as Locator
}

/** Validate and clamp one explicit page limit. */
function pageLimitOf(limit: number | undefined, sourceId: string): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ClueError('invalid-request', `source "${sourceId}" received an invalid page limit (1..${MAX_PAGE_LIMIT})`)
  }
  return limit
}

/** Non-empty workspace id or a clear failure. */
function requireWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new ClueError('invalid-request', 'a non-empty workspace id is required')
  }
  return workspaceId
}

/** Trimmed pack name or a clear failure. */
function packNameOf(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '' || trimmed.length > MAX_PACK_NAME) {
    throw new ClueError('invalid-request', `a pack name must be 1..${MAX_PACK_NAME} characters`)
  }
  return trimmed
}

/** Target equality key of a binding. */
function bindingKey(target: ClueBindingTarget): string {
  return target.kind === 'clue' ? `clue:${target.clueId}` : `pack:${target.packId}`
}

/**
 * Copy one source descriptor down to the mutable-looking leaves.
 *
 * A plain `{ ...descriptor }` shares `capabilities` (and `dependencyIds`)
 * with the registrant and with every caller, so mutating a returned
 * `capabilities.read` silently disabled the registered source's read. The
 * registry stores this copy and each getter hands out a fresh one.
 */
function copySourceDescriptor(descriptor: ClueSourceDescriptor): ClueSourceDescriptor {
  return {
    ...descriptor,
    types: [...descriptor.types],
    capabilities: { ...descriptor.capabilities },
    ...(descriptor.dependencyIds === undefined ? {} : { dependencyIds: [...descriptor.dependencyIds] }),
  }
}

/** Copy one type descriptor (capabilities and formats are the mutable leaves). */
function copyTypeDescriptor(type: ClueTypeDescriptor): ClueTypeDescriptor {
  return {
    ...type,
    formats: [...type.formats],
    capabilities: { ...type.capabilities },
  }
}

/**
 * Create one clue service instance. One instance per plugin mount: its
 * registries die with {@link CluesService.dispose}, which is what the
 * `ctx.effect` in `installClues` hooks into.
 * @param options - storage, workspace-path resolver and test seams.
 */
export function createCluesService(options: CluesServiceOptions = {}): CluesService {
  const store = options.store ?? new CluesStore({ root: options.root })
  const now = options.now ?? (() => new Date().toISOString())
  const newId = options.newId ?? ((kind: 'clue' | 'pack' | 'snapshot') => `${kind}-${randomUUID()}`)
  const sources = new Map<string, RegisteredSource>()
  const types = new Map<string, ClueTypeDescriptor>()
  const apis = new Map<string, RegisteredApi>()
  let disposed = false

  const workspacePathOf = (workspaceId: string): string | undefined => {
    if (options.resolveWorkspacePath === undefined) return undefined
    try {
      const path = options.resolveWorkspacePath(workspaceId)
      return typeof path === 'string' && path !== '' ? path : undefined
    } catch {
      // A registry miss is not an access decision: the source simply lacks a
      // workspace directory and reports its own clear failure.
      return undefined
    }
  }

  const contextOf = (workspaceId: string, call: ClueCallOptions = {}): ClueOperationContext => {
    const workspacePath = workspacePathOf(workspaceId)
    return {
      workspaceId,
      caller: call.caller ?? 'ui',
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
    }
  }

  const throwIfAborted = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) {
      throw new ClueError('cancelled', 'clue operation was cancelled')
    }
  }

  /**
   * Normalize any thrown value to a clue error. The raw error text is
   * deliberately NOT copied: transport stdout/stderr, Authorization headers,
   * tokens and environment secrets must never reach the wire or the model.
   */
  const normalizeError = (error: unknown, sourceId?: string): ClueError => {
    if (isClueError(error)) return error
    if (isAbortError(error)) return new ClueError('cancelled', 'clue operation was cancelled')
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT') return new ClueError('not-found', 'the referenced resource no longer exists')
    if (code === 'EACCES' || code === 'EPERM') {
      return new ClueError('permission-denied', 'the host user cannot access the referenced resource')
    }
    return new ClueError(
      'failed',
      sourceId === undefined
        ? 'clue operation failed'
        : `clue source "${sourceId}" failed`,
    )
  }

  const sourceFor = (sourceId: string): RegisteredSource => {
    const source = sources.get(sourceId)
    if (source === undefined) {
      throw new ClueError('source-missing', `clue source "${sourceId}" is not available`)
    }
    return source
  }

  const orderedSources = (): RegisteredSource[] =>
    [...sources.values()].sort((a, b) =>
      (a.descriptor.order - b.descriptor.order) || a.descriptor.sourceId.localeCompare(b.descriptor.sourceId))

  /** Run one source operation with abort checks and error normalization. */
  const callSource = async <T>(
    source: RegisteredSource,
    context: ClueOperationContext,
    operation: () => Promise<T>,
  ): Promise<T> => {
    throwIfAborted(context.signal)
    let result: T
    try {
      result = await operation()
    } catch (error) {
      throw normalizeError(error, source.descriptor.sourceId)
    }
    throwIfAborted(context.signal)
    return result
  }

  const normalizeSourceLocator = (
    source: RegisteredSource,
    locator: Locator,
    context: ClueOperationContext,
  ): Locator => {
    const raw = requireLocator(locator)
    if (source.operations?.normalizeLocator === undefined) return raw
    try {
      return requireLocator(source.operations.normalizeLocator(raw, {
        workspaceId: context.workspaceId,
        ...(context.workspacePath === undefined ? {} : { workspacePath: context.workspacePath }),
      }))
    } catch (error) {
      throw normalizeError(error, source.descriptor.sourceId)
    }
  }

  const locatorKeyOf = (source: RegisteredSource, locator: Locator): string => {
    if (source.operations?.locatorKey !== undefined) {
      try {
        const key = source.operations.locatorKey(locator)
        if (typeof key === 'string' && key !== '') return key
      } catch {
        // Fall through to the default canonical JSON key: a broken custom key
        // must not make an existing reference unreadable.
      }
    }
    return stableLocatorKey(locator)
  }

  const findClueByLocator = (
    state: WorkspaceState,
    source: RegisteredSource,
    key: string,
  ): Clue | undefined => state.clues.find(clue =>
    clue.sourceId === source.descriptor.sourceId && locatorKeyOf(source, clue.locator) === key)

  const stateOrEmpty = async (workspaceId: string): Promise<WorkspaceState> => {
    if (!store.available) {
      return { revision: 0, clues: [], packs: [], pins: [], bindings: [] }
    }
    return store.read(workspaceId)
  }

  const requireStore = (): CluesStore => {
    if (!store.available) {
      throw new ClueError('failed', 'clue storage is unavailable: the DSH profile home is unknown')
    }
    return store
  }

  const typeOf = (source: RegisteredSource, typeId: string): ClueTypeDescriptor => {
    const type = types.get(typeId)
    if (type === undefined || type.sourceId !== source.descriptor.sourceId) {
      throw new ClueError('unsupported', `clue source "${source.descriptor.sourceId}" does not offer type "${typeId}"`)
    }
    return type
  }

  /**
   * Context of one read/edit call. The payload's `sessionId` wins over the
   * method option so S6/S2 integrations that only serialize the payload still
   * hand the caller session to the source.
   */
  const contextFor = (params: CluesReadParams, call: ClueCallOptions): ClueOperationContext =>
    contextOf(requireWorkspaceId(params.workspaceId), {
      ...call,
      ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    })

  /** Refuse an operation the source's declared capabilities do not advertise. */
  const requireSourceCapability = (
    source: RegisteredSource,
    capability: keyof ClueSourceCapabilities,
    what: string,
  ): void => {
    if (source.descriptor.capabilities[capability] !== true) {
      throw new ClueError('unsupported', `clue source "${source.descriptor.sourceId}" does not support ${what}`)
    }
  }

  /** Refuse an operation the named type's declared capabilities do not advertise. */
  const requireTypeCapability = (
    source: RegisteredSource,
    typeId: string,
    capability: keyof ClueTypeDescriptor['capabilities'],
    what: string,
  ): void => {
    if (typeOf(source, typeId).capabilities[capability] !== true) {
      throw new ClueError('unsupported', `clue type "${typeId}" does not support ${what}`)
    }
  }

  const normalizeCandidate = (
    candidate: ClueCandidate,
    fallback: { source: RegisteredSource; typeId?: string },
    context: ClueOperationContext,
    existing: WorkspaceState | undefined,
  ): ClueCandidate => {
    const source = sources.get(candidate.sourceId) ?? fallback.source
    const declared = candidate.typeId !== undefined && candidate.typeId !== ''
      ? candidate.typeId
      : fallback.typeId ?? source.types[0]?.typeId
    if (declared === undefined) {
      throw new ClueError('unsupported', `clue source "${source.descriptor.sourceId}" returned a candidate without a type`)
    }
    typeOf(source, declared)
    const locator = normalizeSourceLocator(source, candidate.locator, context)
    const title = typeof candidate.title === 'string' && candidate.title.trim() !== ''
      ? candidate.title
      : String(locator.path ?? locator.id ?? locator.url ?? 'clue')
    const key = locatorKeyOf(source, locator)
    const clueId = existing?.clues.find(clue =>
      clue.sourceId === source.descriptor.sourceId && locatorKeyOf(source, clue.locator) === key)?.id
    return {
      sourceId: source.descriptor.sourceId,
      typeId: declared,
      locator,
      title,
      ...(candidate.subtitle === undefined ? {} : { subtitle: candidate.subtitle }),
      ...(candidate.meta === undefined ? {} : { meta: candidate.meta }),
      ...(clueId === undefined ? {} : { clueId }),
    }
  }

  const resolveRef = async (
    params: CluesReadParams,
    call: ClueCallOptions,
  ): Promise<{ source: RegisteredSource; typeId: string; locator: Locator; clue?: Clue }> => {
    const workspaceId = requireWorkspaceId(params.workspaceId)
    const context = contextOf(workspaceId, call)
    if (typeof params.clueId === 'string' && params.clueId !== '') {
      const state = await stateOrEmpty(workspaceId)
      const clue = state.clues.find(candidate => candidate.id === params.clueId)
      if (clue === undefined) {
        throw new ClueError('not-found', `clue "${params.clueId}" does not exist in this workspace`)
      }
      // An imported-but-unresolved reference must not try its source at all:
      // the source may answer a misleading not-found/permission error, while
      // the actual state is "the source this clue names is not available
      // here". `ensure` clears the marker once the source really resolves it.
      if (clue.unresolved !== undefined) {
        throw new ClueError(
          'source-missing',
          `clue "${clue.id}" is unresolved: ${clue.unresolved.reason}`,
        )
      }
      const source = sourceFor(clue.sourceId)
      return { source, typeId: clue.typeId, locator: clue.locator, clue }
    }
    if (params.sourceId === undefined || params.typeId === undefined || params.locator === undefined) {
      throw new ClueError('invalid-request', 'reading or editing requires a clueId or a sourceId + typeId + locator')
    }
    const source = sourceFor(params.sourceId)
    typeOf(source, params.typeId)
    const locator = normalizeSourceLocator(source, params.locator, context)
    return { source, typeId: params.typeId, locator }
  }

  const sourcePage = async (
    params: CluesListParams,
    call: ClueCallOptions,
    kind: 'list' | 'search',
  ): Promise<ClueListResult> => {
    const workspaceId = requireWorkspaceId(params.workspaceId)
    const source = sourceFor(params.sourceId)
    const capability: keyof ClueSourceCapabilities = kind
    if (source.descriptor.capabilities[capability] !== true || source.operations?.[kind] === undefined) {
      throw new ClueError(
        'unsupported',
        `clue source "${params.sourceId}" does not support ${kind}`,
      )
    }
    pageLimitOf(params.limit, params.sourceId)
    const context = contextOf(workspaceId, call)
    const input: ClueSourceListInput = {
      ...(params.scope === undefined ? {} : { scope: params.scope }),
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    }
    if (kind === 'list') {
      return callSource(source, context, async () => source.operations!.list!(input, context))
    }
    const query = (params as CluesSearchParams).query
    return callSource(source, context, async () =>
      source.operations!.search!({ ...input, query }, context))
  }

  /**
   * Register one source. `allowReserved` is set only by the core's own
   * construction path ({@link CluesServiceOptions.builtinSources}); every
   * public call rejects the fixed built-in ids.
   */
  const registerSourceRecord = (registration: ClueSourceRegistration, allowReserved: boolean): () => void => {
    if (disposed) {
      throw new Error('[clues] cannot register a source on a disposed service')
    }
    const descriptor = registration.descriptor
    const sourceId = descriptor?.sourceId
    if (typeof sourceId !== 'string' || sourceId.trim() === '') {
      throw new Error('[clues] a source registration needs a non-empty sourceId')
    }
    if (!allowReserved && RESERVED_SOURCE_IDS.includes(sourceId)) {
      throw new Error(`[clues] source id "${sourceId}" is reserved by the core`)
    }
    if (sources.has(sourceId)) {
      throw new Error(`[clues] source "${sourceId}" is already registered`)
    }
    const declaredTypes = Array.isArray(descriptor.types) ? descriptor.types : []
    const seen = new Set<string>()
    for (const type of registration.types) {
      if (type.sourceId !== sourceId) {
        throw new Error(`[clues] type "${type.typeId}" belongs to "${type.sourceId}", not "${sourceId}"`)
      }
      if (seen.has(type.typeId)) {
        throw new Error(`[clues] type "${type.typeId}" declared twice by source "${sourceId}"`)
      }
      if (types.has(type.typeId)) {
        throw new Error(`[clues] type "${type.typeId}" is already registered`)
      }
      if (!declaredTypes.includes(type.typeId)) {
        throw new Error(`[clues] source "${sourceId}" must list type "${type.typeId}" in its descriptor`)
      }
      seen.add(type.typeId)
    }
    if (declaredTypes.length !== registration.types.length || declaredTypes.some(id => !seen.has(id))) {
      throw new Error(`[clues] source "${sourceId}" declares types it did not register`)
    }
    const registeredTypes = registration.types.map(copyTypeDescriptor)
    const registered: RegisteredSource = {
      descriptor: copySourceDescriptor({ ...descriptor, types: declaredTypes }),
      types: registeredTypes,
      ...(registration.operations === undefined ? {} : { operations: registration.operations }),
    }
    sources.set(sourceId, registered)
    for (const type of registeredTypes) types.set(type.typeId, type)
    return () => {
      if (sources.get(sourceId) !== registered) return
      sources.delete(sourceId)
      for (const type of registeredTypes) {
        if (types.get(type.typeId) === type) types.delete(type.typeId)
      }
    }
  }

  const service: CluesService = {
    codecs: { clues: CLUE_CODEC_SOURCE, packs: PACK_CODEC_SOURCE },
    builtinSourceIds: Object.values(BUILTIN_SOURCE_IDS),

    registerSource(registration: ClueSourceRegistration): () => void {
      return registerSourceRecord(registration, false)
    },

    getSources(): readonly ClueSourceDescriptor[] {
      return orderedSources().map(source => copySourceDescriptor(source.descriptor))
    },

    getSource(sourceId: string): ClueSourceDescriptor | undefined {
      const source = sources.get(sourceId)
      return source === undefined ? undefined : copySourceDescriptor(source.descriptor)
    },

    getTypes(sourceId?: string): readonly ClueTypeDescriptor[] {
      const all = [...types.values()]
      return (sourceId === undefined ? all : all.filter(type => type.sourceId === sourceId))
        .map(copyTypeDescriptor)
    },

    async resolve(params: CluesResolveParams, call: ClueCallOptions = {}): Promise<readonly ClueCandidate[]> {
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const context = contextOf(workspaceId, call)
      let candidates: ClueCandidate[] = []
      const explicitSourceId = params.sourceId
      const requested = explicitSourceId === undefined
        ? orderedSources()
        : [sourceFor(explicitSourceId)]
      for (const source of requested) {
        if (source.descriptor.capabilities.resolve !== true || source.operations?.resolve === undefined) {
          if (explicitSourceId !== undefined) {
            throw new ClueError('unsupported', `clue source "${source.descriptor.sourceId}" cannot resolve references`)
          }
          continue
        }
        const input: ClueResolveInput = {
          ...(params.text === undefined ? {} : { text: params.text }),
          ...(params.locator === undefined ? {} : { locator: params.locator }),
          ...(params.typeId === undefined ? {} : { typeId: params.typeId }),
          ...(explicitSourceId === undefined ? {} : { explicit: true }),
        }
        let raw: ClueCandidate | readonly ClueCandidate[] | undefined
        try {
          raw = await callSource(source, context, async () => source.operations!.resolve!(input, context))
        } catch (error) {
          // Auto resolution asks the sources in order. A source that does not
          // own the input (a URL is not a local path, a path is not a pulled
          // issue, an unavailable transport) must not stop the later sources
          // from answering — otherwise the order-0 builtin poisons every
          // remote URL/issue reference. An explicit sourceId still reports its
          // own failure, and auth/permission failures always propagate.
          if (
            explicitSourceId === undefined
            && isClueError(error)
            && AUTO_RESOLVE_MISS_CATEGORIES.has(error.category)
          ) {
            continue
          }
          throw error
        }
        const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
        candidates = list.map(candidate => normalizeCandidate(candidate, {
          source,
          ...(params.typeId === undefined ? {} : { typeId: params.typeId }),
        }, context, undefined))
        if (candidates.length > 0) break
      }
      // No source owned the input: an empty candidate list is the "not found
      // anywhere" answer of auto resolution (the caller passed no source to
      // blame). An explicit-source call propagates its failures above; it can
      // only get here when the source genuinely returned no candidate.
      const state = await stateOrEmpty(workspaceId)
      const seen = new Set<string>()
      const normalized: ClueCandidate[] = []
      for (const candidate of candidates) {
        const source = sourceFor(candidate.sourceId)
        const key = `${candidate.sourceId}\u0000${locatorKeyOf(source, candidate.locator)}`
        if (seen.has(key)) continue
        seen.add(key)
        normalized.push(normalizeCandidate(candidate, { source }, context, state))
      }
      return normalized
    },

    async list(params: CluesListParams, call: ClueCallOptions = {}): Promise<ClueListResult> {
      return sourcePage(params, call, 'list')
    },

    async search(params: CluesSearchParams, call: ClueCallOptions = {}): Promise<ClueListResult> {
      return sourcePage(params, call, 'search')
    },

    async read(params: CluesReadParams, call: ClueCallOptions = {}): Promise<ClueReadResult> {
      const ref = await resolveRef(params, call)
      const context = contextFor(params, call)
      if (ref.source.operations?.read === undefined) {
        throw new ClueError('unsupported', `clue source "${ref.source.descriptor.sourceId}" cannot read content`)
      }
      requireSourceCapability(ref.source, 'read', 'reads')
      requireTypeCapability(ref.source, ref.typeId, 'read', 'reads')
      const input: ClueSourceReadInput = {
        typeId: ref.typeId,
        locator: ref.locator,
        ...(params.offset === undefined ? {} : { offset: params.offset }),
      }
      const result = await callSource(ref.source, context, async () => ref.source.operations!.read!(input, context))
      return { ...result, fetchedAt: result.fetchedAt ?? now() } as ClueReadResult
    },

    async loadEdit(params: CluesReadParams, call: ClueCallOptions = {}): Promise<ClueEditDocument> {
      const ref = await resolveRef(params, call)
      const context = contextFor(params, call)
      if (ref.source.operations?.loadEdit === undefined) {
        throw new ClueError('unsupported', `clue source "${ref.source.descriptor.sourceId}" is not editable`)
      }
      requireSourceCapability(ref.source, 'edit', 'edits')
      requireTypeCapability(ref.source, ref.typeId, 'edit', 'edits')
      const input: ClueSourceReadInput = { typeId: ref.typeId, locator: ref.locator }
      return callSource(ref.source, context, async () => ref.source.operations!.loadEdit!(input, context))
    },

    async saveEdit(
      params: CluesReadParams & { readonly document: ClueSaveEditInput },
      call: ClueCallOptions = {},
    ): Promise<ClueSaveEditResult> {
      const ref = await resolveRef(params, call)
      const context = contextFor(params, call)
      if (ref.source.operations?.saveEdit === undefined) {
        throw new ClueError('unsupported', `clue source "${ref.source.descriptor.sourceId}" is not editable`)
      }
      requireSourceCapability(ref.source, 'edit', 'edits')
      requireTypeCapability(ref.source, ref.typeId, 'edit', 'edits')
      const input: ClueSourceSaveInput = {
        typeId: ref.typeId,
        locator: ref.locator,
        document: params.document,
      }
      const result = await callSource(ref.source, context, async () => ref.source.operations!.saveEdit!(input, context))
      return { ...result, savedAt: result.savedAt ?? now() } as ClueSaveEditResult
    },

    async portable(params: CluesReadParams, call: ClueCallOptions = {}): Promise<CluePortableRef> {
      const ref = await resolveRef(params, call)
      const context = contextFor(params, call)
      if (ref.source.descriptor.capabilities.portable !== true || ref.source.operations?.portable === undefined) {
        return { portable: false, reason: 'the source does not provide portable references' }
      }
      const input: ClueSourceReadInput = { typeId: ref.typeId, locator: ref.locator }
      return callSource(ref.source, context, async () => ref.source.operations!.portable!(input, context))
    },

    async ensure(params: CluesEnsureParams, call: ClueCallOptions = {}): Promise<CluesEnsureResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const source = sourceFor(params.sourceId)
      typeOf(source, params.typeId)
      const context = contextOf(workspaceId, call)
      const locator = normalizeSourceLocator(source, params.locator, context)
      const key = locatorKeyOf(source, locator)
      const title = typeof params.title === 'string' && params.title.trim() !== ''
        ? params.title.trim()
        : String(locator.path ?? locator.id ?? locator.url ?? 'clue')
      const transaction = await requireStore().transact(workspaceId, undefined, (state) => {
        const existing = findClueByLocator(state, source, key)
        if (existing !== undefined) {
          if (existing.unresolved === undefined) return { clue: existing, created: false }
          // REMAP: the same stable reference resolves now. Keep its id (packs,
          // pins, bindings and snapshots already point at it), adopt the
          // resolved locator/title, and clear the unresolved marker.
          const next: Clue = {
            ...existing,
            typeId: params.typeId,
            locator,
            title,
            updatedAt: now(),
            unresolved: undefined,
          }
          state.clues[state.clues.indexOf(existing)] = next
          return { clue: next, created: false }
        }
        const timestamp = now()
        const clue: Clue = {
          id: newId('clue'),
          sourceId: source.descriptor.sourceId,
          typeId: params.typeId,
          locator,
          title,
          workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        state.clues.push(clue)
        return { clue, created: true }
      })
      return transaction.result
    },

    async importUnresolved(
      params: CluesImportUnresolvedParams,
      call: ClueCallOptions = {},
    ): Promise<CluesEnsureResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const sourceId = typeof params.sourceId === 'string' ? params.sourceId.trim() : ''
      if (sourceId === '') {
        throw new ClueError('invalid-request', 'an unresolved clue needs a non-empty sourceId')
      }
      const typeId = typeof params.typeId === 'string' ? params.typeId.trim() : ''
      if (typeId === '') {
        throw new ClueError('invalid-request', 'an unresolved clue needs a non-empty typeId')
      }
      const title = typeof params.title === 'string' ? params.title.trim() : ''
      if (title === '') {
        throw new ClueError('invalid-request', 'an unresolved clue needs a non-empty title')
      }
      const reason = typeof params.reason === 'string' ? params.reason.trim() : ''
      if (reason === '') {
        throw new ClueError('invalid-request', 'an unresolved clue needs a non-empty reason')
      }
      const locator = requireLocator(params.locator)
      const portable = params.portable
      // The stored locator is exactly what the importer supplied (a portable
      // locator or `{}`), never a fabricated resolvable address. For DEDUPE
      // only, a usable locator (the row's own, else the portable one) is
      // normalized through the source when it is registered, so a later
      // `ensure` sees the same key.
      const dedupeLocator = Object.keys(locator).length > 0
        ? locator
        : portable?.locator !== undefined && Object.keys(portable.locator).length > 0
          ? portable.locator
          : undefined
      const source = sources.get(sourceId)
      const context = contextOf(workspaceId, call)
      const normalizedDedupe = dedupeLocator === undefined
        ? undefined
        : source === undefined
          ? requireLocator(dedupeLocator, 'portable locator')
          : normalizeSourceLocator(source, dedupeLocator, context)
      const dedupeKey = normalizedDedupe === undefined
        ? undefined
        : source === undefined
          ? stableLocatorKey(normalizedDedupe)
          : locatorKeyOf(source, normalizedDedupe)
      const unresolved: ClueUnresolved = {
        reason,
        ...(portable === undefined ? {} : { portable }),
      }
      const transaction = await requireStore().transact(workspaceId, undefined, (state) => {
        if (dedupeKey !== undefined) {
          const existing = state.clues.find(clue =>
            clue.sourceId === sourceId
            && (source === undefined
              ? stableLocatorKey(clue.locator) === dedupeKey
              : locatorKeyOf(source, clue.locator) === dedupeKey))
          if (existing !== undefined) {
            if (existing.unresolved === undefined) return { clue: existing, created: false }
            const next: Clue = { ...existing, title, unresolved, updatedAt: now() }
            state.clues[state.clues.indexOf(existing)] = next
            return { clue: next, created: false }
          }
        }
        const timestamp = now()
        const clue: Clue = {
          id: newId('clue'),
          sourceId,
          typeId,
          locator,
          title,
          workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
          unresolved,
        }
        state.clues.push(clue)
        return { clue, created: true }
      })
      return transaction.result
    },

    async listClues(workspaceId: string): Promise<CluesLibraryResult> {
      const state = await requireStore().read(requireWorkspaceId(workspaceId))
      return { clues: [...state.clues], revision: state.revision }
    },

    async listPins(workspaceId: string): Promise<CluesPinsResult> {
      const state = await requireStore().read(requireWorkspaceId(workspaceId))
      return { pins: [...state.pins], revision: state.revision }
    },

    async addPin(params: CluesPinMutationParams, call: ClueCallOptions = {}): Promise<CluesPinsResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const transaction = await requireStore().transact(workspaceId, params.expectedRevision, (state) => {
        if (!state.clues.some(clue => clue.id === params.clueId)) {
          throw new ClueError('not-found', `clue "${params.clueId}" does not exist in this workspace`)
        }
        if (!state.pins.some(pin => pin.clueId === params.clueId)) {
          const pin: CluePin = { workspaceId, clueId: params.clueId, createdAt: now() }
          state.pins.push(pin)
        }
        return state.pins
      })
      return { pins: transaction.result, revision: transaction.revision }
    },

    async removePin(params: CluesPinMutationParams, call: ClueCallOptions = {}): Promise<CluesPinsResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const transaction = await requireStore().transact(workspaceId, params.expectedRevision, (state) => {
        state.pins = state.pins.filter(pin => pin.clueId !== params.clueId)
        return state.pins
      })
      return { pins: transaction.result, revision: transaction.revision }
    },

    async listPacks(workspaceId: string): Promise<CluesPacksResult> {
      const state = await requireStore().read(requireWorkspaceId(workspaceId))
      return { packs: [...state.packs], revision: state.revision }
    },

    async createPack(params: CluesPackCreateParams, call: ClueCallOptions = {}): Promise<CluesPackMutationResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const name = packNameOf(params.name)
      const requested = params.members ?? []
      if (requested.length > MAX_PACK_MEMBERS) {
        throw new ClueError('invalid-request', `a pack accepts at most ${MAX_PACK_MEMBERS} members`)
      }
      const members = [...new Set(requested.filter(id => typeof id === 'string' && id !== ''))]
      const transaction = await requireStore().transact(workspaceId, params.expectedRevision, (state) => {
        const known = new Set(state.clues.map(clue => clue.id))
        const missing = members.find(id => !known.has(id))
        if (missing !== undefined) {
          throw new ClueError('not-found', `clue "${missing}" does not exist in this workspace`)
        }
        const timestamp = now()
        const pack: CluePack = {
          id: newId('pack'),
          name,
          workspaceId,
          members,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        state.packs.push(pack)
        return { pack }
      })
      return {
        pack: transaction.result.pack,
        revision: transaction.revision,
        packRevision: transaction.result.pack.revision,
      }
    },

    async renamePack(params: CluesPackRenameParams, call: ClueCallOptions = {}): Promise<CluesPackMutationResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const name = packNameOf(params.name)
      const transaction = await requireStore().transact(workspaceId, undefined, (state) => {
        const pack = requirePack(state, params.packId)
        requirePackRevision(pack, params.expectedRevision)
        // CluePack is readonly: replace the row with a new object instead of
        // mutating the committed shape (the store persists the replaced row).
        const next: CluePack = { ...pack, name, revision: pack.revision + 1, updatedAt: now() }
        state.packs[state.packs.indexOf(pack)] = next
        return { pack: next }
      })
      return {
        pack: transaction.result.pack,
        revision: transaction.revision,
        packRevision: transaction.result.pack.revision,
      }
    },

    async addPackMember(params: CluesPackMemberParams, call: ClueCallOptions = {}): Promise<CluesPackMutationResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const transaction = await requireStore().transact(workspaceId, undefined, (state) => {
        const pack = requirePack(state, params.packId)
        requirePackRevision(pack, params.expectedRevision)
        if (!state.clues.some(clue => clue.id === params.clueId)) {
          throw new ClueError('not-found', `clue "${params.clueId}" does not exist in this workspace`)
        }
        if (pack.members.includes(params.clueId)) return { pack }
        const next: CluePack = {
          ...pack,
          members: [...pack.members, params.clueId],
          revision: pack.revision + 1,
          updatedAt: now(),
        }
        state.packs[state.packs.indexOf(pack)] = next
        return { pack: next }
      })
      return {
        pack: transaction.result.pack,
        revision: transaction.revision,
        packRevision: transaction.result.pack.revision,
      }
    },

    async removePackMember(params: CluesPackMemberParams, call: ClueCallOptions = {}): Promise<CluesPackMutationResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const transaction = await requireStore().transact(workspaceId, undefined, (state) => {
        const pack = requirePack(state, params.packId)
        requirePackRevision(pack, params.expectedRevision)
        if (!pack.members.includes(params.clueId)) return { pack }
        const next: CluePack = {
          ...pack,
          members: pack.members.filter(id => id !== params.clueId),
          revision: pack.revision + 1,
          updatedAt: now(),
        }
        state.packs[state.packs.indexOf(pack)] = next
        return { pack: next }
      })
      return {
        pack: transaction.result.pack,
        revision: transaction.revision,
        packRevision: transaction.result.pack.revision,
      }
    },

    async deletePack(params: CluesPackDeleteParams, call: ClueCallOptions = {}): Promise<CluesPackDeleteResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const transaction = await requireStore().transact(workspaceId, undefined, (state) => {
        const pack = requirePack(state, params.packId)
        requirePackRevision(pack, params.expectedRevision)
        state.packs = state.packs.filter(candidate => candidate.id !== params.packId)
        state.bindings = state.bindings.filter(binding =>
          !(binding.target.kind === 'pack' && binding.target.packId === params.packId))
        return { packs: state.packs, packRevision: pack.revision }
      })
      return {
        deleted: true,
        packs: transaction.result.packs,
        revision: transaction.revision,
        packRevision: transaction.result.packRevision,
      }
    },

    async listBindings(workspaceId: string): Promise<CluesBindingsResult> {
      const state = await requireStore().read(requireWorkspaceId(workspaceId))
      return { bindings: [...state.bindings], revision: state.revision }
    },

    async addBinding(params: CluesBindingMutationParams, call: ClueCallOptions = {}): Promise<CluesBindingsResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const target = params.target
      if (target === null || typeof target !== 'object' || (target.kind !== 'clue' && target.kind !== 'pack')) {
        throw new ClueError('invalid-request', 'a binding target must be a clue or a pack')
      }
      const key = bindingKey(target)
      const transaction = await requireStore().transact(workspaceId, params.expectedRevision, (state) => {
        if (target.kind === 'clue' && !state.clues.some(clue => clue.id === target.clueId)) {
          throw new ClueError('not-found', `clue "${target.clueId}" does not exist in this workspace`)
        }
        if (target.kind === 'pack' && !state.packs.some(pack => pack.id === target.packId)) {
          throw new ClueError('not-found', `pack "${target.packId}" does not exist in this workspace`)
        }
        if (!state.bindings.some(binding => bindingKey(binding.target) === key)) {
          const binding: ClueBinding = { workspaceId, target, createdAt: now() }
          state.bindings.push(binding)
        }
        return state.bindings
      })
      return { bindings: transaction.result, revision: transaction.revision }
    },

    async removeBinding(params: CluesBindingMutationParams, call: ClueCallOptions = {}): Promise<CluesBindingsResult> {
      throwIfAborted(call.signal)
      const workspaceId = requireWorkspaceId(params.workspaceId)
      const key = bindingKey(params.target)
      const transaction = await requireStore().transact(workspaceId, params.expectedRevision, (state) => {
        state.bindings = state.bindings.filter(binding => bindingKey(binding.target) !== key)
        return state.bindings
      })
      return { bindings: transaction.result, revision: transaction.revision }
    },

    async putSnapshot(workspaceId: string, input: ClueSnapshotInput): Promise<ClueSnapshotMeta> {
      const id = requireWorkspaceId(workspaceId)
      const state = await requireStore().read(id)
      if (!state.clues.some(clue => clue.id === input.clueId)) {
        throw new ClueError('not-found', `clue "${input.clueId}" does not exist in this workspace`)
      }
      const timestamp = now()
      const meta: ClueSnapshotMeta = {
        snapshotId: input.snapshotId ?? newId('snapshot'),
        workspaceId: id,
        clueId: input.clueId,
        format: input.format,
        fetchedAt: input.fetchedAt ?? timestamp,
        createdAt: timestamp,
        ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
        integrity: input.integrity ?? 'unknown',
      }
      const content: ClueSnapshotContent = {
        format: input.format,
        data: input.data,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.assets === undefined ? {} : { assets: input.assets }),
      }
      return requireStore().putSnapshot(id, meta, content)
    },

    async readSnapshot(params: CluesSnapshotReadParams): Promise<ClueSnapshotRecord> {
      const workspaceId = requireWorkspaceId(params.workspaceId)
      return requireStore().readSnapshot(workspaceId, params.snapshotId)
    },

    async listSnapshots(workspaceId: string): Promise<readonly ClueSnapshotMeta[]> {
      return requireStore().listSnapshots(requireWorkspaceId(workspaceId))
    },

    registerApi(name: string, handler: ClueApiHandler): () => void {
      if (disposed) {
        throw new Error('[clues] cannot register an API method on a disposed service')
      }
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('[clues] an API method needs a non-empty name')
      }
      if (typeof handler !== 'function') {
        throw new Error(`[clues] API method "${name}" needs a handler function`)
      }
      if (apis.has(name)) {
        throw new Error(`[clues] API method "${name}" is already registered`)
      }
      const entry: RegisteredApi = { handler }
      apis.set(name, entry)
      return () => {
        if (apis.get(name) === entry) apis.delete(name)
      }
    },

    hasApi(name: string): boolean {
      return apis.has(name)
    },

    async invokeApi(name: string, payload: unknown, context: ClueApiContext = { caller: 'ui' }): Promise<unknown> {
      const entry = apis.get(name)
      if (entry === undefined) {
        throw new ClueError('not-found', `unknown clue API method "${name}"`)
      }
      if (context.signal?.aborted === true) {
        throw new ClueError('cancelled', 'clue operation was cancelled')
      }
      try {
        return await entry.handler(payload, context)
      } catch (error) {
        // S2+ handlers run CLI/HTTP integrations; their raw stdout/stderr or
        // headers must never reach the wire. Normalization is the boundary,
        // exactly like a source operation (an intentional ClueError keeps its
        // fixed category and safe message).
        throw normalizeError(error)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      sources.clear()
      types.clear()
      apis.clear()
    },
  }

  // The core's own sources use the reserved registration path; a duplicate
  // id or type fails construction loudly instead of blocking an external one.
  for (const registration of options.builtinSources ?? []) {
    registerSourceRecord(registration, true)
  }

  return service
}

/** The pack a mutation names, or not-found. */
function requirePack(state: WorkspaceState, packId: string): CluePack {
  const pack = state.packs.find(candidate => candidate.id === packId)
  if (pack === undefined) {
    throw new ClueError('not-found', `pack "${packId}" does not exist in this workspace`)
  }
  return pack
}

/** Pack-local CAS guard (the pack's own revision, not the workspace revision). */
function requirePackRevision(pack: CluePack, expectedRevision: number | undefined): void {
  if (expectedRevision !== undefined && expectedRevision !== pack.revision) {
    throw new ClueError(
      'conflict',
      `pack "${pack.id}" changed: expected revision ${expectedRevision}, found ${pack.revision}`,
    )
  }
}
