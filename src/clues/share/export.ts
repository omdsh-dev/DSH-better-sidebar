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
 * Cancellation and archive-size failure throw before any bytes are returned.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { CluesService } from '../service.ts'
import {
  ClueError,
  isClueError,
  type Clue,
  type ClueErrorCategory,
  type CluePack,
  type CluePortableRef,
  type ClueReadResult,
  type JsonValue,
  type Locator,
} from '../types.ts'
import {
  CLUEPACK_EXTENSION,
  CLUEPACK_FORMAT,
  CLUEPACK_FORMAT_VERSION,
  CLUEPACK_MANIFEST_PATH,
  serializeCluepackManifest,
  type CluepackClue,
  type CluepackIssue,
  type CluepackManifest,
  type CluepackMode,
  type CluepackPack,
  type CluepackSnapshot,
  type CluepackSource,
} from './manifest.ts'
import { createZip, type ZipEntryInput } from './zip.ts'

/** Default upper bound of one snapshot payload (JSON or raw bytes). */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
/** Default upper bound of the finished archive. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
/** Byte length bound of a pack name used in a download file name. */
const MAX_FILE_STEM = 100

/** Everything the exporter needs from the host (tests inject the seams). */
export interface ClueShareExportDeps {
  readonly clues: CluesService
  /** Clock injection (tests); defaults to `new Date().toISOString()`. */
  readonly now?: () => string
  /** Maximum size of one snapshot payload. */
  readonly maxSnapshotBytes?: number
  /** Maximum size of the finished archive. */
  readonly maxArchiveBytes?: number
  /** Raw-byte reader for an asset path (tests). */
  readonly readFileBytes?: (path: string) => Promise<Uint8Array>
  /** Size probe of an asset path (tests). */
  readonly statSize?: (path: string) => Promise<number>
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
  /** Member id → position in `clues`. */
  readonly order: ReadonlyMap<string, number>
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

/** The fixed category/message of one source failure (never a raw payload). */
function failureOf(error: unknown): { category: ClueErrorCategory; reason: string } {
  if (isClueError(error)) return { category: error.category, reason: error.message }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { category: 'cancelled', reason: 'the clue pack export was cancelled' }
  }
  return { category: 'failed', reason: 'the source operation failed' }
}

/** Whether a value is a plain JSON object (locator shape). */
function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Copy a source-provided portable reference down to the contract fields. */
function portableRefOf(ref: CluePortableRef | undefined, fallbackReason: string): CluePortableRef {
  if (ref === undefined) return { portable: false, reason: fallbackReason }
  if (ref.portable && isRecord(ref.locator)) {
    return { portable: true, locator: ref.locator as Locator, ...(ref.reason === undefined ? {} : { reason: ref.reason }) }
  }
  return {
    portable: false,
    reason: ref.reason ?? (ref.portable ? 'the source did not provide a portable locator' : fallbackReason),
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
    order: new Map(clues.map((clue, index) => [clue.id, index])),
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

/** Sanitize a pack name into a download file stem (path separators removed). */
function fileStemOf(name: string | undefined): string {
  const source = name ?? 'clues'
  const cleaned = source
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return (cleaned === '' ? 'clues' : cleaned).slice(0, MAX_FILE_STEM)
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

/** Source attribution records of the selected clues, keyed by source id. */
function collectSources(deps: ClueShareExportDeps, clues: readonly Clue[]): {
  sources: CluepackSource[]
  keyBySourceId: Map<string, string>
} {
  const sources: CluepackSource[] = []
  const keyBySourceId = new Map<string, string>()
  for (const clue of clues) {
    if (keyBySourceId.has(clue.sourceId)) continue
    const key = `source-${sources.length + 1}`
    keyBySourceId.set(clue.sourceId, key)
    const descriptor = deps.clues.getSource(clue.sourceId)
    sources.push({
      key,
      sourceId: clue.sourceId,
      ...(descriptor === undefined
        ? {}
        : {
          pluginId: descriptor.pluginId,
          name: descriptor.name,
          transport: descriptor.transport,
        }),
    })
  }
  return { sources, keyBySourceId }
}

/** The payload + descriptor of one captured snapshot. */
interface CapturedSnapshot {
  readonly descriptor: Omit<CluepackSnapshot, 'path'>
  readonly bytes: Uint8Array
  readonly extension: 'json' | 'bin'
}

/** Read one structured read result into a JSON payload. */
function jsonPayloadOf(result: ClueReadResult): Uint8Array {
  let text: string
  try {
    text = JSON.stringify({
      format: result.format,
      data: result.data,
      ...(result.text === undefined ? {} : { text: result.text }),
    })
  } catch {
    throw new ClueError('failed', 'the source content is not JSON-serializable')
  }
  if (typeof text !== 'string') {
    throw new ClueError('failed', 'the source content is not JSON-serializable')
  }
  return new TextEncoder().encode(text)
}

/** SHA-256 hex digest of one byte array. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Capture one clue's content for snapshot mode.
 * @returns the payload or an issue when the content cannot be fully captured.
 */
async function captureSnapshot(
  deps: ClueShareExportDeps,
  clue: Clue,
  result: ClueReadResult,
  maxSnapshotBytes: number,
): Promise<CapturedSnapshot | { readonly issue: CluepackIssue }> {
  const asset = result.assets?.find(candidate => candidate.path !== undefined
    && (candidate.kind === 'download' || candidate.kind === 'open'))
  if (asset?.path !== undefined) {
    const statSize = deps.statSize ?? (async path => (await stat(path)).size)
    const readBytes = deps.readFileBytes ?? (async path => new Uint8Array(await readFile(path)))
    let size: number
    try {
      size = await statSize(asset.path)
    } catch {
      return {
        issue: {
          target: 'clue',
          key: clue.id,
          category: 'failed',
          reason: 'the local asset could not be read for export',
        },
      }
    }
    if (size > maxSnapshotBytes) {
      return {
        issue: {
          target: 'clue',
          key: clue.id,
          category: 'unsupported',
          reason: `content exceeds the ${maxSnapshotBytes} byte snapshot limit`,
        },
      }
    }
    let bytes: Uint8Array
    try {
      bytes = await readBytes(asset.path)
    } catch {
      return {
        issue: {
          target: 'clue',
          key: clue.id,
          category: 'failed',
          reason: 'the local asset could not be read for export',
        },
      }
    }
    if (bytes.byteLength > maxSnapshotBytes) {
      return {
        issue: {
          target: 'clue',
          key: clue.id,
          category: 'unsupported',
          reason: `content exceeds the ${maxSnapshotBytes} byte snapshot limit`,
        },
      }
    }
    return {
      bytes,
      extension: 'bin',
      descriptor: {
        encoding: 'raw',
        mediaType: asset.mime ?? 'application/octet-stream',
        format: result.format,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        fetchedAt: result.fetchedAt,
        ...(result.revision === undefined ? {} : { sourceVersion: result.revision }),
      },
    }
  }
  let bytes: Uint8Array
  try {
    bytes = jsonPayloadOf(result)
  } catch (error) {
    return {
      issue: {
        target: 'clue',
        key: clue.id,
        category: isClueError(error) ? error.category : 'failed',
        reason: isClueError(error) ? error.message : 'the source content is not JSON-serializable',
      },
    }
  }
  if (bytes.byteLength > maxSnapshotBytes) {
    return {
      issue: {
        target: 'clue',
        key: clue.id,
        category: 'unsupported',
        reason: `content exceeds the ${maxSnapshotBytes} byte snapshot limit`,
      },
    }
  }
  return {
    bytes,
    extension: 'json',
    descriptor: {
      encoding: 'json',
      mediaType: 'application/json',
      format: result.format,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      fetchedAt: result.fetchedAt,
      ...(result.revision === undefined ? {} : { sourceVersion: result.revision }),
    },
  }
}

/**
 * Preview one export from LOCAL metadata only: no source read/portable call,
 * no CLI, no network. The UI uses it as the confirmation screen.
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
      warnings.push(`"${clue.title}" is unresolved: ${clue.unresolved.reason}`)
    }
    return {
      clueId: clue.id,
      title: clue.title,
      sourceId: clue.sourceId,
      typeId: clue.typeId,
      ...(clue.unresolved === undefined ? {} : { unresolved: clue.unresolved.reason }),
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
 * Cancellation and archive-size overflow throw (there is no bytes result to
 * mistake for a finished pack); per-item failures are reported through
 * `issues` and `complete: false`.
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
  const selection = await collectSelection(deps, params)
  const issues: CluepackIssue[] = [...selection.issues]
  const clues: CluepackClue[] = []
  /** clue id → package key (for pack members). */
  const keyByClueId = new Map<string, string>()
  /** Package key → captured payload (assembled into ZIP entries later). */
  const content = new Map<string, CapturedSnapshot>()
  const progress = params.onProgress ?? (() => undefined)
  const total = selection.clues.length
  const { sources, keyBySourceId } = collectSources(deps, selection.clues)
  progress({ phase: 'collect', completed: 0, total })

  for (const [index, clue] of selection.clues.entries()) {
    throwIfAborted(params.signal)
    const key = `clue-${index + 1}`
    keyByClueId.set(clue.id, key)
    const itemIssues: CluepackIssue[] = []
    let portable: CluePortableRef
    if (clue.unresolved !== undefined) {
      portable = portableRefOf(clue.unresolved.portable, clue.unresolved.reason)
    } else {
      try {
        portable = portableRefOf(await deps.clues.portable({ workspaceId, clueId: clue.id }, {
          caller: 'ui',
          ...(params.signal === undefined ? {} : { signal: params.signal }),
        }), 'the source did not provide a portable reference')
      } catch (error) {
        if (params.signal?.aborted === true) throwIfAborted(params.signal)
        const failure = failureOf(error)
        itemIssues.push({ target: 'clue', key, category: failure.category, reason: failure.reason })
        portable = { portable: false, reason: failure.reason }
      }
    }
    let snapshot: CluepackSnapshot | undefined
    if (mode === 'snapshot') {
      if (clue.unresolved !== undefined) {
        itemIssues.push({
          target: 'clue',
          key,
          category: 'source-missing',
          reason: `no snapshot was captured: ${clue.unresolved.reason}`,
        })
      } else {
        let result: ClueReadResult | undefined
        try {
          result = await deps.clues.read({ workspaceId, clueId: clue.id }, {
            caller: 'ui',
            ...(params.signal === undefined ? {} : { signal: params.signal }),
          })
        } catch (error) {
          if (params.signal?.aborted === true) throwIfAborted(params.signal)
          const failure = failureOf(error)
          itemIssues.push({ target: 'clue', key, category: failure.category, reason: failure.reason })
        }
        if (result !== undefined) {
          if (result.limited === true) {
            itemIssues.push({
              target: 'clue',
              key,
              category: 'unsupported',
              reason: 'content is larger than one read page and was not fully captured',
            })
          } else {
            throwIfAborted(params.signal)
            const captured = await captureSnapshot(deps, clue, result, maxSnapshotBytes)
            if ('issue' in captured) {
              itemIssues.push({ ...captured.issue, key })
            } else {
              // The path derives from the package key, never from a title or
              // a local file name; the importer validates it again.
              snapshot = {
                ...captured.descriptor,
                path: `content/${key}.${captured.extension}`,
              }
              content.set(key, captured)
            }
          }
        }
      }
    }
    issues.push(...itemIssues)
    clues.push({
      key,
      sourceKey: keyBySourceId.get(clue.sourceId)!,
      typeId: clue.typeId,
      title: clue.title,
      portable,
      ...(snapshot === undefined ? {} : { snapshot }),
    })
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
  const entries: ZipEntryInput[] = [
    { name: CLUEPACK_MANIFEST_PATH, data: serializeCluepackManifest(manifest), compress: true },
  ]
  for (const [key, captured] of content) {
    const clue = clues.find(candidate => candidate.key === key)!
    entries.push({
      name: clue.snapshot!.path,
      data: captured.bytes,
      compress: captured.descriptor.encoding === 'json',
    })
  }
  const bytes = createZip(entries, { modifiedAt: new Date(manifest.exportedAt) })
  if (bytes.byteLength > maxArchiveBytes) {
    throw new ClueError(
      'failed',
      `the clue pack exceeds the maximum export size (${bytes.byteLength} bytes; limit ${maxArchiveBytes})`,
    )
  }
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
