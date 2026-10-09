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
  clearEditorDirty, confirmDiscardDraft, dirtyCount, editorDirtyRevision,
  isEditorDirty, setEditorDirty, subscribeEditorDirty,
} from '../src/client/editor-dirty.ts'
import { closePathTabs } from '../src/client/tree-mutations.ts'

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
    expect(isEditorDirty('t1', 's1')).toBe(true)
    expect(dirtyCount()).toBe(1)
    expect(isEditorDirty('t1', 'other')).toBe(false)
    expect(editorDirtyRevision()).toBeGreaterThan(before)

    const afterRegister = editorDirtyRevision()
    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    // Same entry twice is a no-op: no revision churn (the unload effect would
    // otherwise re-subscribe on every render).
    expect(editorDirtyRevision()).toBe(afterRegister)

    clearEditorDirty('t1', 's1')
    expect(isEditorDirty('t1', 's1')).toBe(false)
    expect(dirtyCount()).toBe(0)
    expect(editorDirtyRevision()).toBeGreaterThan(afterRegister)
  })

  it('keeps one record per session for the same tab id', () => {
    // The id is session-scoped: the native right column counts its own `tab1`…
    // and the workbench reuses `editor:<path>` across sessions, so both records
    // must be able to exist at once.
    setEditorDirty('t2', true, 's1', '/tmp/a.ts')
    setEditorDirty('t2', true, 's2', '/tmp/b.ts')
    expect(dirtyCount()).toBe(2)
    expect(isEditorDirty('t2', 's1')).toBe(true)
    expect(isEditorDirty('t2', 's2')).toBe(true)
  })

  it('a second session mounting the same tab id never clears the first session draft', () => {
    // Session A's editor holds a draft …
    setEditorDirty('tab1', true, 's1', '/tmp/a.ts')
    // … then B's editor mounts over the same native id and reports clean (its
    // mount always does: the toolbar has not reported yet), and B's body is
    // unmounted again. Neither may touch A's record: losing it disarms the
    // unload guard and a refresh drops A's draft without a word.
    setEditorDirty('tab1', false, 's2', '/tmp/b.ts')
    clearEditorDirty('tab1', 's2')
    expect(isEditorDirty('tab1', 's1')).toBe(true)
    expect(dirtyCount()).toBe(1)
    // Without a session the read is the conservative one: any session matches.
    expect(isEditorDirty('tab1')).toBe(true)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeEditorDirty(listener)
    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    expect(listener).toHaveBeenCalledTimes(1)
    clearEditorDirty('t1', 's1')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('confirmDiscardDraft passes clean tabs through and prompts for dirty ones', () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    expect(confirmDiscardDraft('t1', 'sure?', 's1')).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()

    setEditorDirty('t1', true, 's1', '/tmp/a.ts')
    expect(confirmDiscardDraft('t1', 'sure?', 's1')).toBe(false)
    expect(confirmSpy).toHaveBeenCalledWith('sure?')
    // Declined: the draft survives.
    expect(isEditorDirty('t1', 's1')).toBe(true)

    confirmSpy.mockReturnValue(true)
    expect(confirmDiscardDraft('t1', 'sure?', 's1')).toBe(true)
    // Confirmed: the entry is cleared so a follow-up close cannot re-prompt.
    expect(isEditorDirty('t1', 's1')).toBe(false)
    // Another session's same-numbered tab is untouched by that clear.
    setEditorDirty('t1', true, 's9', '/tmp/other.ts')
    confirmSpy.mockReturnValue(false)
    expect(confirmDiscardDraft('t1', 'sure?', 's1')).toBe(true)
    expect(isEditorDirty('t1', 's9')).toBe(true)
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
    expect(isEditorDirty(tab.id, 'editor-host-dirty')).toBe(true)
    mounted.unmount()
    expect(isEditorDirty(tab.id, 'editor-host-dirty')).toBe(false)
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
      expect(isEditorDirty('editor:/tmp/a.ts', mounted.sessionId)).toBe(true)

      // Cancel: the tab survives and stays dirty.
      confirmSpy.mockReturnValue(false)
      click(closeButton(mounted.container))
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(openTabIds(mounted.store)).toContain('editor:/tmp/a.ts')
      expect(isEditorDirty('editor:/tmp/a.ts', mounted.sessionId)).toBe(true)

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
      clearEditorDirty('editor:/tmp/a.ts', mounted.sessionId)
      click(closeButton(mounted.container))
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(openTabIds(mounted.store)).not.toContain('editor:/tmp/a.ts')
    } finally {
      mounted.unmount()
    }
  })
})
