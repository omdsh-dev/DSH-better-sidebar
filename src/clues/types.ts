/**
 * Public clue vocabulary shared by BOTH halves of the plugin.
 *
 * This module is the S1 contract later specs (source runtime, context
 * insertion, floating window, share/import, settings, tab) build on, so it
 * holds TYPES and CONSTANTS only: it must stay free of `node:*` imports and of
 * any runtime service so the browser bundle can import it safely.
 *
 * Model boundaries (from the approved S1 spec):
 * - a SOURCE is a provider with a stable `sourceId` and a transport; a TYPE is
 *   a namespaced content description offered by one source; a CLUE is one
 *   stable reference to a resource, not a copy of its body;
 * - a PACK is a local collection of clue ids (never nested, no per-member
 *   permissions); a PIN is a shortcut, a BINDING only decides what a new
 *   session offers automatically — none of them grants access and none of
 *   them deletes the underlying resource when removed;
 * - locators and all source `data` payloads must be JSON-serializable.
 */
import type { ReactNode } from 'react'

// The error class lives in its own module so the host bundle and the public
// `./clues` artifact can share ONE class object (see error.ts / tsdown.config.ts).
export * from './error.ts'

// ── JSON vocabulary ────────────────────────────────────────────────────────

/** A JSON primitive. */
export type JsonPrimitive = string | number | boolean | null

/** Any JSON-serializable value (locators and source data use this). */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** A JSON object (the shape every `locator` is built from). */
export type JsonObject = { [key: string]: JsonValue }

/**
 * The source-owned stable address of one resource.
 *
 * Sources normalize their locators themselves (see
 * {@link ClueSourceOperations.normalizeLocator}) and decide resource equality
 * through {@link ClueSourceOperations.locatorKey}; the core never guesses a
 * remote identity from a title or a URL fragment.
 */
export type Locator = JsonObject

// ── Built-in identities (fixed for the whole feature line) ─────────────────

/**
 * The built-in source ids. Later specs MUST reuse these strings instead of
 * inventing a second name for the same provider.
 */
export const BUILTIN_SOURCE_IDS = {
  files: 'builtin.files',
  githubIssues: 'builtin.github.issues',
  githubPulls: 'builtin.github.pulls',
  feishuDocs: 'builtin.feishu.docs',
  feishuTasks: 'builtin.feishu.tasks',
} as const

/** One built-in source id. */
export type BuiltinSourceId = (typeof BUILTIN_SOURCE_IDS)[keyof typeof BUILTIN_SOURCE_IDS]

/**
 * Reserved directory/display identity of the local pack library. It is NOT a
 * source: third-party sources may never register it, and it maps to the
 * `better-sidebar:packs` codec source (S5 owns the aggregate codec).
 */
export const BUILTIN_PACKS_ID = 'builtin.packs'

/**
 * Source ids the core owns. They are reserved and never available through the
 * public `registerSource`; the core supplies its built-in sources at service
 * construction time instead (`CluesServiceOptions.builtinSources`).
 */
export const RESERVED_SOURCE_IDS: readonly string[] = [
  BUILTIN_PACKS_ID,
  ...Object.values(BUILTIN_SOURCE_IDS),
]

/** Codec source names (S5 owns the codec implementation; S1 fixes the names). */
export const CLUE_CODEC_SOURCE = 'better-sidebar:clues'
/** Codec source name of the local pack library (`builtin.packs`). */
export const PACK_CODEC_SOURCE = 'better-sidebar:packs'

/** Public preference keys consumed by S8/S5 and the client. */
export const CLUE_PREF_KEYS = {
  sourcesEnabled: 'clueSourcesEnabled',
  sourcesMentionEnabled: 'clueSourcesMentionEnabled',
  packsMentionEnabled: 'cluePacksMentionEnabled',
} as const

// ── Source / type descriptors ──────────────────────────────────────────────

/**
 * How a source reaches its content. `files` is the built-in local file service;
 * remote sources use `http`, `cli` or DSH-internal `mcp`. Transport is not a
 * content type.
 */
export type SourceTransport = 'files' | 'http' | 'cli' | 'mcp'

/** Operations a source advertises in the host catalogue. */
export interface ClueSourceCapabilities {
  readonly resolve: boolean
  readonly list: boolean
  readonly search: boolean
  readonly read: boolean
  /** Whether loadEdit/saveEdit are available. */
  readonly edit: boolean
  /** Whether a credential-free portable locator can be exported. */
  readonly portable: boolean
}

/**
 * Host-side, JSON-serializable source metadata. The client renderer is
 * registered separately ({@link ClueSourceDisplayDescriptor}) and never
 * travels over the wire.
 */
export interface ClueSourceDescriptor {
  /** Stable id (`builtin.files`, `third.party:docs`, …). */
  readonly sourceId: string
  /** Display name (a client dictionary may localize it later). */
  readonly name: string
  /** Serializable icon identifier (a brand icon, resolved client-side). */
  readonly icon?: string
  /** Display order among sources (ascending). */
  readonly order: number
  /** Identity of the plugin that owns this source, for attribution. */
  readonly pluginId: string
  /** The type ids this source offers (each registered by this source). */
  readonly types: readonly string[]
  readonly transport: SourceTransport
  readonly capabilities: ClueSourceCapabilities
  /** Runtime dependencies this source needs (S2 resolves them). */
  readonly dependencyIds?: readonly string[]
  /** Shared connection identity, when the source rides one (S2 owns it). */
  readonly connectionId?: string
}

/** What a type's content can do. */
export interface ClueTypeCapabilities {
  readonly read: boolean
  /** Editable through loadEdit/saveEdit. A read-only preview type is false. */
  readonly edit: boolean
}

/**
 * One content type inside a source. `typeId` is namespaced by convention
 * (`builtin.files.markdown`) and unique across all registered sources.
 */
export interface ClueTypeDescriptor {
  readonly typeId: string
  readonly sourceId: string
  /** Content formats this type can produce (`text/markdown`, `text/plain`, …). */
  readonly formats: readonly string[]
  readonly capabilities: ClueTypeCapabilities
}

// ── Candidates, pagination and reads ───────────────────────────────────────

/**
 * One light-weight resource reference produced by resolve/list/search. It is
 * NOT persisted until a durable use (insert, pin, pack member, binding,
 * import) ensures the stable {@link Clue}.
 */
export interface ClueCandidate {
  readonly sourceId: string
  readonly typeId: string
  readonly locator: Locator
  readonly title: string
  readonly subtitle?: string
  /** Present when this resource is already in the workspace library. */
  readonly clueId?: string
  readonly meta?: JsonObject
}

/**
 * One page of a source listing/search. `cursor` stays opaque to the client;
 * changing the range/query resets it (the core never reuses a cursor across
 * different inputs).
 */
export interface ClueListResult {
  readonly items: ClueCandidate[]
  readonly nextCursor?: string
  /** Optional exact total; absent means "unknown" — do not invent one. */
  readonly total?: number
  /** The source capped the underlying result (not only this page). */
  readonly limited?: boolean
}

/** Where a read came from. */
export type ClueFreshness = 'live' | 'snapshot'

/** One downloadable/openable asset of a read. */
export interface ClueAsset {
  readonly kind: 'download' | 'open'
  /** Absolute path in the host namespace for local assets. */
  readonly path?: string
  readonly mime?: string
  readonly size?: number
}

/**
 * One content read. `text` is the model-facing text projection (present only
 * when a text projection exists); `data` is the source-owned structured body
 * and is never silently converted to Markdown by the core.
 */
export interface ClueReadResult {
  readonly format: string
  readonly data: JsonValue
  /** Opaque source revision used as the optimistic edit baseline. */
  readonly revision?: string
  readonly fetchedAt: string
  readonly freshness?: ClueFreshness
  readonly text?: string
  readonly assets?: readonly ClueAsset[]
  /** The result is one explicit page, not the whole resource. */
  readonly limited?: boolean
  /** Byte offset of the next page, when {@link limited} is true. */
  readonly nextOffset?: number
}

/** One editable document loaded from a source. */
export interface ClueEditDocument {
  readonly format: string
  readonly data: JsonValue
  /** Opaque baseline a save sends back to the source. */
  readonly baseRevision?: string
}

/** One save request: the same format/data the load returned, plus the baseline. */
export interface ClueSaveEditInput {
  readonly format: string
  readonly data: JsonValue
  readonly baseRevision?: string
}

/** Result of a successful edit save. */
export interface ClueSaveEditResult {
  readonly revision?: string
  readonly savedAt: string
}

/**
 * A credential-free reference for sharing (S7). `portable: false` keeps the
 * existing reference unresolved instead of executing anything.
 */
export interface CluePortableRef {
  readonly portable: boolean
  readonly locator?: Locator
  readonly reason?: string
}

// ── Persisted domain model ─────────────────────────────────────────────────

/**
 * Why a stable reference could not be resolved at import time (S7 shares a
 * clue whose source/plugin was not installed on this machine). The row stays a
 * first-class clue: it can be put in a pack, receive snapshots and be listed;
 * read/edit/portable answer `source-missing` with this reason until an
 * `ensure` against the re-registered source remaps it.
 */
export interface ClueUnresolved {
  readonly reason: string
  /** A credential-free locator the resolver may retry, when one was known. */
  readonly portable?: CluePortableRef
}

/** One stable reference to a resource, owned by one workspace. */
export interface Clue {
  readonly id: string
  readonly sourceId: string
  readonly typeId: string
  readonly locator: Locator
  readonly title: string
  readonly workspaceId: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Present while the reference is imported but its source cannot resolve it. */
  readonly unresolved?: ClueUnresolved
}

/** One local pack: an ordered, de-duplicated set of clue ids. */
export interface CluePack {
  readonly id: string
  readonly name: string
  readonly workspaceId: string
  readonly members: readonly string[]
  /** Pack-local CAS revision; mutated by rename/member changes only. */
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** One workspace shortcut to a clue (independent of readability). */
export interface CluePin {
  readonly workspaceId: string
  readonly clueId: string
  readonly createdAt: string
}

/** What a binding points at. */
export type ClueBindingTarget =
  | { readonly kind: 'clue'; readonly clueId: string }
  | { readonly kind: 'pack'; readonly packId: string }

/** One automatic-reference binding of a workspace (not an access grant). */
export interface ClueBinding {
  readonly workspaceId: string
  readonly target: ClueBindingTarget
  readonly createdAt: string
}

/** Stable metadata of one imported snapshot; content lives beside it. */
export interface ClueSnapshotMeta {
  readonly snapshotId: string
  readonly workspaceId: string
  readonly clueId: string
  readonly format: string
  readonly fetchedAt: string
  readonly createdAt: string
  /** Source version the snapshot was taken from, when the source reported one. */
  readonly sourceVersion?: string
  /** Integrity state recorded at import time. */
  readonly integrity?: 'verified' | 'unknown'
}

/** The content half of a snapshot (metadata is stored separately). */
export interface ClueSnapshotContent {
  readonly format: string
  readonly data: JsonValue
  readonly text?: string
  readonly assets?: readonly ClueAsset[]
}

/** One snapshot as read back from the local store. */
export interface ClueSnapshotRecord {
  readonly meta: ClueSnapshotMeta
  readonly content: ClueSnapshotContent
}

// ── Client-rendered source metadata ────────────────────────────────────────

/** A React node or a size-aware icon factory (TabDescriptor convention). */
export type ClueDisplayIcon = ReactNode | ((size: number) => ReactNode)

/**
 * Client-only source presentation. The host catalogue carries only the
 * serializable `icon` id; the owning client plugin registers the renderer.
 * `name` may override the host display name.
 */
export interface ClueSourceDisplayDescriptor {
  readonly sourceId: string
  readonly name?: string
  readonly icon?: ClueDisplayIcon
}

// ── Operation context ──────────────────────────────────────────────────────

/** Who asked: an interactive UI request or a read-only agent tool call. */
export type ClueCaller = 'ui' | 'agent'

/**
 * Context handed to every source operation. It carries the workspace the
 * reference belongs to (not the current cwd), an abort signal, and the caller
 * identity for host integrations. It is NOT an access allowlist.
 */
export interface ClueOperationContext {
  readonly workspaceId: string
  /** The host-registered workspace directory, when the registry knows it. */
  readonly workspacePath?: string
  readonly caller: ClueCaller
  readonly signal?: AbortSignal
  readonly sessionId?: string
}

/** Where a locator is normalized. */
export interface ClueLocatorContext {
  readonly workspaceId: string
  readonly workspacePath?: string
}

// ── S1 API params/results (wire shapes of `clues.*` methods) ───────────────

/** `clues.sources` result. */
export interface CluesSourcesResult {
  readonly sources: readonly ClueSourceDescriptor[]
}

/**
 * `clues.sources` result including the registered type descriptors: the
 * host-side catalogue is the only source of truth for type formats and edit
 * capability, so the wire carries both halves in one round trip.
 */
export interface CluesSourcesCatalogResult extends CluesSourcesResult {
  readonly types: readonly ClueTypeDescriptor[]
}

/** `clues.resolve` params. A path/URL text OR an existing locator. */
export interface CluesResolveParams {
  readonly workspaceId: string
  readonly sourceId?: string
  readonly typeId?: string
  readonly text?: string
  readonly locator?: Locator
}

/** `clues.resolve` result. */
export interface CluesResolveResult {
  readonly candidates: readonly ClueCandidate[]
}

/** `clues.list` params; `scope` is source-defined (a path, repo, folder, …). */
export interface CluesListParams {
  readonly workspaceId: string
  readonly sourceId: string
  readonly scope?: JsonValue
  readonly cursor?: string
  readonly limit?: number
}

/** `clues.search` params (same pagination/result contract as list). */
export interface CluesSearchParams extends CluesListParams {
  readonly query: string
}

/** `clues.read` params: a stable clue id OR a direct resource ref. */
export interface CluesReadParams {
  readonly workspaceId: string
  readonly clueId?: string
  readonly sourceId?: string
  readonly typeId?: string
  readonly locator?: Locator
  /** Explicit byte offset for pageable text reads. */
  readonly offset?: number
  readonly sessionId?: string
}

/** `clues.ensure` params: create (or reuse) the stable reference. */
export interface CluesEnsureParams {
  readonly workspaceId: string
  readonly sourceId: string
  readonly typeId: string
  readonly locator: Locator
  readonly title: string
}

/**
 * Core-only input of {@link CluesService.importUnresolved} (S7): persist a
 * reference even though this machine cannot resolve it yet. `sourceId` and
 * `typeId` are still required (they name the owner), and `locator` may be an
 * empty object when only a portable locator is known — it is NEVER filled with
 * a fabricated path just to look resolvable. Not exposed over HTTP.
 */
export interface CluesImportUnresolvedParams {
  readonly workspaceId: string
  readonly sourceId: string
  readonly typeId: string
  readonly locator: Locator
  readonly title: string
  readonly reason: string
  readonly portable?: CluePortableRef
}

/** `clues.ensure` result; `created` is false when the stable id was reused. */
export interface CluesEnsureResult {
  readonly clue: Clue
  readonly created: boolean
}

/** `clues.clues` result (workspace library + its CAS revision). */
export interface CluesLibraryResult {
  readonly clues: readonly Clue[]
  readonly revision: number
}

/** `clues.pins.list` / mutation result. */
export interface CluesPinsResult {
  readonly pins: readonly CluePin[]
  readonly revision: number
}

/** `clues.pins.add` / `clues.pins.remove` params. */
export interface CluesPinMutationParams {
  readonly workspaceId: string
  readonly clueId: string
  readonly expectedRevision?: number
}

/** `clues.bindings.*` result. */
export interface CluesBindingsResult {
  readonly bindings: readonly ClueBinding[]
  readonly revision: number
}

/** `clues.bindings.add` / `clues.bindings.remove` params. */
export interface CluesBindingMutationParams {
  readonly workspaceId: string
  readonly target: ClueBindingTarget
  readonly expectedRevision?: number
}

/** `clues.packs.list` result. */
export interface CluesPacksResult {
  readonly packs: readonly CluePack[]
  readonly revision: number
}

/**
 * `clues.packs.create` params.
 *
 * `expectedRevision` here is the WORKSPACE library revision (the same domain
 * as `clues.clues` / pins / bindings): the pack does not exist yet, so there
 * is no pack revision to compare against.
 */
export interface CluesPackCreateParams {
  readonly workspaceId: string
  readonly name: string
  readonly members?: readonly string[]
  readonly expectedRevision?: number
}

/** `clues.packs.rename` params. `expectedRevision` is the PACK revision. */
export interface CluesPackRenameParams {
  readonly workspaceId: string
  readonly packId: string
  readonly name: string
  readonly expectedRevision?: number
}

/**
 * `clues.packs.addMember` / `removeMember` params.
 * `expectedRevision` is the PACK revision.
 */
export interface CluesPackMemberParams {
  readonly workspaceId: string
  readonly packId: string
  readonly clueId: string
  readonly expectedRevision?: number
}

/** `clues.packs.delete` params. `expectedRevision` is the PACK revision. */
export interface CluesPackDeleteParams {
  readonly workspaceId: string
  readonly packId: string
  readonly expectedRevision?: number
}

/**
 * `clues.packs.*` mutation result: the committed pack.
 *
 * The two revisions are DIFFERENT domains: `revision` is the workspace
 * library revision (what pins/bindings/pack creation expect), while
 * `packRevision` is the pack-local CAS value a subsequent rename/member
 * mutation of THIS pack must send as `expectedRevision`. Never feed
 * `revision` back into a pack mutation guard.
 */
export interface CluesPackMutationResult {
  readonly pack: CluePack
  readonly revision: number
  readonly packRevision: number
}

/** `clues.packs.delete` result: the pack identity is gone; members remain. */
export interface CluesPackDeleteResult {
  readonly deleted: true
  readonly packs: readonly CluePack[]
  /** Workspace library revision after the delete. */
  readonly revision: number
  /** Pack-local revision the deleted pack had reached. */
  readonly packRevision: number
}

/** `clues.snapshot.read` params. */
export interface CluesSnapshotReadParams {
  readonly workspaceId: string
  readonly snapshotId: string
}

/** One API method handler registered through the service seam. */
export type ClueApiHandler = (payload: unknown, context: ClueApiContext) => Promise<unknown> | unknown

/** Context of one registered API method call. */
export interface ClueApiContext {
  readonly caller: ClueCaller
  readonly signal?: AbortSignal
  readonly sessionId?: string
}
