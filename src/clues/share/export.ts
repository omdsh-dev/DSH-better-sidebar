/**
 * S7 export: turn a local pack/clue selection into a `.cluepack` archive.
 *
 * Two modes, deliberately asymmetric:
 * - **references** — carries the pack relationships, titles, source
 *   attribution and credential-free portable locators. It NEVER calls a
 *   source's `read`, so no body, cache or secret can leak into the archive.
 * - **snapshot** — additionally calls `read` per clue, records a real
 *   `fetchedAt`, the source's revision (when reported), byte size and SHA-256,
 *   and stores the payload under `content/`. A local-file read that exposes a
 *   download asset stores the ORIGINAL bytes; a structured read stores the
 *   source-declared `format` + `data` (+ text projection) as JSON — never a
 *   Markdown rewrite.
 *
 * Failure policy: one failed item never silently becomes a "complete" pack.
 * The item is listed in `issues` with its fixed clue category, the manifest
 * records it, the archive is still produced (so the user can accept the
 * partial export explicitly), and the result reports `complete: false`.
 * Cancellation and any limit overflow throw before any bytes are returned.
 *
 * Sharing scope (spec §3): {@link previewExport} is local-only, and
 * {@link inspectExport} is the explicit consent step that resolves the exact
 * portable references (never content) so a private URL/resource id is visible
 * before the user confirms.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { stableLocatorKey, type CluesService } from '../service.ts'
import {
  BUILTIN_SOURCE_IDS,
  ClueError,
  isClueError,
  type Clue,
  type ClueErrorCategory,
  type CluePack,
  type CluePortableRef,
  type ClueReadResult,
  type ClueSnapshotMeta,
  type ClueSnapshotRecord,
  type JsonValue,
  type Locator,
} from '../types.ts'
import {
  CLUEPACK_EXTENSION,
  CLUEPACK_FORMAT,
  CLUEPACK_FORMAT_VERSION,
  CLUEPACK_MANIFEST_PATH,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_CLUES,
  MAX_MANIFEST_ISSUES,
  MAX_MANIFEST_PACKS,
  serializeCluepackManifest,
  type CluepackClue,
  type CluepackIssue,
  type CluepackManifest,
  type CluepackMode,
  type CluepackPack,
  type CluepackSnapshot,
  type CluepackSource,
} from './manifest.ts'
import {
  SAFE_EXTERNAL_PATH_REASON,
  SAFE_FAILURE_REASONS,
  SAFE_PORTABLE_REFUSED_REASON,
  SAFE_UNRESOLVED_REASON,
  safeFailureOf,
  safeStoredReason,
} from './reasons.ts'
import { createZip, DEFAULT_ZIP_LIMITS, type ZipEntryInput } from './zip.ts'

/**
 * Default upper bound of one snapshot payload (JSON or raw bytes). It is the
 * reader's per-entry bound, so any content the exporter accepts is content the
 * importer accepts.
 */
export const DEFAULT_MAX_SNAPSHOT_BYTES = DEFAULT_ZIP_LIMITS.maxEntryBytes
/** Default upper bound of the finished archive (the import route's own cap). */
export const DEFAULT_MAX_ARCHIVE_BYTES = DEFAULT_ZIP_LIMITS.maxArchiveBytes
/** Default upper bound of one export's archive entries (S1's largest pack + manifest). */
export const DEFAULT_MAX_ENTRIES = DEFAULT_ZIP_LIMITS.maxEntries
/** Default upper bound of all expanded content together. */
export const DEFAULT_MAX_TOTAL_BYTES = DEFAULT_ZIP_LIMITS.maxTotalBytes
/** Default upper bound of the serialized manifest document. */
export const DEFAULT_MAX_MANIFEST_BYTES = MAX_MANIFEST_BYTES
/** Code-point bound of a pack name used in a download file name. */
const MAX_FILE_STEM = 100

/** Everything the exporter needs from the host (tests inject the seams). */
export interface ClueShareExportDeps {
  readonly clues: CluesService
  /** Clock injection (tests); defaults to `new Date().toISOString()`. */
  readonly now?: () => string
  /** Maximum size of one snapshot payload. */
  readonly maxSnapshotBytes?: number
  /** Maximum size of the finished archive (defaults to the import route cap). */
  readonly maxArchiveBytes?: number
  /** Maximum number of archive entries. */
  readonly maxEntries?: number
  /** Maximum expanded size of all content together. */
  readonly maxTotalBytes?: number
  /** Maximum size of the serialized manifest. */
  readonly maxManifestBytes?: number
  /** Raw-byte reader for an asset path (tests). */
  readonly readFileBytes?: (path: string) => Promise<Uint8Array>
  /** Size + regular-file probe of an asset path (tests). */
  readonly statFile?: (path: string) => Promise<{ readonly size: number; readonly isFile: boolean }>
}

/** Caller input of one export/preview. */
export interface ClueShareExportParams {
  readonly workspaceId: string
  readonly mode: CluepackMode
  /** Packs whose members are exported (union, order preserved). */
  readonly packIds?: readonly string[]
  /** Extra clue ids appended after the pack members. */
  readonly clueIds?: readonly string[]
  /** Cancels the operation; no archive is returned once aborted. */
  readonly signal?: AbortSignal
  /** Per-item progress (UI feedback for snapshot reads). */
  readonly onProgress?: (progress: ClueShareExportProgress) => void
}

/** One progress notification of an export. */
export interface ClueShareExportProgress {
  readonly phase: 'collect' | 'read' | 'content' | 'archive' | 'done'
  readonly completed: number
  readonly total: number
  readonly key?: string
  readonly status?: 'ok' | 'issue'
  readonly reason?: string
}

/** One clue as the export confirmation screen shows it (no source access). */
export interface ClueShareExportItemPreview {
  readonly clueId: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  /** Present when the row is already unresolved locally. */
  readonly unresolved?: string
  /** Snapshot mode says content will be fetched on confirm. */
  readonly snapshotMode: boolean
}

/** Result of `previewExport` (pure local metadata). */
export interface ClueShareExportPreview {
  readonly mode: CluepackMode
  readonly fileName: string
  readonly items: readonly ClueShareExportItemPreview[]
  readonly packs: readonly { readonly packId: string; readonly name: string; readonly members: number }[]
  readonly warnings: readonly string[]
  readonly totals: {
    readonly clues: number
    readonly packs: number
    readonly sources: number
  }
}

/** Result of `exportPack`. */
export interface ClueShareExportResult {
  /** Suggested download name (`<stem>-<yyyymmdd>.cluepack`). */
  readonly fileName: string
  /** The complete archive bytes (only returned on success). */
  readonly bytes: Buffer
  readonly manifest: CluepackManifest
  readonly mode: CluepackMode
  /** False when at least one item could not be exported; see `issues`. */
  readonly complete: boolean
  readonly issues: readonly CluepackIssue[]
  readonly stats: {
    readonly clues: number
    readonly packs: number
    readonly sources: number
    readonly snapshots: number
    readonly bytes: number
  }
}

/**
 * One clue as the share-confirmation screen shows it: the EXACT portable
 * reference the archive would carry.
 *
 * Spec §3: "私有资源的 URL／标题本身也可能敏感；导出确认面展示将携带的资源信息,
 * 让用户决定分享范围。" The zero-source-call {@link previewExport} cannot know
 * the source-provided locator, so the UI calls {@link inspectExport} — an
 * explicitly user-triggered, content-free resolution step — before the final
 * confirmation. It never calls `read`.
 */
export interface ClueShareExportSharedItem {
  readonly clueId: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  /** Exactly what the manifest will carry (or why no address can be shared). */
  readonly portable: CluePortableRef
  /** The local unresolved reason, when the row is already unresolved. */
  readonly unresolved?: string
  /** Snapshot mode says content will be fetched after the user confirms. */
  readonly snapshotMode: boolean
}

/** Result of `inspectExport` (portable references only; no content). */
export interface ClueShareExportInspection {
  readonly mode: CluepackMode
  readonly fileName: string
  readonly items: readonly ClueShareExportSharedItem[]
  readonly sources: readonly CluepackSource[]
  readonly warnings: readonly string[]
}

/** One selected pack plus its package-local key. */
interface SelectedPack {
  readonly pack: CluePack
  readonly key: string
  readonly clueIds: readonly string[]
}

/** Internal selection result shared by preview and export. */
interface Selection {
  readonly packs: readonly SelectedPack[]
  readonly clues: readonly Clue[]
  readonly issues: readonly CluepackIssue[]
}

/** Refuse a malformed caller payload before touching the library. */
function requireParams(params: ClueShareExportParams): { workspaceId: string; mode: CluepackMode } {
  if (typeof params.workspaceId !== 'string' || params.workspaceId.trim() === '') {
    throw new ClueError('invalid-request', 'a non-empty workspace id is required')
  }
  if (params.mode !== 'references' && params.mode !== 'snapshot') {
    throw new ClueError('invalid-request', 'the cluepack mode must be "references" or "snapshot"')
  }
  for (const [field, value] of [['packIds', params.packIds], ['clueIds', params.clueIds]] as const) {
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id.trim() === '')) {
      throw new ClueError('invalid-request', `"${field}" must be an array of non-empty ids`)
    }
  }
  return { workspaceId: params.workspaceId, mode: params.mode }
}

/** Throw the fixed cancellation category when the caller aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ClueError('cancelled', 'the clue pack export was cancelled')
  }
}

/** Whether a value is a plain JSON object (locator shape). */
function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Copy a source-provided portable reference down to the contract fields.
 *
 * A `portable:false` reference may still carry a credential-free locator as an
 * explicitly marked HINT (spec §3: an external absolute path is shared as a
 * labelled source clue and only remapped by an explicit receiver choice). The
 * hint is preserved, but `portable` stays false so no importer treats it as an
 * automatically usable address.
 */
function portableRefOf(
  ref: CluePortableRef | undefined,
  fallbackReason: string,
  origin: 'source' | 'stored' = 'source',
): CluePortableRef {
  if (ref === undefined) return { portable: false, reason: fallbackReason }
  if (ref.portable && isRecord(ref.locator)) {
    // A portable reference needs no explanation, and a SOURCE-provided reason
    // is untrusted text: never copy it into the shared manifest.
    return { portable: true, locator: ref.locator as Locator }
  }
  // A stored reason is only trusted when it is one of this layer's own fixed
  // catalogue entries (an older build or a hand-seeded row may carry a raw
  // message with a token/path in it).
  const storedReason = origin === 'stored' ? safeStoredReason(ref.reason, fallbackReason) : fallbackReason
  return {
    portable: false,
    ...(isRecord(ref.locator) ? { locator: ref.locator as Locator } : {}),
    reason: ref.portable ? SAFE_PORTABLE_REFUSED_REASON : storedReason,
  }
}

/**
 * Preserve the sender's local external path as an explicitly non-portable
 * hint.
 *
 * S1's local-file source declines to make an external absolute path portable
 * (correctly: it must never be opened on the receiver's machine), and its
 * `portable` answer carries no locator at all. Without this hint the receiver
 * could not even SEE which path the sender shared, so it could never choose an
 * explicit remap. Only the built-in file source gets this fallback: a
 * third-party source's refusal to expose its locator is authoritative and is
 * never overridden here.
 */
function externalPathHintOf(clue: Clue, portable: CluePortableRef): CluePortableRef {
  if (portable.portable || portable.locator !== undefined) return portable
  if (clue.sourceId !== BUILTIN_SOURCE_IDS.files) return portable
  const root = isRecord(clue.locator.root) ? clue.locator.root : undefined
  if (root?.kind !== 'external') return portable
  return {
    portable: false,
    locator: clue.locator,
    reason: portable.reason ?? SAFE_EXTERNAL_PATH_REASON,
  }
}

/** Select packs/clues from the local library without touching a source. */
async function collectSelection(
  deps: ClueShareExportDeps,
  params: ClueShareExportParams,
): Promise<Selection> {
  const { workspaceId } = requireParams(params)
  const [library, packsResult] = await Promise.all([
    deps.clues.listClues(workspaceId),
    deps.clues.listPacks(workspaceId),
  ])
  const clueById = new Map(library.clues.map(clue => [clue.id, clue]))
  const packById = new Map(packsResult.packs.map(pack => [pack.id, pack]))
  const issues: CluepackIssue[] = []
  const selectedPacks: SelectedPack[] = []
  params.packIds?.forEach((packId, index) => {
    const pack = packById.get(packId)
    if (pack === undefined) {
      throw new ClueError('not-found', `pack "${packId}" does not exist in this workspace`)
    }
    selectedPacks.push({ pack, key: `pack-${index + 1}`, clueIds: pack.members })
  })
  const orderedIds: string[] = []
  const seen = new Set<string>()
  for (const selected of selectedPacks) {
    for (const clueId of selected.clueIds) {
      if (!clueById.has(clueId)) {
        issues.push({
          target: 'pack',
          key: selected.key,
          category: 'not-found',
          reason: `pack "${selected.pack.name}" lists a clue that no longer exists`,
        })
        continue
      }
      if (seen.has(clueId)) continue
      seen.add(clueId)
      orderedIds.push(clueId)
    }
  }
  for (const clueId of params.clueIds ?? []) {
    if (!clueById.has(clueId)) {
      throw new ClueError('not-found', `clue "${clueId}" does not exist in this workspace`)
    }
    if (seen.has(clueId)) continue
    seen.add(clueId)
    orderedIds.push(clueId)
  }
  const clues = orderedIds.map(clueId => clueById.get(clueId)!)
  return {
    packs: selectedPacks,
    clues,
    issues,
  }
}

/** The date stamp of a suggested file name (`yyyymmdd`). */
function dateStamp(now: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(now)
  if (match !== null) return `${match[1]}${match[2]}${match[3]}`
  const date = new Date(now)
  return Number.isNaN(date.getTime())
    ? 'unknown-date'
    : date.toISOString().slice(0, 10).replaceAll('-', '')
}

/**
 * Replace lone UTF-16 surrogates with nothing.
 *
 * A pack name is arbitrary text (S1 only bounds its length and trims it), so
 * it may contain an unpaired surrogate. `encodeURIComponent` throws
 * `URIError: URI malformed` on one, which turned a legal long/emoji name into
 * a 500 on the download route. Everything derived from a name is made
 * well-formed here before it reaches an encoder.
 * @param value - possibly ill-formed text.
 */
export function wellFormedText(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index]! + value[index + 1]!
        index += 1
      }
      // A lone high surrogate is dropped.
      continue
    }
    // A lone low surrogate is dropped.
    if (code >= 0xdc00 && code <= 0xdfff) continue
    result += value[index]!
  }
  return result
}

/** Sanitize a pack name into a download file stem (path separators removed). */
function fileStemOf(name: string | undefined): string {
  const source = wellFormedText(name ?? 'clues')
  const cleaned = source
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  // Truncate by CODE POINT, not UTF-16 code unit: slicing at 100 code units
  // can cut a surrogate pair in half and hand the RFC 5987 encoder an
  // unencodable string (a valid emoji pack name then 500'd the download).
  return [...(cleaned === '' ? 'clues' : cleaned)].slice(0, MAX_FILE_STEM).join('')
}

/** Suggested download name of one selection. */
function fileNameOf(selection: Selection, now: string): string {
  const stem = selection.packs.length === 1 ? fileStemOf(selection.packs[0]!.pack.name) : 'clues'
  return `${stem}-${dateStamp(now)}${CLUEPACK_EXTENSION}`
}

/** The current timestamp of one export. */
function nowOf(deps: ClueShareExportDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))()
}

/**
 * The source-side read/portable params of one already-selected clue.
 *
 * Passing the selection's own `{sourceId, typeId, locator}` instead of a
 * `clueId` keeps `resolveRef` from re-reading the whole workspace state once
 * per clue (a 10,000-clue export previously did 10,000 full-store reads even
 * though the exporter had already loaded the library).
 */
function liveCallOf(workspaceId: string, clue: Clue): {
  workspaceId: string
  sourceId: string
  typeId: string
  locator: Locator
} {
  return { workspaceId, sourceId: clue.sourceId, typeId: clue.typeId, locator: clue.locator }
}

/** Source attribution records of the selected clues, keyed by source id. */
function collectSources(deps: ClueShareExportDeps, clues: readonly Clue[]): {
  sources: CluepackSource[]
  keyBySourceId: Map<string, string>
} {
  const sources: CluepackSource[] = []
  const keyBySourceId = new Map<string, string>()
  /** Type ids per source, accumulated once (never a per-source rescan). */
  const typeIdsBySource = new Map<string, Set<string>>()
  for (const clue of clues) {
    const typeIds = typeIdsBySource.get(clue.sourceId)
    if (typeIds === undefined) typeIdsBySource.set(clue.sourceId, new Set([clue.typeId]))
    else typeIds.add(clue.typeId)
  }
  for (const [sourceId, typeIds] of typeIdsBySource) {
    const key = `source-${sources.length + 1}`
    keyBySourceId.set(sourceId, key)
    const descriptor = deps.clues.getSource(sourceId)
    sources.push({
      key,
      sourceId,
      ...(descriptor === undefined
        ? {}
        : {
          // An empty optional attribution string is "unknown", not a value:
          // the manifest rejects empty strings, and copying one used to fail
          // the whole export after every snapshot had already been read.
          ...(descriptor.pluginId.trim() === '' ? {} : { pluginId: descriptor.pluginId }),
          ...(descriptor.name.trim() === '' ? {} : { name: descriptor.name }),
          transport: descriptor.transport,
        }),
      typeIds: [...typeIds],
    })
  }
  return { sources, keyBySourceId }
}

/** One extra asset captured from a source read. */
interface CapturedAsset {
  readonly kind: 'download' | 'open'
  readonly mediaType: string
  readonly bytes: Uint8Array
}

/** The payload(s) + descriptor of one captured snapshot. */
interface CapturedSnapshot {
  readonly descriptor: Omit<CluepackSnapshot, 'path' | 'assets'>
  /** Primary payload: the JSON body or the first raw asset. */
  readonly bytes: Uint8Array
  readonly extension: 'json' | 'bin'
  /** Additional raw assets captured from the same read. */
  readonly assets?: readonly CapturedAsset[]
}

/**
 * Archive resources still available to ONE snapshot capture.
 *
 * Passed into the capture loop so assets are bounded as they are read, not
 * only after every payload of a multi-asset read is already in memory. The
 * final `capture()` check remains the authoritative parity bound; this makes an
 * over-budget read stop before it holds the whole set.
 */
interface CaptureBudget {
  /** Expanded bytes available to this snapshot (body + assets). */
  readonly bytes: number
  /** Archive entries available to this snapshot (primary + assets). */
  readonly entries: number
}

/** Fixed reason when the entry budget cannot hold a multi-payload snapshot. */
const SAFE_ENTRY_BUDGET_REASON
  = 'the clue pack exceeds the entry limit (a multi-payload snapshot does not fit the remaining entries)'
/** Fixed reason when the expanded-size budget cannot hold a multi-payload snapshot. */
const SAFE_BYTE_BUDGET_REASON
  = 'the clue pack exceeds the expanded size limit (the remaining budget cannot hold this snapshot)'

/** Fixed reason of a read payload that cannot be stored as an importable snapshot. */
const SAFE_NOT_JSON_REASON = 'the source content is not a JSON value that can be stored as a snapshot'
/** Fixed reason of a binary read that exposed no bytes to archive. */
const SAFE_BINARY_WITHOUT_ASSET_REASON = 'the source returned a binary reference without an exportable asset'
/** Deepest JSON payload this serializer accepts (guards a hostile read result). */
const MAX_JSON_DEPTH = 512

/**
 * Whether one untrusted read payload is representable as JSON without loss.
 *
 * `JSON.stringify` silently drops `undefined`/functions, turns `NaN` and
 * `Infinity` into `null`, and can be hijacked by a `toJSON` method. The
 * importer re-parses the content document, so a lossy value would either be
 * refused later (an exporter-built archive its own importer rejects) or
 * silently change meaning. This walk rejects everything JSON cannot carry,
 * including cycles and depth that would overflow the recursive serializer.
 */
function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  let valid: boolean
  if (Array.isArray(value)) {
    valid = value.every(item => isJsonValue(item, seen, depth + 1))
  } else {
    valid = Object.keys(value).every(key =>
      isJsonValue((value as Record<string, unknown>)[key], seen, depth + 1))
  }
  seen.delete(value)
  return valid
}

/**
 * Serialize one structured read result into the content document the importer
 * accepts (`{format, data, text?}`).
 *
 * The bytes are parsed back and compared before they are staged: `data` must
 * be present and representable, `text` must be a string when present, and the
 * wrapper must round-trip. A source that returns something else becomes a
 * per-clue issue and `complete:false` instead of a metadata-only "snapshot"
 * the receiver has to reject.
 * @returns the UTF-8 bytes, or one fixed safe reason.
 */
function jsonBodyOf(
  format: unknown,
  data: unknown,
  text: unknown,
): { readonly bytes: Uint8Array } | { readonly reason: string } {
  if (typeof format !== 'string' || format.trim() === '') return { reason: SAFE_NOT_JSON_REASON }
  if (data === undefined || !isJsonValue(data)) return { reason: SAFE_NOT_JSON_REASON }
  if (text !== undefined && typeof text !== 'string') return { reason: SAFE_NOT_JSON_REASON }
  let encoded: string
  try {
    encoded = JSON.stringify({
      format,
      data,
      ...(text === undefined ? {} : { text }),
    })
    const parsed = JSON.parse(encoded) as unknown
    if (!isRecord(parsed) || parsed.format !== format || !('data' in parsed)) {
      return { reason: SAFE_NOT_JSON_REASON }
    }
    if (text === undefined ? parsed.text !== undefined : parsed.text !== text) {
      return { reason: SAFE_NOT_JSON_REASON }
    }
    // A `toJSON` method or a class instance can still change the value during
    // stringification even when the walk above accepted the raw object.
    if (stableLocatorKey(parsed.data as JsonValue) !== stableLocatorKey(data as JsonValue)) {
      return { reason: SAFE_NOT_JSON_REASON }
    }
  } catch {
    return { reason: SAFE_NOT_JSON_REASON }
  }
  return { bytes: new TextEncoder().encode(encoded) }
}

/** SHA-256 hex digest of one byte array. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** One bounded local-asset read (never opens a FIFO/device or trusts stat). */
async function readAssetBytes(
  deps: ClueShareExportDeps,
  path: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (deps.readFileBytes !== undefined) {
    throwIfAborted(signal)
    const bytes = await deps.readFileBytes(path)
    throwIfAborted(signal)
    return bytes
  }
  // O_NONBLOCK keeps a FIFO that replaced the file between `stat` and this
  // open from blocking the whole host (a read-only open of a FIFO waits for a
  // writer otherwise). The fstat below re-checks the REAL opened object, so a
  // regular-file promise from the earlier stat is not trusted.
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK))
  try {
    if (!(await handle.stat()).isFile()) {
      throw new ClueError('unsupported', 'the local asset is not a regular file')
    }
    const chunks: Buffer[] = []
    let total = 0
    // One byte past the limit is enough to prove the file is too large; the
    // same buffer size also keeps a file that GROWS after `stat` bounded.
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1))
    for (;;) {
      throwIfAborted(signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > limit) {
        throw new ClueError('unsupported', `content exceeds the ${limit} byte snapshot limit`)
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    return new Uint8Array(Buffer.concat(chunks))
  } finally {
    await handle.close()
  }
}

/** One fixed issue of the clue currently being captured. */
function issueOf(clue: Clue, category: ClueErrorCategory, reason: string): { readonly issue: CluepackIssue } {
  return { issue: { target: 'clue', key: clue.id, category, reason } }
}

/**
 * Whether a read is the local-file binary shape.
 *
 * `data.kind === 'binary'` is the source's own marker. Requiring an asset here
 * (as the old guard did) made a binary read with no usable asset fall through
 * to the JSON branch: the archive then carried a metadata-only document with
 * the sender's absolute path and none of the original bytes, while the export
 * claimed success. The asset list is checked separately, so the missing bytes
 * become an explicit issue.
 */
function isBinaryRead(result: ClueReadResult): boolean {
  return result.text === undefined
    && isRecord(result.data)
    && result.data.kind === 'binary'
}

/** Capture one asset path with the shared size bound and fixed failures. */
async function captureAsset(
  deps: ClueShareExportDeps,
  clue: Clue,
  asset: { readonly kind: 'download' | 'open'; readonly path?: string; readonly mime?: string },
  maxSnapshotBytes: number,
  signal: AbortSignal | undefined,
): Promise<CapturedAsset | { readonly issue: CluepackIssue }> {
  if (asset.path === undefined || asset.path === '') {
    return issueOf(clue, 'unsupported', 'the source returned an asset without an exportable path')
  }
  const statFile = deps.statFile ?? (async path => {
    const info = await stat(path)
    return { size: info.size, isFile: info.isFile() }
  })
  try {
    throwIfAborted(signal)
    const info = await statFile(asset.path)
    throwIfAborted(signal)
    if (!info.isFile) {
      return issueOf(clue, 'unsupported', 'the local asset is not a regular file')
    }
    if (info.size > maxSnapshotBytes) {
      return issueOf(clue, 'unsupported', `content exceeds the ${maxSnapshotBytes} byte snapshot limit`)
    }
  } catch (error) {
    if (isClueError(error)) {
      return issueOf(clue, error.category, SAFE_FAILURE_REASONS[error.category])
    }
    return issueOf(clue, 'failed', 'the local asset could not be read for export')
  }
  let bytes: Uint8Array
  try {
    bytes = await readAssetBytes(deps, asset.path, maxSnapshotBytes, signal)
  } catch (error) {
    if (isClueError(error)) {
      return issueOf(clue, error.category, SAFE_FAILURE_REASONS[error.category])
    }
    return issueOf(clue, 'failed', 'the local asset could not be read for export')
  }
  if (bytes.byteLength > maxSnapshotBytes) {
    return issueOf(clue, 'unsupported', `content exceeds the ${maxSnapshotBytes} byte snapshot limit`)
  }
  return {
    kind: asset.kind,
    mediaType: asset.mime === undefined || asset.mime === '' ? 'application/octet-stream' : asset.mime,
    bytes,
  }
}

/**
 * Capture one clue's content for snapshot mode.
 *
 * A source read may carry a structured/text body AND several assets. The
 * primary payload is the body (JSON) when one exists; otherwise the first raw
 * asset is primary and the remaining assets are stored beside it. Every asset
 * is either captured completely or the whole clue becomes an explicit issue:
 * a multi-asset read is never silently reduced to its first asset, and a body
 * is never dropped just because one asset happened to have a path.
 * @returns the payload(s) or an issue when the content cannot be fully captured.
 */
async function captureSnapshot(
  deps: ClueShareExportDeps,
  clue: Clue,
  result: ClueReadResult,
  maxSnapshotBytes: number,
  budget: CaptureBudget,
  signal: AbortSignal | undefined,
): Promise<CapturedSnapshot | { readonly issue: CluepackIssue }> {
  const assets = result.assets ?? []
  const declaredButUnreadable = assets.find(asset => asset.path === undefined || asset.path === '')
  if (declaredButUnreadable !== undefined) {
    return issueOf(clue, 'unsupported', 'the source returned an asset without an exportable path')
  }
  if (assets.some(asset => asset.kind !== 'download' && asset.kind !== 'open')) {
    return issueOf(clue, 'unsupported', 'the source returned an asset with an unsupported kind')
  }
  const binary = isBinaryRead(result)
  if (binary && assets.length === 0) {
    // The sender's absolute path in `data` is metadata, not content: exporting
    // it as a "snapshot" would leak the path and carry no original bytes.
    return issueOf(clue, 'unsupported', SAFE_BINARY_WITHOUT_ASSET_REASON)
  }
  let bodyBytes: Uint8Array | undefined
  if (!binary) {
    const body = jsonBodyOf(result.format, result.data, result.text)
    if ('reason' in body) return issueOf(clue, 'unsupported', body.reason)
    bodyBytes = body.bytes
    if (bodyBytes.byteLength > maxSnapshotBytes) {
      return issueOf(clue, 'unsupported', `content exceeds the ${maxSnapshotBytes} byte snapshot limit`)
    }
  }
  // The primary payload (body or first asset) plus every extra asset needs one
  // archive entry. Refuse an over-budget multi-asset read BEFORE reading any of
  // them, so a hostile source cannot make the exporter hold the whole set.
  if (1 + assets.length > budget.entries) {
    throw new ClueError('invalid-request', SAFE_ENTRY_BUDGET_REASON)
  }
  let remainingBytes = budget.bytes - (bodyBytes?.byteLength ?? 0)
  if (remainingBytes < 0) throw new ClueError('invalid-request', SAFE_BYTE_BUDGET_REASON)
  const capturedAssets: CapturedAsset[] = []
  for (const asset of assets) {
    // Each asset is bounded by BOTH the per-content limit and what is left of
    // the aggregate expanded budget: the old loop read every asset with the
    // per-content bound first and only discovered the aggregate overflow later.
    const allowance = Math.min(maxSnapshotBytes, remainingBytes)
    if (allowance <= 0) throw new ClueError('invalid-request', SAFE_BYTE_BUDGET_REASON)
    const captured = await captureAsset(deps, clue, asset, allowance, signal)
    if ('issue' in captured) {
      // An asset that only fails because the AGGREGATE allowance ran out is a
      // request-level limit failure (like the old post-capture check), not a
      // per-item content problem.
      if (allowance < maxSnapshotBytes
        && captured.issue.reason === `content exceeds the ${allowance} byte snapshot limit`) {
        throw new ClueError('invalid-request', SAFE_BYTE_BUDGET_REASON)
      }
      return captured
    }
    remainingBytes -= captured.bytes.byteLength
    capturedAssets.push(captured)
  }
  const common = {
    format: result.format,
    fetchedAt: result.fetchedAt,
    ...(result.revision === undefined || result.revision.trim() === ''
      ? {}
      : { sourceVersion: result.revision }),
  }
  if (binary) {
    const primary = capturedAssets.shift()!
    const rest = capturedAssets.length === 0 ? undefined : capturedAssets
    return {
      bytes: primary.bytes,
      extension: 'bin',
      descriptor: {
        encoding: 'raw',
        mediaType: primary.mediaType,
        bytes: primary.bytes.byteLength,
        sha256: sha256Hex(primary.bytes),
        ...common,
      },
      ...(rest === undefined ? {} : { assets: rest }),
    }
  }
  return {
    bytes: bodyBytes!,
    extension: 'json',
    descriptor: {
      encoding: 'json',
      mediaType: 'application/json',
      bytes: bodyBytes!.byteLength,
      sha256: sha256Hex(bodyBytes!),
      ...common,
    },
    ...(capturedAssets.length === 0 ? {} : { assets: capturedAssets }),
  }
}

/**
 * The raw-binary transport wrapper S1 stores for an imported binary asset
 * (`{kind:'binary', mediaType, size, sha256, encoding:'base64', base64}`).
 *
 * All six fields are required. Requiring the full shape keeps a STRUCTURED
 * snapshot whose JSON content happens to contain a `kind`/`base64` object from
 * being reinterpreted as raw bytes on re-share.
 */
function binaryWrapperOf(data: JsonValue): {
  mediaType: string
  bytes: Uint8Array
  sha256: string
  size: number
} | undefined {
  if (!isRecord(data)) return undefined
  const raw = data as Record<string, JsonValue>
  if (
    raw.kind !== 'binary'
    || raw.encoding !== 'base64'
    || typeof raw.base64 !== 'string'
    || typeof raw.mediaType !== 'string'
    || raw.mediaType === ''
    || typeof raw.size !== 'number'
    || typeof raw.sha256 !== 'string'
  ) {
    return undefined
  }
  return {
    mediaType: raw.mediaType,
    bytes: new Uint8Array(Buffer.from(raw.base64, 'base64')),
    sha256: raw.sha256,
    size: raw.size,
  }
}

/**
 * S1 stores one JSON value per snapshot. A read that carries several payloads
 * (the structured body plus raw assets) is projected into this versioned
 * wrapper so a later re-share can reproduce every byte. A normal single-part
 * snapshot keeps the existing plain shape for backward compatibility.
 */
interface StoredSnapshotBundle {
  readonly primary:
    | { readonly encoding: 'json'; readonly data: JsonValue }
    | {
      readonly encoding: 'raw'
      readonly mediaType: string
      readonly size: number
      readonly sha256: string
      readonly base64: string
    }
  readonly assets: readonly {
    readonly kind: 'download' | 'open'
    readonly mediaType: string
    readonly size: number
    readonly sha256: string
    readonly base64: string
  }[]
}

/** Marker/version of the multi-payload S1 projection. */
const STORED_BUNDLE_KIND = 'cluepack-snapshot-bundle'
const STORED_BUNDLE_VERSION = 1

/** Decode one base64 payload and verify its declared size/digest. */
function verifiedBase64(
  base64: unknown,
  size: unknown,
  digest: unknown,
): { readonly bytes: Uint8Array } | undefined {
  if (typeof base64 !== 'string' || typeof size !== 'number' || typeof digest !== 'string') return undefined
  if (!Number.isSafeInteger(size) || size < 0) return undefined
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
  if (bytes.byteLength !== size || sha256Hex(bytes) !== digest) return undefined
  return { bytes }
}

/** Parse the versioned multi-payload projection, or `undefined` for a plain snapshot. */
function storedBundleOf(data: JsonValue): StoredSnapshotBundle | undefined {
  if (!isRecord(data)) return undefined
  const raw = data as Record<string, JsonValue>
  if (raw.kind !== STORED_BUNDLE_KIND || raw.version !== STORED_BUNDLE_VERSION) return undefined
  if (!isRecord(raw.primary) || !Array.isArray(raw.assets)) return undefined
  const primary = raw.primary
  const primaryRecord = primary as Record<string, JsonValue>
  let parsedPrimary: StoredSnapshotBundle['primary']
  if (primaryRecord.encoding === 'json') {
    if (!('data' in primaryRecord)) return undefined
    parsedPrimary = { encoding: 'json', data: primaryRecord.data! }
  } else if (primaryRecord.encoding === 'raw') {
    const verified = verifiedBase64(primaryRecord.base64, primaryRecord.size, primaryRecord.sha256)
    if (verified === undefined || typeof primaryRecord.mediaType !== 'string' || primaryRecord.mediaType === '') {
      return undefined
    }
    parsedPrimary = {
      encoding: 'raw',
      mediaType: primaryRecord.mediaType,
      size: primaryRecord.size as number,
      sha256: primaryRecord.sha256 as string,
      base64: primaryRecord.base64 as string,
    }
  } else {
    return undefined
  }
  const assets: StoredSnapshotBundle['assets'][number][] = []
  for (const entry of raw.assets) {
    if (!isRecord(entry)) return undefined
    const asset = entry as Record<string, JsonValue>
    const verified = verifiedBase64(asset.base64, asset.size, asset.sha256)
    if (
      verified === undefined
      || (asset.kind !== 'download' && asset.kind !== 'open')
      || typeof asset.mediaType !== 'string'
      || asset.mediaType === ''
    ) {
      return undefined
    }
    assets.push({
      kind: asset.kind,
      mediaType: asset.mediaType,
      size: asset.size as number,
      sha256: asset.sha256 as string,
      base64: asset.base64 as string,
    })
  }
  return { primary: parsedPrimary, assets }
}

/**
 * Reconstruct one captured snapshot from the multi-payload S1 projection.
 * Every raw part is hash-checked again so a corrupted store cannot be
 * re-shared as if it were intact.
 */
function capturedStoredBundle(
  record: ClueSnapshotRecord,
  bundle: StoredSnapshotBundle,
  maxSnapshotBytes: number,
  key: string,
  budget: CaptureBudget,
): CapturedSnapshot | { readonly issue: CluepackIssue } {
  const fail = (reason: string): { readonly issue: CluepackIssue } => ({
    issue: { target: 'clue', key, category: 'failed', reason },
  })
  const tooLarge = (): { readonly issue: CluepackIssue } => ({
    issue: {
      target: 'clue',
      key,
      category: 'unsupported',
      reason: `content exceeds the ${maxSnapshotBytes} byte snapshot limit`,
    },
  })
  const overBudget = (): never => {
    throw new ClueError('invalid-request', SAFE_BYTE_BUDGET_REASON)
  }
  const common = {
    format: record.content.format,
    fetchedAt: record.meta.fetchedAt,
    ...(record.meta.sourceVersion === undefined || record.meta.sourceVersion.trim() === ''
      ? {}
      : { sourceVersion: record.meta.sourceVersion }),
  }
  if (1 + bundle.assets.length > budget.entries) {
    throw new ClueError('invalid-request', SAFE_ENTRY_BUDGET_REASON)
  }
  // Validate/serialize the JSON primary before decoding assets so the aggregate
  // budget can subtract its real bytes; a later share must not read every asset
  // into memory first.
  const body = bundle.primary.encoding === 'json'
    ? jsonBodyOf(record.content.format, bundle.primary.data, record.content.text)
    : undefined
  if (body !== undefined && 'reason' in body) return fail(body.reason)
  if (body !== undefined && body.bytes.byteLength > maxSnapshotBytes) return tooLarge()
  const primarySize = bundle.primary.encoding === 'raw'
    ? bundle.primary.size
    : body!.bytes.byteLength
  if (primarySize > maxSnapshotBytes) return tooLarge()
  let remainingBytes = budget.bytes - primarySize
  if (remainingBytes < 0) return overBudget()
  const assets: CapturedAsset[] = []
  for (const asset of bundle.assets) {
    if (asset.size > maxSnapshotBytes) return tooLarge()
    if (asset.size > remainingBytes) return overBudget()
    const verified = verifiedBase64(asset.base64, asset.size, asset.sha256)
    if (verified === undefined) return fail('the stored snapshot failed its integrity check')
    remainingBytes -= verified.bytes.byteLength
    assets.push({ kind: asset.kind, mediaType: asset.mediaType, bytes: verified.bytes })
  }
  if (bundle.primary.encoding === 'raw') {
    const primary = bundle.primary
    const verified = verifiedBase64(primary.base64, primary.size, primary.sha256)
    if (verified === undefined) return fail('the stored snapshot failed its integrity check')
    return {
      bytes: verified.bytes,
      extension: 'bin',
      descriptor: {
        encoding: 'raw',
        mediaType: primary.mediaType,
        bytes: verified.bytes.byteLength,
        sha256: primary.sha256,
        ...common,
      },
      ...(assets.length === 0 ? {} : { assets }),
    }
  }
  const bodyBytes = body!.bytes
  return {
    bytes: bodyBytes,
    extension: 'json',
    descriptor: {
      encoding: 'json',
      mediaType: 'application/json',
      bytes: bodyBytes.byteLength,
      sha256: sha256Hex(bodyBytes),
      ...common,
    },
    ...(assets.length === 0 ? {} : { assets }),
  }
}

/** One workspace's stored snapshots, indexed by clue id (newest first). */
interface StoredSnapshotIndex {
  readonly newestByClueId: ReadonlyMap<string, ClueSnapshotMeta>
  /** Present when the ONE listing call failed; per-clue fallback reports it. */
  readonly failure?: { readonly category: ClueErrorCategory; readonly reason: string }
}

/**
 * Whether `left` is newer than `right` (fetchedAt instant, then snapshot id).
 *
 * `fetchedAt` is an ISO timestamp that may carry different timezone offsets
 * (`...Z` vs `...+08:00`), so the STRING order is not the time order; compare
 * the parsed instants instead. The id is the deterministic tie-break.
 */
function isNewerSnapshot(left: ClueSnapshotMeta, right: ClueSnapshotMeta): boolean {
  const leftTime = Date.parse(left.fetchedAt)
  const rightTime = Date.parse(right.fetchedAt)
  const byTime = leftTime === rightTime ? 0 : leftTime > rightTime ? 1 : -1
  return byTime > 0 || (byTime === 0 && left.snapshotId.localeCompare(right.snapshotId) > 0)
}

/**
 * Read the workspace snapshot catalogue ONCE before the export loop.
 *
 * `listSnapshots` readdirs the snapshot directory and reads every meta file;
 * calling it per unresolved clue would make a 1,000-clue offline export do
 * ~1,000,000 file reads. The loop only needs the newest snapshot per clue.
 */
async function indexStoredSnapshots(
  deps: ClueShareExportDeps,
  workspaceId: string,
): Promise<StoredSnapshotIndex> {
  try {
    const newestByClueId = new Map<string, ClueSnapshotMeta>()
    for (const meta of await deps.clues.listSnapshots(workspaceId)) {
      const current = newestByClueId.get(meta.clueId)
      if (current === undefined || isNewerSnapshot(meta, current)) newestByClueId.set(meta.clueId, meta)
    }
    return { newestByClueId }
  } catch (error) {
    return {
      newestByClueId: new Map(),
      failure: {
        category: isClueError(error) ? error.category : 'failed',
        reason: 'the stored snapshots could not be listed for export',
      },
    }
  }
}

/**
 * Re-share the newest snapshot S1 already stores for one clue.
 *
 * Snapshot mode normally reads the source. An UNRESOLVED clue has no source to
 * ask, but it may still carry an imported snapshot (offline import); spec §3
 * says a clue with a snapshot can still be shared, so the stored snapshot is
 * re-encoded into the archive instead of reporting a missing source. The same
 * fallback is used when a resolved clue's live read fails (source uninstalled,
 * authorization expired), so its historical snapshot is not lost. This is a
 * local read (`readSnapshot`), never a source operation.
 *
 * @param index - the once-per-export snapshot catalogue.
 * @returns the payload; `undefined` when the clue has no stored snapshot;
 *   `{issue}` when the stored snapshot cannot be re-shared.
 */
async function captureStoredSnapshot(
  deps: ClueShareExportDeps,
  index: StoredSnapshotIndex,
  clueId: string,
  key: string,
  maxSnapshotBytes: number,
  budget: CaptureBudget,
): Promise<CapturedSnapshot | { readonly issue: CluepackIssue } | undefined> {
  if (index.failure !== undefined) {
    return {
      issue: {
        target: 'clue',
        key,
        category: index.failure.category,
        reason: index.failure.reason,
      },
    }
  }
  const newest = index.newestByClueId.get(clueId)
  if (newest === undefined) return undefined
  let record: ClueSnapshotRecord
  try {
    record = await deps.clues.readSnapshot({ workspaceId: newest.workspaceId, snapshotId: newest.snapshotId })
  } catch (error) {
    return {
      issue: {
        target: 'clue',
        key,
        category: isClueError(error) ? error.category : 'failed',
        reason: 'the stored snapshot could not be read for export',
      },
    }
  }
  const format = record.content.format
  const rawData = record.content.data
  if (isRecord(rawData) && rawData.kind === STORED_BUNDLE_KIND) {
    const bundle = storedBundleOf(rawData)
    if (bundle === undefined) {
      return {
        issue: {
          target: 'clue',
          key,
          category: 'failed',
          reason: 'the stored snapshot failed its integrity check',
        },
      }
    }
    return capturedStoredBundle(record, bundle, maxSnapshotBytes, key, budget)
  }
  const binary = binaryWrapperOf(rawData)
  if (binary !== undefined) {
    const digest = sha256Hex(binary.bytes)
    if (binary.sha256 !== digest || binary.size !== binary.bytes.byteLength) {
      return {
        issue: {
          target: 'clue',
          key,
          category: 'failed',
          reason: 'the stored snapshot failed its integrity check',
        },
      }
    }
    if (binary.bytes.byteLength > maxSnapshotBytes) {
      return {
        issue: {
          target: 'clue',
          key,
          category: 'unsupported',
          reason: `content exceeds the ${maxSnapshotBytes} byte snapshot limit`,
        },
      }
    }
    if (budget.entries < 1) throw new ClueError('invalid-request', SAFE_ENTRY_BUDGET_REASON)
    if (binary.bytes.byteLength > budget.bytes) throw new ClueError('invalid-request', SAFE_BYTE_BUDGET_REASON)
    return {
      bytes: binary.bytes,
      extension: 'bin',
      descriptor: {
        encoding: 'raw',
        mediaType: binary.mediaType,
        format,
        bytes: binary.bytes.byteLength,
        sha256: digest,
        fetchedAt: record.meta.fetchedAt,
        ...(record.meta.sourceVersion === undefined || record.meta.sourceVersion.trim() === ''
          ? {}
          : { sourceVersion: record.meta.sourceVersion }),
      },
    }
  }
  const body = jsonBodyOf(format, record.content.data, record.content.text)
  if ('reason' in body) {
    return {
      issue: {
        target: 'clue',
        key,
        category: 'failed',
        reason: body.reason,
      },
    }
  }
  const bytes = body.bytes
  if (bytes.byteLength > maxSnapshotBytes) {
    return {
      issue: {
        target: 'clue',
        key,
        category: 'unsupported',
        reason: `content exceeds the ${maxSnapshotBytes} byte snapshot limit`,
      },
    }
  }
  if (budget.entries < 1) throw new ClueError('invalid-request', SAFE_ENTRY_BUDGET_REASON)
  if (bytes.byteLength > budget.bytes) throw new ClueError('invalid-request', SAFE_BYTE_BUDGET_REASON)
  return {
    bytes,
    extension: 'json',
    descriptor: {
      encoding: 'json',
      mediaType: 'application/json',
      format,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      fetchedAt: record.meta.fetchedAt,
      ...(record.meta.sourceVersion === undefined || record.meta.sourceVersion.trim() === ''
        ? {}
        : { sourceVersion: record.meta.sourceVersion }),
    },
  }
}

/**
 * Resolve the EXACT portable references the archive would carry, for the
 * share-confirmation screen.
 *
 * This is the explicit post-preview consent step spec §3 requires: the UI calls
 * it when the user asks "what exactly am I about to share?". It calls the
 * source's `portable` operation per live clue (never `read`), so a private URL
 * or resource identifier is visible BEFORE the user confirms. Failures are
 * per-item reasons, not a failed inspection.
 * @param deps - service + test seams.
 * @param params - workspace/mode/selection.
 */
export async function inspectExport(
  deps: ClueShareExportDeps,
  params: ClueShareExportParams,
): Promise<ClueShareExportInspection> {
  throwIfAborted(params.signal)
  const { workspaceId, mode } = requireParams(params)
  const selection = await collectSelection(deps, params)
  throwIfAborted(params.signal)
  const { sources } = collectSources(deps, selection.clues)
  const warnings: string[] = selection.issues.map(issue => issue.reason)
  const items: ClueShareExportSharedItem[] = []
  for (const clue of selection.clues) {
    throwIfAborted(params.signal)
    let portable: CluePortableRef
    if (clue.unresolved !== undefined) {
      portable = externalPathHintOf(clue, portableRefOf(
        clue.unresolved.portable,
        safeStoredReason(clue.unresolved.reason, SAFE_UNRESOLVED_REASON),
        'stored',
      ))
      warnings.push(`"${clue.title}" is unresolved: ${safeStoredReason(clue.unresolved.reason, SAFE_UNRESOLVED_REASON)}`)
    } else {
      try {
        portable = externalPathHintOf(clue, portableRefOf(
          await deps.clues.portable(liveCallOf(workspaceId, clue), {
            caller: 'ui',
            ...(params.signal === undefined ? {} : { signal: params.signal }),
          }),
          SAFE_PORTABLE_REFUSED_REASON,
        ))
      } catch (error) {
        if (params.signal?.aborted === true) throwIfAborted(params.signal)
        const failure = safeFailureOf(error)
        portable = externalPathHintOf(clue, { portable: false, reason: failure.reason })
        warnings.push(`"${clue.title}": ${failure.reason}`)
      }
    }
    if (portable.portable !== true || portable.locator === undefined) {
      warnings.push(portable.locator === undefined
        ? `"${clue.title}": no portable locator will be shared`
        : `"${clue.title}": the shared locator is not portable and needs an explicit receiver remap`)
    }
    items.push({
      clueId: clue.id,
      title: clue.title,
      sourceId: clue.sourceId,
      typeId: clue.typeId,
      portable,
      ...(clue.unresolved === undefined
        ? {}
        : { unresolved: safeStoredReason(clue.unresolved.reason, SAFE_UNRESOLVED_REASON) }),
      snapshotMode: mode === 'snapshot',
    })
  }
  return {
    mode,
    fileName: fileNameOf(selection, nowOf(deps)),
    items,
    sources,
    warnings,
  }
}

/**
 * Preview one export from LOCAL metadata only: no source read/portable call,
 * no CLI, no network. The UI uses it as the confirmation screen; call
 * {@link inspectExport} next to show the exact portable references.
 * @param deps - service + test seams.
 * @param params - workspace/mode/selection.
 */
export async function previewExport(
  deps: ClueShareExportDeps,
  params: ClueShareExportParams,
): Promise<ClueShareExportPreview> {
  throwIfAborted(params.signal)
  const { mode } = requireParams(params)
  const selection = await collectSelection(deps, params)
  throwIfAborted(params.signal)
  const now = nowOf(deps)
  const { sources } = collectSources(deps, selection.clues)
  const warnings: string[] = []
  const items: ClueShareExportItemPreview[] = selection.clues.map((clue) => {
    if (clue.unresolved !== undefined) {
      warnings.push(`"${clue.title}" is unresolved: ${safeStoredReason(clue.unresolved.reason, SAFE_UNRESOLVED_REASON)}`)
    }
    return {
      clueId: clue.id,
      title: clue.title,
      sourceId: clue.sourceId,
      typeId: clue.typeId,
      ...(clue.unresolved === undefined
        ? {}
        : { unresolved: safeStoredReason(clue.unresolved.reason, SAFE_UNRESOLVED_REASON) }),
      snapshotMode: mode === 'snapshot',
    }
  })
  for (const issue of selection.issues) warnings.push(issue.reason)
  return {
    mode,
    fileName: fileNameOf(selection, now),
    items,
    packs: selection.packs.map(selected => ({
      packId: selected.pack.id,
      name: selected.pack.name,
      members: selected.pack.members.length,
    })),
    warnings,
    totals: { clues: items.length, packs: selection.packs.length, sources: sources.length },
  }
}

/**
 * Build one `.cluepack` archive.
 *
 * The archive is checked against the SAME limit set the importer enforces
 * (entry count, per-entry size, total expanded bytes, manifest size, archive
 * size). Entry count is pre-checked from the selection; the expanded total is
 * accumulated as each snapshot is captured, so a selection that exceeds it
 * stops BEFORE the next source read instead of holding every payload in
 * memory and only failing after the loop. The finished archive size is left to
 * the writer's exact check: a ZIP can be far smaller than its expanded
 * payloads (deflate text), so comparing expanded bytes with the archive limit
 * would refuse a pack that compresses under the limit.
 *
 * Cancellation and limit overflow throw (there is no bytes result to mistake
 * for a finished pack); per-item failures are reported through `issues` and
 * `complete: false`. In snapshot mode a stored snapshot is the fallback when
 * an unresolved clue has no source or a resolved clue's live read fails.
 * @param deps - service + test seams.
 * @param params - workspace/mode/selection/progress/signal.
 */
export async function exportPack(
  deps: ClueShareExportDeps,
  params: ClueShareExportParams,
): Promise<ClueShareExportResult> {
  throwIfAborted(params.signal)
  const { workspaceId, mode } = requireParams(params)
  const maxSnapshotBytes = deps.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES
  const maxArchiveBytes = deps.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotalBytes = deps.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxManifestBytes = deps.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES
  const selection = await collectSelection(deps, params)
  throwIfAborted(params.signal)
  // References mode writes the manifest alone. Snapshot mode writes at least
  // one content entry per clue (extra assets are discovered during the read and
  // checked again before the archive is built), so this is a lower bound that
  // refuses an impossible selection before the first source read.
  const plannedEntries = mode === 'snapshot' ? selection.clues.length + 1 : 1
  if (plannedEntries > maxEntries) {
    throw new ClueError(
      'invalid-request',
      `the selection exceeds the clue pack entry limit (${plannedEntries} entries; limit ${maxEntries})`,
    )
  }
  if (selection.clues.length > MAX_MANIFEST_CLUES) {
    throw new ClueError(
      'invalid-request',
      `the selection exceeds the clue pack manifest limit (${selection.clues.length} clues; limit ${MAX_MANIFEST_CLUES})`,
    )
  }
  if (selection.packs.length > MAX_MANIFEST_PACKS) {
    throw new ClueError(
      'invalid-request',
      `the selection exceeds the clue pack manifest limit (${selection.packs.length} packs; limit ${MAX_MANIFEST_PACKS})`,
    )
  }
  const issues: CluepackIssue[] = [...selection.issues]
  const clues: CluepackClue[] = []
  /** clue id → package key (for pack members). */
  const keyByClueId = new Map<string, string>()
  /** Archive path → payload (assembled into ZIP entries later). */
  const content = new Map<string, { readonly bytes: Uint8Array; readonly compress: boolean }>()
  /** Bytes captured so far; checked on every capture to bound memory. */
  let capturedBytes = 0
  const progress = params.onProgress ?? (() => undefined)
  const total = selection.clues.length
  const { sources, keyBySourceId } = collectSources(deps, selection.clues)
  // Snapshot fallback needs the catalogue once, not once per clue.
  const storedSnapshots = mode === 'snapshot' ? await indexStoredSnapshots(deps, workspaceId) : undefined
  throwIfAborted(params.signal)
  const capture = (path: string, bytes: Uint8Array, compress: boolean): void => {
    capturedBytes += bytes.byteLength
    content.set(path, { bytes, compress })
    // This is the importer's expanded-size bound. Checking it HERE means a
    // 10,000-snapshot selection stops at the 128 MiB boundary, not after
    // ~312 GiB of payloads have been retained. The archive-size bound is NOT
    // checked here: an expanded-byte lower bound is not a valid archive lower
    // bound once deflate is allowed (the writer checks the exact size).
    if (capturedBytes > maxTotalBytes) {
      throw new ClueError(
        'invalid-request',
        `the clue pack exceeds the expanded size limit (${capturedBytes} bytes captured; limit ${maxTotalBytes})`,
      )
    }
  }
  /**
   * Give one captured snapshot its archive paths and stage every payload.
   * The path derives only from the package clue key, never from a title or a
   * local file name; the importer validates it again.
   */
  const attachCapturedSnapshot = (key: string, captured: CapturedSnapshot): CluepackSnapshot => {
    const base = `content/${key}`
    const primaryPath = `${base}.${captured.extension}`
    const capturedAssets = captured.assets ?? []
    const assets = capturedAssets.map((asset, index) => ({
      path: `${base}.asset-${index + 1}.bin`,
      kind: asset.kind,
      mediaType: asset.mediaType,
      bytes: asset.bytes.byteLength,
      sha256: sha256Hex(asset.bytes),
    }))
    capture(primaryPath, captured.bytes, captured.extension === 'json')
    for (const [index, asset] of capturedAssets.entries()) {
      capture(`${base}.asset-${index + 1}.bin`, asset.bytes, false)
    }
    return {
      ...captured.descriptor,
      path: primaryPath,
      ...(assets.length === 0 ? {} : { assets }),
    }
  }
  progress({ phase: 'collect', completed: 0, total })

  for (const [index, clue] of selection.clues.entries()) {
    throwIfAborted(params.signal)
    const key = `clue-${index + 1}`
    keyByClueId.set(clue.id, key)
    // Remaining archive resources for THIS clue's snapshot. The manifest is
    // always one entry and `content` holds what earlier clues already staged,
    // so a multi-asset read is bounded as each asset is read.
    const budget: CaptureBudget = {
      bytes: maxTotalBytes - capturedBytes,
      entries: maxEntries - content.size - 1,
    }
    const itemIssues: CluepackIssue[] = []
    let portable: CluePortableRef
    if (clue.unresolved !== undefined) {
      portable = externalPathHintOf(clue, portableRefOf(
        clue.unresolved.portable,
        safeStoredReason(clue.unresolved.reason, SAFE_UNRESOLVED_REASON),
        'stored',
      ))
    } else {
      try {
        portable = externalPathHintOf(clue, portableRefOf(
          await deps.clues.portable(liveCallOf(workspaceId, clue), {
            caller: 'ui',
            ...(params.signal === undefined ? {} : { signal: params.signal }),
          }),
          SAFE_PORTABLE_REFUSED_REASON,
        ))
      } catch (error) {
        if (params.signal?.aborted === true) throwIfAborted(params.signal)
        const failure = safeFailureOf(error)
        itemIssues.push({ target: 'clue', key, category: failure.category, reason: failure.reason })
        portable = externalPathHintOf(clue, { portable: false, reason: failure.reason })
      }
    }
    let snapshot: CluepackSnapshot | undefined
    if (mode === 'snapshot') {
      const storedSnapshotsForClue = storedSnapshots!
      if (clue.unresolved !== undefined) {
        // No source to read, but an offline import may still own a snapshot:
        // re-share the newest stored one instead of pretending the clue has no
        // content (spec §3: a clue with a snapshot can still be shared).
        throwIfAborted(params.signal)
        const stored = await captureStoredSnapshot(deps, storedSnapshotsForClue, clue.id, key, maxSnapshotBytes, budget)
        throwIfAborted(params.signal)
        if (stored === undefined) {
          itemIssues.push({
            target: 'clue',
            key,
            category: 'source-missing',
            reason: `no snapshot was captured: ${safeStoredReason(clue.unresolved.reason, SAFE_UNRESOLVED_REASON)}`,
          })
        } else if ('issue' in stored) {
          itemIssues.push({ ...stored.issue, key })
        } else {
          snapshot = attachCapturedSnapshot(key, stored)
        }
      } else {
        let result: ClueReadResult | undefined
        let readFailure: { category: ClueErrorCategory; reason: string } | undefined
        try {
          result = await deps.clues.read(liveCallOf(workspaceId, clue), {
            caller: 'ui',
            ...(params.signal === undefined ? {} : { signal: params.signal }),
          })
        } catch (error) {
          if (params.signal?.aborted === true) throwIfAborted(params.signal)
          readFailure = safeFailureOf(error)
        }
        if (readFailure !== undefined) {
          // A resolved clue may still own an imported snapshot. Spec §3/§5 say
          // a failed live read keeps the snapshot readable; re-share it instead
          // of losing the content just because the source was uninstalled.
          throwIfAborted(params.signal)
          const stored = await captureStoredSnapshot(deps, storedSnapshotsForClue, clue.id, key, maxSnapshotBytes, budget)
          throwIfAborted(params.signal)
          if (stored !== undefined && !('issue' in stored)) {
            snapshot = attachCapturedSnapshot(key, stored)
            // Never turn a failed live read into a silent success: the
            // receiver must be able to see that this content is an OLD
            // snapshot (with its real fetchedAt), not fresh source content.
            itemIssues.push({
              target: 'clue',
              key,
              category: readFailure.category,
              reason: `${readFailure.reason}; the archive carries the earlier snapshot fetched at ${stored.descriptor.fetchedAt} instead of fresh content`,
            })
          } else if (stored !== undefined && 'issue' in stored) {
            itemIssues.push({ ...stored.issue, key })
          } else {
            itemIssues.push({ target: 'clue', key, category: readFailure.category, reason: readFailure.reason })
          }
        } else if (result !== undefined) {
          if (result.limited === true) {
            itemIssues.push({
              target: 'clue',
              key,
              category: 'unsupported',
              reason: 'content is larger than one read page and was not fully captured',
            })
          } else {
            throwIfAborted(params.signal)
            const captured = await captureSnapshot(deps, clue, result, maxSnapshotBytes, budget, params.signal)
            if ('issue' in captured) {
              itemIssues.push({ ...captured.issue, key })
            } else {
              snapshot = attachCapturedSnapshot(key, captured)
            }
          }
        }
      }
    }
    issues.push(...itemIssues)
    const record: CluepackClue = {
      key,
      sourceKey: keyBySourceId.get(clue.sourceId)!,
      typeId: clue.typeId,
      title: clue.title,
      portable,
      ...(snapshot === undefined ? {} : { snapshot }),
    }
    clues.push(record)
    progress({
      phase: 'read',
      completed: index + 1,
      total,
      key,
      status: itemIssues.length === 0 ? 'ok' : 'issue',
      ...(itemIssues[0] === undefined ? {} : { reason: itemIssues[0].reason }),
    })
  }

  const packs: CluepackPack[] = selection.packs.map(selected => ({
    key: selected.key,
    name: selected.pack.name,
    members: selected.clueIds
      .map(clueId => keyByClueId.get(clueId))
      .filter((key): key is string => key !== undefined),
  }))
  const manifest: CluepackManifest = {
    formatVersion: CLUEPACK_FORMAT_VERSION,
    format: CLUEPACK_FORMAT,
    exportedAt: nowOf(deps),
    mode,
    sources,
    clues,
    packs,
    issues,
  }
  throwIfAborted(params.signal)
  progress({ phase: 'archive', completed: total, total })
  const manifestBytes = serializeCluepackManifest(manifest)
  if (manifestBytes.byteLength > maxManifestBytes) {
    throw new ClueError(
      'invalid-request',
      `the clue pack manifest exceeds the import limit (${manifestBytes.byteLength} bytes; limit ${maxManifestBytes})`,
    )
  }
  const entries: ZipEntryInput[] = [
    { name: CLUEPACK_MANIFEST_PATH, data: manifestBytes, compress: true },
  ]
  for (const [name, captured] of content) {
    entries.push({ name, data: captured.bytes, compress: captured.compress })
  }
  // The entry count was pre-checked from the selection and `createZip`
  // re-checks it; this assembly step only needs the expanded-size parity
  // check that the per-capture bound could not make for the manifest bytes.
  const expandedBytes = capturedBytes + manifestBytes.byteLength
  if (expandedBytes > maxTotalBytes) {
    throw new ClueError(
      'invalid-request',
      `the clue pack exceeds the expanded size limit (${expandedBytes} bytes; limit ${maxTotalBytes})`,
    )
  }
  if (issues.length > MAX_MANIFEST_ISSUES) {
    throw new ClueError(
      'invalid-request',
      `the clue pack manifest exceeds the issue limit (${issues.length} issues; limit ${MAX_MANIFEST_ISSUES})`,
    )
  }
  const bytes = createZip(entries, {
    modifiedAt: new Date(manifest.exportedAt),
    limits: {
      maxEntries,
      // The manifest has its own (separate) bound; the per-entry bound only
      // has to admit it, otherwise a small snapshot policy would reject the
      // manifest itself.
      maxEntryBytes: Math.max(maxSnapshotBytes, manifestBytes.byteLength),
      maxTotalBytes,
      maxArchiveBytes,
    },
  })
  throwIfAborted(params.signal)
  progress({ phase: 'done', completed: total, total })
  return {
    fileName: fileNameOf(selection, manifest.exportedAt),
    bytes,
    manifest,
    mode,
    complete: issues.length === 0,
    issues,
    stats: {
      clues: clues.length,
      packs: packs.length,
      sources: sources.length,
      snapshots: clues.filter(clue => clue.snapshot !== undefined).length,
      bytes: bytes.byteLength,
    },
  }
}
