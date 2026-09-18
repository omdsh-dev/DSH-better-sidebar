/**
 * Unsaved editor edits must survive a tab switch. The native right Sidebar
 * mounts ONE tab body per pane, so looking at another tab (or another
 * conversation) unmounts the editor and destroys its CodeMirror document. The
 * draft is parked in a module-level map on unmount and re-seeded on the way
 * back — without it the reader's typing is gone, the worst of the state losses
 * this work covers (a scroll position is a nuisance; losing an edit is data).
 *
 * The editor is driven through its real CodeMirror instance: the module is
 * imported directly (the `editor` chunk only re-exports it), so a jsdom mount
 * builds a live view whose document can be typed into.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import type { Context } from '../src/context-types.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import type { FileViewerProps } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

vi.mock('../src/client/api.ts', () => ({
  api: { fsWrite: async () => ({ ok: true }) },
  htmlUrl: (scope: unknown, path: string) => `about:blank#${path}`,
}))

afterEach(() => { document.body.innerHTML = '' })

interface Harness {
  /** The live CodeMirror content. */
  doc: () => string
  /** Type into the document through CodeMirror's own dispatch. */
  type: (text: string) => void
  /** Unmount = the host switching to another tab (destroying the editor). */
  unmount: () => void
}

async function mountEditor(
  sessionId: string, path: string, content: string, onMount?: (view: unknown) => void,
): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const ctx = {} as unknown as Context
  const props: FileViewerProps = {
    ctx,
    store: createSidebarStore(),
    scope: { sessionId, cwd: '/work' },
    path,
    title: path.split('/').pop() ?? path,
    viewerId: 'code',
    content,
    toolbar: 'host',
  }
  await act(async () => { root.render(createElement(TextEditor, props)) })
  const host = container.querySelector('.cm-content') as HTMLElement | null
  expect(host, 'the editor must mount a CodeMirror view').not.toBeNull()
  /** The live EditorView, via CodeMirror's own DOM→view accessor. */
  const getView = (): CodeMirrorView => {
    const el = container.querySelector('.cm-editor') as HTMLElement | null
    expect(el, 'the editor must render a .cm-editor root').not.toBeNull()
    const view = CodeMirrorView.findFromDOM(el!)
    expect(view, 'the live EditorView must be reachable from the DOM').not.toBeNull()
    return view!
  }
  if (onMount !== undefined) onMount(getView())
  return {
    doc: () => getView().state.doc.toString(),
    type: (text: string) => {
      act(() => {
        const v = getView()
        v.dispatch({ changes: { from: v.state.doc.length, insert: text } })
      })
    },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('TextEditor unsaved-edit memory', () => {
  it('keeps an unsaved edit across an unmount (a tab switch)', async () => {
    const first = await mountEditor('s1', '/work/a.ts', 'const a = 1\n')
    first.type('\nconst b = 2\n')
    expect(first.doc()).toBe('const a = 1\n\nconst b = 2\n')
    first.unmount()

    // The host re-mounts the tab: the typing must still be there.
    const second = await mountEditor('s1', '/work/a.ts', 'const a = 1\n')
    expect(second.doc(), 'the unsaved edit survives the remount').toBe('const a = 1\n\nconst b = 2\n')
    second.unmount()
  })

  it('does not park a clean document', async () => {
    const first = await mountEditor('s2', '/work/clean.ts', 'unchanged\n')
    first.unmount()

    // A clean remount reads the file content, and — crucially — a LATER file
    // change is not masked by a stale parked copy.
    const second = await mountEditor('s2', '/work/clean.ts', 'changed on disk\n')
    expect(second.doc(), 'a clean document never parks, so disk wins').toBe('changed on disk\n')
    second.unmount()
  })

  it('keys the parked edit per session + path (a conversation switch cannot cross them)', async () => {
    const a = await mountEditor('session-a', '/work/x.ts', 'base\n')
    a.type('edited-by-a\n')
    a.unmount()

    // Another session with the SAME path must start from the file, not A's edit.
    const b = await mountEditor('session-b', '/work/x.ts', 'base\n')
    expect(b.doc(), 'B does not inherit A’s unsaved edit').toBe('base\n')
    b.type('edited-by-b\n')
    b.unmount()

    // Returning to A restores A's own edit, not B's.
    const backInA = await mountEditor('session-a', '/work/x.ts', 'base\n')
    expect(backInA.doc(), 'A gets its own edit back').toBe('base\nedited-by-a\n')
    backInA.unmount()
  })
})
