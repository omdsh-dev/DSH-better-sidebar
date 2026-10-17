/**
 * Durable clue storage (S1): one state file per host workspace plus one file
 * pair per imported snapshot.
 *
 * Layout (under the plugin's own user-data directory, which is rooted at the
 * DSH profile home):
 *
 * ```
 * workspaces/<encoded workspaceId>/state.json
 * workspaces/<encoded workspaceId>/snapshots/<snapshotId>.meta.json
 * workspaces/<encoded workspaceId>/snapshots/<snapshotId>.content.json
 * ```
 *
 * The workspace component is percent-encoded with `%2E` standing in for every
 * dot, so no id (including `.`/`..`) can address the workspaces root itself.
 *
 * Guarantees this module owns:
 * - **atomic writes** — a uniquely named temp sibling is renamed into place, so
 *   a crash never leaves a truncated state document;
 * - **one serial writer per workspace** — concurrent mutations are queued, so
 *   two callers cannot interleave read-modify-write cycles;
 * - **revision CAS** — a transaction handed a stale `expectedRevision` is
 *   refused with `conflict` and the previous data stays on disk;
 * - **loud corruption** — an unparseable/malformed document raises an explicit
 *   error instead of being silently replaced with an empty library (which
 *   would erase every stable reference);
 * - **snapshot separation** — metadata and content are separate files, so a
 *   snapshot can be read without the source that produced it (and a future
 *   cache eviction can never touch it).
 */
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  ClueError,
  type Clue,
  type ClueBinding,
  type CluePack,
  type CluePin,
  type ClueSnapshotContent,
  type ClueSnapshotMeta,
} from './types.ts'

/** The authoritative in-memory shape of one workspace's clue library. */
export interface WorkspaceState {
  /** Monotonic revision; incremented on every committed write. */
  revision: number
  clues: Clue[]
  packs: CluePack[]
  pins: CluePin[]
  bindings: ClueBinding[]
}

/** Result of one committed transaction. */
export interface ClueTransactionResult<T> {
  /** The workspace revision AFTER the commit. */
  revision: number
  result: T
}

/** Options of {@link CluesStore}. */
export interface CluesStoreOptions {
  /**
   * The plugin user-data directory. Undefined (no profile home) leaves the
   * store unavailable: every persistence call raises a clear error instead of
   * pretending the library is empty.
   */
  root?: string
}

const STATE_FILE = 'state.json'
const SNAPSHOT_DIR = 'snapshots'
const WORKSPACES_DIR = 'workspaces'
const META_SUFFIX = '.meta.json'
const CONTENT_SUFFIX = '.content.json'

/** A fresh, empty workspace library. */
export function emptyWorkspaceState(): WorkspaceState {
  return { revision: 0, clues: [], packs: [], pins: [], bindings: [] }
}

/** Whether a value is a plain JSON object (not null / array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Clone a JSON document without touching the caller's object. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * The directory owning one workspace's library.
 *
 * The id is percent-encoded, but `encodeURIComponent` leaves dots untouched:
 * the ids `..` and `.` would then name the workspaces root (or its parent)
 * instead of a child directory, and two workspaces could end up sharing one
 * state file. Escaping every dot before joining, plus the containment check
 * below, keeps each id in exactly one directory under `workspaces/`.
 * @param root - plugin user-data directory.
 * @param workspaceId - host-stable workspace id.
 */
export function workspaceStoreDir(root: string, workspaceId: string): string {
  const workspacesRoot = join(root, WORKSPACES_DIR)
  const component = encodeStorageComponent(workspaceId, 'workspace id').replaceAll('.', '%2E')
  const dir = join(workspacesRoot, component)
  const relativePath = relative(workspacesRoot, dir)
  if (
    relativePath === ''
    || isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
  ) {
    throw new ClueError('failed', `the workspace id "${workspaceId}" is not a valid clue storage name`)
  }
  return dir
}

/**
 * Percent-encode one caller-supplied id for use as a filename component.
 *
 * `encodeURIComponent` throws a raw URIError for a lone surrogate; the store's
 * public contract is the fixed {@link ClueError} vocabulary, so a malformed id
 * must not escape as an untyped exception callers cannot branch on.
 */
function encodeStorageComponent(id: string, what: string): string {
  if (typeof id !== 'string' || id === '') {
    throw new ClueError('failed', `the ${what} must be a non-empty string`)
  }
  try {
    return encodeURIComponent(id)
  } catch {
    throw new ClueError('failed', `the ${what} is not a valid clue storage name`)
  }
}

/** Path of one snapshot half (`<encoded id><suffix>` inside the snapshot dir). */
function snapshotFilePath(dir: string, snapshotId: string, suffix: string): string {
  return join(dir, `${encodeStorageComponent(snapshotId, 'snapshot id')}${suffix}`)
}

/** The state document path of one workspace (exposed for diagnostics/tests). */
export function workspaceStatePath(root: string, workspaceId: string): string {
  return join(workspaceStoreDir(root, workspaceId), STATE_FILE)
}

/** The snapshot directory path of one workspace. */
export function workspaceSnapshotDir(root: string, workspaceId: string): string {
  return join(workspaceStoreDir(root, workspaceId), SNAPSHOT_DIR)
}

/** A loud corruption failure with the document and row context. */
function corrupt(workspaceId: string, detail: string): never {
  throw new ClueError(
    'failed',
    `clue library for workspace "${workspaceId}" is corrupt: ${detail}`,
  )
}

/** Whether a stored row is a non-empty string field. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Validate one stored clue row (a malformed element must fail loudly). */
function parseClueRow(raw: unknown, workspaceId: string, index: number): Clue {
  if (
    !isRecord(raw)
    || !isNonEmptyString(raw.id)
    || !isNonEmptyString(raw.sourceId)
    || !isNonEmptyString(raw.typeId)
    || !isRecord(raw.locator)
    || typeof raw.title !== 'string'
    || !isNonEmptyString(raw.workspaceId)
    || typeof raw.createdAt !== 'string'
    || typeof raw.updatedAt !== 'string'
  ) {
    corrupt(workspaceId, `clues[${index}] is not a valid clue row`)
  }
  // Shape alone is not ownership: a copied/corrupt state file could carry a
  // row from another workspace, and reading it here would mix two libraries.
  if (raw.workspaceId !== workspaceId) {
    corrupt(workspaceId, `clues[${index}] belongs to workspace "${String(raw.workspaceId)}"`)
  }
  // The optional unresolved marker is part of the durable shape (S7 imports a
  // reference before its source exists): a malformed marker must fail loudly
  // instead of making every subsequent read a raw TypeError.
  if (raw.unresolved !== undefined) {
    const unresolved = raw.unresolved
    if (!isRecord(unresolved) || !isNonEmptyString(unresolved.reason)) {
      corrupt(workspaceId, `clues[${index}].unresolved is not a valid unresolved marker`)
    }
    if (unresolved.portable !== undefined) {
      const portable = unresolved.portable
      if (
        !isRecord(portable)
        || typeof portable.portable !== 'boolean'
        || (portable.locator !== undefined && !isRecord(portable.locator))
        || (portable.reason !== undefined && typeof portable.reason !== 'string')
      ) {
        corrupt(workspaceId, `clues[${index}].unresolved.portable is not a valid portable reference`)
      }
    }
  }
  return raw as unknown as Clue
}

/** Validate one stored pack row. */
function parsePackRow(raw: unknown, workspaceId: string, index: number): CluePack {
  if (
    !isRecord(raw)
    || !isNonEmptyString(raw.id)
    || typeof raw.name !== 'string'
    || !isNonEmptyString(raw.workspaceId)
    || !Array.isArray(raw.members)
    || raw.members.some(member => !isNonEmptyString(member))
    || typeof raw.revision !== 'number'
    || !Number.isInteger(raw.revision)
    || raw.revision < 0
    || typeof raw.createdAt !== 'string'
    || typeof raw.updatedAt !== 'string'
  ) {
    corrupt(workspaceId, `packs[${index}] is not a valid pack row`)
  }
  if (raw.workspaceId !== workspaceId) {
    corrupt(workspaceId, `packs[${index}] belongs to workspace "${String(raw.workspaceId)}"`)
  }
  return raw as unknown as CluePack
}

/** Validate one stored pin row. */
function parsePinRow(raw: unknown, workspaceId: string, index: number): CluePin {
  if (
    !isRecord(raw)
    || !isNonEmptyString(raw.workspaceId)
    || !isNonEmptyString(raw.clueId)
    || typeof raw.createdAt !== 'string'
  ) {
    corrupt(workspaceId, `pins[${index}] is not a valid pin row`)
  }
  if (raw.workspaceId !== workspaceId) {
    corrupt(workspaceId, `pins[${index}] belongs to workspace "${String(raw.workspaceId)}"`)
  }
  return raw as unknown as CluePin
}

/** Validate one stored binding row. */
function parseBindingRow(raw: unknown, workspaceId: string, index: number): ClueBinding {
  const target = isRecord(raw) ? raw.target : undefined
  const validTarget = isRecord(target) && (
    (target.kind === 'clue' && isNonEmptyString(target.clueId))
    || (target.kind === 'pack' && isNonEmptyString(target.packId))
  )
  if (
    !isRecord(raw)
    || !isNonEmptyString(raw.workspaceId)
    || !validTarget
    || typeof raw.createdAt !== 'string'
  ) {
    corrupt(workspaceId, `bindings[${index}] is not a valid binding row`)
  }
  if (raw.workspaceId !== workspaceId) {
    corrupt(workspaceId, `bindings[${index}] belongs to workspace "${String(raw.workspaceId)}"`)
  }
  return raw as unknown as ClueBinding
}

/**
 * Reject a repeated stable id inside one state collection. Ids are the
 * library's durable identity: a duplicated row makes "find by id" ambiguous
 * and silently hides one of the two records, so the document is corrupt.
 */
function requireUniqueIds(rows: readonly { readonly id: string }[], key: string, workspaceId: string): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) corrupt(workspaceId, `${key} contains duplicate id "${row.id}"`)
    seen.add(row.id)
  }
}

/** Parse one stored state document, rejecting malformed shapes loudly. */
function parseState(text: string, workspaceId: string): WorkspaceState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ClueError(
      'failed',
      `clue library for workspace "${workspaceId}" is corrupt: ${STATE_FILE} is not valid JSON`,
    )
  }
  if (!isRecord(raw) || typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0) {
    throw new ClueError(
      'failed',
      `clue library for workspace "${workspaceId}" is corrupt: ${STATE_FILE} has no valid revision`,
    )
  }
  for (const key of ['clues', 'packs', 'pins', 'bindings'] as const) {
    if (!Array.isArray(raw[key])) {
      throw new ClueError(
        'failed',
        `clue library for workspace "${workspaceId}" is corrupt: ${STATE_FILE}.${key} is not an array`,
      )
    }
  }
  const document = raw as {
    revision: number
    clues: unknown[]
    packs: unknown[]
    pins: unknown[]
    bindings: unknown[]
  }
  const state: WorkspaceState = {
    revision: document.revision,
    // Deep validation: a `clues: [null]` document used to surface later as a
    // raw TypeError (or as a corrupt row in every consumer). The module's
    // contract is to fail loudly instead.
    clues: document.clues.map((row, index) => parseClueRow(row, workspaceId, index)),
    packs: document.packs.map((row, index) => parsePackRow(row, workspaceId, index)),
    pins: document.pins.map((row, index) => parsePinRow(row, workspaceId, index)),
    bindings: document.bindings.map((row, index) => parseBindingRow(row, workspaceId, index)),
  }
  requireUniqueIds(state.clues, 'clues', workspaceId)
  requireUniqueIds(state.packs, 'packs', workspaceId)
  return state
}

/** Whether a path exists (either half of a snapshot is enough to refuse). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Read one stored JSON file, or undefined when it does not exist. */
async function readJsonFile(path: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ClueError('failed', `clue storage is not readable: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ClueError('failed', `clue storage file "${path}" is corrupt: not valid JSON`)
  }
}

/** Write one JSON document atomically (unique temp sibling + rename). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    // `mkdir` belongs INSIDE the boundary: a read-only parent used to reject
    // with a raw EACCES instead of the store's fixed `failed` category.
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw new ClueError(
      'failed',
      `clue storage is not writable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * One per-workspace durable library. Instances are cheap; callers normally
 * share the one created by the clues service.
 */
export class CluesStore {
  private readonly root: string | undefined
  /** Per-workspace serial writer chain (settled promises, cleaned up). */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(options: CluesStoreOptions = {}) {
    this.root = options.root
  }

  /** Whether a storage root is configured. */
  get available(): boolean {
    return this.root !== undefined && this.root !== ''
  }

  /** The configured storage root (undefined when unavailable). */
  get rootDir(): string | undefined {
    return this.root
  }

  private rootOrThrow(): string {
    if (this.root === undefined || this.root === '') {
      throw new ClueError('failed', 'clue storage is unavailable: the DSH profile home is unknown')
    }
    return this.root
  }

  private requireWorkspaceId(workspaceId: string): void {
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      throw new ClueError('failed', 'clue storage requires a non-empty workspace id')
    }
  }

  /**
   * Read one workspace's committed state. A missing document is an empty
   * library (revision 0); a corrupt document is an explicit failure.
   * @param workspaceId - host-stable workspace id.
   */
  async read(workspaceId: string): Promise<WorkspaceState> {
    this.requireWorkspaceId(workspaceId)
    const path = workspaceStatePath(this.rootOrThrow(), workspaceId)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWorkspaceState()
      throw new ClueError('failed', `clue storage is not readable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return parseState(text, workspaceId)
  }

  /**
   * Commit one mutation serially and atomically.
   *
   * @param workspaceId - host-stable workspace id.
   * @param expectedRevision - optional CAS baseline (the state revision the
   *   caller based its edit on); a mismatch refuses with `conflict` and leaves
   *   the old document untouched.
   * @param mutate - mutates the freshly read state in place; its return value
   *   is handed back to the caller.
   * @returns the committed workspace revision plus the callback's result.
   */
  transact<T>(
    workspaceId: string,
    expectedRevision: number | undefined,
    mutate: (state: WorkspaceState) => T,
  ): Promise<ClueTransactionResult<T>> {
    this.requireWorkspaceId(workspaceId)
    return this.enqueue(workspaceId, async () => {
      const root = this.rootOrThrow()
      const state = await this.read(workspaceId)
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw new ClueError(
          'conflict',
          `clue library for workspace "${workspaceId}" changed: expected revision ${expectedRevision}, found ${state.revision}`,
        )
      }
      const result = mutate(state)
      state.revision += 1
      await writeJsonAtomic(workspaceStatePath(root, workspaceId), state)
      return { revision: state.revision, result: result === undefined ? result : cloneJson(result) }
    })
  }

  /**
   * Snapshot metadata rows of one workspace (newest first is NOT guaranteed;
   * callers order by {@link ClueSnapshotMeta.fetchedAt} when they need it).
   */
  async listSnapshots(workspaceId: string): Promise<ClueSnapshotMeta[]> {
    this.requireWorkspaceId(workspaceId)
    const dir = workspaceSnapshotDir(this.rootOrThrow(), workspaceId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ClueError('failed', `clue snapshots are not readable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const metas: ClueSnapshotMeta[] = []
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue
      const parsed = await readJsonFile(join(dir, name))
      if (parsed === undefined) continue
      // The filename IS the snapshot id (percent-encoded): a meta document
      // naming a different snapshot is corrupt, not a second row.
      const idPart = name.slice(0, -META_SUFFIX.length)
      let expectedId: string
      try {
        expectedId = decodeURIComponent(idPart)
      } catch {
        throw new ClueError('failed', `clue snapshot metadata "${name}" is corrupt: unreadable snapshot id`)
      }
      metas.push(parseSnapshotMeta(parsed, workspaceId, name, expectedId))
    }
    return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.snapshotId.localeCompare(b.snapshotId))
  }

  /** Read one snapshot's metadata file only. */
  async readSnapshotMeta(workspaceId: string, snapshotId: string): Promise<ClueSnapshotMeta> {
    this.requireWorkspaceId(workspaceId)
    const path = snapshotFilePath(
      workspaceSnapshotDir(this.rootOrThrow(), workspaceId),
      snapshotId,
      META_SUFFIX,
    )
    const parsed = await readJsonFile(path)
    if (parsed === undefined) {
      throw new ClueError('not-found', `clue snapshot "${snapshotId}" does not exist`)
    }
    return parseSnapshotMeta(parsed, workspaceId, path, snapshotId)
  }

  /** Read one snapshot's content file only (independent of any source). */
  async readSnapshotContent(workspaceId: string, snapshotId: string): Promise<ClueSnapshotContent> {
    this.requireWorkspaceId(workspaceId)
    const path = snapshotFilePath(
      workspaceSnapshotDir(this.rootOrThrow(), workspaceId),
      snapshotId,
      CONTENT_SUFFIX,
    )
    const parsed = await readJsonFile(path)
    if (parsed === undefined) {
      throw new ClueError('not-found', `clue snapshot content "${snapshotId}" does not exist`)
    }
    return parseSnapshotContent(parsed, snapshotId, path)
  }

  /** Read one snapshot (metadata + content). */
  async readSnapshot(workspaceId: string, snapshotId: string): Promise<{ meta: ClueSnapshotMeta; content: ClueSnapshotContent }> {
    const meta = await this.readSnapshotMeta(workspaceId, snapshotId)
    const content = await this.readSnapshotContent(workspaceId, snapshotId)
    return { meta, content }
  }

  /**
   * Persist one snapshot. Content is written first so a committed metadata
   * row can never point at missing content; both files are atomic.
   *
   * Snapshot ids are caller-visible stable identities: an existing id is
   * refused with `conflict` rather than silently overwriting the earlier
   * import's content/metadata.
   *
   * The existence check and both writes run inside the SAME per-workspace
   * writer queue: two concurrent puts of one id are serialized (otherwise both
   * could pass the check and the later one would silently win), and a failed
   * metadata write removes the content that was already committed, so the id
   * does not become permanently un-retryable.
   */
  async putSnapshot(
    workspaceId: string,
    meta: ClueSnapshotMeta,
    content: ClueSnapshotContent,
  ): Promise<ClueSnapshotMeta> {
    this.requireWorkspaceId(workspaceId)
    if (meta.workspaceId !== workspaceId) {
      throw new ClueError('failed', 'clue snapshot meta belongs to another workspace')
    }
    return this.enqueue(workspaceId, async () => {
      const dir = workspaceSnapshotDir(this.rootOrThrow(), workspaceId)
      const contentPath = snapshotFilePath(dir, meta.snapshotId, CONTENT_SUFFIX)
      const metaPath = snapshotFilePath(dir, meta.snapshotId, META_SUFFIX)
      if (await fileExists(metaPath) || await fileExists(contentPath)) {
        throw new ClueError('conflict', `clue snapshot "${meta.snapshotId}" already exists`)
      }
      let contentWritten = false
      try {
        await writeJsonAtomic(contentPath, content)
        contentWritten = true
        await writeJsonAtomic(metaPath, meta)
      } catch (error) {
        // The pair is one unit: a metadata failure must not leave orphan
        // content that makes this id conflict forever on retry.
        if (contentWritten) await rm(contentPath, { force: true }).catch(() => undefined)
        throw error
      }
      return cloneJson(meta)
    })
  }

  /** Run one task after every previously queued task of the same workspace. */
  private enqueue<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve()
    const run = previous.then(task)
    const settled = run.then(() => undefined, () => undefined)
    this.queues.set(workspaceId, settled)
    void settled.then(() => {
      if (this.queues.get(workspaceId) === settled) this.queues.delete(workspaceId)
    })
    return run
  }
}

/**
 * Validate one stored snapshot metadata document.
 *
 * `expectedSnapshotId` is the id the caller requested or the one encoded in
 * the file name: a metadata document that names another snapshot would let a
 * corrupted/copied file masquerade as a different import, so it is refused
 * loudly instead of being attributed to the requested id.
 */
function parseSnapshotMeta(
  raw: unknown,
  workspaceId: string,
  source: string,
  expectedSnapshotId: string,
): ClueSnapshotMeta {
  if (
    !isRecord(raw)
    || !isNonEmptyString(raw.snapshotId)
    || raw.snapshotId !== expectedSnapshotId
    || typeof raw.clueId !== 'string'
    || typeof raw.format !== 'string'
    || typeof raw.fetchedAt !== 'string'
    || typeof raw.createdAt !== 'string'
    || (raw.workspaceId !== undefined && raw.workspaceId !== workspaceId)
  ) {
    throw new ClueError('failed', `clue snapshot metadata "${source}" is corrupt`)
  }
  return {
    snapshotId: raw.snapshotId,
    workspaceId,
    clueId: raw.clueId,
    format: raw.format,
    fetchedAt: raw.fetchedAt,
    createdAt: raw.createdAt,
    ...(typeof raw.sourceVersion === 'string' ? { sourceVersion: raw.sourceVersion } : {}),
    ...(raw.integrity === 'verified' || raw.integrity === 'unknown' ? { integrity: raw.integrity } : {}),
  }
}

/** Validate one stored snapshot content document. */
function parseSnapshotContent(raw: unknown, snapshotId: string, source: string): ClueSnapshotContent {
  if (!isRecord(raw) || typeof raw.format !== 'string' || !('data' in raw)) {
    throw new ClueError('failed', `clue snapshot content "${source}" is corrupt (snapshot ${snapshotId})`)
  }
  return raw as unknown as ClueSnapshotContent
}
