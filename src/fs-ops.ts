/**
 * File operations for the sidebar explorer's context menu: create
 * directories, rename entries, remove entries (trash-first), reveal entries
 * in the system file manager, and recursively search a directory by file
 * name and file content. These are the host-side primitives behind the
 * /sidebar/api fs.* routes; every function throws {@link SidebarError} with
 * a wire code on failure (mirror of the reference workspace-explorer
 * plugin's handlers, adapted to this codebase's error conventions).
 *
 * Security note: like `fs.tree`/`fs.read`/`fs.write`, these operations
 * accept any absolute path — the /sidebar fence (trusted loopback host)
 * is the boundary, and the explorer UI only ever sends paths it listed.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { SidebarError } from './wire.ts'

const execFileAsync = promisify(execFile)

/** Search result row (name or content match). */
export interface SidebarSearchResult {
  path: string
  name: string
  /** Path relative to the search root ('' for the root itself). */
  rel: string
  type: 'file' | 'directory'
  size: number | null
  /** The first line containing the query (truncated), null for name-only matches. */
  matchLine: string | null
}

/** One search outcome. */
export interface SidebarSearchOutcome {
  path: string
  query: string
  results: SidebarSearchResult[]
  /** Whether a scan cap stopped the walk early. */
  truncated: boolean
}

/** Max matches returned by one search. */
const SEARCH_MAX_RESULTS = 500
/** Max directory entries visited by one search. */
const SEARCH_MAX_VISIT = 20000
/** Files larger than this are skipped for content scanning. */
const SEARCH_CONTENT_FILE_LIMIT = 256 * 1024
/** Max files whose content is scanned per search. */
const SEARCH_CONTENT_SCAN_LIMIT = 2000
/** Max chars of the matching line returned. */
const SEARCH_CONTEXT_LINE_LIMIT = 160

/** Create one directory (the parent must exist). */
export async function createDirectory(path: string): Promise<{ path: string }> {
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SidebarError('fs-error', `目录已存在: ${path}`)
    }
    throw new SidebarError('fs-error', `无法创建目录 "${path}": ${messageOf(error)}`, 400)
  }
  return { path }
}

/** Validate a caller-supplied new name for a create/rename operation. */
export function validateEntryName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new SidebarError('bad-request', '名称不能为空，不能包含 / 或 \\，不能为 . 或 ..')
  }
  return trimmed
}

/** Rename a file or directory (same parent; the name is basename-only).
 *  The destination is pre-checked: POSIX `rename(2)` silently REPLACES an
 *  existing destination file, so the explorer refuses collisions instead
 *  of destroying data. */
export async function renameEntry(path: string, rawName: string): Promise<{ path: string; dest: string }> {
  const name = validateEntryName(rawName)
  const dest = join(dirname(path), name)
  let occupied = false
  try {
    await access(dest)
    occupied = true
  } catch {
    // ENOENT (or unreadable): proceed — the rename itself reports real errors.
  }
  if (occupied) throw new SidebarError('fs-error', `同名文件或目录已存在: ${name}`)
  try {
    await rename(path, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new SidebarError('not-found', `路径不存在: ${path}`, 404)
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new SidebarError('fs-error', `同名文件或目录已存在: ${name}`)
    }
    throw new SidebarError('fs-error', `无法重命名 "${path}": ${messageOf(error)}`, 400)
  }
  return { path, dest }
}

/**
 * The system trash directory, or null when this platform has none.
 * `DSH_SIDEBAR_TRASH_DIR` overrides it (test hook, mirror of the reference
 * plugin's WSE_TRASH_DIR).
 */
export function trashDirectory(): string | null {
  if (process.env.DSH_SIDEBAR_TRASH_DIR !== undefined && process.env.DSH_SIDEBAR_TRASH_DIR !== '') {
    return process.env.DSH_SIDEBAR_TRASH_DIR
  }
  if (process.platform === 'darwin') return join(homedir(), '.Trash')
  if (process.platform === 'linux') return join(homedir(), '.local', 'share', 'Trash', 'files')
  return null // no trash directory on this platform
}

/** The first non-colliding destination inside `dir` for `name` (name 2, 3, …). */
async function uniqueDest(dir: string, name: string): Promise<string> {
  const plain = join(dir, name)
  try {
    await access(plain)
  } catch {
    return plain
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 10000; i++) {
    const candidate = join(dir, `${stem} ${i}${ext}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${stem} ${Date.now()}${ext}`)
}

/**
 * Remove a file or directory tree. Trash-first: on darwin/linux the entry
 * is MOVED into the system trash (macOS ~/.Trash, freedesktop Trash), with
 * name collisions auto-suffixed; a cross-device move (trash on another
 * volume) or a platform without a trash falls back to permanent deletion.
 */
export async function removeEntry(path: string): Promise<{ path: string; trashed: boolean; dest?: string }> {
  try {
    await access(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SidebarError('not-found', `路径不存在: ${path}`, 404)
    }
    throw new SidebarError('fs-error', `无法删除 "${path}": ${messageOf(error)}`, 400)
  }
  const trashDir = trashDirectory()
  if (trashDir !== null) {
    try {
      await mkdir(trashDir, { recursive: true })
      const dest = await uniqueDest(trashDir, basename(path))
      await rename(path, dest)
      return { path, trashed: true, dest }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw new SidebarError('fs-error', `无法移入回收站 "${path}": ${messageOf(error)}`, 400)
      }
      // Cross-device move: the trash lives on another volume; fall through
      // to permanent deletion below.
    }
  }
  // No trash available (or cross-device): permanent delete.
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    throw new SidebarError('fs-error', `无法删除 "${path}": ${messageOf(error)}`, 400)
  }
  return { path, trashed: false }
}

/**
 * Reveal the entry in the system file manager: macOS Finder (open -R,
 * selects the item), Windows Explorer (/select,), Linux opens the parent
 * directory (xdg-open).
 */
export async function revealEntry(path: string): Promise<{ path: string }> {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-R', path])
    } else if (process.platform === 'win32') {
      await execFileAsync('explorer', ['/select,', path])
    } else {
      await execFileAsync('xdg-open', [dirname(path)])
    }
  } catch (error) {
    throw new SidebarError('fs-error', `无法在文件管理器中显示 "${path}": ${messageOf(error)}`, 400)
  }
  return { path }
}

/** The first line containing the query (trimmed, truncated). */
function matchingLine(content: string, query: string): string | null {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(query)
  if (idx < 0) return null
  const lineStart = content.lastIndexOf('\n', idx) + 1
  let lineEnd = content.indexOf('\n', idx)
  if (lineEnd < 0) lineEnd = content.length
  let line = content.slice(lineStart, lineEnd).trim()
  if (line.length > SEARCH_CONTEXT_LINE_LIMIT) line = line.slice(0, SEARCH_CONTEXT_LINE_LIMIT) + '…'
  return line
}

/** Read a file for content matching; null when unreadable/binary/too large. */
async function readForScan(path: string, size: number | null): Promise<string | null> {
  if (size !== null && size > SEARCH_CONTENT_FILE_LIMIT) return null
  try {
    const content = await readFile(path, 'utf8')
    if (content.includes('\u0000')) return null // binary heuristic
    return content
  } catch {
    return null
  }
}

/**
 * Recursively search `root` (BFS, skipping symlinks to avoid cycles): rows
 * match by file NAME or by file CONTENT (case-insensitive, first matching
 * line returned). Bounded: 500 results / 20000 entries visited / 2000
 * content scans / 256 KiB per scanned file; an empty query returns no
 * results without walking the tree.
 */
export async function searchDirectory(root: string, rawQuery: string): Promise<SidebarSearchOutcome> {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') {
    return { path: root, query: rawQuery.trim(), results: [], truncated: false }
  }
  const results: SidebarSearchResult[] = []
  let visited = 0
  let scanned = 0
  let hitCap = false
  const queue = [root]
  const rootPrefix = root.replace(/[\\/]+$/, '')

  while (queue.length > 0 && !hitCap) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory: skip it
    }
    entries.sort((a, b) => {
      const ad = a.isDirectory() && !a.isSymbolicLink() ? 0 : 1
      const bd = b.isDirectory() && !b.isSymbolicLink() ? 0 : 1
      if (ad !== bd) return ad - bd
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      visited += 1
      if (visited > SEARCH_MAX_VISIT) {
        hitCap = true
        break
      }
      const childPath = join(dir, entry.name)
      const isDir = entry.isDirectory() && !entry.isSymbolicLink()
      const isFile = entry.isFile() && !entry.isSymbolicLink()
      const nameMatched = entry.name.toLowerCase().includes(query)
      const rel = childPath.slice(0, rootPrefix.length) === rootPrefix
        ? childPath.slice(rootPrefix.length).replace(/^[\\/]/, '')
        : entry.name

      let size: number | null = null
      if (isFile) {
        try {
          size = (await stat(childPath)).size
        } catch {
          size = null
        }
      }

      let pushed = false
      if (nameMatched) {
        results.push({ path: childPath, name: entry.name, rel, type: isDir ? 'directory' : 'file', size, matchLine: null })
        pushed = true
      } else if (isFile && scanned < SEARCH_CONTENT_SCAN_LIMIT) {
        scanned += 1
        const content = await readForScan(childPath, size)
        if (content !== null) {
          const lower = content.toLowerCase()
          if (lower.includes(query)) {
            results.push({
              path: childPath,
              name: entry.name,
              rel,
              type: 'file',
              size,
              matchLine: matchingLine(content, query),
            })
            pushed = true
          }
        }
      }
      if (pushed && results.length >= SEARCH_MAX_RESULTS) {
        hitCap = true
        break
      }
      if (isDir) queue.push(childPath)
    }
  }

  return {
    path: root,
    query: rawQuery.trim(),
    results,
    truncated: hitCap,
  }
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
