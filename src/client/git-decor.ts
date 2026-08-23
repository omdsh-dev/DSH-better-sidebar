/**
 * Git decoration derivation for the explorer rows: turns one working-tree
 * status snapshot into the path-keyed marks the file tree renders (badge
 * letters on changed files, containment dots on their ancestor directories).
 *
 * Pure client logic (no DOM, no network) so the mapping is unit-testable
 * without mounting the tree; the host remains the authority for path
 * semantics, mirrored through `paths.ts`.
 */
import type { GitStatusEntry, GitStatusResult } from './api.ts'
import { relativeTo } from './paths.ts'

/** One status letter for a git entry (X = index, Y = worktree). */
export function gitBadgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  const worktree = entry.xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

/** Comparison key for a repo-relative path: '/' separators, lowercase (the
 *  containment test must not depend on casing — see relativeTo). */
export function gitKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** The repo-relative key of an absolute path under the git root ('' = the
 *  root itself), or undefined when the path lies outside the repo. */
export function gitRelOf(root: string, abs: string): string | undefined {
  const rel = relativeTo(root, abs)
  if (rel === '.') return ''
  return rel === abs ? undefined : rel
}

/** Dominance order for a directory's status tint: the most salient letter
 *  wins when a subtree mixes statuses (modified > added/untracked > deleted
 *  > renamed), so a folder's color is deterministic. */
const DIR_TINT_PRIORITY: Record<string, number> = { M: 4, A: 3, '?': 2, D: 1, R: 0 }

/** The explorer decorations of one repository. */
export interface GitDecorations {
  badges: Map<string, string>
  dirtyDirs: Set<string>
  /** Dominant status letter per dirty directory ('' = the repo root itself). */
  dirBadges: Map<string, string>
}

/** The explorer decorations derived from one status snapshot: the badge
 *  letter per repo-relative path key, the set of directories whose subtree
 *  contains at least one changed file, and the dominant status letter per
 *  such directory (drives the folder-name tint). */
export function gitDecorations(status: GitStatusResult): GitDecorations {
  const badges = new Map<string, string>()
  const dirtyDirs = new Set<string>()
  const dirBadges = new Map<string, string>()
  if (!status.isRepo) {
    return { badges, dirtyDirs, dirBadges }
  }
  const noteDir = (key: string, letter: string): void => {
    const current = dirBadges.get(key)
    if (current === undefined || (DIR_TINT_PRIORITY[letter] ?? 0) > (DIR_TINT_PRIORITY[current] ?? 0)) {
      dirBadges.set(key, letter)
    }
  }
  for (const entry of status.entries) {
    const key = gitKey(entry.path)
    const letter = gitBadgeOf(entry)
    badges.set(key, letter)
    let sep = key.lastIndexOf('/')
    while (sep > 0) {
      const dir = key.slice(0, sep)
      dirtyDirs.add(dir)
      noteDir(dir, letter)
      sep = key.lastIndexOf('/', sep - 1)
    }
  }
  if (status.entries.length > 0) {
    // The repo root folder itself carries the dominant letter over all
    // entries (the repo-relative key '' never appears as an ancestor above).
    const dominant = status.entries
      .map(entry => gitBadgeOf(entry))
      .sort((a, b) => (DIR_TINT_PRIORITY[b] ?? 0) - (DIR_TINT_PRIORITY[a] ?? 0))[0]
    if (dominant !== undefined) noteDir('', dominant)
  }
  return { badges, dirtyDirs, dirBadges }
}

/**
 * The deepest repository whose tree contains an absolute path, from a map
 * of status snapshots keyed by the directory they were fetched for (the
 * workspace root plus every visible directory carrying a `.git` entry).
 * The effective matching root is the host-reported repo root when present
 * (a cwd fetched from inside its repo), else the fetched directory itself.
 */
export function owningRepo(
  repos: ReadonlyMap<string, GitStatusResult>,
  abs: string,
): { key: string; root: string; status: GitStatusResult } | undefined {
  let best: { key: string; root: string; status: GitStatusResult } | undefined
  for (const [key, status] of repos) {
    if (!status.isRepo) continue
    const root = status.root !== undefined && status.root !== '' ? status.root : key
    if (gitRelOf(root, abs) === undefined) continue
    if (best === undefined || root.length > best.root.length) best = { key, root, status }
  }
  return best
}
