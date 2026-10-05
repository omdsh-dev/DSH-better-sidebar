/**
 * Recursive file-name search for the editor's merged-mode side panel.
 * Streams the tree with opendir and matches the query as a case-insensitive
 * substring of each entry's NAME (paths stay relative to the search root —
 * the client resolves them against the session cwd). No .gitignore semantics
 * (this is a name lookup, not a code search), but known noise directories
 * (`.git`, `node_modules`, package-manager stores, build caches) are
 * skipped outright and symlink directories are NOT descended (cycle safety).
 *
 * Two performance budgets bound the walk: `maxMatches` (the client renders
 * the flat list) and `maxVisited` (a runaway tree — a home directory root
 * — must not stall the host). Exceeding either stops early with
 * `truncated: true`.
 *
 * A hit can be a DIRECTORY (the list shows where matches live), so the result
 * separates them: `fs.read` refuses a directory, and the client must navigate
 * the tree for those rows instead of opening them as files.
 *
 * `searchFiles` (the dispatch the fs.search route calls) first tries the
 * probed native engines (fd / rg — see search-engines.ts); when none are
 * available or all failed at runtime it falls back to this walk (exported as
 * `searchFilesPlain` for tests). Both paths fill the same contract — the
 * `opts.exclude` probe included: the walk skips a match before descending,
 * the engine path post-filters its flat listing (see engineExcludeProbe).
 */
import type { Dirent } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import type { ExcludeTest } from './exclude-patterns.ts'
import { SKIP_DIR_NAMES, runEngine, usableEngines } from './search-engines.ts'
import { debugLog } from './search-debug.ts'

/** One search: the relative paths of the matching entries (dirs included so
 *  the client can hint where matches live) plus the truncation flag. */
export interface FsSearchResult {
  matches: string[]
  /** The subset of `matches` that are DIRECTORIES (same relative, '/'-separated
   *  form). The client navigates the tree for these instead of opening them:
   *  `fs.read` refuses a directory, so treating a hit as a file surfaces a bare
   *  `"…" is a directory` error. */
  dirs: string[]
  truncated: boolean
}

/** Search budgets (both injectable for tests). */
export interface FsSearchOptions {
  /** Row cap of the result list (default 200). */
  maxMatches?: number
  /** Total entries visited before the walk gives up (default 100_000). */
  maxVisited?: number
  /** Compiled exclude-pattern probe (the explorerExclude pref): matched
   *  entries never match AND are never descended — the search surface stays
   *  in lockstep with the tree listing. */
  exclude?: ExcludeTest
}

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_VISITED = 100_000

/**
 * Directory names that are never useful filename-search results and would
 * burn the visit budget before the walk reaches project files. Compared
 * case-insensitively so `Node_Modules` / `.GIT` stay skipped on every
 * platform. The name list lives in search-engines.ts (SKIP_DIR_NAMES) — the
 * engine argvs exclude the same names so the fallback and the engines return
 * the same result shape. An entry with a skip name is neither matched nor
 * descended — including a worktree-style `.git` FILE, which the engine
 * excludes cover as well.
 */
const SEARCH_SKIP_DIRS = new Set(SKIP_DIR_NAMES)

/** Shorten an absolute search root for log lines: ~/ for the config home. */
function relRoot(root: string): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : homedir()
  if (root === home) return '~'
  const boundary = home.endsWith(sep) ? home : home + sep
  return root.startsWith(boundary) ? `~${root.slice(home.length)}` : root
}

/**
 * Whether one matched entry is a DIRECTORY, following symlinks the way the
 * tree and `fs.read` do: the dirent answers for real directories, a link is
 * stat'ed (a link to a directory is a directory row — `fs.read` refuses it as
 * a file), and an unresolvable link stays a plain entry.
 */
async function isDirectoryEntry(absolute: string, dirent: Dirent): Promise<boolean> {
  if (dirent.isDirectory()) return true
  if (!dirent.isSymbolicLink()) return false
  const info = await stat(absolute).catch(() => undefined)
  return info?.isDirectory() === true
}

/**
 * The plain-JS fallback walk: search `root` recursively for entries whose
 * name contains `query` (case-insensitive).
 * @param root - absolute search root.
 * @param query - the name substring; empty matches nothing.
 * @param opts - budget overrides (tests).
 * @returns the matching paths RELATIVE to `root` ('/'-separated), sorted,
 *  plus which of them are directories and whether a budget cut the walk
 *  short. An unreadable level is skipped (permission errors never fail the
 *  whole search).
 */
export async function searchFilesPlain(root: string, query: string, opts: FsSearchOptions = {}): Promise<FsSearchResult> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { matches: [], dirs: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxVisited = opts.maxVisited ?? DEFAULT_MAX_VISITED

  const matches: string[] = []
  const dirs: string[] = []
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
      // Dependency / VCS / build-output forests: never matched, never
      // descended. A worktree-style `.git` FILE (pointer to the real
      // gitdir) is VCS noise too — the name check covers both shapes,
      // parity with the engines' .git exclusion (SKIP_DIR_NAMES).
      if (SEARCH_SKIP_DIRS.has(dirent.name.toLowerCase())) continue
      const absolute = join(dir, dirent.name)
      // The user's exclude list removes entries from search exactly like the
      // tree listing (no match, no descent).
      if (opts.exclude !== undefined && opts.exclude(absolute, dirent.name)) continue
      if (dirent.name.toLowerCase().includes(needle)) {
        const hit = join(relative(root, dir), dirent.name)
        matches.push(hit)
        if (await isDirectoryEntry(absolute, dirent)) dirs.push(hit)
        if (matches.length >= maxMatches) {
          truncated = true
          return
        }
      }
      // Descend real directories only: a symlinked directory may point back
      // up the tree (cycle).
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        await walk(absolute)
        if (truncated) return
      }
    }
  }
  await walk(root)
  // '/' separators on every platform: the client joins onto the cwd itself.
  const normalize = (path: string): string => path.split(sep).join('/')
  return { matches: matches.sort().map(normalize), dirs: dirs.sort().map(normalize), truncated }
}

/**
 * The walk's exclude probe applied to a FLAT engine listing (the engines have
 * no notion of the user's patterns). The engines are a faster walk, not a
 * different surface, so the walk's two rules carry over verbatim: a row whose
 * name is excluded disappears, and so does every row BELOW an excluded
 * directory — the walk never descended into one, so it could never have
 * reported a child as a match either. Verdicts are memoized per directory:
 * the engines report hundreds of rows under the same few directories.
 */
function engineExcludeProbe(root: string, exclude: ExcludeTest): (relativePath: string) => boolean {
  const excludedDirs = new Map<string, boolean>()
  /** Whether the directory at `relativeDir` ('' = the search root) is
   *  excluded, itself or through an ancestor. */
  const dirExcluded = (relativeDir: string): boolean => {
    if (relativeDir === '') return false
    const cached = excludedDirs.get(relativeDir)
    if (cached !== undefined) return cached
    const cut = relativeDir.lastIndexOf('/')
    const parent = cut === -1 ? '' : relativeDir.slice(0, cut)
    const name = cut === -1 ? relativeDir : relativeDir.slice(cut + 1)
    const verdict = dirExcluded(parent) || exclude(join(root, ...relativeDir.split('/')), name)
    excludedDirs.set(relativeDir, verdict)
    return verdict
  }
  return (relativePath) => {
    const cut = relativePath.lastIndexOf('/')
    const parent = cut === -1 ? '' : relativePath.slice(0, cut)
    const name = cut === -1 ? relativePath : relativePath.slice(cut + 1)
    return dirExcluded(parent) || exclude(join(root, ...relativePath.split('/')), name)
  }
}

/**
 * The fs.search dispatch: native engines first (when verified and healthy),
 * the plain walk as fallback. Engine output is normalized onto the walk
 * contract — root-relative, '/'-separated, sorted, and split into
 * matches/dirs — so the route and the client stay unchanged. A blank query
 * matches nothing and touches neither the engines nor the filesystem.
 *
 * The engines keep their own cap (and report it through `truncated`), so a
 * root whose first `maxMatches` rows are ALL excluded comes back short with
 * `truncated: true` rather than silently hiding the remainder — the same
 * signal a budget-cut walk gives.
 */
export async function searchFiles(root: string, query: string, opts: FsSearchOptions = {}): Promise<FsSearchResult> {
  const needle = query.trim()
  if (needle === '') return { matches: [], dirs: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const started = performance.now()
  const isExcluded = opts.exclude === undefined ? undefined : engineExcludeProbe(root, opts.exclude)
  for (const probe of await usableEngines()) {
    try {
      const result = await runEngine(probe, root, needle, maxMatches)
      // The SAME exclude list as the walk, applied as a post-step (an engine
      // argv cannot express the compiled glob subset, and duplicating the
      // grammar would let the two surfaces disagree). It runs before the
      // budget slice so an excluded row never eats one of the caller's rows.
      const paths = isExcluded === undefined ? result.paths : result.paths.filter(path => !isExcluded(path))
      // The engine's own cap is a sentinel (maxMatches + 1) proving there is
      // more; slice back to the caller's budget and re-derive the directory
      // subset from what was kept, so dirs never names a dropped row.
      const matches = [...paths].sort().slice(0, maxMatches)
      const kept = new Set(matches)
      const dirs = [...new Set(result.dirs)].filter(dir => kept.has(dir)).sort()
      debugLog(`[dsh-search] engine=${probe.engine} bin=${probe.binary} root=${relRoot(root)} query="${needle}" hits=${matches.length} truncated=${result.truncated} ${(performance.now() - started).toFixed(0)}ms`)
      return { matches, dirs, truncated: result.truncated }
    } catch {
      // runEngine already recorded the failure (broken engine or timeout);
      // the next engine — or the walk below — gets its turn.
    }
  }
  const result = await searchFilesPlain(root, query, opts)
  debugLog(`[dsh-search] engine=plain root=${relRoot(root)} query="${needle}" hits=${result.matches.length} truncated=${result.truncated} ${(performance.now() - started).toFixed(0)}ms`)
  return result
}
