// @vitest-environment jsdom
/**
 * Unit tests for the quote-chip landing flash (src/client/quote-flash.ts):
 * the line-range clamp, the CodeMirror state field that carries the flash
 * across document edits, the decorations it renders, the one-shot style
 * injection (skin-token based, never a hardcoded colour), and the
 * self-clearing entry point the viewer calls on landing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { RangeSet } from '@codemirror/state'
import {
  QUOTE_FLASH_MS,
  QUOTE_FLASH_STYLE_ID,
  clampQuoteRange,
  ensureQuoteFlashStyle,
  flashQuoteLines,
  quoteFlashEffect,
  quoteFlashField,
  quoteFlashHighlight,
} from '../src/client/quote-flash.ts'

const DOC = 'l1\nl2\nl3\nl4\nl5'

const flashedState = (doc = DOC): ReturnType<EditorState['update']>['state'] => {
  const state = EditorState.create({ doc, extensions: [quoteFlashField, quoteFlashHighlight] })
  const from = state.doc.line(2).from
  const to = state.doc.line(3).to
  return state.update({ effects: quoteFlashEffect.of({ from, to }) }).state
}

/** The literal line classes the flash facet currently renders, in order. */
function flashClasses(state: EditorState): string[] {
  const sets = state.facet(EditorView.decorations) as unknown as RangeSet<Decoration>[]
  const classes: string[] = []
  for (const set of sets) {
    const cursor = set.iter()
    while (cursor.value !== null) {
      const kind = cursor.value.spec as { class?: string }
      if (kind.class === 'cm-quote-flash') classes.push(kind.class)
      cursor.next()
    }
  }
  return classes
}

describe('clampQuoteRange', () => {
  it('passes a range that lies inside the document through', () => {
    expect(clampQuoteRange(100, 5, 9)).toEqual({ first: 5, last: 9 })
  })

  it('defaults the end to the start line', () => {
    expect(clampQuoteRange(100, 7, undefined)).toEqual({ first: 7, last: 7 })
  })

  it('clamps an end above the start back down to it', () => {
    expect(clampQuoteRange(100, 5, 2)).toEqual({ first: 5, last: 5 })
  })

  it('clamps an end beyond the document to its last line', () => {
    expect(clampQuoteRange(10, 8, 99)).toEqual({ first: 8, last: 10 })
  })

  it('refuses a start outside the document', () => {
    expect(clampQuoteRange(10, 0, 3)).toBeUndefined()
    expect(clampQuoteRange(10, 11, 12)).toBeUndefined()
    expect(clampQuoteRange(10, Number.NaN, undefined)).toBeUndefined()
  })
})

describe('quoteFlashField', () => {
  it('carries the flash range and clears on an undefined effect', () => {
    const flashed = flashedState()
    expect(flashClasses(flashed)).toEqual(['cm-quote-flash', 'cm-quote-flash'])
    const cleared = flashed.update({ effects: quoteFlashEffect.of(undefined) }).state
    expect(flashClasses(cleared)).toEqual([])
  })

  it('maps the range through document edits (an inserted line shifts it down)', () => {
    const flashed = flashedState()
    const edited = flashed.update({ changes: { insert: 'new\n', from: 0 } }).state
    expect(flashClasses(edited)).toEqual(['cm-quote-flash', 'cm-quote-flash'])
    // The decorations moved from lines 2-3 to lines 3-4 (positions mapped).
    expect(edited.field(quoteFlashField)).toEqual({
      from: edited.doc.line(3).from,
      to: edited.doc.line(4).to,
    })
  })

  it('starts inert: no flash, no decorations', () => {
    const state = EditorState.create({ doc: DOC, extensions: [quoteFlashField, quoteFlashHighlight] })
    expect(state.field(quoteFlashField)).toBeNull()
    expect(flashClasses(state)).toEqual([])
  })
})

describe('ensureQuoteFlashStyle', () => {
  beforeEach(() => {
    document.getElementById(QUOTE_FLASH_STYLE_ID)?.remove()
  })

  it('injects the stylesheet once and is idempotent', () => {
    expect(document.getElementById(QUOTE_FLASH_STYLE_ID)).toBeNull()
    ensureQuoteFlashStyle()
    const first = document.getElementById(QUOTE_FLASH_STYLE_ID)
    expect(first).not.toBeNull()
    expect(first?.textContent).toContain('.cm-quote-flash')
    ensureQuoteFlashStyle()
    expect(document.querySelectorAll(`#${QUOTE_FLASH_STYLE_ID}`)).toHaveLength(1)
  })

  it('paints from the skin token, never a literal colour', () => {
    ensureQuoteFlashStyle()
    const css = document.getElementById(QUOTE_FLASH_STYLE_ID)?.textContent ?? ''
    // The sidebar's own hover/active fill, mixed toward transparent so the
    // text under it stays readable in every scheme (AGENTS §5: no hardcoded
    // colours).
    expect(css).toContain('var(--dsw-alias-interactive-bg-hover-accent)')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu)
    expect(css).not.toMatch(/rgba?\(/u)
  })
})

describe('flashQuoteLines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flashes the span, then clears itself after the hold', () => {
    vi.useFakeTimers()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: DOC, extensions: [quoteFlashField, quoteFlashHighlight] }) })

    flashQuoteLines(view, 2, 3)
    expect(flashClasses(view.state)).toEqual(['cm-quote-flash', 'cm-quote-flash'])

    vi.advanceTimersByTime(QUOTE_FLASH_MS + 1)
    expect(flashClasses(view.state)).toEqual([])

    view.destroy()
    parent.remove()
  })

  it('a second landing replaces the first one instead of stacking', () => {
    vi.useFakeTimers()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: DOC, extensions: [quoteFlashField, quoteFlashHighlight] }) })

    flashQuoteLines(view, 1, 1)
    flashQuoteLines(view, 4, 5)
    const ranges = view.state.field(quoteFlashField)
    expect(ranges).toEqual({ from: view.state.doc.line(4).from, to: view.state.doc.line(5).to })

    vi.advanceTimersByTime(QUOTE_FLASH_MS + 1)
    expect(flashClasses(view.state)).toEqual([])

    view.destroy()
    parent.remove()
  })

  it('does nothing when the view is already torn down', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: DOC, extensions: [quoteFlashField, quoteFlashHighlight] }) })
    view.destroy()

    expect(() => { flashQuoteLines(view, 1, 2) }).not.toThrow()
    parent.remove()
  })
})
