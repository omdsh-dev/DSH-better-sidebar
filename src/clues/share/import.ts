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
 *   write — it only reads the local registry and library to label
 *   availability;
 * - the importer never touches bindings or pins (no inherited workspace
 *   binding, nothing pinned by default);
 * - an explicit JSON-safe `remap` entry (package clue key → receiving-side
 *   locator, optional connection id) is the receiver's choice; without one, an
 *   external absolute path or ambiguous connection stays unresolved instead of
 *   being opened automatically (spec §3);
 * - an existing live clue is reused by `ensure`; its locator/title/read mode
 *   are never overwritten, and the imported content becomes an independent
 *   snapshot;
 * - a duplicate pack name produces a NEW pack (S1 has no overwrite path);
 * - raw asset bytes are preserved exactly by the archive and stored as a
 *   base64 JSON body because S1's snapshot store is JSON-only. `data.base64`
 *   decodes to the original bytes; no Markdown/projection rewrite happens.
 *
 * Cancellation (S1 offers no cross-object transaction or rollback — a clue,
 * a snapshot and a pack are three independent durable writes):
 * - a cancellation observed before the FIRST write throws `cancelled` and the
 *   target area is untouched;
 * - any cancellation or failure observed after at least one committed write
 *   stops at the next item boundary and returns an EXPLICIT partial result
 *   (`complete: false`, `partial: true`, `requiresAcceptance: true`) listing
 *   exactly what was committed. It is never reported as success and never a
 *   bare throw that would hide committed rows;
 * - a cancellation observed after EVERY write completed returns the normal
 *   result with `cancelled: true` (and `complete` as computed). It is fully
 *   applied, so retrying would duplicate the pack; the flag exists so a late
 *   abort is still visible instead of being silently swallowed.
 */
import { createHash } from 'node:crypto'
import { stableLocatorKey, type CluesService } from '../service.ts'
import {
  BUILTIN_SOURCE_IDS,
  ClueError,
  isClueError,
  type Clue,
  type ClueErrorCategory,
  type CluePack,
  type CluePortableRef,
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

/**
 * One explicit receiver-side remap of a package clue.
 *
 * Spec §3: an external absolute path (or a reference whose receiver connection
 * is ambiguous) is never opened automatically; the user chooses a local
 * address. `clueKey` comes from {@link ClueShareImportPreview.items}, so the
 * choice survives JSON/HTTP.
 */
export interface ClueShareLocatorRemap {
  /** Package clue key (`clue-1`), from the import preview. */
  readonly clueKey: string
  /** Receiving-side locator to use instead of the archived one. */
  readonly locator: Locator
  /**
   * Optional receiver connection selected by the user. When present it must
   * match the installed source's advertised `connectionId`; a same-named
   * connection on another account is never assumed to be the same. S1 exposes
   * at most one active descriptor per source id, so a choice for a connection
   * this mount does not expose stays unresolved with a readable reason rather
   * than silently using the wrong account (a true multi-connection switch
   * belongs to S1's registry seam, outside S7's write scope).
   */
  readonly connectionId?: string
}

/** Validate + copy a JSON-safe remap list from an API/route payload. */
export function parseClueShareRemap(value: unknown): ClueShareLocatorRemap[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new ClueError('invalid-request', '"remap" must be an array of receiving-side locator choices')
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ClueError('invalid-request', `"remap[${index}]" must be an object`)
    }
    const clueKey = entry.clueKey
    if (typeof clueKey !== 'string' || clueKey.trim() === '') {
      throw new ClueError('invalid-request', `"remap[${index}].clueKey" must be a non-empty string`)
    }
    if (seen.has(clueKey)) {
      throw new ClueError('invalid-request', `duplicate remap for clue "${clueKey}"`)
    }
    seen.add(clueKey)
    if (!isRecord(entry.locator)) {
      throw new ClueError('invalid-request', `"remap[${index}].locator" must be a JSON object`)
    }
    if (entry.connectionId !== undefined
      && (typeof entry.connectionId !== 'string' || entry.connectionId.trim() === '')) {
      throw new ClueError('invalid-request', `"remap[${index}].connectionId" must be a non-empty string`)
    }
    return {
      clueKey,
      locator: entry.locator as Locator,
      ...(entry.connectionId === undefined ? {} : { connectionId: entry.connectionId as string }),
    }
  })
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
   * JSON-safe receiver-side locator choices (API/raw-route seam). An entry
   * keyed by package clue key wins over the archived address, which is what
   * makes an external absolute path or an ambiguous connection explicitly
   * remappable by the user.
   */
  readonly remap?: readonly ClueShareLocatorRemap[]
  /**
   * Programmatic receiver-side locator remapping. A portable locator may name
   * the SENDER's workspace id or an absolute path from the sender's machine;
   * only a receiving-side choice can turn that into a local address. Return a
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
  /** The installed source's active connection id, when it advertises one. */
  readonly connectionId?: string
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
  /**
   * The archived credential-free locator, including an explicitly
   * non-portable hint (for the receiver's remap UI). It is never opened by the
   * preview; the receiver must choose a local address explicitly.
   */
  readonly locator?: Locator
  readonly snapshot: boolean
  /**
   * True when this import is expected to keep the row unresolved. Best-effort:
   * the preview compares the archived locator with the local library without
   * calling the source, so a source-specific `normalizeLocator` that accepts a
   * differently-shaped address is only confirmed by the actual commit.
   */
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
  /**
   * True when the caller aborted after at least one write. A cancellation
   * before the FIRST write throws; every cancellation after that is returned
   * explicitly. When all writes had already committed, `complete` stays true
   * and the archive is fully applied — the flag only says the abort was
   * observed late, so the caller must not retry (a retry would create a
   * duplicate pack).
   */
  readonly cancelled: boolean
  /**
   * True whenever `partial` is true: the caller must obtain explicit user
   * acceptance of the committed subset before treating the import as done.
   * A fully committed but late-cancelled import is not partial.
   */
  readonly requiresAcceptance: boolean
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

/**
 * Whether the caller aborted. A separate function (rather than an inline
 * `signal?.aborted === true`) keeps TypeScript from narrowing the property to
 * `false` for all following code after the first check.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
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

/**
 * Apply an EXPLICIT user choice (`remap`) first, then the programmatic seam,
 * then the core default. A non-portable locator is never auto-used: it is a
 * sender-side hint until the user explicitly remaps it (spec §3).
 */
function remapForImport(
  deps: ClueShareImportDeps,
  params: ClueShareImportParams,
  clue: CluepackClue,
  source: CluepackSource,
  explicitByKey: ReadonlyMap<string, ClueShareLocatorRemap> | undefined,
): RemappedLocator {
  const explicit = explicitByKey?.get(clue.key)
  if (explicit !== undefined) {
    if (explicit.connectionId !== undefined) {
      const installed = deps.clues.getSource(source.sourceId)
      if (installed?.connectionId !== explicit.connectionId) {
        return {
          reason: `the selected connection "${explicit.connectionId}" for source "${source.sourceId}" is not available on this machine`,
        }
      }
    }
    return { locator: explicit.locator }
  }
  const locator = clue.portable.locator
  if (locator === undefined) {
    return {
      reason: clue.portable.reason ?? 'the clue has no portable reference',
    }
  }
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
  if (clue.portable.portable !== true) {
    return {
      reason: clue.portable.reason
        ?? 'the archived non-portable locator needs an explicit receiving-side remapping',
    }
  }
  return defaultRemapLocator(source.sourceId, locator, params.workspaceId)
}

/**
 * Validate the explicit remap list against one manifest and index it by clue
 * key. An unknown key is refused instead of silently ignored: the UI should
 * have taken the key from the preview, and a stale choice must not look like
 * it was applied.
 */
function remapMapOf(
  manifest: CluepackManifest,
  value: unknown,
): ReadonlyMap<string, ClueShareLocatorRemap> | undefined {
  const entries = parseClueShareRemap(value)
  if (entries === undefined) return undefined
  const known = new Set(manifest.clues.map(clue => clue.key))
  for (const entry of entries) {
    if (!known.has(entry.clueKey)) {
      throw new ClueError('invalid-request', `"remap" names an unknown clue "${entry.clueKey}"`)
    }
  }
  return new Map(entries.map(entry => [entry.clueKey, entry]))
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

/** Stable lookup key of one source + locator pair. */
function addressKey(sourceId: string, locator: Locator): string {
  return `${sourceId}\u0000${stableLocatorKey(locator)}`
}

/**
 * Index the local library by every address an import could name.
 *
 * `ensure` / `importUnresolved` dedupe by the stored locator (or an unresolved
 * row's portable locator), so the preview builds the same address index once.
 * The archived locator is compared as-is: a source-specific normalization can
 * only be confirmed by the import commit, so the preview's `willBeUnresolved`
 * is explicitly best-effort for those sources.
 */
function indexStoredClues(clues: readonly Clue[]): ReadonlyMap<string, Clue> {
  const byAddress = new Map<string, Clue>()
  for (const clue of clues) {
    for (const locator of [clue.locator, clue.unresolved?.portable?.locator]) {
      if (locator === undefined) continue
      const key = addressKey(clue.sourceId, locator)
      if (!byAddress.has(key)) byAddress.set(key, clue)
    }
  }
  return byAddress
}

/**
 * Preview one import: parse + verify the archive, label source availability
 * from the local registry and LOCAL library, and report unresolved/snapshot
 * counts. It NEVER calls a source operation, installs a plugin/CLI, starts
 * authorization or writes to the library.
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
  const remapByKey = remapMapOf(manifest, params.remap)
  const library = await deps.clues.listClues(params.workspaceId)
  // A client can disconnect while the library read is in flight; the raw
  // route forwards the response-close signal, so the final answer must not be
  // a 200 preview after that abort.
  throwIfAborted(params.signal)
  const sourceById = new Map(manifest.sources.map(source => [source.key, source]))
  const manifestClueByKey = new Map(manifest.clues.map(clue => [clue.key, clue]))
  const storedByAddress = indexStoredClues(library.clues)
  const sourceRows = new Map<string, ClueShareImportSourcePreview>()
  const items: ClueShareImportItemPreview[] = []
  let unresolvedCount = 0
  for (const clue of manifest.clues) {
    throwIfAborted(params.signal)
    const source = sourceById.get(clue.sourceKey)!
    const descriptor = deps.clues.getSource(source.sourceId)
    const installed = descriptor !== undefined
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
        ...(descriptor?.connectionId === undefined ? {} : { connectionId: descriptor.connectionId }),
        missingTypeIds: missingTypes,
      })
    } else {
      const merged = [...new Set([...existing.missingTypeIds, ...missingTypes])]
      if (merged.length !== existing.missingTypeIds.length) {
        sourceRows.set(source.key, { ...existing, missingTypeIds: merged })
      }
    }
    const remapped = remapForImport(deps, params, clue, source, remapByKey)
    const live = canResolve(deps, clue, source, remapped.locator)
    // The importer persists the remapped address when it has one, so an
    // EXISTING resolved row for that same address is reused (created: false)
    // and must not be previewed as "will be unresolved".
    const address = remapped.locator ?? clue.portable.locator
    const reused = address === undefined
      ? undefined
      : storedByAddress.get(addressKey(source.sourceId, address))
    const willBeUnresolved = !live && !(reused !== undefined && reused.unresolved === undefined)
    if (willBeUnresolved) unresolvedCount += 1
    items.push({
      key: clue.key,
      title: clue.title,
      sourceId: source.sourceId,
      typeId: clue.typeId,
      portable: clue.portable.portable === true && clue.portable.locator !== undefined,
      ...(clue.portable.locator === undefined ? {} : { locator: clue.portable.locator }),
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
        manifestClueByKey.get(member)?.snapshot !== undefined).length,
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
 *
 * Writes are grouped per clue (clue row → snapshot) and packs come last. A
 * cancellation before the first write throws and touches nothing; a
 * cancellation after a committed write stops at the next item boundary and
 * returns the explicit partial result described in the module header, because
 * S1 has no cross-object transaction to roll the committed rows back.
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
  const remapByKey = remapMapOf(manifest, params.remap)
  const workspaceId = params.workspaceId
  const issues: CluepackIssue[] = [...manifest.issues]
  /** Mutable until its snapshot (if any) is attached. */
  interface PendingClue {
    clueKey: string
    clueId: string
    title: string
    created: boolean
    unresolved: boolean
    snapshotId?: string
  }
  const clues: PendingClue[] = []
  const snapshots: ClueShareImportedSnapshot[] = []
  const packs: ClueShareImportedPack[] = []
  /** Package clue key → local clue id (packs are built from this). */
  const localIdByKey = new Map<string, string>()
  const progress = params.onProgress ?? (() => undefined)
  const total = manifest.clues.length
  const packTotal = manifest.packs.length
  progress({ phase: 'validate', completed: 0, total })
  const options = { caller: 'ui' as const, ...(params.signal === undefined ? {} : { signal: params.signal }) }
  /** The item currently being committed (for a post-commit failure reason). */
  let active: { readonly target: 'clue' | 'pack'; readonly key: string } | undefined

  /** How many archive objects were durably committed so far. */
  const committedCount = (): number => clues.length + snapshots.length + packs.length

  /**
   * Return an EXPLICIT result once a failure/cancellation lands after at least
   * one durable write. S1 cannot roll the committed rows back, so hiding them
   * behind a bare throw would leave the user unaware of what this import
   * already added. Any non-cancellation failure is partial too: the module
   * contract says a commit failure never silently becomes success.
   */
  const partialResult = (error: unknown): ClueShareImportResult => {
    const cancelled = aborted(params.signal)
      && isClueError(error)
      && error.category === 'cancelled'
    const failure = failureOf(error)
    if (!cancelled) {
      const target = active ?? { target: 'clue' as const, key: 'manifest' }
      issues.push({
        target: target.target,
        key: target.key,
        category: failure.category,
        reason: failure.reason,
      })
    }
    const reason = cancelled
      ? `the clue pack import was cancelled after committing ${clues.length} of ${total} clues and ${packs.length} of ${packTotal} packs; the committed items remain in the library and need explicit acceptance`
      : `the clue pack import failed after committing ${clues.length} of ${total} clues and ${packs.length} of ${packTotal} packs: ${failure.reason}`
    const reasons = [...new Set([...issues.map(issue => issue.reason), reason])]
    progress({ phase: 'done', completed: total, total, status: 'issue', reason })
    return {
      workspaceId,
      mode: manifest.mode,
      clues,
      packs,
      snapshots,
      issues,
      manifestIssues: manifest.issues,
      complete: false,
      partial: true,
      cancelled,
      requiresAcceptance: true,
      reasons,
    }
  }

  /**
   * The portable carrier stored on an unresolved row.
   *
   * The RECEIVER-remapped locator wins over the sender's locator: `ensure`
   * dedupes a row by the stored portable locator, so persisting the sender's
   * workspace-rooted address meant a later `ensure` with this workspace's
   * address minted a second clue and left the orphan unresolved. When no
   * receiver remapping exists (e.g. an external absolute path), the sender's
   * credential-free locator is kept as an explicitly marked hint.
   */
  const unresolvedPortableOf = (
    clue: CluepackClue,
    remapped: RemappedLocator,
    reason: string,
  ): CluePortableRef => {
    const locator = remapped.locator ?? clue.portable.locator
    const portable = clue.portable.portable === true
    if (locator === undefined) return { portable: false, reason: clue.portable.reason ?? reason }
    return {
      portable,
      locator,
      ...(clue.portable.reason === undefined ? {} : { reason: clue.portable.reason }),
    }
  }

  /**
   * Persist one unresolved row.
   *
   * A registered source may refuse the imported address form (its
   * `normalizeLocator` rejects it). The row is still kept rather than failing
   * the whole pack, and the address is retained as an explicitly non-portable
   * hint for a later explicit remapping; only a locator S1 itself cannot
   * store at all is dropped, with the failure reason.
   */
  const commitUnresolved = async (
    source: CluepackSource,
    clue: CluepackClue,
    remapped: RemappedLocator,
    reason: string,
  ): Promise<{ clueId: string; title: string; created: boolean; unresolved: boolean }> => {
    const common = {
      workspaceId,
      sourceId: source.sourceId,
      typeId: clue.typeId,
      locator: {},
      title: clue.title,
      reason,
    }
    const attempt = (portable: CluePortableRef | undefined) => deps.clues.importUnresolved({
      ...common,
      ...(portable === undefined ? {} : { portable }),
    }, options)
    const preferred = unresolvedPortableOf(clue, remapped, reason)
    let imported
    try {
      imported = await attempt(preferred)
    } catch (error) {
      if (aborted(params.signal)) throw error
      if (!isClueError(error) || error.category !== 'invalid-request' || preferred.locator === undefined) throw error
      try {
        imported = await attempt({ portable: false, locator: preferred.locator, reason })
      } catch (retry) {
        if (aborted(params.signal)) throw retry
        if (!isClueError(retry) || retry.category !== 'invalid-request') throw retry
        imported = await attempt({ portable: false, reason })
      }
    }
    // importUnresolved may return an EXISTING resolved row (created:false),
    // in which case the imported clue is not unresolved at all.
    return {
      clueId: imported.clue.id,
      title: imported.clue.title,
      created: imported.created,
      unresolved: imported.clue.unresolved !== undefined,
    }
  }

  try {
    for (const [index, clue] of manifest.clues.entries()) {
      throwIfAborted(params.signal)
      const source = requireSource(manifest, clue)
      const remapped = remapForImport(deps, params, clue, source, remapByKey)
      const live = canResolve(deps, clue, source, remapped.locator)
      active = { target: 'clue', key: clue.key }
      let clueId: string
      let title: string
      let created: boolean
      let unresolved = false
      let itemIssue = false
      if (live) {
        try {
          const ensured = await deps.clues.ensure({
            workspaceId,
            sourceId: source.sourceId,
            typeId: clue.typeId,
            locator: remapped.locator!,
            title: clue.title,
          }, options)
          clueId = ensured.clue.id
          title = ensured.clue.title
          created = ensured.created
          unresolved = ensured.clue.unresolved !== undefined
        } catch (error) {
          if (aborted(params.signal)) throw error
          const failure = failureOf(error)
          // The source is present but could not even normalize/store the
          // reference. Preserve the data as unresolved and surface the
          // failure: hiding it would make a half-imported pack look complete.
          const imported = await commitUnresolved(source, clue, remapped, failure.reason)
          clueId = imported.clueId
          title = imported.title
          created = imported.created
          unresolved = imported.unresolved
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
        const imported = await commitUnresolved(source, clue, remapped, reason)
        clueId = imported.clueId
        title = imported.title
        created = imported.created
        unresolved = imported.unresolved
      }
      localIdByKey.set(clue.key, clueId)
      // Record the clue IMMEDIATELY after its row is durable. If the abort or
      // a failure lands before its snapshot, the partial result still names
      // the committed row (previously `clues.push` happened after the
      // snapshot, so a first-item abort looked like "nothing committed").
      const record: PendingClue = {
        clueKey: clue.key,
        clueId,
        title,
        created,
        unresolved,
      }
      clues.push(record)
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
          if (aborted(params.signal)) throw error
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
      if (snapshotId !== undefined) record.snapshotId = snapshotId
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
    for (const [index, pack] of manifest.packs.entries()) {
      throwIfAborted(params.signal)
      active = { target: 'pack', key: pack.key }
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
        }, options)).pack
        // Report the ACTUAL stored name (S1 trims/validates it), not the
        // archive's pre-normalization string.
        packs.push({ key: pack.key, name: created.name, packId: created.id, members: created.members.length })
        progress({ phase: 'pack', completed: index + 1, total: packTotal, key: pack.key, status: 'ok' })
      } catch (error) {
        if (aborted(params.signal)) throw error
        const failure = failureOf(error)
        issues.push({ target: 'pack', key: pack.key, category: failure.category, reason: failure.reason })
        progress({
          phase: 'pack',
          completed: index + 1,
          total: packTotal,
          key: pack.key,
          status: 'issue',
          reason: failure.reason,
        })
      }
    }
  } catch (error) {
    // Any failure/cancellation after a committed write is reported, never
    // thrown away: the committed rows are real and the caller must see them.
    // Before the first write there is nothing to accept, so the original
    // typed error is preserved.
    if (committedCount() > 0) return partialResult(error)
    throw error
  }

  // Every planned write has happened. A late abort is still surfaced through
  // `cancelled`, but it must not hide a fully committed import behind a bare
  // throw: a retry would create duplicate packs and the caller could not tell
  // "cancelled before writing" from "cancelled after everything applied".
  const cancelledAtEnd = aborted(params.signal)
  const reasons = [...new Set(issues.map(issue => issue.reason))]
  if (cancelledAtEnd) {
    reasons.push('the clue pack import completed before the cancellation was observed')
  }
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
    cancelled: cancelledAtEnd,
    requiresAcceptance: !complete,
    reasons,
  }
}
