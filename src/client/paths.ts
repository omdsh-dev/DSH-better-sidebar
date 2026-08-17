/**
 * Path projection helpers shared by the explorer rows: a path relative to
 * the session cwd (for the @-reference button and "copy relative path").
 * The fs-tree joins with '/' even on Windows, so both separators normalize
 * to '/' before comparison.
 */

/**
 * The last path segment (platform-independent: '/' and '\' both split), with
 * trailing separators trimmed ('/a/b/' → 'b'). Used for the explorer's root
 * label and for deriving file icons (basename → icon-theme lookup).
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
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
