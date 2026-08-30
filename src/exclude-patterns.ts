/**
 * Glob-style exclude patterns for the explorer tree and name search — the
 * VS Code `files.exclude` lineage. One compiled matcher serves BOTH host
 * consumption points (the `fs.tree` level listing and the `fs.search` walk)
 * so a pattern can never disagree between the two surfaces.
 *
 * Pattern grammar (a deliberate subset of VS Code's globs):
 *  - `name`            matches that base NAME at any depth (`Thumbs.db`);
 *  - `dir/name`        path-anchored at the session cwd (`build/out`);
 *  - doublestar-slash head (`**` + `/name`) matches at any depth (the head strips away);
 *  - `*` / `?`         wildcards within one segment; `**` spans segments.
 * Matching is case-sensitive on POSIX and case-insensitive on Windows (the
 * filesystem's own notion). Invalid shapes (empty, overlong, over the count
 * cap) are dropped silently — a malformed pattern must never break the tree.
 */
import { relative, sep } from 'node:path'

/** Hard cap on how many patterns one request may carry (extras dropped). */
export const EXCLUDE_PATTERN_LIMIT = 64
/** Hard cap on one pattern's length (longer ones dropped). */
export const EXCLUDE_PATTERN_MAX_LENGTH = 256

/** One entry probe: the entry's absolute path and its base name. */
export type ExcludeTest = (entryPath: string, name: string) => boolean

/** One compiled pattern and the surface it claims. */
interface CompiledPattern {
  /** 'name' tests the base name anywhere; 'path' tests the cwd-relative
   *  path anchored at the root; 'suffix' (a doublestar-slash head shape) tests
   *  the name
   *  OR any trailing segment run of the relative path. */
  kind: 'name' | 'path' | 'suffix'
  regex: RegExp
}

/**
 * Normalize one raw pattern (accepts unknown wire values): trim, unify
 * separators, drop the doublestar-slash head (remembered as a suffix kind) and the
 * `./` and trailing-/ decorations. Returns undefined for empty/invalid input.
 */
function normalizePattern(raw: unknown): { kind: CompiledPattern['kind']; body: string } | undefined {
  if (typeof raw !== 'string') return undefined
  let pattern = raw.trim().replace(/\\/g, '/')
  if (pattern.length > EXCLUDE_PATTERN_MAX_LENGTH) return undefined
  while (pattern.startsWith('./')) pattern = pattern.slice(2)
  while (pattern.startsWith('/')) pattern = pattern.slice(1)
  while (pattern.endsWith('/')) pattern = pattern.slice(0, -1)
  let kind: CompiledPattern['kind'] = 'name'
  if (pattern.startsWith('**/')) {
    kind = 'suffix'
    pattern = pattern.slice(3)
  }
  if (pattern === '' || pattern === '**') {
    // A bare `**` (or one that stripped to nothing) would swallow the whole
    // tree — refuse it instead of hiding everything.
    return undefined
  }
  if (kind === 'name' && pattern.includes('/')) kind = 'path'
  return { kind, body: pattern }
}

/** Compile one normalized glob body to an anchored RegExp. */
function globToRegExp(body: string, insensitive: boolean): RegExp {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!
    if (char === '*') {
      if (body[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, insensitive ? 'i' : undefined)
}

/** The cwd-relative '/' path of `entryPath` (undefined when outside `root`). */
function relativeToRoot(root: string, entryPath: string): string | undefined {
  const rel = relative(root, entryPath).split(sep).join('/')
  return rel.startsWith('..') ? undefined : rel
}

/**
 * Compile the wire patterns into one entry probe.
 * @param raw - the request payload's `exclude` field (anything; validated).
 * @param root - the session cwd the path-anchored patterns resolve against.
 * @param platform - case-folding semantics (`'win32'` matches insensitively).
 * @returns the probe, or undefined when nothing valid was declared (callers
 * skip filtering entirely then — the no-pattern fast path).
 */
export function compileExcludePatterns(
  raw: unknown,
  root: string,
  platform: NodeJS.Platform | 'posix' = process.platform,
): ExcludeTest | undefined {
  if (!Array.isArray(raw)) return undefined
  const compiled: CompiledPattern[] = []
  for (const item of raw) {
    if (compiled.length >= EXCLUDE_PATTERN_LIMIT) break
    const normalized = normalizePattern(item)
    if (normalized === undefined) continue
    compiled.push({ kind: normalized.kind, regex: globToRegExp(normalized.body, platform === 'win32') })
  }
  if (compiled.length === 0) return undefined
  const needsRel = compiled.some(pattern => pattern.kind !== 'name')
  return (entryPath: string, name: string): boolean => {
    let rel: string | undefined
    for (const pattern of compiled) {
      if (pattern.kind === 'name') {
        if (pattern.regex.test(name)) return true
        continue
      }
      if (rel === undefined) {
        if (!needsRel) continue
        rel = relativeToRoot(root, entryPath) ?? ''
      }
      if (pattern.kind === 'path') {
        if (rel !== '' && pattern.regex.test(rel)) return true
        continue
      }
      // Suffix kind: the name itself or any trailing segment run of rel.
      if (pattern.regex.test(name)) return true
      if (rel !== '') {
        const segments = rel.split('/')
        for (let start = 0; start < segments.length - 1; start += 1) {
          if (pattern.regex.test(segments.slice(start).join('/'))) return true
        }
      }
    }
    return false
  }
}
