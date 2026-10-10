/**
 * The editor keeps the reader's place across a reload. A manual refresh
 * re-creates the CodeMirror view (the host even unmounts the whole viewer
 * behind its loading state) and any content swap does the same, so without a
 * per-file memory the reloaded file came back at line 1 and the reader had to
 * scroll back to their line by hand. The preview side of the same problem has
 * had `previewScrollMemory` all along; this is the editor's half.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import './browser-globals.ts'
import { createElement } from 'react'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
setupReactAct()

const SCOPE = { sessionId: 's-editor-scroll', cwd: '/work' }

/** One code-viewer mount (the viewerId the code editor registers under). */
function props(content: string, path = '/work/launch.js'): FileViewerProps {
  return {
    ctx: {} as FileViewerProps['ctx'],
    store: createSidebarStore(),
    scope: SCOPE,
    path,
    title: path.slice(path.lastIndexOf('/') + 1),
    viewerId: 'code',
    content,
  }
}

/** The editor's own scroller (what the reader actually scrolls). */
function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('.cm-scroller')
  expect(scroller, 'the CodeMirror scroller must be mounted').not.toBeNull()
  return scroller as HTMLElement
}

/**
 * Scroll the editor the way a browser does, then detach it the way the refresh
 * does. jsdom keeps `scrollTop` on a detached node (it has no layout to lose),
 * while a real browser reports 0 the moment the host pulls the scroller out of
 * the document — which is exactly why the position has to be captured from the
 * scroll event rather than from the teardown read. Zeroing it here models the
 * browser, so a teardown-only capture fails this case.
 */
function scrollThenDetach(container: HTMLElement, top: number): void {
  const scroller = scrollerOf(container)
  scroller.scrollTop = top
  // jsdom never emits a scroll event for a programmatic write; a real one does.
  scroller.dispatchEvent(new Event('scroll'))
  scroller.scrollTop = 0
}

describe('TextEditor keeps the reader’s place across a reload', () => {
  it('restores the position captured while scrolling, though the detached scroller reads 0', () => {
    const first = renderRoot(createElement(TextEditor, props('one\ntwo\nthree\n')))
    scrollThenDetach(first.container, 420)
    // The refresh: the host drops the viewer while the reload is in flight…
    first.unmount()
    // …and mounts a fresh one once the reloaded content lands.
    const second = renderRoot(createElement(TextEditor, props('one\ntwo reloaded\nthree\n')))
    expect(scrollerOf(second.container).scrollTop, 'the reloaded file reopens where the reader was').toBe(420)
    second.unmount()
  })

  it('restores it when the content swaps under a mounted viewer', () => {
    const root = renderRoot(createElement(TextEditor, props('one\ntwo\nthree\n')))
    scrollThenDetach(root.container, 300)
    // A content swap re-creates the view in place (the save-then-reload flows).
    root.rerender(createElement(TextEditor, props('one\ntwo changed\nthree\n')))
    expect(scrollerOf(root.container).scrollTop).toBe(300)
    root.unmount()
  })

  it('does not leak one file’s position into another file', () => {
    const first = renderRoot(createElement(TextEditor, props('one\ntwo\nthree\n')))
    scrollThenDetach(first.container, 260)
    first.unmount()
    const other = renderRoot(createElement(TextEditor, props('alpha\nbeta\n', '/work/other.js')))
    expect(scrollerOf(other.container).scrollTop, 'a first open still starts at the top').toBe(0)
    other.unmount()
  })
})
