/**
 * "Reload from disk" after a save conflict, with the host's dirty guard in
 * play (#1059). Opening a file, editing it, and then touching the file (same
 * bytes, new mtime) makes the next save fail with `fs-conflict`; the banner
 * promises a way out. The host's reload route stops first at `window.confirm`
 * whenever the draft is dirty, and some desktop shells answer that dialog with
 * no UI at all (`false`) — so a reload that would only carry a new mtime must
 * NOT need the confirm: it is resolved in place, baseline updated, draft kept.
 *
 * Real disk edits keep the old dirty protection: when the reload returns a
 * different document the host's confirm still decides, and a declined confirm
 * replaces nothing.
 *
 * The comparison is against the bytes the editor was LOADED from, not the live
 * draft: after the user's edit the draft legitimately differs from disk, and
 * comparing against it would classify every touch-only reload as "changed".
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { EditorView } from '@codemirror/view'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'

setupReactAct()

vi.mock('../src/client/api.ts', async (importOriginal) => {
  // Keep the real module: TextEditor narrows the save failure with
  // instanceof SidebarApiError.
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: { ...actual.api, fsRead: vi.fn(), fsWrite: vi.fn() },
  }
})
import { SidebarApiError, api } from '../src/client/api.ts'

const fsRead = vi.mocked(api.fsRead)
const fsWrite = vi.mocked(api.fsWrite)

const CONTENT = 'const a = 1\n'
/** The user's unsaved edit (what the reload must NOT throw away). */
const DRAFT_PREFIX = '// draft\n'
const SECOND_PREFIX = '// second\n'
const CHANGED_CONTENT = 'const a = 2\n'

interface ViewerSpec {
  id: string
  ext: string
  path: string
}

const CODE_VIEWER: ViewerSpec = { id: 'code', ext: 'ts', path: '/p/a.ts' }
const MARKDOWN_VIEWER: ViewerSpec = { id: 'markdown', ext: 'md', path: '/p/a.md' }

const readText = (content: string, mtimeMs: number): { kind: 'text'; content: string; size: number; mtimeMs: number } =>
  ({ kind: 'text', content, size: content.length, mtimeMs })

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

function setup(viewer: ViewerSpec = CODE_VIEWER): { ctx: Context; store: ReturnType<typeof createSidebarStore>; tab: () => SidebarTab } {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: viewer.id,
    exts: [viewer.ext],
    priority: 0,
    fetchStrategy: 'fsRead',
    component: (props: FileViewerProps) => createElement(TextEditor, props),
  })
  store.setSession('s1')
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { s1: { cwd: '/p' } }, current: 's1' }) } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  ctx.betterSidebar.openTab({ type: 'editor', title: viewer.path.split('/').pop()!, path: viewer.path, id: `editor:${viewer.path}` })
  const tab = (): SidebarTab => allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    .find(candidate => candidate.path === viewer.path)!
  return { ctx, store, tab }
}

function mount(viewer: ViewerSpec = CODE_VIEWER): Harness {
  const { ctx, store, tab } = setup(viewer)
  const root = renderRoot(createElement(EditorHost, {
    ctx,
    store: store as never,
    scope: { sessionId: 's1' },
    tab: tab(),
    expanded: [],
    revealed: [],
    onToggleDir: () => {},
    onReferenceFile: () => {},
  }))
  return { container: root.container, unmount: root.unmount }
}

/** The editor's live CodeMirror view (the real document, draft included). */
function viewOf(container: HTMLElement): EditorView {
  const host = container.querySelector('.cm-editor')
  if (host === null) throw new Error('the mounted editor has no .cm-editor')
  const view = EditorView.findFromDOM(host as HTMLElement)
  if (view === null) throw new Error('the mounted editor has no CodeMirror view')
  return view
}

/** Type through CodeMirror's own doc-change path (a keystroke). */
function typeText(container: HTMLElement, text: string): void {
  act(() => {
    viewOf(container).dispatch({ changes: { from: 0, insert: text } })
  })
}

/** The user's first unsaved edit. */
function typeDraft(container: HTMLElement): void {
  typeText(container, DRAFT_PREFIX)
}

function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button[aria-label="Save"]')
  if (button === null) throw new Error('the host header has no save button')
  return button as HTMLButtonElement
}

/** One of the host header's mode-toggle buttons, by label. */
function modeButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`no "${label}" mode button`)
  return button as HTMLButtonElement
}

/** Save once and assert the host refused it as a conflict. */
async function saveIntoConflict(container: HTMLElement): Promise<void> {
  fsWrite.mockRejectedValueOnce(new SidebarApiError('fs-conflict', 'changed on disk'))
  click(saveButton(container))
  await settle()
  expect(container.textContent ?? '').toContain('changed on disk since it was loaded')
}

function reloadButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find(candidate => candidate.textContent === 'Reload from disk')
  if (button === undefined) throw new Error('the conflict banner has no reload button')
  return button as HTMLButtonElement
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  fsRead.mockReset()
  fsWrite.mockReset()
  fsWrite.mockResolvedValue({ ok: true, mtimeMs: 300 })
  fsRead.mockImplementation(() => Promise.resolve(readText(CONTENT, 100)))
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('save-conflict banner: reload with a dirty draft (#1059)', () => {
  it('adopts a touch-only reload in place: no confirm, draft kept, next save uses the new mtime', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container, unmount } = mount()
    try {
      await settle()
      typeDraft(container)
      await saveIntoConflict(container)
      const before = viewOf(container)
      expect(before.state.doc.toString()).toBe(`${DRAFT_PREFIX}${CONTENT}`)
      // Disk still holds the loaded bytes; only the mtime moved.
      fsRead.mockImplementation(() => Promise.resolve(readText(CONTENT, 200)))
      click(reloadButton(container))
      await settle()
      // No dirty-confirm was asked, the banner cleared, and the draft is intact.
      expect(confirm).not.toHaveBeenCalled()
      expect(container.textContent ?? '').not.toContain('changed on disk since it was loaded')
      expect(viewOf(container), 'the same editor instance stays mounted').toBe(before)
      expect(viewOf(container).state.doc.toString()).toBe(`${DRAFT_PREFIX}${CONTENT}`)
      // The next save carries the fresh baseline (200) and is accepted.
      click(saveButton(container))
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(2)
      expect(fsWrite.mock.calls[1]![2]).toBe(`${DRAFT_PREFIX}${CONTENT}`)
      expect(fsWrite.mock.calls[1]![3]).toBe(200)
    } finally {
      unmount()
    }
  })

  it('still protects a dirty draft when the reloaded bytes really changed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container, unmount } = mount()
    try {
      await settle()
      typeDraft(container)
      await saveIntoConflict(container)
      const before = viewOf(container)
      // The file was really rewritten, not merely touched.
      fsRead.mockImplementation(() => Promise.resolve(readText(CHANGED_CONTENT, 200)))
      click(reloadButton(container))
      await settle()
      // The host's dirty guard still applies: a declined confirm replaces
      // nothing, and the conflict banner stays up.
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(viewOf(container), 'no remount on a declined reload').toBe(before)
      expect(viewOf(container).state.doc.toString()).toBe(`${DRAFT_PREFIX}${CONTENT}`)
      expect(container.textContent ?? '').toContain('changed on disk since it was loaded')
    } finally {
      unmount()
    }
  })

  it('compares against the last SAVED bytes when an edit-mode save did not reload', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fsRead.mockImplementation(() => Promise.resolve(readText(CONTENT, 100)))
    const { container, unmount } = mount(MARKDOWN_VIEWER)
    try {
      await settle()
      // Markdown opens in preview; the host header's Edit toggle shows source.
      click(modeButton(container, 'Edit'))
      typeDraft(container)
      // A successful save in EDIT mode does not reload (the host keeps the
      // caret), so `content` stays at the bytes loaded when the tab opened.
      click(saveButton(container))
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(1)
      expect(fsWrite.mock.calls[0]![2]).toBe(`${DRAFT_PREFIX}${CONTENT}`)
      // The tool touches the file: same bytes as the last SAVE, new mtime.
      fsRead.mockImplementation(() => Promise.resolve(readText(`${DRAFT_PREFIX}${CONTENT}`, 200)))
      typeText(container, SECOND_PREFIX)
      await saveIntoConflict(container)
      click(reloadButton(container))
      await settle()
      // In-place: no confirm, the second draft survives, the comparison point
      // was the saved bytes (not the stale `content` prop).
      expect(confirm).not.toHaveBeenCalled()
      expect(container.textContent ?? '').not.toContain('changed on disk since it was loaded')
      expect(viewOf(container).state.doc.toString()).toBe(`${SECOND_PREFIX}${DRAFT_PREFIX}${CONTENT}`)
      click(saveButton(container))
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(3)
      expect(fsWrite.mock.calls[2]![2]).toBe(`${SECOND_PREFIX}${DRAFT_PREFIX}${CONTENT}`)
      expect(fsWrite.mock.calls[2]![3]).toBe(200)
    } finally {
      unmount()
    }
  })
})
