/**
 * Feishu URL/token and locator parsing (S4).
 *
 * Route by URL PATH, not by domain: a `/docx/` path is a Docx document and a
 * `/wiki/` path is a wiki NODE token. The wiki token is never used as a docx
 * token — resolving a wiki URL first asks `wiki +node-get` for the underlying
 * object. Task links are todo applinks (`/client/todo/detail` or the older
 * `/client/todo/task`), and ONLY the `guid` query parameter is a task
 * identity; the display number (`t104121` / `suite_entity_num`) is rejected
 * explicitly.
 *
 * Locators are canonical JSON objects (`kind` + stable resource identifiers +
 * an optional original URL). `locatorKey` deliberately ignores presentation
 * fields (`projection`, `url`) and unifies a resolved wiki node with its
 * underlying docx object, so the same document reached through both entries
 * reuses one stable clue.
 */
import { ClueError } from '../../types.ts'
import type { Locator } from '../../types.ts'
import {
  isRecord,
  stringOf,
  type FeishuDocLocator,
  type FeishuDocProjection,
  type FeishuDriveFolderLocator,
  type FeishuTaskLocator,
  type FeishuWikiLocator,
  type FeishuWikiSpaceLocator,
} from './format.ts'

/** A Docx URL/token recognized in free text. */
export interface ParsedDocxText {
  readonly kind: 'docx'
  readonly docToken: string
  readonly url?: string
}

/** A wiki URL/token recognized in free text (still a NODE token). */
export interface ParsedWikiText {
  readonly kind: 'wiki'
  readonly wikiToken: string
  readonly url?: string
}

/** A Drive folder URL/token recognized in free text (a browsing scope). */
export interface ParsedDriveFolderText {
  readonly kind: 'drive-folder'
  readonly folderToken: string
  readonly url?: string
}

/** One recognized document text form. */
export type ParsedDocText = ParsedDocxText | ParsedWikiText | ParsedDriveFolderText

/** One recognized task text form. */
export type ParsedTaskText =
  | { readonly kind: 'applink'; readonly guid: string; readonly url: string }
  | { readonly kind: 'display-id'; readonly value: string }

/** The display-number shape (`t104121`) that is NOT a GUID. */
const DISPLAY_TASK_ID = /^t\d+$/i

/** Token-only prefixes we can classify without fetching. */
const DOCX_TOKEN = /^(?:docx|doccn|doxcn)[A-Za-z0-9_-]{4,}$/i
const WIKI_TOKEN = /^wik[A-Za-z0-9_-]{4,}$/i
const FOLDER_TOKEN = /^fld[A-Za-z0-9_-]{4,}$/i

/** Decode one URL path segment without ever throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The segment immediately after one marker in a URL path. */
function segmentAfter(url: URL, marker: string): string | undefined {
  const parts = url.pathname.split('/').filter(part => part !== '')
  const index = parts.findIndex(part => part.toLowerCase() === marker)
  const raw = index >= 0 ? parts[index + 1] : undefined
  return raw === undefined ? undefined : decodeSegment(raw)
}

/** Parse one document URL or token from user text. */
export function parseFeishuDocText(text: string): ParsedDocText | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return undefined
    }
    const docToken = segmentAfter(url, 'docx')
    if (docToken !== undefined && docToken !== '') {
      return { kind: 'docx', docToken, url: trimmed }
    }
    const wikiToken = segmentAfter(url, 'wiki')
    if (wikiToken !== undefined && wikiToken !== '') {
      return { kind: 'wiki', wikiToken, url: trimmed }
    }
    const folderToken = segmentAfter(url, 'folder')
    if (folderToken !== undefined && folderToken !== '') {
      return { kind: 'drive-folder', folderToken, url: trimmed }
    }
    return undefined
  }
  if (DOCX_TOKEN.test(trimmed)) return { kind: 'docx', docToken: trimmed }
  if (WIKI_TOKEN.test(trimmed)) return { kind: 'wiki', wikiToken: trimmed }
  if (FOLDER_TOKEN.test(trimmed)) return { kind: 'drive-folder', folderToken: trimmed }
  return undefined
}

/** Parse one task applink from user text; display numbers are reported so an explicit call can fail loudly. */
export function parseFeishuTaskText(text: string): ParsedTaskText | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (DISPLAY_TASK_ID.test(trimmed)) return { kind: 'display-id', value: trimmed }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (!/^https?:$/i.test(url.protocol)) return undefined
  // The CLI documents the task applink as `/client/todo/detail?guid=...`
  // (`suite_entity_num` is the display number); older/share links use
  // `/client/todo/task`. Accept the whole todo applink family and require a
  // non-empty `guid`; the display number is never an identity.
  const isTodoApplink = /^\/client\/todo\//i.test(url.pathname)
  if (!isTodoApplink) return undefined
  const guid = url.searchParams.get('guid')?.trim() ?? ''
  if (guid === '') return { kind: 'display-id', value: 'applink-without-guid' }
  return { kind: 'applink', guid, url: trimmed }
}

/** The host of one URL (display/portable metadata only, never an auth bound). */
export function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** An optional non-empty projection field. */
function projectionOf(value: unknown): FeishuDocProjection | undefined {
  return value === 'xml' || value === 'markdown' ? value : undefined
}

/**
 * Parse one canonical document locator.
 * @throws {ClueError} `invalid-request` for a malformed/unsupported locator.
 */
export function parseDocLocator(value: Locator): FeishuDocLocator {
  if (!isRecord(value)) throw new ClueError('invalid-request', 'a Feishu document locator must be a JSON object')
  const kind = value.kind
  if (kind === 'docx') {
    const docToken = stringOf(value.docToken)
    if (docToken === undefined) {
      throw new ClueError('invalid-request', 'a Feishu docx locator needs a non-empty "docToken"')
    }
    const projection = projectionOf(value.projection)
    return {
      kind: 'docx',
      docToken,
      ...(stringOf(value.url) === undefined ? {} : { url: stringOf(value.url) }),
      ...(projection === undefined ? {} : { projection }),
    }
  }
  if (kind === 'wiki') {
    const wikiToken = stringOf(value.wikiToken)
    if (wikiToken === undefined) {
      throw new ClueError('invalid-request', 'a Feishu wiki locator needs a non-empty "wikiToken"')
    }
    const projection = projectionOf(value.projection)
    return {
      kind: 'wiki',
      wikiToken,
      ...(stringOf(value.objToken) === undefined ? {} : { objToken: stringOf(value.objToken) }),
      ...(stringOf(value.objType) === undefined ? {} : { objType: stringOf(value.objType) }),
      ...(stringOf(value.spaceId) === undefined ? {} : { spaceId: stringOf(value.spaceId) }),
      ...(stringOf(value.url) === undefined ? {} : { url: stringOf(value.url) }),
      ...(projection === undefined ? {} : { projection }),
    }
  }
  if (kind === 'wiki-space') {
    const spaceId = stringOf(value.spaceId)
    if (spaceId === undefined) {
      throw new ClueError('invalid-request', 'a Feishu wiki-space locator needs a non-empty "spaceId"')
    }
    return {
      kind: 'wiki-space',
      spaceId,
      ...(stringOf(value.url) === undefined ? {} : { url: stringOf(value.url) }),
    }
  }
  if (kind === 'drive-folder') {
    const folderToken = stringOf(value.folderToken)
    if (folderToken === undefined) {
      throw new ClueError('invalid-request', 'a Feishu drive-folder locator needs a non-empty "folderToken"')
    }
    return {
      kind: 'drive-folder',
      folderToken,
      ...(stringOf(value.url) === undefined ? {} : { url: stringOf(value.url) }),
    }
  }
  throw new ClueError(
    'invalid-request',
    'a locator must be a Feishu docx, wiki, wiki-space or drive-folder reference',
  )
}

/** Whether a locator denotes a wiki space (a scope picker row, not a document). */
export function isWikiSpaceLocator(locator: FeishuDocLocator): locator is FeishuWikiSpaceLocator {
  return locator.kind === 'wiki-space'
}

/** Whether a locator denotes a Drive folder (a browsing scope, not a document). */
export function isDriveFolderLocator(locator: FeishuDocLocator): locator is FeishuDriveFolderLocator {
  return locator.kind === 'drive-folder'
}

/** Canonicalize one document locator (the source owns resource identity). */
export function normalizeDocLocator(locator: Locator): Locator {
  return parseDocLocator(locator) as unknown as Locator
}

/** Stable equality key of one document locator. */
export function docLocatorKey(locator: Locator): string {
  const parsed = parseDocLocator(locator)
  if (parsed.kind === 'docx') return `docx:${parsed.docToken}`
  if (parsed.kind === 'wiki') {
    // A resolved wiki node and the docx object it wraps are the SAME resource.
    if (parsed.objType === 'docx' && parsed.objToken !== undefined) return `docx:${parsed.objToken}`
    return `wiki:${parsed.wikiToken}`
  }
  if (parsed.kind === 'drive-folder') return `drive-folder:${parsed.folderToken}`
  return `wiki-space:${parsed.spaceId}`
}

/** The projection a document read should use. */
export function docProjectionOf(locator: FeishuDocLocator): FeishuDocProjection {
  if (locator.kind === 'wiki-space' || locator.kind === 'drive-folder') return 'xml'
  return locator.projection === 'markdown' ? 'markdown' : 'xml'
}

/** A stable display title for a locator that has not been read yet. */
export function docLocatorTitle(locator: FeishuDocLocator): string {
  if (locator.kind === 'docx') return `Feishu document ${locator.docToken.slice(-8)}`
  if (locator.kind === 'drive-folder') return `Feishu folder ${locator.folderToken.slice(-8)}`
  if (locator.kind === 'wiki') {
    return locator.objType === 'docx' ? `Feishu wiki document ${locator.wikiToken.slice(-8)}` : `Feishu wiki node ${locator.wikiToken.slice(-8)}`
  }
  return `Feishu wiki space ${locator.spaceId}`
}

/**
 * Parse one canonical task locator. The display number is always rejected —
 * it can never update or read a task.
 * @throws {ClueError} `invalid-request` for a malformed locator.
 */
export function parseTaskLocator(value: Locator): FeishuTaskLocator {
  if (!isRecord(value)) throw new ClueError('invalid-request', 'a Feishu task locator must be a JSON object')
  if (value.kind !== 'task') throw new ClueError('invalid-request', 'a locator must be a Feishu task reference')
  const guid = stringOf(value.guid)
  if (guid === undefined) {
    throw new ClueError('invalid-request', 'a Feishu task locator needs a non-empty "guid"')
  }
  if (DISPLAY_TASK_ID.test(guid)) {
    throw new ClueError('invalid-request', 'the displayed task number is not a task GUID')
  }
  return {
    kind: 'task',
    guid,
    ...(stringOf(value.url) === undefined ? {} : { url: stringOf(value.url) }),
  }
}

/** Canonicalize one task locator. */
export function normalizeTaskLocator(locator: Locator): Locator {
  return parseTaskLocator(locator) as unknown as Locator
}

/** Stable equality key of one task locator. */
export function taskLocatorKey(locator: Locator): string {
  return `task:${parseTaskLocator(locator).guid}`
}

/** A wiki locator (resolved or not). */
export function isWikiLocator(locator: FeishuDocLocator): locator is FeishuWikiLocator {
  return locator.kind === 'wiki'
}
