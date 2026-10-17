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
import type {
  ClueBindingTarget,
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
  resolve(workspaceId: string, input: ClueClientResolveInput, signal?: AbortSignal): Promise<CluesResolveResult>
  list(workspaceId: string, input: ClueClientListInput, signal?: AbortSignal): Promise<ClueListResult>
  search(workspaceId: string, input: ClueClientSearchInput, signal?: AbortSignal): Promise<ClueListResult>
  read(workspaceId: string, input: ClueClientResourceInput, signal?: AbortSignal): Promise<ClueReadResult>
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

/** The single client API instance (stateless; safe to share). */
export const cluesApi: CluesClientApi = {
  sources: signal => call<CluesSourcesCatalogResult>('clues.sources', {}, signal),
  resolve: (workspaceId, input, signal) =>
    call<CluesResolveResult>('clues.resolve', { workspaceId, ...input }, signal),
  list: (workspaceId, input, signal) =>
    call<ClueListResult>('clues.list', { workspaceId, ...input }, signal),
  search: (workspaceId, input, signal) =>
    call<ClueListResult>('clues.search', { workspaceId, ...input }, signal),
  read: (workspaceId, input, signal) =>
    call<ClueReadResult>('clues.read', { workspaceId, ...input }, signal),
  loadEdit: (workspaceId, input, signal) =>
    call<ClueEditDocument>('clues.loadEdit', { workspaceId, ...input }, signal),
  saveEdit: (workspaceId, input, signal) =>
    call<ClueSaveEditResult>('clues.saveEdit', { workspaceId, ...input }, signal),
  portable: (workspaceId, input, signal) =>
    call<CluePortableRef>('clues.portable', { workspaceId, ...input }, signal),
  ensure: (workspaceId, input, signal) =>
    call<CluesEnsureResult>('clues.ensure', { workspaceId, ...input }, signal),
  clues: workspaceId => call<CluesLibraryResult>('clues.clues', { workspaceId }),
  pinsList: workspaceId => call<CluesPinsResult>('clues.pins.list', { workspaceId }),
  pinsAdd: (workspaceId, input, signal) =>
    call<CluesPinsResult>('clues.pins.add', { workspaceId, ...input }, signal),
  pinsRemove: (workspaceId, input, signal) =>
    call<CluesPinsResult>('clues.pins.remove', { workspaceId, ...input }, signal),
  packsList: workspaceId => call<CluesPacksResult>('clues.packs.list', { workspaceId }),
  packsCreate: (workspaceId, input, signal) =>
    call<CluesPackMutationResult>('clues.packs.create', { workspaceId, ...input }, signal),
  packsRename: (workspaceId, input, signal) =>
    call<CluesPackMutationResult>('clues.packs.rename', { workspaceId, ...input }, signal),
  packsAddMember: (workspaceId, input, signal) =>
    call<CluesPackMutationResult>('clues.packs.addMember', { workspaceId, ...input }, signal),
  packsRemoveMember: (workspaceId, input, signal) =>
    call<CluesPackMutationResult>('clues.packs.removeMember', { workspaceId, ...input }, signal),
  packsDelete: (workspaceId, input, signal) =>
    call<CluesPackDeleteResult>('clues.packs.delete', { workspaceId, ...input }, signal),
  bindingsList: workspaceId => call<CluesBindingsResult>('clues.bindings.list', { workspaceId }),
  bindingsAdd: (workspaceId, input, signal) =>
    call<CluesBindingsResult>('clues.bindings.add', { workspaceId, ...input }, signal),
  bindingsRemove: (workspaceId, input, signal) =>
    call<CluesBindingsResult>('clues.bindings.remove', { workspaceId, ...input }, signal),
  snapshotsList: workspaceId => call<{ snapshots: readonly ClueSnapshotMeta[] }>('clues.snapshots.list', { workspaceId }),
  snapshotsRead: (workspaceId, snapshotId) =>
    call<ClueSnapshotRecord>('clues.snapshots.read', { workspaceId, snapshotId }),
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
