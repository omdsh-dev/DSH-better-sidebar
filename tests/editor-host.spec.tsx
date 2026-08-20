/**
 * EditorHost (the files window): in merged (in-place) mode a path-less tab
 * renders the empty-state hint with the tree dock open, and the header's
 * tree toggle persists its flag through ctx.betterSidebar.updateTab
 * (meta.treeOpen rides the tab's persisted layout). The editorExplorer pref
 * controls FILE-OPEN behavior — in-place rewrites the current tab via
 * updateTab, split opens a per-path dedupe tab via openSidebarFile — and in
 * split mode a PATH-LESS window becomes the standalone explorer (tree panel
 * only, no editor chrome); file tabs keep the full chrome in both modes.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** A store with the seeded editor-home tab (default prefs: separate mode;
 *  merged-mode scenarios re-enable editorExplorer explicitly). */
function setup(): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
  homeTab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // The openTab path needs a registered editor descriptor (dedupe by path).
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession('editor-home-session')
  const homeTab = (): SidebarTab =>
    allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.type === 'editor' && tab.path === undefined)!
  // openSidebarFile reads the session cwd from ctx.sessions.
  const sessionsSnapshot = { byId: { 'editor-home-session': { cwd: '/tmp' } }, current: 'editor-home-session' }
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  return { store, ctx, homeTab }
}

/** Mount the host for one tab; returns the container and an unmount helper. */
function mountHost(ctx: Context, store: ReturnType<typeof createSidebarStore>, tab: () => SidebarTab): {
  container: HTMLDivElement
  rerender: () => void
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (): void => {
    root.render(createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId: 'editor-home-session' },
      tab: tab(),
      expanded: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
  }
  act(render)
  return {
    container,
    // The real app re-renders the host with the fresh tab on every store
    // change (Sidebar subscribes); mirror that after mutating the store.
    rerender: () => { act(render) },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Type into the controlled path input (native setter) and press Enter. */
function typeAndCommit(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('EditorHost (files window)', () => {
  it('a path-less tab renders the empty-state hint with the tree panel open', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const html = container.innerHTML
      // The empty-state hint renders instead of the viewer loading flow.
      expect(html).toContain('Pick a file from the tree panel')
      expect(html).not.toContain('Loading…')
      // The header carries the path input and the pressed tree toggle; the
      // docked panel (search box) is open by default for path-less tabs.
      expect(container.querySelector('input')).not.toBeNull()
      const toggle = container.querySelector('button[aria-pressed]')
      expect(toggle?.getAttribute('aria-pressed')).toBe('true')
      // No cwd: the embedded tree renders its no-session placeholder
      // instead of touching the network.
      expect(html).toContain('Select a conversation')
    } finally {
      unmount()
    }
  })

  it('the tree toggle persists meta.treeOpen through updateTab', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    expect(homeTab().meta).toEqual({ treeOpen: true })
    const { container, rerender, unmount } = mountHost(ctx, store, homeTab)
    try {
      act(() => {
        container.querySelector('button[aria-pressed]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(homeTab().meta).toEqual({ treeOpen: false })
      // The store change re-renders the host with the fresh tab (Sidebar's
      // subscription in the real app); the second click flips it back.
      rerender()
      expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('false')
      act(() => {
        container.querySelector('button[aria-pressed]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(homeTab().meta).toEqual({ treeOpen: true })
    } finally {
      unmount()
    }
  })

  it('in-place mode: the path input Enter switches the CURRENT tab (stable id, meta kept)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const before = homeTab()
      typeAndCommit(container.querySelector('input')!, '/tmp/a.ts')
      // The same tab id now carries the file (homeTab's path-less finder no
      // longer matches — look the tab up by id).
      const after = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === before.id)!
      expect(after.id).toBe(before.id)
      expect(after.path).toBe('/tmp/a.ts')
      expect(after.title).toBe('a.ts')
      expect(after.meta).toEqual({ treeOpen: true })
      // No new tab landed.
      expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)).toHaveLength(1)
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab\'s path input Enter opens a NEW per-path tab; the source tab keeps its path', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      typeAndCommit(container.querySelector('input[placeholder^="File path"]')!, '/tmp/b.ts')
      const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      // home + a.ts + b.ts
      expect(tabs).toHaveLength(3)
      expect(fileTab().path).toBe('/tmp/a.ts')
      const opened = tabs.find(tab => tab.path === '/tmp/b.ts')!
      expect(opened.type).toBe('editor')
      expect(opened.title).toBe('b.ts')
      expect(opened.id).toBe('editor:/tmp/b.ts')
    } finally {
      unmount()
    }
  })

  it('split mode: the path-less window is the standalone explorer (tree only, no chrome)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      // No editor chrome: no path input, no tree toggle, no resize handle.
      expect(container.querySelector('input[placeholder^="File path"]')).toBeNull()
      expect(container.querySelector('button[aria-pressed]')).toBeNull()
      expect(container.querySelector('[role="separator"]')).toBeNull()
      // The tree panel fills the whole window — its search box is the only
      // input, and (no cwd) the tree shows its no-session placeholder.
      expect(container.querySelector('input[placeholder^="Search files"]')).not.toBeNull()
      expect(container.innerHTML).toContain('Select a conversation')
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab keeps the full chrome (path input + tree toggle + dock)', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts', meta: { treeOpen: true },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      expect(container.querySelector('input[placeholder^="File path"]')).not.toBeNull()
      expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true')
      expect(container.querySelector('[role="separator"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('dragging the panel edge resizes the dock and persists meta.treeWidth on release', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const handle = container.querySelector('[role="separator"]')!
      expect(handle).not.toBeNull()
      // The dock starts at the default width.
      const dock = handle.parentElement!
      expect(dock.style.width).toBe('240px')
      // Drag the left edge LEFT by 100px → the right-docked panel widens.
      // Pointer capture keeps move/up on the handle (jsdom: MouseEvent with
      // pointer* type names; setPointerCapture is absent and skipped).
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300 }))
        handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 }))
      })
      expect(dock.style.width).toBe('340px')
      // Release: the drag state clears and the width persists on the tab.
      act(() => { handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200 })) })
      expect(homeTab().meta).toEqual({ treeOpen: true, treeWidth: 340 })
    } finally {
      unmount()
    }
  })

  it('the header hosts the viewer toolbar (mode toggle / dirty dot / save)', () => {
    const { store, ctx } = setup()
    const service = ctx.betterSidebar
    const calls: string[] = []
    // A viewer with a hoisted toolbar (the TextEditor contract): register
    // commands and report the state once on mount.
    service.registerFileViewer({
      id: 'test:fake',
      exts: ['fake'],
      fetchStrategy: 'none',
      component: (viewerProps) => {
        useEffect(() => {
          viewerProps.onToolbarControls?.({
            setMode: (next) => { calls.push(`mode:${next}`) },
            save: () => { calls.push('save') },
          })
          viewerProps.onToolbarState?.({ modes: true, mode: 'preview', dirty: true, editable: true, saveState: 'idle' })
          return () => { viewerProps.onToolbarControls?.(null) }
        }, [])
        return null
      },
    })
    service.openTab({ type: 'editor', title: 'x.fake', path: '/tmp/x.fake', id: 'editor:/tmp/x.fake' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/x.fake')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      // Mode toggle + dirty dot + save button sit in the header row.
      const header = container.querySelector('input')!.parentElement!
      const buttons = [...header.querySelectorAll('button')]
      expect(buttons.map(b => b.textContent)).toContain('Preview')
      expect(buttons.map(b => b.textContent)).toContain('Edit')
      expect(header.querySelector('button[aria-label="Save"]')).not.toBeNull()
      expect(header.querySelector('[title="Unsaved"]')).not.toBeNull()
      // The header commands reach the viewer's registered controls.
      act(() => { buttons.find(b => b.textContent === 'Edit')!.click() })
      act(() => { header.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click() })
      expect(calls).toEqual(['mode:edit', 'save'])
    } finally {
      unmount()
    }
  })
})
