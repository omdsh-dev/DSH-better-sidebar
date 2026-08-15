/**
 * Exclude-pattern matching specs (issue #18): exact-name matches, the
 * single-`*` wildcard (prefix / suffix / middle), case-insensitivity,
 * blank-pattern handling, and regex-special characters being treated
 * literally.
 */
import { describe, expect, it } from 'vitest'
import { isExcludedName, matchesExcludePattern } from '../src/exclude-patterns.ts'

describe('matchesExcludePattern', () => {
  it('exact name match without a wildcard', () => {
    expect(matchesExcludePattern('node_modules', 'node_modules')).toBe(true)
    expect(matchesExcludePattern('.DS_Store', '.DS_Store')).toBe(true)
    expect(matchesExcludePattern('index.ts', 'index.ts')).toBe(true)
    expect(matchesExcludePattern('index.ts', 'index.js')).toBe(false)
  })

  it('wildcard suffix (*.meta)', () => {
    expect(matchesExcludePattern('Player.meta', '*.meta')).toBe(true)
    expect(matchesExcludePattern('.meta', '*.meta')).toBe(true)
    expect(matchesExcludePattern('meta', '*.meta')).toBe(false)
    expect(matchesExcludePattern('Player.META', '*.meta')).toBe(true)
    expect(matchesExcludePattern('Player.metabak', '*.meta')).toBe(false)
  })

  it('wildcard prefix (build*)', () => {
    expect(matchesExcludePattern('build', 'build*')).toBe(true)
    expect(matchesExcludePattern('build-ios', 'build*')).toBe(true)
    expect(matchesExcludePattern('rebuild', 'build*')).toBe(false)
  })

  it('wildcard in the middle (foo*bar)', () => {
    expect(matchesExcludePattern('foobar', 'foo*bar')).toBe(true)
    expect(matchesExcludePattern('fooXYZbar', 'foo*bar')).toBe(true)
    expect(matchesExcludePattern('foo.bar', 'foo*bar')).toBe(true)
    expect(matchesExcludePattern('foobaz', 'foo*bar')).toBe(false)
    expect(matchesExcludePattern('xxfoobar', 'foo*bar')).toBe(false)
  })

  it('bare * matches everything (and the empty string)', () => {
    expect(matchesExcludePattern('anything', '*')).toBe(true)
    expect(matchesExcludePattern('', '*')).toBe(true)
  })

  it('case-insensitive by design', () => {
    expect(matchesExcludePattern('README.MD', '*.md')).toBe(true)
    expect(matchesExcludePattern('Node_Modules', 'node_modules')).toBe(true)
    expect(matchesExcludePattern('Thumbs.DB', 'thumbs.db')).toBe(true)
  })

  it('blank and whitespace-only patterns never match', () => {
    expect(matchesExcludePattern('a', '')).toBe(false)
    expect(matchesExcludePattern('a', '   ')).toBe(false)
  })

  it('regex-special characters are matched literally', () => {
    // `.` must not act as "any char"
    expect(matchesExcludePattern('aXb', 'a.b')).toBe(false)
    expect(matchesExcludePattern('a.b', 'a.b')).toBe(true)
    // character classes / groups / alternation are literal text
    expect(matchesExcludePattern('a.b', 'a[.]b')).toBe(false)
    expect(matchesExcludePattern('a[.]b', 'a[.]b')).toBe(true)
    expect(matchesExcludePattern('axb', 'a+b')).toBe(false)
    expect(matchesExcludePattern('a+b', 'a+b')).toBe(true)
    expect(matchesExcludePattern('a?b', 'a?b')).toBe(true)
  })

  it('wildcard still works alongside literal specials', () => {
    expect(matchesExcludePattern('a.b.c', '*.b.*')).toBe(true)
    expect(matchesExcludePattern('aXbYc', '*.b.*')).toBe(false)
  })
})

describe('isExcludedName', () => {
  it('matches when any pattern hits', () => {
    expect(isExcludedName('Player.meta', ['*.meta', 'node_modules'])).toBe(true)
    expect(isExcludedName('node_modules', ['*.meta', 'node_modules'])).toBe(true)
    expect(isExcludedName('src', ['*.meta', 'node_modules'])).toBe(false)
  })

  it('ignores blank entries in the list', () => {
    expect(isExcludedName('a.meta', ['', '   ', '*.meta'])).toBe(true)
    expect(isExcludedName('a.ts', ['', '   '])).toBe(false)
  })

  it('empty list excludes nothing', () => {
    expect(isExcludedName('anything', [])).toBe(false)
  })
})
