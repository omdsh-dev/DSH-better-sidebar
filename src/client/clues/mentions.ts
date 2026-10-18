/**
 * S5 composer integration: the two `@` trigger sources (client half).
 *
 * Registered names are the FROZEN codec names from S1 —
 * `better-sidebar:clues` and `better-sidebar:packs` — so a draft reference
 * keeps one codec even when a business source is disabled or unloaded. The
 * sources aggregate the clue extension face (`ctx.betterSidebar.clues`):
 *
 * - empty query: local pinned clues (clues source) and the local pack library
 *   (packs source); opening `@` never fetches remote resources;
 * - non-empty query: enabled/mention-enabled sources are searched with bounded
 *   concurrency and per-source failure isolation; the request signal cancels
 *   the in-flight searches, and stale results are dropped;
 * - browsing NEVER writes the workspace library. A search hit is offered only
 *   when it already maps to a stored clue (matched by clueId or by sourceId +
 *   locator); a lightweight, not-yet-persisted candidate is skipped. S1 §3
 *   forbids ensuring stable references on browse, and the host's synchronous
 *   `onPick` leaves no safe place to await `ensure` before an insert. New
 *   resources enter the library through a durable insertion surface (the
 *   sidebar action in S9, which can await `ensure`) and become mentionable
 *   afterwards;
 * - every row also offers an explicit "include content" option. The normal
 *   option inserts a stable token and serializes to that token alone — no
 *   remote body read, no auth probe. The content option encodes its mode in
 *   the opaque ref; at submit time the codec reads the CURRENT source content,
 *   adds source/read-time/freshness metadata, and rejects over-limit or
 *   partial reads so the host keeps the draft instead of silently truncating;
 * - `clipboardText` is always the stable token, including for content mode;
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
  readonly span?: unknown
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
  /**
   * Whether one source/type pair can read content. S9 wires this from the
   * cached source catalogue; omitted means "unknown" (treated as readable).
   * It only controls the explicit "include content" rows; plain references
   * stay available for read-only sources.
   */
  canRead?(sourceId: string, typeId: string): boolean
}

/**
 * One pre-send content preview, reported after a content-mode insert.
 *
 * The host composer has no preview surface of its own, so S9 may render this
 * notification (for example "includes 1.2k characters from GitHub"). `chars`
 * is the full submitted projection size; `overLimit` is set when the same
 * serialization would be refused at submit time.
 */
export interface ClueContentPreview {
  readonly kind: 'clue' | 'pack'
  readonly id: string
  readonly token: string
  readonly chars?: number
  readonly overLimit?: boolean
  readonly error?: { readonly category: string; readonly message: string }
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
  /** Appended to a content-mode candidate title (a getter is re-read per row). */
  readonly includeContentSuffix: LocalizedText
  /** Description of one default clue row. */
  readonly clueReferenceDescription: (source: string, type: string) => string
  /** Description of one content-mode clue row. */
  readonly clueContentDescription: (source: string, type: string) => string
  /** Description of one content-mode pack row. */
  readonly packContentDescription: (memberCount: number) => string
  /** Notice when a clue pick could not be inserted (a getter follows the live locale). */
  readonly clueInsertFailed: LocalizedText
  /** Notice when a pack pick could not be inserted (a getter follows the live locale). */
  readonly packInsertFailed: LocalizedText
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
   * Report the projected size (or failure) of an explicit content-mode insert
   * so the UI can show the volume before the user submits.
   */
  readonly onContentPreview?: (preview: ClueContentPreview) => void
  /** Section heading of the content-mode candidate rows (a getter follows the live locale). */
  readonly contentSection?: LocalizedText
  /**
   * Localized user-visible copy. Omitted fields keep the English defaults;
   * callbacks receive escaped display metadata only.
   */
  readonly copy?: Partial<ClueMentionsCopy>
  /** Maximum characters of one content-mode model projection (default 12000). */
  readonly includeContentMaxChars?: number
  /** Maximum pack members inlined by one content-mode projection (default 50). */
  readonly includeContentMaxMembers?: number
  /** Maximum rows returned per source and mode (default 20, hard cap 50). */
  readonly limit?: number
  /** Maximum concurrent source searches (default 4). */
  readonly concurrency?: number
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
/** Default content boundary; a larger projection blocks the send. */
const DEFAULT_INCLUDE_CONTENT_MAX_CHARS = 12_000
/** Default pack-member boundary of one content projection. */
const DEFAULT_INCLUDE_CONTENT_MAX_MEMBERS = 50
/** Default section heading of the explicit content-mode rows. */
const DEFAULT_CONTENT_SECTION = 'Include current content'
/** Prefix marking an opaque content-mode reference id. */
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

/** Run an observer callback without letting it break the composer. */
function callSafely(callback: () => void): void {
  try {
    callback()
  } catch {
    // Observers are presentation hooks; a broken one never breaks a pick.
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

/** Encode one content-mode ref. */
function encodeContentReference(reference: ContentReference, copy: ClueMentionsCopy): string {
  serializeClueToken(reference.kind, reference.id)
  if (reference.workspaceId === '') {
    throw new ClueError('invalid-request', copy.contentReferenceError('empty-workspace'))
  }
  if (reference.sessionId === '') {
    throw new ClueError('invalid-request', copy.contentReferenceError('empty-session'))
  }
  return `${CONTENT_REF_PREFIX}${JSON.stringify(reference)}`
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

/** Parse one candidate payload produced by this module. */
function parseCandidateValue(value: string | undefined): {
  kind: 'clue' | 'pack'
  id: string
  appearance?: 'file' | 'folder'
  mode?: 'content'
  workspaceId?: string
} | undefined {
  if (value === undefined) return undefined
  try {
    const raw = JSON.parse(value) as unknown
    if (raw === null || typeof raw !== 'object') return undefined
    const record = raw as {
      kind?: unknown
      id?: unknown
      appearance?: unknown
      mode?: unknown
      workspaceId?: unknown
    }
    if (record.kind !== 'clue' && record.kind !== 'pack') return undefined
    if (typeof record.id !== 'string' || record.id === '') return undefined
    if (record.mode !== undefined && record.mode !== 'content') return undefined
    if (record.mode === 'content' && (typeof record.workspaceId !== 'string' || record.workspaceId === '')) return undefined
    return {
      kind: record.kind,
      id: record.id,
      ...(record.appearance === 'file' || record.appearance === 'folder' ? { appearance: record.appearance } : {}),
      ...(record.mode === 'content' ? { mode: 'content' as const } : {}),
      ...(typeof record.workspaceId === 'string' && record.workspaceId !== '' ? { workspaceId: record.workspaceId } : {}),
    }
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

/** One effective clue row shared by pins and search results. */
interface ClueRow {
  readonly id: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  /** An imported row whose original locator is unresolved. */
  readonly unresolved?: boolean
}

/** The two presentation modes of one logical row. */
type CandidateMode = 'reference' | 'content'

/** Display name of one logical clue row (stable, escaped, no UUID alias). */
function clueDisplayName(row: ClueRow): string {
  return escapeClueTitle(row.title) || displayText(row.id, 'clue')
}

/** Build the composer candidate row for one stable clue. */
function clueCandidate(
  row: ClueRow,
  displayById: ReadonlyMap<string, ClueSourceDisplayDescriptor>,
  workspaceId: string,
  mode: CandidateMode,
  contentSection: string | undefined,
  copy: ClueMentionsCopy,
): ClueInputCandidate {
  const display = displayById.get(row.sourceId)
  const sourceName = displayText(display?.name ?? row.sourceId, 'clue source')
  const typeName = displayText(row.typeId, 'clue type')
  const title = clueDisplayName(row)
  const appearance = appearanceOf(row.typeId)
  const icon = wrapDisplayIcon(display?.icon, appearance)
  if (mode === 'content') {
    const label = `${title}${textOf(copy.includeContentSuffix)}`
    return {
      name: label,
      label,
      description: copy.clueContentDescription(sourceName, typeName),
      ...(contentSection === undefined ? {} : { section: contentSection }),
      icon,
      value: JSON.stringify({ kind: 'clue', id: row.id, appearance, mode: 'content', workspaceId }),
    }
  }
  return {
    name: title,
    label: title,
    description: copy.clueReferenceDescription(sourceName, typeName),
    icon,
    value: JSON.stringify({ kind: 'clue', id: row.id, appearance }),
  }
}

/** Build the composer candidate row for one stable pack. */
function packCandidate(
  pack: { readonly id: string; readonly name: string; readonly members: readonly string[] },
  workspaceId: string,
  mode: CandidateMode,
  contentSection: string | undefined,
  copy: ClueMentionsCopy,
): ClueInputCandidate {
  const name = escapeClueTitle(pack.name) || displayText(pack.id, 'clue pack')
  if (mode === 'content') {
    const label = `${name}${textOf(copy.includeContentSuffix)}`
    return {
      name: label,
      label,
      description: copy.packContentDescription(pack.members.length),
      ...(contentSection === undefined ? {} : { section: contentSection }),
      icon: 'folder',
      value: JSON.stringify({ kind: 'pack', id: pack.id, mode: 'content', workspaceId }),
    }
  }
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
  const contentSectionOf = (): string | undefined => {
    const value = options.contentSection === undefined
      ? DEFAULT_CONTENT_SECTION
      : textOf(options.contentSection)
    return value === '' ? undefined : value
  }
  const copy: ClueMentionsCopy = { ...DEFAULT_COPY, ...options.copy }
  const includeContentMaxChars = positiveOf(options.includeContentMaxChars, DEFAULT_INCLUDE_CONTENT_MAX_CHARS)
  const includeContentMaxMembers = positiveOf(options.includeContentMaxMembers, DEFAULT_INCLUDE_CONTENT_MAX_MEMBERS)
  /** Single-entry bounded catalogue cache (ids are persisted elsewhere). */
  let catalogue: { readonly at: number; readonly value: CluesSourcesCatalogResult } | undefined
  /** In-flight preview reads; aborted with the sources. */
  const previews = new Set<AbortController>()
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

  /** Local pinned clues matching one query (empty query = every pin, ordered). */
  const pinnedRowsOf = (local: LocalLibrary, query: string): ClueRow[] => {
    const byId = new Map(local.library.clues.map(clue => [clue.id, clue]))
    const rows: ClueRow[] = []
    for (const pin of local.pins.pins) {
      const clue = byId.get(pin.clueId)
      if (clue === undefined) continue
      if (query !== '' && !clue.title.toLowerCase().includes(query)) continue
      if (!face.isSourceEnabled(clue.sourceId)) continue
      // A per-source @ switch also hides that source's pinned rows; the
      // switch is presentation only, so explicit reads stay available.
      if (!face.isSourceMentionEnabled(clue.sourceId)) continue
      rows.push({
        id: clue.id,
        title: clue.title,
        sourceId: clue.sourceId,
        typeId: clue.typeId,
        ...(clue.unresolved === undefined ? {} : { unresolved: true }),
      })
    }
    return rows
  }

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

  /**
   * Content-read capability of one source/type pair.
   *
   * `face.canRead` wins when the wiring layer provides it. Otherwise the live
   * source catalogue is used, but only a POSITIVE "cannot read" answer hides a
   * row: a source/type missing from a degraded catalogue is treated as unknown
   * rather than silently losing its content option.
   */
  const readableOf = (catalog: CluesSourcesCatalogResult | undefined): ((sourceId: string, typeId: string) => boolean) => {
    const sourceRead = new Map<string, boolean>()
    const typeRead = new Map<string, boolean>()
    for (const source of catalog?.sources ?? []) sourceRead.set(source.sourceId, source.capabilities.read)
    for (const type of catalog?.types ?? []) typeRead.set(`${type.sourceId}\u0000${type.typeId}`, type.capabilities.read)
    return (sourceId: string, typeId: string): boolean => {
      const explicit = face.canRead?.(sourceId, typeId)
      if (explicit !== undefined) return explicit
      if (sourceRead.get(sourceId) === false) return false
      if (typeRead.get(`${sourceId}\u0000${typeId}`) === false) return false
      return true
    }
  }

  /**
   * Search one enabled source and keep only hits that already have a stable
   * workspace clue. S1 §3 forbids persisting lightweight candidates on browse,
   * and the synchronous host `onPick` cannot await `ensure` before inserting,
   * so a not-yet-stored candidate is deliberately not offered here. It becomes
   * mentionable after the sidebar's durable insertion path ensures it.
   */
  const searchSource = async (
    workspaceId: string,
    sourceId: string,
    query: string,
    signal: AbortSignal,
    perSourceLimit: number,
    library: { byId: Map<string, Clue>; byLocator: Map<string, Clue> },
  ): Promise<ClueRow[]> => {
    let result: ClueListResult
    try {
      result = await face.api.search(workspaceId, { sourceId, query, limit: perSourceLimit }, signal)
    } catch (error) {
      if (!signal.aborted) report(error, sourceId)
      return []
    }
    if (signal.aborted) return []
    const rows: ClueRow[] = []
    const seen = new Set<string>()
    for (const candidate of result.items.slice(0, perSourceLimit)) {
      if (signal.aborted) return []
      const stored = library.byLocator.get(storedLocatorKey(candidate.sourceId, candidate.locator))
        ?? (candidate.clueId === undefined ? undefined : library.byId.get(candidate.clueId))
      // No `ensure`: browsing must never rewrite the library.
      if (stored === undefined || seen.has(stored.id)) continue
      seen.add(stored.id)
      rows.push({
        id: stored.id,
        title: stored.title,
        sourceId: stored.sourceId,
        typeId: stored.typeId,
        ...(stored.unresolved === undefined ? {} : { unresolved: true }),
      })
    }
    return rows
  }

  /** Build the normal rows plus the explicit content-mode rows of one list. */
  const clueCandidateRows = (
    rows: readonly ClueRow[],
    displays: ReadonlyMap<string, ClueSourceDisplayDescriptor>,
    workspaceId: string,
    readable: (sourceId: string, typeId: string) => boolean,
  ): ClueInputCandidate[] => {
    const valid = rows.filter(row => {
      if (clueTokenOrUndefined('clue', row.id) !== undefined) return true
      report(new ClueError('invalid-request', 'a workspace clue id cannot be represented as a stable token; the row was hidden'))
      return false
    })
    const contentSection = contentSectionOf()
    return [
      ...valid.map(row => clueCandidate(row, displays, workspaceId, 'reference', contentSection, copy)),
      // A content option that is guaranteed to fail on send is worse than no
      // option: hide it for unresolved rows and sources/types without read.
      ...valid
        .filter(row => row.unresolved !== true && readable(row.sourceId, row.typeId))
        .map(row => clueCandidate(row, displays, workspaceId, 'content', contentSection, copy)),
    ]
  }

  /** Build the normal rows plus the explicit content-mode rows of one pack list. */
  const packCandidateRows = (
    packs: readonly { readonly id: string; readonly name: string; readonly members: readonly string[] }[],
    workspaceId: string,
    memberOf: (clueId: string) => Clue | undefined,
    readable: (sourceId: string, typeId: string) => boolean,
  ): ClueInputCandidate[] => {
    const valid = packs.filter(pack => {
      if (clueTokenOrUndefined('pack', pack.id) !== undefined) return true
      report(new ClueError('invalid-request', 'a workspace pack id cannot be represented as a stable token; the row was hidden'))
      return false
    })
    const contentCapable = (pack: { readonly members: readonly string[] }): boolean =>
      pack.members.length > 0 && pack.members.every(clueId => {
        const clue = memberOf(clueId)
        return clue !== undefined && clue.unresolved === undefined && readable(clue.sourceId, clue.typeId)
      })
    const contentSection = contentSectionOf()
    return [
      ...valid.map(pack => packCandidate(pack, workspaceId, 'reference', contentSection, copy)),
      ...valid
        .filter(contentCapable)
        .map(pack => packCandidate(pack, workspaceId, 'content', contentSection, copy)),
    ]
  }

  /** Enforce the configured content boundary. */
  const boundedProjection = (text: string): ContentProjection => {
    if (text.length > includeContentMaxChars) {
      throw new ContentLimitError(text.length, includeContentMaxChars, copy.contentLimit(text.length, includeContentMaxChars))
    }
    return { text, chars: text.length }
  }

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
      result = await face.api.read(reference.workspaceId, contentReadInput(reference, reference.id), signal)
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
        result = await face.api.read(reference.workspaceId, contentReadInput(reference, clue.id), signal)
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

  /** Project one content-mode reference. */
  const projectContent = async (reference: ContentReference, signal: AbortSignal): Promise<ContentProjection> => {
    return reference.kind === 'clue'
      ? projectClueContent(reference, signal)
      : projectPackContent(reference, signal)
  }

  /** Report the pre-send volume of one explicit content-mode insert. */
  const startContentPreview = (reference: ContentReference): void => {
    const observer = options.onContentPreview
    if (observer === undefined) return
    const controller = new AbortController()
    previews.add(controller)
    void (async () => {
      let token: string
      try {
        token = serializeClueToken(reference.kind, reference.id)
      } catch {
        previews.delete(controller)
        return
      }
      try {
        const projection = await projectContent(reference, controller.signal)
        if (disposed || controller.signal.aborted) return
        callSafely(() => observer({ kind: reference.kind, id: reference.id, token, chars: projection.chars }))
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        const limit = error instanceof ContentLimitError
          ? { overLimit: true as const, chars: error.size }
          : {}
        callSafely(() => observer({
          kind: reference.kind,
          id: reference.id,
          token,
          ...limit,
          error: { category: categoryOf(error), message: messageOf(error) },
        }))
      } finally {
        previews.delete(controller)
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
      const workspaceId = await workspaceOf(session, request.signal)
      if (workspaceId === undefined) return []
      const query = request.query.trim().toLowerCase()
      const displays = displayMap()
      if (query === '') {
        const local = await localLibraryOf(workspaceId, request.signal)
        if (request.signal.aborted) return []
        return clueCandidateRows(
          pinnedRowsOf(local, '').slice(0, limit),
          displays,
          workspaceId,
          readableOf(undefined),
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
      // again below. A broad query cannot persist anything: search only maps
      // hits to clues that are already stored.
      const perSourceLimit = Math.max(1, Math.ceil(limit / Math.max(1, sources.length)))
      const perSource = await mapWithLimit(sources, concurrency, async source =>
        searchSource(workspaceId, source.sourceId, request.query.trim(), request.signal, perSourceLimit, library))
      if (request.signal.aborted) return []
      const seen = new Set<string>()
      const merged: ClueRow[] = []
      for (const row of [...pins, ...perSource.flat()]) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        merged.push(row)
        if (merged.length >= limit) break
      }
      return clueCandidateRows(merged, displays, workspaceId, readableOf(catalog))
    },
    onPick({ candidate, session }): CluePickOutcome {
      const value = parseCandidateValue(candidate.value)
      if (value === undefined || value.kind !== 'clue') return undefined
      try {
        const token = serializeClueToken('clue', value.id)
        const content = value.mode === 'content'
        const reference: ContentReference | undefined = content
          ? {
              kind: 'clue',
              id: value.id,
              workspaceId: value.workspaceId!,
              // The composer session travels opaquely in the ref and is handed
              // to the source at send time (session-scoped approvals/routes).
              ...(session.sessionId === '' ? {} : { sessionId: session.sessionId }),
            }
          : undefined
        if (reference !== undefined) startContentPreview(reference)
        return {
          insert: {
            source: CLUE_CODEC_SOURCE,
            ref: reference === undefined ? value.id : encodeContentReference(reference, copy),
            label: candidate.label ?? token,
            appearance: value.appearance ?? 'file',
            clipboardText: token,
          },
        }
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
        const [result, library] = await Promise.all([
          face.api.packsList(workspaceId),
          // The content option needs each member's source/type; an explicit
          // pack page reads members from the same library.
          face.api.clues(workspaceId).catch((error: unknown) => {
            if (!request.signal.aborted) report(error)
            return { clues: [], revision: 0 } as CluesLibraryResult
          }),
        ])
        if (request.signal.aborted) return []
        const catalog = query === '' ? undefined : await catalogueOf(request.signal)
        if (request.signal.aborted) return []
        const packs = result.packs
          .filter(pack => query === '' || pack.name.toLowerCase().includes(query))
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
          .slice(0, limit)
        const clueById = new Map(library.clues.map(clue => [clue.id, clue]))
        return packCandidateRows(packs, workspaceId, id => clueById.get(id), readableOf(catalog))
      } catch (error) {
        if (!request.signal.aborted) report(error)
        return []
      }
    },
    onPick({ candidate, session }): CluePickOutcome {
      const value = parseCandidateValue(candidate.value)
      if (value === undefined || value.kind !== 'pack') return undefined
      try {
        const token = serializeClueToken('pack', value.id)
        const content = value.mode === 'content'
        const reference: ContentReference | undefined = content
          ? {
              kind: 'pack',
              id: value.id,
              workspaceId: value.workspaceId!,
              ...(session.sessionId === '' ? {} : { sessionId: session.sessionId }),
            }
          : undefined
        if (reference !== undefined) startContentPreview(reference)
        return {
          insert: {
            source: PACK_CODEC_SOURCE,
            ref: reference === undefined ? value.id : encodeContentReference(reference, copy),
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
      for (const controller of previews) controller.abort()
      previews.clear()
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
