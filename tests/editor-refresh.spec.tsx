/**
 * EditorHost refresh behaviors (issue #167): the manual refresh button
 * re-runs the load (A), returning from edit to preview reloads unless the
 * draft is dirty or the save failed (B), and a preview-mode save reloads on
 * the 'saved' edge (C). A mock viewer reports a hoisted toolbar so the host
 * chrome renders exactly like the real text editor.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const fsRead = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: { fsRead: (...args: unknown[]) => fsRead(...args) },
  mediaUrl: () => '',
}))

/** One fsRead call counter reset per test. */
function reads(): number {
  return fsRead.mock.calls.length
}

interface MockViewerProps {
  initialMode?: 'preview' | 'edit'
  dirty?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onToolbarState?: (state: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onToolbarControls?: (controls: any) => void
}

/** A viewer that hoists a real toolbar (mode toggle + save state). */
function MockTextViewer({ initialMode = 'preview', dirty = false, onToolbarState, onToolbarControls }: MockViewerProps) {
  const [mode, setMode] = useState(initialMode)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  useEffect(() => {
    onToolbarState?.({ modes: true, mode, dirty, editable: true, saveState })
  }, [mode, saveState, dirty, onToolbarState])
  useEffect(() => {
    onToolbarControls?.({
      setMode,
      // A synchronous save (saving then saved in one batch) drives the edge.
      save: () => { setSaveState('saving'); setSaveState('saved') },
    })
    return () => { onToolbarControls?.(null) }
  }, [onToolbarControls])
  return createElement('div', null, `mock-${mode}`)
}

function setup(initialMode: 'preview' | 'edit' = 'preview', dirty = false): {
  ctx: Context
  fileTab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'mock-text',
    exts: ['ts'],
    priority: 0,
    fetchStrategy: 'fsRead',
    component: (props: FileViewerProps) => createElement(MockTextViewer, {
      initialMode,
      dirty,
      onToolbarState: props.onToolbarState,
      onToolbarControls: props.onToolbarControls,
    }),
  })
  store.setSession('editor-home-session')
  const sessionsSnapshot = { byId: { 'editor-home-session': { cwd: '/tmp' } }, current: 'editor-home-session' }
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  ctx.betterSidebar.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
  const fileTab = (): SidebarTab =>
    allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.path === '/tmp/a.ts')!
  return { ctx, fileTab }
}

function mount(ctx: Context, tab: () => SidebarTab): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(EditorHost, {
      ctx, store: ctx.betterSidebar as never, scope: { sessionId: 'editor-home-session' },
      tab: tab(), expanded: [], onToggleDir: () => {}, onReferenceFile: () => {},
    }))
  })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** The header's refresh button (locale-dependent aria-label), or null. */
function refreshButton(container: HTMLDivElement): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Refresh"], button[aria-label="刷新"]')
}

function click(button: HTMLButtonElement): void {
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  fsRead.mockReset()
  fsRead.mockResolvedValue({ kind: 'text', content: 'hello', truncated: false })
})

describe('EditorHost refresh (issue #167)', () => {
  it('A: the refresh button renders for a toolbar-reporting viewer and re-runs the load', async () => {
    const { ctx, fileTab } = setup()
    const { container, unmount } = mount(ctx, fileTab)
    try {
      // The initial load ran once; settle the async fsRead.
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(1)
      const refresh = refreshButton(container)
      expect(refresh).not.toBeNull()
      click(refresh!)
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(2)
    } finally {
      unmount()
    }
  })

  it('B: returning from edit to preview reloads (fresh content shows after save)', async () => {
    const { ctx, fileTab } = setup('edit')
    const { container, unmount } = mount(ctx, fileTab)
    try {
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(1)
      const preview = Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Preview')!
      click(preview)
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(2)
    } finally {
      unmount()
    }
  })

  it('B: a dirty draft suppresses the edit→preview reload (the draft would be dropped)', async () => {
    const { ctx, fileTab } = setup('edit', true)
    const { container, unmount } = mount(ctx, fileTab)
    try {
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(1)
      const preview = Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Preview')!
      click(preview)
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(1)
    } finally {
      unmount()
    }
  })

  it('C: a preview-mode save reloads on the saved edge', async () => {
    const { ctx, fileTab } = setup('preview')
    const { container, unmount } = mount(ctx, fileTab)
    try {
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(1)
      const save = container.querySelector('button[aria-label="Save"]') as HTMLButtonElement
      click(save)
      await act(async () => { await Promise.resolve() })
      expect(reads()).toBe(2)
    } finally {
      unmount()
    }
  })
})
