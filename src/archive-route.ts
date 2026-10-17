/**
 * The `/sidebar/archive` flow: the file tree's "zip and download" action.
 *
 * Three steps, unchanged from before: `archive.build` fences every `path` and
 * answers with an id immediately; `archive.status` reports
 * `building → ready | error`; `GET /sidebar/archive` serves the finished bytes
 * once. What changed is what happens in between.
 *
 * The archive is no longer BUILT BY US. The system's `zip` (or `tar` — see
 * archive-tools.ts) writes it, straight into a temp file in the OS temp
 * directory, and that file is what gets streamed out. Consequences worth
 * stating plainly:
 *
 * - **No memory ceiling.** The old path concatenated every member into one
 *   `Buffer`, held it on the task table, and `res.end()`-ed it; a selection
 *   large enough to matter took the host down. Now only the OS's disk usage
 *   grows.
 * - **No per-entry progress.** The old build reported `done / total` because
 *   our own writer visited each entry. A child process tells us nothing per
 *   entry, so the status reports BYTES written so far (the temp file's size)
 *   and the UI shows a plain "packing" line. Inventing an entry count would
 *   mean walking the tree a second time just to have a number to display.
 * - **Failures still arrive before the download starts.** The tool runs to
 *   completion in the background; a non-zero exit settles the task as `error`
 *   with the tool's own stderr, which the client renders. That ordering is the
 *   whole reason the temp file exists rather than piping the tool directly
 *   into the response — a mid-stream tool failure would otherwise be a 200
 *   response carrying half an archive.
 *
 * A temp archive is removed on every exit path: a completed download, the TTL
 * sweep, and plugin teardown (which also kills a build still running).
 */
import { randomUUID } from 'node:crypto'
import { open, rm, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SidebarHttpResponse } from './context-types.ts'
import { streamFileToResponse } from './file-stream.ts'
import {
  archiveFileName,
  archiveTempName,
  planArchive,
  resolveArchiveTool,
  runArchiveTool,
  type ArchivePlan,
  type ArchiveSpawn,
  type ArchiveToolSpec,
} from './archive-tools.ts'
import { SidebarError } from './wire.ts'

/** How many archives one host may build at the same time. */
export const ARCHIVE_MAX_BUILDING = 4
/** How long a finished (or failed) archive stays downloadable. */
export const ARCHIVE_TTL_MS = 5 * 60 * 1000
/**
 * How long teardown waits after the polite kill before escalating a running
 * build to SIGKILL. A tool that ignores SIGTERM must not hold dispose forever.
 */
const DISPOSE_KILL_GRACE_MS = 5_000
/** How long teardown waits for the close report AFTER SIGKILL, then gives up. */
const DISPOSE_CLOSE_GRACE_MS = 1_000

/**
 * Wait for one promise for at most `ms`.
 *
 * Teardown needs a bounded wait, not an abstraction: `ms` is a hard cap, and
 * an expiry answers `false` so the caller can escalate or move on.
 */
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  return Promise.race([promise.then(() => true), timeout])
    .finally(() => clearTimeout(timer))
}

/** The finished archive on disk. */
interface ArchiveFile {
  path: string
  size: number
}

/** One archive build: the state the client polls, plus the finished file. */
interface ArchiveTask {
  id: string
  sessionId: string
  /** The final download name (the tool's extension already applied). */
  name: string
  state: 'building' | 'ready' | 'error'
  /** Bytes written so far (the temp file's size while building). */
  bytes: number
  error?: string
  file?: ArchiveFile
  /** When the task stops being downloadable (set when it settles). */
  expiresAt: number
}

/** The status shape the client reads (never carries the bytes). */
export interface ArchiveStatus {
  state: 'building' | 'ready' | 'error'
  bytes: number
  error?: string
}

/** Why a download/status read could not be served. */
export type ArchiveLookup =
  | { ok: true; task: ArchiveTask }
  | { ok: false; reason: 'missing' | 'forbidden' | 'building' | 'expired' | 'error'; message: string }

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
  const stem = ascii.replace(/\.(?:zip|tar\.gz)$/i, '')
  if (stem === '' || /^\.+$/.test(stem)) return 'download.zip'
  return ascii
}

/**
 * Answer one `GET /sidebar/archive?id=&sessionId=` from the task table.
 *
 * Split out of index.ts because this mapping IS the contract: 400 without
 * both parameters, 403 for another session's task, 409 while it builds, 410
 * for a failed build, 404 for unknown/expired/already-downloaded, 200 with the
 * RFC 5987 disposition otherwise. Kept here so all six branches are testable
 * without a live cordis mount.
 *
 * The bytes are STREAMED from the temp file and the task is released only once
 * the stream settles: releasing first (as the buffered version could) would
 * unlink the file the response is still reading from.
 *
 * @param tasks - the plugin's task table.
 * @param query - the request's `sessionId` / `id` values (null = absent).
 * @param res - the response face.
 * @throws {SidebarError} for every non-200 branch (callers turn it into the
 *  JSON error envelope they already use). Thrown BEFORE any header commits, so
 *  the envelope is still deliverable.
 */
export async function respondArchiveDownload(
  tasks: ArchiveTasks,
  query: { sessionId: string | null; id: string | null },
  res: SidebarHttpResponse,
): Promise<void> {
  if (query.sessionId === null || query.id === null || query.id === '') {
    throw new SidebarError('bad-request', 'sessionId and id are required')
  }
  const found = tasks.lookup(query.id, query.sessionId)
  if (!found.ok || found.task.state !== 'ready' || found.task.file === undefined) {
    if (found.ok) throw new SidebarError('not-found', 'archive is gone', 404)
    if (found.reason === 'building') throw new SidebarError('bad-request', found.message, 409)
    if (found.reason === 'forbidden') throw new SidebarError('forbidden', found.message, 403)
    if (found.reason === 'error') throw new SidebarError('fs-error', found.message, 410)
    throw new SidebarError('not-found', found.message, 404)
  }
  const { name, file } = found.task
  const id = found.task.id
  try {
    await streamFileToResponse(file.path, file.size, res, {
      // The extension follows the TOOL, not the client's guess: a host with
      // only `tar` sends a real .tar.gz rather than a mislabelled .zip.
      'content-type': name.endsWith('.tar.gz') ? 'application/gzip' : 'application/zip',
      // Never the raw name: a non-latin1 value (中文目录 → 报告.zip) makes Node's
      // writeHead throw and turns the download into a 500.
      'content-disposition': contentDispositionOf(name),
      'cache-control': 'no-cache',
    })
  } finally {
    // A download consumes the task: the bytes are not kept for a second fetch
    // (the task table is a queue, not a store).
    tasks.release(id)
  }
}

/**
 * The host-side archive task table.
 *
 * A selection is planned up front (cheap: one probe + a couple of path joins)
 * and then packed in the BACKGROUND, so the client gets an id immediately and
 * the download only starts once the bytes actually exist. The table is bounded
 * twice — {@link ARCHIVE_MAX_BUILDING} concurrent builds and
 * {@link ARCHIVE_TTL_MS} since a finished one — and every read is
 * session-scoped, so one session can never fetch another's archive.
 */
export interface ArchiveTasks {
  /** Start a build; rejects when the tool is missing or the cap is hit. */
  start(input: { sessionId: string; name: string; paths: readonly string[] }): Promise<{ id: string; name: string; entries: number }>
  /** Poll one task (a settled task past its TTL reads as missing). */
  status(id: string, sessionId: string): ArchiveStatus
  /** Look one task up for a download; `sessionId` must match the builder's. */
  lookup(id: string, sessionId: string): ArchiveLookup
  /** Release a task (called after its bytes were served): deletes the temp file. */
  release(id: string): void
  /** Number of live tasks (tests / diagnostics). */
  size(): number
  /**
   * Kill every running build, close every in-flight descriptor, then delete
   * every temp file (plugin teardown). Async because Windows refuses to unlink
   * a file while a handle to it is still open: the descriptor must be closed
   * (and the close awaited) before the `rm`.
   */
  dispose(): Promise<void>
}

/** Options of {@link createArchiveTasks} (tests inject the spawn + temp dir). */
export interface ArchiveTaskOptions {
  spawn?: ArchiveSpawn
  /** Directory the temp archives live in (defaults to the OS temp directory). */
  tempDir?: string
  /** Resolve the archive tool (defaults to the real probe). `spawner` is
   *  undefined when the table was built without an injected spawn. */
  resolveTool?: (spawner: ArchiveSpawn | undefined) => Promise<ArchiveToolSpec | undefined>
}

/** Create one archive task table (one per plugin mount). */
export function createArchiveTasks(options: ArchiveTaskOptions = {}): ArchiveTasks {
  const tasks = new Map<string, ArchiveTask>()
  /**
   * Running children, by task id (teardown kills them and then AWAITS their
   * close event before unlinking the file they were writing). The wait is
   * bounded: an unresponsive tool must not block dispose forever.
   */
  const children = new Map<string, { kill(signal?: NodeJS.Signals): void; closed: Promise<void> }>()
  /**
   * In-flight output descriptors, by task id (with the temp path they own).
   * The descriptor stays open across the spawn (`stdio[1]` is that fd), so
   * teardown must close it explicitly: a build whose child never reports back
   * would otherwise leave the fd to the FileHandle GC finalizer (which Node
   * now treats as an error). The path rides along because Windows refuses to
   * unlink the file while the descriptor is open — teardown must close first,
   * then remove.
   */
  const handles = new Map<string, { handle: FileHandle; path: string }>()
  /** Teardown flag: an `open()` that resolves after dispose closes at once. */
  let disposed = false
  /** One teardown per table: a second `dispose()` awaits the same cleanup. */
  let disposing: Promise<void> | undefined
  const spawner = options.spawn ?? undefined

  const tempPathOf = (id: string, ext: string): string =>
    join(options.tempDir ?? tmpdir(), archiveTempName(id, ext))

  /** Drop settled tasks past their TTL, deleting the temp files they held. */
  const sweep = (now: number): void => {
    for (const [id, task] of tasks) {
      if (task.state === 'building' || task.expiresAt > now) continue
      tasks.delete(id)
      if (task.file !== undefined) void rm(task.file.path, { force: true }).catch(() => {})
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
    async start({ sessionId, name, paths }) {
      if (disposed) throw new SidebarError('unavailable', 'archive tasks were shut down', 503)
      sweep(Date.now())
      let building = 0
      for (const task of tasks.values()) if (task.state === 'building') building += 1
      if (building >= ARCHIVE_MAX_BUILDING) {
        throw new SidebarError('bad-request', `too many archives are being built (max ${ARCHIVE_MAX_BUILDING})`, 409)
      }
      const resolve = options.resolveTool ?? resolveArchiveTool
      // One call either way: `spawn` has a default, so passing `undefined`
      // selects the real implementation without a second code path.
      const spec = await resolve(spawner)
      // Teardown may land during the (async) tool probe: after this point no
      // await separates the check from `tasks.set`, so the task cannot be
      // created after dispose cleared the table.
      if (disposed) throw new SidebarError('unavailable', 'archive tasks were shut down', 503)
      if (spec === undefined) {
        // A NEW wire code, and deliberately its own: "this machine has no zip
        // and no tar" is not a failure of the selection, and the client shows
        // it as an actionable sentence rather than a raw English message.
        throw new SidebarError(
          'unavailable',
          'no archive tool is available: neither zip nor tar could be run',
          501,
        )
      }
      const plan = planArchive(paths, spec)
      const id = `ar-${randomUUID()}`
      const finalName = archiveFileName(name, spec.ext)
      const tempPath = tempPathOf(id, spec.ext)
      const task: ArchiveTask = {
        id,
        sessionId,
        name: finalName,
        state: 'building',
        bytes: 0,
        expiresAt: Number.POSITIVE_INFINITY,
      }
      tasks.set(id, task)
      // Detached on purpose: the POST answers as soon as the id exists, and the
      // task table (not the request) owns the error from here on.
      void pack(id, task, plan, tempPath, spawner)
      return { id, name: finalName, entries: paths.length }
    },
    status(id, sessionId) {
      sweep(Date.now())
      const task = tasks.get(id)
      if (task === undefined) throw new SidebarError('not-found', 'unknown or expired archive', 404)
      if (task.sessionId !== sessionId) throw new SidebarError('forbidden', 'archive belongs to another session', 403)
      return {
        state: task.state,
        bytes: task.bytes,
        ...(task.error === undefined ? {} : { error: task.error }),
      }
    },
    lookup,
    release(id) {
      const task = tasks.get(id)
      tasks.delete(id)
      if (task?.file !== undefined) void rm(task.file.path, { force: true }).catch(() => {})
    },
    size() {
      sweep(Date.now())
      return tasks.size
    },
    dispose() {
      disposing ??= (async () => {
        disposed = true
        const running = [...children.values()]
        for (const child of running) {
          try {
            child.kill()
          } catch {
            // A child that already exited cannot be killed; nothing to do.
          }
        }
        children.clear()
        // Wait for the killed builds to REPORT their close before closing the
        // output descriptor and unlinking: on Windows the child may still hold
        // the file, and `rm` would fail with EBUSY (a swallowed error that
        // leaves the temp archive behind). The wait is bounded: a child that
        // ignores the polite kill is escalated to SIGKILL, and one that still
        // never reports close cannot block dispose past the hard cap.
        await Promise.all(running.map(async (child) => {
          if (await settlesWithin(child.closed, DISPOSE_KILL_GRACE_MS)) return
          try {
            child.kill('SIGKILL')
          } catch {
            // A child that exited between the timer and the escalation has
            // nothing left to kill.
          }
          await settlesWithin(child.closed, DISPOSE_CLOSE_GRACE_MS)
        }))
        // Close every in-flight descriptor BEFORE unlinking its temp file:
        // Windows answers EBUSY/EPERM for a file that still has an open handle,
        // and a swallowed rm would leave the temp archive behind forever.
        const closing: Promise<void>[] = []
        const paths = new Set<string>()
        for (const entry of handles.values()) {
          paths.add(entry.path)
          closing.push(entry.handle.close().catch(() => undefined))
        }
        handles.clear()
        await Promise.all(closing)
        for (const task of tasks.values()) {
          if (task.file !== undefined) paths.add(task.file.path)
        }
        tasks.clear()
        await Promise.all([...paths].map(path => rm(path, { force: true }).catch(() => undefined)))
      })()
      return disposing
    },
  }

  /**
   * Pack one task: open the temp file, hand its descriptor to the tool, and
   * settle the task from the exit code.
   *
   * The descriptor stays open across the spawn and is closed only after the
   * child exits — closing it earlier would truncate output still being written.
   */
  async function pack(
    id: string,
    task: ArchiveTask,
    plan: ArchivePlan,
    tempPath: string,
    spawner: ArchiveSpawn | undefined,
  ): Promise<void> {
    const settle = (error: string | undefined): void => {
      task.state = error === undefined ? 'ready' : 'error'
      if (error !== undefined) task.error = error
      task.expiresAt = Date.now() + ARCHIVE_TTL_MS
      children.delete(id)
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(tempPath, 'w')
      // `start` returns before this open resolves, so a teardown that lands in
      // between must not leave the descriptor to the GC finalizer.
      if (disposed) {
        await handle.close().catch(() => undefined)
        await rm(tempPath, { force: true }).catch(() => undefined)
        // A race that slipped past `start`'s checks must settle as `error`,
        // never leave a `building` task behind forever.
        settle('archive tasks were shut down')
        return
      }
      handles.set(id, { handle, path: tempPath })
      const result = await runArchiveTool(plan, handle.fd, spawner, child => {
        // `close` (not `exit`) is the event that also means the child is done
        // touching whatever it inherited. Attached synchronously with the
        // spawn, so a very fast child cannot emit it before we listen.
        const closed = new Promise<void>(resolve => {
          child.once('close', () => resolve())
          child.once('error', () => resolve())
        })
        children.set(id, { kill: (signal) => { child.kill(signal) }, closed })
      })
      await handle.close()
      handles.delete(id)
      handle = undefined
      if (result.code !== 0) {
        settle(result.stderr === '' ? `${plan.spec.bin} exited with code ${result.code}` : result.stderr)
        await rm(tempPath, { force: true }).catch(() => {})
        return
      }
      const info = await stat(tempPath).catch(() => undefined)
      if (info === undefined) {
        settle(`${plan.spec.bin} produced no archive`)
        return
      }
      task.bytes = info.size
      task.file = { path: tempPath, size: info.size }
      settle(undefined)
    } catch (error: unknown) {
      // A tool that cannot be started at all, or a disk that refuses the temp
      // file. Either way the task must not stay `building` forever.
      await handle?.close().catch(() => {})
      handles.delete(id)
      task.bytes = await stat(tempPath).then(info => info.size).catch(() => 0)
      settle(error instanceof Error ? error.message : String(error))
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }
}
