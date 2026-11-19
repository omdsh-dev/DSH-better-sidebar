/**
 * Pure payload logic for the viewer selection popup ("add to
 * conversation"): the fence header (relative path + line span), the
 * over-limit plain-line fallback, and the best-effort reverse-search that
 * maps a preview selection back to source lines.
 */
import { describe, expect, it } from 'vitest'
import {
  SELECTION_LIMIT,
  buildPlanAnnotationInsert,
  buildSelectionInsert,
  cleanPlanTitle,
  clipText,
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
  it('wraps a small selection in a fenced block with the path:line info line', () => {
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

  it('drops the content past the limit: one plain path line, no fence', () => {
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

describe('buildPlanAnnotationInsert', () => {
  const labels = { heading: '计划批注', noteLabel: '批注', quoteLabel: '原文' }

  it('labels the note and sends the quoted plan text as a blockquote', () => {
    expect(buildPlanAnnotationInsert('Use a queue.', 'retry once', { ...labels, planTitle: 'Ship it' }))
      .toBe('计划批注 · Ship it\n批注: Use a queue.\n\n原文:\n> retry once')
  })

  it('prefixes every quoted line so a multi-line selection stays one blockquote', () => {
    expect(buildPlanAnnotationInsert('n', 'one\ntwo', labels))
      .toBe('计划批注\n批注: n\n\n原文:\n> one\n> two')
  })

  it('labels a multi-line note once and keeps its own line breaks', () => {
    expect(buildPlanAnnotationInsert('one\ntwo', 'q', labels))
      .toBe('计划批注\n批注: one\ntwo\n\n原文:\n> q')
  })

  it('never exceeds the selection limit and keeps the note intact', () => {
    const note = 'n'.repeat(400)
    const text = buildPlanAnnotationInsert(note, 'x'.repeat(400), labels)
    expect(text.length).toBeLessThanOrEqual(SELECTION_LIMIT)
    expect(text).toContain(note)
    expect(text).toContain('…')
  })

  it('keeps an over-limit note whole in the bare envelope (never silently truncates)', () => {
    const note = 'n'.repeat(SELECTION_LIMIT + 20)
    const text = buildPlanAnnotationInsert(note, 'quote', labels)
    // The reader's words survive intact; only the quote is dropped.
    expect(text).toBe(`计划批注\n批注: ${note}`)
    expect(text).toContain(note)
    expect(text.length).toBeGreaterThan(SELECTION_LIMIT)
    expect(text).not.toContain('> quote')
  })

  it('truncates the quote on code points so no emoji surrogate pair is split', () => {
    const note = 'n'.repeat(300)
    const text = buildPlanAnnotationInsert(note, '🙂'.repeat(300), labels)
    expect(text).toContain('…')
    expect(text.length).toBeLessThanOrEqual(SELECTION_LIMIT)
    // Strip every valid pair; a lone surrogate would remain and fail this.
    const withoutPairs = text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    expect(withoutPairs).not.toMatch(/[\uD800-\uDFFF]/)
  })

  it('bounds a very large selection without copying it whole', () => {
    const text = buildPlanAnnotationInsert('n', 'x'.repeat(100_000), labels)
    expect(text.length).toBeLessThanOrEqual(SELECTION_LIMIT)
    expect(text).toContain('…')
  })

  it('collapses a multi-line plan title into the heading line', () => {
    const text = buildPlanAnnotationInsert('note', 'quote', { ...labels, planTitle: 'Ship\nit\n\nnow' })
    expect(text).toBe('计划批注 · Ship it now\n批注: note\n\n原文:\n> quote')
  })

  it('caps a long plan title so the heading cannot crowd out the quote', () => {
    const text = buildPlanAnnotationInsert('note', 'quote', { ...labels, planTitle: 'T'.repeat(200) })
    expect(text.split('\n')[0]).toBe(`计划批注 · ${'T'.repeat(60)}…`)
    expect(text).toContain('原文:\n> quote')
  })
})

describe('clipText', () => {
  it('keeps a short string and ellipsizes a long one', () => {
    expect(clipText('short', 10)).toBe('short')
    expect(clipText('abcdef', 3)).toBe('abc…')
  })

  it('never leaves half an emoji behind', () => {
    expect(clipText('🙂🙂', 1)).toBe('…')
    expect(clipText('🙂🙂', 3)).toBe('🙂…')
  })
})

describe('cleanPlanTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanPlanTitle('  Ship\t it\nnow  ', 60)).toBe('Ship it now')
  })

  it('caps by code points and appends one ellipsis', () => {
    expect(cleanPlanTitle('🙂'.repeat(5), 3)).toBe('🙂🙂🙂…')
    expect(cleanPlanTitle('abc', 3)).toBe('abc')
  })

  it('treats missing and blank titles as absent', () => {
    expect(cleanPlanTitle(undefined, 60)).toBeUndefined()
    expect(cleanPlanTitle('   \n\t ', 60)).toBeUndefined()
  })
})
