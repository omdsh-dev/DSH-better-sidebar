/**
 * `builtin.feishu.docs`: paginated Docx / wiki browsing, latest XML/Markdown
 * reads and credential-free portable references.
 *
 * Range and pagination contract:
 * - browsing REQUIRES an explicit range (Drive folder token, wiki space/parent
 *   or the explicit Drive root); there is no implicit "all documents" and no
 *   silent fallback to the root;
 * - one request = one provider page (`drive files list`, `wiki +node-list`,
 *   `wiki +space-list`, `drive +search`), continued only with the provider's
 *   `page_token`. `--page-all` and the multi-page shortcuts are never used;
 * - a Drive folder row is returned as a `drive-folder` SCOPE candidate (its
 *   token is the next explicit list range); only a user choice descends one
 *   level. The source never walks subfolders recursively;
 * - cursors are bound to the exact range/query that produced them; a stale
 *   cursor from another range is refused instead of silently mixing pages;
 * - `total` is never invented (Drive list/search expose no reliable total), and
 *   an unpaginatable root page or search index coverage is reported via
 *   `limited`;
 * - a wiki node is a separate identity: `/wiki/<token>` is resolved through
 *   `wiki +node-get`, and only `obj_type=docx` becomes a readable document.
 *
 * Reads fetch the whole document with the lightweight `--detail simple` detail
 * (S4 §5's ordinary-reading mode) and window it by byte offset. Content and
 * `revision_id` come from that one response. The pinned lark-cli 1.0.55 fetch
 * body has no `reference_map` opt-in and `docs +update` has no reference-map
 * flag (verified against the v1.0.55 source), so there is no sidecar to carry
 * or replay; the spec's sidecar clause is not implementable with this CLI
 * version. The plugin runner's stdout capture is capped at 8 MiB, so a document
 * above that cap is reported explicitly instead of being silently truncated.
 *
 * lark-cli 1.0.55 DOES support partial reads (`docs +fetch --scope
 * outline|range|keyword|section`), but the S1 read contract only carries a byte
 * `offset` and no block id, so this adapter cannot ask for a section. Instead,
 * a window is aligned to whole top-level XML blocks (`data.fragment='blocks'`)
 * and falls back to a raw byte slice (`data.fragment='bytes'`) when one block
 * is larger than the window. A block-id read is a follow-up S1 contract
 * extension, not a missing CLI flag.
 *
 * Edit is block-scoped and lossless for TEXT blocks: `loadEdit` fetches the XML
 * with `--detail full` (block ids + styles), and `saveEdit` sends only the
 * blocks the user changed through `docs +update --command block_replace
 * --block-id <id>`. Complex containers are read-only. Markdown is never a save
 * input. See {@link DOCS_EDIT_SCOPE_NOTE}.
 */
import { ClueError } from '../../types.ts'
import type {
  ClueCandidate,
  ClueEditDocument,
  ClueListResult,
  ClueOperationContext,
  CluePortableRef,
  ClueReadResult,
  ClueSaveEditInput,
  ClueSaveEditResult,
  ClueTypeDescriptor,
  JsonValue,
  Locator,
} from '../../types.ts'
import type {
  ClueSourceListInput,
  ClueSourceReadInput,
  ClueSourceRegistration,
  ClueSourceSaveInput,
  ClueSourceSearchInput,
} from '../../service.ts'
import type { ClueRuntime } from '../../runtime/types.ts'
import { decodeCursor, encodeCursor, stableJson } from './cursor.ts'
import {
  DOCS_EDIT_SCOPE_NOTE,
  FEISHU_CONNECTION_ID,
  FEISHU_DEPENDENCY_ID,
  FEISHU_FORMATS,
  FEISHU_PLUGIN_ID,
  FEISHU_SCOPE_ROLE,
  FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS,
  fallbackTitle,
  isRecord,
  parseDocEditData,
  stripHighlight,
  stringOf,
  type FeishuDocEditBlock,
  type FeishuDocEditData,
  type FeishuDocLocator,
  type FeishuDocProjection,
  type FeishuDocReadData,
} from './format.ts'
import {
  buildDocBlockXml,
  buildDocTitleXml,
  decodeXmlEntities,
  isEditableBlockTag,
  isSafeBlockId,
  parseDocEditXml,
  topLevelSpans,
} from './edit.ts'
import {
  larkWorkingDirectory,
  recordField,
  stringField,
  LARK_CLI_MAX_OUTPUT_BYTES,
  type LarkSuccess,
} from './lark.ts'
import { runFeishuCommand } from './auth.ts'
import {
  docLocatorKey,
  docProjectionOf,
  docLocatorTitle,
  hostOf,
  isDriveFolderLocator,
  isWikiLocator,
  isWikiSpaceLocator,
  normalizeDocLocator,
  parseDocLocator,
  parseFeishuDocText,
} from './urls.ts'

/** Provider page caps (documented maximums; a caller limit is clamped to them). */
const DRIVE_PAGE_SIZE = 200
const WIKI_PAGE_SIZE = 50
const SEARCH_PAGE_SIZE = 20
/** One read is a bounded fragment; the next page starts at `nextOffset`. */
const DOC_READ_MAX_BYTES = 256 * 1024
/** `drive +search` rejects a query longer than 30 Unicode code points. */
const SEARCH_QUERY_MAX_CHARS = 30
/** Bounds of one block-replace payload (argv size and accidental whole-doc writes). */
const MAX_EDIT_BLOCK_BYTES = 64 * 1024
const MAX_EDIT_TOTAL_BYTES = 256 * 1024
const MAX_EDIT_BLOCKS = 200
/** The `docs +fetch --detail full` invocation shared by loadEdit/save re-reads. */
const FETCH_FULL_ARGS = ['docs', '+fetch', '--api-version', 'v2'] as const
/** The native block update verb (one target block, no append/overwrite). */
const UPDATE_BLOCK_COMMAND = 'block_replace'
/** Locator kinds this source owns; anything else is another source's shape. */
const DOC_LOCATOR_KINDS: ReadonlySet<string> = new Set([
  'docx',
  'wiki',
  'wiki-space',
  'drive-folder',
])

/** The explicit browsing ranges of the docs source. */
export type DocsListScope =
  | { readonly kind: 'drive'; readonly folderToken: string }
  | { readonly kind: 'drive-root' }
  | { readonly kind: 'wiki'; readonly spaceId: string; readonly parentNodeToken?: string }
  | { readonly kind: 'wiki-spaces' }

/** The range filter a document search may carry. */
export type DocsSearchScope =
  | { readonly kind: 'drive'; readonly folderToken: string }
  | { readonly kind: 'wiki'; readonly spaceId: string }

/** Page-size bound of one explicit page. */
function pageLimitOf(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ClueError('invalid-request', 'the page size must be a positive integer')
  }
  return Math.min(limit, max)
}

/** The CLI process cwd (resource scope is never derived from it). */
function cwdOf(context: ClueOperationContext): string {
  return larkWorkingDirectory(context.workspacePath)
}

/** A required JSON object scope. */
function scopeRecord(value: JsonValue | undefined, what: string): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw new ClueError('invalid-request', `${what} needs an explicit browsing range`)
  }
  return value
}

/**
 * Resolve the personal-library alias to the real numeric space id.
 *
 * `wiki +space-list` never returns `my_library`, and `drive +search
 * --space-ids` documents numeric space ids only, so a search scoped to the
 * synthetic personal-library row must resolve the alias first. `wiki +node-list`
 * accepts the alias directly, so list does not pay this extra call.
 */
async function resolvedWikiSpaceId(
  runtime: ClueRuntime,
  spaceId: string,
  context: ClueOperationContext,
): Promise<string> {
  if (spaceId !== 'my_library') return spaceId
  const success = await runFeishuCommand(runtime, {
    args: [
      'wiki', 'spaces', 'get',
      // Typed API flag: a JSON `--params` argv token cannot cross the Windows
      // managed `.cmd` shim (cmd.exe would reinterpret the double quotes).
      '--space-id', spaceId,
      '--as', 'user', '--format', 'json',
    ],
    cwd: cwdOf(context),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const space = recordField(success.data, 'space') ?? success.data
  const resolved = stringField(space, 'space_id')
  if (resolved === undefined) {
    throw new ClueError('failed', 'lark-cli could not resolve the personal wiki library space id')
  }
  return resolved
}

/** Parse one list scope; absent/invalid is a typed empty-state failure, never "all documents". */
export function parseDocsListScope(value: JsonValue | undefined): DocsListScope {
  const record = scopeRecord(value, 'listing Feishu documents')
  const kind = record.kind
  if (kind === 'drive') {
    const folderToken = stringOf(record.folderToken)
    if (folderToken === undefined) {
      throw new ClueError('invalid-request', 'a Drive range needs a non-empty folder token (use kind "drive-root" for the explicit root)')
    }
    return { kind: 'drive', folderToken }
  }
  if (kind === 'drive-root') return { kind: 'drive-root' }
  if (kind === 'wiki') {
    const spaceId = stringOf(record.spaceId)
    if (spaceId === undefined) {
      throw new ClueError('invalid-request', 'a wiki range needs a space id (use "my_library" for the personal library)')
    }
    return {
      kind: 'wiki',
      spaceId,
      ...(stringOf(record.parentNodeToken) === undefined ? {} : { parentNodeToken: stringOf(record.parentNodeToken) }),
    }
  }
  if (kind === 'wiki-spaces') return { kind: 'wiki-spaces' }
  throw new ClueError('invalid-request', 'unknown Feishu document range')
}

/** Parse one optional search filter. */
export function parseDocsSearchScope(value: JsonValue | undefined): DocsSearchScope | undefined {
  if (value === undefined) return undefined
  const record = scopeRecord(value, 'searching Feishu documents')
  if (record.kind === 'drive') {
    const folderToken = stringOf(record.folderToken)
    if (folderToken === undefined) {
      throw new ClueError('invalid-request', 'a Drive search filter needs a non-empty folder token')
    }
    return { kind: 'drive', folderToken }
  }
  if (record.kind === 'wiki') {
    const spaceId = stringOf(record.spaceId)
    if (spaceId === undefined) {
      throw new ClueError('invalid-request', 'a wiki search filter needs a space id')
    }
    return { kind: 'wiki', spaceId }
  }
  // A root/space-picker range is a browse scope, not a search filter.
  throw new ClueError('invalid-request', 'a Feishu document search filter must be a Drive folder or a wiki space')
}

/** Decode a caller cursor against the exact range/query that minted it. */
function pageTokenOf(signature: string, cursor: string | undefined): string | undefined {
  return cursor === undefined ? undefined : decodeCursor(signature, cursor).pageToken
}

/**
 * The next provider cursor, or a `limited` marker when the provider truncated
 * but gave no token. When the provider explicitly says `has_more:false`, a
 * stale/echoed token must NOT mint a phantom next page.
 */
function pageOf(
  success: LarkSuccess,
  signature: string,
): { readonly nextCursor?: string; readonly limited?: boolean } {
  const hasMore = typeof success.data.has_more === 'boolean' ? success.data.has_more : undefined
  const token = stringField(success.data, 'next_page_token') ?? stringField(success.data, 'page_token')
  if (hasMore !== false && token !== undefined && token !== '') {
    return { nextCursor: encodeCursor(signature, token) }
  }
  return hasMore === true ? { limited: true } : {}
}

/** The expected array of one page; a malformed success envelope is a failure, not an empty page. */
function requiredArrayField(success: LarkSuccess, key: string, what: string): JsonValue[] {
  const value = success.data[key]
  if (!Array.isArray(value)) {
    throw new ClueError('failed', `lark-cli returned no ${what} list in its success payload`)
  }
  return value
}

/**
 * The rows of one `drive +search` answer.
 *
 * The CLI wrapper emits `results` (the raw Search v2 `res_units` rows);
 * accepting `res_units` as well keeps the raw API spelling usable, but neither
 * is ever treated as an empty page when absent.
 */
function searchRowsOf(success: LarkSuccess): JsonValue[] {
  for (const key of ['results', 'res_units']) {
    const value = success.data[key]
    if (Array.isArray(value)) return value
  }
  throw new ClueError('failed', 'lark-cli returned no document search result list in its success payload')
}

/**
 * Build one Drive FOLDER scope candidate. The locator carries the token the
 * caller passes as the next explicit `drive` list range; the source never
 * descends on its own. `meta.role='scope'` mirrors the wiki-space row.
 */
function driveFolderScopeCandidate(
  folderToken: string,
  title?: string,
  url?: string,
): ClueCandidate {
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    // There is no content type for a folder: this is a scope row, identified
    // by its locator kind/meta.role exactly like a wiki-space row.
    typeId: FEISHU_TYPE_IDS.docx,
    locator: {
      kind: 'drive-folder',
      folderToken,
      ...(url === undefined ? {} : { url }),
    } as unknown as Locator,
    title: title ?? `Feishu folder ${folderToken.slice(-8)}`,
    subtitle: 'Folder',
    meta: { role: FEISHU_SCOPE_ROLE, scopeKind: 'drive-folder' },
  }
}

/** Build one Drive folder candidate from a `drive files list` row. */
function driveFolderCandidate(file: Record<string, JsonValue>): ClueCandidate | undefined {
  const token = stringOf(file.token)
  if (token === undefined) return undefined
  return driveFolderScopeCandidate(token, stringOf(file.name), stringOf(file.url))
}

/** Build one Docx candidate from a Drive file row. */
function driveDocCandidate(file: Record<string, JsonValue>): ClueCandidate | undefined {
  const type = stringOf(file.type)
  if (type !== 'docx') return undefined
  const token = stringOf(file.token)
  if (token === undefined) return undefined
  const title = stringOf(file.name) ?? fallbackTitle(token)
  const url = stringOf(file.url)
  const modifiedTime = file.modified_time === undefined ? undefined : String(file.modified_time)
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    typeId: FEISHU_TYPE_IDS.docx,
    locator: { kind: 'docx', docToken: token, ...(url === undefined ? {} : { url }) } as unknown as Locator,
    title,
    subtitle: 'Docx',
    meta: {
      fileType: 'docx',
      ...(modifiedTime === undefined ? {} : { modifiedTime }),
    },
  }
}

/** Map one Drive row to either a folder SCOPE candidate or a readable Docx. */
function driveRowCandidate(file: Record<string, JsonValue>): ClueCandidate | undefined {
  if (stringOf(file.type) === 'folder') return driveFolderCandidate(file)
  return driveDocCandidate(file)
}

/** Build one wiki-node candidate from a `+node-list` row. */
function wikiNodeCandidate(
  node: Record<string, JsonValue>,
  spaceId: string,
): ClueCandidate | undefined {
  if (stringOf(node.obj_type) !== 'docx') return undefined
  const wikiToken = stringOf(node.node_token) ?? stringOf(node.token)
  if (wikiToken === undefined) return undefined
  const objToken = stringOf(node.obj_token)
  const title = stringOf(node.title) ?? fallbackTitle(wikiToken)
  const parentNodeToken = stringOf(node.parent_node_token)
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    typeId: FEISHU_TYPE_IDS.wiki,
    locator: {
      kind: 'wiki',
      wikiToken,
      objType: 'docx',
      ...(objToken === undefined ? {} : { objToken }),
      spaceId,
    } as unknown as Locator,
    title,
    subtitle: 'Wiki document',
    meta: {
      objType: 'docx',
      nodeType: stringOf(node.node_type) ?? 'origin',
      hasChild: node.has_child === true,
      spaceId,
      ...(parentNodeToken === undefined ? {} : { parentNodeToken }),
    },
  }
}

/** Build one wiki-space candidate (a scope picker row, not a document). */
function wikiSpaceCandidate(space: Record<string, JsonValue>): ClueCandidate | undefined {
  const spaceId = stringOf(space.space_id)
  if (spaceId === undefined) return undefined
  return wikiSpaceScopeCandidate(spaceId, stringOf(space.name), {
    spaceType: stringOf(space.space_type) ?? 'team',
    visibility: stringOf(space.visibility) ?? 'unknown',
  })
}

/** Build one synthetic wiki-space scope row (personal library / parsed space URL). */
function wikiSpaceScopeCandidate(
  spaceId: string,
  name: string | undefined,
  meta: Record<string, JsonValue> = {},
): ClueCandidate {
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    typeId: FEISHU_TYPE_IDS.wiki,
    locator: { kind: 'wiki-space', spaceId } as unknown as Locator,
    title: name ?? (spaceId === 'my_library' ? 'My library' : `Feishu wiki space ${spaceId}`),
    subtitle: 'Wiki space',
    meta: {
      role: FEISHU_SCOPE_ROLE,
      ...meta,
      // `wiki +space-list` never returns the personal library; the CLI
      // documents `my_library` as a user-identity alias for node-list.
      ...(spaceId === 'my_library' ? { synthetic: true } : {}),
    },
  }
}

/**
 * The supported document type of one `drive +search` hit.
 *
 * lark-cli 1.0.55's Search v2 response carries `res_units[].entity_type` and
 * `res_units[].result_meta.doc_types` (not the flat `doc_type` some older
 * fixtures used). A hit may spell the type in either place; both are checked
 * case-insensitively. Any other entity (sheet, bitable, file, folder, …) is
 * not a readable Feishu document for this source and is skipped.
 */
function searchTypeOf(types: readonly JsonValue[]): 'docx' | 'wiki' | undefined {
  const normalized: string[] = []
  for (const value of types) {
    if (typeof value === 'string') normalized.push(value.trim().toLowerCase())
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') normalized.push(entry.trim().toLowerCase())
      }
    }
  }
  if (normalized.includes('docx')) return 'docx'
  if (normalized.includes('wiki')) return 'wiki'
  return undefined
}

/**
 * Map one real `drive +search` result row to a supported document candidate.
 *
 * Each row of the CLI's `results` array is one Search v2 `res_units` entry:
 * `{title_highlighted, entity_type, result_meta:{doc_types, token, url,
 * update_time}}`. The token/url/type live under `result_meta`; reading only
 * top-level fields silently produced an empty, "successful" search page.
 */
function searchCandidate(row: Record<string, JsonValue>): ClueCandidate | undefined {
  const resultMeta = isRecord(row.result_meta) ? row.result_meta : {}
  const type = searchTypeOf([
    resultMeta.doc_types ?? null,
    row.entity_type ?? null,
    row.doc_type ?? null,
    row.type ?? null,
  ])
  const token = stringOf(resultMeta.token) ?? stringOf(row.token) ?? stringOf(row.obj_token)
  if (type === undefined || token === undefined) return undefined
  const title = stripHighlight(
    stringOf(row.title_highlighted)
      ?? stringOf(row.title)
      ?? stringOf(resultMeta.title)
      ?? fallbackTitle(token),
  )
  const url = stringOf(resultMeta.url) ?? stringOf(row.url)
  const updateTime = resultMeta.update_time ?? row.edit_time
  const editTime = updateTime === undefined ? undefined : String(updateTime)
  if (type === 'docx') {
    return {
      sourceId: FEISHU_SOURCE_IDS.docs,
      typeId: FEISHU_TYPE_IDS.docx,
      locator: { kind: 'docx', docToken: token, ...(url === undefined ? {} : { url }) } as unknown as Locator,
      title,
      subtitle: 'Docx',
      meta: { fileType: 'docx', ...(editTime === undefined ? {} : { editTime }) },
    }
  }
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    typeId: FEISHU_TYPE_IDS.wiki,
    locator: { kind: 'wiki', wikiToken: token, ...(url === undefined ? {} : { url }) } as unknown as Locator,
    title,
    subtitle: 'Wiki document',
    meta: { objType: 'docx', ...(editTime === undefined ? {} : { editTime }) },
  }
}

/** One node-get answer (resolved underlying object). */
interface ResolvedWikiNode {
  readonly wikiToken: string
  readonly objToken: string
  readonly spaceId?: string
  readonly title: string
}

/**
 * Resolve a wiki node token/URL to its underlying object. A wiki token is
 * never assumed to be a docx token.
 * @throws {ClueError} `unsupported` when the node wraps a non-docx object.
 */
async function resolveWikiNode(
  runtime: ClueRuntime,
  wikiToken: string,
  url: string | undefined,
  context: ClueOperationContext,
): Promise<ResolvedWikiNode> {
  const success = await runFeishuCommand(runtime, {
    args: ['wiki', '+node-get', '--node-token', url ?? wikiToken, '--as', 'user', '--format', 'json'],
    cwd: cwdOf(context),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const node = recordField(success.data, 'node') ?? success.data
  const objType = stringOf(node.obj_type) ?? stringOf(node.objType)
  const objToken = stringOf(node.obj_token) ?? stringOf(node.objToken)
  const nodeToken = stringOf(node.node_token) ?? stringOf(node.token) ?? wikiToken
  if (objToken === undefined) {
    throw new ClueError('failed', 'lark-cli did not resolve the wiki node to an underlying object token')
  }
  if (objType !== 'docx') {
    // Do not interpolate the upstream obj_type: an anomalous/malicious value
    // would otherwise flow into a user/model-visible error.
    throw new ClueError(
      'unsupported',
      'the wiki node wraps a non-document object; only Docx documents are supported',
    )
  }
  return {
    wikiToken: nodeToken,
    objToken,
    ...(stringOf(node.space_id) === undefined ? {} : { spaceId: stringOf(node.space_id) }),
    title: stringOf(node.title) ?? fallbackTitle(nodeToken),
  }
}

/**
 * Extract the `<title>` of a Docx XML projection.
 *
 * DocxXML may attach attributes to the title (a block id in an id-bearing
 * export, alignment, …), so accept `<title …>` as well as bare `<title>`.
 * Matching only the bare form silently fell back to a token-derived title.
 */
function titleOfContent(content: string): string | undefined {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(content)
  if (match === null) return undefined
  const title = decodeXmlEntities(match[1]!.replace(/<[^>]*>/g, '')).trim()
  return title === '' ? undefined : title
}

/**
 * Extract the title of a Markdown projection. Markdown has no structural
 * `<title>` node; a leading level-1 heading is a best-effort heuristic, not a
 * documented title field. When the export opens with a paragraph or a lower
 * heading there is no title to claim (fall back to the resolved node title /
 * locator). Markdown is never used as an edit/save input.
 */
function titleOfMarkdown(content: string): string | undefined {
  const firstLine = content.split(/\r?\n/).find(line => line.trim() !== '')
  if (firstLine === undefined) return undefined
  // Only a LEVEL-1 ATX heading is a plausible document title; a `## Section`
  // opening line is a section, not the title, so do not claim it as one.
  const match = /^#\s+(.+?)\s*#*\s*$/.exec(firstLine.trim())
  const title = match?.[1]?.trim()
  return title === undefined || title === '' ? undefined : title
}

/** One read window; `fragment` labels partial XML honestly. */
interface ContentFragment {
  readonly text: string
  readonly limited: boolean
  readonly nextOffset?: number
  readonly fragment?: 'blocks' | 'bytes'
}

/** UTF-8-safe byte slice, never splitting a code point. */
function byteWindowOf(content: string, offset: number): ContentFragment {
  const bytes = new TextEncoder().encode(content)
  let end = Math.min(offset + DOC_READ_MAX_BYTES, bytes.length)
  // Never split a UTF-8 code point: move the page boundary back to its start.
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1
  if (end === offset && end < bytes.length) end = Math.min(offset + DOC_READ_MAX_BYTES, bytes.length)
  const limited = end < bytes.length
  return {
    text: new TextDecoder().decode(bytes.subarray(offset, end)),
    limited,
    ...(limited ? { nextOffset: end } : {}),
    // A partial byte slice is not a well-formed XML document; the data says so.
    ...(limited || offset > 0 ? { fragment: 'bytes' as const } : {}),
  }
}

/**
 * A byte window of one document.
 *
 * For XML, windows are aligned to COMPLETE top-level blocks so the returned
 * text never cuts a tag/attribute/entity in half. A single block larger than
 * the window falls back to a raw byte slice and labels itself as such. For
 * Markdown (no structure) and for malformed XML the raw byte window is used.
 * @param content - the full document projection.
 * @param offset - byte offset of this window.
 * @param alignBlocks - whether the caller asked for the XML projection.
 */
function fragmentOf(content: string, offset: number, alignBlocks: boolean): ContentFragment {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ClueError('invalid-request', 'the document byte offset must be a non-negative integer')
  }
  const totalBytes = new TextEncoder().encode(content).length
  if (offset > totalBytes) {
    throw new ClueError('invalid-request', 'the document byte offset is past the end of the content')
  }
  if (!alignBlocks) return byteWindowOf(content, offset)
  const spans = topLevelSpans(content)
  if (spans === undefined || spans.length === 0) return byteWindowOf(content, offset)
  // Character spans → byte spans in one pass (never O(n²)).
  const byteSpans: Array<{ readonly start: number; readonly end: number }> = []
  let previous = 0
  let bytes = 0
  for (const span of spans) {
    bytes += new TextEncoder().encode(content.slice(previous, span.start)).length
    const start = bytes
    bytes += new TextEncoder().encode(content.slice(span.start, span.end)).length
    byteSpans.push({ start, end: bytes })
    previous = span.end
  }
  const total = byteSpans[byteSpans.length - 1]!.end
  // A full read is the whole document, not a fragment (leading/trailing
  // whitespace outside the top-level elements is still the whole document).
  if (offset === 0 && content.slice(spans[spans.length - 1]!.end).trim() === '' && totalBytes <= DOC_READ_MAX_BYTES) {
    return { text: content, limited: false }
  }
  // Align forward: never start in the middle of a block.
  let first = byteSpans.findIndex(span => span.end > offset)
  if (first < 0) return { text: '', limited: false, fragment: 'blocks' }
  if (byteSpans[first]!.start < offset) first += 1
  if (first >= byteSpans.length) {
    // The offset points inside the LAST block: a whole-block window would be
    // empty, so return the raw remainder and label it as a byte slice.
    return byteWindowOf(content, offset)
  }
  let last = first
  while (last + 1 < byteSpans.length && byteSpans[last + 1]!.end - byteSpans[first]!.start <= DOC_READ_MAX_BYTES) {
    last += 1
  }
  if (byteSpans[last]!.end - byteSpans[first]!.start > DOC_READ_MAX_BYTES) {
    // One block is larger than the read window: a raw slice is the only honest answer.
    return byteWindowOf(content, offset)
  }
  const startChar = spans[first]!.start
  const endChar = spans[last]!.end
  const nextOffset = byteSpans[last]!.end
  const limited = nextOffset < total
  return {
    text: content.slice(startChar, endChar),
    limited,
    ...(limited ? { nextOffset } : {}),
    fragment: 'blocks',
  }
}

/** The server-side document payload of one `docs +fetch` answer. */
interface FetchedDocument {
  readonly content: string
  readonly title?: string
  readonly revisionId?: string
}

/** Parse one `docs +fetch` success payload. */
function fetchedDocumentOf(success: LarkSuccess): FetchedDocument {
  const document = recordField(success.data, 'document')
  if (document === undefined) {
    throw new ClueError('failed', 'lark-cli returned no document content')
  }
  // An EMPTY document is a legitimate document, not a missing payload: the
  // title may also be the only block. Only a non-string `content` is malformed.
  const rawContent = document.content
  if (typeof rawContent !== 'string') {
    throw new ClueError('failed', 'lark-cli returned no document content')
  }
  const content = rawContent
  const title = stringField(document, 'title')
  // `document.title` is tolerated when present, but the documented
  // `docs +fetch` payload has no title field; the XML `<title>` (or the
  // resolved wiki node) is the authoritative source.
  const revision = document.revision_id
  return {
    content,
    ...(title === undefined ? {} : { title }),
    ...(revision === undefined ? {} : { revisionId: String(revision) }),
  }
}

/** Resolve the doc argument of a fetch, unpacking a wiki node when needed. */
async function docArgumentOf(
  runtime: ClueRuntime,
  locator: FeishuDocLocator,
  context: ClueOperationContext,
): Promise<{ readonly token: string; readonly title?: string }> {
  if (locator.kind === 'docx') return { token: locator.docToken }
  if (locator.kind === 'wiki-space') {
    throw new ClueError('invalid-request', 'a wiki space is a browsing scope, not a document')
  }
  if (locator.kind === 'drive-folder') {
    throw new ClueError('invalid-request', 'a Drive folder is a browsing scope, not a document')
  }
  if (locator.objType !== undefined && locator.objType !== 'docx') {
    // The locator is caller-supplied; never interpolate its objType into the
    // visible message.
    throw new ClueError(
      'unsupported',
      'the wiki locator points at a non-document object; only Docx documents are supported',
    )
  }
  if (locator.objToken !== undefined) return { token: locator.objToken }
  const resolved = await resolveWikiNode(runtime, locator.wikiToken, locator.url, context)
  return { token: resolved.objToken, title: resolved.title }
}

/**
 * Fetch one document with block ids (`--detail full`). The docs read path uses
 * `simple`; only the editor and its save-time re-read need ids and styles.
 */
async function fetchFullDocument(
  runtime: ClueRuntime,
  token: string,
  context: ClueOperationContext,
): Promise<FetchedDocument> {
  const success = await runFeishuCommand(runtime, {
    args: [
      ...FETCH_FULL_ARGS,
      '--doc', token,
      '--doc-format', 'xml',
      '--detail', 'full',
      '--as', 'user', '--format', 'json',
    ],
    cwd: cwdOf(context),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  return fetchedDocumentOf(success)
}

/** UTF-8 byte length (argv/payload budget). */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Project one full fetch into the renderer's edit data. */
function editDataOf(
  locator: FeishuDocLocator,
  docToken: string,
  fetched: FetchedDocument,
): FeishuDocEditData {
  const parsed = parseDocEditXml(fetched.content)
  // Never invent a title for the editor: an absent/empty <title> stays empty
  // (and may be uneditable when it has no block id). The read preview is the
  // place that may fall back to a resolved wiki/locator title.
  const title = parsed.title
  // Validate the title block id BEFORE advertising it as editable: a dash/`-1`
  // or otherwise unsafe id must never reach `--block-id`.
  const titleBlockId = parsed.titleBlockId !== undefined && isSafeBlockId(parsed.titleBlockId)
    ? parsed.titleBlockId
    : undefined
  return {
    kind: locator.kind === 'docx' ? 'docx' : 'wiki',
    docToken,
    ...(locator.kind === 'wiki'
      ? { wikiToken: locator.wikiToken, objToken: docToken, objType: 'docx' }
      : {}),
    ...(locator.url === undefined ? {} : { sourceUrl: locator.url }),
    ...(fetched.revisionId === undefined ? {} : { revisionId: fetched.revisionId }),
    title,
    baselineTitle: title,
    titleEditable: titleBlockId !== undefined,
    ...(titleBlockId === undefined ? {} : { titleBlockId }),
    titleAttrs: parsed.titleAttrs,
    blocks: parsed.blocks,
    readOnlyBlocks: parsed.readOnlyBlocks,
  }
}

/** The current block models by id (the save-time structural baseline). */
function blockModelsOf(content: string): Map<string, FeishuDocEditBlock> {
  const parsed = parseDocEditXml(content)
  const map = new Map<string, FeishuDocEditBlock>()
  for (const block of parsed.blocks) map.set(block.id, block)
  return map
}

/** The parsed title identity of the current XML. */
function titleModelOf(content: string): { readonly text: string; readonly blockId?: string; readonly attrs: string } {
  const parsed = parseDocEditXml(content)
  return {
    text: parsed.title,
    ...(parsed.titleBlockId === undefined ? {} : { blockId: parsed.titleBlockId }),
    attrs: parsed.titleAttrs,
  }
}

/** The native revision id of one block update answer. */
function revisionOfUpdate(success: LarkSuccess): string | undefined {
  const document = recordField(success.data, 'document')
  const revision = document?.revision_id
  return revision === undefined ? undefined : String(revision)
}

/**
 * Fail a write unless the business result is an unqualified full success.
 *
 * `docs +update` returns `{result, updated_blocks_count, warnings}` in
 * addition to the envelope. An absent/unknown `result`, a non-empty
 * `warnings` list or an unexpected `updated_blocks_count` means the write must
 * not be reported as complete (S4 §8).
 * @param success - one update success envelope.
 * @param expectedBlocks - number of block writes this answer must have applied.
 */
function assertUpdateResult(success: LarkSuccess, expectedBlocks = 1): void {
  const result = stringField(success.data, 'result')
  if (result === undefined) {
    throw new ClueError('failed', 'lark-cli did not report a document update result')
  }
  if (result !== 'success') {
    throw new ClueError(
      'failed',
      result === 'partial_success'
        ? 'lark-cli reported the document update as a partial success'
        : 'lark-cli reported the document update as failed',
      result === 'partial_success' ? { partial: 'true' } : undefined,
    )
  }
  const warnings = success.data.warnings
  if (Array.isArray(warnings) && warnings.length > 0) {
    throw new ClueError(
      'failed',
      'lark-cli reported warnings for the document update; the write is not confirmed complete',
      { partial: 'true' },
    )
  }
  if (success.data.warnings !== undefined && !Array.isArray(warnings)) {
    throw new ClueError(
      'failed',
      'lark-cli returned an unreadable warning list for the document update',
      { partial: 'true' },
    )
  }
  const count = success.data.updated_blocks_count
  if (count !== undefined) {
    const parsed = typeof count === 'number' ? count : Number(stringOf(count) ?? Number.NaN)
    if (!Number.isInteger(parsed) || parsed !== expectedBlocks) {
      throw new ClueError(
        'failed',
        'lark-cli did not confirm that every requested document block was updated',
        { partial: 'true' },
      )
    }
  }
}

/**
 * The safe partial-success error after a write was at least attempted.
 * `written` may be empty when the very first block's business result was
 * partial: the caller then learns that nothing is confirmed complete instead
 * of the failure being mislabeled as an outright failure.
 */
function partialEditError(error: unknown, written: readonly string[], unwritten: readonly string[]): ClueError {
  const base = error instanceof ClueError
    ? error
    : new ClueError('failed', 'the document block update failed')
  const message = written.length === 0
    ? `partial success: the first block update was not confirmed complete (${base.message}); `
      + 'no block is reported as fully written and the draft is preserved'
    : `partial success: ${written.length} block(s) were saved, but the remaining block(s) `
      + `were not written (${base.message}); the draft is preserved`
  return new ClueError(
    base.category,
    message,
    {
      ...(base.meta ?? {}),
      partial: 'true',
      written: written.join(','),
      unwritten: unwritten.join(','),
    },
  )
}

/** Validate one block id/change set before issuing any write. */
function validateEditDocument(
  edited: FeishuDocEditData,
  changedBlocks: readonly FeishuDocEditBlock[],
  titleChanged: boolean,
): void {
  if (changedBlocks.length + (titleChanged ? 1 : 0) > MAX_EDIT_BLOCKS) {
    throw new ClueError('invalid-request', `a document save may update at most ${MAX_EDIT_BLOCKS} blocks`)
  }
  let total = 0
  const seen = new Set<string>()
  for (const block of changedBlocks) {
    if (!isSafeBlockId(block.id)) {
      throw new ClueError('invalid-request', 'a document block id is not a safe identifier')
    }
    if (seen.has(block.id)) {
      throw new ClueError('invalid-request', 'a document save repeats one block id')
    }
    seen.add(block.id)
    if (!isEditableBlockTag(block.tag)) {
      throw new ClueError('invalid-request', 'a document save targets a block type that is not editable')
    }
    if (block.kind !== 'xml' && block.kind !== 'plain') {
      throw new ClueError('invalid-request', 'a document block has an unknown text kind')
    }
    if (titleChanged && edited.titleBlockId === block.id) {
      throw new ClueError('invalid-request', 'a document save targets the title block twice')
    }
    const bytes = utf8Length(block.text)
    if (bytes > MAX_EDIT_BLOCK_BYTES) {
      throw new ClueError(
        'invalid-request',
        `one document block is too large to save (limit ${MAX_EDIT_BLOCK_BYTES} bytes)`,
      )
    }
    total += bytes
  }
  if (titleChanged) {
    total += utf8Length(edited.title)
    if (edited.title.trim() === '') {
      throw new ClueError('invalid-request', 'a document title cannot be empty')
    }
    if (!edited.titleEditable || edited.titleBlockId === undefined) {
      throw new ClueError(
        'unsupported',
        'this document did not expose an editable title block; the title stays read-only',
      )
    }
    if (!isSafeBlockId(edited.titleBlockId)) {
      throw new ClueError('invalid-request', 'a document title block id is not a safe identifier')
    }
  }
  if (total > MAX_EDIT_TOTAL_BYTES) {
    throw new ClueError(
      'invalid-request',
      `the document edit is too large to save (limit ${MAX_EDIT_TOTAL_BYTES} bytes)`,
    )
  }
}

/**
 * Refuse client-supplied write metadata that does not match the freshly
 * re-read document.
 *
 * The save payload is client-owned. Without this check a stale/buggy client
 * could retarget a block id, change `tag`/`attrs` (p→h2, alignment, checkbox
 * `done`, caption) or point at an id inside another attribute, and the write
 * would silently rewrite structure the editor is not allowed to touch.
 * @param currentContent - the fresh `--detail full` XML.
 * @returns nothing; throws `conflict`/`invalid-request` on any mismatch.
 */
function requireCurrentStructure(
  edited: FeishuDocEditData,
  changedBlocks: readonly FeishuDocEditBlock[],
  titleChanged: boolean,
  currentContent: string,
): void {
  if (!parseDocEditXml(currentContent).complete) {
    throw new ClueError(
      'failed',
      'lark-cli returned document XML with an unparsable tail during the save comparison',
    )
  }
  const currentBlocks = blockModelsOf(currentContent)
  for (const block of changedBlocks) {
    const current = currentBlocks.get(block.id)
    if (current === undefined || !isEditableBlockTag(current.tag)) {
      throw new ClueError('conflict', 'the document changed since it was loaded; re-read it and retry')
    }
    if (
      current.tag !== block.tag
      || current.attrs !== block.attrs
      || current.kind !== block.kind
      || current.text !== block.baseline
    ) {
      throw new ClueError(
        'conflict',
        'the block structure changed since it was loaded; re-read it and retry',
      )
    }
  }
  if (!titleChanged) return
  const currentTitle = titleModelOf(currentContent)
  if (
    edited.titleBlockId === undefined
    || currentTitle.blockId !== edited.titleBlockId
    || currentTitle.attrs !== edited.titleAttrs
    || currentTitle.text !== edited.baselineTitle
  ) {
    throw new ClueError('conflict', 'the document title changed since it was loaded; re-read it and retry')
  }
}

/** The source descriptor (client presentation is registered separately). */
function docsDescriptor(): ClueSourceRegistration['descriptor'] {
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    name: 'Feishu docs',
    icon: 'feishu-docs',
    order: 3,
    pluginId: FEISHU_PLUGIN_ID,
    types: [FEISHU_TYPE_IDS.docx, FEISHU_TYPE_IDS.wiki],
    transport: 'cli',
    capabilities: {
      resolve: true,
      list: true,
      search: true,
      read: true,
      // Text blocks are edited through the native block-scoped replace verb;
      // complex containers stay read-only (see DOCS_EDIT_SCOPE_NOTE).
      edit: true,
      portable: true,
    },
    dependencyIds: [FEISHU_DEPENDENCY_ID],
    connectionId: FEISHU_CONNECTION_ID,
  }
}

/** Type descriptors; both document types share XML/Markdown read formats. */
function docsTypes(): ClueTypeDescriptor[] {
  const note = { editScope: DOCS_EDIT_SCOPE_NOTE }
  return [FEISHU_TYPE_IDS.docx, FEISHU_TYPE_IDS.wiki].map(typeId => ({
    typeId,
    sourceId: FEISHU_SOURCE_IDS.docs,
    formats: [FEISHU_FORMATS.docsXml, FEISHU_FORMATS.docsMarkdown],
    // The native revision id is used as the `--revision-id` baseline for each
    // block write; this is a best-effort comparison, not an atomic CAS claim.
    capabilities: { read: true, edit: true, concurrency: 'check-before-save' },
    extensions: note,
  }))
}

/**
 * Create the `builtin.feishu.docs` source registration.
 * @param getRuntime - lazy runtime accessor (never called at construction).
 */
export function createFeishuDocsSource(getRuntime: () => ClueRuntime): ClueSourceRegistration {
  const runtime = (): ClueRuntime => getRuntime()

  return {
    descriptor: docsDescriptor(),
    types: docsTypes(),
    operations: {
      normalizeLocator(locator: Locator): Locator {
        return normalizeDocLocator(locator)
      },

      locatorKey(locator: Locator): string {
        return docLocatorKey(locator)
      },

      async resolve(
        input: { readonly text?: string; readonly locator?: Locator; readonly explicit?: boolean },
        context: ClueOperationContext,
      ) {
        if (input.locator !== undefined) {
          // Auto resolution walks the sources in order. A locator of another
          // source's shape (e.g. `{kind:'task'}`) is not a docs failure: it
          // must answer "not mine" so the later source can resolve it. Only an
          // explicit source call reports the malformed shape.
          const kind = isRecord(input.locator) ? input.locator.kind : undefined
          if (typeof kind !== 'string' || !DOC_LOCATOR_KINDS.has(kind)) {
            if (input.explicit === true) {
              throw new ClueError(
                'invalid-request',
                'a locator must be a Feishu docx, wiki, wiki-space or drive-folder reference',
              )
            }
            return undefined
          }
          const locator = parseDocLocator(input.locator)
          if (isWikiSpaceLocator(locator)) return undefined
          if (isDriveFolderLocator(locator)) {
            return driveFolderScopeCandidate(
              locator.folderToken,
              docLocatorTitle(locator),
              locator.url,
            )
          }
          if (isWikiLocator(locator) && locator.objType !== undefined && locator.objType !== 'docx') {
            // A wiki node wrapping a sheet/bitable/... is not a readable text
            // document. Return a stable-but-unreadable candidate was the old
            // bug; auto resolution answers "not mine", an explicit source call
            // reports the unsupported object.
            if (input.explicit === true) {
              throw new ClueError(
                'unsupported',
                'the wiki locator points at a non-document object; only Docx documents are supported',
              )
            }
            return undefined
          }
          if (isWikiLocator(locator) && (locator.objToken === undefined || locator.objType === undefined)) {
            const resolved = await resolveWikiNode(runtime(), locator.wikiToken, locator.url, context)
            return {
              sourceId: FEISHU_SOURCE_IDS.docs,
              typeId: FEISHU_TYPE_IDS.wiki,
              locator: {
                kind: 'wiki',
                wikiToken: resolved.wikiToken,
                objToken: resolved.objToken,
                objType: 'docx',
                ...(resolved.spaceId === undefined ? {} : { spaceId: resolved.spaceId }),
                ...(locator.url === undefined ? {} : { url: locator.url }),
              } as unknown as Locator,
              title: resolved.title,
              subtitle: 'Wiki document',
              meta: { objType: 'docx', resolved: true },
            }
          }
          return {
            sourceId: FEISHU_SOURCE_IDS.docs,
            typeId: locator.kind === 'docx' ? FEISHU_TYPE_IDS.docx : FEISHU_TYPE_IDS.wiki,
            locator: locator as unknown as Locator,
            title: docLocatorTitle(locator),
          }
        }
        if (input.text === undefined) return undefined
        const parsed = parseFeishuDocText(input.text)
        if (parsed === undefined) return undefined
        if (parsed.kind === 'docx') {
          return {
            sourceId: FEISHU_SOURCE_IDS.docs,
            typeId: FEISHU_TYPE_IDS.docx,
            locator: {
              kind: 'docx',
              docToken: parsed.docToken,
              ...(parsed.url === undefined ? {} : { url: parsed.url }),
            } as unknown as Locator,
            title: fallbackTitle(parsed.docToken),
            subtitle: 'Docx',
          }
        }
        if (parsed.kind === 'drive-folder') {
          return driveFolderScopeCandidate(parsed.folderToken, undefined, parsed.url)
        }
        if (parsed.kind === 'wiki-space') {
          // `/wiki/space/<space_id>` is a wiki-space scope, not a node token;
          // asking `wiki +node-get --node-token space` was the old bug.
          return wikiSpaceScopeCandidate(parsed.spaceId, undefined)
        }
        const resolved = await resolveWikiNode(runtime(), parsed.wikiToken, parsed.url, context)
        return {
          sourceId: FEISHU_SOURCE_IDS.docs,
          typeId: FEISHU_TYPE_IDS.wiki,
          locator: {
            kind: 'wiki',
            wikiToken: resolved.wikiToken,
            objToken: resolved.objToken,
            objType: 'docx',
            ...(resolved.spaceId === undefined ? {} : { spaceId: resolved.spaceId }),
            ...(parsed.url === undefined ? {} : { url: parsed.url }),
          } as unknown as Locator,
          title: resolved.title,
          subtitle: 'Wiki document',
          meta: { objType: 'docx', resolved: true },
        }
      },

      async list(input: ClueSourceListInput, context): Promise<ClueListResult> {
        const scope = parseDocsListScope(input.scope)
        const signature = stableJson(scope as unknown as JsonValue)
        const pageToken = pageTokenOf(signature, input.cursor)
        const cwd = cwdOf(context)
        const signal = context.signal === undefined ? {} : { signal: context.signal }

        if (scope.kind === 'drive' || scope.kind === 'drive-root') {
          const limit = pageLimitOf(input.limit, 100, DRIVE_PAGE_SIZE)
          if (scope.kind === 'drive-root' && pageToken !== undefined) {
            throw new ClueError('invalid-request', 'the Drive root page is not paginated; reset the range')
          }
          const fileArgs = [
            // Typed API flags, never a JSON `--params` argv token: a managed
            // Windows `.cmd` shim would reject the embedded double quotes.
            // The Drive root is requested by omitting `--folder-token` (the
            // CLI documents that as the root listing).
            ...(scope.kind === 'drive' ? ['--folder-token', scope.folderToken] : []),
            '--page-size', String(limit),
            ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
          ]
          const success = await runFeishuCommand(runtime(), {
            args: ['drive', 'files', 'list', ...fileArgs, '--as', 'user', '--format', 'json'],
            cwd,
            ...signal,
          })
          const files = requiredArrayField(success, 'files', 'Drive file')
          const items: ClueCandidate[] = []
          for (const file of files) {
            if (!isRecord(file)) continue
            const candidate = driveRowCandidate(file)
            if (candidate !== undefined) items.push(candidate)
          }
          const page = pageOf(success, signature)
          return {
            items,
            // The Drive root explicitly does not support the folder pagination
            // contract; its first page is a starting point, never a full range.
            ...(scope.kind === 'drive-root' ? { limited: true } : page),
          }
        }

        if (scope.kind === 'wiki-spaces') {
          const limit = pageLimitOf(input.limit, WIKI_PAGE_SIZE, WIKI_PAGE_SIZE)
          const success = await runFeishuCommand(runtime(), {
            args: [
              'wiki', '+space-list', '--page-size', String(limit),
              ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
              '--as', 'user', '--format', 'json',
            ],
            cwd,
            ...signal,
          })
          const spaces = requiredArrayField(success, 'spaces', 'wiki space')
          const items: ClueCandidate[] = []
          // `wiki +space-list` never returns the personal library; without a
          // synthetic row the user can never pick it from the source. It is
          // only prepended to the first page, never invented on a cursor page.
          if (pageToken === undefined) items.push(wikiSpaceScopeCandidate('my_library', undefined))
          for (const space of spaces) {
            if (!isRecord(space)) continue
            const candidate = wikiSpaceCandidate(space)
            if (candidate !== undefined) items.push(candidate)
          }
          return { items, ...pageOf(success, signature) }
        }

        const limit = pageLimitOf(input.limit, WIKI_PAGE_SIZE, WIKI_PAGE_SIZE)
        const success = await runFeishuCommand(runtime(), {
          args: [
            'wiki', '+node-list', '--space-id', scope.spaceId,
            ...(scope.parentNodeToken === undefined ? [] : ['--parent-node-token', scope.parentNodeToken]),
            '--page-size', String(limit),
            ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
            '--as', 'user', '--format', 'json',
          ],
          cwd,
          ...signal,
        })
        const nodes = requiredArrayField(success, 'nodes', 'wiki node')
        const items: ClueCandidate[] = []
        for (const node of nodes) {
          if (!isRecord(node)) continue
          const candidate = wikiNodeCandidate(node, scope.spaceId)
          if (candidate !== undefined) items.push(candidate)
        }
        return { items, ...pageOf(success, signature) }
      },

      async search(input: ClueSourceSearchInput, context): Promise<ClueListResult> {
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        if ([...query].length > SEARCH_QUERY_MAX_CHARS) {
          throw new ClueError(
            'invalid-request',
            `a Feishu document search keyword is at most ${SEARCH_QUERY_MAX_CHARS} characters`,
          )
        }
        const scope = parseDocsSearchScope(input.scope)
        if (query === '' && scope === undefined) {
          throw new ClueError('invalid-request', 'a Feishu document search needs a keyword or an explicit range')
        }
        const signature = stableJson({
          query,
          ...(scope === undefined ? {} : { scope }),
        } as unknown as JsonValue)
        const pageToken = pageTokenOf(signature, input.cursor)
        const limit = pageLimitOf(input.limit, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE)
        const searchSpaceId = scope?.kind === 'wiki'
          ? await resolvedWikiSpaceId(runtime(), scope.spaceId, context)
          : undefined
        const success = await runFeishuCommand(runtime(), {
          args: [
            'drive', '+search', '--query', query,
            // The S4 source only models Docx and wiki nodes; asking for the
            // legacy `doc` type produced hits the mapper then dropped.
            '--doc-types', 'docx,wiki',
            ...(scope === undefined
              ? []
              : scope.kind === 'drive'
                ? ['--folder-tokens', scope.folderToken]
                : ['--space-ids', searchSpaceId!]),
            '--page-size', String(limit),
            ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
            '--as', 'user', '--format', 'json',
          ],
          cwd: cwdOf(context),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        // lark-cli 1.0.55's `drive +search` JSON wrapper exposes the raw
        // Search v2 `res_units` under `results`; each row keeps its
        // identifiers in `result_meta` (there is no top-level token/doc_type).
        // Accept a raw `res_units` payload too, but a missing array is a
        // malformed answer, never an empty page.
        const rows = searchRowsOf(success)
        const items: ClueCandidate[] = []
        for (const row of rows) {
          if (!isRecord(row)) continue
          const candidate = searchCandidate(row)
          if (candidate !== undefined) items.push(candidate)
        }
        const page = pageOf(success, signature)
        // The provider search is an index over what the service indexed and the
        // account may see; it never promises a complete document corpus and its
        // `total` is documented as unreliable — mark the coverage limit, never
        // invent a total.
        return { items, limited: true, ...page }
      },

      async read(input: ClueSourceReadInput, context): Promise<ClueReadResult> {
        const locator = parseDocLocator(input.locator)
        const runtimeNow = runtime()
        const doc = await docArgumentOf(runtimeNow, locator, context)
        const projection: FeishuDocProjection = docProjectionOf(locator)
        let success: LarkSuccess
        try {
          success = await runFeishuCommand(runtimeNow, {
            args: [
              'docs', '+fetch', '--api-version', 'v2', '--doc', doc.token,
              '--doc-format', projection,
              // S4 §5's ordinary reading mode: lightweight `simple` detail.
              // The read needs content + revision, both of which simple
              // carries; block ids/styles belong to `loadEdit` (detail full).
              '--detail', 'simple',
              '--as', 'user', '--format', 'json',
            ],
            cwd: cwdOf(context),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
        } catch (error) {
          // The read is a whole-document fetch windowed by byte offset. An
          // oversized document cannot be fetched through the bounded runner;
          // report the fixed limit instead of returning a silent partial read.
          if (error instanceof ClueError && /capture limit/i.test(error.message)) {
            const mebibytes = LARK_CLI_MAX_OUTPUT_BYTES / (1024 * 1024)
            throw new ClueError(
              'failed',
              `the document exceeds the plugin runner's ${mebibytes} MiB stdout capture limit and `
              + 'cannot be read in one fragment; the S1 read contract carries only a byte offset, '
              + 'so this adapter cannot request a block-scoped section here',
            )
          }
          throw error
        }
        const fetched = fetchedDocumentOf(success)
        const fragment = fragmentOf(fetched.content, input.offset ?? 0, projection === 'xml')
        // XML has an authoritative <title>; Markdown's first heading is only a
        // fallback when neither the CLI nor the resolved wiki node reports one.
        const title = projection === 'xml'
          ? titleOfContent(fetched.content) ?? fetched.title ?? doc.title ?? docLocatorTitle(locator)
          : fetched.title ?? doc.title ?? titleOfMarkdown(fetched.content) ?? docLocatorTitle(locator)
        const data: FeishuDocReadData = {
          kind: locator.kind === 'docx' ? 'docx' : 'wiki',
          title,
          projection,
          content: fragment.text,
          docToken: locator.kind === 'docx' ? locator.docToken : doc.token,
          ...(locator.kind === 'wiki' ? { wikiToken: locator.wikiToken, objToken: doc.token, objType: 'docx' } : {}),
          ...(locator.url === undefined ? {} : { sourceUrl: locator.url }),
          ...(fetched.revisionId === undefined ? {} : { revisionId: fetched.revisionId }),
          ...(fragment.fragment === undefined ? {} : { fragment: fragment.fragment }),
        }
        return {
          format: projection === 'xml' ? FEISHU_FORMATS.docsXml : FEISHU_FORMATS.docsMarkdown,
          data: data as unknown as JsonValue,
          ...(fetched.revisionId === undefined ? {} : { revision: fetched.revisionId }),
          fetchedAt: new Date().toISOString(),
          freshness: 'live',
          text: fragment.text,
          ...(fragment.limited ? { limited: true } : {}),
          ...(fragment.nextOffset === undefined ? {} : { nextOffset: fragment.nextOffset }),
        }
      },

      async loadEdit(input: ClueSourceReadInput, context): Promise<ClueEditDocument> {
        const locator = parseDocLocator(input.locator)
        const runtimeNow = runtime()
        const doc = await docArgumentOf(runtimeNow, locator, context)
        let fetched: FetchedDocument
        try {
          fetched = await fetchFullDocument(runtimeNow, doc.token, context)
        } catch (error) {
          // The editor needs the whole XML to assign block ids; a document past
          // the runner cap cannot be edited safely through this path.
          if (error instanceof ClueError && /capture limit/i.test(error.message)) {
            const mebibytes = LARK_CLI_MAX_OUTPUT_BYTES / (1024 * 1024)
            throw new ClueError(
              'failed',
              `the document exceeds the plugin runner's ${mebibytes} MiB stdout capture limit, `
              + 'so it cannot be loaded for block-scoped editing',
            )
          }
          throw error
        }
        const parsed = parseDocEditXml(fetched.content)
        if (!parsed.complete) {
          // A parseable prefix with a malformed tail must not load as an
          // editable document: saving it would silently hide/drop the tail.
          throw new ClueError(
            'failed',
            'lark-cli returned document XML with an unparsable tail; refusing to edit a partial document',
          )
        }
        if (
          fetched.content.trim() !== ''
          && parsed.title === ''
          && parsed.blocks.length === 0
          && parsed.readOnlyBlocks.length === 0
        ) {
          throw new ClueError('failed', 'lark-cli returned document XML this editor could not parse')
        }
        const data = editDataOf(locator, doc.token, fetched)
        return {
          format: FEISHU_FORMATS.docsXml,
          data: data as unknown as JsonValue,
          ...(fetched.revisionId === undefined ? {} : { baseRevision: fetched.revisionId }),
        }
      },

      async saveEdit(input: ClueSourceSaveInput, context): Promise<ClueSaveEditResult> {
        // There is no agent write path: only the interactive editor may save.
        if (context.caller === 'agent') {
          throw new ClueError('permission-denied', 'document editing is available only to an interactive user request')
        }
        const locator = parseDocLocator(input.locator)
        const document: ClueSaveEditInput = input.document
        if (document.format !== FEISHU_FORMATS.docsXml) {
          throw new ClueError('unsupported', 'a Feishu document save must use the XML edit format')
        }
        const edited = parseDocEditData(document.data)
        if (edited === undefined) {
          throw new ClueError('invalid-request', 'the document edit payload is not a Feishu XML edit document')
        }
        const runtimeNow = runtime()
        const doc = await docArgumentOf(runtimeNow, locator, context)
        if (edited.docToken !== doc.token && edited.objToken !== doc.token) {
          throw new ClueError('invalid-request', 'the document edit payload belongs to a different document')
        }
        const titleChanged = edited.title !== edited.baselineTitle
        const changedBlocks = edited.blocks.filter(block => block.text !== block.baseline)
        if (!titleChanged && changedBlocks.length === 0) {
          const revision = document.baseRevision ?? edited.revisionId
          return {
            savedAt: new Date().toISOString(),
            ...(revision === undefined ? {} : { revision }),
          }
        }
        validateEditDocument(edited, changedBlocks, titleChanged)

        // Compare against a fresh full read AND the native revision. The CLI's
        // `--revision-id` is documented as a baseline for `docs +update`; the
        // first write uses the fresh revision and each later write uses the
        // revision the previous answer returned. A changed block is only
        // written when its tag/attrs/kind/inner text are still the loaded
        // structure — text alone is not enough (p→h2, alignment, caption and
        // checkbox `done` are structure-preserving text changes otherwise).
        let current: FetchedDocument
        try {
          current = await fetchFullDocument(runtimeNow, doc.token, context)
        } catch (error) {
          if (error instanceof ClueError && /capture limit/i.test(error.message)) {
            throw new ClueError('conflict', 'the document is now too large to re-read and compare; try again later')
          }
          throw error
        }
        const baseline = document.baseRevision ?? edited.revisionId
        if (baseline !== undefined) {
          if (current.revisionId === undefined) {
            throw new ClueError('conflict', 'the document baseline could not be confirmed; re-read it and retry')
          }
          if (current.revisionId !== baseline) {
            throw new ClueError('conflict', 'the document changed since it was loaded; re-read it and retry')
          }
        }
        requireCurrentStructure(edited, changedBlocks, titleChanged, current.content)

        interface PlannedWrite {
          readonly blockId: string
          readonly xml: string
          readonly title: boolean
        }
        const writes: PlannedWrite[] = []
        if (titleChanged) {
          writes.push({
            blockId: edited.titleBlockId!,
            xml: buildDocTitleXml(titleModelOf(current.content).attrs, edited.title),
            title: true,
          })
        }
        for (const block of changedBlocks) {
          writes.push({ blockId: block.id, xml: buildDocBlockXml(block, block.text), title: false })
        }

        const written: string[] = []
        let resultRevision = current.revisionId ?? document.baseRevision ?? edited.revisionId
        let writeRevision: string | undefined = current.revisionId
        let remainingBlocks = [...changedBlocks]
        let remainingTitle = titleChanged
        for (let index = 0; index < writes.length; index += 1) {
          const write = writes[index]!
          try {
            const success = await runFeishuCommand(runtimeNow, {
              args: [
                'docs', '+update',
                '--api-version', 'v2',
                '--doc', doc.token,
                '--command', UPDATE_BLOCK_COMMAND,
                '--block-id', write.blockId,
                // `--content -` reads the XML from stdin. XML carries quoted
                // attributes and can exceed the command-line bound; it must
                // never be spliced into argv (the Windows `.cmd` shim rejects
                // a double quote in an argument).
                '--content', '-',
                '--doc-format', 'xml',
                ...(writeRevision === undefined ? [] : ['--revision-id', writeRevision]),
                '--as', 'user',
                '--format', 'json',
              ],
              stdin: write.xml,
              cwd: cwdOf(context),
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            })
            assertUpdateResult(success)
            const next = revisionOfUpdate(success)
            if (next !== undefined) resultRevision = next
            // Only a confirmed new revision is a safe baseline for the next
            // block write; otherwise the next write omits the flag until a
            // fresh read supplies one.
            writeRevision = next
            written.push(write.blockId)
            if (write.title) remainingTitle = false
            else remainingBlocks = remainingBlocks.filter(block => block.id !== write.blockId)
            if (index < writes.length - 1) {
              // lark-cli's own update guide: a block_replace does not guarantee
              // the target id survives, so re-fetch before the next block-level
              // operation and never reuse stale ids/revision. The fresh read
              // also re-verifies that every remaining target still matches the
              // loaded baseline before it is written.
              const fresh = await fetchFullDocument(runtimeNow, doc.token, context)
              if (fresh.revisionId !== undefined) {
                resultRevision = fresh.revisionId
                writeRevision = fresh.revisionId
              }
              requireCurrentStructure(edited, remainingBlocks, remainingTitle, fresh.content)
            }
          } catch (error) {
            if (written.length === 0) {
              // A business-level partial on the very first block is still a
              // partial result, not an outright failure.
              if (error instanceof ClueError && error.meta?.partial === 'true') {
                throw partialEditError(error, written, writes.map(entry => entry.blockId))
              }
              throw error
            }
            const unwritten = writes.slice(written.length).map(entry => entry.blockId)
            throw partialEditError(error, written, unwritten)
          }
        }
        if (writeRevision === undefined) {
          // No update answer carried a revision. A final read gives the client
          // a real baseline instead of returning the stale loaded revision.
          try {
            const fresh = await fetchFullDocument(runtimeNow, doc.token, context)
            if (fresh.revisionId !== undefined) resultRevision = fresh.revisionId
          } catch {
            // Best-effort; omitting the revision is honest.
          }
        }
        return {
          savedAt: new Date().toISOString(),
          ...(resultRevision === undefined ? {} : { revision: resultRevision }),
        }
      },

      async portable(input: ClueSourceReadInput): Promise<CluePortableRef> {
        const locator = parseDocLocator(input.locator)
        if (isWikiSpaceLocator(locator)) {
          return { portable: false, reason: 'a wiki space is a browsing scope, not a shareable document' }
        }
        if (isDriveFolderLocator(locator)) {
          return { portable: false, reason: 'a Drive folder is a browsing scope, not a shareable document' }
        }
        const host = hostOf(locator.url)
        if (locator.kind === 'docx') {
          return {
            portable: true,
            locator: {
              kind: 'docx',
              docToken: locator.docToken,
              ...(locator.url === undefined ? {} : { url: locator.url }),
              ...(host === undefined ? {} : { host }),
            } as unknown as Locator,
          }
        }
        return {
          portable: true,
          locator: {
            kind: 'wiki',
            wikiToken: locator.wikiToken,
            ...(locator.objToken === undefined ? {} : { objToken: locator.objToken }),
            ...(locator.objType === undefined ? {} : { objType: locator.objType }),
            ...(locator.url === undefined ? {} : { url: locator.url }),
            ...(host === undefined ? {} : { host }),
          } as unknown as Locator,
        }
      },

      // Edits are block-scoped text replacements only. There is deliberately no
      // append/overwrite/delete/move path: those verbs are forbidden by the
      // approved spec, and complex containers are kept read-only.
    },
  }
}
