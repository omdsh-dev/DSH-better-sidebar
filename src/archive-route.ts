/**
 * Helpers for the `/sidebar/archive` route (the file tree's "zip and
 * download" action): the download-name sanitizer and the recursive entry
 * walk. Kept apart from index.ts so both are directly unit-testable — the
 * walk's bounds live inside the collector, and the route module is a
 * cordis plugin whose setup needs a whole fake context.
 *
 * The walk is the security-relevant half: every row comes from an already
 * fenced path (index.ts resolves each selection through
 * `ensureWorkspacePath` first), and a symlink is skipped rather than followed,
 * so it can neither escape the workspace nor cycle.
 */
import { randomUUID } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SidebarError } from './wire.ts'
import { buildZip, ZIP_MAX_ENTRIES, type ZipEntry } from './zip.ts'

/** Maximum archive-name length (keeps the Content-Disposition header sane). */
export const ARCHIVE_NAME_MAX = 120

/**
 * Sanitize the archive's download name: one flat file name, never a path.
 * Separators, control characters, quotes and leading dots are stripped (a
 * name cannot look like a traversal or hide as a dotfile); an empty result
 * falls back to `archive.zip`, and a `.zip` suffix is applied once.
 */
export function archiveNameOf(raw: string | null): string {
  // A bare `.zip` (or nothing at all) is the caller asking for the default:
  // check BEFORE the leading-dot strip below, which would turn it into `zip`.
  const trimmed = (raw ?? '').trim()
  if (trimmed === '' || trimmed === '.zip') return 'archive.zip'
  // Character filter (not a character-class regex): separators, quotes and
  // C0/DEL control characters cannot survive into the header.
  const cleaned = [...trimmed]
    .filter((char) => {
      const code = char.codePointAt(0)!
      return char !== '\\' && char !== '/' && char !== '"' && char !== '\'' && code >= 0x20 && code !== 0x7F
    })
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, ARCHIVE_NAME_MAX)
  if (cleaned === '') return 'archive.zip'
  return cleaned.toLowerCase().endsWith('.zip') ? cleaned : `${cleaned}.zip`
}

/**
 * The `content-disposition` value for one archive download.
 *
 * A non-latin1 name (a Chinese folder → `报告.zip`) CANNOT go into the header
 * verbatim: Node's `writeHead` validates header values and rejects anything
 * above U+00FF with `Invalid character in header content` — the route turned
 * that into a 500. So the name is sent twice, exactly like `/sidebar/file`
 * does for a download: an ASCII-only `filename="…"` fallback for old clients
 * and the RFC 5987 `filename*=UTF-8''…` form (percent-encoded, therefore pure
 * ASCII) for everyone else, which wins in every current browser.
 */
export function contentDispositionOf(name: string): string {
  return `attachment; filename="${asciiFallbackOf(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * The ASCII-only fallback of a download name: characters a quoted header
 * string cannot carry (or that no latin1 client could render) drop out, and a
 * stray quote or backslash does too. A result with no stem left (`''` or a
 * bare extension, as a fully non-latin1 name reduces to) becomes
 * `download.zip`, so the header always names a usable file.
 */
function asciiFallbackOf(name: string): string {
  const ascii = [...name]
    .filter(char => {
      const code = char.codePointAt(0)!
      return code >= 0x20 && code <= 0x7E && char !== '"' && char !== '\\'
    })
    .join('')
  const stem = ascii.replace(/\.zip$/i, '')
  if (stem === '' || /^\.+$/.test(stem)) return 'download.zip'
  return ascii
}

/**
 * The in-archive name of every selection, disambiguated.
 *
 * The common case keeps the intuition "one selection is named by its own
 * basename" — archive `/ws/src` and the entries live under `src/`. Two
 * selections that would collide (multi-select `/ws/a/index.ts` and
 * `/ws/b/index.ts` both wanting `index.ts`) are extended with parent
 * segments until every name is unique, so an extractor cannot silently
 * overwrite one member with another. A path that runs out of ancestors
 * (selecting the filesystem root, or `/a` twice) falls back to the full
 * '/'-joined path, which is unique by construction.
 *
 * @param selections - absolute (already fenced) paths, in selection order.
 * @returns one '/'-separated archive name per selection, same order.
 */
export function disambiguateArchiveNames(selections: readonly string[]): string[] {
  const segmentsOf = (absolute: string, depth: number): string => {
    const parts: string[] = []
    let current = absolute
    for (let level = 0; level < depth; level += 1) {
      const part = basename(current)
      const parent = dirname(current)
      if (part === '' || parent === current) break
      parts.unshift(part)
      current = parent
    }
    return parts.join('/')
  }
  const deepEnough = (absolute: string, name: string): string => {
    const full = segmentsOf(absolute, Number.MAX_SAFE_INTEGER)
    // Still colliding after every segment is in play (two identical paths, or
    // a root-level duplicate): the full path is the best available identity.
    return full === name ? absolute.replace(/^\/+/, '') : name
  }
  const depth = new Map<string, number>(selections.map(path => [path, 1]))
  for (let round = 0; round < 64; round += 1) {
    const names = selections.map(path => segmentsOf(path, depth.get(path)!))
    const counts = new Map<string, number>()
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
    if ([...counts.values()].every(count => count === 1)) return names
    const grown = new Set<string>()
    for (const [index, path] of selections.entries()) {
      if ((counts.get(names[index]!) ?? 0) <= 1) continue
      depth.set(path, depth.get(path)! + 1)
      grown.add(path)
    }
    if (grown.size === 0) break
  }
  return selections.map(path => deepEnough(path, segmentsOf(path, depth.get(path)!)))
}

/**
 * Collect one selected path into the archive: a file becomes one entry, a
 * directory is walked depth-first and each level contributes its own entry
 * (a trailing '/' name), files keep their layout under the directory's own
 * name. Symlinks are skipped, never followed. Iterative (an explicit stack)
 * because a deep tree must not blow the JS stack, and the count bound is
 * enforced HERE so a runaway directory fails before its rows pile up.
 *
 * @param absolute - the (already fenced) absolute path of the selection.
 * @param name - the in-archive name of that selection (its basename).
 * @param out - the entry list appended to, in archive order.
 * @param maxEntries - entry-count bound.
 * @throws {SidebarError} fs-error when a row cannot be read or the bound is hit.
 */
export async function collectZipEntries(
  absolute: string,
  name: string,
  out: ZipEntry[],
  maxEntries = ZIP_MAX_ENTRIES,
): Promise<void> {
  const stack: Array<{ path: string; name: string }> = [{ path: absolute, name }]
  while (stack.length > 0) {
    const item = stack.pop()!
    if (out.length >= maxEntries) {
      throw new SidebarError('fs-error', `too many entries for one archive (> ${maxEntries})`, 400)
    }
    const info = await lstat(item.path).catch((error: unknown) => {
      throw new SidebarError('fs-error', `cannot read "${item.path}": ${error instanceof Error ? error.message : String(error)}`, 400)
    })
    if (info.isSymbolicLink()) {
      // A link row is not a file to read and not a directory to walk: it is
      // skipped (an archive of a dangling link has nothing to store). Never
      // followed — no escape and no cycle.
      continue
    }
    if (!info.isDirectory()) {
      out.push({ path: item.path, name: item.name })
      continue
    }
    out.push({ path: item.path, name: item.name, isDir: true })
    let level
    try {
      level = await readdir(item.path, { withFileTypes: true })
    } catch (error) {
      throw new SidebarError('fs-error', `cannot list "${item.path}": ${error instanceof Error ? error.message : String(error)}`, 400)
    }
    // Reverse order: the stack pops the first child next, so the archive reads
    // top-down in directory order.
    for (let index = level.length - 1; index >= 0; index -= 1) {
      const child = level[index]!
      stack.push({ path: join(item.path, child.name), name: `${item.name}/${child.name}` })
    }
  }
}

/** How many archives one host may build at the same time. */
export const ARCHIVE_MAX_BUILDING = 4
/** How long a finished (or failed) archive stays downloadable. */
export const ARCHIVE_TTL_MS = 5 * 60 * 1000

/** One archive build: the state the client polls, plus the finished bytes. */
interface ArchiveTask {
  id: string
  sessionId: string
  name: string
  state: 'building' | 'ready' | 'error'
  done: number
  total: number
  bytes: number
  error?: string
  zip?: Buffer
  /** When the task stops being downloadable (set when it settles). */
  expiresAt: number
}

/** The status shape the client reads (never carries the bytes). */
export interface ArchiveStatus {
  state: 'building' | 'ready' | 'error'
  done: number
  total: number
  bytes: number
  error?: string
}

/** Why a download/status read could not be served. */
export type ArchiveLookup =
  | { ok: true; task: ArchiveTask }
  | { ok: false; reason: 'missing' | 'forbidden' | 'building' | 'expired' | 'error'; message: string }

/** A resolved download: the bytes plus the sanitized name they were built for. */
export interface ArchiveDownload {
  name: string
  zip: Buffer
}

/** The response face {@link respondArchiveDownload} writes through. */
export interface ArchiveDownloadResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(chunk?: Buffer | string): void
}

/**
 * Answer one `GET /sidebar/archive?id=&sessionId=` from the task table.
 *
 * Split out of index.ts because this mapping IS the contract: 400 without
 * both parameters, 403 for another session's task, 409 while it builds, 410
 * for a failed build, 404 for unknown/expired/already-downloaded, 200 with the
 * RFC 5987 disposition otherwise. Kept here so all six branches are testable
 * without a live cordis mount.
 * @param tasks - the plugin's task table.
 * @param query - the request's `sessionId` / `id` values (null = absent).
 * @param res - a minimal response face.
 * @throws {SidebarError} for every non-200 branch (callers turn it into the
 *  JSON error envelope they already use).
 */
export function respondArchiveDownload(
  tasks: ArchiveTasks,
  query: { sessionId: string | null; id: string | null },
  res: ArchiveDownloadResponse,
): void {
  if (query.sessionId === null || query.id === null || query.id === '') {
    throw new SidebarError('bad-request', 'sessionId and id are required')
  }
  const found = tasks.lookup(query.id, query.sessionId)
  if (!found.ok || found.task.state !== 'ready' || found.task.zip === undefined) {
    if (found.ok) throw new SidebarError('not-found', 'archive is gone', 404)
    if (found.reason === 'building') throw new SidebarError('bad-request', found.message, 409)
    if (found.reason === 'forbidden') throw new SidebarError('forbidden', found.message, 403)
    if (found.reason === 'error') throw new SidebarError('fs-error', found.message, 410)
    throw new SidebarError('not-found', found.message, 404)
  }
  const { name, zip } = found.task
  // A download consumes the task: the bytes are not kept for a second fetch
  // (the task table is a queue, not a store).
  tasks.release(found.task.id)
  res.writeHead(200, {
    'content-type': 'application/zip',
    // Never the raw name: a non-latin1 value (中文目录 → 报告.zip) makes Node's
    // writeHead throw and turns the download into a 500.
    'content-disposition': contentDispositionOf(name),
    'content-length': String(zip.byteLength),
    'cache-control': 'no-cache',
  })
  res.end(zip)
}

/**
 * The host-side archive task table.
 *
 * A selection is collected up front (cheap: names + sizes) and then zipped in
 * the BACKGROUND, so the client can show progress instead of staring at a
 * spinner: `start` returns an id immediately, `status` reports
 * `building → ready | error`, and `download` hands over the bytes exactly once.
 * The table is bounded twice — {@link ARCHIVE_MAX_BUILDING} concurrent builds
 * and {@link ARCHIVE_TTL_MS} since a finished one — and every read is
 * session-scoped, so one session can never fetch another's archive.
 */
export interface ArchiveTasks {
  /** Start a build; rejects with bad-request when the concurrency cap is hit. */
  start(input: { sessionId: string; name: string; entries: readonly ZipEntry[] }): { id: string; entries: number }
  /** Poll one task (a settled task past its TTL reads as missing). */
  status(id: string, sessionId: string): ArchiveStatus
  /** Look one task up for a download; `sessionId` must match the builder's. */
  lookup(id: string, sessionId: string): ArchiveLookup
  /** Release a task (called after its bytes were served). */
  release(id: string): void
  /** Number of live tasks (tests / diagnostics). */
  size(): number
}

/** Create one archive task table (one per plugin mount). */
export function createArchiveTasks(): ArchiveTasks {
  const tasks = new Map<string, ArchiveTask>()

  /** Drop settled tasks past their TTL (called on every access). */
  const sweep = (now: number): void => {
    for (const [id, task] of tasks) {
      if (task.state !== 'building' && task.expiresAt <= now) tasks.delete(id)
    }
  }

  /** The task one (id, sessionId) pair names, or why it cannot be read. */
  const lookup = (id: string, sessionId: string): ArchiveLookup => {
    sweep(Date.now())
    const task = tasks.get(id)
    if (task === undefined) return { ok: false, reason: 'missing', message: 'unknown or expired archive' }
    if (task.sessionId !== sessionId) return { ok: false, reason: 'forbidden', message: 'archive belongs to another session' }
    if (task.state === 'building') return { ok: false, reason: 'building', message: 'archive is still being built' }
    if (task.state === 'error') return { ok: false, reason: 'error', message: task.error ?? 'archive failed' }
    return { ok: true, task }
  }

  return {
    start({ sessionId, name, entries }) {
      sweep(Date.now())
      let building = 0
      for (const task of tasks.values()) if (task.state === 'building') building += 1
      if (building >= ARCHIVE_MAX_BUILDING) {
        throw new SidebarError('bad-request', `too many archives are being built (max ${ARCHIVE_MAX_BUILDING})`, 409)
      }
      const task: ArchiveTask = {
        id: `ar-${randomUUID()}`,
        sessionId,
        name,
        state: 'building',
        done: 0,
        total: entries.length,
        bytes: 0,
        expiresAt: Number.POSITIVE_INFINITY,
      }
      tasks.set(task.id, task)
      // Detached on purpose: the POST answers as soon as the id exists, and the
      // task table (not the request) owns the error from here on.
      void buildZip([...entries], {
        onProgress: (progress) => {
          task.done = progress.done
          task.bytes = progress.bytes
        },
      }).then((zip) => {
        task.zip = zip
        task.state = 'ready'
        task.done = task.total
        task.expiresAt = Date.now() + ARCHIVE_TTL_MS
      }, (error: unknown) => {
        task.state = 'error'
        task.error = error instanceof Error ? error.message : String(error)
        task.expiresAt = Date.now() + ARCHIVE_TTL_MS
      })
      return { id: task.id, entries: entries.length }
    },
    status(id, sessionId) {
      sweep(Date.now())
      const task = tasks.get(id)
      if (task === undefined) throw new SidebarError('not-found', 'unknown or expired archive', 404)
      if (task.sessionId !== sessionId) throw new SidebarError('forbidden', 'archive belongs to another session', 403)
      return {
        state: task.state,
        done: task.done,
        total: task.total,
        bytes: task.bytes,
        ...(task.error === undefined ? {} : { error: task.error }),
      }
    },
    lookup,
    release(id) {
      tasks.delete(id)
    },
    size() {
      sweep(Date.now())
      return tasks.size
    },
  }
}
