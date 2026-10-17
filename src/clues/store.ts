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
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
 * @param root - plugin user-data directory.
 * @param workspaceId - host-stable workspace id.
 */
export function workspaceStoreDir(root: string, workspaceId: string): string {
  return join(root, WORKSPACES_DIR, encodeURIComponent(workspaceId))
}

/** The state document path of one workspace (exposed for diagnostics/tests). */
export function workspaceStatePath(root: string, workspaceId: string): string {
  return join(workspaceStoreDir(root, workspaceId), STATE_FILE)
}

/** The snapshot directory path of one workspace. */
export function workspaceSnapshotDir(root: string, workspaceId: string): string {
  return join(workspaceStoreDir(root, workspaceId), SNAPSHOT_DIR)
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
  return {
    revision: raw.revision,
    clues: raw.clues as Clue[],
    packs: raw.packs as CluePack[],
    pins: raw.pins as CluePin[],
    bindings: raw.bindings as ClueBinding[],
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
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
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
      metas.push(parseSnapshotMeta(parsed, workspaceId, name))
    }
    return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.snapshotId.localeCompare(b.snapshotId))
  }

  /** Read one snapshot's metadata file only. */
  async readSnapshotMeta(workspaceId: string, snapshotId: string): Promise<ClueSnapshotMeta> {
    this.requireWorkspaceId(workspaceId)
    const path = join(
      workspaceSnapshotDir(this.rootOrThrow(), workspaceId),
      `${encodeURIComponent(snapshotId)}${META_SUFFIX}`,
    )
    const parsed = await readJsonFile(path)
    if (parsed === undefined) {
      throw new ClueError('not-found', `clue snapshot "${snapshotId}" does not exist`)
    }
    return parseSnapshotMeta(parsed, workspaceId, path)
  }

  /** Read one snapshot's content file only (independent of any source). */
  async readSnapshotContent(workspaceId: string, snapshotId: string): Promise<ClueSnapshotContent> {
    this.requireWorkspaceId(workspaceId)
    const path = join(
      workspaceSnapshotDir(this.rootOrThrow(), workspaceId),
      `${encodeURIComponent(snapshotId)}${CONTENT_SUFFIX}`,
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
    const dir = workspaceSnapshotDir(this.rootOrThrow(), workspaceId)
    await writeJsonAtomic(join(dir, `${encodeURIComponent(meta.snapshotId)}${CONTENT_SUFFIX}`), content)
    await writeJsonAtomic(join(dir, `${encodeURIComponent(meta.snapshotId)}${META_SUFFIX}`), meta)
    return cloneJson(meta)
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

/** Validate one stored snapshot metadata document. */
function parseSnapshotMeta(raw: unknown, workspaceId: string, source: string): ClueSnapshotMeta {
  if (
    !isRecord(raw)
    || typeof raw.snapshotId !== 'string'
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
