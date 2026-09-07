/**
 * Path projection helpers shared by the explorer rows: workspace-relative
 * mentions and session-cwd-relative "copy relative path".
 * The fs-tree joins with '/' even on Windows, so both separators normalize
 * to '/' before comparison.
 *
 * This module is dependency-free (no node:path in the client bundle): the
 * host is the authority for path semantics, so this mirror deliberately
 * accepts a SUPERSET of absolute forms — anything a Windows host would emit
 * (drive letters, UNC) plus POSIX roots. A form the host would reject
 * (e.g. a backslash UNC path on a POSIX host) passes through here and then
 * fails loudly in the host's requireAbsolute instead of being silently
 * joined onto the cwd.
 */

/**
 * Mirror of the host's absolute-path notion (see fs-tree.requireAbsolute):
 * POSIX roots, Windows drive letters, and Windows UNC network shares in
 * both backslash (`\\server\share\...`) and forward-slash
 * (`//server/share/...`) form. Deliberately a superset — see the module
 * comment — so a produced UNC path is never joined onto the cwd.
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
}

/**
 * The path relative to the session's working directory.
 * @param cwd - the explorer root (absolute).
 * @param path - an absolute entry path from the fs-tree.
 * @returns the relative path with '/' separators ('.' for the cwd itself),
 * or `path` unchanged when it lies outside the cwd.
 *
 * The prefix test is case-insensitive: Windows paths (and macOS's
 * case-insensitive volumes) may arrive with different casing than the cwd
 * row, and the containment decision must not depend on it. The returned
 * relative text keeps the caller's own casing.
 */
export function relativeTo(cwd: string, path: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  const norm = (value: string): string => value.replace(/\\/g, '/')
  const nBase = norm(base)
  const nPath = norm(path)
  if (nPath === nBase) return '.'
  if (nPath.toLowerCase().startsWith(`${nBase.toLowerCase()}/`)) return nPath.slice(nBase.length + 1)
  return path
}

/**
 * Project an absolute explorer entry against the host-confirmed workspace
 * root. Unlike copy-relative-path's `relativeTo`, mention insertion must
 * never fall back to an absolute token. Unknown roots, traversal components
 * and paths outside the workspace are refused. Windows drive/UNC paths are
 * case-insensitive; POSIX paths retain their case-sensitive distinction.
 */
export function workspaceRelativePath(root: string | undefined, path: string): string | undefined {
  if (root === undefined || !isAbsolutePath(root) || !isAbsolutePath(path)) return undefined
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(root)
  const target = norm(path)
  if ([base, target].some(value => value.split('/').some(part => part === '.' || part === '..'))) return undefined
  const windows = /^[A-Za-z]:\//.test(root.replace(/\\/g, '/')) || /^[\\/]{2}/.test(root)
  const compare = (value: string): string => windows ? value.toLowerCase() : value
  if (compare(target) === compare(base)) return '.'
  if (!compare(target).startsWith(`${compare(base)}/`)) return undefined
  const relative = target.slice(base.length + 1)
  return relative === '' || isAbsolutePath(relative) ? undefined : relative
}

/**
 * Whether `target` lies under `base` (or equals it), tolerant of separator
 * style and — on Windows-style drive paths — of letter case. A client-side
 * mirror of the host's `isWithin` (fs-tree.ts) used to decide whether a
 * git-derived path can be opened in the editor (a linked worktree outside
 * the session workspace cannot: the host's workspace fence would reject it).
 */
export function isWithinWorkspace(base: string, target: string): boolean {
  const norm = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  const lb = b.toLowerCase()
  const lt = t.toLowerCase()
  return lt === lb || lt.startsWith(`${lb}/`)
}

/**
 * The last path segment of a '/'- or '\'-separated path (a diff tab title,
 * a worktree label). Returns the whole string when no separator is present.
 */
export function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * The lowercased file extension of a path ('' when none). The dot must sit
 * inside the last segment — a dot in a directory name is not an extension.
 * Shared by the editor language mapping (lang.ts) and the viewer registry's
 * extension matching (service.ts), which both live in the core bundle.
 */
export function extOf(path: string): string {
  const at = path.lastIndexOf('.')
  if (at === -1) return ''
  const base = path.slice(at + 1).toLowerCase()
  return base.includes('/') || base.includes('\\') ? '' : base
}
