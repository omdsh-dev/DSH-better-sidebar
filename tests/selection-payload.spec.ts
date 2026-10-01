/**
 * Pure payload logic for the viewer selection popup ("add to
 * conversation"): the chip label and model text (fence header = relative path
 * + line span), the over-limit plain-line fallback, and the best-effort
 * reverse-search that maps a preview selection back to source lines.
 */
import { describe, expect, it } from 'vitest'
import {
  SELECTION_LIMIT,
  buildSelectionInsert,
  headerOf,
  linesOfSelection,
} from '../src/client/selection-payload.ts'

describe('headerOf', () => {
  it('projects the path relative to the session cwd', () => {
    expect(headerOf('/p/docs/plan.md', '/p', { start: 12, end: 12 })).toBe('docs/plan.md:12')
  })

  it('falls back to the absolute path when the cwd is unknown', () => {
    expect(headerOf('/p/docs/plan.md', undefined, { start: 3, end: 3 })).toBe('/p/docs/plan.md:3')
  })

  it('keeps the absolute path for files outside the cwd', () => {
    expect(headerOf('/other/x.md', '/p', { start: 1, end: 1 })).toBe('/other/x.md:1')
  })

  it('writes a single line number for single-line selections', () => {
    expect(headerOf('/p/a.md', '/p', { start: 5, end: 5 })).toBe('a.md:5')
  })

  it('writes the start-end range for multi-line selections', () => {
    expect(headerOf('/p/a.md', '/p', { start: 5, end: 9 })).toBe('a.md:5-9')
  })

  it('omits the line suffix entirely when the lines are unknown', () => {
    expect(headerOf('/p/a.md', '/p', undefined)).toBe('a.md')
  })
})

describe('buildSelectionInsert', () => {
  it('labels a small selection with the path:line info line and fences the model form', () => {
    expect(buildSelectionInsert('/p/a.ts', '/p', { start: 2, end: 4 }, 'const x = 1')).toEqual({
      label: 'a.ts:2-4',
      text: '```a.ts:2-4\nconst x = 1\n```',
    })
  })

  it('accepts a selection exactly at the limit (fenced)', () => {
    const text = 'x'.repeat(SELECTION_LIMIT)
    expect(buildSelectionInsert('/p/a.ts', '/p', { start: 1, end: 1 }, text)).toEqual({
      label: 'a.ts:1',
      text: `\`\`\`a.ts:1\n${text}\n\`\`\``,
    })
  })

  it('drops the content past the limit: the path line is label and payload alike', () => {
    const text = 'x'.repeat(SELECTION_LIMIT + 1)
    expect(buildSelectionInsert('/p/a.ts', '/p', { start: 7, end: 7 }, text)).toEqual({
      label: 'a.ts:7',
      text: 'a.ts:7',
    })
  })

  it('keeps the plain-line form when past the limit without line numbers', () => {
    const text = 'x'.repeat(SELECTION_LIMIT + 1)
    expect(buildSelectionInsert('/p/a.ts', '/p', undefined, text)).toEqual({
      label: 'a.ts',
      text: 'a.ts',
    })
  })
})

describe('linesOfSelection', () => {
  const source = 'alpha\nbeta\ngamma alpha\ndelta\n'

  it('maps a unique hit to its source line span', () => {
    expect(linesOfSelection(source, 'beta')).toEqual({ start: 2, end: 2 })
    expect(linesOfSelection(source, 'gamma alpha')).toEqual({ start: 3, end: 3 })
  })

  it('spans the end line when the selection crosses line breaks', () => {
    expect(linesOfSelection(source, 'beta\ngamma')).toEqual({ start: 2, end: 3 })
  })

  it('returns null when the text is missing from the source', () => {
    expect(linesOfSelection(source, 'nope')).toBeNull()
  })

  it('returns null on an ambiguous (multi-hit) match', () => {
    expect(linesOfSelection(source, 'alpha')).toBeNull()
  })

  it('strips a single trailing newline before searching (DOM block selections)', () => {
    expect(linesOfSelection(source, 'delta\n')).toEqual({ start: 4, end: 4 })
  })

  it('returns null for an empty selection', () => {
    expect(linesOfSelection(source, '')).toBeNull()
    expect(linesOfSelection(source, '\n')).toBeNull()
  })
})
