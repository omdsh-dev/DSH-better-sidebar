/**
 * Parsing of chat path:line references and the editor jump meta: the shared
 * rules used by the chat-mentions resolver, the open-path interception and
 * the editor tab (see src/client/path-line.ts).
 */
import { describe, expect, it } from 'vitest'
import {
  isPlausiblePath,
  linePathWithSuffix,
  looksLikePath,
  parsePathLine,
  readJumpMeta,
} from '../src/client/path-line.ts'

describe('parsePathLine', () => {
  it('parses a single line suffix', () => {
    expect(parsePathLine('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', start: 42, end: 42 })
    expect(parsePathLine('foo.ts:1')).toEqual({ path: 'foo.ts', start: 1, end: 1 })
  })

  it('parses a start-end range', () => {
    expect(parsePathLine('src/foo.ts:42-56')).toEqual({ path: 'src/foo.ts', start: 42, end: 56 })
  })

  it('accepts and ignores a column suffix (line:col)', () => {
    expect(parsePathLine('lib/utils.ts:10:5')).toEqual({ path: 'lib/utils.ts', start: 10, end: 10 })
    expect(parsePathLine('lib/utils.ts:10-20:5')).toEqual({ path: 'lib/utils.ts', start: 10, end: 20 })
  })

  it('keeps Windows drive letters and absolute roots intact', () => {
    expect(parsePathLine('C:\\proj\\foo.ts:42')).toEqual({ path: 'C:\\proj\\foo.ts', start: 42, end: 42 })
    expect(parsePathLine('/abs/path/foo.ts:7-9')).toEqual({ path: '/abs/path/foo.ts', start: 7, end: 9 })
  })

  it('accepts extensionless build files but rejects lowercase prose tokens', () => {
    expect(parsePathLine('Makefile:12')).toEqual({ path: 'Makefile', start: 12, end: 12 })
    expect(parsePathLine('Dockerfile:15')).toEqual({ path: 'Dockerfile', start: 15, end: 15 })
    expect(parsePathLine('host:8080')).toBeNull()
    expect(parsePathLine('localhost:3000')).toBeNull()
  })

  it('rejects values with no line suffix, URLs, whitespace, or digit-only paths', () => {
    expect(parsePathLine('src/foo.ts')).toBeNull()
    expect(parsePathLine('12:30')).toBeNull()
    expect(parsePathLine('https://host:8080')).toBeNull()
    expect(parsePathLine('src/foo bar.ts:42')).toBeNull()
    expect(parsePathLine(':42')).toBeNull()
  })

  it('normalizes a backwards range to the single start line', () => {
    expect(parsePathLine('src/foo.ts:5-3')).toEqual({ path: 'src/foo.ts', start: 5, end: 5 })
  })

  it('linePathWithSuffix is the inverse of parsePathLine', () => {
    const single = parsePathLine('src/foo.ts:42')!
    expect(linePathWithSuffix(single)).toBe('src/foo.ts:42')
    const range = parsePathLine('src/foo.ts:42-56')!
    expect(linePathWithSuffix(range)).toBe('src/foo.ts:42-56')
  })
})

describe('isPlausiblePath', () => {
  it('accepts separators, extensions, and uppercase build-file names', () => {
    expect(isPlausiblePath('src/foo.ts')).toBe(true)
    expect(isPlausiblePath('C:\\proj\\foo.ts')).toBe(true)
    expect(isPlausiblePath('webpack.config.js')).toBe(true)
    expect(isPlausiblePath('Makefile')).toBe(true)
  })

  it('rejects URLs, whitespace, digits, empty and lowercase-prose tokens', () => {
    expect(isPlausiblePath('https://host')).toBe(false)
    expect(isPlausiblePath('a b')).toBe(false)
    expect(isPlausiblePath('123')).toBe(false)
    expect(isPlausiblePath('')).toBe(false)
    expect(isPlausiblePath('host')).toBe(false)
    expect(isPlausiblePath('a')).toBe(false)
  })
})

describe('looksLikePath', () => {
  it('accepts separator-carrying paths', () => {
    expect(looksLikePath('src/main.ts')).toBe(true)
    expect(looksLikePath('./src/main.ts')).toBe(true)
    expect(looksLikePath('C:\\proj\\foo.ts')).toBe(true)
    expect(looksLikePath('/abs/foo.ts')).toBe(true)
  })

  it('rejects bare tokens, dotted method names, URLs and whitespace', () => {
    expect(looksLikePath('obj.method')).toBe(false)
    expect(looksLikePath('npm')).toBe(false)
    expect(looksLikePath('main.ts')).toBe(false)
    expect(looksLikePath('https://host/x')).toBe(false)
    expect(looksLikePath('a b.ts')).toBe(false)
  })
})

describe('readJumpMeta', () => {
  it('reads a valid line range from the tab meta', () => {
    expect(readJumpMeta({ line: { start: 42, end: 56 } })).toEqual({ start: 42, end: 56 })
    expect(readJumpMeta({ line: { start: 3, end: 3 } })).toEqual({ start: 3, end: 3 })
  })

  it('rejects malformed, missing, or invalid shapes', () => {
    expect(readJumpMeta(undefined)).toBeNull()
    expect(readJumpMeta(null)).toBeNull()
    expect(readJumpMeta({})).toBeNull()
    expect(readJumpMeta({ line: '42' })).toBeNull()
    expect(readJumpMeta({ line: { start: '42', end: 56 } })).toBeNull()
    expect(readJumpMeta({ line: { start: 0, end: 1 } })).toBeNull()
    expect(readJumpMeta({ line: { start: 56, end: 42 } })).toBeNull()
    expect(readJumpMeta({ other: 1 })).toBeNull()
  })
})
