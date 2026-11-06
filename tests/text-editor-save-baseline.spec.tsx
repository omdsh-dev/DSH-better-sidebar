/**
 * The text editor's save baseline (#1059). `mtimeRef` is the optimistic-
 * concurrency baseline the editor sends as `expectedMtimeMs`; the host refuses
 * the save (`fs-conflict`) when the file on disk no longer matches it.
 *
 * A fresh load can return the SAME bytes with a NEW mtime — `touch`, a
 * `git checkout`, a formatter rewriting identical text — and then `content`
 * never changes, so the file-switch effect keyed on it never runs. The
 * baseline must therefore ALSO follow the `mtimeMs` prop, or every later save
 * keeps sending the stale value and the conflict never clears.
 *
 * The second case pins the other side of the contract: a genuinely different
 * document must still run the original file-switch reset (preview mode, no
 * draft, clean editor, conflict cleared, new baseline) unchanged.
 *
 * The third case is a save still in flight: keystrokes made after the write
 * was sent are NOT the bytes on disk, so the tab must stay dirty and keep its
 * durable backup instead of declaring itself saved (which would let the next
 * close/quit drop those edits silently).
 *
 * The fourth case is the cross-file save race (#3): a save sent for file A is
 * still in flight when the viewer switches to file B — the [content, path]
 * effect destroys A's view and points viewRef at B's. An expired result may
 * only release the save lock (and adopt the server's mtime): it must not write
 * A's text / save state into B's draft, while typing during a save of the
 * CURRENT file still keeps that tab dirty (the third case above).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { EditorView } from '@codemirror/view'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { EditorToolbarControls, EditorToolbarState, FileViewerProps } from '../src/client/service.ts'

setupReactAct()

const fsWrite = vi.fn()
vi.mock('../src/client/api.ts', async (importOriginal) => {
  // Keep the real module (the api surface and the error class); only the save
  // call is observed.
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: { ...actual.api, fsWrite: (...args: unknown[]) => fsWrite(...args) },
  }
})

const { clearDraftBackup } = vi.hoisted(() => ({ clearDraftBackup: vi.fn() }))
vi.mock('../src/client/editor-draft-backup.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/editor-draft-backup.ts')>()
  return { ...actual, clearDraftBackup: (...args: unknown[]) => clearDraftBackup(...args) }
})

const CONTENT = 'const a = 1\n'
const NEXT_CONTENT = 'const a = 2\n'
// Distinct markdown headings: the preview renders whichever document `draft`
// currently holds, so a leaked draft from file A is visible in the DOM.
const A_CONTENT = '# A-source-heading\n'
const B_CONTENT = '# B-clean-heading\n'

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: {} as FileViewerProps['ctx'],
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a.ts',
    title: 'a.ts',
    viewerId: 'code',
    content: CONTENT,
    mtimeMs: 100,
    // The real editor's deployment: the host header owns the toolbar, so the
    // save/mode commands arrive through the registered controls.
    toolbar: 'host',
    ...overrides,
  }
}

interface Harness {
  container: HTMLDivElement
  /** Re-render the SAME instance with the next load (a reload / file swap). */
  rerender: (next: Partial<FileViewerProps>) => void
  /** The last toolbar state the editor reported. */
  state: () => EditorToolbarState
  /** The toolbar commands the editor registered on mount. */
  controls: () => EditorToolbarControls
  /** The live CodeMirror view. */
  view: () => EditorView
  unmount: () => void
}

function mountEditor(overrides: Partial<FileViewerProps> = {}): Harness {
  const props = viewerProps(overrides)
  let toolbar: EditorToolbarState | undefined
  let controls: EditorToolbarControls | null = null
  const element = (next: Partial<FileViewerProps> = {}): ReturnType<typeof createElement> =>
    createElement(TextEditor, {
      ...props,
      ...next,
      onToolbarState: (state: EditorToolbarState) => { toolbar = state },
      onToolbarControls: (nextControls: EditorToolbarControls | null) => { controls = nextControls },
    })
  const root = renderRoot(element())
  const view = (): EditorView => {
    const host = root.container.querySelector('.cm-editor')
    if (host === null) throw new Error('the mounted editor has no .cm-editor')
    const live = EditorView.findFromDOM(host as HTMLElement)
    if (live === null) throw new Error('the mounted editor has no CodeMirror view')
    return live
  }
  return {
    container: root.container,
    rerender: (next: Partial<FileViewerProps>) => { root.rerender(element(next)) },
    state: () => {
      if (toolbar === undefined) throw new Error('the editor reported no toolbar state')
      return toolbar
    },
    controls: () => {
      if (controls === null) throw new Error('the editor registered no toolbar controls')
      return controls
    },
    view,
    unmount: root.unmount,
  }
}

/** Apply the CodeMirror transaction a keystroke would (same doc-change path). */
function type(view: EditorView, insert: string): void {
  act(() => { view.dispatch({ changes: { from: 0, insert } }) })
}

beforeEach(() => {
  fsWrite.mockReset()
  fsWrite.mockResolvedValue({ ok: true, mtimeMs: 999 })
  clearDraftBackup.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TextEditor save baseline (#1059)', () => {
  it('follows a fresh load of unchanged text, not just a content change', async () => {
    const editor = mountEditor()
    try {
      const mounted = editor.view()
      // The reported reload: same bytes on disk, new mtime. `content` is
      // unchanged, so the file-switch effect must not be what re-bases the ref.
      editor.rerender({ content: CONTENT, mtimeMs: 200 })
      expect(editor.view(), 'the same viewer instance stays mounted').toBe(mounted)
      type(editor.view(), '// touched\n')
      expect(editor.state().dirty).toBe(true)
      await act(async () => { editor.controls().save() })
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(1)
      // (scope, path, content, expectedMtimeMs) — the fresh load's mtime.
      expect(fsWrite.mock.calls[0]![3]).toBe(200)
    } finally {
      editor.unmount()
    }
  })

  it('still performs the file-switch reset when the content really changes', async () => {
    const editor = mountEditor({ viewerId: 'markdown', path: '/p/a.md', title: 'a.md' })
    try {
      expect(editor.state()).toMatchObject({ mode: 'preview', dirty: false, saveState: 'idle' })
      act(() => { editor.controls().setMode('edit') })
      expect(editor.state().mode).toBe('edit')
      type(editor.view(), '# draft\n')
      expect(editor.state().dirty).toBe(true)
      // A genuinely different document: the original [content] reset runs.
      editor.rerender({ content: NEXT_CONTENT, mtimeMs: 400 })
      expect(editor.view().state.doc.toString()).toBe(NEXT_CONTENT)
      expect(editor.state()).toMatchObject({ mode: 'preview', dirty: false, saveState: 'idle' })
      await act(async () => { editor.controls().save() })
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(1)
      expect(fsWrite.mock.calls[0]![2]).toBe(NEXT_CONTENT)
      expect(fsWrite.mock.calls[0]![3]).toBe(400)
    } finally {
      editor.unmount()
    }
  })

  it('keeps typing done while the write is in flight unsaved', async () => {
    let finish: ((value: { ok: true; mtimeMs: number }) => void) | undefined
    fsWrite.mockImplementation(() => new Promise<{ ok: true; mtimeMs: number }>((resolve) => { finish = resolve }))
    const editor = mountEditor()
    try {
      // Mount may decline a leftover draft backup (jsdom's confirm is a no-op);
      // only the save callback's clear is under test here.
      clearDraftBackup.mockClear()
      const view = editor.view()
      type(view, '// first\n')
      await act(async () => { editor.controls().save() })
      expect(editor.state().saveState).toBe('saving')
      type(view, '// typed during save\n')
      await act(async () => {
        finish?.({ ok: true, mtimeMs: 999 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(editor.state().dirty).toBe(true)
      expect(editor.state().saveState).toBe('idle')
      expect(clearDraftBackup).not.toHaveBeenCalled()
      // The next save re-sends the live document against the NEW baseline.
      fsWrite.mockResolvedValue({ ok: true, mtimeMs: 1000 })
      await act(async () => { editor.controls().save() })
      await act(async () => { await Promise.resolve() })
      expect(fsWrite.mock.calls[1]![2]).toBe('// typed during save\n// first\n' + CONTENT)
      expect(fsWrite.mock.calls[1]![3]).toBe(999)
    } finally {
      editor.unmount()
    }
  })

  it('lets an in-flight save from the previous file expire without touching the new file', async () => {
    let finish: ((value: { ok: true; mtimeMs: number }) => void) | undefined
    fsWrite.mockImplementation(() => new Promise<{ ok: true; mtimeMs: number }>((resolve) => { finish = resolve }))
    const editor = mountEditor()
    try {
      clearDraftBackup.mockClear()
      const view = editor.view()
      type(view, '// first\n')
      await act(async () => { editor.controls().save() })
      expect(editor.state().saveState).toBe('saving')
      // A genuinely different document: the file-switch effect destroys the
      // view the save captured and re-seats a clean one for NEXT_CONTENT.
      editor.rerender({ content: NEXT_CONTENT, mtimeMs: 400 })
      expect(editor.view().state.doc.toString()).toBe(NEXT_CONTENT)
      expect(editor.state()).toMatchObject({ mode: 'preview', dirty: false, saveState: 'idle' })
      clearDraftBackup.mockClear()
      await act(async () => {
        finish?.({ ok: true, mtimeMs: 999 })
        await Promise.resolve()
        await Promise.resolve()
      })
      // The result belongs to A: it must not declare B saved, drop B's
      // durable backup, or move B's dirty/draft state.
      expect(editor.state()).toMatchObject({ dirty: false, saveState: 'idle' })
      expect(clearDraftBackup).not.toHaveBeenCalled()
      // The save lock was released, so B can still save normally.
      fsWrite.mockResolvedValue({ ok: true, mtimeMs: 1000 })
      await act(async () => { editor.controls().save() })
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(2)
      expect(fsWrite.mock.calls[1]![2]).toBe(NEXT_CONTENT)
    } finally {
      editor.unmount()
    }
  })

  it('does not publish the old file text as the new file draft when a save expires', async () => {
    let finish: ((value: { ok: true; mtimeMs: number }) => void) | undefined
    fsWrite.mockImplementation(() => new Promise<{ ok: true; mtimeMs: number }>((resolve) => { finish = resolve }))
    const editor = mountEditor({
      viewerId: 'markdown', path: '/p/a.md', title: 'a.md',
      content: A_CONTENT, mtimeMs: 100,
    })
    try {
      clearDraftBackup.mockClear()
      act(() => { editor.controls().setMode('edit') })
      const view = editor.view()
      type(view, 'LEAK-FROM-A\n')
      await act(async () => { editor.controls().save() })
      expect(editor.state().saveState).toBe('saving')
      // More keystrokes while the write is in flight: the old view's live
      // document no longer equals the bytes that were sent, which is the
      // branch that used to call setDraft(live).
      type(view, 'MORE-FROM-A\n')
      editor.rerender({ content: B_CONTENT, mtimeMs: 400 })
      expect(editor.view().state.doc.toString()).toBe(B_CONTENT)
      expect(editor.container.textContent).toContain('B-clean-heading')
      expect(editor.state()).toMatchObject({ mode: 'preview', dirty: false, saveState: 'idle' })
      clearDraftBackup.mockClear()
      await act(async () => {
        finish?.({ ok: true, mtimeMs: 999 })
        await Promise.resolve()
        await Promise.resolve()
      })
      // The preview still renders B's own content, not A's leaked text.
      expect(editor.container.textContent).toContain('B-clean-heading')
      expect(editor.container.textContent).not.toContain('MORE-FROM-A')
      expect(editor.state()).toMatchObject({ dirty: false, saveState: 'idle' })
      expect(clearDraftBackup).not.toHaveBeenCalled()
      // The save lock was released, so B can still save normally.
      fsWrite.mockResolvedValue({ ok: true, mtimeMs: 1000 })
      await act(async () => { editor.controls().save() })
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(2)
      expect(fsWrite.mock.calls[1]![2]).toBe(B_CONTENT)
    } finally {
      editor.unmount()
    }
  })
})
