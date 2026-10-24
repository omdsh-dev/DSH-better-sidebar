/**
 * The JSONL CodeMirror language: one JSON document per line.
 *
 * Born from a measured problem with the obvious shortcut. Reusing
 * `@codemirror/lang-json` for a JSONL file "works" for tinting but is
 * structurally wrong: its grammar accepts ONE top-level value, so a 400-record
 * file parses into 402 error nodes. `languageKeyForExt('jsonl')` returning
 * `'json'` would therefore have shipped a file that looks highlighted and is
 * accounted broken — every structure query, fold and diagnostic built on it
 * inherits the damage, and a genuinely broken line stops being distinguishable
 * from the boundary noise.
 *
 * These tests walk the parse tree directly, because that is where the
 * difference is observable: the assertions are about node NAMES and COUNTS,
 * not about how a theme happened to paint them.
 */
import { describe, expect, it } from 'vitest'
import type { Language } from '@codemirror/language'
import { languageForPath, languageKeyForExt } from '../src/client/lang.ts'

/** Every named node of the tree, in document order. */
function nodesOf(path: string, doc: string): Array<{ name: string; from: number; to: number }> {
  const language = languageForPath(path)
  expect(language, `no language for ${path}`).not.toBeNull()
  const parser = (language as Language).parser
  const tree = parser.parse(doc)
  const nodes: Array<{ name: string; from: number; to: number }> = []
  tree.cursor().iterate(node => {
    nodes.push({ name: node.name, from: node.from, to: node.to })
  })
  return nodes
}

/**
 * The spans the tokenizer marked `invalid`.
 *
 * Deliberately NOT `node.type.isError`: a `StreamLanguage` token named
 * `invalid` maps to the `invalid` highlight tag and produces a NAMED node, not
 * a parser error node. Asserting on `isError` here would have passed on an
 * empty list forever while the tokenizer marked nothing at all.
 */
function invalidSpans(path: string, doc: string): Array<{ from: number; to: number }> {
  return nodesOf(path, doc).filter(node => node.name === 'invalid')
}

describe('the JSONL language mapping', () => {
  it('routes .jsonl and .ndjson to their own language key', () => {
    expect(languageKeyForExt('jsonl')).toBe('jsonl')
    expect(languageKeyForExt('ndjson')).toBe('jsonl')
    // The single-document extension keeps the stock grammar.
    expect(languageKeyForExt('json')).toBe('json')
    expect(languageKeyForExt('jsonc')).toBe('json')
  })

  it('leaves the stock JSON fixtures alone', () => {
    expect(languageForPath('/ws/package.json')).not.toBeNull()
    expect(languageForPath('/ws/log.jsonl')).not.toBeNull()
    expect(languageForPath('/ws/log.ndjson')).not.toBeNull()
  })
})

describe('a well-formed JSONL document has NO error nodes', () => {
  it('parses 400 records without a single error', () => {
    // The exact shape the `json()` shortcut fails on: 402 error nodes.
    const doc = `${Array.from({ length: 400 }, (_, i) => JSON.stringify({ i, msg: 'hello' })).join('\n')}\n`
    const errors = invalidSpans('/ws/logs/big.jsonl', doc)
    expect(errors).toEqual([])
    const nodes = nodesOf('/ws/logs/big.jsonl', doc)
    // And the records really were parsed, not skipped: each of the 400 records
    // is `{"i":n,"msg":"hello"}`, i.e. two keys and one number.
    expect(nodes.filter(node => node.name === 'propertyName')).toHaveLength(800)
    expect(nodes.filter(node => node.name === 'number')).toHaveLength(400)
    expect(nodes.filter(node => node.name === 'string')).toHaveLength(400)
  })

  it('keeps a broken line from spilling into the lines after it', () => {
    // A grammar with cross-line state would let one malformed record spoil
    // every later one. JSONL records are independent by definition, so the
    // only invalid spans in this document are on line 1.
    const doc = '{"a": oops}\n{"b": 2}\n{"c": 3}\n'
    const brokenEnd = doc.indexOf('\n')
    const errors = invalidSpans('/ws/logs/x.jsonl', doc)
    expect(errors.length).toBeGreaterThan(0)
    for (const span of errors) expect(span.from).toBeLessThan(brokenEnd)
    // The two good lines are fully parsed: their keys and their numbers.
    const nodes = nodesOf('/ws/logs/x.jsonl', doc)
    expect(nodes.filter(node => node.name === 'propertyName')).toHaveLength(3)
    expect(nodes.filter(node => node.name === 'number')).toHaveLength(2)
  })

  it('marks unrecognised text but does NOT invent errors for missing structure', () => {
    // A tokenizer is not a parser, and pretending otherwise would produce
    // false errors: `{"a":` has nothing in it that is not valid JSON — the
    // value is simply absent. Flagging it would mean guessing at structure,
    // which is the JSON grammar's job, not this one's.
    expect(invalidSpans('/ws/logs/x.jsonl', '{"a":\n{"b": 2}\n')).toEqual([])
    // What a tokenizer CAN prove, it does: the three words below are not JSON.
    expect(invalidSpans('/ws/logs/x.jsonl', 'oops\n')).toHaveLength(1)
  })
})

describe('token shapes', () => {
  it('distinguishes property names from string values', () => {
    const doc = '{"key": "value"}\n'
    const nodes = nodesOf('/ws/logs/x.jsonl', doc)
    const properties = nodes.filter(node => node.name === 'propertyName')
    expect(properties).toHaveLength(1)
    // The property span covers the quoted key, and the value stays a string.
    expect(doc.slice(properties[0]!.from, properties[0]!.to)).toBe('"key"')
    const strings = nodes.filter(node => node.name === 'string')
    expect(strings).toHaveLength(1)
    expect(doc.slice(strings[0]!.from, strings[0]!.to)).toBe('"value"')
  })

  it('treats a string followed by a colon across whitespace as a property', () => {
    const nodes = nodesOf('/ws/logs/x.jsonl', '{  "key"  :  1 }\n')
    expect(nodes.filter(node => node.name === 'propertyName')).toHaveLength(1)
  })

  it('does NOT call a value a property when no colon follows', () => {
    // The lookahead is what separates the two, so its negative case matters:
    // an array of strings has no property names at all.
    const nodes = nodesOf('/ws/logs/x.jsonl', '["a", "b"]\n')
    expect(nodes.filter(node => node.name === 'propertyName')).toHaveLength(0)
    expect(nodes.filter(node => node.name === 'string')).toHaveLength(2)
  })

  it('tags numbers, keywords and punctuation', () => {
    const doc = '{"a": -1.5e3, "b": true, "c": null, "d": "s"}\n'
    const nodes = nodesOf('/ws/logs/x.jsonl', doc)
    const spansOf = (name: string): string[] => nodes
      .filter(node => node.name === name)
      .map(node => doc.slice(node.from, node.to))
    // `-1.5e3` is ONE number token, not a minus plus a number.
    expect(spansOf('number')).toEqual(['-1.5e3'])
    // `true` and `null` share the keyword tag; the theme maps it to `atom`.
    expect(spansOf('atom')).toEqual(['true', 'null'])
    expect(spansOf('string')).toEqual(['"s"'])
    expect(spansOf('punctuation')).toEqual(['{', ':', ',', ':', ',', ':', ',', ':', '}'])
    expect(spansOf('invalid')).toEqual([])
  })

  it('handles escapes and nested quotes inside a string', () => {
    const doc = `${JSON.stringify({ msg: 'he said "hi" \\ and \\\\ done' })}\n`
    expect(invalidSpans('/ws/logs/x.jsonl', doc)).toEqual([])
    const nodes = nodesOf('/ws/logs/x.jsonl', doc)
    expect(nodes.filter(node => node.name === 'propertyName')).toHaveLength(1)
    expect(nodes.filter(node => node.name === 'string')).toHaveLength(1)
  })

  it('flags an unterminated string as invalid', () => {
    // A record cannot span lines, so a quote that never closes IS an error —
    // this is the one case a general JSON tokenizer could not call.
    const errors = invalidSpans('/ws/logs/x.jsonl', '{"a": "never closed\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.from).toBe(6)
  })

  it('flags a bare word and a broken number as invalid', () => {
    expect(invalidSpans('/ws/logs/x.jsonl', '{"a": nope}\n').length).toBeGreaterThan(0)
    expect(invalidSpans('/ws/logs/x.jsonl', 'not json at all\n').length).toBeGreaterThan(0)
    expect(invalidSpans('/ws/logs/x.jsonl', '--1\n').length).toBeGreaterThan(0)
  })

  it('flags a whole malformed line, not just its first character', () => {
    const errors = invalidSpans('/ws/logs/x.jsonl', 'BROKEN LINE HERE\n')
    // Every word is marked, which is what makes the marker readable as "this
    // line is not JSON" instead of a stray caret.
    expect(errors).toHaveLength(3)
  })

  it('accepts the blank line a JSONL writer leaves at the end', () => {
    expect(invalidSpans('/ws/logs/x.jsonl', '{"a": 1}\n\n')).toEqual([])
  })

  it('parses scalars, arrays and deeply nested records', () => {
    const doc = '1\n"two"\n[1, [2, [3]]]\n{"deep": {"deeper": {"x": [1]}}}\ntrue\nnull\n'
    expect(invalidSpans('/ws/logs/x.jsonl', doc)).toEqual([])
    const nodes = nodesOf('/ws/logs/x.jsonl', doc)
    const names = nodes.map(node => node.name)
    expect(names).toContain('number')
    expect(names).toContain('string')
    expect(names).toContain('atom')
    // Three nesting levels plus the array wrappers.
    expect(names.filter(name => name === 'punctuation').length).toBeGreaterThanOrEqual(12)
  })

  it('survives a very long single record', () => {
    const doc = `${JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => `v${i}`) })}\n`
    expect(invalidSpans('/ws/logs/x.jsonl', doc)).toEqual([])
  })
})
