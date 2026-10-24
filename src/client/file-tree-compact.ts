/**
 * Pure logic behind the explorer's breadcrumb folder compaction (VSCode's
 * "compact folders"): a directory whose contents are exactly one child
 * (host flag `compact`) folds together with its sole directory children
 * into one `a/b/c` row — the chain extends only through DIRECTORY links,
 * the terminal link's sole child may be a file. The host only ever marks
 * non-symlink children, so a fold chain can never cycle through the
 * filesystem — the visited guard is belt-and-braces against a stale or
 * hostile cache. The chain walk skips POSIX-hidden entries (the host probe
 * marks `compact` with the same filter), so junk like macOS's `.DS_Store`
 * beside the sole child never snaps a chain open — regardless of whether
 * the user's "show hidden files" switch renders them.
 */
import type { FsEntry } from './api.ts'

/** One cached level as FileTree stores it (entries arrive async; error set on failure). */
export interface CompactLevel {
  entries?: FsEntry[]
  error?: string
}

/**
 * Cap on one fold chain, shared by what the row RENDERS and what the preload
 * loads ahead of it ({@link compactLoadTargets}) so a chain never pays for
 * links the breadcrumb would not show. A legitimate deep singleton chain
 * (a Java package path, a chain of single-child project folders) does reach
 * this; past it the breadcrumb stops folding and the next link appears as its
 * own row on expansion. The stale-cache cycle guard is {@link compactChain}'s
 * `visited` set, not this.
 */
export const MAX_COMPACT_DEPTH = 32

/**
 * The fold chain starting at `entry`: successive sole directory children
 * while each link's level is loaded, still holds exactly one healthy
 * directory child, and the chain stays within the depth cap. The returned
 * chain always starts with `entry` itself; its LAST element is the level
 * the expanded row renders.
 */
export function compactChain(entry: FsEntry, levelOf: (path: string) => CompactLevel | undefined): FsEntry[] {
  const chain = [entry]
  const visited = new Set<string>([entry.path])
  let current = entry
  while (current.compact === true && chain.length < MAX_COMPACT_DEPTH) {
    const level = levelOf(current.path)
    // Unloaded / failed / stale level: the chain pauses at the current link
    // (the caller keeps loading while the tail stays `compact`).
    if (level === undefined || level.error !== undefined || level.entries === undefined) break
    // Hidden (dot-prefixed) entries don't count as children — the host
    // probe marked `compact` with the same filter, so hidden junk beside
    // the sole child must not snap the chain open here.
    const visible = level.entries.filter(entry => entry.hidden !== true)
    if (visible.length !== 1) break
    const child = visible[0]!
    if (!child.isDir || child.broken || visited.has(child.path)) break
    visited.add(child.path)
    chain.push(child)
    current = child
  }
  return chain
}

/**
 * The collapsed singleton directories whose levels still need loading, so
 * fold chains can extend past what the user has expanded. Walks down from the
 * RENDERED levels (`roots` — the workspace root plus every expanded
 * directory) along the very same {@link compactChain} the row renderer builds
 * its label with, so the walk inherits that chain's
 * {@link MAX_COMPACT_DEPTH} cap: past the cap the breadcrumb stops folding and
 * the preload stops asking for links the renderer would never draw. (The
 * previous every-loaded-level scan kept pulling link 33, 34, … for a chain
 * the row had already stopped folding at 32 — one serial POST plus one
 * whole-tree render per wasted link.)
 *
 * Each arrival may reveal the next link, so the caller re-runs this after
 * every cache update. `visited` dedupes that walk and keeps it terminating:
 * chains cannot cycle (the host never marks symlink children).
 * @param levels - the tree's level cache, keyed by absolute path.
 * @param roots - the levels the tree actually renders, in any order.
 * @returns the absolute paths of the frontier links still to load.
 */
export function compactLoadTargets(levels: Record<string, CompactLevel>, roots: readonly string[]): string[] {
  const targets = new Set<string>()
  const visited = new Set<string>()
  // A work list, not recursion: a deep expanded tree must not grow the stack.
  const pending = [...roots]
  while (pending.length > 0) {
    const dir = pending.pop()!
    if (visited.has(dir)) continue
    visited.add(dir)
    const level = levels[dir]
    // Unloaded, in-flight (`{}`) or failed level: nothing to scan here.
    if (level?.entries === undefined) continue
    for (const entry of level.entries) {
      if (!entry.isDir) continue
      const chain = compactChain(entry, path => levels[path])
      const tail = chain[chain.length - 1]!
      // The chain's frontier: its tail still folds but that level is unloaded.
      if (tail.compact === true && levels[tail.path] === undefined) {
        targets.add(tail.path)
        continue
      }
      // Tail already loaded: descend for the next frontier link — but stop at
      // the render cap, which is exactly where the label stops extending.
      if (chain.length < MAX_COMPACT_DEPTH) pending.push(tail.path)
    }
  }
  return [...targets]
}
