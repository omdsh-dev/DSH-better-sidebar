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
import { serializeClueToken } from './context/tokens.ts'

/** Public tool names (fixed by the approved spec). */
export const CLUE_LIST_TOOL = 'sidebar_clue_list'
export const CLUE_READ_TOOL = 'sidebar_clue_read'

/** Default/maximum page size of `sidebar_clue_list`. */
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
/** Maximum number of workspaces scanned to locate one stable id. */
const MAX_WORKSPACE_SCAN = 64
/** Maximum snapshot summaries attached to one read row. */
const MAX_SNAPSHOT_ROWS = 20

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
  readonly snapshots?: SnapshotRow[]
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
  readonly workspace: { readonly id: string; readonly path?: string }
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
  const resolved = scopeOf(await registry.resolveByPath(target))
  if (resolved === undefined) {
    throw new ClueError('not-found', `"${target}" is not a registered local workspace directory`)
  }
  return resolved
}

/** Every local workspace to search, primary first (bounded, de-duplicated). */
function candidateScopes(ctx: Context, primary: WorkspaceScope): WorkspaceScope[] {
  const scopes: WorkspaceScope[] = [primary]
  const seen = new Set([primary.id])
  const listed: readonly { readonly id?: unknown; readonly path?: unknown }[] = (() => {
    try {
      return registryOf(ctx).list?.() ?? []
    } catch {
      return []
    }
  })()
  for (const item of listed) {
    const scope = scopeOf(item)
    if (scope === undefined || seen.has(scope.id)) continue
    seen.add(scope.id)
    scopes.push(scope)
    if (scopes.length >= MAX_WORKSPACE_SCAN) break
  }
  return scopes
}

/** One token for a stable id, or undefined when the stored id is unrepresentable. */
function tokenOrUndefined(kind: 'clue' | 'pack' | 'snapshot', id: string): string | undefined {
  try {
    return serializeClueToken(kind, id)
  } catch {
    return undefined
  }
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

/** Group snapshot metadata by clue, newest first and bounded per clue. */
function groupSnapshotRows(metas: readonly ClueSnapshotMeta[]): Map<string, SnapshotRow[]> {
  const grouped = new Map<string, SnapshotRow[]>()
  for (const meta of metas) {
    const rows = grouped.get(meta.clueId) ?? []
    rows.push(snapshotRow(meta))
    grouped.set(meta.clueId, rows)
  }
  for (const [clueId, rows] of grouped) {
    grouped.set(clueId, rows
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.snapshotId.localeCompare(left.snapshotId))
      .slice(0, MAX_SNAPSHOT_ROWS))
  }
  return grouped
}

/** Snapshot rows of one clue in one workspace, newest first, bounded. */
async function snapshotsOf(clues: CluesService, workspaceId: string, clueId: string): Promise<SnapshotRow[]> {
  return groupSnapshotRows(await clues.listSnapshots(workspaceId)).get(clueId) ?? []
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

/** Render the `sidebar_clue_list` result. */
function renderList(value: ListValue): string {
  const where = value.workspace.path === undefined
    ? `workspace ${value.workspace.id}`
    : `workspace ${value.workspace.path}`
  if (value.target === 'sources') {
    const sources = value.sources ?? []
    if (sources.length === 0) return `No clue sources are registered (${where}).`
    return [
      `${sources.length} clue source${sources.length === 1 ? '' : 's'} (${where}):`,
      ...sources.map(source => `- ${source.sourceId} — ${source.name} (${source.transport}); types: ${source.types.join(', ') || 'none'}`),
    ].join('\n')
  }
  if (value.target === 'packs') {
    const packs = value.packs ?? []
    if (packs.length === 0) return `No clue packs in ${where}.`
    return [
      `${value.total} pack${value.total === 1 ? '' : 's'} in ${where} (showing ${packs.length} from offset ${value.offset}):`,
      ...packs.map(pack => `- ${pack.token ?? pack.id} "${pack.name}" — ${pack.memberCount} member${pack.memberCount === 1 ? '' : 's'}, revision ${pack.revision}`),
    ].join('\n')
  }
  const rows = value.clues ?? []
  if (rows.length === 0) return `No clue references in ${where}.`
  return [
    `${value.total} clue reference${value.total === 1 ? '' : 's'} in ${where} (showing ${rows.length} from offset ${value.offset}):`,
    ...rows.map(row => `- ${row.token ?? row.id} "${row.title}" — ${row.sourceId} · ${row.typeId}${row.pinned ? ' · pinned' : ''}${row.unresolved ? ' · unresolved (source unavailable; snapshots may still be readable)' : ''}`),
  ].join('\n')
}

/** Render the `sidebar_clue_read` result. */
function renderRead(value: ReadValue): string {
  if (value.status === 'error') {
    const error = value.error ?? { category: 'failed', message: 'the clue operation failed' }
    const snapshots = value.snapshots ?? []
    if (value.kind === 'clue') {
      return [
        `Live read failed (${error.category}): ${error.message}`,
        'No fallback content was used. Available snapshots for this clue:',
        ...(snapshots.length === 0
          ? ['- none']
          : snapshots.map(snapshot => `- [[dsh-clue-snapshot:${snapshot.snapshotId}]] fetched ${snapshot.fetchedAt} (${snapshot.format}, integrity: ${snapshot.integrity ?? 'unknown'})`)),
      ].join('\n')
    }
    return `${value.kind} read failed (${error.category}): ${error.message}`
  }
  if (value.kind === 'pack') {
    const members = value.members ?? []
    return [
      `Pack ${value.token ?? value.id} "${value.name ?? ''}" (revision ${value.packRevision ?? 0}, ${members.length} current member${members.length === 1 ? '' : 's'}):`,
      ...members.map(member => [
        `- ${member.token ?? member.clueId}${member.title === undefined ? '' : ` "${member.title}"`}`,
        member.sourceId === undefined ? '' : ` — ${member.sourceId} · ${member.typeId ?? ''}`,
        member.unresolved === true ? ' · unresolved' : '',
        ` · snapshots: ${member.snapshots.length === 0 ? 'none' : member.snapshots.map(item => item.snapshotId).join(', ')}`,
      ].join('')),
    ].join('\n')
  }
  const header = value.kind === 'snapshot'
    ? `Snapshot [[dsh-clue-snapshot:${value.id}]] of clue ${value.clueId ?? '?'} — fetched ${value.fetchedAt ?? '?'} (${value.format ?? 'unknown'}, integrity: ${value.integrity ?? 'unknown'})`
    : `Live clue ${value.token ?? value.id} "${value.title ?? ''}" — fetched ${value.fetchedAt ?? '?'} (${value.format ?? 'unknown'})`
  const body = value.text !== undefined
    ? value.text
    : value.data === undefined
      ? ''
      : jsonText(value.data)
  const limited = value.limited === true
    ? `\n\n[limited read; next offset: ${value.nextOffset ?? 'unknown'}]`
    : ''
  return `${header}\n\n${body}${limited}`
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
            required: true,
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
      const scope = await resolveScope(ctx, exec, args.workspace)
      exec.signal.throwIfAborted()
      if (target === 'sources') {
        const sources = clues.getSources().map(source => ({
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
        const types = clues.getTypes().map(type => ({
          typeId: type.typeId,
          sourceId: type.sourceId,
          formats: [...type.formats],
        }))
        return {
          target,
          workspace: { id: scope.id, ...(scope.path === undefined ? {} : { path: scope.path }) },
          sources,
          types,
          total: sources.length,
          offset: 0,
          limit: sources.length,
        }
      }
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
            ...(tokenOrUndefined('pack', pack.id) === undefined ? {} : { token: tokenOrUndefined('pack', pack.id)! }),
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
          ...(tokenOrUndefined('clue', clue.id) === undefined ? {} : { token: tokenOrUndefined('clue', clue.id)! }),
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
      + 'kind="clue" reads the source\'s CURRENT content (live): the token [[dsh-clue:<id>]] always means live content. If the source fails, the result carries the original stable error plus the ids of available snapshots — it never falls back automatically; pick a snapshot explicitly if the user wants history. '
      + 'kind="pack" returns the pack\'s CURRENT members and each member\'s available snapshot ids, never their bodies. '
      + 'kind="snapshot" reads one explicit local snapshot ([[dsh-clue-snapshot:<id>]]) with its fetch time and integrity, even when the source is unavailable. '
      + 'By default the calling session\'s workspace is the query scope; `workspace` may name another registered local workspace. '
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
        description: 'Explicit byte offset for a pageable live clue read (kind="clue" only).',
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
          snapshots: { type: 'array', items: SNAPSHOT_ITEM_SCHEMA },
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
    async execute(args: { kind: 'clue' | 'pack' | 'snapshot'; id: string; workspace?: string; offset?: number }, exec: ToolRunContext): Promise<ReadValue> {
      exec.signal.throwIfAborted()
      const id = args.id.trim()
      if (id === '') throw new ClueError('invalid-request', 'a clue read needs a non-empty stable id')
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) {
        throw new ClueError('invalid-request', 'offset must be a non-negative integer')
      }
      const scope = await resolveScope(ctx, exec, args.workspace)
      const scopes = candidateScopes(ctx, scope)
      exec.signal.throwIfAborted()
      if (args.kind === 'snapshot') {
        for (const workspace of scopes) {
          try {
            const record = await clues.readSnapshot({ workspaceId: workspace.id, snapshotId: id })
            const meta = record.meta
            return {
              status: 'ok',
              kind: 'snapshot',
              id,
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
          const members: MemberRow[] = []
          for (const clueId of located.pack.members) {
            const clue = clueById.get(clueId)
            const snapshots = snapshotsByClue.get(clueId) ?? []
            if (clue === undefined) {
              members.push({ clueId, missing: true, snapshots })
              continue
            }
            const token = tokenOrUndefined('clue', clue.id)
            members.push({
              clueId: clue.id,
              ...(token === undefined ? {} : { token }),
              title: clue.title,
              sourceId: clue.sourceId,
              typeId: clue.typeId,
              ...(clue.unresolved === undefined ? {} : { unresolved: true }),
              snapshots,
            })
          }
          const token = tokenOrUndefined('pack', located.pack.id)
          return {
            status: 'ok',
            kind: 'pack',
            id: located.pack.id,
            ...(token === undefined ? {} : { token }),
            workspaceId: located.workspace.id,
            name: located.pack.name,
            packRevision: located.pack.revision,
            memberCount: members.length,
            members,
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
      const token = tokenOrUndefined('clue', located.clue.id)
      let snapshots: SnapshotRow[]
      try {
        snapshots = await snapshotsOf(clues, located.workspace.id, located.clue.id)
      } catch {
        snapshots = []
      }
      try {
        const result: ClueReadResult = await clues.read({
          workspaceId: located.workspace.id,
          clueId: located.clue.id,
          ...(args.offset === undefined ? {} : { offset: args.offset }),
        }, { caller: 'agent', signal: exec.signal })
        return {
          status: 'ok',
          kind: 'clue',
          id: located.clue.id,
          ...(token === undefined ? {} : { token }),
          workspaceId: located.workspace.id,
          title: located.clue.title,
          sourceId: located.clue.sourceId,
          typeId: located.clue.typeId,
          format: result.format,
          freshness: 'live',
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
          ...(snapshots.length === 0 ? {} : { snapshots }),
        }
      } catch (error) {
        return {
          status: 'error',
          kind: 'clue',
          id: located.clue.id,
          ...(token === undefined ? {} : { token }),
          workspaceId: located.workspace.id,
          error: safeErrorOf(error),
          ...(snapshots.length === 0 ? {} : { snapshots }),
        }
      }
    },
  })

  const disposeList = context.tools.register(listTool)
  const disposeRead = context.tools.register(readTool)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeList()
    disposeRead()
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
