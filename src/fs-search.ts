/**
 * Recursive file-name search for the editor's merged-mode side panel.
 * Streams the tree with opendir and matches a whitespace-split query as
 * case-insensitive substrings (paths stay relative to the search root —
 * the client resolves them against the session cwd). A single token matches
 * the entry NAME only; multiple tokens require every token to appear in the
 * entry's relative path (intersection — order-independent), so
 * `微黄金 搬迁` can hit `微黄金/搬迁方案.md`. No .gitignore semantics
 * (this is a name lookup, not a code search), but known noise directories
 * (`.git`, `node_modules`, package-manager stores, build caches) are
 * skipped outright — and the settings-page `searchExcludeDirs` list merges
 * into the same skip set — and symlink directories are NOT descended (cycle
 * safety).
 *
 * Two performance budgets bound the walk: `maxMatches` (the client renders
 * the flat list) and `maxVisited` (a runaway tree — a home directory root
 * — must not stall the host). Exceeding either stops early with
 * `truncated: true`.
 */
import { opendir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** One search: the relative paths of the matching entries (dirs included so
 *  the client can hint where matches live) plus the truncation flag. */
export interface FsSearchResult {
  matches: string[]
  truncated: boolean
}

/** Search budgets (both injectable for tests) + optional extra skip dirs. */
export interface FsSearchOptions {
  /** Row cap of the result list (default 200). */
  maxMatches?: number
  /** Total entries visited before the walk gives up (default 100_000). */
  maxVisited?: number
  /**
   * Extra directory names to skip (merged with {@link SEARCH_SKIP_DIRS}).
   * Compared case-insensitively to each walked directory's basename — the
   * directory itself is neither matched nor descended. Prefer feeding
   * {@link parseSearchExcludeDirs} output here.
   */
  skipDirs?: string[]
}

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_VISITED = 100_000

/**
 * Directory names that are never useful filename-search results and would
 * burn the visit budget before the walk reaches project files. Compared
 * case-insensitively so `Node_Modules` / `.GIT` stay skipped on every
 * platform. The directory itself is neither matched nor descended.
 */
const SEARCH_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.turbo',
  '.turbopack',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.parcel-cache',
  'coverage',
  'dist',
  'build',
  'out',
  '.umi',
  '.umi-production',
  '.dumi',
])

/**
 * Parse the settings-page `searchExcludeDirs` string into lowercase directory
 * basenames ready for {@link FsSearchOptions.skipDirs}. Splits on commas and
 * whitespace; strips trailing slashes; takes the final path segment so
 * `.smart-env/` and `foo/.smart-env` both become `.smart-env`. Empty /
 * `.` / `..` segments are dropped; duplicates collapse.
 */
export function parseSearchExcludeDirs(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(/[,\s]+/)) {
    let name = part.trim().replace(/[/\\]+$/g, '')
    if (name === '') continue
    const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
    if (slash >= 0) name = name.slice(slash + 1)
    if (name === '' || name === '.' || name === '..') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** Split `query` on whitespace into lowercase tokens; empty / blank → []. */
export function tokenizeQuery(query: string): string[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === '') return []
  return trimmed.split(/\s+/).filter(token => token.length > 0)
}

/**
 * Whether an entry matches the tokenized query.
 * Single token → basename substring; multiple → every token in the
 * '/'-separated relative path (intersection).
 */
function entryMatches(name: string, relativePosix: string, tokens: string[]): boolean {
  if (tokens.length === 1) return name.toLowerCase().includes(tokens[0]!)
  const haystack = relativePosix.toLowerCase()
  return tokens.every(token => haystack.includes(token))
}

/**
 * Search `root` recursively for entries matching `query` (case-insensitive
 * substrings; whitespace-split tokens are AND'd — see file header).
 * @param root - absolute search root.
 * @param query - name / path substrings; empty matches nothing.
 * @param opts - budget overrides (tests) and optional extra skip dirs.
 * @returns the matching paths RELATIVE to `root` ('/'-separated), sorted,
 *  plus whether a budget cut the walk short. An unreadable level is skipped
 *  (permission errors never fail the whole search).
 */
export async function searchFiles(root: string, query: string, opts: FsSearchOptions = {}): Promise<FsSearchResult> {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return { matches: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxVisited = opts.maxVisited ?? DEFAULT_MAX_VISITED
  const skip = new Set(SEARCH_SKIP_DIRS)
  for (const name of opts.skipDirs ?? []) {
    const key = name.trim().toLowerCase()
    if (key !== '') skip.add(key)
  }

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
      // Dependency / VCS / build-output forests (+ user excludes): never
      // matched, never descended.
      if (dirent.isDirectory() && skip.has(dirent.name.toLowerCase())) continue
      const rel = join(relative(root, dir), dirent.name)
      const relPosix = rel.split(sep).join('/')
      if (entryMatches(dirent.name, relPosix, tokens)) {
        matches.push(rel)
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
