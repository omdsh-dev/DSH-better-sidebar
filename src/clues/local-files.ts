/**
 * `builtin.files`: the local-file reference source (S1).
 *
 * It is deliberately a THIN adapter over the host's existing filesystem
 * capabilities rather than a second file backend:
 * - listing goes through `fs-tree.listDirectory` (one level, capped, cached,
 *   sorted, symlink-aware);
 * - search goes through `fs-search.searchFiles` (engines when healthy, the
 *   bounded walk otherwise);
 * - reads go through `fs-read.readText` / `readPage` (binary sniffing, editable
 *   threshold, line-aligned pages, one locked wide encoding per file);
 * - saves re-detect the file's own encoding/EOL via `fileFormatOf` and encode
 *   with `restoreEol` + `encodeText`, exactly like the editor's own save.
 *
 * Stable references (`Clue.locator`) carry a RESOLUTION ROOT, not a cwd:
 *
 * ```
 * { root: { kind: 'workspace', workspaceId }, path: '../docs/a.md', dialect: 'posix' }
 * { root: { kind: 'external' }, path: 'C:\\notes\\a.md', dialect: 'win32' }
 * ```
 *
 * A workspace-relative path resolves against the owning workspace's registered
 * directory (`context.workspacePath` from the host workspace registry), never
 * against whatever directory the current session happens to sit in. An
 * external path keeps its platform dialect and is only ever normalized with
 * that dialect's own `node:path` module, so a win32 reference is never
 * reinterpreted by the POSIX host functions (or vice versa).
 *
 * Three types, no pretense:
 * - `builtin.files.markdown` — `.md` / `.markdown`, `text/markdown`, editable;
 * - `builtin.files.text` — any other text, `text/plain`, editable;
 * - `builtin.files.binary` — read-only; a read answers an asset entry instead
 *   of pretending the bytes are a string.
 */
import { randomUUID } from 'node:crypto'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, posix, win32 } from 'node:path'
import { listDirectory, invalidateDirectoryCache } from '../fs-tree.ts'
import { searchFiles } from '../fs-search.ts'
import { readPage, readText } from '../fs-read.ts'
import { fileFormatOf, encodeText, restoreEol } from '../text-encoding.ts'
import { MAX_EDITABLE_BYTES } from '../editor-limits.ts'
import {
  BUILTIN_SOURCE_IDS,
  ClueError,
  type ClueAsset,
  type ClueCandidate,
  type ClueEditDocument,
  type ClueListResult,
  type ClueLocatorContext,
  type ClueOperationContext,
  type CluePortableRef,
  type ClueReadResult,
  type ClueSaveEditResult,
  type ClueSourceDescriptor,
  type ClueTypeDescriptor,
  type JsonObject,
  type JsonValue,
  type Locator,
} from './types.ts'
import type {
  ClueResolveInput,
  ClueSourceListInput,
  ClueSourceOperations,
  ClueSourceReadInput,
  ClueSourceRegistration,
  ClueSourceSaveInput,
  ClueSourceSearchInput,
} from './service.ts'

/** Built-in source id (`builtin.files`). */
export const LOCAL_FILE_SOURCE_ID = BUILTIN_SOURCE_IDS.files

/** The three content types the local source offers. */
export const LOCAL_FILE_TYPE_IDS = {
  markdown: 'builtin.files.markdown',
  text: 'builtin.files.text',
  binary: 'builtin.files.binary',
} as const

/** One local-file type id. */
export type LocalFileTypeId = (typeof LOCAL_FILE_TYPE_IDS)[keyof typeof LOCAL_FILE_TYPE_IDS]

/** Path dialect a locator was written in. */
export type LocalFileDialect = 'posix' | 'win32'

/** The resolution root of a local file reference. */
export type LocalFileRoot =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'external' }

/** The source-owned stable address of one local file. */
export interface LocalFileLocator {
  readonly root: LocalFileRoot
  /** Workspace-relative (workspace root) or absolute (external root) path. */
  readonly path: string
  readonly dialect: LocalFileDialect
}

/** Caller-supplied scope of one list/search (a directory). */
export type LocalFileScope =
  | string
  | { readonly path?: string; readonly locator?: Locator }
  | null
  | undefined

/** The host platform's own dialect: what a bare relative input means here. */
const HOST_DIALECT: LocalFileDialect = process.platform === 'win32' ? 'win32' : 'posix'

/** The `node:path` flavour a locator's dialect must be handled with. */
const dialectPath = (dialect: LocalFileDialect): typeof posix => (dialect === 'win32' ? win32 : posix)

/**
 * Trim trailing separators while keeping a filesystem root intact (`/`,
 * `C:\`, a UNC share root). Two spellings of the same directory/file
 * therefore normalize to ONE locator (and one stable clue), which is the
 * equality rule the source documents.
 */
function withoutTrailingSeparator(value: string, dialect: LocalFileDialect): string {
  const rootLength = dialectPath(dialect).parse(value).root.length
  let end = value.length
  while (end > rootLength && (value[end - 1] === '/' || (dialect === 'win32' && value[end - 1] === '\\'))) {
    end -= 1
  }
  return end === value.length ? value : value.slice(0, end)
}

/** Extensions rendered through the markdown type (everything else text is plain). */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

/**
 * Extensions the listing classifies as binary without sniffing. A read still
 * sniffs the actual bytes (the verdict that matters is the read's), this list
 * only keeps browsing/resolution from having to open every file.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.tif', '.tiff', '.heic', '.psd',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.mp4', '.mov', '.webm', '.mkv', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.o', '.a', '.lib',
  '.sqlite', '.sqlite3', '.db',
])

/** MIME hints for the asset entry of a binary read (optional metadata). */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  '.wasm': 'application/wasm', '.json': 'application/json',
}

/** Format of each editable type. */
const TYPE_FORMATS: Record<string, string> = {
  [LOCAL_FILE_TYPE_IDS.markdown]: 'text/markdown',
  [LOCAL_FILE_TYPE_IDS.text]: 'text/plain',
  [LOCAL_FILE_TYPE_IDS.binary]: 'application/octet-stream',
}

/** A safe page bound for a cursor walk (a huge offset cannot scan forever). */
const MAX_PAGE_OFFSET = 10_000

/** The source descriptor (stable host-side metadata; no React here). */
export function localFileSourceDescriptor(): ClueSourceDescriptor {
  return {
    sourceId: LOCAL_FILE_SOURCE_ID,
    name: 'Local files',
    icon: 'files',
    order: 0,
    pluginId: 'dsh-better-sidebar',
    types: [LOCAL_FILE_TYPE_IDS.markdown, LOCAL_FILE_TYPE_IDS.text, LOCAL_FILE_TYPE_IDS.binary],
    transport: 'files',
    capabilities: {
      resolve: true,
      list: true,
      search: true,
      read: true,
      edit: true,
      portable: true,
    },
  }
}

/** The three type descriptors the local source registers. */
export function localFileTypeDescriptors(): ClueTypeDescriptor[] {
  return [
    {
      typeId: LOCAL_FILE_TYPE_IDS.markdown,
      sourceId: LOCAL_FILE_SOURCE_ID,
      formats: ['text/markdown'],
      capabilities: { read: true, edit: true },
    },
    {
      typeId: LOCAL_FILE_TYPE_IDS.text,
      sourceId: LOCAL_FILE_SOURCE_ID,
      formats: ['text/plain'],
      capabilities: { read: true, edit: true },
    },
    {
      typeId: LOCAL_FILE_TYPE_IDS.binary,
      sourceId: LOCAL_FILE_SOURCE_ID,
      formats: ['application/octet-stream'],
      capabilities: { read: true, edit: false },
    },
  ]
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Throw the fixed cancellation category when the caller aborted. */
function throwIfAborted(context: ClueOperationContext): void {
  if (context.signal?.aborted === true) {
    throw new ClueError('cancelled', 'clue operation was cancelled')
  }
}

/** A non-empty string field of an untrusted object. */
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClueError('failed', `local file ${what} must be a non-empty string`)
  }
  return value
}

/** The dialect a raw user path is written in. */
export function dialectOfText(text: string): LocalFileDialect {
  // A drive-letter or UNC path is unambiguously Windows, wherever the host
  // runs; a rooted slash path is POSIX. A bare relative path means "the
  // platform the user is on" (the host), which is the only sensible default.
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')) return 'win32'
  // `//server/share` (forward-slash UNC) is the native Windows spelling; on
  // POSIX the same leading `//` is just a rooted path. Classify it with the
  // host it was typed on instead of rejecting the form on win32.
  if (text.startsWith('//')) return HOST_DIALECT === 'win32' ? 'win32' : 'posix'
  if (text.startsWith('/')) return 'posix'
  return HOST_DIALECT
}

/**
 * Expand a leading `~` to the host user's home directory.
 *
 * A pasted `~/notes/a.md` is an absolute host path, not a workspace-relative
 * literal: the built-in local source follows the same expansion every host fs
 * route already applies (`resolveTarget` in path-security.ts), so the same
 * text resolves to the same file through both surfaces. Only the bare `~` and
 * `~/` / `~\` spellings expand; `~user` is intentionally not a thing here.
 */
function expandHome(text: string): string {
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/** Whether `path` is absolute in `dialect` (never the host's own guess). */
export function isAbsoluteIn(dialect: LocalFileDialect, path: string): boolean {
  return dialect === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path)
}

/**
 * Normalize one path with its own dialect. Workspace-relative paths must stay
 * inside the workspace after normalization (an explicit `../` cannot climb
 * out); external paths must stay absolute.
 */
function normalizePath(path: string, dialect: LocalFileDialect, kind: 'workspace' | 'external'): string {
  const flavour = dialectPath(dialect)
  if (kind === 'external') {
    if (!flavour.isAbsolute(path)) {
      throw new ClueError('failed', 'an external local file locator needs an absolute path')
    }
    return withoutTrailingSeparator(flavour.normalize(path), dialect)
  }
  const normalized = flavour.normalize(path === '' ? '.' : path)
  const rootless = withoutTrailingSeparator(normalized === '.' ? '' : normalized, dialect)
  if (rootless === '' || rootless === '.') return ''
  if (flavour.isAbsolute(rootless) || rootless === '..' || rootless.startsWith(`..${flavour.sep}`)) {
    throw new ClueError('failed', 'a workspace-local file path must stay inside its workspace')
  }
  return rootless
}

/**
 * Parse and canonicalize an untrusted locator. The returned form is the
 * equality basis: every source operation normalizes before comparing.
 * @param locator - the raw locator.
 */
export function normalizeLocalFileLocator(locator: Locator): LocalFileLocator {
  const raw = locator as unknown
  if (!isRecord(raw) || !isRecord(raw.root)) {
    throw new ClueError('failed', 'a local file locator needs a root, a path and a dialect')
  }
  const dialect = raw.dialect === 'win32' || raw.dialect === 'posix'
    ? raw.dialect
    : (() => { throw new ClueError('failed', 'a local file locator needs a posix or win32 dialect') })()
  if (typeof raw.path !== 'string') {
    throw new ClueError('failed', 'a local file locator needs a path')
  }
  const rawPath = raw.path
  const root = raw.root
  if (root.kind === 'workspace') {
    const workspaceId = requireString(root.workspaceId, 'workspace id')
    return {
      root: { kind: 'workspace', workspaceId },
      path: normalizePath(rawPath, dialect, 'workspace'),
      dialect,
    }
  }
  if (root.kind === 'external') {
    if (rawPath === '') throw new ClueError('failed', 'an external local file locator needs a path')
    return { root: { kind: 'external' }, path: normalizePath(rawPath, dialect, 'external'), dialect }
  }
  throw new ClueError('failed', 'a local file locator root must be a workspace or external root')
}

/** Stable equality key of a normalized locator (win32 paths fold case). */
export function localFileLocatorKey(locator: LocalFileLocator): string {
  const path = locator.dialect === 'win32' ? locator.path.toLowerCase() : locator.path
  const root = locator.root.kind === 'workspace' ? `workspace:${locator.root.workspaceId}` : 'external'
  return `${root}\u0000${locator.dialect}\u0000${path}`
}

/** Build a workspace-root locator for an id + relative path. */
function workspaceLocator(workspaceId: string, path: string, dialect: LocalFileDialect = HOST_DIALECT): LocalFileLocator {
  return { root: { kind: 'workspace', workspaceId }, path, dialect }
}

/** Build an external locator for an absolute path. */
function externalLocator(path: string, dialect: LocalFileDialect = HOST_DIALECT): LocalFileLocator {
  return { root: { kind: 'external' }, path, dialect }
}

/**
 * Turn a raw scope (directory) into a locator. Absent scope = the workspace
 * root; a string is the same text a resolve accepts; an object may carry an
 * existing locator or a path.
 */
function scopeLocator(scope: JsonValue | undefined, context: ClueOperationContext): LocalFileLocator {
  if (scope === undefined || scope === null) {
    return workspaceLocator(context.workspaceId, '', HOST_DIALECT)
  }
  if (typeof scope === 'string') return locatorOfText(scope, context)
  if (isRecord(scope)) {
    if (scope.locator !== undefined) return normalizeLocalFileLocator(scope.locator as Locator)
    if (typeof scope.path === 'string') return locatorOfText(scope.path, context)
    // An empty object is the workspace root (the caller wanted the default
    // scope and spread nothing onto it).
    if (Object.keys(scope).length === 0) return workspaceLocator(context.workspaceId, '', HOST_DIALECT)
  }
  throw new ClueError('failed', 'a local file scope must be a path, a locator or an object carrying one')
}

/** Parse user text into a locator (absolute = external, relative = workspace). */
function locatorOfText(text: string, context: ClueOperationContext): LocalFileLocator {
  const trimmed = text.trim()
  if (trimmed === '') throw new ClueError('failed', 'a local file path is required')
  const expanded = expandHome(trimmed)
  const dialect = dialectOfText(expanded)
  if (isAbsoluteIn(dialect, expanded)) {
    return externalLocator(normalizePath(expanded, dialect, 'external'), dialect)
  }
  return workspaceLocator(
    context.workspaceId,
    normalizePath(expanded, dialect, 'workspace'),
    dialect,
  )
}

/**
 * Reject a workspace locator that belongs to a different workspace.
 *
 * A workspace locator stores its resolution root by `workspaceId` (see the
 * module header). Resolving it against `context.workspacePath` without this
 * check would read a file in the CALLER's workspace while the locator claims
 * another one — a copied/foreign locator would silently point at the wrong
 * file. The reference is refused instead.
 */
function requireOwnWorkspace(locator: LocalFileLocator, context: { readonly workspaceId: string }): void {
  if (locator.root.kind === 'workspace' && locator.root.workspaceId !== context.workspaceId) {
    throw new ClueError(
      'failed',
      `the local file reference belongs to workspace "${locator.root.workspaceId}", not "${context.workspaceId}"`,
    )
  }
}

/** Absolute host path of a locator, resolved against its own root. */
function absolutePathOf(locator: LocalFileLocator, context: ClueOperationContext): string {
  if (locator.dialect !== HOST_DIALECT) {
    throw new ClueError(
      'unsupported',
      `a ${locator.dialect} file reference cannot be read on a ${HOST_DIALECT} host`,
    )
  }
  if (locator.root.kind === 'external') return locator.path
  requireOwnWorkspace(locator, context)
  if (context.workspacePath === undefined || context.workspacePath === '') {
    throw new ClueError('dependency-missing', 'the workspace directory is unknown to the host registry')
  }
  return locator.path === '' ? context.workspacePath : join(context.workspacePath, locator.path)
}

/** The type a path is listed/resolved as (extension heuristic, read sniffs). */
export function localFileTypeOf(path: string, dialect: LocalFileDialect = HOST_DIALECT): LocalFileTypeId {
  const ext = dialectPath(dialect).extname(path).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(ext)) return LOCAL_FILE_TYPE_IDS.markdown
  if (BINARY_EXTENSIONS.has(ext)) return LOCAL_FILE_TYPE_IDS.binary
  return LOCAL_FILE_TYPE_IDS.text
}

/** Display title of a path in its own dialect. */
function titleOf(locator: LocalFileLocator): string {
  const name = dialectPath(locator.dialect).basename(locator.path)
  return name === '' || name === '.' ? locator.root.kind === 'workspace' ? 'Workspace' : locator.path : name
}

/** MIME hint of a path (only used to describe binary assets). */
function mimeOf(path: string): string {
  const ext = extname(path).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/** The opaque baseline a loadEdit hands back and a saveEdit compares. */
function revisionOf(info: { mtimeMs: number; size: number }): string {
  return `${info.mtimeMs}:${info.size}`
}

/** A bounded page limit from the source call (service already validates it). */
function pageLimitOf(input: { limit?: number }): number {
  const limit = input.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ClueError('failed', 'a local file page limit must be between 1 and 500')
  }
  return limit
}

/** The opaque offset a cursor carries (absent = 0). */
function cursorOffsetOf(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0
  if (!/^\d+$/.test(cursor)) throw new ClueError('failed', 'the local file cursor is not valid')
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset > MAX_PAGE_OFFSET) {
    throw new ClueError('failed', 'the local file cursor is out of range')
  }
  return offset
}

/** Build one candidate from a path under `scope`. */
function candidateOf(
  locator: LocalFileLocator,
  isDir: boolean,
  relativeTitle?: string,
): ClueCandidate {
  const typeId = isDir ? LOCAL_FILE_TYPE_IDS.binary : localFileTypeOf(locator.path, locator.dialect)
  const meta: JsonObject = isDir ? { kind: 'directory' } : { kind: 'file' }
  return {
    sourceId: LOCAL_FILE_SOURCE_ID,
    typeId,
    locator: locator as unknown as Locator,
    title: relativeTitle ?? titleOf(locator),
    ...(locator.root.kind === 'workspace' && locator.path !== '' ? { subtitle: locator.path } : {}),
    meta,
  }
}

/** Child locator: workspace-relative joins keep the scope's dialect. */
function childLocator(scope: LocalFileLocator, name: string): LocalFileLocator {
  const flavour = dialectPath(scope.dialect)
  const path = flavour.join(scope.path === '' ? '.' : scope.path, name)
  return scope.root.kind === 'workspace'
    ? workspaceLocator(scope.root.workspaceId, normalizePath(path, scope.dialect, 'workspace'), scope.dialect)
    : externalLocator(flavour.normalize(path), scope.dialect)
}

/** Whether `candidate` is `root` itself or one of its descendants. */
function isWithin(flavour: typeof posix, root: string, candidate: string): boolean {
  const relativePath = flavour.relative(root, candidate)
  return relativePath === ''
    || (!flavour.isAbsolute(relativePath)
      && relativePath !== '..'
      && !relativePath.startsWith(`..${flavour.sep}`))
}

/**
 * Map one search match onto a locator.
 *
 * Most queries answer scope-relative '/'-separated paths, but a direct-path
 * query (`./a.md`, `~/x`, an absolute path) makes `searchFiles` answer the
 * RESOLVED absolute target. An in-workspace absolute target must become the
 * SAME workspace locator `resolve('./a.md')` produces — otherwise one file
 * gets two stable clue ids (dedupe and portability break). A target outside
 * the declared scope is dropped: a search never reports resources outside
 * its own range.
 */
function searchedLocator(
  scope: LocalFileLocator,
  absoluteScope: string,
  match: string,
  context: ClueOperationContext,
): LocalFileLocator | undefined {
  const flavour = dialectPath(scope.dialect)
  if (isAbsoluteIn(scope.dialect, match)) {
    const absoluteMatch = flavour.normalize(match)
    if (!isWithin(flavour, absoluteScope, absoluteMatch)) return undefined
    if (scope.root.kind === 'external') return externalLocator(absoluteMatch, scope.dialect)
    const workspacePath = context.workspacePath
    if (workspacePath === undefined || workspacePath === '') {
      throw new ClueError('dependency-missing', 'the workspace directory is unknown to the host registry')
    }
    if (!isWithin(flavour, workspacePath, absoluteMatch)) return undefined
    return workspaceLocator(
      scope.root.workspaceId,
      normalizePath(flavour.relative(workspacePath, absoluteMatch), scope.dialect, 'workspace'),
      scope.dialect,
    )
  }
  const joined = flavour.join(scope.path === '' ? '.' : scope.path, ...match.split('/'))
  return scope.root.kind === 'workspace'
    ? workspaceLocator(scope.root.workspaceId, normalizePath(joined, scope.dialect, 'workspace'), scope.dialect)
    : externalLocator(flavour.normalize(joined), scope.dialect)
}

/** The format of one type id, refusing unknown/foreign ids loudly. */
function formatOf(typeId: string): string {
  const format = TYPE_FORMATS[typeId]
  if (format === undefined) {
    throw new ClueError('unsupported', `the local file source does not offer type "${typeId}"`)
  }
  return format
}

/** Asset entry of one binary read. */
function assetOf(absolute: string, size: number): ClueAsset {
  return { kind: 'open', path: absolute, mime: mimeOf(absolute), size }
}

/**
 * Stat the scope itself before listing/searching it. `listDirectory` and
 * `searchFiles` turn a missing/file scope into their own route errors (or, for
 * search, an empty result), which loses the clue categories: a missing
 * directory is `not-found`, a file is `unsupported`.
 */
async function requireDirectoryScope(absolute: string): Promise<void> {
  const info = await stat(absolute).catch((error: unknown) => {
    throw normalizeFileError(error, absolute)
  })
  if (!info.isDirectory()) {
    throw new ClueError('unsupported', `"${absolute}" is not a directory`)
  }
}

/**
 * The cursor of the next page, or undefined at the paging bound.
 *
 * The source must never emit a cursor it would itself reject:
 * {@link cursorOffsetOf} refuses offsets above {@link MAX_PAGE_OFFSET}, so a
 * page that crosses that bound ends the walk (`limited` stays true) instead of
 * handing the caller an unusable cursor.
 */
function nextCursorOf(offset: number, limit: number, hasMore: boolean): string | undefined {
  if (!hasMore) return undefined
  const next = offset + limit
  return next <= MAX_PAGE_OFFSET ? String(next) : undefined
}

/** List one directory page. */
async function listDirectoryPage(
  scope: LocalFileLocator,
  input: ClueSourceListInput,
  context: ClueOperationContext,
): Promise<ClueListResult> {
  throwIfAborted(context)
  const absolute = absolutePathOf(scope, context)
  await requireDirectoryScope(absolute)
  throwIfAborted(context)
  const offset = cursorOffsetOf(input.cursor)
  const limit = pageLimitOf(input)
  // One extra row proves there is a next page without trusting a total.
  const cap = Math.min(offset + limit + 1, MAX_PAGE_OFFSET + 501)
  const listing = await listDirectory(absolute, cap).catch((error: unknown) => {
    throw normalizeFileError(error, absolute)
  })
  throwIfAborted(context)
  const page = listing.entries.slice(offset, offset + limit)
  const hasMore = listing.entries.length > offset + limit
  const items = page.map(entry => candidateOf(childLocator(scope, entry.name), entry.isDir))
  const nextCursor = nextCursorOf(offset, limit, hasMore)
  return {
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    // A capped listing cannot know how many rows the level really holds.
    ...(listing.truncated ? {} : { total: listing.entries.length }),
    ...(hasMore || listing.truncated ? { limited: true } : {}),
  }
}

/** Search below one directory page. */
async function searchDirectoryPage(
  scope: LocalFileLocator,
  input: ClueSourceSearchInput,
  context: ClueOperationContext,
): Promise<ClueListResult> {
  throwIfAborted(context)
  const absolute = absolutePathOf(scope, context)
  await requireDirectoryScope(absolute)
  throwIfAborted(context)
  const query = typeof input.query === 'string' ? input.query : ''
  if (query.trim() === '') return { items: [], total: 0 }
  const offset = cursorOffsetOf(input.cursor)
  const limit = pageLimitOf(input)
  const result = await searchFiles(absolute, query, {
    maxMatches: Math.min(offset + limit + 1, MAX_PAGE_OFFSET + 501),
  }).catch((error: unknown) => {
    throw normalizeFileError(error, absolute)
  })
  throwIfAborted(context)
  const dirs = new Set(result.dirs)
  const page = result.matches.slice(offset, offset + limit)
  const items: ClueCandidate[] = []
  /** Matches dropped for being outside the declared scope (direct paths). */
  let offScope = 0
  for (const match of page) {
    const locator = searchedLocator(scope, absolute, match, context)
    if (locator === undefined) {
      offScope += 1
      continue
    }
    items.push(candidateOf(locator, dirs.has(match)))
  }
  const hasMore = result.matches.length > offset + limit
  const nextCursor = nextCursorOf(offset, limit, hasMore)
  return {
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(result.truncated ? {} : { total: result.matches.length - offScope }),
    ...(hasMore || result.truncated ? { limited: true } : {}),
  }
}

/** Normalize a filesystem failure without echoing raw transport output. */
function normalizeFileError(error: unknown, path: string): ClueError {
  if (error instanceof ClueError) return error
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') return new ClueError('not-found', `"${path}" does not exist`)
  if (code === 'EACCES' || code === 'EPERM') {
    return new ClueError('permission-denied', `"${path}" is not readable by the host user`)
  }
  if (code === 'EISDIR') return new ClueError('unsupported', `"${path}" is a directory`)
  return new ClueError('failed', `the local file operation failed for "${path}"`)
}

/** Binary read of one file (no text projection is invented). */
function binaryReadResult(
  absolute: string,
  info: { size: number; mtimeMs: number },
  fetchedAt: string,
  limited = false,
): ClueReadResult {
  return {
    format: TYPE_FORMATS[LOCAL_FILE_TYPE_IDS.binary]!,
    data: { kind: 'binary', path: absolute, size: info.size },
    revision: revisionOf(info),
    fetchedAt,
    assets: [assetOf(absolute, info.size)],
    ...(limited ? { limited: true } : {}),
  }
}

/** Read one local file, explicitly paged for large text. */
async function readFileContent(
  typeId: string,
  locator: LocalFileLocator,
  offset: number | undefined,
  context: ClueOperationContext,
): Promise<ClueReadResult> {
  throwIfAborted(context)
  const format = formatOf(typeId)
  const absolute = absolutePathOf(locator, context)
  // Stat before reading: `readText` wraps every failure in its route error,
  // which would lose the ENOENT/permission distinction the clue categories
  // need. This also gives the binary path its asset size without a second
  // open.
  const info = await stat(absolute).catch((error: unknown) => {
    throw normalizeFileError(error, absolute)
  })
  if (info.isDirectory()) throw new ClueError('unsupported', `"${absolute}" is a directory`)
  if (typeId === LOCAL_FILE_TYPE_IDS.binary) {
    return binaryReadResult(absolute, info, new Date().toISOString())
  }
  const result = await readText(absolute).catch((error: unknown) => {
    throw normalizeFileError(error, absolute)
  })
  throwIfAborted(context)
  const fetchedAt = new Date().toISOString()
  // The bytes decide binary-vs-text, never the extension that named the type:
  // a PNG renamed to `.md` still answers an asset, not mojibake.
  if (result.kind === 'binary') return binaryReadResult(absolute, result, fetchedAt)
  if (result.kind === 'too-large' || offset !== undefined) {
    const page = await readPage(absolute, offset !== undefined && offset > 0 ? offset : 0).catch((error: unknown) => {
      throw normalizeFileError(error, absolute)
    })
    throwIfAborted(context)
    return {
      format,
      data: { text: page.text },
      revision: revisionOf(page),
      fetchedAt,
      text: page.text,
      limited: !page.eof,
      ...(page.eof ? {} : { nextOffset: page.nextOffset }),
    }
  }
  return {
    format,
    data: { text: result.content },
    revision: revisionOf(result),
    fetchedAt,
    text: result.content,
    limited: false,
  }
}

/** Load one editable document (the full text + its opaque baseline). */
async function loadEditDocument(
  typeId: string,
  locator: LocalFileLocator,
  context: ClueOperationContext,
): Promise<ClueEditDocument> {
  throwIfAborted(context)
  const format = formatOf(typeId)
  if (typeId === LOCAL_FILE_TYPE_IDS.binary) {
    throw new ClueError('unsupported', 'a binary local file is read-only')
  }
  const absolute = absolutePathOf(locator, context)
  const info = await stat(absolute).catch((error: unknown) => {
    throw normalizeFileError(error, absolute)
  })
  if (info.isDirectory()) throw new ClueError('unsupported', `"${absolute}" is a directory`)
  const result = await readText(absolute).catch((error: unknown) => {
    throw normalizeFileError(error, absolute)
  })
  if (result.kind === 'binary') throw new ClueError('unsupported', 'a binary local file cannot be edited')
  if (result.kind === 'too-large') {
    throw new ClueError('unsupported', `"${absolute}" exceeds the editable size limit (${MAX_EDITABLE_BYTES} bytes)`)
  }
  return {
    format,
    // The edit document is LF-only (the client's editor has no other line
    // model); saveEdit restores the file's own EOL from disk.
    data: { text: result.content.replaceAll('\r\n', '\n') },
    baseRevision: revisionOf(result),
  }
}

/** Save one editable document after re-reading the file's current baseline. */
async function saveEditDocument(
  typeId: string,
  locator: LocalFileLocator,
  document: { format: string; data: JsonValue; baseRevision?: string },
  context: ClueOperationContext,
): Promise<ClueSaveEditResult> {
  throwIfAborted(context)
  const expectedFormat = formatOf(typeId)
  if (typeId === LOCAL_FILE_TYPE_IDS.binary) {
    throw new ClueError('unsupported', 'a binary local file is read-only')
  }
  if (document.format !== expectedFormat) {
    throw new ClueError('failed', `the edit format "${document.format}" does not match "${expectedFormat}"`)
  }
  if (!isRecord(document.data) || typeof document.data.text !== 'string') {
    throw new ClueError('failed', 'a local file edit must carry { text: string }')
  }
  const absolute = absolutePathOf(locator, context)
  // Save-before-check (not an atomic CAS): the source documents it as such.
  // Without a baseline there is nothing to compare, so the save is refused
  // rather than silently clobbering whatever is on disk.
  if (document.baseRevision === undefined || document.baseRevision === '') {
    throw new ClueError('conflict', 'the local file save carries no baseline revision')
  }
  const before = await stat(absolute).catch((error: unknown) => {
    // A baseline-bearing document whose file is GONE is an external
    // modification, exactly like the established editor save path
    // (fs-operations.ts): `conflict`, not `not-found`. `not-found` would tell
    // the UI the reference is invalid and throw the draft away.
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      throw new ClueError('conflict', `"${absolute}" no longer exists on disk`)
    }
    throw normalizeFileError(error, absolute)
  })
  if (before.isDirectory()) throw new ClueError('unsupported', `"${absolute}" is a directory`)
  if (document.baseRevision !== revisionOf(before)) {
    throw new ClueError('conflict', `"${absolute}" changed on disk since it was loaded`)
  }
  throwIfAborted(context)
  // Re-detect encoding + EOL from the DISK before writing: the editor only
  // ever sends LF, and a GBK/UTF-16/CRLF file must keep its own format.
  const { encoding, eol } = await fileFormatOf(absolute)
  const tmp = join(dirname(absolute), `.${basename(absolute)}.dsh-clues-tmp-${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, encodeText(restoreEol(document.data.text, eol), encoding), { flag: 'wx' })
    await rename(tmp, absolute)
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw new ClueError('failed', `the local file could not be written: "${absolute}"`)
  }
  invalidateDirectoryCache(dirname(absolute))
  const after = await stat(absolute).catch(() => undefined)
  return {
    ...(after === undefined ? {} : { revision: revisionOf(after) }),
    savedAt: new Date().toISOString(),
  }
}

/** Portable locator: workspace-relative only; absolute paths have no share form. */
function portableOf(locator: LocalFileLocator): CluePortableRef {
  if (locator.root.kind === 'external') {
    return { portable: false, reason: 'an absolute path outside a workspace has no portable reference' }
  }
  return { portable: true, locator: locator as unknown as Locator }
}

/**
 * Create the `builtin.files` source registration. The returned object is what
 * `CluesService.registerSource` takes; installing it is the caller's job.
 */
export function createLocalFileSource(): ClueSourceRegistration {
  const operations: ClueSourceOperations = {
    async resolve(input: ClueResolveInput, context: ClueOperationContext): Promise<ClueCandidate | undefined> {
      throwIfAborted(context)
      let locator: LocalFileLocator
      if (input.locator !== undefined) {
        locator = normalizeLocalFileLocator(input.locator)
      } else if (input.text !== undefined) {
        locator = locatorOfText(input.text, context)
      } else {
        return undefined
      }
      const typeId = input.typeId ?? localFileTypeOf(locator.path, locator.dialect)
      formatOf(typeId)
      const absolute = absolutePathOf(locator, context)
      // resolve is a READ-side gesture (the caller pastes a path): verify the
      // resource exists so a typo is not pinned as a stable reference.
      const info = await stat(absolute).catch((error: unknown) => {
        throw normalizeFileError(error, absolute)
      })
      throwIfAborted(context)
      if (info.isDirectory()) return candidateOf(locator, true)
      return {
        sourceId: LOCAL_FILE_SOURCE_ID,
        typeId,
        locator: locator as unknown as Locator,
        title: titleOf(locator),
        ...(locator.root.kind === 'workspace' && locator.path !== '' ? { subtitle: locator.path } : {}),
        meta: { kind: 'file', size: info.size },
      }
    },

    async list(input: ClueSourceListInput, context: ClueOperationContext): Promise<ClueListResult> {
      return listDirectoryPage(scopeLocator(input.scope, context), input, context)
    },

    async search(input: ClueSourceSearchInput, context: ClueOperationContext): Promise<ClueListResult> {
      return searchDirectoryPage(scopeLocator(input.scope, context), input, context)
    },

    async read(input: ClueSourceReadInput, context: ClueOperationContext): Promise<ClueReadResult> {
      return readFileContent(input.typeId, normalizeLocalFileLocator(input.locator), input.offset, context)
    },

    async loadEdit(input: ClueSourceReadInput, context: ClueOperationContext): Promise<ClueEditDocument> {
      return loadEditDocument(input.typeId, normalizeLocalFileLocator(input.locator), context)
    },

    async saveEdit(input: ClueSourceSaveInput, context: ClueOperationContext): Promise<ClueSaveEditResult> {
      return saveEditDocument(
        input.typeId,
        normalizeLocalFileLocator(input.locator),
        input.document,
        context,
      )
    },

    async portable(input: ClueSourceReadInput, context: ClueOperationContext): Promise<CluePortableRef> {
      throwIfAborted(context)
      const locator = normalizeLocalFileLocator(input.locator)
      requireOwnWorkspace(locator, context)
      return portableOf(locator)
    },

    normalizeLocator(locator: Locator, context: ClueLocatorContext): Locator {
      const normalized = normalizeLocalFileLocator(locator)
      // The registry normalizes a locator against the operation's workspace
      // before it becomes a stable reference: a foreign workspace root can
      // never be stored as if it addressed this workspace.
      requireOwnWorkspace(normalized, context)
      return normalized as unknown as Locator
    },

    locatorKey(locator: Locator): string {
      return localFileLocatorKey(normalizeLocalFileLocator(locator))
    },
  }
  return {
    descriptor: localFileSourceDescriptor(),
    types: localFileTypeDescriptors(),
    operations,
  }
}
