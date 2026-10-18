/**
 * The two read-only agent tools of the clue surface (S5).
 *
 * - `sidebar_clue_list` — list sources, the workspace library's clues or its
 *   packs. A workspace is a QUERY SCOPE, never an access grant: the caller may
 *   name another registered local workspace directory, but the tool cannot
 *   widen or narrow what a reference can read.
 * - `sidebar_clue_read` — read by kind:
 *   - `clue` reads the source's CURRENT content. A live failure is returned
 *     WITH the available snapshot ids; it never silently falls back to an old
 *     body (only an explicit `snapshot` read returns history);
 *   - `pack` returns the pack's CURRENT members (and each member's snapshot
 *     ids), never their bodies;
 *   - `snapshot` reads one explicit local snapshot, including its fetch time
 *     and integrity, even when the original source is unavailable.
 *
 * Workspace identity comes from the CALLING session's header cwd through
 * `workspaceRegistry.resolveByPath` (never the currently displayed session and
 * never the host process cwd). Reads locate the owning workspace by scanning
 * local registrations after the calling workspace, so a stable reference stays
 * readable from another workspace; that scan is not an authorization model.
 *
 * Nothing here reads credentials, launches CLIs, or repeats vendor client
 * logic: source operations go through the clue service, which normalizes every
 * failure to the fixed categories and never leaks transport output.
 */
import { isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectValueSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '../context-types.ts'
import type { CluesService } from './service.ts'
import {
  ClueError,
  type Clue,
  type ClueReadResult,
  type ClueSnapshotMeta,
  type JsonValue,
} from './types.ts'
import { clueTokenOrUndefined, escapeClueTitle } from './context/tokens.ts'

/** Public tool names (fixed by the approved spec). */
export const CLUE_LIST_TOOL = 'sidebar_clue_list'
export const CLUE_READ_TOOL = 'sidebar_clue_read'

/** Default/maximum page size of `sidebar_clue_list`. */
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
/** Maximum number of workspaces scanned to locate one stable id. */
const MAX_WORKSPACE_SCAN = 64
/** Snapshot metadata rows returned per clue/member page. */
const SNAPSHOT_PAGE_SIZE = 20
/** Maximum pack members returned by one read page (S1 allows up to 10k). */
const MAX_PACK_READ_MEMBERS = 50

/** The host workspace registry slice these tools need. */
interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<{ readonly id?: unknown; readonly path?: unknown } | undefined>
  list?(): readonly { readonly id?: unknown; readonly path?: unknown }[]
}

/** The resolved query scope. */
interface WorkspaceScope {
  readonly id: string
  readonly path?: string
}

/** One safe, stable error projection. */
interface SafeError {
  readonly category: string
  readonly message: string
}

/** One snapshot summary row (no body). */
interface SnapshotRow {
  readonly snapshotId: string
  readonly clueId: string
  readonly format: string
  readonly fetchedAt: string
  readonly createdAt: string
  readonly integrity?: 'verified' | 'unknown'
  readonly sourceVersion?: string
}

/** One pack member row (metadata + snapshots only). */
interface MemberRow {
  readonly clueId: string
  readonly token?: string
  readonly title?: string
  readonly sourceId?: string
  readonly typeId?: string
  readonly unresolved?: boolean
  readonly missing?: boolean
  readonly snapshots: SnapshotRow[]
  /** Total snapshots available for this member (not only this page). */
  readonly snapshotCount: number
  readonly snapshotsLimited?: boolean
  readonly snapshotNextOffset?: number
}

/** Canonical value of `sidebar_clue_read`. */
interface ReadValue {
  readonly status: 'ok' | 'error'
  readonly kind: 'clue' | 'pack' | 'snapshot'
  readonly id: string
  readonly token?: string
  readonly workspaceId?: string
  readonly error?: SafeError
  readonly title?: string
  readonly sourceId?: string
  readonly typeId?: string
  readonly format?: string
  readonly freshness?: 'live' | 'snapshot'
  readonly fetchedAt?: string
  readonly revision?: string
  readonly text?: string
  readonly data?: JsonValue
  readonly assets?: { readonly kind: 'download' | 'open'; readonly path?: string; readonly mime?: string; readonly size?: number }[]
  readonly limited?: boolean
  readonly nextOffset?: number
  /** Requested snapshot-metadata offset (clue and pack reads). */
  readonly snapshotOffset?: number
  readonly snapshots?: SnapshotRow[]
  /** Total snapshots available for this clue (not only this page). */
  readonly snapshotCount?: number
  readonly snapshotsLimited?: boolean
  readonly snapshotNextOffset?: number
  /** The local snapshot index could not be read; never reported as "none". */
  readonly snapshotsUnavailable?: SafeError
  readonly name?: string
  readonly packRevision?: number
  readonly memberCount?: number
  readonly members?: MemberRow[]
  readonly clueId?: string
  readonly createdAt?: string
  readonly integrity?: 'verified' | 'unknown'
  readonly sourceVersion?: string
  readonly unresolved?: boolean
}

/** Canonical value of `sidebar_clue_list`. */
interface ListValue {
  readonly target: 'sources' | 'clues' | 'packs'
  /** Absent only for the global catalogue when no workspace is resolvable. */
  readonly workspace?: { readonly id: string; readonly path?: string }
  readonly sources?: {
    readonly sourceId: string
    readonly name: string
    readonly transport: string
    readonly order: number
    readonly types: string[]
    readonly capabilities: {
      readonly resolve: boolean
      readonly list: boolean
      readonly search: boolean
      readonly read: boolean
      readonly edit: boolean
      readonly portable: boolean
    }
  }[]
  readonly types?: { readonly typeId: string; readonly sourceId: string; readonly formats: string[] }[]
  readonly clues?: {
    readonly id: string
    readonly token?: string
    readonly title: string
    readonly sourceId: string
    readonly typeId: string
    readonly pinned: boolean
    readonly createdAt: string
    readonly updatedAt: string
    readonly unresolved?: boolean
  }[]
  readonly packs?: {
    readonly id: string
    readonly token?: string
    readonly name: string
    readonly revision: number
    readonly memberCount: number
    readonly createdAt: string
    readonly updatedAt: string
  }[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly nextOffset?: number
}

/** The structural context these tools need (tools + workspace registry). */
interface ToolsContext {
  readonly tools?: { register(tool: unknown): () => void }
  get?(name: string): unknown
}

/** Resolve the live workspace registry or fail with the stable category. */
function registryOf(ctx: Context): WorkspaceRegistryLike {
  const value = (ctx as unknown as ToolsContext).get?.('workspaceRegistry')
  if (value === null || typeof value !== 'object') {
    throw new ClueError('dependency-missing', 'the host workspace registry is unavailable')
  }
  const resolveByPath = (value as { resolveByPath?: unknown }).resolveByPath
  if (typeof resolveByPath !== 'function') {
    throw new ClueError('dependency-missing', 'the host workspace registry cannot resolve directories')
  }
  return value as WorkspaceRegistryLike
}

/** A safe message for any thrown value (never echoes unknown transport output). */
function safeErrorOf(error: unknown): SafeError {
  if (error instanceof ClueError) return { category: error.category, message: error.message }
  return { category: 'failed', message: 'the clue operation failed' }
}

/** The calling session id, when the host attached one. */
function callingSessionId(exec: ToolRunContext): string | undefined {
  const id = (exec.agent?.session as { readonly id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** One workspace row, if the registry can answer. */
function scopeOf(workspace: { readonly id?: unknown; readonly path?: unknown } | undefined): WorkspaceScope | undefined {
  if (workspace === undefined) return undefined
  const id = workspace.id
  if (typeof id !== 'string' || id === '') return undefined
  const path = typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : undefined
  return path === undefined ? { id } : { id, path }
}

/**
 * Resolve the CALLING session's workspace, or an explicit registered
 * workspace directory.
 *
 * The cwd is read only as an input to `resolveByPath`; the plugin never treats
 * it as an allowlist and never falls back to its own process cwd.
 */
async function resolveScope(
  ctx: Context,
  exec: ToolRunContext,
  explicitPath: string | undefined,
): Promise<WorkspaceScope> {
  const agent = exec.agent
  if (agent === undefined) {
    throw new ClueError('failed', 'this clue tool requires an initiating agent')
  }
  const registry = registryOf(ctx)
  let target: string | undefined
  if (explicitPath !== undefined && explicitPath !== '') {
    if (!isAbsolute(explicitPath)) {
      throw new ClueError('invalid-request', 'the workspace argument must be an absolute directory path')
    }
    target = explicitPath
  } else {
    const cwd = (agent.session as { header?: { cwd?: unknown } }).header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new ClueError('failed', 'the calling session has no working directory; pass an explicit workspace path')
    }
    target = cwd
  }
  let resolved: WorkspaceScope | undefined
  try {
    resolved = scopeOf(await registry.resolveByPath(target))
  } catch {
    // `resolveByPath` rejects (for example ENOENT after realpath) when the
    // directory does not exist. The host error is not a model-facing category,
    // so map it to the stable contract instead of leaking a raw failure.
    throw explicitPath === undefined
      ? new ClueError('failed', 'the calling session working directory could not be resolved; pass an explicit registered workspace path')
      : new ClueError('not-found', `"${target}" is not a registered local workspace directory`)
  }
  if (resolved === undefined) {
    throw new ClueError('not-found', `"${target}" is not a registered local workspace directory`)
  }
  return resolved
}

/** Every registered local workspace, bounded and de-duplicated (scan order). */
function registeredScopes(ctx: Context): WorkspaceScope[] {
  const scopes: WorkspaceScope[] = []
  const seen = new Set<string>()
  let listed: readonly { readonly id?: unknown; readonly path?: unknown }[]
  try {
    listed = registryOf(ctx).list?.() ?? []
  } catch {
    return scopes
  }
  for (const item of listed) {
    const scope = scopeOf(item)
    if (scope === undefined || seen.has(scope.id)) continue
    seen.add(scope.id)
    scopes.push(scope)
    if (scopes.length >= MAX_WORKSPACE_SCAN) break
  }
  return scopes
}

/** Every local workspace to search, primary first (bounded, de-duplicated). */
function candidateScopes(ctx: Context, primary: WorkspaceScope): WorkspaceScope[] {
  const scopes: WorkspaceScope[] = [primary]
  const seen = new Set([primary.id])
  for (const scope of registeredScopes(ctx)) {
    if (seen.has(scope.id)) continue
    seen.add(scope.id)
    scopes.push(scope)
    if (scopes.length >= MAX_WORKSPACE_SCAN) break
  }
  return scopes
}

/**
 * Best-effort calling scope for targets that do not NEED a workspace (the
 * global source catalogue). An explicit path is still validated loudly; a
 * session without a resolvable cwd simply has no scope to report.
 */
async function optionalScope(
  ctx: Context,
  exec: ToolRunContext,
  explicitPath: string | undefined,
): Promise<WorkspaceScope | undefined> {
  if (explicitPath !== undefined && explicitPath !== '') return resolveScope(ctx, exec, explicitPath)
  const cwd = (exec.agent?.session as { header?: { cwd?: unknown } } | undefined)?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return undefined
  try {
    return scopeOf(await registryOf(ctx).resolveByPath(cwd))
  } catch {
    return undefined
  }
}

/**
 * Scopes of a LOCAL-only scan (an explicit snapshot id). A snapshot lives in
 * local storage, so the scan must work when the calling session has no
 * resolvable workspace cwd: the registered workspace list is then the scope.
 */
async function scanScopes(ctx: Context, exec: ToolRunContext, explicitPath: string | undefined): Promise<WorkspaceScope[]> {
  if (explicitPath !== undefined && explicitPath !== '') {
    return candidateScopes(ctx, await resolveScope(ctx, exec, explicitPath))
  }
  const primary = await optionalScope(ctx, exec, undefined)
  if (primary !== undefined) return candidateScopes(ctx, primary)
  const scopes = registeredScopes(ctx)
  if (scopes.length === 0) {
    throw new ClueError('failed', 'no local workspace is available; pass an explicit registered workspace path')
  }
  return scopes
}

/** The wire shape of one resolved workspace scope. */
function workspaceValueOf(scope: WorkspaceScope): { readonly id: string; readonly path?: string } {
  return { id: scope.id, ...(scope.path === undefined ? {} : { path: scope.path }) }
}

/** Escape one untrusted metadata value for model-facing text. */
function displayText(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' ? escapeClueTitle(value) || fallback : fallback
}

/**
 * One stable token for a model-facing render. An unrepresentable stored id is
 * shown as escaped, quoted data — never concatenated into token brackets.
 */
function tokenForText(kind: 'clue' | 'pack', id: string): string {
  return clueTokenOrUndefined(kind, id)
    ?? `(id ${JSON.stringify(displayText(id))}; not token-safe)`
}

/** One snapshot id rendered as a token, or as escaped metadata when unsafe. */
function snapshotForText(id: string): string {
  return clueTokenOrUndefined('snapshot', id)
    ?? `(snapshot ${JSON.stringify(displayText(id))}; not token-safe)`
}

/** Project one snapshot metadata row (no content). */
function snapshotRow(meta: ClueSnapshotMeta): SnapshotRow {
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

/** Group snapshot metadata by clue, newest first (the full index per clue). */
function groupSnapshotRows(metas: readonly ClueSnapshotMeta[]): Map<string, SnapshotRow[]> {
  const grouped = new Map<string, SnapshotRow[]>()
  for (const meta of metas) {
    const rows = grouped.get(meta.clueId) ?? []
    rows.push(snapshotRow(meta))
    grouped.set(meta.clueId, rows)
  }
  for (const [clueId, rows] of grouped) {
    grouped.set(clueId, rows.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.snapshotId.localeCompare(left.snapshotId)))
  }
  return grouped
}

/** One explicit page of snapshot metadata plus its true total. */
interface SnapshotPage {
  readonly rows: SnapshotRow[]
  readonly total: number
  readonly offset: number
  readonly nextOffset?: number
}

/** Page one clue/member's snapshot metadata; `offset` is caller-controlled. */
function snapshotPageOf(rows: readonly SnapshotRow[], offset: number): SnapshotPage {
  const start = Math.min(offset, rows.length)
  const page = rows.slice(start, start + SNAPSHOT_PAGE_SIZE)
  const nextOffset = start + page.length < rows.length ? start + page.length : undefined
  return {
    rows: page,
    total: rows.length,
    offset,
    ...(nextOffset === undefined ? {} : { nextOffset }),
  }
}

/** Attach one snapshot page to a canonical read value. */
function withSnapshotPage(value: ReadValue, page: SnapshotPage): ReadValue {
  return {
    ...value,
    snapshotOffset: page.offset,
    snapshotCount: page.total,
    ...(page.rows.length === 0 ? {} : { snapshots: page.rows }),
    ...(page.nextOffset === undefined ? {} : { snapshotsLimited: true, snapshotNextOffset: page.nextOffset }),
  }
}

/** The clue row and its owning workspace. */
interface LocatedClue {
  readonly workspace: WorkspaceScope
  readonly clue: Clue
}

/** Locate a clue by stable id across local workspaces (bounded, serial). */
async function locateClue(clues: CluesService, scopes: readonly WorkspaceScope[], clueId: string): Promise<LocatedClue | undefined> {
  for (const workspace of scopes) {
    const library = await clues.listClues(workspace.id)
    const clue = library.clues.find(candidate => candidate.id === clueId)
    if (clue !== undefined) return { workspace, clue }
  }
  return undefined
}

/** The pack row and its owning workspace. */
interface LocatedPack {
  readonly workspace: WorkspaceScope
  readonly pack: { readonly id: string; readonly name: string; readonly revision: number; readonly members: readonly string[]; readonly createdAt: string; readonly updatedAt: string }
}

/** Locate a pack by stable id across local workspaces (bounded, serial). */
async function locatePack(clues: CluesService, scopes: readonly WorkspaceScope[], packId: string): Promise<LocatedPack | undefined> {
  for (const workspace of scopes) {
    const result = await clues.listPacks(workspace.id)
    const pack = result.packs.find(candidate => candidate.id === packId)
    if (pack !== undefined) return { workspace, pack }
  }
  return undefined
}

/** Human-oriented text projection helper. */
function textRender(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Render a stable JSON body for a source without a text projection. */
function jsonText(value: JsonValue): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Render the `sidebar_clue_list` result.
 *
 * Every metadata field here is source-owned and therefore untrusted: titles
 * and names are escaped and quoted, and only validated ids ever appear inside
 * token brackets. A stored id that cannot be represented is shown as quoted
 * data, so it cannot forge a reference or break the line structure.
 */
function renderList(value: ListValue): string {
  const where = value.workspace === undefined
    ? undefined
    : value.workspace.path === undefined
      ? `workspace ${displayText(value.workspace.id)}`
      : `workspace ${displayText(value.workspace.path)}`
  if (value.target === 'sources') {
    const sources = value.sources ?? []
    const total = value.total
    const suffix = where ?? 'global catalogue'
    if (total === 0) return `No clue sources are registered (${suffix}).`
    if (sources.length === 0) {
      return `No clue sources at offset ${value.offset} (total ${total}; ${suffix}).`
    }
    return [
      `${total} clue source${total === 1 ? '' : 's'} (${suffix}; showing ${sources.length} from offset ${value.offset}):`,
      ...sources.map(source => `- ${displayText(source.sourceId)} — ${displayText(source.name)} (${displayText(source.transport)}); types: ${source.types.map(typeId => displayText(typeId)).join(', ') || 'none'}`),
    ].join('\n')
  }
  if (where === undefined) {
    // Defensive: clues/packs always carry a resolved workspace.
    return `No workspace scope was resolved; ${value.target} cannot be listed.`
  }
  if (value.target === 'packs') {
    const packs = value.packs ?? []
    if (packs.length === 0) return `No clue packs in ${where}.`
    return [
      `${value.total} pack${value.total === 1 ? '' : 's'} in ${where} (showing ${packs.length} from offset ${value.offset}):`,
      ...packs.map(pack => `- ${tokenForText('pack', pack.id)} ${JSON.stringify(displayText(pack.name))} — ${pack.memberCount} member${pack.memberCount === 1 ? '' : 's'}, revision ${pack.revision}`),
    ].join('\n')
  }
  const rows = value.clues ?? []
  if (rows.length === 0) return `No clue references in ${where}.`
  return [
    `${value.total} clue reference${value.total === 1 ? '' : 's'} in ${where} (showing ${rows.length} from offset ${value.offset}):`,
    ...rows.map(row => `- ${tokenForText('clue', row.id)} ${JSON.stringify(displayText(row.title))} — ${displayText(row.sourceId)} · ${displayText(row.typeId)}${row.pinned ? ' · pinned' : ''}${row.unresolved ? ' · unresolved (source unavailable; snapshots may still be readable)' : ''}`),
  ].join('\n')
}

/** Format one asset list (escaped metadata only; never bytes or local paths). */
function assetsText(assets: NonNullable<ReadValue['assets']>): string {
  return assets.map(asset => [
    displayText(asset.kind, 'unknown asset'),
    asset.mime === undefined ? '' : displayText(asset.mime, 'unknown type'),
    asset.size === undefined ? '' : `${asset.size} bytes`,
  ].filter(part => part !== '').join(' ')).join(', ')
}

/**
 * Model-visible availability of one clue's snapshots.
 *
 * A failed snapshot-index read is reported as unavailable — never as "none" —
 * and a bounded page carries its true total plus the next offset, so an old
 * snapshot id can still be discovered.
 */
function snapshotSection(value: ReadValue): string[] {
  if (value.snapshotsUnavailable !== undefined) {
    return [
      `Snapshot metadata is unavailable (${displayText(value.snapshotsUnavailable.category)}): ${displayText(value.snapshotsUnavailable.message)}`,
    ]
  }
  const total = value.snapshotCount ?? value.snapshots?.length ?? 0
  if (total === 0) return []
  const offset = value.snapshotOffset ?? 0
  const rows = value.snapshots ?? []
  if (rows.length === 0) {
    return [`No snapshot metadata at snapshot offset ${offset} (total ${total}).`]
  }
  const page = value.snapshotsLimited === true
    ? ` (showing ${rows.length} of ${total}; pass snapshotOffset=${value.snapshotNextOffset ?? offset + rows.length} for older snapshots)`
    : ` (${total} total)`
  return [
    `Available snapshots for this clue${page}:`,
    ...rows.map(snapshot => `- ${snapshotForText(snapshot.snapshotId)} fetched ${displayText(snapshot.fetchedAt)} (${displayText(snapshot.format)}, integrity: ${displayText(snapshot.integrity ?? 'unknown')})`),
  ]
}

/** One pack member's paged snapshot metadata. */
function memberSnapshotsText(member: MemberRow, offset: number): string {
  const total = member.snapshotCount ?? member.snapshots.length
  if (total === 0) return 'none'
  if (member.snapshots.length === 0) {
    return `none at snapshot offset ${offset} (total ${total})`
  }
  const ids = member.snapshots.map(item => snapshotForText(item.snapshotId)).join(', ')
  return member.snapshotsLimited === true
    ? `${ids} (showing ${member.snapshots.length} of ${total}; next snapshot offset ${member.snapshotNextOffset ?? offset + member.snapshots.length})`
    : `${ids} (${total} total)`
}

/**
 * Render the `sidebar_clue_read` result.
 *
 * Binary / non-text content is explicitly MARKED (never rendered as `{}` or
 * base64), and every source-owned metadata value is escaped: a hostile title,
 * source, type, asset kind or format can never forge a reference.
 */
function renderRead(value: ReadValue): string {
  if (value.status === 'error') {
    const error = value.error ?? { category: 'failed', message: 'the clue operation failed' }
    const source = value.sourceId === undefined
      ? ''
      : `\nSource: ${displayText(value.sourceId)}${value.typeId === undefined ? '' : ` · ${displayText(value.typeId)}`}${value.title === undefined ? '' : ` — ${JSON.stringify(displayText(value.title))}`}`
    if (value.kind === 'clue') {
      const snapshots = snapshotSection(value)
      return [
        `${value.kind} read failed (${displayText(error.category)}): ${displayText(error.message)}${source}`,
        'No fallback content was used.',
        ...(snapshots.length === 0
          ? ['No available snapshots are recorded for this clue.']
          : snapshots),
      ].join('\n')
    }
    return `${value.kind} read failed (${displayText(error.category)}): ${displayText(error.message)}${source}`
  }
  if (value.kind === 'pack') {
    const members = value.members ?? []
    const total = value.memberCount ?? members.length
    const shown = members.length < total ? `; showing ${members.length}` : ''
    const snapshotOffset = value.snapshotOffset ?? 0
    const rows = members.map(member => {
      // A missing member has no resolvable token; rendering one anyway would
      // claim a clue exists. Present members use their structured token, and
      // an unsafe stored id falls back to escaped data.
      const memberRef = member.token ?? (member.missing === true
        ? `(missing clue ${JSON.stringify(displayText(member.clueId))})`
        : `(clue ${JSON.stringify(displayText(member.clueId))}; not token-safe)`)
      return [
        `- ${memberRef}${member.title === undefined ? '' : ` ${JSON.stringify(displayText(member.title))}`}`,
        member.sourceId === undefined ? '' : ` — ${displayText(member.sourceId)} · ${displayText(member.typeId ?? '')}`,
        member.unresolved === true ? ' · unresolved' : '',
        ` · snapshots: ${memberSnapshotsText(member, snapshotOffset)}`,
      ].join('')
    })
    const limited = value.nextOffset === undefined
      ? ''
      : `\n\n[limited read; next offset: ${value.nextOffset}]`
    // Every page of member rows shares one snapshot offset; a member with more
    // snapshot metadata than this page tells the agent how to fetch the rest.
    const nextSnapshotOffset = members.find(member => member.snapshotNextOffset !== undefined)?.snapshotNextOffset
    const snapshotHint = nextSnapshotOffset === undefined
      ? ''
      : `\n\n[snapshot metadata is paged; pass snapshotOffset=${nextSnapshotOffset} for older snapshot ids]`
    return [
      `Pack ${tokenForText('pack', value.id)} ${JSON.stringify(displayText(value.name, '?'))} (revision ${value.packRevision ?? 0}, ${total} current member${total === 1 ? '' : 's'}${shown}):`,
      ...rows,
    ].join('\n') + limited + snapshotHint
  }
  const clueRef = value.clueId === undefined ? 'unknown clue' : tokenForText('clue', value.clueId)
  const freshness = value.freshness ?? 'live'
  const header = value.kind === 'snapshot'
    ? `Snapshot ${snapshotForText(value.id)} of clue ${clueRef} — fetched ${displayText(value.fetchedAt, '?')} (${displayText(value.format)}, integrity: ${displayText(value.integrity ?? 'unknown')})`
    : `${freshness === 'snapshot' ? 'Snapshot-backed clue' : 'Live clue'} ${tokenForText('clue', value.id)} ${JSON.stringify(displayText(value.title, ''))} — source ${displayText(value.sourceId)} · ${displayText(value.typeId)}; fetched ${displayText(value.fetchedAt, '?')} (freshness: ${displayText(freshness)}, format: ${displayText(value.format)})`
  const assets = value.assets ?? []
  const assetList = assetsText(assets)
  const body = value.text !== undefined
    ? [value.text, ...(assets.length === 0
      ? []
      : [`[assets are not inlined: ${assetList}; open the reference to use the host resource entry]`])].join('\n\n')
    : assets.length > 0
      // `data` of a binary source is usually `{}`; rendering it as the whole
      // body would read as complete content. Mark the assets instead.
      ? `[no text projection; ${assets.length} asset(s) are not inlined: ${assetList}. Open the reference to use the host resource entry.]`
      : value.data === undefined
        ? ''
        : jsonText(value.data)
  const limited = value.limited === true
    ? `\n\n[limited read; next offset: ${value.nextOffset ?? 'unknown'}]`
    : ''
  const snapshots = value.kind === 'clue' ? snapshotSection(value) : []
  return [header, body, limited, snapshots.join('\n')].filter(part => part !== '').join('\n\n')
}

/**
 * Register both read-only clue tools.
 *
 * @param ctx - host plugin context (tool registry + workspace registry).
 * @param clues - the live clue service.
 * @returns a disposer unregistering exactly these two tools (idempotent).
 */
export function installClueTools(ctx: Context, clues: CluesService): () => void {
  const context = ctx as unknown as ToolsContext
  if (context.tools === undefined || typeof context.tools.register !== 'function') {
    throw new ClueError('dependency-missing', 'the host tool registry is unavailable')
  }

  const listTool = defineTool({
    name: CLUE_LIST_TOOL,
    description:
      'List the local clue catalogue: registered clue sources, the workspace library\'s stable clue references, or the local packs. '
      + 'Reference tokens have three fixed spellings: [[dsh-clue:<id>]] (live clue), [[dsh-cluepack:<id>]] (pack, read its CURRENT members) and [[dsh-clue-snapshot:<id>]] (one explicit historical snapshot). '
      + 'By default this lists the calling session\'s workspace. `workspace` may name another registered local workspace directory; a workspace is a query scope, not an access grant. '
      + 'Filtering by source and a keyword is available for clues. Read content with sidebar_clue_read; this tool never fetches remote bodies. '
      + 'Results contain metadata only — no credentials, environment variables or installation commands.',
    parameters: {
      target: {
        type: 'string',
        enum: ['sources', 'clues', 'packs'],
        description: 'What to list; defaults to "clues".',
      },
      workspace: {
        type: 'string',
        description: 'Absolute path of a registered local workspace. Omit for the calling session\'s workspace.',
      },
      sourceId: {
        type: 'string',
        description: 'Only clues owned by this registered source id.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive keyword matched against clue titles/source/type or pack names.',
      },
      limit: {
        type: 'integer',
        description: 'Page size (1-100, default 20).',
      },
      offset: {
        type: 'integer',
        description: 'Zero-based row offset (default 0).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', enum: ['sources', 'clues', 'packs'], required: true },
          workspace: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              path: { type: 'string' },
            },
          },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sourceId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                transport: { type: 'string', required: true },
                order: { type: 'integer', required: true },
                types: { type: 'array', items: { type: 'string' }, required: true },
                capabilities: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    resolve: { type: 'boolean', required: true },
                    list: { type: 'boolean', required: true },
                    search: { type: 'boolean', required: true },
                    read: { type: 'boolean', required: true },
                    edit: { type: 'boolean', required: true },
                    portable: { type: 'boolean', required: true },
                  },
                },
              },
            },
          },
          types: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                typeId: { type: 'string', required: true },
                sourceId: { type: 'string', required: true },
                formats: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
          clues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                token: { type: 'string' },
                title: { type: 'string', required: true },
                sourceId: { type: 'string', required: true },
                typeId: { type: 'string', required: true },
                pinned: { type: 'boolean', required: true },
                createdAt: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
                unresolved: { type: 'boolean' },
              },
            },
          },
          packs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                token: { type: 'string' },
                name: { type: 'string', required: true },
                revision: { type: 'integer', required: true },
                memberCount: { type: 'integer', required: true },
                createdAt: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
          offset: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
          nextOffset: { type: 'integer' },
        },
      },
      render: (_args, value) => textRender(renderList(value as ListValue)),
    },
    async execute(args: {
      target?: 'sources' | 'clues' | 'packs'
      workspace?: string
      sourceId?: string
      query?: string
      limit?: number
      offset?: number
    }, exec: ToolRunContext): Promise<ListValue> {
      exec.signal.throwIfAborted()
      const target = args.target ?? 'clues'
      const limit = args.limit ?? DEFAULT_LIST_LIMIT
      const offset = args.offset ?? 0
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new ClueError('invalid-request', `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`)
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new ClueError('invalid-request', 'offset must be a non-negative integer')
      }
      if (target === 'sources') {
        // The source catalogue is GLOBAL: listing it must not fail just because
        // the calling session has no resolvable workspace cwd.
        const scope = await optionalScope(ctx, exec, args.workspace)
        exec.signal.throwIfAborted()
        // The catalogue is global metadata, but it is still paged: an
        // installation can register many sources, and the caller's validated
        // limit/offset must mean the same thing for every target.
        const allSources = clues.getSources().map(source => ({
          sourceId: source.sourceId,
          name: source.name,
          transport: source.transport,
          order: source.order,
          types: [...source.types],
          capabilities: {
            resolve: source.capabilities.resolve,
            list: source.capabilities.list,
            search: source.capabilities.search,
            read: source.capabilities.read,
            edit: source.capabilities.edit,
            portable: source.capabilities.portable,
          },
        }))
        const page = allSources.slice(offset, offset + limit)
        const pageSourceIds = new Set(page.map(source => source.sourceId))
        // Keep the top-level type list consistent with the source page: a
        // caller that pages sources must not receive every type anyway.
        const types = clues.getTypes()
          .filter(type => pageSourceIds.has(type.sourceId))
          .map(type => ({
            typeId: type.typeId,
            sourceId: type.sourceId,
            formats: [...type.formats],
          }))
        return {
          target,
          ...(scope === undefined ? {} : { workspace: workspaceValueOf(scope) }),
          sources: page,
          types,
          total: allSources.length,
          offset,
          limit,
          ...(offset + page.length < allSources.length ? { nextOffset: offset + page.length } : {}),
        }
      }
      const scope = await resolveScope(ctx, exec, args.workspace)
      exec.signal.throwIfAborted()
      if (target === 'packs') {
        const query = (args.query ?? '').trim().toLowerCase()
        const result = await clues.listPacks(scope.id)
        const matches = result.packs
          .filter(pack => query === '' || pack.name.toLowerCase().includes(query))
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
        const page = matches.slice(offset, offset + limit)
        return {
          target,
          workspace: { id: scope.id, ...(scope.path === undefined ? {} : { path: scope.path }) },
          packs: page.map(pack => ({
            id: pack.id,
            ...(clueTokenOrUndefined('pack', pack.id) === undefined ? {} : { token: clueTokenOrUndefined('pack', pack.id)! }),
            name: pack.name,
            revision: pack.revision,
            memberCount: pack.members.length,
            createdAt: pack.createdAt,
            updatedAt: pack.updatedAt,
          })),
          total: matches.length,
          offset,
          limit,
          ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}),
        }
      }
      const query = (args.query ?? '').trim().toLowerCase()
      const sourceId = (args.sourceId ?? '').trim()
      const [library, pins] = await Promise.all([clues.listClues(scope.id), clues.listPins(scope.id)])
      const pinOrder = new Map(pins.pins.map((pin, index) => [pin.clueId, index]))
      const matches = library.clues.filter(clue => {
        if (sourceId !== '' && clue.sourceId !== sourceId) return false
        if (query === '') return true
        return clue.title.toLowerCase().includes(query)
          || clue.sourceId.toLowerCase().includes(query)
          || clue.typeId.toLowerCase().includes(query)
      })
      const sorted = matches.sort((left, right) => {
        const leftPin = pinOrder.get(left.id)
        const rightPin = pinOrder.get(right.id)
        if (leftPin !== undefined || rightPin !== undefined) {
          if (leftPin === undefined) return 1
          if (rightPin === undefined) return -1
          return leftPin - rightPin
        }
        return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      })
      const page = sorted.slice(offset, offset + limit)
      return {
        target,
        workspace: { id: scope.id, ...(scope.path === undefined ? {} : { path: scope.path }) },
        clues: page.map(clue => ({
          id: clue.id,
          ...(clueTokenOrUndefined('clue', clue.id) === undefined ? {} : { token: clueTokenOrUndefined('clue', clue.id)! }),
          title: clue.title,
          sourceId: clue.sourceId,
          typeId: clue.typeId,
          pinned: pinOrder.has(clue.id),
          createdAt: clue.createdAt,
          updatedAt: clue.updatedAt,
          ...(clue.unresolved === undefined ? {} : { unresolved: true }),
        })),
        total: sorted.length,
        offset,
        limit,
        ...(offset + page.length < sorted.length ? { nextOffset: offset + page.length } : {}),
      }
    },
  })

  const readTool = defineTool({
    name: CLUE_READ_TOOL,
    description:
      'Read one clue reference by kind and stable id. '
      + 'kind="clue" reads the source\'s CURRENT content: the token [[dsh-clue:<id>]] always means a live read. The result reports the freshness the source actually returned (live or snapshot). If the source fails, the result carries the original stable error plus the available snapshot ids — it never falls back automatically; pick a snapshot explicitly if the user wants history. '
      + 'kind="pack" returns the pack\'s CURRENT members and each member\'s available snapshot ids (paged), never their bodies. '
      + 'kind="snapshot" reads one explicit local snapshot ([[dsh-clue-snapshot:<id>]]) with its fetch time and integrity, even when the source is unavailable. '
      + 'Snapshot id lists are paged; a bounded page reports the true total and the next `snapshotOffset`. '
      + 'The calling session\'s workspace is searched first, then the other registered local workspaces (so a restored session without a cwd still finds a stable id); `workspace` may name another registered local workspace. '
      + 'Returns only source content, necessary metadata and stable errors — never credentials, environment variables or installation commands.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['clue', 'pack', 'snapshot'],
        required: true,
        description: 'What to read: a live clue, a pack\'s current members, or one explicit snapshot.',
      },
      id: {
        type: 'string',
        required: true,
        description: 'The stable id from the token (clue id, pack id or snapshotId).',
      },
      workspace: {
        type: 'string',
        description: 'Absolute path of a registered local workspace. Omit for the calling session\'s workspace.',
      },
      offset: {
        type: 'integer',
        description: 'Explicit byte offset for a pageable live clue read (kind="clue"), or the member offset of a pack page (kind="pack").',
      },
      snapshotOffset: {
        type: 'integer',
        description: 'Snapshot-metadata page offset (default 0). Applies to the clue snapshot list and to every member snapshot list of a pack page.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok', 'error'], required: true },
          kind: { type: 'string', enum: ['clue', 'pack', 'snapshot'], required: true },
          id: { type: 'string', required: true },
          token: { type: 'string' },
          workspaceId: { type: 'string' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              category: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
          title: { type: 'string' },
          sourceId: { type: 'string' },
          typeId: { type: 'string' },
          format: { type: 'string' },
          freshness: { type: 'string', enum: ['live', 'snapshot'] },
          fetchedAt: { type: 'string' },
          revision: { type: 'string' },
          text: { type: 'string' },
          data: { type: 'json' },
          assets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                path: { type: 'string' },
                mime: { type: 'string' },
                size: { type: 'integer' },
              },
            },
          },
          limited: { type: 'boolean' },
          nextOffset: { type: 'integer' },
          snapshotOffset: { type: 'integer' },
          snapshots: { type: 'array', items: SNAPSHOT_ITEM_SCHEMA },
          snapshotCount: { type: 'integer' },
          snapshotsLimited: { type: 'boolean' },
          snapshotNextOffset: { type: 'integer' },
          snapshotsUnavailable: {
            type: 'object',
            additionalProperties: false,
            properties: {
              category: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
          name: { type: 'string' },
          packRevision: { type: 'integer' },
          memberCount: { type: 'integer' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                clueId: { type: 'string', required: true },
                token: { type: 'string' },
                title: { type: 'string' },
                sourceId: { type: 'string' },
                typeId: { type: 'string' },
                unresolved: { type: 'boolean' },
                missing: { type: 'boolean' },
                snapshots: { type: 'array', items: SNAPSHOT_ITEM_SCHEMA, required: true },
                snapshotCount: { type: 'integer', required: true },
                snapshotsLimited: { type: 'boolean' },
                snapshotNextOffset: { type: 'integer' },
              },
            },
          },
          clueId: { type: 'string' },
          createdAt: { type: 'string' },
          integrity: { type: 'string', enum: ['verified', 'unknown'] },
          sourceVersion: { type: 'string' },
          unresolved: { type: 'boolean' },
        },
      },
      render: (_args, value) => textRender(renderRead(value as ReadValue)),
    },
    async execute(args: { kind: 'clue' | 'pack' | 'snapshot'; id: string; workspace?: string; offset?: number; snapshotOffset?: number }, exec: ToolRunContext): Promise<ReadValue> {
      exec.signal.throwIfAborted()
      const id = args.id.trim()
      if (id === '') throw new ClueError('invalid-request', 'a clue read needs a non-empty stable id')
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) {
        throw new ClueError('invalid-request', 'offset must be a non-negative integer')
      }
      if (args.snapshotOffset !== undefined && (!Number.isInteger(args.snapshotOffset) || args.snapshotOffset < 0)) {
        throw new ClueError('invalid-request', 'snapshotOffset must be a non-negative integer')
      }
      if (args.kind === 'snapshot') {
        // A snapshot is local storage, not a workspace-scoped source read: no
        // calling cwd is required, the local registrations are the scan scope.
        const scopes = await scanScopes(ctx, exec, args.workspace)
        exec.signal.throwIfAborted()
        for (const workspace of scopes) {
          try {
            const record = await clues.readSnapshot({ workspaceId: workspace.id, snapshotId: id })
            const meta = record.meta
            const snapshotToken = clueTokenOrUndefined('snapshot', id)
            return {
              status: 'ok',
              kind: 'snapshot',
              id,
              ...(snapshotToken === undefined ? {} : { token: snapshotToken }),
              workspaceId: workspace.id,
              clueId: meta.clueId,
              format: record.content.format,
              freshness: 'snapshot',
              fetchedAt: meta.fetchedAt,
              createdAt: meta.createdAt,
              integrity: meta.integrity ?? 'unknown',
              ...(meta.sourceVersion === undefined ? {} : { sourceVersion: meta.sourceVersion }),
              ...(record.content.text === undefined ? {} : { text: record.content.text }),
              ...(record.content.text === undefined ? { data: record.content.data } : {}),
              ...(record.content.assets === undefined ? {} : {
                assets: record.content.assets.map(asset => ({
                  kind: asset.kind,
                  ...(asset.path === undefined ? {} : { path: asset.path }),
                  ...(asset.mime === undefined ? {} : { mime: asset.mime }),
                  ...(asset.size === undefined ? {} : { size: asset.size }),
                })),
              }),
            }
          } catch (error) {
            const safe = safeErrorOf(error)
            if (safe.category !== 'not-found') return { status: 'error', kind: 'snapshot', id, error: safe }
          }
        }
        return {
          status: 'error',
          kind: 'snapshot',
          id,
          error: { category: 'not-found', message: `clue snapshot "${id}" does not exist in any local workspace` },
        }
      }
      // Reads locate a stable id across the local registrations, so a
      // restored/no-cwd session works without inventing a workspace; an
      // explicit workspace is still validated and searched first.
      const scopes = await scanScopes(ctx, exec, args.workspace)
      exec.signal.throwIfAborted()
      if (args.kind === 'pack') {
        const located = await locatePack(clues, scopes, id)
        if (located === undefined) {
          return {
            status: 'error',
            kind: 'pack',
            id,
            error: { category: 'not-found', message: `clue pack "${id}" does not exist in any local workspace` },
          }
        }
        try {
          const [library, snapshotMetas] = await Promise.all([
            clues.listClues(located.workspace.id),
            clues.listSnapshots(located.workspace.id),
          ])
          const clueById = new Map(library.clues.map(clue => [clue.id, clue]))
          const snapshotsByClue = groupSnapshotRows(snapshotMetas)
          const snapshotOffset = args.snapshotOffset ?? 0
          // One pack may hold 10k members: page the member rows so one tool
          // result cannot flood the model context (each row may carry 20
          // snapshot ids, and snapshot metadata itself is paged).
          const offset = args.offset ?? 0
          const allMembers = located.pack.members
          const pageMembers = allMembers.slice(offset, offset + MAX_PACK_READ_MEMBERS)
          const nextOffset = offset + pageMembers.length < allMembers.length
            ? offset + pageMembers.length
            : undefined
          const members: MemberRow[] = []
          for (const clueId of pageMembers) {
            const clue = clueById.get(clueId)
            const page = snapshotPageOf(snapshotsByClue.get(clueId) ?? [], snapshotOffset)
            const snapshotFields = {
              snapshots: page.rows,
              snapshotCount: page.total,
              ...(page.nextOffset === undefined
                ? {}
                : { snapshotsLimited: true, snapshotNextOffset: page.nextOffset }),
            }
            if (clue === undefined) {
              members.push({ clueId, missing: true, ...snapshotFields })
              continue
            }
            const token = clueTokenOrUndefined('clue', clue.id)
            members.push({
              clueId: clue.id,
              ...(token === undefined ? {} : { token }),
              title: clue.title,
              sourceId: clue.sourceId,
              typeId: clue.typeId,
              ...(clue.unresolved === undefined ? {} : { unresolved: true }),
              ...snapshotFields,
            })
          }
          const token = clueTokenOrUndefined('pack', located.pack.id)
          return {
            status: 'ok',
            kind: 'pack',
            id: located.pack.id,
            ...(token === undefined ? {} : { token }),
            workspaceId: located.workspace.id,
            name: located.pack.name,
            packRevision: located.pack.revision,
            memberCount: allMembers.length,
            snapshotOffset,
            members,
            ...(nextOffset === undefined ? {} : { limited: true, nextOffset }),
          }
        } catch (error) {
          return { status: 'error', kind: 'pack', id, error: safeErrorOf(error) }
        }
      }
      const located = await locateClue(clues, scopes, id)
      if (located === undefined) {
        return {
          status: 'error',
          kind: 'clue',
          id,
          error: { category: 'not-found', message: `clue "${id}" does not exist in any local workspace` },
        }
      }
      const token = clueTokenOrUndefined('clue', located.clue.id)
      const snapshotOffset = args.snapshotOffset ?? 0
      let snapshotPage: SnapshotPage = { rows: [], total: 0, offset: snapshotOffset }
      let snapshotsUnavailable: SafeError | undefined
      try {
        snapshotPage = snapshotPageOf(
          groupSnapshotRows(await clues.listSnapshots(located.workspace.id)).get(located.clue.id) ?? [],
          snapshotOffset,
        )
      } catch (error) {
        // A broken snapshot index is NOT "no snapshots": keep the failure in
        // the value and the model-visible render.
        snapshotsUnavailable = safeErrorOf(error)
      }
      const withSnapshots = (value: ReadValue): ReadValue => snapshotsUnavailable === undefined
        // Only a real index contributes counts/pages; a failed index must not
        // look like a zero-snapshot clue.
        ? withSnapshotPage(value, snapshotPage)
        : { ...value, snapshotsUnavailable }
      try {
        const sessionId = callingSessionId(exec)
        const result: ClueReadResult = await clues.read({
          workspaceId: located.workspace.id,
          clueId: located.clue.id,
          ...(args.offset === undefined ? {} : { offset: args.offset }),
        }, {
          caller: 'agent',
          signal: exec.signal,
          // S2 §MCP: an agent-initiated read keeps the caller session so a
          // session-scoped source retains approval/route context.
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        return withSnapshots({
          status: 'ok',
          kind: 'clue',
          id: located.clue.id,
          ...(token === undefined ? {} : { token }),
          workspaceId: located.workspace.id,
          title: located.clue.title,
          sourceId: located.clue.sourceId,
          typeId: located.clue.typeId,
          format: result.format,
          // The source reports its own freshness; never overwrite a snapshot
          // answer with a hard-coded "live".
          freshness: result.freshness ?? 'live',
          fetchedAt: result.fetchedAt,
          ...(result.revision === undefined ? {} : { revision: result.revision }),
          ...(result.text === undefined ? {} : { text: result.text }),
          ...(result.text === undefined ? { data: result.data } : {}),
          ...(result.assets === undefined ? {} : {
            assets: result.assets.map(asset => ({
              kind: asset.kind,
              ...(asset.path === undefined ? {} : { path: asset.path }),
              ...(asset.mime === undefined ? {} : { mime: asset.mime }),
              ...(asset.size === undefined ? {} : { size: asset.size }),
            })),
          }),
          ...(result.limited === undefined ? {} : { limited: result.limited }),
          ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }),
          ...(located.clue.unresolved === undefined ? {} : { unresolved: true }),
        })
      } catch (error) {
        return withSnapshots({
          status: 'error',
          kind: 'clue',
          id: located.clue.id,
          ...(token === undefined ? {} : { token }),
          workspaceId: located.workspace.id,
          // Keep the actionable source identity in the error projection: an
          // auth-required/permission-denied answer must point the model (and
          // the user) at the source whose settings need attention.
          sourceId: located.clue.sourceId,
          typeId: located.clue.typeId,
          title: located.clue.title,
          error: safeErrorOf(error),
          ...(located.clue.unresolved === undefined ? {} : { unresolved: true }),
        })
      }
    },
  })

  const disposeList = context.tools.register(listTool)
  let disposeRead: (() => void) | undefined
  try {
    disposeRead = context.tools.register(readTool)
  } catch (error) {
    // A partial registration would leave the list tool behind after a failed
    // activation; roll the first one back before surfacing the failure.
    try { disposeList() } catch { /* the original failure is the useful one */ }
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeList()
    disposeRead?.()
  }
}

/** Shared snapshot-metadata schema node (metadata rows only; no body). */
const SNAPSHOT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    snapshotId: { type: 'string', required: true },
    clueId: { type: 'string', required: true },
    format: { type: 'string', required: true },
    fetchedAt: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    integrity: { type: 'string', enum: ['verified', 'unknown'] },
    sourceVersion: { type: 'string' },
  },
} as const satisfies ObjectValueSchemaSpec
