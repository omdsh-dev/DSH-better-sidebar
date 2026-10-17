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
 * Reads fetch the whole document with `docs +fetch --api-version v2` and
 * window it by byte offset; the plugin runner's stdout capture is capped at
 * 8 MiB, so a document above that cap is reported explicitly instead of being
 * silently truncated. Block-scoped partial fetch needs block ids, which the S4
 * read contract does not carry, so fragment reads necessarily re-fetch the
 * document.
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
import { buildDocBlockXml, buildDocTitleXml, parseDocEditXml } from './edit.ts'
import {
  arrayField,
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

/** The next provider cursor, or a `limited` marker when the provider truncated but gave no token. */
function pageOf(
  success: LarkSuccess,
  signature: string,
): { readonly nextCursor?: string; readonly limited?: boolean } {
  const hasMore = success.data.has_more === true
  const token = stringField(success.data, 'next_page_token') ?? stringField(success.data, 'page_token')
  if (token !== undefined && token !== '') return { nextCursor: encodeCursor(signature, token) }
  return hasMore ? { limited: true } : {}
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
  const name = stringOf(space.name) ?? `Feishu wiki space ${spaceId}`
  return {
    sourceId: FEISHU_SOURCE_IDS.docs,
    typeId: FEISHU_TYPE_IDS.wiki,
    locator: { kind: 'wiki-space', spaceId } as unknown as Locator,
    title: name,
    subtitle: 'Wiki space',
    meta: {
      role: FEISHU_SCOPE_ROLE,
      spaceType: stringOf(space.space_type) ?? 'team',
      visibility: stringOf(space.visibility) ?? 'unknown',
    },
  }
}

/** Map one search row to a supported document candidate. */
function searchCandidate(row: Record<string, JsonValue>): ClueCandidate | undefined {
  const rawType = (stringOf(row.doc_type) ?? stringOf(row.type) ?? '').toLowerCase()
  const token = stringOf(row.token) ?? stringOf(row.obj_token)
  if (token === undefined) return undefined
  const title = stripHighlight(stringOf(row.title) ?? stringOf(row.title_highlighted) ?? fallbackTitle(token))
  const url = stringOf(row.url)
  const editTime = row.edit_time === undefined ? undefined : String(row.edit_time)
  const docType = rawType === 'docx' ? 'docx' : rawType === 'wiki' ? 'wiki' : undefined
  if (docType === undefined) return undefined
  if (docType === 'docx') {
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

/** Extract the `<title>` of a Docx XML projection. */
function titleOfContent(content: string): string | undefined {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(content)
  if (match === null) return undefined
  const title = match[1]!
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
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

/** UTF-8-safe fragment of one document content. */
function fragmentOf(content: string, offset: number): {
  readonly text: string
  readonly limited: boolean
  readonly nextOffset?: number
} {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ClueError('invalid-request', 'the document byte offset must be a non-negative integer')
  }
  const bytes = new TextEncoder().encode(content)
  if (offset > bytes.length) {
    throw new ClueError('invalid-request', 'the document byte offset is past the end of the content')
  }
  let end = Math.min(offset + DOC_READ_MAX_BYTES, bytes.length)
  // Never split a UTF-8 code point: move the page boundary back to its start.
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1
  if (end === offset && end < bytes.length) end = Math.min(offset + DOC_READ_MAX_BYTES, bytes.length)
  const limited = end < bytes.length
  return {
    text: new TextDecoder().decode(bytes.subarray(offset, end)),
    limited,
    ...(limited ? { nextOffset: end } : {}),
  }
}

/** The server-side document payload of one `docs +fetch` answer. */
interface FetchedDocument {
  readonly content: string
  readonly title?: string
  readonly revisionId?: string
  readonly referenceMap?: JsonValue
}

/** Parse one `docs +fetch` success payload. */
function fetchedDocumentOf(success: LarkSuccess): FetchedDocument {
  const document = recordField(success.data, 'document')
  if (document === undefined) {
    throw new ClueError('failed', 'lark-cli returned no document content')
  }
  const content = stringField(document, 'content')
  if (content === undefined) {
    throw new ClueError('failed', 'lark-cli returned no document content')
  }
  const title = stringField(document, 'title')
  // `document.title` is tolerated when present, but the documented
  // `docs +fetch` payload has no title field; the XML `<title>` (or the
  // resolved wiki node) is the authoritative source.
  const revision = document.revision_id
  const referenceMap = document.reference_map
  return {
    content,
    ...(title === undefined ? {} : { title }),
    ...(revision === undefined ? {} : { revisionId: String(revision) }),
    ...(referenceMap === undefined ? {} : { referenceMap }),
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
    titleEditable: parsed.titleBlockId !== undefined,
    ...(parsed.titleBlockId === undefined ? {} : { titleBlockId: parsed.titleBlockId }),
    titleAttrs: parsed.titleAttrs,
    blocks: parsed.blocks,
    readOnlyBlocks: parsed.readOnlyBlocks,
  }
}

/** The current block texts by id (save-time best-effort comparison). */
function blockTextsOf(content: string): Map<string, string> {
  const parsed = parseDocEditXml(content)
  const map = new Map<string, string>()
  for (const block of parsed.blocks) map.set(block.id, block.text)
  return map
}

/** The current XML title (save-time best-effort comparison). */
function titleOfEditContent(content: string): string {
  return parseDocEditXml(content).title
}

/** The native revision id of one block update answer. */
function revisionOfUpdate(success: LarkSuccess): string | undefined {
  const document = recordField(success.data, 'document')
  const revision = document?.revision_id
  return revision === undefined ? undefined : String(revision)
}

/** Fail a write whose business result is not a full success. */
function assertUpdateResult(success: LarkSuccess): void {
  const result = stringField(success.data, 'result')
  if (result === 'failed') {
    throw new ClueError('failed', 'lark-cli reported the document update as failed')
  }
  if (result === 'partial_success') {
    throw new ClueError('failed', 'lark-cli reported the document update as a partial success')
  }
}

/** The safe partial-success error after at least one block was written. */
function partialEditError(error: unknown, written: readonly string[], unwritten: readonly string[]): ClueError {
  const base = error instanceof ClueError
    ? error
    : new ClueError('failed', 'the document block update failed')
  return new ClueError(
    base.category,
    `partial success: ${written.length} block(s) were saved, but the remaining block(s) `
    + `were not written (${base.message}); the draft is preserved`,
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
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(block.id)) {
      throw new ClueError('invalid-request', 'a document block id is not a safe identifier')
    }
    if (seen.has(block.id)) {
      throw new ClueError('invalid-request', 'a document save repeats one block id')
    }
    seen.add(block.id)
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
  }
  if (total > MAX_EDIT_TOTAL_BYTES) {
    throw new ClueError(
      'invalid-request',
      `the document edit is too large to save (limit ${MAX_EDIT_TOTAL_BYTES} bytes)`,
    )
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

      async resolve(input: { readonly text?: string; readonly locator?: Locator }, context: ClueOperationContext) {
        const locator = input.locator === undefined ? undefined : parseDocLocator(input.locator)
        if (locator !== undefined) {
          if (isWikiSpaceLocator(locator)) return undefined
          if (isDriveFolderLocator(locator)) {
            return driveFolderScopeCandidate(
              locator.folderToken,
              docLocatorTitle(locator),
              locator.url,
            )
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
          const params: Record<string, JsonValue> = {
            folder_token: scope.kind === 'drive' ? scope.folderToken : '',
            page_size: limit,
            ...(pageToken === undefined ? {} : { page_token: pageToken }),
          }
          const success = await runFeishuCommand(runtime(), {
            args: ['drive', 'files', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
            cwd,
            ...signal,
          })
          const files = arrayField(success.data, 'files') ?? []
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
          const spaces = arrayField(success.data, 'spaces') ?? []
          const items: ClueCandidate[] = []
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
        const nodes = arrayField(success.data, 'nodes') ?? []
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
                : ['--space-ids', scope.spaceId]),
            '--page-size', String(limit),
            ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
            '--as', 'user', '--format', 'json',
          ],
          cwd: cwdOf(context),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        const rows = arrayField(success.data, 'results') ?? []
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
              + 'cannot be read in one fragment; the S4 read contract has no block-scoped fragment '
              + 'request, so no partial read is claimed',
            )
          }
          throw error
        }
        const fetched = fetchedDocumentOf(success)
        const fragment = fragmentOf(fetched.content, input.offset ?? 0)
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
          ...(fetched.referenceMap === undefined ? {} : { referenceMap: fetched.referenceMap }),
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

        // Best-effort comparison against a fresh full read. The CLI's
        // `--revision-id` cannot be used for a SEQUENCE of block writes (the
        // first write advances the revision), so compare the changed blocks
        // themselves and only write when their baselines are still current.
        let current: FetchedDocument
        try {
          current = await fetchFullDocument(runtimeNow, doc.token, context)
        } catch (error) {
          if (error instanceof ClueError && /capture limit/i.test(error.message)) {
            throw new ClueError('conflict', 'the document is now too large to re-read and compare; try again later')
          }
          throw error
        }
        const currentBlocks = blockTextsOf(current.content)
        for (const block of changedBlocks) {
          const currentText = currentBlocks.get(block.id)
          if (currentText === undefined || currentText !== block.baseline) {
            throw new ClueError('conflict', 'the document changed since it was loaded; re-read it and retry')
          }
        }
        if (titleChanged && titleOfEditContent(current.content) !== edited.baselineTitle) {
          throw new ClueError('conflict', 'the document title changed since it was loaded; re-read it and retry')
        }

        const writes: Array<{ readonly blockId: string; readonly xml: string }> = []
        if (titleChanged) {
          writes.push({
            blockId: edited.titleBlockId!,
            xml: buildDocTitleXml(edited.titleAttrs, edited.title),
          })
        }
        for (const block of changedBlocks) {
          writes.push({ blockId: block.id, xml: buildDocBlockXml(block, block.text) })
        }

        const written: string[] = []
        let revision = current.revisionId ?? document.baseRevision ?? edited.revisionId
        for (const write of writes) {
          try {
            const success = await runFeishuCommand(runtimeNow, {
              args: [
                'docs', '+update',
                '--api-version', 'v2',
                '--doc', doc.token,
                '--command', UPDATE_BLOCK_COMMAND,
                '--block-id', write.blockId,
                '--content', write.xml,
                '--doc-format', 'xml',
                '--as', 'user',
                '--format', 'json',
              ],
              cwd: cwdOf(context),
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            })
            assertUpdateResult(success)
            revision = revisionOfUpdate(success) ?? revision
            written.push(write.blockId)
          } catch (error) {
            if (written.length === 0) throw error
            const unwritten = writes.slice(written.length).map(entry => entry.blockId)
            throw partialEditError(error, written, unwritten)
          }
        }
        return {
          savedAt: new Date().toISOString(),
          ...(revision === undefined ? {} : { revision }),
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
