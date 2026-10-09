/**
 * Single-level directory listing for the sidebar explorer.
 *
 * The hot path here IS the explorer's latency budget, so the implementation is
 * deliberately allocation-shy: one `readdir(withFileTypes)` call (no
 * `opendir` stream), rows built only for the capped slice, paths composed by
 * string concatenation, and a hand-rolled case-insensitive sort (see
 * {@link compareEntries} — `localeCompare` alone costs ~15ms/10k rows, ~40x
 * the whole listing budget). A short TTL cache ({@link DIRECTORY_CACHE_TTL_MS})
 * absorbs the repeat listings a tree view makes on every re-render.
 *
 * Row semantics are unchanged: directories first, case-insensitive name order
 * with a deterministic tie-break, POSIX-hidden entries flagged for dimming,
 * symlinks stat'ed once so a link to a directory expands like a directory and
 * a dangling one is flagged broken. Directory rows additionally get one
 * bounded read of their own level to mark singleton-dir chains (`compact`)
 * for the explorer's breadcrumb folding.
 */
import { opendir, readdir, stat } from 'node:fs/promises'
import type { Dir, Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { SidebarError } from './wire.ts'
import type { ExcludeMatcher } from './exclude-patterns.ts'

/** One explorer row. */
export interface SidebarFsEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  /** Whether the row is a symlink; `isDir` then describes the link's target. */
  isSymlink: boolean
  /** For symlinks: the target is missing or unreadable (stat failed). */
  broken: boolean
  /**
   * Directory rows only: the contents are EXACTLY one child — the explorer
   * folds such singleton chains into one breadcrumb row (VSCode's "compact
   * folders"). The terminal link (sole child is a FILE) is marked too, so
   * the row label never shifts when the chain expands. Symlink children
   * never qualify: a self-referential link would otherwise fold forever.
   */
  compact?: boolean
}

/** One listed level. */
export interface SidebarFsListing {
  path: string
  entries: SidebarFsEntry[]
  truncated: boolean
}

/**
 * Directory-first, case-insensitive name ordering (VSCode explorer order).
 *
 * `toLowerCase()` + code-point comparison instead of `localeCompare`: measured
 * at ~0.35ms/10k rows against ~14.6ms for the collator, and the tie-break on
 * the ORIGINAL name keeps the order total and deterministic for names that
 * only differ in case (`A` before `a`).
 */
export function compareEntries(a: SidebarFsEntry, b: SidebarFsEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const la = a.name.toLowerCase()
  const lb = b.name.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

/** How many symlink target stats run in flight during one level listing. */
const SYMLINK_PROBE_CONCURRENCY = 32

/**
 * How long one listed level stays valid. Short on purpose: it absorbs the
 * re-listing a re-render (or a burst of tree opens) causes without hiding
 * changes for perceptibly long, and every writer invalidates it explicitly
 * anyway (see {@link invalidateDirectoryCache}).
 */
export const DIRECTORY_CACHE_TTL_MS = 1_500

/**
 * The level cache, keyed by `"<absoluteDir>\0<cap>\0<excludeKey>"`.
 *
 * Keyed by ABSOLUTE PATH, not by session: a listing is a pure function of the
 * path plus the cap AND the exclude pattern set, and its rows already carry
 * absolute paths, so sharing an entry between two sessions that read the same
 * directory is correct (and desirable — one directory read serves both).
 * Nothing session-scoped is stored, so no session's data can leak into
 * another's listing.
 *
 * The exclude set is part of the key, never ambient host state: a listing
 * filtered by one pattern list must never be served to a request carrying
 * another (the user's edit must show up on the next read, and the pattern list
 * travels WITH the request — see {@link ExcludeMatcher.key}).
 */
const directoryCache = new Map<string, { at: number; listing: SidebarFsListing }>()

/** Cache key of one level read. */
function cacheKey(path: string, maxEntries: number, exclude?: ExcludeMatcher): string {
  return `${path}\0${maxEntries}\0${exclude?.key ?? ''}`
}

/**
 * Drop the cached level(s) for one directory (and, when called with no
 * argument, everything). Writers call this after any mutation: `fs.write`,
 * `fs.rename`, `fs.remove`, `fs.mkdir`, the upload route and the fs-watch
 * notifier all funnel here, so a stale level is never served past the write
 * that changed it.
 * @param path - absolute (or session-relative) directory to invalidate; absent
 *  clears the whole cache.
 */
export function invalidateDirectoryCache(path?: string): void {
  if (path === undefined) {
    directoryCache.clear()
    return
  }
  const target = resolve(path)
  const prefix = `${target}\0`
  for (const key of directoryCache.keys()) {
    if (key.startsWith(prefix)) directoryCache.delete(key)
  }
}

/** Max entries tracked in the TTL cache before the oldest are evicted. */
const DIRECTORY_CACHE_MAX = 512

/** Read one level through the cache when it is fresh. */
async function listDirectoryCached(path: string, maxEntries: number, exclude?: ExcludeMatcher): Promise<SidebarFsListing> {
  const key = cacheKey(path, maxEntries, exclude)
  const now = Date.now()
  const hit = directoryCache.get(key)
  if (hit !== undefined && now - hit.at < DIRECTORY_CACHE_TTL_MS) return hit.listing
  const listing = await readDirectory(path, maxEntries, exclude)
  // Bounded: a deep walk of many directories must not grow this map without
  // limit (entries are tiny, but an unbounded map in a long-lived host is a
  // leak). Map iteration order is insertion order, so the first key is oldest.
  if (directoryCache.size >= DIRECTORY_CACHE_MAX) {
    const oldest = directoryCache.keys().next().value
    if (oldest !== undefined) directoryCache.delete(oldest)
  }
  directoryCache.set(key, { at: now, listing })
  return listing
}

/**
 * List one directory level (cached for {@link DIRECTORY_CACHE_TTL_MS}).
 * @param path - absolute directory path.
 * @param maxEntries - row bound of one level (extra rows flag `truncated`).
 * @param exclude - compiled exclude-pattern probe (the explorerExclude pref):
 *  matched entries are dropped from the listing AND the singleton fold probe,
 *  so they never render nor block a breadcrumb fold.
 * @returns the sorted listing.
 * @throws {SidebarError} fs-error when the level is unreadable or not a directory.
 */
export async function listDirectory(path: string, maxEntries = 1000, exclude?: ExcludeMatcher): Promise<SidebarFsListing> {
  return await listDirectoryCached(path, maxEntries, exclude)
}

/** Read one level straight from the filesystem (the cache's slow path). */
async function readDirectory(path: string, maxEntries: number, exclude?: ExcludeMatcher): Promise<SidebarFsListing> {
  let dirents
  try {
    // One syscall batch instead of an `opendir` stream: `readdir` with types is
    // roughly half the wall time of `for await (const dirent of await opendir())`
    // and gives the same Dirent objects.
    dirents = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new SidebarError('fs-error', `cannot list "${path}": ${messageOf(error)}`, 400)
  }
  const prefix = path.endsWith(sep) ? path : `${path}${sep}`
  // The user's exclude list removes matched rows entirely (VS Code's
  // files.exclude semantics) — BEFORE the cap, so an excluded entry never
  // consumes a row of the level's budget, and the same compiled matcher
  // filters the singleton fold probe below.
  const visible = exclude === undefined
    ? dirents
    : dirents.filter(dirent => !exclude(`${prefix}${dirent.name}`, dirent.name))
  const truncated = visible.length > maxEntries
  // Build rows ONLY for the rows that survive the cap: composing a row costs
  // ~0.3µs (path concat + three flags), so an uncapped 10k level would spend
  // ~3ms on rows nobody will see.
  const kept = truncated ? visible.slice(0, maxEntries) : visible
  const rows: SidebarFsEntry[] = new Array(kept.length)
  for (let index = 0; index < kept.length; index += 1) {
    const dirent = kept[index]!
    // String concat over `path.join`: ~10x faster on 10k rows, and the
    // separator stays platform-correct (`sep`).
    rows[index] = {
      name: dirent.name,
      path: `${prefix}${dirent.name}`,
      isDir: dirent.isDirectory(),
      isSymlink: dirent.isSymbolicLink(),
      broken: false,
      hidden: dirent.name.startsWith('.'),
    }
  }
  // Probe symlink targets AFTER the read, with bounded concurrency: a
  // symlink-heavy level (UNC/network targets) would otherwise serialize up to
  // maxEntries stat calls and stall the explorer. Non-symlink rows are skipped,
  // so levels without links stay as cheap as before.
  await probeSymlinkTargets(rows)
  // Mark singleton-directory rows AFTER the symlink probe (it finalizes
  // isDir/broken), so the client can fold compact chains without an extra
  // round trip per collapsed level.
  await probeCompactRows(rows, exclude)
  rows.sort(compareEntries)
  return { path, entries: rows, truncated }
}

/**
 * Visit every row with at most `concurrency` visitors in flight, in row order.
 * Both probes below spend one await per row (a network stat, an opendir) on a
 * level that can hold thousands of rows, so the bound has to exist — and be
 * shared, or the two probes drift into two different ones.
 */
async function forEachRow(rows: readonly SidebarFsEntry[], concurrency: number, visit: (row: SidebarFsEntry) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= rows.length) return
      await visit(rows[index]!)
    }
  })
  await Promise.all(workers)
}

/** Probe each symlink row's target once (bounded concurrency, order-preserving). */
async function probeSymlinkTargets(rows: SidebarFsEntry[], concurrency = SYMLINK_PROBE_CONCURRENCY): Promise<void> {
  await forEachRow(rows, concurrency, async (row) => {
    if (!row.isSymlink) return
    // stat follows the chain; any failure (missing target, ELOOP, permission)
    // leaves the row as a broken file-shaped link the editor refuses to read.
    const info = await stat(row.path).catch(() => undefined)
    row.isDir = info !== undefined ? info.isDirectory() : row.isDir
    row.broken = info === undefined
  })
}

/** How many compact probes run in flight during one level listing. */
const COMPACT_PROBE_CONCURRENCY = 32

/**
 * Mark each directory row whose contents are EXACTLY one non-symlink child
 * (`compact`), so the explorer can fold singleton chains into one breadcrumb
 * row. The terminal link (sole FILE child) is marked too: the client
 * preloads marked levels to stabilize the fold label before expansion.
 * Bounded concurrency like the symlink probe: each probe is one opendir + up
 * to two dirent reads, so a directory-heavy level stays responsive. Probe
 * failures (unreadable child level) leave the row unmarked — it simply does
 * not fold.
 */
async function probeCompactRows(rows: SidebarFsEntry[], exclude?: ExcludeMatcher, concurrency = COMPACT_PROBE_CONCURRENCY): Promise<void> {
  await forEachRow(rows, concurrency, async (row) => {
    if (!row.isDir || row.broken) return
    if (await hasSingletonChild(row.path, exclude)) row.compact = true
  })
}

/**
 * Whether `dir` holds exactly one EFFECTIVE entry (POSIX-hidden entries —
 * dot-prefixed, e.g. macOS's `.DS_Store` — don't count, and neither do
 * entries the user's exclude list removes) and that entry is NOT a symlink.
 * Symlink children never qualify: the client's fold chain follows `compact`
 * links eagerly, and a self-referential link would otherwise fold forever.
 * Hidden/excluded entries never qualify either: the client walks chains
 * with the same filters, so a fold never hides a visible row — the user's
 * "show hidden files" switch only affects rendering, never the fold itself.
 */
async function hasSingletonChild(dir: string, exclude?: ExcludeMatcher): Promise<boolean> {
  let level: Dir | undefined
  try {
    level = await opendir(dir)
    let only: Dirent | null = null
    for (;;) {
      const entry = await level.read()
      if (entry === null) break
      if (entry.name.startsWith('.')) continue
      if (exclude !== undefined && exclude(`${dir}${sep}${entry.name}`, entry.name)) continue
      if (only !== null) return false
      only = entry
    }
    // A dirent's isSymbolicLink() never follows targets — exactly the
    // exclusion we want here (see above).
    return only !== null && !only.isSymbolicLink()
  } catch {
    return false
  } finally {
    await level?.close().catch(() => undefined)
  }
}

/** The root row label of a listing: the last path segment (or the full path at the filesystem root). */
export function rootLabel(path: string): string {
  const base = basename(path)
  return base !== '' ? base : path
}

/** Parent of a path, or undefined at the filesystem root (the explorer's "up" target). */
export function parentOf(path: string): string | undefined {
  const parent = dirname(path)
  return parent === path ? undefined : parent
}

/**
 * Normalize a caller-supplied path to an absolute, resolved path or throw
 * fs-error. `path.isAbsolute()` is the OS's own notion of absolute: POSIX
 * roots (`/...`), Windows drive letters (`C:\...`) and — on win32 — UNC
 * network shares (`\\server\share\...`); drive-relative forms (`C:foo`)
 * stay rejected.
 */
export function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) {
    throw new SidebarError('fs-error', `"${path}" is not an absolute path`, 400)
  }
  return resolve(path)
}

/**
 * Whether `target` lies under `base` (or equals it), tolerant of separator
 * style and — on Windows, where the filesystem is case-insensitive — of
 * letter case.
 *
 * LEXICAL ONLY, and no longer a security boundary: the sidebar's containment
 * fence was removed (see path-security.ts), so nothing in this plugin decides
 * access by this function any more. It is kept for the client-side mirror
 * usage and the historical tests, not as a guard.
 * @param platform - filesystem semantics; injectable so both branches are
 *  unit-testable on any host.
 */
export function isWithin(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  if (platform === 'win32') {
    const lb = b.toLowerCase()
    const lt = t.toLowerCase()
    return lt === lb || lt.startsWith(`${lb}/`)
  }
  return t === b || t.startsWith(`${b}/`)
}

/** Message text of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
