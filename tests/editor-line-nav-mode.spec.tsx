/**
 * A markdown reference that names a line must not own the file's mode forever
 * (#826, second half — the forced edit-mode flip).
 *
 * The text editor flips a markdown/html file OUT of preview when a reference
 * named a line (preview renders no source lines). That flip is part of the
 * navigation, not a property of the file: the reader must be able to go back to
 * preview afterwards. It cannot be tracked inside the viewer, because a reload
 * REMOUNTS the viewer (EditorHost renders the loading row in its place) and the
 * fresh instance — mode `preview`, no memory — would re-force the flip on every
 * refresh, including the one the preview button itself triggers.
 *
 * `tests/text-editor-line-jump.spec.tsx` renders the viewer alone, so it cannot
 * see any of this: the host is what decides when a navigation is spent.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarStore, type SidebarTab } from '../src/client/state.ts'

setupReactAct()

const fsRead = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsRead: (...args: unknown[]) => fsRead(...args),
    mediaUrl: () => '',
  },
}))

const SESSION = 'line-nav-session'
const BODY = '# title\n\nfirst\n\nsecond\n'

/** fsRead call count: the "did a reload remount the viewer" evidence. */
function reads(): number {
  return fsRead.mock.calls.length
}

/** Let the initial load (and any reload it triggers) settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

interface Harness {
  ctx: Context
  store: SidebarStore
  /** The editor tab for `path`, carrying `line` when the reference named one. */
  tabOf: (path: string, line?: number) => SidebarTab
}

/** One sidebar service + store with the REAL text editor behind `markdown`. */
function harness(): Harness {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'markdown',
    exts: ['md'],
    priority: 0,
    fetchStrategy: 'fsRead',
    component: TextEditor,
  })
  store.setSession(SESSION)
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [SESSION]: { cwd: '/tmp' } } }) } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  return {
    ctx,
    store,
    tabOf: (path, line): SidebarTab => {
      ctx.betterSidebar.openTab({ type: 'editor', title: path.split('/').pop()!, path, id: `editor:${path}` })
      const tab = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(item => item.path === path)!
      return line === undefined ? tab : { ...tab, line }
    },
  }
}

function mount(ctx: Context, tab: SidebarTab, store: SidebarStore): ReturnType<typeof renderRoot> {
  return renderRoot(createElement(EditorHost, {
    ctx,
    store,
    scope: { sessionId: SESSION, cwd: '/tmp' },
    tab,
    visible: true,
    expanded: [],
    revealed: [],
    onToggleDir: () => {},
    onReferenceFile: () => {},
  }))
}

/** The editor is on screen (edit mode) — in preview the CodeMirror host is hidden. */
function editing(container: HTMLElement): boolean {
  return container.querySelector('[class*="editorCmHidden"]') === null
}

function modeButton(container: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent === label)!
}

function click(button: HTMLButtonElement): void {
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  fsRead.mockReset()
  fsRead.mockResolvedValue({ kind: 'text', content: BODY, truncated: false })
})

describe('a referenced line does not own the file mode (#826)', () => {
  it('a markdown reference opens in the editor, and the reader can go back to preview', async () => {
    const { ctx, store, tabOf } = harness()
    const view = mount(ctx, tabOf('/tmp/readme.md', 3), store)
    try {
      await settle()
      expect(reads()).toBe(1)
      // The reference asked for source, so the file lands in the editor.
      expect(editing(view.container)).toBe(true)

      // Back to preview — this reloads (#167 part B), which REMOUNTS the viewer.
      click(modeButton(view.container, 'Preview'))
      await settle()
      expect(reads()).toBe(2)

      // ...and the remount must not flip the file back into the editor.
      expect(editing(view.container)).toBe(false)
    } finally {
      view.unmount()
    }
  })

  it('the header refresh does not flip a previewed file back into the editor either', async () => {
    const { ctx, store, tabOf } = harness()
    const view = mount(ctx, tabOf('/tmp/readme.md', 3), store)
    try {
      await settle()
      expect(editing(view.container)).toBe(true)
      click(modeButton(view.container, 'Preview'))
      await settle()

      const refresh = view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh"], button[aria-label="刷新"]',
      )!
      click(refresh)
      await settle()
      expect(reads()).toBe(3)

      expect(editing(view.container)).toBe(false)
    } finally {
      view.unmount()
    }
  })

  it('a NEW line on the same open file still lands (and re-opens the editor)', async () => {
    const { ctx, store, tabOf } = harness()
    const view = mount(ctx, tabOf('/tmp/readme.md', 3), store)
    try {
      await settle()
      expect(editing(view.container)).toBe(true)
      click(modeButton(view.container, 'Preview'))
      await settle()
      expect(editing(view.container)).toBe(false)

      // The same tab navigated to another line of the same file.
      view.rerender(createElement(EditorHost, {
        ctx,
        store,
        scope: { sessionId: SESSION, cwd: '/tmp' },
        tab: { ...tabOf('/tmp/readme.md', 5), line: 5 },
        visible: true,
        expanded: [],
        revealed: [],
        onToggleDir: () => {},
        onReferenceFile: () => {},
      }))
      await settle()

      expect(editing(view.container)).toBe(true)
    } finally {
      view.unmount()
    }
  })
})
describe('a spent line must not ride along to the next file', () => {
  it('an in-place path switch drops it (updateTab retargets the record)', async () => {
    // The reader types another path into the same window (merged mode): the
    // record keeps its identity and takes the new path, but the landing line
    // belonged to the navigation that delivered the PREVIOUS file. Keeping it
    // sent the new file to line 3 — and, being markdown, forced it into the
    // editor, which is the same "stuck in edit mode" the reload bug produced.
    const { ctx, store, tabOf } = harness()
    const tab = tabOf('/tmp/a.md', 3)
    const view = mount(ctx, tab, store)
    const host = (next: SidebarTab): ReturnType<typeof createElement> => createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId: SESSION, cwd: '/tmp' },
      tab: next,
      visible: true,
      expanded: [],
      revealed: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    })
    try {
      await settle()
      expect(editing(view.container)).toBe(true)

      // The real retarget path (`EditorHost.openFile` merged mode / a rename),
      // then the tab the store actually holds after it.
      ctx.betterSidebar.updateTab(tab.id, { path: '/tmp/b.md', title: 'b.md' }, SESSION)
      const retargeted = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(item => item.id === tab.id)!
      expect(retargeted.line).toBeUndefined()

      view.rerender(host(retargeted))
      await settle()

      expect(editing(view.container)).toBe(false)
    } finally {
      view.unmount()
    }
  })
})
