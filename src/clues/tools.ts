/**
 * The local read seam of the clue reference protocol (S5, post-tool revision).
 *
 * The former model-facing clue tools no longer exist: the host exposes one
 * fixed loopback HTTP read route instead (`./agent-read.ts`), and the prompt
 * tells the agent how to call it with `curl`. This module owns the business
 * half that route uses, and nothing else:
 *
 * - one reference must parse to exactly one token (`[[dsh-clue:<id>]]`,
 *   `[[dsh-cluepack:<id>]]` or `[[dsh-clue-snapshot:<id>]]`), reusing the
 *   shared parser in `context/tokens.ts`;
 * - a normal clue token is a LIVE read of the source's CURRENT content. A live
 *   failure is returned as the fixed clue category/message and NEVER falls
 *   back to a stored snapshot;
 * - `commentsCursor` / `parentId` on a clue token dispatch to the comments
 *   reader directly: they page the discussion without re-reading the body;
 * - a live read and a stored snapshot project their `discussion` field. A
 *   legacy snapshot that captured no discussion is explicitly
 *   `status:'not-captured'`, never an empty "no comments" page;
 * - a snapshot token reads exactly that local snapshot (fetch time, creation
 *   time and integrity are explicit), even when its source is gone;
 * - a pack token returns the pack's CURRENT member metadata only — never a
 *   member body — in bounded pages;
 * - the requested workspace must be a registered workspace id. That workspace
 *   is searched first, then the other registered workspaces are scanned
 *   forward with a hard bound, so a stable reference stays readable from
 *   another workspace. The scan is convenience, not an access model.
 *
 * Every failure projected across this seam is a fixed `ClueError` category and
 * a safe message. Unknown transport/store failures collapse to a generic
 * `failed`; raw stdout/stderr, credentials or environment values never enter
 * the value.
 */
import { parseClueToken, parseClueTokens, serializeClueToken, type ClueToken } from './context/tokens.ts'
import {
  ClueError,
  type Clue,
  type ClueAsset,
  type ClueDiscussionPage,
  type ClueSnapshotMeta,
  type ClueSnapshotRecord,
  type ClueCommentsListParams,
  type JsonValue,
} from './types.ts'
import type { ClueCallOptions, CluesService } from './service.ts'

/** Hard bound of workspaces one read may inspect (primary first). */
export const MAX_AGENT_READ_WORKSPACES = 64
/** Maximum pack member rows returned by one read page. */
export const MAX_AGENT_READ_PACK_MEMBERS = 50
/** Maximum snapshot-metadata rows returned per clue/member page. */
export const MAX_AGENT_READ_SNAPSHOTS = 20
/** The fixed local reader route shared by the host route and the prompt text. */
export const CLUE_AGENT_READ_ROUTE_PATH = '/sidebar/agent/clues/read'

/** Parse an IPv4 dotted quad, with every octet range-checked. */
function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    octets.push(octet)
  }
  return octets
}

/**
 * Whether an address is loopback. Accepts 127/8, `::1`, and the IPv4-mapped
 * spellings Node reports on dual-stack listeners. Used by BOTH the HTTP gate
 * (real peer socket) and the prompt origin check.
 */
export function isLoopbackAddress(address: string): boolean {
  if (typeof address !== 'string') return false
  const value = address.trim().toLowerCase().replace(/%.*$/u, '')
  const ipv4 = parseIpv4(value)
  if (ipv4 !== undefined) return ipv4[0] === 127
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  const mappedDotted = /^::ffff:(.+)$/u.exec(value)
  if (mappedDotted !== null) {
    const mapped = parseIpv4(mappedDotted[1]!)
    if (mapped !== undefined) return mapped[0] === 127
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value)
  if (mappedHex !== null) {
    return (Number.parseInt(mappedHex[1]!, 16) & 0xff00) === 0x7f00
  }
  const expandedMapped = /^0:0:0:0:0:ffff:(.+)$/u.exec(value)
  if (expandedMapped !== null) {
    const mapped = parseIpv4(expandedMapped[1]!)
    if (mapped !== undefined) return mapped[0] === 127
  }
  return false
}

/** One safe, stable error projection (category + safe message only). */
export interface ClueReaderError {
  readonly category: string
  readonly message: string
}

/** One workspace registration the reader may address. */
export interface ClueReaderWorkspace {
  readonly id: string
  readonly path?: string
}

/** The host workspace-registry slice this reader consumes (structural). */
export interface ClueReaderRegistry {
  get?(id: string): { readonly id?: unknown; readonly path?: unknown } | undefined
  list?(): readonly { readonly id?: unknown; readonly path?: unknown }[]
}

/** One snapshot metadata row (no body). */
export interface ClueReaderSnapshotMeta {
  readonly snapshotId: string
  readonly clueId: string
  readonly format: string
  readonly fetchedAt: string
  readonly createdAt: string
  readonly integrity?: 'verified' | 'unknown'
  readonly sourceVersion?: string
}

/** One pack member row (metadata only; never a body). */
export interface ClueReaderMember {
  readonly clueId: string
  readonly token?: string
  readonly title?: string
  readonly sourceId?: string
  readonly typeId?: string
  readonly unresolved?: boolean
  readonly missing?: boolean
  /** Bounded snapshot-metadata page for this member. */
  readonly snapshots?: readonly ClueReaderSnapshotMeta[]
  /** True total for this member, not only this page. */
  readonly snapshotCount?: number
  readonly snapshotsLimited?: boolean
  readonly snapshotNextOffset?: number
}

/** Canonical value of one local read. */
export interface ClueReaderValue {
  readonly status: 'ok' | 'error'
  readonly kind: 'clue' | 'pack' | 'snapshot'
  readonly id: string
  readonly token?: string
  readonly workspaceId?: string
  readonly error?: ClueReaderError
  readonly title?: string
  readonly sourceId?: string
  readonly typeId?: string
  readonly format?: string
  readonly freshness?: 'live' | 'snapshot'
  readonly fetchedAt?: string
  readonly revision?: string
  readonly text?: string
  readonly data?: JsonValue
  readonly assets?: readonly ClueAsset[]
  readonly limited?: boolean
  readonly nextOffset?: number
  /**
   * Discussion page carried by a live read, a stored snapshot, or an explicit
   * comments follow-up (`commentsCursor` / `parentId`). A legacy snapshot
   * without captured discussion is explicitly `status: 'not-captured'`.
   */
  readonly discussion?: ClueDiscussionPage
  /** Requested snapshot-metadata page (clue and pack reads). */
  readonly snapshotOffset?: number
  readonly snapshots?: readonly ClueReaderSnapshotMeta[]
  /** True snapshot total for this clue (not only this page). */
  readonly snapshotCount?: number
  readonly snapshotsLimited?: boolean
  readonly snapshotNextOffset?: number
  /** The local snapshot index could not be read; never reported as "none". */
  readonly snapshotsUnavailable?: ClueReaderError
  readonly clueId?: string
  readonly createdAt?: string
  readonly integrity?: 'verified' | 'unknown'
  readonly sourceVersion?: string
  readonly unresolved?: boolean
  readonly name?: string
  readonly packRevision?: number
  readonly memberCount?: number
  readonly offset?: number
  readonly limit?: number
  readonly members?: readonly ClueReaderMember[]
}

/** One read request: a registered workspace scope plus exactly one token. */
export interface ClueReaderRequest {
  readonly workspaceId: string
  readonly token: ClueToken
  /** Explicit offset for a pageable live clue read. */
  readonly offset?: number
  /**
   * Follow-up discussion page cursor. A clue read with this field calls the
   * comments reader directly; the resource body is NOT re-read.
   */
  readonly commentsCursor?: string
  /**
   * List one comment's replies. A clue read with this field calls the comments
   * reader directly; the resource body is NOT re-read.
   */
  readonly parentId?: string
  /** Snapshot-metadata page offset (clue and pack reads). */
  readonly snapshotOffset?: number
}

/** Dependencies of {@link readClueReference}. */
export interface ClueReaderOptions {
  readonly clues: CluesService
  readonly registry?: ClueReaderRegistry
  /** The agent session that initiated the read (source approval/route context). */
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

/**
 * The target public comments reader the parent service will expose (UI19).
 *
 * Declared structurally so this module compiles before the shared service
 * wiring lands. A missing method is reported as an explicit `unsupported`
 * failure — never replaced by a body re-read or an empty page.
 */
interface ClueCommentsReader {
  readonly commentsList?: (
    params: ClueCommentsListParams,
    options?: ClueCallOptions,
  ) => Promise<ClueDiscussionPage>
}

/** Parse the fixed request reference; embedded/absent/multiple tokens fail. */
export function parseReaderReference(reference: string): ClueToken {
  if (typeof reference !== 'string') {
    throw new ClueError('invalid-request', 'reference must be one clue token')
  }
  const trimmed = reference.trim()
  const token = parseClueToken(trimmed)
  if (token === undefined || parseClueTokens(trimmed).length !== 1) {
    throw new ClueError('invalid-request', 'reference must be exactly one clue, pack or snapshot token')
  }
  return token
}

/** One registration row, when it carries a usable id. */
function workspaceOf(value: { readonly id?: unknown; readonly path?: unknown } | undefined): ClueReaderWorkspace | undefined {
  if (value === undefined) return undefined
  const id = value.id
  if (typeof id !== 'string' || id === '') return undefined
  const path = typeof value.path === 'string' && value.path !== '' ? value.path : undefined
  return path === undefined ? { id } : { id, path }
}

/**
 * Every registered workspace, bounded and de-duplicated in registry order.
 * Exported so the bound itself is directly testable.
 */
export function boundedWorkspaceScopes(registry?: ClueReaderRegistry): ClueReaderWorkspace[] {
  if (registry?.list === undefined) return []
  let listed: readonly { readonly id?: unknown; readonly path?: unknown }[]
  try {
    listed = registry.list() ?? []
  } catch {
    return []
  }
  const scopes: ClueReaderWorkspace[] = []
  const seen = new Set<string>()
  for (const row of listed) {
    const scope = workspaceOf(row)
    if (scope === undefined || seen.has(scope.id)) continue
    seen.add(scope.id)
    scopes.push(scope)
    if (scopes.length >= MAX_AGENT_READ_WORKSPACES) break
  }
  return scopes
}

/**
 * Resolve the REQUESTED workspace registration. The input must bind one of the
 * host's registered workspace ids; an unknown id is not a scope.
 */
export function requestedWorkspaceScope(
  registry: ClueReaderRegistry | undefined,
  workspaceId: string,
): ClueReaderWorkspace | undefined {
  if (registry === undefined || typeof workspaceId !== 'string' || workspaceId === '') return undefined
  if (typeof registry.get === 'function') {
    try {
      return workspaceOf(registry.get(workspaceId))
    } catch {
      return undefined
    }
  }
  return boundedWorkspaceScopes(registry).find(scope => scope.id === workspaceId)
}

/** Candidate scan order: the requested workspace first, then bounded others. */
function candidateScopes(primary: ClueReaderWorkspace, registry?: ClueReaderRegistry): ClueReaderWorkspace[] {
  const scopes = [primary]
  const seen = new Set([primary.id])
  for (const scope of boundedWorkspaceScopes(registry)) {
    if (seen.has(scope.id)) continue
    seen.add(scope.id)
    scopes.push(scope)
    if (scopes.length >= MAX_AGENT_READ_WORKSPACES) break
  }
  return scopes
}

/** The safe fixed projection of any thrown value. */
function safeErrorOf(error: unknown): ClueReaderError {
  if (error instanceof ClueError) return { category: error.category, message: error.message }
  return { category: 'failed', message: 'the clue operation failed' }
}

/** One fixed invalid-request value that never touches the service. */
function invalidRequestValue(token: ClueToken, message: string): ClueReaderValue {
  return {
    status: 'error',
    kind: token.kind,
    id: token.id,
    error: { category: 'invalid-request', message },
  }
}

/** A stable token when the stored id can be represented, else undefined. */
function tokenOrUndefined(kind: ClueToken['kind'], id: string): string | undefined {
  try {
    return serializeClueToken(kind, id)
  } catch {
    return undefined
  }
}

/** Refuse an already-aborted read before touching the service. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ClueError('cancelled', 'the clue read was cancelled')
}

/** Project one stored snapshot metadata row (no content). */
function snapshotMetaOf(meta: ClueSnapshotMeta): ClueReaderSnapshotMeta {
  return {
    snapshotId: meta.snapshotId,
    clueId: meta.clueId,
    format: meta.format,
    fetchedAt: meta.fetchedAt,
    createdAt: meta.createdAt,
    ...(meta.integrity === undefined ? {} : { integrity: meta.integrity }),
    ...(meta.sourceVersion === undefined ? {} : { sourceVersion: meta.sourceVersion }),
  }
}

/** Group snapshot metadata by clue, newest first (the full local index). */
function groupSnapshotMetas(metas: readonly ClueSnapshotMeta[]): Map<string, ClueReaderSnapshotMeta[]> {
  const grouped = new Map<string, ClueReaderSnapshotMeta[]>()
  for (const meta of metas) {
    const rows = grouped.get(meta.clueId) ?? []
    rows.push(snapshotMetaOf(meta))
    grouped.set(meta.clueId, rows)
  }
  for (const [clueId, rows] of grouped) {
    grouped.set(clueId, rows.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.snapshotId.localeCompare(left.snapshotId)))
  }
  return grouped
}

/** One bounded snapshot-metadata page plus its true total. */
interface SnapshotPage {
  readonly rows: readonly ClueReaderSnapshotMeta[]
  readonly total: number
  readonly offset: number
  readonly nextOffset?: number
}

/** Page one clue/member's snapshot metadata; `offset` is caller-controlled. */
function snapshotPageOf(rows: readonly ClueReaderSnapshotMeta[], offset: number): SnapshotPage {
  const start = Math.min(offset, rows.length)
  const page = rows.slice(start, start + MAX_AGENT_READ_SNAPSHOTS)
  const nextOffset = start + page.length < rows.length ? start + page.length : undefined
  return {
    rows: page,
    total: rows.length,
    offset,
    ...(nextOffset === undefined ? {} : { nextOffset }),
  }
}

/** The local snapshot index of one owning workspace (or its safe failure). */
interface SnapshotIndex {
  readonly byClue: Map<string, ClueReaderSnapshotMeta[]>
  readonly error?: ClueReaderError
}

/** Read the owner workspace's snapshot index; a failure is explicit, never 0. */
async function snapshotIndexOf(options: ClueReaderOptions, workspaceId: string): Promise<SnapshotIndex> {
  try {
    return { byClue: groupSnapshotMetas(await options.clues.listSnapshots(workspaceId)) }
  } catch (error) {
    return { byClue: new Map(), error: safeErrorOf(error) }
  }
}

/** Attach one snapshot page to a canonical value. */
function withSnapshotPage(value: ClueReaderValue, page: SnapshotPage): ClueReaderValue {
  return {
    ...value,
    snapshotOffset: page.offset,
    snapshotCount: page.total,
    ...(page.rows.length === 0 ? {} : { snapshots: page.rows }),
    ...(page.nextOffset === undefined
      ? {}
      : { snapshotsLimited: true, snapshotNextOffset: page.nextOffset }),
  }
}

/** Attach the owner's snapshot index page (or its explicit failure). */
function withSnapshotIndex(
  value: ClueReaderValue,
  clueId: string,
  index: SnapshotIndex,
  offset: number,
): ClueReaderValue {
  if (index.error !== undefined) {
    return { ...value, snapshotOffset: offset, snapshotsUnavailable: index.error }
  }
  return withSnapshotPage(value, snapshotPageOf(index.byClue.get(clueId) ?? [], offset))
}

/** One located clue and the workspace that owns it. */
interface LocatedClue {
  readonly workspace: ClueReaderWorkspace
  readonly clue: Clue
}

/** One located pack and its workspace. */
interface LocatedPack {
  readonly workspace: ClueReaderWorkspace
  readonly pack: { readonly id: string; readonly name: string; readonly revision: number; readonly members: readonly string[] }
}

/** Locate a clue by stable id across the bounded candidate scopes. */
async function locateClue(
  clues: CluesService,
  scopes: readonly ClueReaderWorkspace[],
  clueId: string,
): Promise<{ readonly found?: LocatedClue; readonly error?: ClueReaderError }> {
  let failure: ClueReaderError | undefined
  for (const workspace of scopes) {
    try {
      const library = await clues.listClues(workspace.id)
      const clue = library.clues.find(candidate => candidate.id === clueId)
      if (clue !== undefined) return { found: { workspace, clue } }
    } catch (error) {
      failure ??= safeErrorOf(error)
    }
  }
  return failure === undefined ? {} : { error: failure }
}

/** Locate a pack by stable id across the bounded candidate scopes. */
async function locatePack(
  clues: CluesService,
  scopes: readonly ClueReaderWorkspace[],
  packId: string,
): Promise<{ readonly found?: LocatedPack; readonly error?: ClueReaderError }> {
  let failure: ClueReaderError | undefined
  for (const workspace of scopes) {
    try {
      const result = await clues.listPacks(workspace.id)
      const pack = result.packs.find(candidate => candidate.id === packId)
      if (pack !== undefined) return { found: { workspace, pack } }
    } catch (error) {
      failure ??= safeErrorOf(error)
    }
  }
  return failure === undefined ? {} : { error: failure }
}

/**
 * Read one explicit discussion follow-up for a located clue.
 *
 * The comments reader is called DIRECTLY: the resource body is never re-read,
 * so paging through a long discussion does not refetch the whole document.
 * A missing service method or a source failure is a fixed safe error value.
 */
async function readClueComments(
  options: ClueReaderOptions,
  workspace: ClueReaderWorkspace,
  clue: Clue,
  request: ClueReaderRequest,
): Promise<ClueReaderValue> {
  const tokenText = tokenOrUndefined('clue', clue.id)
  const base = {
    status: 'ok' as const,
    kind: 'clue' as const,
    id: clue.id,
    ...(tokenText === undefined ? {} : { token: tokenText }),
    workspaceId: workspace.id,
    title: clue.title,
    sourceId: clue.sourceId,
    typeId: clue.typeId,
    ...(clue.unresolved === undefined ? {} : { unresolved: true as const }),
  }
  const comments = options.clues as CluesService & ClueCommentsReader
  if (typeof comments.commentsList !== 'function') {
    return {
      ...base,
      status: 'error',
      error: { category: 'unsupported', message: 'the local clue service cannot list clue discussion' },
    }
  }
  throwIfAborted(options.signal)
  try {
    const discussion = await comments.commentsList({
      workspaceId: workspace.id,
      clueId: clue.id,
      ...(request.commentsCursor === undefined ? {} : { cursor: request.commentsCursor }),
      ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
    }, {
      caller: 'agent',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    })
    throwIfAborted(options.signal)
    return { ...base, discussion }
  } catch (error) {
    return {
      ...base,
      status: 'error',
      error: safeErrorOf(error),
    }
  }
}

/** Project one read result's content fields (never invent a body). */
function contentFields(result: {
  readonly format?: string
  readonly text?: string
  readonly data?: JsonValue
  readonly assets?: readonly ClueAsset[]
  readonly limited?: boolean
  readonly nextOffset?: number
  readonly discussion?: ClueDiscussionPage
}): Pick<ClueReaderValue, 'format' | 'text' | 'data' | 'assets' | 'limited' | 'nextOffset' | 'discussion'> {
  return {
    ...(result.format === undefined ? {} : { format: result.format }),
    ...(result.text === undefined ? {} : { text: result.text }),
    ...(result.text === undefined && result.data !== undefined ? { data: result.data } : {}),
    ...(result.assets === undefined ? {} : { assets: result.assets }),
    ...(result.limited === undefined ? {} : { limited: result.limited }),
    ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }),
    ...(result.discussion === undefined ? {} : { discussion: result.discussion }),
  }
}

/** Explicit page for a legacy snapshot that never captured discussion. */
function notCapturedDiscussion(fetchedAt: string): ClueDiscussionPage {
  return {
    status: 'not-captured',
    items: [],
    fetchedAt,
    complete: false,
    coverage: 'document',
  }
}

/** Project one snapshot read (its own content, never a live fallback). */
function snapshotValue(workspaceId: string, record: ClueSnapshotRecord): ClueReaderValue {
  const { meta, content } = record
  return {
    status: 'ok',
    kind: 'snapshot',
    id: meta.snapshotId,
    ...(tokenOrUndefined('snapshot', meta.snapshotId) === undefined
      ? {}
      : { token: tokenOrUndefined('snapshot', meta.snapshotId)! }),
    workspaceId,
    clueId: meta.clueId,
    freshness: 'snapshot',
    fetchedAt: meta.fetchedAt,
    createdAt: meta.createdAt,
    integrity: meta.integrity ?? 'unknown',
    ...(meta.sourceVersion === undefined ? {} : { sourceVersion: meta.sourceVersion }),
    ...contentFields(content),
    // A legacy snapshot never captured discussion: say so explicitly instead
    // of leaving the field absent (which a caller could read as "no comments").
    ...(content.discussion === undefined ? { discussion: notCapturedDiscussion(meta.fetchedAt) } : {}),
  }
}

/** Read one explicit local snapshot from the bounded candidate scopes. */
async function readSnapshotValue(
  options: ClueReaderOptions,
  scopes: readonly ClueReaderWorkspace[],
  token: ClueToken,
): Promise<ClueReaderValue> {
  for (const workspace of scopes) {
    throwIfAborted(options.signal)
    try {
      const record = await options.clues.readSnapshot({
        workspaceId: workspace.id,
        snapshotId: token.id,
      })
      return snapshotValue(workspace.id, record)
    } catch (error) {
      const safe = safeErrorOf(error)
      // A snapshot id is a global-local identity here: a miss in this
      // workspace is not a failure of the scan, so keep looking.
      if (safe.category !== 'not-found') {
        return { status: 'error', kind: 'snapshot', id: token.id, error: safe }
      }
    }
  }
  return {
    status: 'error',
    kind: 'snapshot',
    id: token.id,
    error: { category: 'not-found', message: `clue snapshot "${token.id}" does not exist in any local workspace` },
  }
}

/** One member's bounded snapshot-metadata fields (empty when index failed). */
function memberSnapshotFields(
  clueId: string,
  index: SnapshotIndex,
  snapshotOffset: number,
): Pick<ClueReaderMember, 'snapshots' | 'snapshotCount' | 'snapshotsLimited' | 'snapshotNextOffset'> {
  if (index.error !== undefined) return {}
  const page = snapshotPageOf(index.byClue.get(clueId) ?? [], snapshotOffset)
  return {
    ...(page.rows.length === 0 ? {} : { snapshots: page.rows }),
    snapshotCount: page.total,
    ...(page.nextOffset === undefined
      ? {}
      : { snapshotsLimited: true, snapshotNextOffset: page.nextOffset }),
  }
}

/** Return the pack's CURRENT member metadata in one bounded page. */
function packValue(
  located: LocatedPack,
  clues: readonly Clue[],
  offset: number,
  index: SnapshotIndex,
  snapshotOffset: number,
): ClueReaderValue {
  const { workspace, pack } = located
  const clueById = new Map(clues.map(clue => [clue.id, clue]))
  const allMembers = pack.members
  const start = Math.min(offset, allMembers.length)
  const pageIds = allMembers.slice(start, start + MAX_AGENT_READ_PACK_MEMBERS)
  const nextOffset = start + pageIds.length < allMembers.length
    ? start + pageIds.length
    : undefined
  const members: ClueReaderMember[] = pageIds.map((clueId) => {
    const snapshotFields = memberSnapshotFields(clueId, index, snapshotOffset)
    const clue = clueById.get(clueId)
    if (clue === undefined) return { clueId, missing: true, ...snapshotFields }
    const token = tokenOrUndefined('clue', clue.id)
    return {
      clueId: clue.id,
      ...(token === undefined ? {} : { token }),
      title: clue.title,
      sourceId: clue.sourceId,
      typeId: clue.typeId,
      ...(clue.unresolved === undefined ? {} : { unresolved: true }),
      ...snapshotFields,
    }
  })
  return {
    status: 'ok',
    kind: 'pack',
    id: pack.id,
    ...(tokenOrUndefined('pack', pack.id) === undefined
      ? {}
      : { token: tokenOrUndefined('pack', pack.id)! }),
    workspaceId: workspace.id,
    name: pack.name,
    packRevision: pack.revision,
    memberCount: allMembers.length,
    offset: start,
    limit: MAX_AGENT_READ_PACK_MEMBERS,
    snapshotOffset,
    ...(index.error === undefined ? {} : { snapshotsUnavailable: index.error }),
    members,
    ...(nextOffset === undefined ? {} : { limited: true, nextOffset }),
  }
}

/**
 * Read one parsed reference inside a registered workspace scope.
 *
 * @param request - the validated workspace id, token and optional offset.
 * @param options - the live clue service, registry, session and abort signal.
 * @returns a canonical read value; failures are fixed safe categories.
 */
export async function readClueReference(
  request: ClueReaderRequest,
  options: ClueReaderOptions,
): Promise<ClueReaderValue> {
  const { token } = request
  const primary = requestedWorkspaceScope(options.registry, request.workspaceId)
  if (primary === undefined) {
    return {
      status: 'error',
      kind: token.kind,
      id: token.id,
      error: { category: 'invalid-request', message: 'the requested workspace is not a registered workspace' },
    }
  }
  if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) {
    return {
      status: 'error',
      kind: token.kind,
      id: token.id,
      error: { category: 'invalid-request', message: 'offset must be a non-negative integer' },
    }
  }
  if (request.snapshotOffset !== undefined && (!Number.isSafeInteger(request.snapshotOffset) || request.snapshotOffset < 0)) {
    return {
      status: 'error',
      kind: token.kind,
      id: token.id,
      error: { category: 'invalid-request', message: 'snapshotOffset must be a non-negative integer' },
    }
  }
  // Cursors and parent ids are source-owned opaque strings: keep them verbatim
  // (never trim) but refuse empty/whitespace-only values before any I/O.
  if (request.commentsCursor !== undefined
    && (typeof request.commentsCursor !== 'string' || request.commentsCursor.trim() === '')) {
    return invalidRequestValue(token, 'commentsCursor must be a non-empty string')
  }
  if (request.parentId !== undefined
    && (typeof request.parentId !== 'string' || request.parentId.trim() === '')) {
    return invalidRequestValue(token, 'parentId must be a non-empty string')
  }
  const commentsFollowup = request.commentsCursor !== undefined || request.parentId !== undefined
  if (commentsFollowup && token.kind !== 'clue') {
    return invalidRequestValue(token, 'commentsCursor and parentId apply only to clue references')
  }
  const snapshotOffset = request.snapshotOffset ?? 0
  const scopes = candidateScopes(primary, options.registry)
  throwIfAborted(options.signal)
  if (token.kind === 'snapshot') return readSnapshotValue(options, scopes, token)

  if (token.kind === 'pack') {
    const located = await locatePack(options.clues, scopes, token.id)
    if (located.found === undefined) {
      return {
        status: 'error',
        kind: 'pack',
        id: token.id,
        error: located.error ?? {
          category: 'not-found',
          message: `clue pack "${token.id}" does not exist in any local workspace`,
        },
      }
    }
    try {
      const [library, index] = await Promise.all([
        options.clues.listClues(located.found.workspace.id),
        snapshotIndexOf(options, located.found.workspace.id),
      ])
      return packValue(located.found, library.clues, request.offset ?? 0, index, snapshotOffset)
    } catch (error) {
      return { status: 'error', kind: 'pack', id: token.id, error: safeErrorOf(error) }
    }
  }

  const located = await locateClue(options.clues, scopes, token.id)
  if (located.found === undefined) {
    return {
      status: 'error',
      kind: 'clue',
      id: token.id,
      error: located.error ?? {
        category: 'not-found',
        message: `clue "${token.id}" does not exist in any local workspace`,
      },
    }
  }
  const { workspace, clue } = located.found
  // A comments follow-up is a discussion-only read: dispatch to the comments
  // reader BEFORE touching `clues.read`, so paging never refetches the body.
  if (commentsFollowup) return readClueComments(options, workspace, clue, request)
  const tokenText = tokenOrUndefined('clue', clue.id)
  const index = await snapshotIndexOf(options, workspace.id)
  try {
    const result = await options.clues.read({
      workspaceId: workspace.id,
      clueId: clue.id,
      ...(request.offset === undefined ? {} : { offset: request.offset }),
    }, {
      caller: 'agent',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    })
    return withSnapshotIndex({
      status: 'ok',
      kind: 'clue',
      id: clue.id,
      ...(tokenText === undefined ? {} : { token: tokenText }),
      workspaceId: workspace.id,
      title: clue.title,
      sourceId: clue.sourceId,
      typeId: clue.typeId,
      // The source reports its own freshness; never overwrite a snapshot
      // answer with a hard-coded "live".
      freshness: result.freshness ?? 'live',
      fetchedAt: result.fetchedAt,
      ...(result.revision === undefined ? {} : { revision: result.revision }),
      ...contentFields(result),
      ...(clue.unresolved === undefined ? {} : { unresolved: true }),
    }, clue.id, index, snapshotOffset)
  } catch (error) {
    // No automatic fallback: an explicit snapshot token is the only history
    // read. The fixed category/message is safe by construction. Available
    // snapshot id METADATA is still attached so the agent can choose history.
    return withSnapshotIndex({
      status: 'error',
      kind: 'clue',
      id: clue.id,
      ...(tokenText === undefined ? {} : { token: tokenText }),
      workspaceId: workspace.id,
      sourceId: clue.sourceId,
      typeId: clue.typeId,
      title: clue.title,
      ...(clue.unresolved === undefined ? {} : { unresolved: true }),
      error: safeErrorOf(error),
    }, clue.id, index, snapshotOffset)
  }
}
