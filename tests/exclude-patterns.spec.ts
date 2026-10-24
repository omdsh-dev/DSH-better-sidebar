/**
 * Unit tests for the explorer's VS Code-style exclude pattern compiler
 * (src/exclude-patterns.ts): the one matcher both host surfaces (fs.trees
 * listing and fs.search walk) share, plus the {@link ExcludeMatcher.key} the
 * host's level cache keys filtered listings on.
 */
import { describe, expect, it } from 'vitest'
import { compileExcludePatterns, EXCLUDE_PATTERN_LIMIT, EXCLUDE_PATTERN_MAX_LENGTH } from '../src/exclude-patterns.ts'

const ROOT = '/work/project'
const test = (patterns: unknown[], path: string, name = path.split('/').pop()!) =>
  compileExcludePatterns(patterns, ROOT, 'posix')?.(path, name) ?? false

describe('compileExcludePatterns', () => {
  it('returns undefined for missing / empty / non-array input (no-pattern fast path)', () => {
    expect(compileExcludePatterns(undefined, ROOT, 'posix')).toBeUndefined()
    expect(compileExcludePatterns([], ROOT, 'posix')).toBeUndefined()
    expect(compileExcludePatterns('node_modules', ROOT, 'posix')).toBeUndefined()
    expect(compileExcludePatterns(['', '   ', '**'], ROOT, 'posix')).toBeUndefined()
  })

  it('matches plain names at any depth', () => {
    const patterns = ['Thumbs.db', 'node_modules']
    expect(test(patterns, `${ROOT}/Thumbs.db`)).toBe(true)
    expect(test(patterns, `${ROOT}/deep/dir/Thumbs.db`)).toBe(true)
    expect(test(patterns, `${ROOT}/node_modules`)).toBe(true)
    expect(test(patterns, `${ROOT}/keep.txt`)).toBe(false)
    // A name pattern is anchored: a substring or superstring does not match.
    expect(test(patterns, `${ROOT}/Thumbs.db2`)).toBe(false)
    expect(test(patterns, `${ROOT}/my-node_modules-x`)).toBe(false)
  })

  it('supports * and ? wildcards within one segment', () => {
    expect(test(['*.log'], `${ROOT}/app.log`)).toBe(true)
    expect(test(['*.log'], `${ROOT}/deep/app.log`)).toBe(true)
    // `*` never crosses a segment boundary (the rel path stays unmatchable).
    expect(test(['*.log'], `${ROOT}/log`)).toBe(false)
    expect(test(['temp-?'], `${ROOT}/temp-1`)).toBe(true)
    expect(test(['temp-?'], `${ROOT}/temp-12`)).toBe(false)
  })

  it('matches path patterns anchored at the session cwd', () => {
    expect(test(['build/out'], `${ROOT}/build/out`)).toBe(true)
    expect(test(['build/out'], `${ROOT}/src/build/out`)).toBe(false)
    expect(test(['build/*'], `${ROOT}/build/main.o`)).toBe(true)
    expect(test(['build/*'], `${ROOT}/build/sub/main.o`)).toBe(false)
    expect(test(['build/**'], `${ROOT}/build/sub/main.o`)).toBe(true)
  })

  it('matches a doublestar-slash head at any depth (name and segment runs)', () => {
    expect(test(['**/.git'], `${ROOT}/.git`)).toBe(true)
    expect(test(['**/.git'], `${ROOT}/deep/.git`)).toBe(true)
    expect(test(['**/cache/tmp'], `${ROOT}/cache/tmp`)).toBe(true)
    expect(test(['**/cache/tmp'], `${ROOT}/deep/cache/tmp`)).toBe(true)
    expect(test(['**/cache/tmp'], `${ROOT}/deep/cache/other`)).toBe(false)
  })

  it('normalizes decorations: backslashes, ./, leading and trailing slashes', () => {
    expect(test(['node_modules\\'], `${ROOT}/node_modules`)).toBe(true)
    expect(test(['./dist/'], `${ROOT}/dist`)).toBe(true)
    expect(test(['/dist'], `${ROOT}/dist`)).toBe(true)
    expect(test(['build\\out'], `${ROOT}/build/out`)).toBe(true)
  })

  it('escapes regex specials literally', () => {
    expect(test(['a.b'], `${ROOT}/a.b`)).toBe(true)
    expect(test(['a.b'], `${ROOT}/axb`)).toBe(false)
    expect(test(['(x)'], `${ROOT}/(x)`)).toBe(true)
  })

  it('matches case-insensitively on win32 only', () => {
    const win = compileExcludePatterns(['Thumbs.db'], 'C:\\work', 'win32')!
    expect(win('C:\\work\\thumbs.db', 'thumbs.db')).toBe(true)
    expect(test(['Thumbs.db'], `${ROOT}/thumbs.db`)).toBe(false)
  })

  it('drops malformed entries without breaking the rest', () => {
    const patterns = ['', 3, null, '**', '  ', '*.tmp'] as unknown[]
    const matcher = compileExcludePatterns(patterns, ROOT, 'posix')!
    expect(matcher(`${ROOT}/scratch.tmp`, 'scratch.tmp')).toBe(true)
    expect(matcher(`${ROOT}/keep.txt`, 'keep.txt')).toBe(false)
  })

  it('caps pattern count and length', () => {
    const many = Array.from({ length: EXCLUDE_PATTERN_LIMIT + 5 }, (_, i) => `file-${i}`)
    const matcher = compileExcludePatterns(many, ROOT, 'posix')!
    expect(matcher(`${ROOT}/file-0`, 'file-0')).toBe(true)
    expect(matcher(`${ROOT}/file-${EXCLUDE_PATTERN_LIMIT + 1}`, `file-${EXCLUDE_PATTERN_LIMIT + 1}`)).toBe(false)
    const long = 'x'.repeat(EXCLUDE_PATTERN_MAX_LENGTH + 1)
    expect(compileExcludePatterns([long], ROOT, 'posix')).toBeUndefined()
  })

  // The host's level cache keys listings on this identity, so a matcher that
  // lied about its patterns would serve rows filtered by somebody else's list.
  describe('the matcher key (the host cache dimension)', () => {
    it('is equal for pattern sets that normalize alike', () => {
      const a = compileExcludePatterns(['dist/', './dist'], ROOT, 'posix')!
      const b = compileExcludePatterns(['/dist', 'dist'], ROOT, 'posix')!
      expect(a.key).toBe(b.key)
      // The key is derived from the normalized list, not deduplicated: a
      // repeated pattern splits the key. That direction is safe — an
      // over-split costs one cache miss, never a wrongly filtered listing.
      expect(a.key).not.toBe(compileExcludePatterns(['dist'], ROOT, 'posix')!.key)
    })

    it('differs when the patterns differ, and when the anchor root differs', () => {
      const base = compileExcludePatterns(['*.log'], ROOT, 'posix')!
      expect(base.key).not.toBe(compileExcludePatterns(['*.tmp'], ROOT, 'posix')!.key)
      // Path-anchored kinds resolve against the root, so two sessions with the
      // same patterns but different cwds match one directory differently.
      expect(base.key).not.toBe(compileExcludePatterns(['*.log'], '/other', 'posix')!.key)
      // Case-folding is part of the compiled regex, hence part of the identity.
      expect(compileExcludePatterns(['a'], '/x', 'posix')!.key)
        .not.toBe(compileExcludePatterns(['a'], '/x', 'win32')!.key)
    })

    it('gives malformed-only input the undefined fast path (never an empty key)', () => {
      expect(compileExcludePatterns(['', '  ', '**'], ROOT, 'posix')).toBeUndefined()
    })
  })
})
