/**
 * Pure derivation for the review panel: one row per changed file, plus the
 * add/remove counts a row badge shows.
 *
 * Git reports a file's state as two letters — X for the index (staged), Y for
 * the worktree (unstaged) — and `git status` emits ONE entry carrying both.
 * The source-control panel splits that entry into a staged and an unstaged
 * section, which is the right shape for composing a commit. Review is a
 * different question: "what has changed since the last commit, and have I
 * looked at it yet?" So a path appears exactly ONCE here, and the two letters
 * collapse into a single review state.
 *
 * Kept dependency-free so the state machine is unit-testable without a git
 * repo or a rendered panel.
 */
import type { GitStatusEntry, GitStatusResult } from './api.ts'

/** Where one file sits in the review pass. */
export type ReviewState =
  /** Worktree changes nobody has accepted yet — the review queue proper. */
  | 'pending'
  /** Fully staged: accepted, and waiting to be committed. */
  | 'accepted'
  /** Staged AND changed again since (git 'MM') — the new part still needs a look. */
  | 'partial'

/** One reviewable file. */
export interface ReviewEntry {
  path: string
  /** The raw two-letter porcelain code, kept for the row badge. */
  xy: string
  state: ReviewState
  /** Untracked files have no committed version to diff against. */
  untracked: boolean
}

/** Whether the index (X) column carries a change. */
function hasStaged(xy: string): boolean {
  const x = xy[0]
  return x !== undefined && x !== ' ' && x !== '?'
}

/** Whether the worktree (Y) column carries a change. */
function hasUnstaged(xy: string): boolean {
  if (xy === '??') return true
  const y = xy[1]
  return y !== undefined && y !== ' ' && y !== '?'
}

/** The review state for one porcelain code. */
export function reviewStateOf(xy: string): ReviewState {
  const staged = hasStaged(xy)
  const unstaged = hasUnstaged(xy)
  if (staged && unstaged) return 'partial'
  if (staged) return 'accepted'
  return 'pending'
}

/** One row per path, in the order git reported them. */
export function reviewEntries(entries: readonly GitStatusEntry[]): ReviewEntry[] {
  const byPath = new Map<string, ReviewEntry>()
  for (const entry of entries) {
    // A duplicate path (a rename reported twice, or two porcelain rows for one
    // file) must not produce two rows: merge by taking the busier state, so a
    // file that is both staged and re-edited never shows as merely 'accepted'.
    const existing = byPath.get(entry.path)
    const state = reviewStateOf(entry.xy)
    if (existing === undefined) {
      byPath.set(entry.path, {
        path: entry.path,
        xy: entry.xy,
        state,
        untracked: entry.xy === '??',
      })
      continue
    }
    if (existing.state !== 'partial' && state !== existing.state) existing.state = 'partial'
  }
  return [...byPath.values()]
}

/** How many rows still need a look. */
export function pendingCount(entries: readonly ReviewEntry[]): number {
  return entries.filter((entry) => entry.state !== 'accepted').length
}

/** Added/removed line counts for one unified diff. */
export interface DiffStats {
  added: number
  removed: number
}

/**
 * Count changed lines in a unified diff. `+++`/`---` file headers start with
 * the same characters as content lines and must not be counted, so they are
 * skipped explicitly; everything before the first hunk header is preamble.
 */
export function diffStats(diff: string): DiffStats {
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue }
    if (!inHunk) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('diff --git')) { inHunk = false; continue }
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/** Stats for an untracked file, which git never diffs: every line is new. */
export function untrackedStats(content: string): DiffStats {
  if (content === '') return { added: 0, removed: 0 }
  const lines = content.split('\n')
  // A trailing newline yields a final empty element that is not a line.
  if (lines[lines.length - 1] === '') lines.pop()
  return { added: lines.length, removed: 0 }
}

/** Status snapshot → review rows (empty outside a repo). */
export function reviewFromStatus(status: GitStatusResult | null): ReviewEntry[] {
  if (status === null || !status.isRepo) return []
  return reviewEntries(status.entries)
}
