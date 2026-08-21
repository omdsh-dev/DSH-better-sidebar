/**
 * Recursive file-name search for the editor's merged-mode side panel.
 * Streams the tree with opendir and matches the query as a case-insensitive
 * substring of each entry's NAME (paths stay relative to the search root —
 * the client resolves them against the session cwd). No .gitignore semantics
 * (this is a name lookup, not a code search), but `.git` directories are
 * skipped outright (VCS internals are never useful results) and symlink
 * directories are NOT descended (cycle safety).
 *
 * Two performance budgets bound the walk: `maxMatches` (the client renders
 * the flat list) and `maxVisited` (a runaway tree — a home directory root,
 * a node_modules forest — must not stall the host). Exceeding either stops
 * early with `truncated: true`.
 *
 * `searchFiles` (the dispatch the fs.search route calls) first tries the
 * probed native engines (fd / rg — see search-engines.ts); when
 * none are available or all failed at runtime it falls back to this walk
 * (exported as `searchFilesPlain` for tests).
 */
import { opendir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { runEngine, usableEngines } from './search-engines.ts'
import { debugLog } from './search-debug.ts'

/** Shorten an absolute search root for log lines: ~/ for the config home. */
function relRoot(root: string): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : homedir()
  if (root === home) return '~'
  const boundary = home.endsWith(sep) ? home : home + sep
  return root.startsWith(boundary) ? '~' + root.slice(home.length) : root
}

/** One search: the relative paths of the matching entries (dirs included so
 *  the client can hint where matches live) plus the truncation flag. */
export interface FsSearchResult {
  matches: string[]
  truncated: boolean
}

/** Search budgets (both injectable for tests). */
export interface FsSearchOptions {
  /** Row cap of the result list (default 200). */
  maxMatches?: number
  /** Total entries visited before the walk gives up (default 100_000). */
  maxVisited?: number
}

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_VISITED = 100_000

/**
 * Search `root` recursively for entries whose name contains `query`
 * (case-insensitive).
 * @param root - absolute search root.
 * @param query - the name substring; empty matches nothing.
 * @param opts - budget overrides (tests).
 * @returns the matching paths RELATIVE to `root` ('/'-separated), sorted,
 *  plus whether a budget cut the walk short. An unreadable level is skipped
 *  (permission errors never fail the whole search).
 */
export async function searchFilesPlain(root: string, query: string, opts: FsSearchOptions = {}): Promise<FsSearchResult> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { matches: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxVisited = opts.maxVisited ?? DEFAULT_MAX_VISITED

  const matches: string[] = []
  let visited = 0
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    const level = await opendir(dir).catch(() => undefined)
    if (level === undefined) return
    for await (const dirent of level) {
      visited += 1
      if (visited > maxVisited) {
        truncated = true
        return
      }
      // .git is VCS-internal noise: never matched, never descended.
      if (dirent.isDirectory() && dirent.name === '.git') continue
      if (dirent.name.toLowerCase().includes(needle)) {
        matches.push(join(relative(root, dir), dirent.name))
        if (matches.length >= maxMatches) {
          truncated = true
          return
        }
      }
      // Descend real directories only: a symlinked directory may point back
      // up the tree (cycle).
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        await walk(join(dir, dirent.name))
        if (truncated) return
      }
    }
  }
  await walk(root)
  // '/' separators on every platform: the client joins onto the cwd itself.
  return { matches: matches.sort().map(path => path.split(sep).join('/')), truncated }
}

/**
 * The fs.search dispatch: native engines first (when verified and healthy),
 * the plain walk as fallback. Engine output matches the walk contract:
 * root-relative, '/'-separated, sorted; the engine's cap (maxMatches + 1)
 * decides `truncated`. A query that matches nothing up front short-circuits
 * before any engine or walk runs.
 * @param signal - aborts the engine child; an aborted search skips the
 *  fallback walk too (the client has already discarded the request).
 */
export async function searchFiles(
  root: string,
  query: string,
  opts: FsSearchOptions = {},
  signal?: AbortSignal,
): Promise<FsSearchResult> {
  const needle = query.trim()
  if (needle === '') return { matches: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const t0 = performance.now()
  for (const probe of await usableEngines()) {
    try {
      const { paths, truncated } = await runEngine(probe, root, needle, maxMatches, signal)
      const matches = paths.sort()
      const elapsed = (performance.now() - t0).toFixed(0)
      debugLog(`[dsh-search] engine=${probe.engine} bin=${probe.binary} root=${relRoot(root)} query="${needle}" hits=${matches.length} truncated=${truncated} ${elapsed}ms`)
      return {
        matches: truncated ? matches.slice(0, maxMatches) : matches,
        truncated,
      }
    } catch {
      // runEngine disabled the engine; try the next one (an aborted signal
      // rethrows untouched, but matching nothing is just as good — the
      // request is dead either way).
      if (signal?.aborted) return { matches: [], truncated: false }
    }
  }
  const result = await searchFilesPlain(root, query, opts)
  const elapsed = (performance.now() - t0).toFixed(0)
  debugLog(`[dsh-search] engine=plain root=${relRoot(root)} query="${needle}" hits=${result.matches.length} truncated=${result.truncated} ${elapsed}ms`)
  return result
}
