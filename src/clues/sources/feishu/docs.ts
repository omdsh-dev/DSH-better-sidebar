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
 * - cursors are bound to the exact range/query that produced them; a stale
 *   cursor from another range is refused instead of silently mixing pages;
 * - `total` is never invented (Drive list/search expose no reliable total), and
 *   an unpaginatable root page or search index coverage is reported via
 *   `limited`;
 * - a wiki node is a separate identity: `/wiki/<token>` is resolved through
 *   `wiki +node-get`, and only `obj_type=docx` becomes a readable document.
 *
 * Edit is intentionally not offered: lark-cli documents no lossless local
 * text-block write (only global `str_replace`, whole-block replace/delete/move,
 * and append/overwrite), so this source is read-only instead of degrading to a
 * destructive write path. See {@link DOCS_EDIT_LIMITATION}.
 */
import { ClueError } from '../../types.ts'
import type {
  ClueCandidate,
  ClueListResult,
  ClueOperationContext,
  CluePortableRef,
  ClueReadResult,
  ClueTypeDescriptor,
  JsonValue,
  Locator,
} from '../../types.ts'
import type {
  ClueSourceListInput,
  ClueSourceReadInput,
  ClueSourceRegistration,
  ClueSourceSearchInput,
} from '../../service.ts'
import type { ClueRuntime } from '../../runtime/types.ts'
import { decodeCursor, encodeCursor, stableJson } from './cursor.ts'
import {
  DOCS_EDIT_LIMITATION,
  FEISHU_CONNECTION_ID,
  FEISHU_DEPENDENCY_ID,
  FEISHU_FORMATS,
  FEISHU_PLUGIN_ID,
  FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS,
  fallbackTitle,
  isRecord,
  stripHighlight,
  stringOf,
  type FeishuDocLocator,
  type FeishuDocProjection,
  type FeishuDocReadData,
} from './format.ts'
import {
  arrayField,
  larkWorkingDirectory,
  recordField,
  runLark,
  stringField,
  type LarkSuccess,
} from './lark.ts'
import {
  docLocatorKey,
  docProjectionOf,
  docLocatorTitle,
  hostOf,
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

/** The explicit browsing ranges of the docs source. */
type DocsListScope =
  | { readonly kind: 'drive'; readonly folderToken: string }
  | { readonly kind: 'drive-root' }
  | { readonly kind: 'wiki'; readonly spaceId: string; readonly parentNodeToken?: string }
  | { readonly kind: 'wiki-spaces' }

/** The range filter a document search may carry. */
type DocsSearchScope =
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
function parseListScope(value: JsonValue | undefined): DocsListScope {
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
function parseSearchScope(value: JsonValue | undefined): DocsSearchScope | undefined {
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
      role: 'scope',
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
  const success = await runLark({
    runtime,
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
    throw new ClueError(
      'unsupported',
      `the wiki node wraps a ${objType ?? 'non-document'} object; only Docx documents are supported`,
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
  const revision = document.revision_id
  const referenceMap = document.reference_map
  return {
    content,
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
  if (locator.objType !== undefined && locator.objType !== 'docx') {
    throw new ClueError(
      'unsupported',
      `the wiki node wraps a ${locator.objType} object; only Docx documents are supported`,
    )
  }
  if (locator.objToken !== undefined) return { token: locator.objToken }
  const resolved = await resolveWikiNode(runtime, locator.wikiToken, locator.url, context)
  return { token: resolved.objToken, title: resolved.title }
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
      // No lossless local text-block write exists in lark-cli.
      edit: false,
      portable: true,
    },
    dependencyIds: [FEISHU_DEPENDENCY_ID],
    connectionId: FEISHU_CONNECTION_ID,
  }
}

/** Type descriptors; both document types share XML/Markdown read formats. */
function docsTypes(): ClueTypeDescriptor[] {
  const reason = { editLimitation: DOCS_EDIT_LIMITATION }
  return [FEISHU_TYPE_IDS.docx, FEISHU_TYPE_IDS.wiki].map(typeId => ({
    typeId,
    sourceId: FEISHU_SOURCE_IDS.docs,
    formats: [FEISHU_FORMATS.docsXml, FEISHU_FORMATS.docsMarkdown],
    capabilities: { read: true, edit: false, concurrency: 'none' },
    extensions: reason,
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
        const scope = parseListScope(input.scope)
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
          const success = await runLark({
            runtime: runtime(),
            args: ['drive', 'files', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
            cwd,
            ...signal,
          })
          const files = arrayField(success.data, 'files') ?? []
          const items: ClueCandidate[] = []
          for (const file of files) {
            if (!isRecord(file)) continue
            const candidate = driveDocCandidate(file)
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
          const success = await runLark({
            runtime: runtime(),
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
        const success = await runLark({
          runtime: runtime(),
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
        const scope = parseSearchScope(input.scope)
        if (query === '' && scope === undefined) {
          throw new ClueError('invalid-request', 'a Feishu document search needs a keyword or an explicit range')
        }
        const signature = stableJson({
          query,
          ...(scope === undefined ? {} : { scope }),
        } as unknown as JsonValue)
        const pageToken = pageTokenOf(signature, input.cursor)
        const limit = pageLimitOf(input.limit, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE)
        const success = await runLark({
          runtime: runtime(),
          args: [
            'drive', '+search', '--query', query,
            '--doc-types', 'docx,wiki,doc',
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
        const success = await runLark({
          runtime: runtimeNow,
          args: [
            'docs', '+fetch', '--doc', doc.token,
            '--doc-format', projection,
            '--detail', 'simple',
            '--as', 'user', '--format', 'json',
          ],
          cwd: cwdOf(context),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        const fetched = fetchedDocumentOf(success)
        const fragment = fragmentOf(fetched.content, input.offset ?? 0)
        const title = titleOfContent(fetched.content) ?? doc.title ?? docLocatorTitle(locator)
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

      async portable(input: ClueSourceReadInput): Promise<CluePortableRef> {
        const locator = parseDocLocator(input.locator)
        if (isWikiSpaceLocator(locator)) {
          return { portable: false, reason: 'a wiki space is a browsing scope, not a shareable document' }
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

      // Deliberately absent: loadEdit / saveEdit. The docs source is read-only
      // because no documented lark-cli verb performs a lossless local text-block
      // update; append/overwrite/delete/move are forbidden by the approved spec.
      // A caller asking to edit gets S1's `unsupported`, never a degraded write.
    },
  }
}
