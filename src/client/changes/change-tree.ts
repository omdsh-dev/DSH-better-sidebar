/**
 * The changes list's hierarchy.
 *
 * A `git status` answer is a flat list of repo-relative paths, and the Git
 * lens used to render exactly that: one row per file, with the file name and
 * its directory squeezed onto the same line. Nested work (a refactor touching
 * `src/client/changes/*`) then read as a wall of near-identical rows. This
 * module folds the list into the directory tree the lens renders — VS Code's
 * SCM tree, including its single-child directory compression — so the shape
 * of the change is legible at a glance.
 *
 * Pure — no React, no DOM. `buildChangeTree` runs once per group per fold;
 * the renderer only walks the result.
 */
import type { GitStatusEntry } from '../api.ts'
import { statusOfXY, type GitFileStatus } from '../ui/index.ts'

/** One changed file (a leaf), carrying its porcelain status. */
export interface ChangeFile {
  kind: 'file'
  /** The file's own name (the last path segment). */
  name: string
  /** The repo-relative path exactly as git reported it (the row's identity). */
  path: string
  status: GitFileStatus
}

/** One directory row: its children plus the number of changed files beneath. */
export interface ChangeDir {
  kind: 'dir'
  /** The display label: one segment, or the compressed chain ('src/client'). */
  name: string
  /** The deepest directory this row stands for. */
  path: string
  children: ChangeNode[]
  /** Changed files anywhere under this row (the row's count pill). */
  changes: number
}

export type ChangeNode = ChangeDir | ChangeFile

/** A directory being assembled (children keyed by their own segment). */
interface DirDraft {
  name: string
  path: string
  dirs: Map<string, DirDraft>
  files: ChangeFile[]
}

/**
 * Directories before files, then by name — case-insensitively.
 *
 * The collation is PINNED (`'en'`, `sensitivity: 'base'`) rather than left to
 * the runtime's default locale: `localeCompare(other)` alone follows whatever
 * locale the browser/Node happens to run under, so the same change list could
 * order differently on two machines. Base sensitivity makes case and accent
 * variants compare equal, and the code-point tiebreak below then decides —
 * a total order that does not move when the input order changes.
 */
function compareNames(left: string, right: string): number {
  const collated = left.localeCompare(right, 'en', { sensitivity: 'base' })
  if (collated !== 0) return collated
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareNodes(left: ChangeNode, right: ChangeNode): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  return compareNames(left.name, right.name)
}

/** The number of changed files under a finished child list. */
function countFiles(nodes: readonly ChangeNode[]): number {
  let count = 0
  for (const node of nodes) count += node.kind === 'dir' ? node.changes : 1
  return count
}

/** Materialize one draft directory, compressing its single-child chain. */
function finishDir(draft: DirDraft): ChangeDir {
  let name = draft.name
  let current = draft
  // A directory with no file of its own and exactly one subdirectory is not
  // worth a row: the whole chain reads as one label (`a/b/c`). Compression
  // stops the moment the path branches or a file sits at this level, so a row
  // always stands for a place where something actually changed.
  while (current.files.length === 0 && current.dirs.size === 1) {
    const only = [...current.dirs.values()][0]!
    name = `${name}/${only.name}`
    current = only
  }
  const children = finishChildren(current)
  return { kind: 'dir', name, path: current.path, children, changes: countFiles(children) }
}

/** Finish a draft's children (directories first, then its own files). */
function finishChildren(draft: DirDraft): ChangeNode[] {
  const nodes: ChangeNode[] = []
  for (const child of draft.dirs.values()) nodes.push(finishDir(child))
  nodes.push(...draft.files)
  nodes.sort(compareNodes)
  return nodes
}

/**
 * Fold one group's changed files (unstaged or staged) into a directory tree.
 * Rows without a porcelain status (clean, ignored) are skipped, a repeated
 * path counts once, and an empty input yields an empty list.
 * @param entries - the group's `git status` entries.
 * @returns the tree's roots, ready to render in order.
 */
export function buildChangeTree(entries: readonly GitStatusEntry[]): ChangeNode[] {
  const root: DirDraft = { name: '', path: '', dirs: new Map(), files: [] }
  const seen = new Set<string>()
  for (const entry of entries) {
    const status = statusOfXY(entry.xy)
    if (status === undefined) continue
    const segments = entry.path.replace(/\\/g, '/').split('/').filter(segment => segment !== '' && segment !== '.')
    if (segments.length === 0) continue
    const normalized = segments.join('/')
    if (seen.has(normalized)) continue
    seen.add(normalized)
    let at = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!
      let next = at.dirs.get(name)
      if (next === undefined) {
        next = { name, path: segments.slice(0, index + 1).join('/'), dirs: new Map(), files: [] }
        at.dirs.set(name, next)
      }
      at = next
    }
    // The FILE keeps git's own spelling (the lane previews, copies and menus
    // all resolve this path); only the directory rows use the split form.
    at.files.push({ kind: 'file', name: segments[segments.length - 1]!, path: entry.path, status })
  }
  return finishChildren(root)
}
