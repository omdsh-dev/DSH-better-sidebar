/**
 * Explorer exclude-pattern matching (issue #18): pure, dependency-free
 * name matching used to hide noisy files/directories (e.g. Unity `.meta`,
 * `.DS_Store`, `node_modules`) from the sidebar explorer tree.
 *
 * A pattern is matched against the ENTRY NAME (not the full path), so
 * directories and files are treated alike (`node_modules`, `build`,
 * `*.meta` all work) and no cwd plumbing is needed on the client.
 * A single `*` wildcard matches any run of characters (0+); a pattern
 * without `*` is an exact-name match. Matching is case-insensitive for
 * cross-platform consistency (Windows/macOS filesystems are insensitive
 * anyway, and users think of `.meta` and `.META` as the same file).
 * Blank patterns (empty or whitespace-only) are ignored.
 *
 * Deliberately NOT a full glob implementation (`**`, `?`, `{a,b}`,
 * `[x]` are all unsupported — see
 * docs/plans/2026-08-14-explorer-exclude-design.md): keeping the runtime
 * dependency-free and the semantics predictable is the goal.
 */

/** One pattern compiled to an anchored, case-folded regex (undefined = blank). */
function patternToRegExp(pattern: string): RegExp | undefined {
  const trimmed = pattern.trim()
  if (trimmed === '') return undefined
  const pat = trimmed.toLowerCase()
  const star = pat.indexOf('*')
  if (star === -1) {
    // Exact-name match (case-insensitive).
    return new RegExp(`^${escapeRegExp(pat)}$`)
  }
  // Anchor the pattern and translate '*' → '.*'; everything else is
  // escaped literally so `foo[bar]`, `a+b`, `.` never read as regex.
  return new RegExp(`^${pat.split('*').map(escapeRegExp).join('.*')}$`)
}

/** Whether one pattern matches `name` (single `*` wildcard, case-insensitive). */
export function matchesExcludePattern(name: string, pattern: string): boolean {
  const re = patternToRegExp(pattern)
  return re === undefined ? false : re.test(name.toLowerCase())
}

/**
 * Precompile a pattern list into a `name => boolean` matcher (the regexes
 * are built once). Use this in render paths (the explorer calls it per row
 * per level) instead of {@link isExcludedName}, which recompiles on every
 * call.
 */
export function compileExcludePatterns(patterns: readonly string[]): (name: string) => boolean {
  const matchers: RegExp[] = []
  for (const pattern of patterns) {
    const re = patternToRegExp(pattern)
    if (re !== undefined) matchers.push(re)
  }
  return (name: string): boolean => {
    if (matchers.length === 0) return false
    const needle = name.toLowerCase()
    for (const re of matchers) {
      if (re.test(needle)) return true
    }
    return false
  }
}

/** Whether `name` is hidden by any of `patterns` (blank patterns ignored).
 *  Convenience form of {@link compileExcludePatterns} — fine for one-off
 *  checks, but render paths should precompile. */
export function isExcludedName(name: string, patterns: readonly string[]): boolean {
  return compileExcludePatterns(patterns)(name)
}

/** Escape one regex-special char (non-star part of a pattern). */
function escapeRegExp(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
