/**
 * Edit-tool → diff routing helpers. When the `editOpensDiff` preference is
 * on, clicking an edit-tool file link in the chat opens the file's git
 * worktree diff instead of the plain editor (see intercept.openSidebarFile).
 * The decision is derived from the session's authoritative git status: a
 * file with no status entry has no change to show, and a file outside the
 * session repository cannot be diffed through the session scope — both fall
 * back to the editor.
 * @module dsh-better-sidebar/client/edit-diff
 */
import type { GitStatusResult } from './api.ts'
import { baseName } from './FileTree.tsx'
import { isWithinWorkspace, relativeTo } from './paths.ts'
import type { OpenTabSeed } from './service.ts'

/** The diff-tab target derived for one edited file. */
export interface EditDiffTarget {
  /** Repo-root-relative path with git separators. */
  relative: string
  /** Absolute root of the repository the file belongs to. */
  repoRoot: string
  /** Whether git lists the file as untracked (`??` — `git diff` never covers it). */
  untracked: boolean
}

/**
 * Derive the diff target for an edit-tool-opened file from the target
 * repository's git status snapshot. The snapshot is already scoped to the
 * repository that owns `absolute` (via `git.status-at`), so only the root
 * containment check and the per-file status entry determine the target.
 *
 * @param absolute - The edited file's absolute path.
 * @param status - The repository's status snapshot (single-repository,
 * already scoped to the file's owning checkout).
 * @returns The diff target, or null when the file is not inside the
 * repository or has no pending change (the caller falls back to the editor).
 */
export function deriveEditDiffTarget(absolute: string, status: GitStatusResult): EditDiffTarget | null {
  if (!status.isRepo || status.root === undefined) return null
  if (!isWithinWorkspace(status.root, absolute)) return null
  const relative = relativeTo(status.root, absolute)
  // Guard against a containment false positive (a root that equals the file):
  // a repository root itself is never a diff target.
  if (relative === '.' || relative === absolute) return null
  const entry = status.entries.find(candidate => candidate.path === relative)
  // No status row means no staged, unstaged, or untracked change — the diff
  // tab would render an empty state, so the editor is the better answer.
  if (entry === undefined) return null
  return { relative, repoRoot: status.root, untracked: entry.xy === '??' }
}

/**
 * Build the diff-tab seed for one edited file. The id mirrors the Git
 * panel's worktree-diff ids (`diff:w:<worktree>:u:<path>` with no linked
 * worktree selected), so a later click of the same row in the Git panel
 * focuses this tab instead of opening a duplicate.
 *
 * @param relative - Repo-root-relative path (from {@link deriveEditDiffTarget}).
 * @param repoRoot - Absolute repository root; threaded into the diff scope so
 * child-repo files resolve against their own repository.
 * @param untracked - Untracked flag for the full-file-addition fallback.
 * @returns The openTab seed.
 */
export function buildEditDiffTab(relative: string, repoRoot: string, untracked: boolean): OpenTabSeed {
  return {
    id: `diff:w::u:${relative}`,
    type: 'diff',
    title: baseName(relative),
    diff: { kind: 'worktree', path: relative, staged: false, untracked, repoRoot },
  }
}
