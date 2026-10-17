/**
 * S7 import: validate a `.cluepack` archive and commit it into the local S1
 * clue library.
 *
 * The order is deliberate:
 * 1. parse the ZIP and the manifest, verify every content entry's size and
 *    SHA-256 (all before the first write);
 * 2. resolve each clue through S1 — `clues.ensure` when the source+type are
 *    installed and the reference is portable, otherwise
 *    `clues.importUnresolved` (the row stays a first-class clue, readable as
 *    `source-missing`, re-mappable later);
 * 3. store snapshots with `clues.putSnapshot` (S1 mints the local
 *    snapshotId; package paths are never runtime ids);
 * 4. create packs LAST, because a pack is the visible "import finished"
 *    object. A pack creation failure is reported as a partial result with a
 *    stable reason and never silently turns into success.
 *
 * Safety/invariants:
 * - preview performs NO source read/portable call, no install, no auth, no
 *   write — it only reads the local registry to label availability;
 * - the importer never touches bindings or pins (no inherited workspace
 *   binding, nothing pinned by default);
 * - an existing live clue is reused by `ensure`; its locator/title/read mode
 *   are never overwritten, and the imported content becomes an independent
 *   snapshot;
 * - a duplicate pack name produces a NEW pack (S1 has no overwrite path);
 * - raw asset bytes are preserved exactly by the archive and stored as a
 *   base64 JSON body because S1's snapshot store is JSON-only. `data.bytes`
 *   decodes to the original bytes; no Markdown/projection rewrite happens.
 */
import { createHash } from 'node:crypto'
import type { CluesService } from '../service.ts'
import {
  BUILTIN_SOURCE_IDS,
  ClueError,
  isClueError,
  type ClueErrorCategory,
  type CluePack,
  type ClueSnapshotMeta,
  type JsonValue,
  type Locator,
} from '../types.ts'
import {
  CLUEPACK_MANIFEST_PATH,
  parseCluepackManifestBytes,
  type CluepackClue,
  type CluepackIssue,
  type CluepackManifest,
  type CluepackMode,
  type CluepackSource,
} from './manifest.ts'
import { readZip, type ZipReadLimits } from './zip.ts'

/** Maximum pack name S1 accepts (mirrors the service's own bound). */
const MAX_PACK_NAME = 200

/** Everything the importer needs from the host (tests inject the registry). */
export interface ClueShareImportDeps {
  readonly clues: CluesService
  /** ZIP resource limits for the untrusted archive. */
  readonly zipLimits?: Partial<ZipReadLimits>
}

/** Caller input of one preview/import. */
export interface ClueShareImportParams {
  readonly workspaceId: string
  /** Raw `.cluepack` bytes. */
  readonly bytes: Uint8Array
  /** Cancels before the next write; already-parsed archives are not committed. */
  readonly signal?: AbortSignal
  /** Per-clue progress (UI feedback). */
  readonly onProgress?: (progress: ClueShareImportProgress) => void
  /**
   * Receiver-side locator remapping. A portable locator may name the SENDER's
   * workspace id or an absolute path from the sender's machine; only a
   * receiving-side choice can turn that into a local address. Return a
   * locator to import live, or `undefined` to keep the row unresolved with a
   * clear reason. The default remaps `builtin.files` workspace-relative
   * locators to `workspaceId` and refuses external absolute paths.
   */
  readonly remapLocator?: (input: {
    readonly sourceId: string
    readonly typeId: string
    readonly locator: Locator
    readonly workspaceId: string
  }) => Locator | undefined
}

/** One progress notification of an import. */
export interface ClueShareImportProgress {
  readonly phase: 'validate' | 'clue' | 'snapshot' | 'pack' | 'done'
  readonly completed: number
  readonly total: number
  readonly key?: string
  readonly status?: 'ok' | 'issue'
  readonly reason?: string
}

/** One source requirement shown by the import confirmation screen. */
export interface ClueShareImportSourcePreview {
  readonly key: string
  readonly sourceId: string
  readonly name?: string
  /** Whether this machine has a source with that id. */
  readonly installed: boolean
  /** Type ids the archive needs that the installed source does not offer. */
  readonly missingTypeIds: readonly string[]
}

/** One clue as the import confirmation screen shows it. */
export interface ClueShareImportItemPreview {
  readonly key: string
  readonly title: string
  readonly sourceId: string
  readonly typeId: string
  readonly portable: boolean
  readonly snapshot: boolean
  /** True when this import will keep the row unresolved rather than live. */
  readonly willBeUnresolved: boolean
}

/** Result of `previewImport` (no side effects). */
export interface ClueShareImportPreview {
  readonly workspaceId: string
  readonly mode: CluepackMode
  readonly exportedAt: string
  /** Pack names in archive order (the UI shows them in the confirmation). */
  readonly packNames: readonly string[]
  readonly packs: readonly {
    readonly key: string
    readonly name: string
    readonly members: number
    readonly snapshotMembers: number
  }[]
  readonly items: readonly ClueShareImportItemPreview[]
  readonly sources: readonly ClueShareImportSourcePreview[]
  /** Source ids this machine cannot resolve at all. */
  readonly missingSources: readonly string[]
  readonly snapshotCount: number
  /** Clues that will be persisted as unresolved. */
  readonly unresolvedCount: number
  /** Issues recorded by the exporter (the shared pack itself is incomplete). */
  readonly issues: readonly CluepackIssue[]
  readonly warnings: readonly string[]
}

/** One clue committed by `importPack`. */
export interface ClueShareImportedClue {
  readonly clueKey: string
  readonly clueId: string
  readonly title: string
  readonly created: boolean
  readonly unresolved: boolean
  readonly snapshotId?: string
}

/** One pack committed by `importPack`. */
export interface ClueShareImportedPack {
  readonly key: string
  readonly name: string
  readonly packId: string
  readonly members: number
}

/** One snapshot committed by `importPack`. */
export interface ClueShareImportedSnapshot {
  readonly clueKey: string
  readonly snapshotId: string
  readonly fetchedAt: string
  readonly format: string
}

/** Result of `importPack`. */
export interface ClueShareImportResult {
  readonly workspaceId: string
  readonly mode: CluepackMode
  readonly clues: readonly ClueShareImportedClue[]
  readonly packs: readonly ClueShareImportedPack[]
  readonly snapshots: readonly ClueShareImportedSnapshot[]
  /** Import failures + the exporter's own issues. */
  readonly issues: readonly CluepackIssue[]
  /** The exporter's issues, kept separately for the summary UI. */
  readonly manifestIssues: readonly CluepackIssue[]
  /** True only when the archive and every commit step succeeded. */
  readonly complete: boolean
  /** True when at least one object could not be committed or was incomplete. */
  readonly partial: boolean
  /** Stable, user-readable failure reasons (duplicates removed). */
  readonly reasons: readonly string[]
}

/** Parsed snapshot payload, already integrity-checked. */
type ParsedSnapshotContent =
  | { readonly kind: 'json'; readonly format: string; readonly data: JsonValue; readonly text?: string }
  | { readonly kind: 'raw'; readonly bytes: Uint8Array }

/** One validated archive. */
interface ParsedArchive {
  readonly manifest: CluepackManifest
  readonly contents: ReadonlyMap<string, ParsedSnapshotContent>
}

/** Throw the fixed cancellation category when the caller aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ClueError('cancelled', 'the clue pack import was cancelled')
  }
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fixed category/message of one unexpected failure (never raw transport output). */
function failureOf(error: unknown): { category: ClueErrorCategory; reason: string } {
  if (error instanceof ClueError) return { category: error.category, reason: error.message }
  return { category: 'failed', reason: 'the clue pack operation failed' }
}

/** Verify one JSON snapshot payload matches its manifest descriptor. */
function parseJsonContent(bytes: Uint8Array, snapshotFormat: string, path: string): ParsedSnapshotContent {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new ClueError('invalid-request', `archive content "${path}" is not valid UTF-8 JSON`)
  }
  if (!isRecord(value) || typeof value.format !== 'string' || !('data' in value)) {
    throw new ClueError('invalid-request', `archive content "${path}" is not a clue snapshot document`)
  }
  if (value.format !== snapshotFormat) {
    throw new ClueError('invalid-request', `archive content "${path}" format does not match the manifest`)
  }
  if (value.text !== undefined && typeof value.text !== 'string') {
    throw new ClueError('invalid-request', `archive content "${path}" has a non-string text projection`)
  }
  return {
    kind: 'json',
    format: value.format,
    data: value.data as JsonValue,
    ...(value.text === undefined ? {} : { text: value.text }),
  }
}

/**
 * Parse and integrity-check one archive (no writes, no source operations).
 * @param deps - service + ZIP limits.
 * @param bytes - untrusted archive bytes.
 */
function loadArchive(deps: ClueShareImportDeps, bytes: Uint8Array): ParsedArchive {
  const entries = readZip(bytes, deps.zipLimits)
  const manifestEntry = entries.find(entry => entry.name === CLUEPACK_MANIFEST_PATH)
  if (manifestEntry === undefined) {
    throw new ClueError('invalid-request', 'the cluepack archive has no manifest.json')
  }
  const manifest = parseCluepackManifestBytes(manifestEntry.data)
  const byName = new Map(entries.map(entry => [entry.name, entry.data]))
  const contents = new Map<string, ParsedSnapshotContent>()
  for (const clue of manifest.clues) {
    if (clue.snapshot === undefined) continue
    const snapshot = clue.snapshot
    const data = byName.get(snapshot.path)
    if (data === undefined) {
      throw new ClueError('invalid-request', `archive content "${snapshot.path}" is missing`)
    }
    if (data.byteLength !== snapshot.bytes) {
      throw new ClueError(
        'invalid-request',
        `archive content "${snapshot.path}" does not match its declared size`,
      )
    }
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== snapshot.sha256) {
      throw new ClueError('invalid-request', `archive content "${snapshot.path}" failed the checksum check`)
    }
    contents.set(
      snapshot.path,
      snapshot.encoding === 'raw'
        ? { kind: 'raw', bytes: data }
        : parseJsonContent(data, snapshot.format, snapshot.path),
    )
  }
  return { manifest, contents }
}

/** Resolve the package clue's source record (validated during parse). */
function requireSource(manifest: CluepackManifest, clue: CluepackClue): CluepackSource {
  const source = manifest.sources.find(candidate => candidate.key === clue.sourceKey)
  if (source === undefined) {
    // The manifest validator guarantees this cannot happen; keep a typed
    // failure so a future validator change cannot silently import a
    // half-known clue.
    throw new ClueError('invalid-request', `clue "${clue.key}" references an unknown source`)
  }
  return source
}

/** The receiving-side locator of one portable reference, or why it cannot be used. */
interface RemappedLocator {
  readonly locator?: Locator
  readonly reason?: string
}

/**
 * Default remapping for the core file source: a workspace-relative locator is
 * re-rooted at the RECEIVING workspace; an external absolute path is not
 * silently opened on this machine (the user must choose a target explicitly).
 */
function defaultRemapLocator(sourceId: string, locator: Locator, workspaceId: string): RemappedLocator {
  if (sourceId !== BUILTIN_SOURCE_IDS.files) return { locator }
  const root = isRecord(locator.root) ? locator.root : undefined
  if (root?.kind === 'workspace') {
    return { locator: { ...locator, root: { ...root, workspaceId } } }
  }
  if (root?.kind === 'external') {
    return {
      reason: 'an absolute path outside a workspace needs an explicit receiving-workspace remapping',
    }
  }
  return { locator }
}

/** Apply the caller's remap seam, or the core default. */
function remapForImport(
  params: ClueShareImportParams,
  clue: CluepackClue,
  source: CluepackSource,
): RemappedLocator {
  const locator = clue.portable.locator
  if (clue.portable.portable !== true || locator === undefined) return {}
  if (params.remapLocator !== undefined) {
    const mapped = params.remapLocator({
      sourceId: source.sourceId,
      typeId: clue.typeId,
      locator,
      workspaceId: params.workspaceId,
    })
    return mapped === undefined
      ? { reason: 'the reference needs an explicit receiving-workspace remapping' }
      : { locator: mapped }
  }
  return defaultRemapLocator(source.sourceId, locator, params.workspaceId)
}

/** Whether one clue can be imported live (portable + source + type present). */
function canResolve(
  deps: ClueShareImportDeps,
  clue: CluepackClue,
  source: CluepackSource,
  locator: Locator | undefined,
): boolean {
  return locator !== undefined
    && deps.clues.getSource(source.sourceId) !== undefined
    && deps.clues.getTypes(source.sourceId).some(type => type.typeId === clue.typeId)
}

/**
 * Preview one import: parse + verify the archive, label source availability
 * from the local registry, and report unresolved/snapshot counts. It NEVER
 * calls a source operation, installs a plugin/CLI, starts authorization or
 * writes to the library.
 * @param deps - service + ZIP limits.
 * @param params - workspace and archive bytes.
 */
export async function previewImport(
  deps: ClueShareImportDeps,
  params: ClueShareImportParams,
): Promise<ClueShareImportPreview> {
  throwIfAborted(params.signal)
  if (typeof params.workspaceId !== 'string' || params.workspaceId.trim() === '') {
    throw new ClueError('invalid-request', 'a non-empty workspace id is required')
  }
  const { manifest } = loadArchive(deps, params.bytes)
  throwIfAborted(params.signal)
  const sourceById = new Map(manifest.sources.map(source => [source.key, source]))
  const sourceRows = new Map<string, ClueShareImportSourcePreview>()
  const items: ClueShareImportItemPreview[] = []
  let unresolvedCount = 0
  for (const clue of manifest.clues) {
    const source = sourceById.get(clue.sourceKey)!
    const installed = deps.clues.getSource(source.sourceId) !== undefined
    const missingTypes = installed
      ? (deps.clues.getTypes(source.sourceId).some(type => type.typeId === clue.typeId)
        ? []
        : [clue.typeId])
      : [clue.typeId]
    const existing = sourceRows.get(source.key)
    if (existing === undefined) {
      sourceRows.set(source.key, {
        key: source.key,
        sourceId: source.sourceId,
        ...(source.name === undefined ? {} : { name: source.name }),
        installed,
        missingTypeIds: missingTypes,
      })
    } else if (missingTypes.length > 0 && existing.missingTypeIds.length === 0) {
      sourceRows.set(source.key, { ...existing, missingTypeIds: missingTypes })
    }
    const remapped = remapForImport(params, clue, source)
    const willBeUnresolved = !canResolve(deps, clue, source, remapped.locator)
    if (willBeUnresolved) unresolvedCount += 1
    items.push({
      key: clue.key,
      title: clue.title,
      sourceId: source.sourceId,
      typeId: clue.typeId,
      portable: clue.portable.portable === true && clue.portable.locator !== undefined,
      snapshot: clue.snapshot !== undefined,
      willBeUnresolved,
    })
  }
  const sources = [...sourceRows.values()]
  const missingSources = [...new Set(sources.filter(source => !source.installed).map(source => source.sourceId))]
  const warnings = [...manifest.issues.map(issue => issue.reason)]
  for (const source of missingSources) {
    warnings.push(`source "${source}" is not installed on this machine; its references stay unresolved`)
  }
  for (const source of sources) {
    for (const typeId of source.missingTypeIds) {
      warnings.push(`source "${source.sourceId}" does not offer type "${typeId}" here`)
    }
  }
  return {
    workspaceId: params.workspaceId,
    mode: manifest.mode,
    exportedAt: manifest.exportedAt,
    packNames: manifest.packs.map(pack => pack.name),
    packs: manifest.packs.map(pack => ({
      key: pack.key,
      name: pack.name,
      members: pack.members.length,
      snapshotMembers: pack.members.filter(member =>
        manifest.clues.find(clue => clue.key === member)?.snapshot !== undefined).length,
    })),
    items,
    sources,
    missingSources,
    snapshotCount: manifest.clues.filter(clue => clue.snapshot !== undefined).length,
    unresolvedCount,
    issues: manifest.issues,
    warnings,
  }
}

/**
 * Commit one validated archive into the local library.
 * @param deps - service + ZIP limits.
 * @param params - workspace, archive bytes, progress and abort signal.
 */
export async function importPack(
  deps: ClueShareImportDeps,
  params: ClueShareImportParams,
): Promise<ClueShareImportResult> {
  throwIfAborted(params.signal)
  if (typeof params.workspaceId !== 'string' || params.workspaceId.trim() === '') {
    throw new ClueError('invalid-request', 'a non-empty workspace id is required')
  }
  const archive = loadArchive(deps, params.bytes)
  throwIfAborted(params.signal)
  const { manifest, contents } = archive
  const workspaceId = params.workspaceId
  const issues: CluepackIssue[] = [...manifest.issues]
  const clues: ClueShareImportedClue[] = []
  const snapshots: ClueShareImportedSnapshot[] = []
  /** Package clue key → local clue id (packs are built from this). */
  const localIdByKey = new Map<string, string>()
  const progress = params.onProgress ?? (() => undefined)
  const total = manifest.clues.length
  progress({ phase: 'validate', completed: 0, total })

  /**
   * Persist one unresolved row. A registered source may refuse to normalize
   * the imported portable locator (e.g. a foreign workspace root); in that
   * case the row is still kept, with the explicit reason and no locator,
   * rather than failing the whole pack.
   */
  const commitUnresolved = async (
    source: CluepackSource,
    clue: CluepackClue,
    reason: string,
  ): Promise<{ clueId: string; created: boolean }> => {
    const common = {
      workspaceId,
      sourceId: source.sourceId,
      typeId: clue.typeId,
      locator: {},
      title: clue.title,
      reason,
    }
    const options = { caller: 'ui' as const, ...(params.signal === undefined ? {} : { signal: params.signal }) }
    try {
      const imported = await deps.clues.importUnresolved({ ...common, portable: clue.portable }, options)
      return { clueId: imported.clue.id, created: imported.created }
    } catch (error) {
      if (!isClueError(error) || error.category !== 'invalid-request') throw error
      const imported = await deps.clues.importUnresolved({
        ...common,
        portable: { portable: false, reason },
      }, options)
      return { clueId: imported.clue.id, created: imported.created }
    }
  }

  for (const [index, clue] of manifest.clues.entries()) {
    throwIfAborted(params.signal)
    const source = requireSource(manifest, clue)
    let clueId: string
    let created: boolean
    let unresolved = false
    let itemIssue = false
    const remapped = remapForImport(params, clue, source)
    const live = canResolve(deps, clue, source, remapped.locator)
    if (live) {
      try {
        const ensured = await deps.clues.ensure({
          workspaceId,
          sourceId: source.sourceId,
          typeId: clue.typeId,
          locator: remapped.locator!,
          title: clue.title,
        }, { caller: 'ui', ...(params.signal === undefined ? {} : { signal: params.signal }) })
        clueId = ensured.clue.id
        created = ensured.created
      } catch (error) {
        if (params.signal?.aborted === true) throwIfAborted(params.signal)
        const failure = failureOf(error)
        // The source is present but could not even normalize/store the
        // reference. Preserve the data as unresolved and surface the failure:
        // hiding it would make a half-imported pack look complete.
        const imported = await commitUnresolved(source, clue, failure.reason)
        clueId = imported.clueId
        created = imported.created
        unresolved = true
        itemIssue = true
        issues.push({ target: 'clue', key: clue.key, category: failure.category, reason: failure.reason })
      }
    } else {
      const reason = remapped.reason
        ?? (deps.clues.getSource(source.sourceId) === undefined
          ? `the source "${source.sourceId}" is not installed on this machine`
          : clue.portable.portable === true && clue.portable.locator !== undefined
            ? `the source "${source.sourceId}" does not offer type "${clue.typeId}" here`
            : clue.portable.reason ?? 'the clue has no portable reference')
      const imported = await commitUnresolved(source, clue, reason)
      clueId = imported.clueId
      created = imported.created
      unresolved = true
    }
    localIdByKey.set(clue.key, clueId)
    let snapshotId: string | undefined
    if (clue.snapshot !== undefined) {
      const content = contents.get(clue.snapshot.path)!
      try {
        throwIfAborted(params.signal)
        const meta: ClueSnapshotMeta = await deps.clues.putSnapshot(workspaceId, {
          clueId,
          format: clue.snapshot.format,
          fetchedAt: clue.snapshot.fetchedAt,
          ...(clue.snapshot.sourceVersion === undefined ? {} : { sourceVersion: clue.snapshot.sourceVersion }),
          integrity: 'verified',
          ...(content.kind === 'json'
            ? {
              data: content.data,
              ...(content.text === undefined ? {} : { text: content.text }),
            }
            : {
              // Raw bytes are preserved exactly (base64 is a transport
              // encoding, not a rewrite): S1 snapshot storage is JSON-only.
              data: {
                kind: 'binary',
                mediaType: clue.snapshot.mediaType,
                size: clue.snapshot.bytes,
                sha256: clue.snapshot.sha256,
                encoding: 'base64',
                base64: Buffer.from(content.bytes).toString('base64'),
              } as JsonValue,
            }),
        })
        snapshotId = meta.snapshotId
        snapshots.push({
          clueKey: clue.key,
          snapshotId,
          fetchedAt: meta.fetchedAt,
          format: meta.format,
        })
        progress({ phase: 'snapshot', completed: index + 1, total, key: clue.key, status: 'ok' })
      } catch (error) {
        if (params.signal?.aborted === true) throwIfAborted(params.signal)
        itemIssue = true
        const failure = failureOf(error)
        issues.push({ target: 'clue', key: clue.key, category: failure.category, reason: failure.reason })
        progress({
          phase: 'snapshot',
          completed: index + 1,
          total,
          key: clue.key,
          status: 'issue',
          reason: failure.reason,
        })
      }
    }
    clues.push({
      clueKey: clue.key,
      clueId,
      title: clue.title,
      created,
      unresolved,
      ...(snapshotId === undefined ? {} : { snapshotId }),
    })
    progress({
      phase: 'clue',
      completed: index + 1,
      total,
      key: clue.key,
      status: itemIssue ? 'issue' : 'ok',
      ...(unresolved ? { reason: 'imported unresolved' } : {}),
    })
  }

  // Packs LAST: they are the visible object the user asked for, so a pack is
  // only created once every clue/snapshot commit was attempted.
  const packs: ClueShareImportedPack[] = []
  for (const [index, pack] of manifest.packs.entries()) {
    throwIfAborted(params.signal)
    const members = pack.members
      .map(member => localIdByKey.get(member))
      .filter((member): member is string => member !== undefined)
    if (members.length !== pack.members.length) {
      issues.push({
        target: 'pack',
        key: pack.key,
        category: 'failed',
        reason: `pack "${pack.name}" has members that were not imported`,
      })
    }
    try {
      const created: CluePack = (await deps.clues.createPack({
        workspaceId,
        name: pack.name.slice(0, MAX_PACK_NAME),
        members,
      }, { caller: 'ui', ...(params.signal === undefined ? {} : { signal: params.signal }) })).pack
      packs.push({ key: pack.key, name: pack.name, packId: created.id, members: created.members.length })
      progress({ phase: 'pack', completed: index + 1, total: manifest.packs.length, key: pack.key, status: 'ok' })
    } catch (error) {
      if (params.signal?.aborted === true) throwIfAborted(params.signal)
      const failure = failureOf(error)
      issues.push({ target: 'pack', key: pack.key, category: failure.category, reason: failure.reason })
      progress({
        phase: 'pack',
        completed: index + 1,
        total: manifest.packs.length,
        key: pack.key,
        status: 'issue',
        reason: failure.reason,
      })
    }
  }

  const reasons = [...new Set(issues.map(issue => issue.reason))]
  const complete = issues.length === 0
  progress({ phase: 'done', completed: total, total, status: complete ? 'ok' : 'issue' })
  return {
    workspaceId,
    mode: manifest.mode,
    clues,
    packs,
    snapshots,
    issues,
    manifestIssues: manifest.issues,
    complete,
    partial: !complete,
    reasons,
  }
}
