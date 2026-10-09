/**
 * Landing on the line a file reference named (#826 second half).
 *
 * `fileParamsOf` splits `path:131` off the address and the host hands its own
 * `#L131` fragment down as `navigation.params.line`; before this, both landed
 * on the record and then on nothing — the file opened and the reader stayed
 * on line 1. The record's side is pinned in `tests/native-tab-line.spec.ts`;
 * this file pins the last hop, into CodeMirror.
 *
 * The SCROLL write is deliberately not asserted: it rides two nested
 * `requestAnimationFrame`s after a `lineBlockAt` measure, and jsdom lays
 * nothing out (every block measures 0). What is asserted is the SELECTION the
 * reveal dispatches — the same anchor the scroll positions, and unlike a
 * scrollTop it is observable without layout.
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { TransactionSpec } from '@codemirror/state'
import type { Context } from '../src/context-types.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

const CTX = {} as Context

/** Four lines plus the empty one the trailing newline opens; the from-offset
 *  of line N is 4 × (N − 1), and the LAST line starts at 16. */
const CONTENT = 'aaa\nbbb\nccc\nddd\n'

const base = (overrides: Partial<FileViewerProps> = {}): FileViewerProps => ({
  ctx: CTX,
  store: createSidebarStore(),
  scope: { sessionId: 's1', cwd: '/workspace' },
  path: '/workspace/a.ts',
  title: 'a.ts',
  viewerId: 'code',
  content: CONTENT,
  toolbar: 'host',
  ...overrides,
})

describe('TextEditor lands on a referenced line', () => {
  let root: Root | undefined
let container: HTMLDivElement | undefined
const anchors: number[] = []

const originalDispatch = EditorView.prototype.dispatch

beforeEach(() => {
  anchors.length = 0
  // Record the selections the component dispatches, and let the real dispatch
  // run: the reveal reads the document back out of the view right after
  // writing to it.
  vi.spyOn(EditorView.prototype, 'dispatch').mockImplementation(function (
    this: EditorView,
    transaction: TransactionSpec,
  ) {
    const spec = transaction as { selection?: { anchor?: number } }
    if (spec?.selection?.anchor !== undefined) anchors.push(spec.selection.anchor)
    return originalDispatch.call(this, transaction)
  })
})

const render = (overrides: Partial<FileViewerProps> = {}): HTMLDivElement => {
  container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { root!.render(createElement(TextEditor, base(overrides))) })
    return container
  }

  afterEach(() => {
    act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
  })

  it('selects the line the reference named', () => {
    render({ line: 3 })
    expect(anchors).toContain(8)
  })

  it('clamps a line past the end of the file to its last line', () => {
    // A link can outlive the revision it was written against; it must land at
    // the bottom rather than throw.
    render({ line: 99 })
    expect(anchors).toContain(16)
  })

  it('never jumps on an ordinary open', () => {
    render()
    expect(anchors).toEqual([])
  })

  it('flips a markdown file out of preview, where the line is reachable', () => {
    // Preview renders no source lines to put a cursor on, and its own
    // mount-time scroll restore would fight the jump — the reference asked for
    // source, so the file opens in the editor.
    const el = render({ viewerId: 'markdown', path: '/workspace/readme.md', line: 2 })
    expect(anchors).toContain(4)
    expect(el.querySelector('[class*="editorCmHidden"]')).toBeNull()
  })

  it('leaves a markdown file in preview when the reference named no line', () => {
    const el = render({ viewerId: 'markdown', path: '/workspace/readme.md' })
    expect(el.querySelector('[class*="editorCmHidden"]')).not.toBeNull()
  })

  it('lands once, not on every re-delivery of the same navigation', () => {
    // The host keeps a visited tab body mounted and re-delivers its
    // navigation on every store notification — a reader must not be yanked
    // back to the same line each time.
    const el = render({ line: 2 })
    const after = anchors.length
    act(() => { root!.render(createElement(TextEditor, base({ line: 2 }))) })
    expect(anchors.length).toBe(after)
    expect(el.querySelector('.cm-content')).not.toBeNull()
  })
})