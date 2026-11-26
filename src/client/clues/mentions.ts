/**
 * S5 composer integration: the two `@` trigger sources (client half).
 *
 * Registered names are the FROZEN codec names from S1 —
 * `better-sidebar:clues` and `better-sidebar:packs` — so a draft reference
 * keeps one codec even when a business source is disabled or unloaded. The
 * sources aggregate the clue extension face (`ctx.betterSidebar.clues`):
 *
 * - empty query: bounded recent workspace clues + local pinned clues (clues
 *   source) and the local pack library (packs source); opening `@` never
 *   fetches remote resources;
 * - non-empty query: enabled/mention-enabled sources are searched with bounded
 *   concurrency and per-source failure isolation; the request signal cancels
 *   the in-flight searches, and stale results are dropped. Every hit is shown
 *   with its REAL title, whether or not it is already stored;
 * - browsing NEVER writes the workspace library (`clues.search` only). A
 *   not-yet-stored hit is persisted through `clues.ensure` on the user's pick
 *   and only then inserted. The host's `onPick` is synchronous, so that path
 *   starts the ensure asynchronously and answers `'handled'`: the chip insert
 *   rides the pick-time detect span/draftRev through the injectable
 *   `insertReference` tail, and a lost revision/phase/session race refuses the
 *   insert, keeps the draft and asks the user to type `@` again;
 * - every row shows only the real title (no UUID alias, no "include content"
 *   duplicate, no source/type technical line). Historical content-mode refs
 *   stay decodable: the frozen codecs still parse/encode them and serialize
 *   current content at submit time, but the menu never mints new ones;
 * - `clipboardText` is always the stable token;
 * - chips use only the host-supported appearances (`session` / `file` /
 *   `folder`) and preview through an INJECTABLE `openReference` callback.
 *
 * This module is node-free; host packages are restated structurally because
 * `@deepseek-ai/dsh-client-ui-input-trigger` is not a peer of this package.
 */
import { Fragment, createElement } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  CLUE_CODEC_SOURCE,
  PACK_CODEC_SOURCE,
  CLUE_ERROR_CATEGORIES,
  ClueError,
  type Clue,
  type ClueAsset,
  type ClueDisplayIcon,
  type ClueErrorCategory,
  type ClueListResult,
  type ClueReadResult,
  type CluesLibraryResult,
  type CluesPacksResult,
  type CluesPinsResult,
  type CluesSourcesCatalogResult,
  type ClueSourceDisplayDescriptor,
  type Locator,
} from '../../clues/types.ts'
import type { CluesClientApi } from './api.ts'
import type { BetterSidebarCluesClientFace } from './registry.ts'
import type { Context } from '../../context-types.ts'
import {
  clueTokenOrUndefined,
  escapeClueTitle,
  isValidClueReferenceId,
  serializeClueToken,
} from '../../clues/context/tokens.ts'

// ── Structural mirror of the host input-trigger contract ───────────────────
//
// Only the members this module calls are restated. `appearance` is the host's
// closed union; no candidate field is invented.

/** The host-supported reference chip appearances. */
export type ClueReferenceAppearance = 'session' | 'file' | 'folder'

/** One reference insert outcome of the composer pipeline. */
export interface ClueReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: ClueReferenceAppearance
  readonly clipboardText: string
}

/** A pick settling outcome (subset of the host `PickOutcome`). */
export type CluePickOutcome =
  | { readonly insert: ClueReferenceInsert }
  | { readonly text: string; readonly continue?: boolean }
  | 'handled'
  | undefined

/** The host pick-time detect span (`TokenSpan`), mirrored structurally. */
export interface ClueReferenceSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** Outcome of the asynchronous chip insert started by a pick. */
export type ClueMentionsInsertOutcome = 'inserted' | 'stale' | 'failed'

/** One candidate row handed to the composer menu. */
export interface ClueInputCandidate {
  readonly name: string
  readonly label?: string
  readonly description?: string
  readonly icon?: 'file' | 'folder' | 'session' | ComponentType<{ readonly size?: number }>
  readonly hint?: string
  readonly section?: string
  readonly value?: string
  readonly drill?: boolean
}

/** The session projection the host hands to every trigger callback. */
export interface ClueSessionContext {
  readonly sessionId: string
}

/** One candidate request from the composer. */
export interface ClueCandidateRequest {
  readonly query: string
  readonly quoted?: boolean
  readonly position: 'leading' | 'inline'
  readonly drilled: boolean
  readonly signal: AbortSignal
}

/** Everything `onPick` needs (the span is host-owned and untouched here). */
export interface ClueInputPick {
  readonly candidate: ClueInputCandidate
  readonly session: ClueSessionContext
  readonly position: 'leading' | 'inline'
  readonly via: 'menu' | 'space' | 'enter'
  readonly action: 'pick' | 'drill'
  /** Pick-time detect span; required for the asynchronous unstored-clue insert. */
  readonly span?: ClueReferenceSpan
}

/** The reference codec contract (clipboard + model serialization). */
export interface ClueReferenceCodec {
  clipboardText(ref: string): string
  serialize(ref: string, signal: AbortSignal): Promise<string>
}

/** One registered trigger source. */
export interface ClueInputTriggerSource {
  readonly trigger: '@'
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(session: ClueSessionContext, request: ClueCandidateRequest): Promise<readonly ClueInputCandidate[]>
  onPick(pick: ClueInputPick): CluePickOutcome
  openReference?(session: ClueSessionContext, reference: { readonly ref: string; readonly appearance?: ClueReferenceAppearance }): boolean
  readonly codec?: ClueReferenceCodec
  warm?(session: ClueSessionContext): void
}

/** The `ctx.inputTriggers` service slice. */
interface InputTriggerServiceLike {
  registerSource(source: ClueInputTriggerSource): () => void
}

/** The injected-context slice `ctx.inject` hands back. */
interface InjectedTriggerContext {
  get?(name: string): unknown
  inputTriggers?: InputTriggerServiceLike
}

/** The host-owned Fiber `ctx.inject` returns (structural subset). */
interface InjectedTriggerFiber {
  /** Cordis unloads the injected child scope through this method. */
  dispose?(): Promise<void> | void
}

/** Release the injected child scope; a failed unload never blocks cleanup. */
function disposeInjectedFiber(fiber: InjectedTriggerFiber | undefined): void {
  try {
    const unloaded = fiber?.dispose?.()
    if (unloaded !== undefined) void unloaded.catch(() => {})
  } catch {
    // The plugin is unloading either way; the parent scope still unwinds.
  }
}

/** The context `installClueInputTriggers` needs (client plugin context). */
interface MentionsContext {
  betterSidebar?: { readonly clues?: BetterSidebarCluesClientFace }
  /**
   * Cordis `ctx.inject` returns a Fiber (also PromiseLike), NOT a callable
   * disposer. Disposing the Fiber releases the injected child scope.
   */
  inject?(deps: readonly string[], callback: (injected: unknown) => (() => void) | void): InjectedTriggerFiber
  logger?: { warn?: (message: string) => void }
}

// ── Options and public API ─────────────────────────────────────────────────

/** The clue face slice the trigger sources consume. */
export interface ClueMentionsFace {
  readonly api: CluesClientApi
  getSourceDisplays(): readonly ClueSourceDisplayDescriptor[]
  isSourceEnabled(sourceId: string): boolean
  isSourceMentionEnabled(sourceId: string): boolean
  isPacksMentionEnabled(): boolean
}

/**
 * User-visible copy of the `@` sources.
 *
 * S9 owns the `betterSidebar` locale dictionary; this module stays locale-free
 * and exposes the user-visible notices plus every content-mode send error it
 * renders, so the wiring layer can pass localized text. (Model-facing content
 * projections
 * keep stable English metadata labels such as `freshness:`; those are content,
 * not UI copy.) Display metadata is ALREADY ESCAPED (never a raw source value),
 * and token arguments are stable reference tokens minted here — never
 * source-controlled text — so localization cannot accidentally mint or leak a
 * reference.
 */
export type LocalizedText = string | (() => string)

export interface ClueMentionsCopy {
  /**
   * Retired from the menu (rows show the real title alone) but kept so the
   * wiring layer's existing dictionary object stays assignable.
   */
  readonly includeContentSuffix: LocalizedText
  /** Retired with the content-mode rows (see {@link includeContentSuffix}). */
  readonly clueReferenceDescription: (source: string, type: string) => string
  /** Retired with the content-mode rows. */
  readonly clueContentDescription: (source: string, type: string) => string
  /** Retired with the content-mode rows. */
  readonly packContentDescription: (memberCount: number) => string
  /** Notice when a clue pick could not be inserted (a getter follows the live locale). */
  readonly clueInsertFailed: LocalizedText
  /** Notice when a pack pick could not be inserted (a getter follows the live locale). */
  readonly packInsertFailed: LocalizedText
  /**
   * Notice when an asynchronously ensured reference lost its pick-time race
   * (draft edited, editor not plain, session gone): the draft is kept.
   */
  readonly clueInsertStale: LocalizedText
  /**
   * Wrap one content read failure. `what` names the clue/pack/member (already
   * escaped metadata), `category` is the stable S1 error category and `detail`
   * is a source-owned message or an empty string.
   */
  readonly contentFailure: (what: string, category: string, detail: string) => string
  /** The content projection exceeded the configured character boundary. */
  readonly contentLimit: (size: number, max: number) => string
  /** A content-mode reference is malformed or incompatible with its codec. */
  readonly contentReferenceError: (reason: ClueContentReferenceErrorReason) => string
  /** A referenced clue/pack disappeared before send. */
  readonly contentMissing: (kind: 'clue' | 'pack', token: string) => string
  /** A pack exceeded the content member boundary. */
  readonly packMemberLimit: (token: string, count: number, max: number) => string
  /** A pack member disappeared before send; `memberId` is already escaped data. */
  readonly packMemberMissing: (token: string, memberId: string) => string
  /** A pack member id cannot be represented as a stable token. */
  readonly packMemberNotTokenSafe: (token: string) => string
  /** A source page would truncate included content. */
  readonly partialRead: (token: string, nextOffset: string | number) => string
}

/** Why a content-mode reference cannot be encoded or parsed. */
export type ClueContentReferenceErrorReason =
  | 'malformed'
  | 'unknown-kind'
  | 'unserializable-id'
  | 'missing-workspace'
  | 'invalid-session'
  | 'empty-workspace'
  | 'empty-session'
  | 'kind-mismatch'

/** The English defaults (S9 replaces the user-visible ones with `t()` calls). */
const DEFAULT_COPY: ClueMentionsCopy = {
  includeContentSuffix: ' (include content)',
  clueReferenceDescription: (source, type) => `${source} · ${type}`,
  clueContentDescription: (source, type) => `At send: current content from ${source} · ${type}`,
  packContentDescription: count => `At send: current content of ${count} member${count === 1 ? '' : 's'}`,
  clueInsertFailed: 'That clue could not be inserted; the draft was left unchanged.',
  packInsertFailed: 'That clue pack could not be inserted; the draft was left unchanged.',
  clueInsertStale: 'The draft changed before the clue was ready; the draft was left unchanged. Type @ again to insert it.',
  contentFailure: (what, _category, detail) =>
    `${what} could not be read${detail === '' ? '' : `: ${detail}`}; no content was sent and the draft was kept`,
  contentLimit: (size, max) =>
    `the included content is ${size} characters, over the ${max}-character limit; nothing was sent and the draft was kept`,
  contentReferenceError: reason => {
    switch (reason) {
      case 'malformed':
        return 'the content reference is malformed; the draft was kept'
      case 'unknown-kind':
        return 'the content reference has an unknown kind; the draft was kept'
      case 'unserializable-id':
        return 'the content reference has an unserializable id; the draft was kept'
      case 'missing-workspace':
        return 'the content reference has no workspace; the draft was kept'
      case 'invalid-session':
        return 'the content reference has an invalid session; the draft was kept'
      case 'empty-workspace':
        return 'a content reference needs a workspace id'
      case 'empty-session':
        return 'a content reference session id cannot be empty'
      case 'kind-mismatch':
        return 'a content reference belongs to a different reference kind and cannot be serialized here; the draft was kept'
    }
  },
  contentMissing: (kind, token) => `${kind} ${token} no longer exists in its workspace; the draft was kept`,
  packMemberLimit: (token, count, max) =>
    `pack ${token} has ${count} members, over the ${max}-member content limit; the draft was kept`,
  packMemberMissing: (token, memberId) => `pack ${token} member ${memberId} no longer exists; the draft was kept`,
  packMemberNotTokenSafe: token =>
    `pack ${token} has a member id that cannot be represented as a stable token; the draft was kept`,
  partialRead: (token, nextOffset) =>
    `${token} is larger than one read page (next offset: ${nextOffset}); including it would truncate the content, so the draft was kept`,
}

/** Resolve one localized string that may be a getter. */
function textOf(value: LocalizedText | undefined): string {
  return typeof value === 'function' ? value() : value ?? ''
}

/** Options of {@link createClueInputTriggers}. */
export interface CreateClueInputTriggersOptions {
  /** The clue extension face (`ctx.betterSidebar.clues`). */
  readonly face: ClueMentionsFace
  /**
   * Resolve the composer session's workspace id. The host client workspace
   * service does not expose workspace ids today, so S9 wires the authoritative
   * resolver (session → workspace) here; `undefined` means "not ready".
   */
  readonly resolveWorkspaceId: (session: ClueSessionContext) => string | undefined | Promise<string | undefined>
  /**
   * Open a reference preview without changing the draft. `false` leaves the
   * gesture to the host (the callback owns the actual preview surface).
   */
  readonly openReference?: (input: {
    readonly kind: 'clue' | 'pack'
    readonly id: string
    readonly sessionId: string
  }) => boolean
  /**
   * Surface a user-visible notice for a refused insert (for example a corrupt
   * stored id). The draft is never modified by this module.
   */
  readonly onNotice?: (message: string) => void
  /**
   * Apply one already-resolved chip at the PICK-TIME detect span (the async
   * `ensure` tail of a not-yet-stored search hit). The wiring resolves the
   * host composer and returns `'stale'` when the draft revision, the editor
   * phase or the session moved since the pick — the draft must then stay
   * untouched and the user re-types `@`.
   */
  readonly insertReference?: (
    reference: ClueReferenceInsert,
    session: ClueSessionContext,
    span: ClueReferenceSpan,
  ) => ClueMentionsInsertOutcome
  /**
   * Localized user-visible copy. Omitted fields keep the English defaults;
   * callbacks receive escaped display metadata only.
   */
  readonly copy?: Partial<ClueMentionsCopy>
  /** Maximum characters of one content-mode model projection (default 12000). */
  readonly includeContentMaxChars?: number
  /** Maximum pack members inlined by one content-mode projection (default 50). */
  readonly includeContentMaxMembers?: number
  /** Maximum rows returned per source (default 20, hard cap 50, menu-wide bound). */
  readonly limit?: number
  /** Maximum concurrent source searches (default 4). */
  readonly concurrency?: number
  /**
   * Trailing debounce before a NON-empty query searches the sources (default
   * 500 ms; 0 disables). One keystroke burst must issue one search round — not
   * one round per keystroke — or superseded rounds saturate the browser's
   * connection pool and delay the query the user actually stopped on. Empty
   * queries (local recent/pins) are always served immediately.
   */
  readonly searchDebounceMs?: number
  /** Catalogue cache TTL (default 30 s; one entry, bounded). */
  readonly catalogueTtlMs?: number
  /** Observability hook for isolated source/candidate failures (never logs secrets). */
  readonly onError?: (error: unknown, sourceId?: string) => void
}

/** The created sources plus their disposer. */
export interface CreatedClueInputTriggers {
  readonly sources: readonly ClueInputTriggerSource[]
  dispose(): void
}

/** Defaults. */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const DEFAULT_CONCURRENCY = 4
const DEFAULT_CATALOGUE_TTL_MS = 30_000
/** Trailing debounce of a keyword burst (see `searchDebounceMs`). */
const DEFAULT_SEARCH_DEBOUNCE_MS = 500
/** Default content boundary for historical content-mode refs; a larger projection blocks the send. */
const DEFAULT_INCLUDE_CONTENT_MAX_CHARS = 12_000
/** Default pack-member boundary of one content projection. */
const DEFAULT_INCLUDE_CONTENT_MAX_MEMBERS = 50
/** Prefix marking an opaque content-mode reference id (decode-only: the menu no longer mints these). */
const CONTENT_REF_PREFIX = 'dsh-clue-content:v1:'

/** Clamp the caller's row budget. */
function limitOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)))
}

/** Clamp a positive bound. */
function positiveOf(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

/** Clamp the search debounce; 0 disables it and `undefined` keeps the default. */
function debounceOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SEARCH_DEBOUNCE_MS
  return Math.max(0, Math.floor(value))
}

/** Run async work over a list with a fixed concurrency ceiling. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }
  const width = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  await Promise.all(Array.from({ length: width }, () => run()))
  return results
}

/** Throw the host's cancellation shape when the request was superseded. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('clue reference candidates were cancelled')
    error.name = 'AbortError'
    throw error
  }
}

/** Escape one untrusted metadata value for display (never a token). */
function displayText(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' ? escapeClueTitle(value) || fallback : fallback
}

/** Stable JSON for a locator-shaped value (key order is not identity). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** Match key of one already-stored clue (source identity + locator, not title). */
function storedLocatorKey(sourceId: string, locator: unknown): string {
  return `${sourceId}\u0000${canonicalJson(locator)}`
}

/** Map one clue error (or unknown failure) to a stable category. */
function categoryOf(error: unknown): ClueErrorCategory {
  if (error instanceof ClueError) return error.category
  const code = (error as { readonly code?: unknown } | null)?.code
  if (typeof code === 'string' && (CLUE_ERROR_CATEGORIES as readonly string[]).includes(code)) {
    return code as ClueErrorCategory
  }
  return 'failed'
}

/** A safe message for a content failure (never raw transport output). */
function messageOf(error: unknown): string {
  if (error instanceof ClueError) return error.message
  const code = (error as { readonly code?: unknown } | null)?.code
  if (typeof code === 'string') return error instanceof Error ? error.message : 'the source read failed'
  return 'the source read failed'
}

/** Wrap one content read failure with the draft-preservation contract. */
function contentFailure(what: string, error: unknown, copy: ClueMentionsCopy): ClueError {
  const category = categoryOf(error)
  const detail = error instanceof ClueError || typeof (error as { readonly code?: unknown } | null)?.code === 'string'
    ? messageOf(error)
    : ''
  return new ClueError(category, copy.contentFailure(what, category, detail))
}

/** The content projection exceeded its configured boundary. */
class ContentLimitError extends ClueError {
  constructor(readonly size: number, readonly max: number, message: string) {
    super('invalid-request', message)
  }
}

/** One stable content-mode ref (opaque host ref; clipboard stays the token). */
interface ContentReference {
  readonly kind: 'clue' | 'pack'
  readonly id: string
  readonly workspaceId: string
  /**
   * The composer session that inserted the reference. Read at send time so a
   * session-scoped source keeps its approval/route context (S2 §MCP); it is
   * metadata for the source, never an access grant.
   */
  readonly sessionId?: string
}

/**
 * Parse one content-mode ref. A plain id (the default mode) answers undefined;
 * a malformed content ref throws so the codec can block the send instead of
 * silently emitting a non-token.
 */
function parseContentReference(ref: string, copy: ClueMentionsCopy): ContentReference | undefined {
  if (!ref.startsWith(CONTENT_REF_PREFIX)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(ref.slice(CONTENT_REF_PREFIX.length))
  } catch {
    throw new ClueError('invalid-request', copy.contentReferenceError('malformed'))
  }
  if (raw === null || typeof raw !== 'object') {
    throw new ClueError('invalid-request', copy.contentReferenceError('malformed'))
  }
  const record = raw as { kind?: unknown; id?: unknown; workspaceId?: unknown; sessionId?: unknown }
  if (record.kind !== 'clue' && record.kind !== 'pack') {
    throw new ClueError('invalid-request', copy.contentReferenceError('unknown-kind'))
  }
  if (typeof record.id !== 'string' || !isValidClueReferenceId(record.id)) {
    throw new ClueError('invalid-request', copy.contentReferenceError('unserializable-id'))
  }
  if (typeof record.workspaceId !== 'string' || record.workspaceId === '') {
    throw new ClueError('invalid-request', copy.contentReferenceError('missing-workspace'))
  }
  if (record.sessionId !== undefined && (typeof record.sessionId !== 'string' || record.sessionId === '')) {
    throw new ClueError('invalid-request', copy.contentReferenceError('invalid-session'))
  }
  return {
    kind: record.kind,
    id: record.id,
    workspaceId: record.workspaceId,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
  }
}

/** The stable token named by one ref, refusing a corrupt id loudly. */
function tokenOfReference(kind: 'clue' | 'pack', ref: string, copy: ClueMentionsCopy): string {
  const content = parseContentReference(ref, copy)
  if (content === undefined) return serializeClueToken(kind, ref)
  if (content.kind !== kind) {
    throw new ClueError('invalid-request', copy.contentReferenceError('kind-mismatch'))
  }
  return serializeClueToken(kind, content.id)
}

/**
 * The `clues.read` input of one content projection. The composer session
 * travels with the read so a session-scoped MCP/CLI source keeps its
 * approval/route context (S2 §MCP); it is never an access grant.
 */
function contentReadInput(reference: ContentReference, clueId: string): { clueId: string; sessionId?: string } {
  return {
    clueId,
    ...(reference.sessionId === undefined ? {} : { sessionId: reference.sessionId }),
  }
}

/** One parsed candidate payload: a stored id or a not-yet-stored clue hit. */
interface ParsedCandidateValue {
  readonly kind: 'clue' | 'pack'
  /** Stored stable id (library row). */
  readonly id?: string
  readonly appearance?: 'file' | 'folder'
  /** Raw search hit (clue only): ensure happens on pick, never on browse. */
  readonly sourceId?: string
  readonly typeId?: string
  readonly locator?: Locator
  readonly title?: string
  readonly workspaceId?: string
}

/** Whether one unknown JSON value is an object usable as a source locator. */
function isLocator(value: unknown): value is Locator {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse one candidate payload produced by this module. */
function parseCandidateValue(value: string | undefined): ParsedCandidateValue | undefined {
  if (value === undefined) return undefined
  try {
    const raw = JSON.parse(value) as unknown
    if (raw === null || typeof raw !== 'object') return undefined
    const record = raw as {
      kind?: unknown
      id?: unknown
      appearance?: unknown
      sourceId?: unknown
      typeId?: unknown
      locator?: unknown
      title?: unknown
      workspaceId?: unknown
    }
    if (record.kind !== 'clue' && record.kind !== 'pack') return undefined
    const appearance = record.appearance === 'file' || record.appearance === 'folder'
      ? record.appearance
      : undefined
    if (typeof record.id === 'string' && record.id !== '') {
      return { kind: record.kind, id: record.id, ...(appearance === undefined ? {} : { appearance }) }
    }
    if (
      record.kind === 'clue'
      && typeof record.sourceId === 'string' && record.sourceId !== ''
      && typeof record.typeId === 'string' && record.typeId !== ''
      && typeof record.title === 'string'
      && isLocator(record.locator)
      && typeof record.workspaceId === 'string' && record.workspaceId !== ''
    ) {
      return {
        kind: 'clue',
        sourceId: record.sourceId,
        typeId: record.typeId,
        locator: record.locator,
        title: record.title,
        workspaceId: record.workspaceId,
        ...(appearance === undefined ? {} : { appearance }),
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** The appearance a clue's content type maps to (host-supported values only). */
function appearanceOf(typeId: string): 'file' | 'folder' {
  return typeId.endsWith('.directory') ? 'folder' : 'file'
}

/** Wrap a client display icon (node or size-aware factory) as a candidate icon component. */
function wrapDisplayIcon(icon: ClueDisplayIcon | undefined, fallback: 'file' | 'folder'): ClueInputCandidate['icon'] {
  if (icon === undefined) return fallback
  if (typeof icon === 'function') {
    const factory = icon
    // The host menu passes its own `size` (14px in the installed menu); the
    // 16px default is only the fallback, never a hard-coded override.
    const ClueSourceIcon = ({ size }: { readonly size?: number } = {}): ReactNode =>
      createElement(Fragment, null, factory(size ?? 16))
    return ClueSourceIcon
  }
  const node = icon
  const ClueSourceIcon = (): ReactNode => createElement(Fragment, null, node)
  return ClueSourceIcon
}

/** One stored clue row shared by recent, pins and search matches. */
interface ClueRow {
  readonly id: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  /** An imported row whose original locator is unresolved. */
  readonly unresolved?: boolean
}

/**
 * One search hit that has no stable workspace clue yet. Browsing never
 * persists it; a user pick is what runs `clues.ensure` and only then inserts.
 */
interface ClueHit {
  readonly sourceId: string
  readonly typeId: string
  readonly locator: Locator
  readonly title: string
}

/** One menu row before it is projected: a stored clue or a raw search hit. */
type ClueEntry = ClueRow | ClueHit

/** Whether one entry already carries a stable workspace id. */
function isStoredRow(entry: ClueEntry): entry is ClueRow {
  return 'id' in entry
}

/**
 * The row's REAL title, escaped for display. No UUID alias: a row whose source
 * title is empty has nothing to show and is not offered (the menu contract is
 * "each row only the real title").
 */
function clueTitleOf(entry: ClueEntry): string {
  return escapeClueTitle(entry.title)
}

/** Build the composer candidate row for one clue, stored or not yet stored. */
function clueCandidate(
  entry: ClueEntry,
  displayById: ReadonlyMap<string, ClueSourceDisplayDescriptor>,
  workspaceId: string,
): ClueInputCandidate | undefined {
  const title = clueTitleOf(entry)
  if (title === '') return undefined
  const appearance = appearanceOf(entry.typeId)
  const icon = wrapDisplayIcon(displayById.get(entry.sourceId)?.icon, appearance)
  if (isStoredRow(entry)) {
    return {
      name: title,
      label: title,
      icon,
      value: JSON.stringify({ kind: 'clue', id: entry.id, appearance }),
    }
  }
  return {
    name: title,
    label: title,
    icon,
    // The hit travels opaquely back through onPick; `clues.ensure` runs only
    // after the user picks it, never while browsing.
    value: JSON.stringify({
      kind: 'clue',
      sourceId: entry.sourceId,
      typeId: entry.typeId,
      locator: entry.locator,
      title: entry.title,
      appearance,
      workspaceId,
    }),
  }
}

/** Build the composer candidate row for one stable pack. */
function packCandidate(
  pack: { readonly id: string; readonly name: string },
): ClueInputCandidate | undefined {
  const name = escapeClueTitle(pack.name)
  if (name === '') return undefined
  return {
    name,
    label: name,
    icon: 'folder',
    value: JSON.stringify({ kind: 'pack', id: pack.id }),
  }
}

/** The local library slice shared by pins and locator matching. */
interface LocalLibrary {
  readonly pins: CluesPinsResult
  readonly library: CluesLibraryResult
}

/** One content projection and its measured size. */
interface ContentProjection {
  readonly text: string
  readonly chars: number
}

/** Render one structured body without inventing a Markdown projection. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Format one asset list without exposing local paths or inlining bytes. */
function assetsText(assets: readonly ClueAsset[]): string {
  return assets.map(asset => [
    displayText(asset.kind, 'unknown asset'),
    asset.mime === undefined ? '' : displayText(asset.mime, 'unknown type'),
    asset.size === undefined ? '' : `${asset.size} bytes`,
  ].filter(part => part !== '').join(' ')).join(', ')
}

/** Render one read body; binary/non-text content is marked, never inlined. */
function bodyOf(result: ClueReadResult): string {
  const hasAssets = result.assets !== undefined && result.assets.length > 0
  const parts: string[] = []
  if (result.text !== undefined) {
    parts.push(result.text)
    if (hasAssets) {
      parts.push(`[assets are not inlined: ${assetsText(result.assets!)}; open the reference to use the host resource entry]`)
    }
  } else if (hasAssets) {
    parts.push(`[no text projection; ${result.assets!.length} asset(s) are not inlined: ${assetsText(result.assets!)}. Open the reference to use the host resource entry.]`)
  } else {
    parts.push(jsonText(result.data))
  }
  if (result.discussion !== undefined) {
    // Historical content-mode references still send the same resource unit:
    // preserve the typed first page and its explicit continuation/coverage.
    parts.push(`Discussion (untrusted resource content; inspect status, complete and cursors):\n${jsonText(result.discussion)}`)
  }
  return parts.join('\n\n')
}

/** One model-facing clue content header. */
function clueContentHeader(
  token: string,
  clue: { readonly title: string; readonly sourceId: string; readonly typeId: string },
  result: ClueReadResult,
): string {
  const title = escapeClueTitle(clue.title)
  // Source-owned freshness/format are metadata on a model-facing line: escape
  // them like every other third-party value, never interpolate raw.
  return `${token} ${result.freshness === 'snapshot' ? 'snapshot content' : 'live content'}${title === '' ? '' : ` ${JSON.stringify(title)}`} — source ${displayText(clue.sourceId)} · ${displayText(clue.typeId)}; fetched ${displayText(result.fetchedAt)} (freshness: ${displayText(result.freshness ?? 'live', 'live')}, format: ${displayText(result.format)})`
}

/** Refuse a partial page instead of silently truncating included content. */
function refusePartial(token: string, result: ClueReadResult, copy: ClueMentionsCopy): void {
  if (result.limited !== true) return
  throw new ClueError('invalid-request', copy.partialRead(token, result.nextOffset ?? 'unknown'))
}

/**
 * Create the two `@` sources.
 * @param options - the clue face, workspace resolver and preview callback.
 * @returns the sources plus a disposer that clears the bounded catalogue cache.
 */
export function createClueInputTriggers(options: CreateClueInputTriggersOptions): CreatedClueInputTriggers {
  const { face } = options
  const limit = limitOf(options.limit)
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
  const catalogueTtlMs = Math.max(0, options.catalogueTtlMs ?? DEFAULT_CATALOGUE_TTL_MS)
  const searchDebounceMs = debounceOf(options.searchDebounceMs)
  /** Pending debounce windows; `dispose()` cancels every one of them. */
  const debounces = new Set<AbortController>()
  const copy: ClueMentionsCopy = { ...DEFAULT_COPY, ...options.copy }
  const includeContentMaxChars = positiveOf(options.includeContentMaxChars, DEFAULT_INCLUDE_CONTENT_MAX_CHARS)
  const includeContentMaxMembers = positiveOf(options.includeContentMaxMembers, DEFAULT_INCLUDE_CONTENT_MAX_MEMBERS)
  /** Single-entry bounded catalogue cache (ids are persisted elsewhere). */
  let catalogue: { readonly at: number; readonly value: CluesSourcesCatalogResult } | undefined
  let disposed = false

  const report = (error: unknown, sourceId?: string): void => {
    try {
      options.onError?.(error, sourceId)
    } catch {
      // An observer must never break the composer.
    }
  }

  const notify = (message: string): void => {
    try {
      options.onNotice?.(message)
    } catch {
      // An observer must never break the composer.
    }
  }

  /**
   * Trailing debounce of one non-empty keyword round. Resolves true when the
   * window elapsed with the request still live; false when the host aborted
   * the candidates (next keystroke) or the sources were disposed. Both
   * cancellation paths settle WITHOUT waiting out the rest of the window, so
   * a superseded round never holds a timer, a fetch or the menu.
   *
   * @param signal - the host's per-hit candidate signal.
   * @returns whether the caller should issue the search round.
   */
  const debounceSearch = (signal: AbortSignal): Promise<boolean> => {
    if (searchDebounceMs <= 0) return Promise.resolve(!disposed && !signal.aborted)
    return new Promise<boolean>(resolve => {
      if (disposed || signal.aborted) {
        resolve(false)
        return
      }
      const controller = new AbortController()
      debounces.add(controller)
      let timer: ReturnType<typeof setTimeout> | undefined = undefined
      let settled = false
      const finish = (proceed: boolean): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        controller.signal.removeEventListener('abort', onDispose)
        debounces.delete(controller)
        resolve(proceed)
      }
      const onAbort = (): void => finish(false)
      const onDispose = (): void => finish(false)
      timer = setTimeout(() => finish(true), searchDebounceMs)
      signal.addEventListener('abort', onAbort, { once: true })
      controller.signal.addEventListener('abort', onDispose, { once: true })
    })
  }

  const workspaceOf = async (session: ClueSessionContext, signal: AbortSignal): Promise<string | undefined> => {
    try {
      const value = await options.resolveWorkspaceId(session)
      if (signal.aborted) return undefined
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch (error) {
      report(error)
      return undefined
    }
  }

  const catalogueOf = async (signal: AbortSignal): Promise<CluesSourcesCatalogResult | undefined> => {
    if (catalogue !== undefined && Date.now() - catalogue.at <= catalogueTtlMs) return catalogue.value
    try {
      const value = await face.api.sources(signal)
      catalogue = { at: Date.now(), value }
      return value
    } catch (error) {
      if (!signal.aborted) report(error)
      return undefined
    }
  }

  const displayMap = (): ReadonlyMap<string, ClueSourceDisplayDescriptor> => {
    const map = new Map<string, ClueSourceDisplayDescriptor>()
    for (const display of face.getSourceDisplays()) map.set(display.sourceId, display)
    return map
  }

  /** The local pins + library slice; a failure degrades to an empty slice. */
  const localLibraryOf = async (workspaceId: string, signal: AbortSignal): Promise<LocalLibrary> => {
    try {
      const [pins, library] = await Promise.all([
        face.api.pinsList(workspaceId),
        face.api.clues(workspaceId),
      ])
      if (signal.aborted) return { pins: { pins: [], revision: 0 }, library: { clues: [], revision: 0 } }
      return { pins, library }
    } catch (error) {
      if (!signal.aborted) report(error)
      return { pins: { pins: [], revision: 0 }, library: { clues: [], revision: 0 } }
    }
  }

  /** One stored clue as a menu row. */
  const rowOf = (clue: Clue): ClueRow => ({
    id: clue.id,
    title: clue.title,
    sourceId: clue.sourceId,
    typeId: clue.typeId,
    ...(clue.unresolved === undefined ? {} : { unresolved: true }),
  })

  /** Whether both the source switch and its @ switch show the source's rows. */
  const mentionableOf = (sourceId: string): boolean =>
    face.isSourceEnabled(sourceId) && face.isSourceMentionEnabled(sourceId)

  /** Local pinned clues matching one query (empty query = every pin, ordered). */
  const pinnedRowsOf = (local: LocalLibrary, query: string): ClueRow[] => {
    const byId = new Map(local.library.clues.map(clue => [clue.id, clue]))
    const rows: ClueRow[] = []
    for (const pin of local.pins.pins) {
      const clue = byId.get(pin.clueId)
      if (clue === undefined) continue
      if (query !== '' && !clue.title.toLowerCase().includes(query)) continue
      // A per-source @ switch also hides that source's pinned rows; the
      // switch is presentation only, so explicit reads stay available.
      if (!mentionableOf(clue.sourceId)) continue
      rows.push(rowOf(clue))
    }
    return rows
  }

  /**
   * Stored clues matching one query, most recently updated first — the
   * `recent` half of the bounded empty-query menu. Applying the row budget
   * before the merge keeps every browse bounded even for a huge library.
   */
  const recentRowsOf = (local: LocalLibrary, query: string): ClueRow[] =>
    [...local.library.clues]
      .filter(clue => query === '' || clue.title.toLowerCase().includes(query))
      .filter(clue => mentionableOf(clue.sourceId))
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(rowOf)

  /** The workspace library indexed by stable id and by source identity + locator. */
  const libraryIndexOf = (local: LocalLibrary): { byId: Map<string, Clue>; byLocator: Map<string, Clue> } => {
    const byId = new Map<string, Clue>()
    const byLocator = new Map<string, Clue>()
    for (const clue of local.library.clues) {
      byId.set(clue.id, clue)
      byLocator.set(storedLocatorKey(clue.sourceId, clue.locator), clue)
    }
    return { byId, byLocator }
  }

  /** Stable dedupe key of one menu entry (stored id, or source identity + locator). */
  const entryKeyOf = (entry: ClueEntry): string => isStoredRow(entry)
    ? `id\u0000${entry.id}`
    : `loc\u0000${storedLocatorKey(entry.sourceId, entry.locator)}`

  /** Dedupe by stable identity and bound the merged menu. */
  const mergeEntries = (entries: readonly ClueEntry[]): ClueEntry[] => {
    const seen = new Set<string>()
    const merged: ClueEntry[] = []
    for (const entry of entries) {
      const key = entryKeyOf(entry)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
      if (merged.length >= limit) break
    }
    return merged
  }

  /**
   * Search one enabled, @-enabled source. Every hit is offered with its REAL
   * title: a hit that already maps to a stored clue (by clueId or by source
   * identity + locator) reuses the stable row, and a not-yet-stored hit stays
   * a lightweight candidate. Browsing NEVER writes the workspace library —
   * `clues.ensure` runs only after the user picks the candidate.
   */
  const searchSource = async (
    workspaceId: string,
    sourceId: string,
    query: string,
    signal: AbortSignal,
    perSourceLimit: number,
    library: { byId: Map<string, Clue>; byLocator: Map<string, Clue> },
  ): Promise<ClueEntry[]> => {
    let result: ClueListResult
    try {
      result = await face.api.search(workspaceId, { sourceId, query, limit: perSourceLimit }, signal)
    } catch (error) {
      if (!signal.aborted) report(error, sourceId)
      return []
    }
    if (signal.aborted) return []
    const entries: ClueEntry[] = []
    const seen = new Set<string>()
    for (const candidate of result.items.slice(0, perSourceLimit)) {
      if (signal.aborted) return []
      const stored = library.byLocator.get(storedLocatorKey(candidate.sourceId, candidate.locator))
        ?? (candidate.clueId === undefined ? undefined : library.byId.get(candidate.clueId))
      const entry: ClueEntry = stored === undefined
        ? {
            sourceId: candidate.sourceId,
            typeId: candidate.typeId,
            locator: candidate.locator,
            title: candidate.title,
          }
        : rowOf(stored)
      const key = entryKeyOf(entry)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
    return entries
  }

  /** Project one bounded entry list into composer rows (stored ids must be token-safe). */
  const clueCandidateRows = (
    entries: readonly ClueEntry[],
    displays: ReadonlyMap<string, ClueSourceDisplayDescriptor>,
    workspaceId: string,
  ): ClueInputCandidate[] => entries.flatMap(entry => {
    if (isStoredRow(entry) && clueTokenOrUndefined('clue', entry.id) === undefined) {
      report(new ClueError('invalid-request', 'a workspace clue id cannot be represented as a stable token; the row was hidden'))
      return []
    }
    const candidate = clueCandidate(entry, displays, workspaceId)
    return candidate === undefined ? [] : [candidate]
  })

  /** Project one bounded pack list into composer rows (pack ids must be token-safe). */
  const packCandidateRows = (
    packs: readonly { readonly id: string; readonly name: string }[],
  ): ClueInputCandidate[] => packs.flatMap(pack => {
    if (clueTokenOrUndefined('pack', pack.id) === undefined) {
      report(new ClueError('invalid-request', 'a workspace pack id cannot be represented as a stable token; the row was hidden'))
      return []
    }
    const candidate = packCandidate(pack)
    return candidate === undefined ? [] : [candidate]
  })

  /** Enforce the configured content boundary. */
  const boundedProjection = (text: string): ContentProjection => {
    if (text.length > includeContentMaxChars) {
      throw new ContentLimitError(text.length, includeContentMaxChars, copy.contentLimit(text.length, includeContentMaxChars))
    }
    return { text, chars: text.length }
  }

  /**
   * Send-time content is historical data, not a screen: it must bypass the
   * activation read cache. The typed API exposes `readFresh`; older/injected
   * faces without it fall back to their ordinary read unchanged.
   */
  const readFreshContent = (
    workspaceId: string,
    input: Parameters<CluesClientApi['read']>[1],
    signal: AbortSignal,
  ): Promise<ClueReadResult> => face.api.readFresh === undefined
    ? face.api.read(workspaceId, input, signal)
    : face.api.readFresh(workspaceId, input, signal)

  /** Project the CURRENT live content of one clue with source/time metadata. */
  const projectClueContent = async (reference: ContentReference, signal: AbortSignal): Promise<ContentProjection> => {
    throwIfAborted(signal)
    const token = serializeClueToken('clue', reference.id)
    let library: CluesLibraryResult
    try {
      library = await face.api.clues(reference.workspaceId)
    } catch (error) {
      throw contentFailure(`clue ${token}`, error, copy)
    }
    const clue = library.clues.find(candidate => candidate.id === reference.id)
    if (clue === undefined) {
      throw new ClueError('not-found', copy.contentMissing('clue', token))
    }
    let result: ClueReadResult
    try {
      result = await readFreshContent(reference.workspaceId, contentReadInput(reference, reference.id), signal)
    } catch (error) {
      if (signal.aborted) throwIfAborted(signal)
      throw contentFailure(`clue ${token} (${displayText(clue.sourceId)})`, error, copy)
    }
    throwIfAborted(signal)
    refusePartial(token, result, copy)
    return boundedProjection(`${clueContentHeader(token, clue, result)}\n\n${bodyOf(result)}`)
  }

  /** Project the CURRENT content of every pack member (never a frozen body set). */
  const projectPackContent = async (reference: ContentReference, signal: AbortSignal): Promise<ContentProjection> => {
    throwIfAborted(signal)
    const token = serializeClueToken('pack', reference.id)
    let library: CluesLibraryResult
    let packs: CluesPacksResult
    try {
      [library, packs] = await Promise.all([
        face.api.clues(reference.workspaceId),
        face.api.packsList(reference.workspaceId),
      ])
    } catch (error) {
      throw contentFailure(`pack ${token}`, error, copy)
    }
    const pack = packs.packs.find(candidate => candidate.id === reference.id)
    if (pack === undefined) {
      throw new ClueError('not-found', copy.contentMissing('pack', token))
    }
    if (pack.members.length > includeContentMaxMembers) {
      throw new ClueError(
        'invalid-request',
        copy.packMemberLimit(token, pack.members.length, includeContentMaxMembers),
      )
    }
    const clueById = new Map(library.clues.map(clue => [clue.id, clue]))
    const chunks: string[] = []
    for (const memberId of pack.members) {
      const clue = clueById.get(memberId)
      if (clue === undefined) {
        throw new ClueError(
          'not-found',
          copy.packMemberMissing(token, JSON.stringify(displayText(memberId, 'unknown'))),
        )
      }
      const memberToken = clueTokenOrUndefined('clue', clue.id)
      if (memberToken === undefined) {
        throw new ClueError('invalid-request', copy.packMemberNotTokenSafe(token))
      }
      let result: ClueReadResult
      try {
        result = await readFreshContent(reference.workspaceId, contentReadInput(reference, clue.id), signal)
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal)
        throw contentFailure(`pack ${token} member ${memberToken} (${displayText(clue.sourceId)})`, error, copy)
      }
      throwIfAborted(signal)
      refusePartial(memberToken, result, copy)
      chunks.push(`${clueContentHeader(memberToken, clue, result)}\n\n${bodyOf(result)}`)
    }
    const header = `${token} pack ${JSON.stringify(escapeClueTitle(pack.name))} — ${pack.members.length} current member${pack.members.length === 1 ? '' : 's'}, revision ${pack.revision}; content fetched at send time`
    return boundedProjection(`${header}\n\n${chunks.length === 0 ? '(the pack has no current members)' : chunks.join('\n\n')}`)
  }

  /**
   * Persist one picked search hit and insert it at the ORIGINAL pick span.
   *
   * The host's `onPick` is synchronous, so `clues.ensure` runs detached: only
   * the user's pick may write the library. The resolved stable reference then
   * goes through the wiring's `insertReference` tail, which applies the
   * pick-time detect span/draftRev CAS. A lost race (draft edited, editor not
   * plain, session gone) keeps the draft and asks the user to type `@` again.
   */
  const ensureAndInsert = (
    session: ClueSessionContext,
    hit: {
      readonly sourceId: string
      readonly typeId: string
      readonly locator: Locator
      readonly title: string
      readonly workspaceId: string
      readonly appearance: 'file' | 'folder'
      readonly label: string
    },
    span: ClueReferenceSpan,
  ): void => {
    const insert = options.insertReference
    // Without an insert tail there is nothing to gain from persisting the
    // hit, so a misconfigured wiring never writes the library.
    if (insert === undefined) {
      notify(textOf(copy.clueInsertFailed))
      return
    }
    void (async () => {
      try {
        const ensured = await face.api.ensure(hit.workspaceId, {
          sourceId: hit.sourceId,
          typeId: hit.typeId,
          locator: hit.locator,
          title: hit.title,
        })
        if (disposed) return
        const token = serializeClueToken('clue', ensured.clue.id)
        const outcome = insert({
          source: CLUE_CODEC_SOURCE,
          ref: ensured.clue.id,
          label: hit.label,
          appearance: hit.appearance,
          clipboardText: token,
        }, session, span)
        if (outcome === 'stale') notify(textOf(copy.clueInsertStale))
        else if (outcome !== 'inserted') notify(textOf(copy.clueInsertFailed))
      } catch (error) {
        if (disposed) return
        report(error)
        notify(textOf(copy.clueInsertFailed))
      }
    })()
  }

  const cluesSource: ClueInputTriggerSource = {
    trigger: '@',
    name: CLUE_CODEC_SOURCE,
    order: 0,
    showGroupTitle: false,
    async candidates(session, request): Promise<readonly ClueInputCandidate[]> {
      if (disposed) return []
      throwIfAborted(request.signal)
      const query = request.query.trim().toLowerCase()
      // Empty query = local recent/pins and must paint instantly. A keyword
      // burst is debounced so only the query the user stopped on searches.
      if (query !== '' && !(await debounceSearch(request.signal))) return []
      if (disposed) return []
      const workspaceId = await workspaceOf(session, request.signal)
      if (workspaceId === undefined) return []
      const displays = displayMap()
      if (query === '') {
        const local = await localLibraryOf(workspaceId, request.signal)
        if (request.signal.aborted) return []
        // Explicit pins first, then the bounded recent library slice.
        return clueCandidateRows(
          mergeEntries([...pinnedRowsOf(local, ''), ...recentRowsOf(local, '')]),
          displays,
          workspaceId,
        )
      }
      const [local, catalog] = await Promise.all([
        localLibraryOf(workspaceId, request.signal),
        catalogueOf(request.signal),
      ])
      if (request.signal.aborted) return []
      const pins = pinnedRowsOf(local, query)
      const library = libraryIndexOf(local)
      const sources = (catalog?.sources ?? []).filter(source =>
        source.capabilities.search
        && face.isSourceEnabled(source.sourceId)
        && face.isSourceMentionEnabled(source.sourceId))
      // Distribute the row budget across sources; the merged list is capped
      // again below. Search never persists anything: every hit is offered with
      // its real title and only a user pick runs `clues.ensure`.
      const perSourceLimit = Math.max(1, Math.ceil(limit / Math.max(1, sources.length)))
      const perSource = await mapWithLimit(sources, concurrency, async source =>
        searchSource(workspaceId, source.sourceId, request.query.trim(), request.signal, perSourceLimit, library))
      if (request.signal.aborted) return []
      return clueCandidateRows(mergeEntries([...pins, ...perSource.flat()]), displays, workspaceId)
    },
    onPick({ candidate, session, span }): CluePickOutcome {
      const value = parseCandidateValue(candidate.value)
      if (value === undefined || value.kind !== 'clue') return undefined
      try {
        if (value.id !== undefined) {
          // Already stored: the host applies the chip with its own pick span.
          const token = serializeClueToken('clue', value.id)
          return {
            insert: {
              source: CLUE_CODEC_SOURCE,
              ref: value.id,
              label: candidate.label ?? token,
              appearance: value.appearance ?? 'file',
              clipboardText: token,
            },
          }
        }
        if (
          value.sourceId === undefined || value.typeId === undefined || value.locator === undefined
          || value.title === undefined || value.workspaceId === undefined
        ) return undefined
        if (span === undefined) {
          notify(textOf(copy.clueInsertFailed))
          return 'handled'
        }
        // Not stored yet: the user's pick is the ONLY point that may persist
        // it. Start the ensure synchronously and answer handled (the host must
        // not insert anything on its own).
        ensureAndInsert(session, {
          sourceId: value.sourceId,
          typeId: value.typeId,
          locator: value.locator,
          title: value.title,
          workspaceId: value.workspaceId,
          appearance: value.appearance ?? 'file',
          label: candidate.label ?? escapeClueTitle(value.title),
        }, span)
        return 'handled'
      } catch (error) {
        report(error)
        notify(textOf(copy.clueInsertFailed))
        return undefined
      }
    },
    openReference(session, reference): boolean {
      if (options.openReference === undefined) return false
      try {
        const parsed = parseContentReference(reference.ref, copy)
        return options.openReference({
          kind: 'clue',
          id: parsed?.id ?? reference.ref,
          sessionId: session.sessionId,
        }) === true
      } catch (error) {
        report(error)
        return false
      }
    },
    codec: {
      clipboardText: (ref: string): string => tokenOfReference('clue', ref, copy),
      async serialize(ref: string, signal: AbortSignal): Promise<string> {
        throwIfAborted(signal)
        const content = parseContentReference(ref, copy)
        if (content === undefined) {
          // Default serialization is the token alone: no remote body read and
          // no authentication probe, so sending never blocks on a source.
          return serializeClueToken('clue', ref)
        }
        if (content.kind !== 'clue') {
          throw new ClueError('invalid-request', copy.contentReferenceError('kind-mismatch'))
        }
        const projection = await projectClueContent(content, signal)
        throwIfAborted(signal)
        return projection.text
      },
    },
  }

  const packsSource: ClueInputTriggerSource = {
    trigger: '@',
    name: PACK_CODEC_SOURCE,
    order: 1,
    showGroupTitle: false,
    async candidates(session, request): Promise<readonly ClueInputCandidate[]> {
      if (disposed) return []
      throwIfAborted(request.signal)
      if (!face.isPacksMentionEnabled()) return []
      const workspaceId = await workspaceOf(session, request.signal)
      if (workspaceId === undefined) return []
      const query = request.query.trim().toLowerCase()
      try {
        const result = await face.api.packsList(workspaceId)
        if (request.signal.aborted) return []
        const packs = result.packs
          .filter(pack => query === '' || pack.name.toLowerCase().includes(query))
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
          .slice(0, limit)
        return packCandidateRows(packs)
      } catch (error) {
        if (!request.signal.aborted) report(error)
        return []
      }
    },
    onPick({ candidate }): CluePickOutcome {
      const value = parseCandidateValue(candidate.value)
      if (value === undefined || value.kind !== 'pack' || value.id === undefined) return undefined
      try {
        const token = serializeClueToken('pack', value.id)
        return {
          insert: {
            source: PACK_CODEC_SOURCE,
            ref: value.id,
            label: candidate.label ?? token,
            appearance: 'folder',
            clipboardText: token,
          },
        }
      } catch (error) {
        report(error)
        notify(textOf(copy.packInsertFailed))
        return undefined
      }
    },
    openReference(session, reference): boolean {
      if (options.openReference === undefined) return false
      try {
        const parsed = parseContentReference(reference.ref, copy)
        return options.openReference({
          kind: 'pack',
          id: parsed?.id ?? reference.ref,
          sessionId: session.sessionId,
        }) === true
      } catch (error) {
        report(error)
        return false
      }
    },
    codec: {
      clipboardText: (ref: string): string => tokenOfReference('pack', ref, copy),
      async serialize(ref: string, signal: AbortSignal): Promise<string> {
        throwIfAborted(signal)
        const content = parseContentReference(ref, copy)
        if (content === undefined) return serializeClueToken('pack', ref)
        if (content.kind !== 'pack') {
          throw new ClueError('invalid-request', copy.contentReferenceError('kind-mismatch'))
        }
        const projection = await projectPackContent(content, signal)
        throwIfAborted(signal)
        return projection.text
      },
    },
  }

  return {
    sources: [cluesSource, packsSource],
    dispose(): void {
      disposed = true
      catalogue = undefined
      for (const controller of debounces) controller.abort()
      debounces.clear()
    },
  }
}

/**
 * Register both `@` sources against `ctx.inputTriggers`.
 *
 * The registration follows the Cordis lifecycle: the injected child scope owns
 * the source disposers, so an HMR reload never leaves a duplicate group.
 *
 * @param ctx - client plugin context.
 * @param options - same options as {@link createClueInputTriggers} except the
 *  face (read from `ctx.betterSidebar.clues` unless supplied).
 * @returns a disposer releasing the injection and both sources.
 */
export function installClueInputTriggers(
  ctx: Context,
  options: Omit<CreateClueInputTriggersOptions, 'face'> & { readonly face?: ClueMentionsFace },
): () => void {
  const context = ctx as unknown as MentionsContext
  const face = options.face ?? context.betterSidebar?.clues
  if (face === undefined) {
    context.logger?.warn?.('dsh-better-sidebar: no clue client face; the @ clue sources stay unregistered')
    return () => {}
  }
  if (typeof context.inject !== 'function') {
    context.logger?.warn?.('dsh-better-sidebar: ctx.inject is unavailable; the @ clue sources stay unregistered')
    return () => {}
  }
  const created = createClueInputTriggers({ ...options, face })
  const offInject = context.inject(['inputTriggers'], (injected) => {
    const triggerContext = injected as InjectedTriggerContext
    const service = (triggerContext.inputTriggers
      ?? triggerContext.get?.('inputTriggers')) as InputTriggerServiceLike | undefined
    if (service === undefined || typeof service.registerSource !== 'function') {
      context.logger?.warn?.('dsh-better-sidebar: the input-trigger service is unavailable; @ clue sources stay unregistered')
      return
    }
    const disposers = created.sources.map(source => service.registerSource(source))
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // `ctx.inject` hands back a Fiber, not a disposer function: calling it
    // threw a TypeError and skipped `created.dispose()` on HMR/plugin unload.
    try {
      disposeInjectedFiber(offInject)
    } finally {
      created.dispose()
    }
  }
}
