/**
 * Unit tests for the `path:line` spec splitter (src/client/path-line.ts).
 *
 * The rule under test is the one DSH's own markdown grammar cannot express:
 * it reads a `#`-less link destination as a file name VERBATIM, so
 * `[a/b.c](a/b.c:131)` addresses `b.c:131` (#826). Every case below is a
 * spelling a model, a compiler diagnostic or a terminal emits — and a short
 * list of ones that must survive untouched because they are already valid
 * file names.
 */
import { describe, expect, it } from 'vitest'
import { splitTrailingLineSpec } from '../src/client/path-line.ts'

describe('splitTrailingLineSpec', () => {
  it('splits a bare line spec off a relative path', () => {
    expect(splitTrailingLineSpec('omlx/custom_kernels/bonsai/csrc/CMakeLists.txt:131')).toEqual({
      path: 'omlx/custom_kernels/bonsai/csrc/CMakeLists.txt',
      line: 131,
      end: 131,
      column: undefined,
    })
  })

  it('splits a range spec, reporting both ends', () => {
    expect(splitTrailingLineSpec('src/main.ts:42-56')).toMatchObject({
      path: 'src/main.ts',
      line: 42,
      end: 56,
    })
  })

  it('splits a line:column spec (the shape the LSP hover tool prints)', () => {
    expect(splitTrailingLineSpec('src/main.ts:42:7')).toMatchObject({
      path: 'src/main.ts',
      line: 42,
      end: 42,
      column: 7,
    })
  })

  it('splits a spec off an absolute POSIX path and a Windows path', () => {
    expect(splitTrailingLineSpec('/work/pkg/a/b.txt:5')?.path).toBe('/work/pkg/a/b.txt')
    expect(splitTrailingLineSpec('C:\\work\\pkg\\a\\b.txt:5')?.path).toBe('C:\\work\\pkg\\a\\b.txt')
    expect(splitTrailingLineSpec('//server/share/a.txt:5')?.path).toBe('//server/share/a.txt')
  })

  it('splits a spec off an extensionless name', () => {
    expect(splitTrailingLineSpec('Makefile:12')).toMatchObject({ path: 'Makefile', line: 12 })
  })

  it('leaves a path without a spec alone', () => {
    expect(splitTrailingLineSpec('src/main.ts')).toBeUndefined()
    expect(splitTrailingLineSpec('')).toBeUndefined()
  })

  it('leaves names that merely contain a colon alone', () => {
    // A version-ish or namespaced name: the spec has to END the string.
    expect(splitTrailingLineSpec('data:2024.csv')).toBeUndefined()
    expect(splitTrailingLineSpec('schema:name.json')).toBeUndefined()
    // A bare drive, with and without a spec — `C` is not a file name.
    expect(splitTrailingLineSpec('C:')).toBeUndefined()
    expect(splitTrailingLineSpec('C:131')).toBeUndefined()
    // Nothing in front of the spec.
    expect(splitTrailingLineSpec(':131')).toBeUndefined()
    // Trailing colon, no digits.
    expect(splitTrailingLineSpec('src/main.ts:')).toBeUndefined()
    expect(splitTrailingLineSpec('src/main.ts:build')).toBeUndefined()
  })

  it('refuses a zero or zero-padded line, exactly like the host fragment rule', () => {
    // The host's `#L` grammar is ^L([1-9]\d*) — 1-based, no leading zero.
    expect(splitTrailingLineSpec('a.c:0')).toBeUndefined()
    expect(splitTrailingLineSpec('a.c:012')).toBeUndefined()
    expect(splitTrailingLineSpec('a.c:1')).toMatchObject({ line: 1 })
  })

  it('refuses an inverted range instead of silently reordering it', () => {
    expect(splitTrailingLineSpec('a.c:20-12')).toBeUndefined()
  })
})
