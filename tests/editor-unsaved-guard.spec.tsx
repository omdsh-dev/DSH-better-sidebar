/**
 * Unsaved-draft protection: the dirty registry itself plus the close guard it
 * arms. The registry is fed by the editor host's toolbar report; the guard is
 * the sidebar's tab close (the X button, middle click, tab context menu, and
 * the tree's close-on-rename/delete all funnel through the same action).
 *
 * The close path is driven through the REAL Sidebar shell (same minimal fake
 * context as sidebar-crash.spec.tsx) so the test pins the behavior a user
 * actually gets, not a helper: cancel keeps the tab, confirm closes it.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { Sidebar } from '../src/client/Sidebar.tsx'
import { createBetterSidebarService, type BetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, toggleBottomPanel, type SidebarStore } from '../src/client/state.ts'
import {
  clearEditorDirty, confirmDiscardDraft, dirtyCount, dirtyCountForSession, editorDirtyRevision,
  isEditorDirty, setEditorDirty, subscribeEditorDirty,
} from '../src/client/editor-dirty.ts'
import { clearRetargetedPath, closePathTabs, consumeRetargetedPath, pathTabKey, retargetPathTabs } from '../src/client/tree-mutations.ts'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'

setupReactAct()

const fsRead = vi.fn()
// Partial mock: only the reads this spec drives are stubbed. The sidebar shell
// also touches `sessionPhase` / `api.sessionCwd` / the tree panel on mount, and
// a wholesale replacement breaks them (`No "sessionPhase" export …`).
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      fsRead: (...args: unknown[]) => fsRead(...args),
      fsTree: () => Promise.resolve({ path: '', entries: [], truncated: false }),
    },
  }
})

/** jsdom has no WebSocket; the sidebar's agent-terminals effect builds one. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

/** A viewer that reports a dirty toolbar and renders nothing else. */
function DirtyViewer({ onToolbarState }: FileViewerProps) {
  useEffect(() => {
    onToolbarState?.({ modes: false, mode: 'edit', dirty: true, editable: true, saveState: 'idle' })
  }, [onToolbarState])
  return createElement('div', null, 'dirty-viewer')
}

let sessionSeq = 0

interface Mounted {
  container: HTMLDivElement
  store: SidebarStore
  service: BetterSidebarService
  sessionId: string
  unmount: () => void
}

/** Mount the real Sidebar shell with one open editor tab (dirty viewer). */
function mountSidebarWithEditor(): Mounted {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({
    id: 'editor',
    title: 'Files',
    dedupeKey: (tab) => tab.path,
    component: ({ ctx, store: tabStore, scope, tab, expanded, revealed, onToggleDir, onReferenceFile }) =>
      createElement(EditorHost, {
        ctx, store: tabStore, scope, tab,
        expanded: expanded ?? [], revealed: revealed ?? [],
        onToggleDir: onToggleDir ?? (() => {}), onReferenceFile: onReferenceFile ?? (() => {}),
      }),
  })
  service.registerFileViewer({
    id: 'mock-text', exts: ['ts'], priority: 0, fetchStrategy: 'fsRead', component: DirtyViewer,
  })
  const sessionId = `dirty-${++sessionSeq}`
  store.setSession(sessionId)
  // The plugin's own workbench hosts its tabs; without the panel open the tab
  // strip (and its close button) is not rendered at all.
  store.reduce(toggleBottomPanel)
  const localeSnapshot = { active: 'en' }
  // The session-list snapshot never carried a current-session field: the shell
  // binds its per-session state to the native surface's mounted seat.
  const sessionsSnapshot = { byId: { [sessionId]: { cwd: '/tmp' } } }
  const mounted = { getSnapshot: () => sessionId, subscribe: () => () => {} }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar'
      ? service
      : name === 'sidebarRight' ? { mounted } : undefined,
  } as unknown as Context
  service.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx, store })) })
  return {
    container, store, service, sessionId,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** The a.ts tab's close button (the seeded Files home tab also has one). */
function closeButton(container: HTMLDivElement): HTMLButtonElement {
  const tabNode = Array.from(container.querySelectorAll('[title="a.ts"]'))
    .find(node => node.querySelector('button') !== null)
  const button = tabNode?.querySelector('button[aria-label="Close"], button[aria-label="关闭"]')
  if (button === undefined || button === null) throw new Error('close button not found')
  return button as HTMLButtonElement
}

function click(button: HTMLElement): void {
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function openTabIds(store: SidebarStore): string[] {
  const state = store.getSnapshot().state
  if (state === undefined) return []
  // The plugin's tabs live in its own bottom workbench (the main column
  // belongs to DSH's native right sidebar).
  return allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs).map(tab => tab.id)
}

beforeEach(() => {
  fsRead.mockReset()
  fsRead.mockResolvedValue({ kind: 'text', content: 'hello', truncated: false })
  // The registry is module-level: a previous test's draft must not leak in.
  for (const id of ['editor:/tmp/a.ts', 't1', 't2']) clearEditorDirty(id)
})

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('editor-dirty registry', () => {
  it('registers a dirty tab and clears it again, bumping the revision each time', () => {
    const before = editorDirtyRevision()
    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    expect(isEditorDirty('t1')).toBe(true)
    expect(dirtyCount()).toBe(1)
    expect(dirtyCountForSession('s1')).toBe(1)
    expect(dirtyCountForSession('other')).toBe(0)
    expect(editorDirtyRevision()).toBeGreaterThan(before)

    const afterRegister = editorDirtyRevision()
    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    // Same entry twice is a no-op: no revision churn (the unload effect would
    // otherwise re-subscribe on every render).
    expect(editorDirtyRevision()).toBe(afterRegister)

    clearEditorDirty('t1')
    expect(isEditorDirty('t1')).toBe(false)
    expect(dirtyCount()).toBe(0)
    expect(editorDirtyRevision()).toBeGreaterThan(afterRegister)
  })

  it('re-points an entry when the tab switches file or session', () => {
    setEditorDirty('t2', true, 's1', '/tmp/a.ts')
    setEditorDirty('t2', true, 's2', '/tmp/b.ts')
    expect(dirtyCountForSession('s1')).toBe(0)
    expect(dirtyCountForSession('s2')).toBe(1)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeEditorDirty(listener)
    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    expect(listener).toHaveBeenCalledTimes(1)
    clearEditorDirty('t1')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('confirmDiscardDraft passes clean tabs through and prompts for dirty ones', () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    expect(confirmDiscardDraft('t1', 'sure?')).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()

    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    expect(confirmDiscardDraft('t1', 'sure?')).toBe(false)
    expect(confirmSpy).toHaveBeenCalledWith('sure?')
    // Declined: the draft survives.
    expect(isEditorDirty('t1')).toBe(true)

    confirmSpy.mockReturnValue(true)
    expect(confirmDiscardDraft('t1', 'sure?')).toBe(true)
    // Confirmed: the entry is cleared so a follow-up close cannot re-prompt.
    expect(isEditorDirty('t1')).toBe(false)
  })
})

describe('tree close-on-delete', () => {
  it('keeps a dirty tab when the user declines, closes it on confirm', () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('tree-close')
    const ctx = { betterSidebar: service, get: (name: string) => name === 'betterSidebar' ? service : undefined } as unknown as Context
    service.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
    setEditorDirty('editor:/tmp/a.ts', true, 'tree-close', '/tmp/a.ts')

    closePathTabs(ctx, store, '/tmp/a.ts', 'discard?')
    expect(confirmSpy).toHaveBeenCalledWith('discard?')
    expect(openTabIds(store)).toContain('editor:/tmp/a.ts')

    confirmSpy.mockReturnValue(true)
    closePathTabs(ctx, store, '/tmp/a.ts', 'discard?')
    expect(openTabIds(store)).not.toContain('editor:/tmp/a.ts')
  })
})

describe('tree rename/delete reconciliation', () => {
  /**
   * A real native surface over a real record registry, installed on the
   * service like the client half does. Native tabs are the DEFAULT place a file
   * opens (with a native surface installed, `openTab` never touches the bottom
   * splits), so a reconciliation that only walked `bottomSplits` skipped the
   * tabs the user actually has open.
   */
  function mountNative(service: BetterSidebarService): {
    records: ReturnType<typeof createNativeTabRecords>
    close: ReturnType<typeof vi.fn>
    context: Context
  } {
    const close = vi.fn()
    const controller = {
      openTab: () => {}, openResource: () => {}, close, focus: () => {},
      mounted: { getSnapshot: () => 'native-scope', subscribe: () => () => {} },
      openTabIn: () => {}, openResourceIn: () => {}, closeIn: () => {},
    }
    const records = createNativeTabRecords()
    const surfaceCtx = {
      get: (name: string) => (name === 'sidebarRight' ? controller : undefined),
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({}) } },
    }
    const surface = createNativeSurface(surfaceCtx as never, records)
    service.setSurface(surface)
    const context = { betterSidebar: service, get: (name: string) => name === 'betterSidebar' ? service : undefined } as unknown as Context
    return { records, close, context }
  }

  /** One editor record bound to a file, as a native open would mint it. */
  const openNativeFile = (
    records: ReturnType<typeof createNativeTabRecords>,
    id: string,
    path: string,
  ): void => {
    records.ensure({
      sessionId: 'native-scope',
      id,
      kind: 'editor',
      title: 'a.ts',
      params: { path },
      scope: { sessionId: 'native-scope' },
    })
  }

  // Both registries are module-level: a leaked draft would break the
  // neighbouring suites' counts, and a leftover retarget marker would suppress
  // a later test's load.
  const TEST_IDS = ['tab1', 'tab2', 'tab3', 'tab4', 'tab5']
  const TEST_SEATS = ['native-scope', 'other-scope']
  beforeEach(() => {
    for (const id of TEST_IDS) {
      clearEditorDirty(id)
      for (const seat of TEST_SEATS) clearRetargetedPath(pathTabKey(seat, id))
    }
  })
  afterEach(() => {
    for (const id of TEST_IDS) {
      clearEditorDirty(id)
      for (const seat of TEST_SEATS) clearRetargetedPath(pathTabKey(seat, id))
    }
  })

  it('retargets a native tab when the FILE it shows is renamed', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('native-scope')
    const { records, context } = mountNative(service)
    openNativeFile(records, 'tab1', '/ws/dir/a.ts')

    retargetPathTabs(context, store, '/ws/dir/a.ts', '/ws/dir/b.ts')

    expect(records.get('native-scope', 'tab1')?.tab).toMatchObject({ path: '/ws/dir/b.ts', title: 'b.ts' })
    // The move is announced for the editor, which keeps its document (and any
    // unsaved draft) instead of reloading the new name. Each announcement is
    // claimed once — a second claim of the same move reports false, and so does
    // a move this tab was never told about.
    const key = pathTabKey('native-scope', 'tab1')
    expect(consumeRetargetedPath(key, '/ws/dir/a.ts', '/ws/dir/b.ts')).toBe(true)
    expect(consumeRetargetedPath(key, '/ws/dir/a.ts', '/ws/dir/b.ts')).toBe(false)
    expect(consumeRetargetedPath(key, '/ws/dir/a.ts', '/ws/elsewhere.ts')).toBe(false)
  })

  it('retargets a tab opened from a CHAT LINK (its address stores a workspace-relative path)', () => {
    // `fileAddressFor` spells a path inside the workspace relatively, so a tab
    // opened from chat holds `src/a.ts` while the tree renames by absolute path.
    // Comparing the two raw skipped exactly those tabs — the default way a file
    // reaches this column — and left them bound to the name the user had just
    // renamed away.
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('native-scope')
    const { records, context } = mountNative(service)
    records.ensure({
      sessionId: 'native-scope',
      id: 'tab2',
      kind: 'editor',
      title: 'a.ts',
      params: { path: 'src/a.ts' },
      scope: { sessionId: 'native-scope', cwd: '/ws' },
    })

    retargetPathTabs(context, store, '/ws/src/a.ts', '/ws/src/b.ts')

    // The tab follows to the new name, spelled absolutely now: `fs.write`
    // resolves either spelling, and the record keeps the host's address until
    // the host navigates it again.
    expect(records.get('native-scope', 'tab2')?.tab.path).toBe('/ws/src/b.ts')
    // The announcement carries the tab's OWN old spelling — what its editor
    // compares against.
    expect(consumeRetargetedPath(pathTabKey('native-scope', 'tab2'), 'src/a.ts', '/ws/src/b.ts')).toBe(true)
  })

  it('keeps one seat\'s pending move when another seat clears its own (native ids restart per session)', () => {
    // `tab1` names a tab in EVERY conversation, so a rename reaches two seats at
    // once. Keyed by the id alone they shared one marker: whichever editor ran
    // its effect first (even one whose own path did not move — it clears what it
    // finds) wiped the other's pending move, and that editor reloaded the
    // renamed file with the draft this mechanism exists to protect.
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('native-scope')
    const { records, context } = mountNative(service)
    openNativeFile(records, 'tab1', '/ws/a.ts')
    records.ensure({
      sessionId: 'other-scope',
      id: 'tab1',
      kind: 'editor',
      title: 'a.ts',
      params: { path: '/ws/a.ts' },
      scope: { sessionId: 'other-scope' },
    })

    retargetPathTabs(context, store, '/ws/a.ts', '/ws/b.ts')

    expect(records.get('native-scope', 'tab1')?.tab.path).toBe('/ws/b.ts')
    expect(records.get('other-scope', 'tab1')?.tab.path).toBe('/ws/b.ts')
    const here = pathTabKey('native-scope', 'tab1')
    const there = pathTabKey('other-scope', 'tab1')
    clearRetargetedPath(here)
    expect(consumeRetargetedPath(there, '/ws/a.ts', '/ws/b.ts')).toBe(true)
    expect(consumeRetargetedPath(here, '/ws/a.ts', '/ws/b.ts')).toBe(false)
  })

  it('keeps the loaded document when a rename moves an OPEN tab (the draft survives)', async () => {
    const mounted = mountSidebarWithEditor()
    try {
      await act(async () => { await Promise.resolve() })
      const readsBefore = fsRead.mock.calls.length
      const tabOf = (): { id: string; path?: string } => allLeaves(mounted.store.getSnapshot().state!.bottomSplits)
        .flatMap(leaf => leaf.tabs).find(candidate => candidate.path !== undefined)!
      const id = tabOf().id
      expect(isEditorDirty(id)).toBe(true)

      const context = {
        get: (name: string) => name === 'betterSidebar' ? mounted.service : undefined,
      } as unknown as Context
      act(() => { retargetPathTabs(context, mounted.store, '/tmp/a.ts', '/tmp/b.ts') })
      await act(async () => { await Promise.resolve() })

      // The tab follows the file…
      expect(tabOf().path).toBe('/tmp/b.ts')
      // …without re-reading it: a reload would replace the document with the
      // same bytes and drop the draft, which lives only in the editor.
      expect(fsRead.mock.calls.length).toBe(readsBefore)
      expect(isEditorDirty(id)).toBe(true)
    } finally {
      mounted.unmount()
    }
  })

  it('retargets the SUBTREE when a directory is renamed (both tab spaces)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('native-scope')
    const { records, context } = mountNative(service)
    openNativeFile(records, 'tab2', '/ws/dir/deep/a.ts')
    // …and one in the bottom workbench (`target: 'bottom'` is the one open that
    // stays in the plugin's own layout), which the old code DID walk but only
    // for an exact path match.
    service.openTab({ type: 'editor', title: 'c.ts', path: '/ws/dir/c.ts', target: 'bottom' })
    const before = records.get('native-scope', 'tab2')?.tab.path

    retargetPathTabs(context, store, '/ws/dir', '/ws/renamed')

    expect(before).toBe('/ws/dir/deep/a.ts')
    expect(records.get('native-scope', 'tab2')?.tab.path).toBe('/ws/renamed/deep/a.ts')
    const bottom = allLeaves(store.getSnapshot().state!.bottomSplits)
      .flatMap(leaf => leaf.tabs).find(tab => tab.path !== undefined)
    expect(bottom?.path).toBe('/ws/renamed/c.ts')
  })

  it('closes a native tab when its FILE is deleted, asking first when dirty', () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('native-scope')
    const { records, close, context } = mountNative(service)
    openNativeFile(records, 'tab3', '/ws/a.ts')
    // The editor host registers the draft under the NATIVE tab id.
    setEditorDirty('tab3', true, 'native-scope', '/ws/a.ts')

    closePathTabs(context, store, '/ws/a.ts', 'discard?')
    expect(confirmSpy).toHaveBeenCalledWith('discard?')
    expect(records.has('native-scope', 'tab3')).toBe(true)
    expect(close).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    closePathTabs(context, store, '/ws/a.ts', 'discard?')
    expect(records.has('native-scope', 'tab3')).toBe(false)
    // The host's own tab really closes too (the record alone would leave an
    // empty pane behind).
    expect(close).toHaveBeenCalledWith('tab3')
  })

  it('closes native tabs under a deleted DIRECTORY', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('native-scope')
    const { records, context } = mountNative(service)
    openNativeFile(records, 'tab4', '/ws/dir/deep/a.ts')
    openNativeFile(records, 'tab5', '/ws/other.ts')

    closePathTabs(context, store, '/ws/dir', 'discard?')

    expect(records.has('native-scope', 'tab4')).toBe(false)
    expect(records.has('native-scope', 'tab5')).toBe(true)
  })
})

describe('EditorHost dirty registration', () => {
  it('registers the open tab and clears it when the host unmounts', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', dedupeKey: (tab) => tab.path, component: () => null })
    service.registerFileViewer({ id: 'mock-text', exts: ['ts'], fetchStrategy: 'fsRead', component: DirtyViewer })
    store.setSession('editor-host-dirty')
    const ctx = { betterSidebar: service, get: (name: string) => name === 'betterSidebar' ? service : undefined } as unknown as Context
    service.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
    const tab = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(candidate => candidate.path === '/tmp/a.ts')!
    const mounted = renderRoot(createElement(EditorHost, {
      ctx, store, scope: { sessionId: 'editor-host-dirty' }, tab,
      expanded: [], revealed: [], onToggleDir: () => {}, onReferenceFile: () => {},
    }))
    await act(async () => { await Promise.resolve() })
    expect(isEditorDirty(tab.id)).toBe(true)
    mounted.unmount()
    expect(isEditorDirty(tab.id)).toBe(false)
  })
})

describe('close guard', () => {
  it('cancel keeps the tab open and confirm closes it', async () => {
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    const mounted = mountSidebarWithEditor()
    try {
      await act(async () => { await Promise.resolve() })
      expect(openTabIds(mounted.store)).toContain('editor:/tmp/a.ts')
      expect(isEditorDirty('editor:/tmp/a.ts')).toBe(true)

      // Cancel: the tab survives and stays dirty.
      confirmSpy.mockReturnValue(false)
      click(closeButton(mounted.container))
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(openTabIds(mounted.store)).toContain('editor:/tmp/a.ts')
      expect(isEditorDirty('editor:/tmp/a.ts')).toBe(true)

      // Confirm: the tab closes.
      confirmSpy.mockReturnValue(true)
      click(closeButton(mounted.container))
      expect(confirmSpy).toHaveBeenCalledTimes(2)
      expect(openTabIds(mounted.store)).not.toContain('editor:/tmp/a.ts')
    } finally {
      mounted.unmount()
    }
  })

  it('a clean tab closes without prompting', async () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const mounted = mountSidebarWithEditor()
    try {
      await act(async () => { await Promise.resolve() })
      clearEditorDirty('editor:/tmp/a.ts')
      click(closeButton(mounted.container))
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(openTabIds(mounted.store)).not.toContain('editor:/tmp/a.ts')
    } finally {
      mounted.unmount()
    }
  })
})
