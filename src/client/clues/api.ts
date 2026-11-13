/**
 * Client-side wire methods of the clue surface (S1).
 *
 * Every method rides the plugin's ONE `/sidebar/api` transport (`call`), so
 * envelope handling, the fenced route, reverse-proxy URL resolution and the
 * `SidebarApiError` contract are shared with the rest of the client half. This
 * module is deliberately node-free and UI-free: S5/S6/S8 consume it.
 *
 * `workspaceId` is always explicit — a clue belongs to a workspace, never to
 * the currently selected session's cwd.
 */
import { call } from '../api.ts'
import {
  cachedClueRequest,
  clueRequestKey,
  invalidateClueRequests,
  notifyClueDataChange,
  peekClueRequest,
} from './request-cache.ts'
export {
  invalidateClueRequest,
  invalidateClueRequests,
  peekClueRequest,
  subscribeClueDataChanges,
} from './request-cache.ts'
export type { ClueDataChange, ClueDataChangeListener } from './request-cache.ts'
import type {
  ClueBindingTarget,
  ClueDiscussionPage,
  ClueCommentCreateResult,
  ClueDefaultScopeResult,
  ClueBinding,
  ClueEditDocument,
  ClueListResult,
  CluePortableRef,
  ClueReadResult,
  ClueSaveEditInput,
  ClueSaveEditResult,
  ClueSourceDescriptor,
  ClueSnapshotMeta,
  ClueSnapshotRecord,
  ClueTypeDescriptor,
  CluesBindingsResult,
  CluesEnsureParams,
  CluesEnsureResult,
  CluesLibraryResult,
  CluesListParams,
  CluesPackCreateParams,
  CluesPackDeleteParams,
  CluesPackDeleteResult,
  CluesPackMemberParams,
  CluesPackMutationResult,
  CluesPackRenameParams,
  CluesPacksResult,
  CluesPinMutationParams,
  CluesPinsResult,
  CluesReadParams,
  CluesResolveParams,
  CluesResolveResult,
  CluesSearchParams,
  CluesSnapshotReadParams,
  CluesSourcesCatalogResult,
  Locator,
} from '../../clues/types.ts'

/** Params that name a clue OR a direct source resource (no workspace). */
export type ClueClientReadInput =
  | { readonly clueId: string }
  | { readonly sourceId: string; readonly typeId: string; readonly locator: Locator }

/** One `clues.resolve` request (workspace rides separately). */
export interface ClueClientResolveInput {
  readonly sourceId?: string
  readonly typeId?: string
  readonly text?: string
  readonly locator?: Locator
}

/** One `clues.list` request. */
export interface ClueClientListInput {
  readonly sourceId: string
  readonly scope?: unknown
  readonly cursor?: string
  readonly limit?: number
}

/** One `clues.search` request. */
export interface ClueClientSearchInput extends ClueClientListInput {
  readonly query: string
}

/** One `clues.read` / `clues.loadEdit` / `clues.portable` request. */
export type ClueClientResourceInput = ClueClientReadInput & {
  /** Explicit byte offset for a paged read. */
  readonly offset?: number
  readonly sessionId?: string
  readonly includeDiscussion?: boolean
  readonly commentsCursor?: string
}

/** One `clues.saveEdit` request. */
export type ClueClientSaveInput = ClueClientResourceInput & {
  readonly document: ClueSaveEditInput
}

/** One `clues.ensure` request. */
export type ClueClientEnsureInput = Omit<CluesEnsureParams, 'workspaceId'>

/** One pin mutation request. */
export type ClueClientPinInput = Omit<CluesPinMutationParams, 'workspaceId'>

/** One pack-member mutation request. */
export type ClueClientPackMemberInput = Omit<CluesPackMemberParams, 'workspaceId'>

/** One pack create request. */
export type ClueClientPackCreateInput = Omit<CluesPackCreateParams, 'workspaceId'>

/** One pack rename request. */
export type ClueClientPackRenameInput = Omit<CluesPackRenameParams, 'workspaceId'>

/** One pack delete request. */
export type ClueClientPackDeleteInput = Omit<CluesPackDeleteParams, 'workspaceId'>

/** One binding mutation request. */
export interface ClueClientBindingInput {
  readonly target: ClueBindingTarget
  readonly expectedRevision?: number
}

/** The typed client face of every S1 method. */
export interface CluesClientApi {
  sources(signal?: AbortSignal): Promise<CluesSourcesCatalogResult>
  defaultScope(workspaceId: string, input: { sourceId: string }, signal?: AbortSignal): Promise<ClueDefaultScopeResult>
  resolve(workspaceId: string, input: ClueClientResolveInput, signal?: AbortSignal): Promise<CluesResolveResult>
  list(workspaceId: string, input: ClueClientListInput, signal?: AbortSignal): Promise<ClueListResult>
  search(workspaceId: string, input: ClueClientSearchInput, signal?: AbortSignal): Promise<ClueListResult>
  read(workspaceId: string, input: ClueClientResourceInput, signal?: AbortSignal): Promise<ClueReadResult>
  /**
   * Explicit fresh document read: bypasses the activation cache, then retains
   * the fresh answer for later ordinary reads. Send-time content must use this.
   */
  readonly readFresh?: (workspaceId: string, input: ClueClientResourceInput, signal?: AbortSignal) => Promise<ClueReadResult>
  readonly readRefresh?: (workspaceId: string, input: ClueClientResourceInput, signal?: AbortSignal) => Promise<ClueReadResult>
  commentsList?(workspaceId: string, input: ClueClientResourceInput & { readonly cursor?: string; readonly limit?: number; readonly parentId?: string }, signal?: AbortSignal): Promise<ClueDiscussionPage>
  commentsCreate?(workspaceId: string, input: ClueClientResourceInput & { readonly body: string; readonly replyToId?: string; readonly requestId: string }, signal?: AbortSignal): Promise<ClueCommentCreateResult>
  loadEdit(workspaceId: string, input: ClueClientResourceInput, signal?: AbortSignal): Promise<ClueEditDocument>
  saveEdit(workspaceId: string, input: ClueClientSaveInput, signal?: AbortSignal): Promise<ClueSaveEditResult>
  portable(workspaceId: string, input: ClueClientResourceInput, signal?: AbortSignal): Promise<CluePortableRef>
  ensure(workspaceId: string, input: ClueClientEnsureInput, signal?: AbortSignal): Promise<CluesEnsureResult>
  clues(workspaceId: string): Promise<CluesLibraryResult>
  pinsList(workspaceId: string): Promise<CluesPinsResult>
  pinsAdd(workspaceId: string, input: ClueClientPinInput, signal?: AbortSignal): Promise<CluesPinsResult>
  pinsRemove(workspaceId: string, input: ClueClientPinInput, signal?: AbortSignal): Promise<CluesPinsResult>
  packsList(workspaceId: string): Promise<CluesPacksResult>
  packsCreate(workspaceId: string, input: ClueClientPackCreateInput, signal?: AbortSignal): Promise<CluesPackMutationResult>
  packsRename(workspaceId: string, input: ClueClientPackRenameInput, signal?: AbortSignal): Promise<CluesPackMutationResult>
  packsAddMember(workspaceId: string, input: ClueClientPackMemberInput, signal?: AbortSignal): Promise<CluesPackMutationResult>
  packsRemoveMember(workspaceId: string, input: ClueClientPackMemberInput, signal?: AbortSignal): Promise<CluesPackMutationResult>
  packsDelete(workspaceId: string, input: ClueClientPackDeleteInput, signal?: AbortSignal): Promise<CluesPackDeleteResult>
  bindingsList(workspaceId: string): Promise<CluesBindingsResult>
  bindingsAdd(workspaceId: string, input: ClueClientBindingInput, signal?: AbortSignal): Promise<CluesBindingsResult>
  bindingsRemove(workspaceId: string, input: ClueClientBindingInput, signal?: AbortSignal): Promise<CluesBindingsResult>
  snapshotsList(workspaceId: string): Promise<{ snapshots: readonly ClueSnapshotMeta[] }>
  snapshotsRead(workspaceId: string, snapshotId: string): Promise<ClueSnapshotRecord>
}

/** Cache reads; editing baselines must stay fresh for the save concurrency check. */
function readClue<T>(
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  options?: { readonly force?: boolean; readonly coalesceRefresh?: boolean },
): Promise<T> {
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined
  return cachedClueRequest(
    method,
    workspaceId,
    payload,
    sharedSignal => call<T>(method, payload, sharedSignal),
    signal,
    options,
  )
}

/**
 * Invalidate only the read families a write can make stale. A pack write must
 * not force a browser re-read, and ensuring a clue must not drop pack targets.
 * (A rejected write may still have committed a prefix, so mutations invalidate
 * in every outcome.)
 */
type ClueReadFamily = readonly string[]

const LIBRARY_READS: ClueReadFamily = ['clues.clues']
/** Pin state is its own family; the library rows are content, not pin state. */
const PIN_READS: ClueReadFamily = ['clues.pins.list']
/** Create/rename/member writes change the pack directory only. */
const PACK_READS: ClueReadFamily = ['clues.packs.list']
/** Deleting a pack also drops bindings that target it. */
const PACK_DELETE_READS: ClueReadFamily = ['clues.packs.list', 'clues.bindings.list']
const BINDING_READS: ClueReadFamily = ['clues.bindings.list']
/** Saving content changes what a list/search/resolve may show. */
const CONTENT_READS: ClueReadFamily = ['clues.list', 'clues.search', 'clues.resolve']

/**
 * One resource has two cache identities: the persisted clue id and the
 * source/type/locator address. Both can be cached in the same workspace (a
 * detail opened from a candidate before ensure vs. a row that already carries
 * its stable id). This bounded two-way index is learned from `ensure` results,
 * the library snapshot and candidate rows — never from an extra remote call —
 * so saving through either identity evicts both bodies.
 */
const ALIAS_LIMIT = 4096
const resourceAliases = new Map<string, string>()

function clueIdentity(workspaceId: string, clueId: string): string {
  return `${workspaceId}\u0000clue\u0000${clueId}`
}

function locatorIdentity(
  workspaceId: string,
  sourceId: string,
  typeId: string,
  locator: Locator,
): string {
  return `${workspaceId}\u0000locator\u0000${
    clueRequestKey('resource', undefined, { sourceId, typeId, locator })
  }`
}

/** Drop one alias and its peer so eviction cannot leave a one-way mapping. */
function dropAlias(key: string): void {
  const peer = resourceAliases.get(key)
  resourceAliases.delete(key)
  if (peer !== undefined && resourceAliases.get(peer) === key) resourceAliases.delete(peer)
}

/** Remember one resource's two identities, bounded like the read cache. */
function rememberAlias(left: string, right: string): void {
  if (left === right) return
  resourceAliases.delete(left)
  resourceAliases.delete(right)
  resourceAliases.set(left, right)
  resourceAliases.set(right, left)
  while (resourceAliases.size > ALIAS_LIMIT) {
    const oldest = resourceAliases.keys().next().value
    if (oldest === undefined) break
    dropAlias(oldest)
  }
}

function indexClueAlias(
  workspaceId: string,
  clue: { readonly id: string; readonly sourceId: string; readonly typeId: string; readonly locator: Locator },
): void {
  if (typeof clue?.id !== 'string' || typeof clue.sourceId !== 'string'
    || typeof clue.typeId !== 'string' || clue.locator === undefined) return
  rememberAlias(
    clueIdentity(workspaceId, clue.id),
    locatorIdentity(workspaceId, clue.sourceId, clue.typeId, clue.locator),
  )
}

function indexCandidateAliases(
  workspaceId: string,
  items: readonly { readonly sourceId: string; readonly typeId: string; readonly locator: Locator; readonly clueId?: string }[],
): void {
  if (!Array.isArray(items)) return
  for (const item of items) {
    if (typeof item.clueId === 'string') {
      indexClueAlias(workspaceId, {
        id: item.clueId,
        sourceId: item.sourceId,
        typeId: item.typeId,
        locator: item.locator,
      })
    }
  }
}

/** The two (possibly aliased) identities a save input addresses. */
function saveIdentities(workspaceId: string, input: ClueClientResourceInput): ReadonlySet<string> {
  const own = 'clueId' in input
    ? clueIdentity(workspaceId, input.clueId)
    : locatorIdentity(workspaceId, input.sourceId, input.typeId, input.locator)
  const identities = new Set([own])
  const alias = resourceAliases.get(own)
  if (alias !== undefined) identities.add(alias)
  return identities
}

function identityOfPayload(workspaceId: string, payload: unknown): string | undefined {
  const record = payload as Record<string, unknown> | null | undefined
  if (record === null || record === undefined) return undefined
  if (typeof record.clueId === 'string') return clueIdentity(workspaceId, record.clueId)
  if (typeof record.sourceId === 'string' && typeof record.typeId === 'string' && record.locator !== undefined) {
    return locatorIdentity(workspaceId, record.sourceId, record.typeId, record.locator as Locator)
  }
  return undefined
}

async function mutateClue<T>(
  method: string,
  payload: Record<string, unknown>,
  reads: ClueReadFamily,
  signal?: AbortSignal,
): Promise<T> {
  try { return await call<T>(method, payload, signal) }
  finally { invalidateClueRequests(typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined, reads) }
}

/** Whether a cached resource read names one of the identities a save changed. */
function sameResource(
  workspaceId: string,
  entryPayload: unknown,
  identities: ReadonlySet<string>,
): boolean {
  const identity = identityOfPayload(workspaceId, entryPayload)
  return identity !== undefined && identities.has(identity)
}

/**
 * A save refreshes the saved resource (every cached offset, plus its portable
 * projection) and the content-derived list/search/resolve families. It does
 * NOT drop unrelated document bodies: the detail surface owns those and can
 * invalidate its exact read explicitly.
 */
function saveEditReadFilter(workspaceId: string, input: ClueClientResourceInput) {
  const identities = saveIdentities(workspaceId, input)
  return (entry: { readonly method: string; readonly payload: unknown }): boolean => {
    if (entry.method === 'clues.read' || entry.method === 'clues.portable' || entry.method === 'clues.comments.list') {
      return sameResource(workspaceId, entry.payload, identities)
    }
    return CONTENT_READS.includes(entry.method)
  }
}

function invalidateSavedResource(workspaceId: string, input: ClueClientResourceInput): void {
  invalidateClueRequests(workspaceId, saveEditReadFilter(workspaceId, input))
  invalidateClueRequests(workspaceId, LIBRARY_READS)
  invalidateClueRequests(workspaceId, BINDING_READS)
}

/** A tracked Agent draft reached a terminal write outcome; preserve dirty UI drafts. */
export function invalidateClueAgentSave(workspaceId: string, input: ClueClientResourceInput): void {
  invalidateSavedResource(workspaceId, input)
  notifyClueDataChange({ kind: 'library', workspaceId })
  notifyClueDataChange({ kind: 'resource', workspaceId, resource: input })
}

/** Synchronous peek of one cached document body (no fetch). */
export function peekClueRead(
  workspaceId: string,
  input: ClueClientResourceInput,
): ClueReadResult | undefined {
  return peekClueRequest<ClueReadResult>('clues.read', workspaceId, { workspaceId, ...input })
}

/** Compare stable clue/locator aliases without depending on object key order. */
export function isSameClueResource(workspaceId: string, a: ClueClientResourceInput, b: unknown): boolean {
  const identities = saveIdentities(workspaceId, a)
  const identity = identityOfPayload(workspaceId, b)
  return identity !== undefined && (identities.has(identity) || identities.has(resourceAliases.get(identity) ?? ''))
}

/** Drop this resource's body variants, including offsets, session and discussion controls. */
export function invalidateClueRead(workspaceId: string, input: ClueClientResourceInput): void {
  const identities = saveIdentities(workspaceId, input)
  invalidateClueRequests(workspaceId, entry => entry.method === 'clues.read' && sameResource(workspaceId, entry.payload, identities))
}

/** Synchronous peek of one cached portable projection (no fetch). */
export function peekCluePortable(
  workspaceId: string,
  input: ClueClientResourceInput,
): CluePortableRef | undefined {
  return peekClueRequest<CluePortableRef>('clues.portable', workspaceId, { workspaceId, ...input })
}

/** One API and one bounded read cache, shared by native tabs and floating windows. */
export const cluesApi: CluesClientApi = {
  sources: signal => readClue<CluesSourcesCatalogResult>('clues.sources', {}, signal),
  defaultScope: (workspaceId, input, signal) =>
    readClue<ClueDefaultScopeResult>('clues.defaultScope', { workspaceId, ...input }, signal),
  resolve: (workspaceId, input, signal) =>
    readClue<CluesResolveResult>('clues.resolve', { workspaceId, ...input }, signal).then((result) => {
      indexCandidateAliases(workspaceId, result.candidates)
      return result
    }),
  list: (workspaceId, input, signal) =>
    readClue<ClueListResult>('clues.list', { workspaceId, ...input }, signal).then((result) => {
      indexCandidateAliases(workspaceId, result.items)
      return result
    }),
  search: (workspaceId, input, signal) =>
    readClue<ClueListResult>('clues.search', { workspaceId, ...input }, signal).then((result) => {
      indexCandidateAliases(workspaceId, result.items)
      return result
    }),
  read: (workspaceId, input, signal) =>
    readClue<ClueReadResult>('clues.read', { workspaceId, ...input }, signal),
  readFresh: (workspaceId, input, signal) =>
    readClue<ClueReadResult>('clues.read', { workspaceId, ...input }, signal, { force: true }),
  readRefresh: (workspaceId, input, signal) =>
    readClue<ClueReadResult>('clues.read', { workspaceId, ...input }, signal, { force: true, coalesceRefresh: true }),
  commentsList: (workspaceId, input, signal) =>
    readClue<ClueDiscussionPage>('clues.comments.list', { workspaceId, ...input }, signal),
  commentsCreate: async (workspaceId, input, signal) => {
    const identities = saveIdentities(workspaceId, input)
    try {
      return await call<ClueCommentCreateResult>('clues.comments.create', { workspaceId, ...input }, signal)
    } finally {
      invalidateClueRequests(workspaceId, entry => (entry.method === 'clues.comments.list' || entry.method === 'clues.read')
        && sameResource(workspaceId, entry.payload, identities))
      notifyClueDataChange({ kind: 'resource', workspaceId, resource: input })
    }
  },
  // Editing holds a base revision and must never inherit another view's
  // baseline; the detail surface lazy-loads this only when editing starts.
  loadEdit: (workspaceId, input, signal) =>
    call<ClueEditDocument>('clues.loadEdit', { workspaceId, ...input }, signal),
  saveEdit: async (workspaceId, input, signal) => {
    let succeeded = false
    try {
      const result = await call<ClueSaveEditResult>('clues.saveEdit', { workspaceId, ...input }, signal)
      succeeded = true
      return result
    } finally {
      invalidateSavedResource(workspaceId, input)
      // A save can persist source metadata (`persistentInfo`) for an EXISTING
      // clue, so the library row and package/binding revisions are refreshed
      // even when no new clue was created. The detail surface then re-reads
      // its binding panel against that revision.
      // Cache invalidation is complete before any observer is told; a listener
      // that immediately reads sees fresh data, never the saved-over body.
      if (succeeded) notifyClueDataChange({ kind: 'library', workspaceId })
    }
  },
  portable: (workspaceId, input, signal) =>
    readClue<CluePortableRef>('clues.portable', { workspaceId, ...input }, signal),
  // `created:false, updated:false` means the row did not change; `updated:true`
  // still invalidates the library because the display snapshot was rewritten.
  ensure: async (workspaceId, input, signal) => {
    try {
      const result = await call<CluesEnsureResult>('clues.ensure', { workspaceId, ...input }, signal)
      // The returned row is canonical: learn its id <-> locator alias even
      // when the ensure was not a create, without re-reading the library.
      indexClueAlias(workspaceId, result.clue)
      if (result.created !== false || result.updated === true) {
        invalidateClueRequests(workspaceId, LIBRARY_READS)
        notifyClueDataChange({ kind: 'library', workspaceId })
      }
      return result
    } catch (failure) {
      // A rejected ensure may have committed; never leave the library claiming
      // the clue does not exist.
      invalidateClueRequests(workspaceId, LIBRARY_READS)
      throw failure
    }
  },
  clues: async (workspaceId) => {
    const result = await readClue<CluesLibraryResult>('clues.clues', { workspaceId })
    if (Array.isArray(result?.clues)) {
      for (const clue of result.clues) indexClueAlias(workspaceId, clue)
    }
    return result
  },
  pinsList: workspaceId => readClue<CluesPinsResult>('clues.pins.list', { workspaceId }),
  pinsAdd: (workspaceId, input, signal) =>
    mutateClue<CluesPinsResult>('clues.pins.add', { workspaceId, ...input }, PIN_READS, signal),
  pinsRemove: (workspaceId, input, signal) =>
    mutateClue<CluesPinsResult>('clues.pins.remove', { workspaceId, ...input }, PIN_READS, signal),
  packsList: workspaceId => readClue<CluesPacksResult>('clues.packs.list', { workspaceId }),
  packsCreate: (workspaceId, input, signal) =>
    mutateClue<CluesPackMutationResult>('clues.packs.create', { workspaceId, ...input }, PACK_READS, signal),
  packsRename: (workspaceId, input, signal) =>
    mutateClue<CluesPackMutationResult>('clues.packs.rename', { workspaceId, ...input }, PACK_READS, signal),
  packsAddMember: (workspaceId, input, signal) =>
    mutateClue<CluesPackMutationResult>('clues.packs.addMember', { workspaceId, ...input }, PACK_READS, signal),
  packsRemoveMember: (workspaceId, input, signal) =>
    mutateClue<CluesPackMutationResult>('clues.packs.removeMember', { workspaceId, ...input }, PACK_READS, signal),
  packsDelete: (workspaceId, input, signal) =>
    mutateClue<CluesPackDeleteResult>('clues.packs.delete', { workspaceId, ...input }, PACK_DELETE_READS, signal),
  bindingsList: workspaceId => readClue<CluesBindingsResult>('clues.bindings.list', { workspaceId }),
  bindingsAdd: (workspaceId, input, signal) =>
    mutateClue<CluesBindingsResult>('clues.bindings.add', { workspaceId, ...input }, BINDING_READS, signal),
  bindingsRemove: (workspaceId, input, signal) =>
    mutateClue<CluesBindingsResult>('clues.bindings.remove', { workspaceId, ...input }, BINDING_READS, signal),
  snapshotsList: workspaceId => readClue<{ snapshots: readonly ClueSnapshotMeta[] }>('clues.snapshots.list', { workspaceId }),
  snapshotsRead: (workspaceId, snapshotId) =>
    readClue<ClueSnapshotRecord>('clues.snapshots.read', { workspaceId, snapshotId }),
}

/** Unused-type guards for consumers importing the re-exported vocabulary. */
export type {
  ClueBinding,
  ClueSourceDescriptor,
  ClueTypeDescriptor,
  ClueSnapshotRecord,
  CluesReadParams,
  CluesListParams,
  CluesSearchParams,
  CluesResolveParams,
  CluesSnapshotReadParams,
}
