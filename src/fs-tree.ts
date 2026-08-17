/**
 * Single-level directory listing for the sidebar explorer. Streams the level
 * with opendir, sorts directories first then names (case-insensitive), and
 * marks POSIX-hidden entries (dot-prefixed) for dimmed display. Symlinks are
 * stat'ed once to expose their target kind — a symlink to a directory
 * expands like a directory — and dangling links are flagged broken. The
 * probe runs only for entries that are actually symlinks, so levels without
 * links stay as cheap as before.
 *
 * Also home to {@link indexDirectory}: a BOUNDED recursive workspace scan
 * that powers the chat path-cache (see verified-paths.ts). It deliberately
 * skips heavyweight / generated directories and stops at entry-count and
 * depth caps, so scanning a huge, deeply nested repository stays cheap —
 * the cache is a hint, not an exhaustive inventory (paths beyond the bounds
 * fall back to a per-path probe at mention time).
 */
import { opendir, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { SidebarError } from './wire.ts'

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
}

/** One listed level. */
export interface SidebarFsListing {
  path: string
  entries: SidebarFsEntry[]
  truncated: boolean
}

/** Directory-first, case-insensitive name ordering (VSCode explorer order). */
export function compareEntries(a: SidebarFsEntry, b: SidebarFsEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * List one directory level.
 * @param path - absolute directory path.
 * @param maxEntries - row bound of one level (extra rows flag `truncated`).
 * @returns the sorted listing.
 * @throws {SidebarError} fs-error when the level is unreadable or not a directory.
 */
export async function listDirectory(path: string, maxEntries = 1000): Promise<SidebarFsListing> {
  let level
  try {
    level = await opendir(path)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot list "${path}": ${messageOf(error)}`, 400)
  }
  const rows: SidebarFsEntry[] = []
  let overflow = 0
  try {
    for await (const dirent of level) {
      if (rows.length >= maxEntries) {
        overflow += 1
        continue
      }
      // Platform join: on Windows the level path uses '\' — a hardcoded '/'
      // would leak mixed separators into every row's path.
      rows.push({
        name: dirent.name,
        path: join(path, dirent.name),
        isDir: dirent.isDirectory(),
        isSymlink: dirent.isSymbolicLink(),
        broken: false,
        hidden: dirent.name.startsWith('.'),
      })
    }
  } catch (error) {
    throw new SidebarError('fs-error', `cannot list "${path}": ${messageOf(error)}`, 400)
  }
  // Probe symlink targets AFTER the readdir stream closes, with bounded
  // concurrency: a symlink-heavy level (UNC/network targets) would otherwise
  // serialize up to maxEntries stat calls and stall the explorer. Non-symlink
  // rows are skipped by the probe, so levels without links stay as cheap as
  // before.
  await probeSymlinkTargets(rows)
  rows.sort(compareEntries)
  return { path, entries: rows, truncated: overflow > 0 }
}

/** How many symlink target stats run in flight during one level listing. */
const SYMLINK_PROBE_CONCURRENCY = 32

/** Directory names never entered by the workspace index scan: heavyweight
 *  or generated content where referencing files is rare and the cost of
 *  walking is high (node_modules alone can dwarf the whole repo). The
 *  mention path-cache treats these as "unknown" and falls back to a
 *  per-path probe, so nothing is permanently invisible. */
export const INDEX_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.turbo', '.parcel-cache', '.eslintcache', '.pytest_cache',
  '.venv', 'venv', '__pycache__',
  '.cache', '.idea', '.vscode',
  'tmp', 'temp',
])

/** One workspace index scan result. */
export interface SidebarFsIndex {
  /** Absolute paths of every indexed entry (files and directories). */
  paths: string[]
  /** Whether a bound (entry count / depth) stopped the scan early. */
  truncated: boolean
}

/** The bounds of one index scan. */
export interface IndexLimits {
  /** Max collected entries; the scan stops at this many (truncated). */
  maxEntries: number
  /** Max directory nesting below the root; deeper levels are skipped (truncated). */
  maxDepth: number
}

/**
 * Bounded recursive workspace scan for the chat path-cache. Walks the tree
 * level by level (bounded concurrency per level), skipping
 * {@link INDEX_SKIP_DIRS}, and stops at the entry-count / depth caps.
 * Symlinked directories are recorded but NOT descended into (cycle safety);
 * symlinked files are recorded like any other entry. Unreadable levels are
 * skipped silently — the index is a best-effort hint. Returns every indexed
 * absolute path, plus whether the scan was cut short by a bound.
 */
export async function indexDirectory(root: string, limits: IndexLimits): Promise<SidebarFsIndex> {
  const paths: string[] = []
  let truncated = false
  let level = [root]
  for (let depth = 0; depth <= limits.maxDepth && level.length > 0 && !truncated; depth += 1) {
    const next: string[] = []
    await Promise.all(level.map(async (dir) => {
      if (truncated) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
      for (const entry of entries) {
        if (paths.length >= limits.maxEntries) {
          truncated = true
          return
        }
        // Heavyweight / generated directories are skipped entirely (neither
        // recorded nor descended into) — a skipped entry must NOT abort the
        // rest of the level.
        if (entry.isDirectory() && INDEX_SKIP_DIRS.has(entry.name)) continue
        paths.push(join(dir, entry.name))
        // Real directories (not symlinks) are descended into on the next
        // level; a symlink to a directory is recorded but not followed.
        if (entry.isDirectory() && !entry.isSymbolicLink()) next.push(join(dir, entry.name))
      }
    }))
    level = next
  }
  // Deeper levels still pending = the depth bound cut the scan short.
  if (level.length > 0) truncated = true
  return { paths, truncated }
}

/** Probe each symlink row's target once (bounded concurrency, order-preserving). */
async function probeSymlinkTargets(rows: SidebarFsEntry[], concurrency = SYMLINK_PROBE_CONCURRENCY): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= rows.length) return
      const row = rows[index]!
      if (!row.isSymlink) continue
      // stat follows the chain; any failure (missing target, ELOOP, permission)
      // leaves the row as a broken file-shaped link the editor refuses to read.
      const info = await stat(row.path).catch(() => undefined)
      row.isDir = info !== undefined ? info.isDirectory() : row.isDir
      row.broken = info === undefined
    }
  })
  await Promise.all(workers)
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
 * letter case. The media route uses this instead of a raw `startsWith` so a
 * case-mismatched or mixed-separator path can never be misclassified
 * (e.g. `C:\Users\Me` vs `c:/users/me/file.png`).
 * @param platform - filesystem semantics; injectable so both branches are
 * unit-testable on any host.
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
