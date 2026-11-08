/**
 * JSONL record handling for the preview: one line, one independent document.
 *
 * The preview never parses the file as a single JSON value — that is the whole
 * point of treating JSONL as its own format. These are the pure helpers behind
 * that: the extension test, the per-line parse, and the collapsed one-line
 * summary a record row shows before it is expanded into the host's JsonTree.
 */
import { describe, expect, it } from 'vitest'
import { isJsonlPath, isTreeRecord, parseRecord, summarizeRecord } from '../src/client/jsonl.ts'

describe('isJsonlPath', () => {
  it('claims .jsonl and .ndjson, case-insensitively', () => {
    expect(isJsonlPath('/ws/logs/session.jsonl')).toBe(true)
    expect(isJsonlPath('/ws/data/events.ndjson')).toBe(true)
    expect(isJsonlPath('/ws/DATA/EVENTS.JSONL')).toBe(true)
  })

  it('leaves plain .json, .jsonc and unrelated extensions alone', () => {
    // `.json` is a single document: the `code` viewer's stock JSON grammar is
    // right for it, and the record list would be wrong.
    expect(isJsonlPath('/ws/package.json')).toBe(false)
    expect(isJsonlPath('/ws/tsconfig.jsonc')).toBe(false)
    expect(isJsonlPath('/ws/notes.txt')).toBe(false)
    expect(isJsonlPath('/ws/jsonl')).toBe(false)
  })
})

describe('parseRecord', () => {
  it('parses each line as its own document', () => {
    expect(parseRecord('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseRecord('[1,2,3]')).toEqual({ ok: true, value: [1, 2, 3] })
    expect(parseRecord('42')).toEqual({ ok: true, value: 42 })
    expect(parseRecord('"a string"')).toEqual({ ok: true, value: 'a string' })
    expect(parseRecord('null')).toEqual({ ok: true, value: null })
    expect(parseRecord('true')).toEqual({ ok: true, value: true })
  })

  it('tolerates surrounding whitespace (the host trims at a line break, not a token)', () => {
    expect(parseRecord('  {"a": 1}  ')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseRecord('\t{"a": 1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reports a blank line as an empty failure, so the caller can SKIP it', () => {
    // JSONL files normally end with a newline, and the host's pages are
    // line-aligned — so a trailing blank lands as its own row. Rendering it as
    // "this line is not valid JSON" would put a fake error at the end of every
    // well-formed file in the world.
    expect(parseRecord('')).toEqual({ ok: false, error: '' })
    expect(parseRecord('   ')).toEqual({ ok: false, error: '' })
  })

  it('reports a broken line with its reason', () => {
    const broken = parseRecord('{"a": }')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error.length).toBeGreaterThan(0)
  })

  it('is not fooled by a JSON value that spans lines', () => {
    // A record CANNOT span lines in JSONL: the first line is incomplete and
    // the second is a stray continuation. Both must fail rather than being
    // silently glued together.
    expect(parseRecord('{"a":').ok).toBe(false)
    expect(parseRecord('1}').ok).toBe(false)
  })
})

describe('isTreeRecord', () => {
  it('accepts objects and arrays, rejects primitives and null', () => {
    expect(isTreeRecord({})).toBe(true)
    expect(isTreeRecord([])).toBe(true)
    expect(isTreeRecord('s')).toBe(false)
    expect(isTreeRecord(1)).toBe(false)
    expect(isTreeRecord(true)).toBe(false)
    // `null` is typeof 'object' — the classic trap this guard exists for.
    expect(isTreeRecord(null)).toBe(false)
  })
})

describe('summarizeRecord', () => {
  it('inlines first-level primitives and elides nesting', () => {
    expect(summarizeRecord({ type: 'assistant', n: 3, ok: true, none: null }))
      .toBe('{type: "assistant", n: 3, ok: true, none: null}')
    expect(summarizeRecord({ a: { deep: 1 }, b: [1, 2, 3] })).toBe('{a: {…}, b: […3]}')
  })

  it('names arrays by length and empty objects literally', () => {
    expect(summarizeRecord([])).toBe('[0 items]')
    expect(summarizeRecord([1, 2])).toBe('[2 items]')
    expect(summarizeRecord({})).toBe('{}')
  })

  it('renders scalars as their JSON literal', () => {
    expect(summarizeRecord('hi')).toBe('"hi"')
    expect(summarizeRecord(12)).toBe('12')
    expect(summarizeRecord(null)).toBe('null')
  })

  it('caps the summary at one scannable line', () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, 'v'.repeat(20)]))
    const summary = summarizeRecord(wide)
    expect(summary.length).toBeLessThanOrEqual(200)
    expect(summary.endsWith('…}')).toBe(true)
  })

  it('marks an elided object with an ellipsis tail and no trailing comma', () => {
    const summary = summarizeRecord({ a: 1, b: { deep: true } })
    expect(summary).toBe('{a: 1, b: {…}}')
  })
})
