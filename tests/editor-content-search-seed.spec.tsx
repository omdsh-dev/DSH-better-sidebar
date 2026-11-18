/**
 * A CONTENT-SEARCH hit highlights its keyword when the file opens.
 *
 * The result row hands the editor the query and switches the hit was found
 * with (`FileViewerProps.search`), and the text viewer:
 *
 * - paints EVERY match in the file with its own panel-independent decoration
 *   (`cm-contentSearchHit`), so the reader sees the keyword as soon as the
 *   file opens — CodeMirror's `.cm-searchMatch` exists only while the find
 *   panel is open, and auto-opening that panel on every result click would
 *   steal focus and cover the editor top;
 * - seeds the SAME query into CodeMirror's search state, so a later
 *   Ctrl/Cmd+F opens the find panel pre-filled (switches included) and can
 *   step through the matches — the effect readers already know;
 * - replaces the marks when a second result click lands on the same
 *   `path#line`, and drops them after an ordinary line landing.
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

/** Two matches on two lines; line 2 is the landing line. */
const CONTENT = 'alpha\nbeta needle here\nneedle again\n'

const base = (overrides: Partial<FileViewerProps> = {}): FileViewerProps => ({
  ctx: {} as FileViewerProps['ctx'],
  store: createSidebarStore(),
  scope: { sessionId: 's1', cwd: '/p' },
  path: '/p/a.ts',
  title: 'a.ts',
  viewerId: 'code',
  content: CONTENT,
  toolbar: 'host',
  ...overrides,
})

let root: Root | undefined
let container: HTMLDivElement | undefined

function render(overrides: Partial<FileViewerProps> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root!.render(createElement(TextEditor, base(overrides))) })
  return container
}

function rerender(overrides: Partial<FileViewerProps> = {}): void {
  act(() => { root!.render(createElement(TextEditor, base(overrides))) })
}

/** The match marks our content-search decoration paints. */
function hits(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('.cm-contentSearchHit')]
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  document.body.innerHTML = ''
})

describe('a content-search hit highlights its keyword on open', () => {
  it('paints every match WITHOUT opening the find panel', () => {
    const el = render({ line: 2, search: { query: 'needle' } })
    expect(hits(el).map(hit => hit.textContent)).toEqual(['needle', 'needle'])
    // The panel is the Ctrl+F surface, not something an open should pop over
    // the editor.
    expect(el.querySelector('.cm-search')).toBeNull()
  })

  it('seeds Ctrl+F with the hit query and its switches', () => {
    const el = render({
      line: 2,
      search: { query: 'needle', caseSensitive: true, wholeWord: true, regex: false },
    })
    expect(hits(el)).toHaveLength(2)
    press(el.querySelector('.cm-content')!, 'f', { ctrlKey: true })
    const field = el.querySelector<HTMLInputElement>('.cm-search input[name=search]')!
    expect(field.value).toBe('needle')
    expect(el.querySelector<HTMLInputElement>('.cm-search input[name=case]')!.checked).toBe(true)
    expect(el.querySelector<HTMLInputElement>('.cm-search input[name=word]')!.checked).toBe(true)
    expect(el.querySelector<HTMLInputElement>('.cm-search input[name=re]')!.checked).toBe(false)
  })

  it('applies case sensitivity and regex to the painted matches', () => {
    // Case-sensitive upper-case query matches nothing in the lower-case file.
    const exact = render({ line: 2, search: { query: 'NEEDLE', caseSensitive: true } })
    expect(hits(exact)).toHaveLength(0)

    // Regex mode: a pattern, not a literal.
    rerender({ line: 2, search: { query: 'neede?le', regex: true } })
    expect(hits(exact)).toHaveLength(2)
  })

  it('re-paints for a second hit on the SAME path#line', () => {
    const el = render({ line: 2, search: { query: 'needle' } })
    expect(hits(el)).toHaveLength(2)
    // Same line, a NEW seed object: a second result click.
    rerender({ line: 2, search: { query: 'alpha' } })
    expect(hits(el).map(hit => hit.textContent)).toEqual(['alpha'])
  })

  it('drops the marks after an ordinary line landing (a quote chip)', () => {
    const el = render({ line: 2, search: { query: 'needle' } })
    expect(hits(el)).toHaveLength(2)
    rerender({ line: 3 })
    expect(hits(el)).toHaveLength(0)
    expect(el.querySelector('.cm-search')).toBeNull()
  })

  it('leaves an ordinary line landing unhighlighted', () => {
    const el = render({ line: 2 })
    expect(hits(el)).toHaveLength(0)
    expect(el.querySelector('.cm-search')).toBeNull()
  })

  it('flips a markdown file out of preview to show the source match', () => {
    const el = render({
      viewerId: 'markdown',
      path: '/p/readme.md',
      line: 2,
      search: { query: 'needle' },
    })
    // The CodeMirror surface (and therefore the marks) is hidden in preview.
    expect(el.querySelector('[class*="editorCmHidden"]')).toBeNull()
    expect(hits(el)).toHaveLength(2)
  })
})