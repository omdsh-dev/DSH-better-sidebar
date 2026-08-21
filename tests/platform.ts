/**
 * Shared platform guards for tests. Use vitest's `describe.skipIf` /
 * `it.skipIf` with these so platform-specific cases are REPORTED as skipped
 * on other hosts instead of silently passing through an inline `if` — and
 * so the opposite branch (e.g. POSIX rejecting drive paths) is always
 * asserted on the matching host.
 */

/** True when running on Windows (drive letters / UNC path semantics apply). */
export const isWin32 = process.platform === 'win32'
