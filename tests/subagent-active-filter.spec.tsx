/**
 * Tasks active-only filter: enabled by default, settled rows stay out of the
 * tree, live descendant branches retain their ancestor context, and the
 * in-view switch restores the complete topology immediately.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SubagentView } from '../src/client/SubagentView.tsx'
import { api } from '../src/client/api.ts'
import type { SidebarStore } from '../src/client/state.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

function makeStore(initial: SidebarSessionList) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function makeCtx(list: ReturnType<typeof makeStore>): Context {
  return {
    sessions: {
      list,
      setSubagentCatalogOpen: () => {},
      openSubagent: () => {},
      open: () => {},
      refreshSubagents: async () => {},
    },
  } as unknown as Context
}

function snapshot(): SidebarSessionList {
  const catalog = (entries: NonNullable<SidebarSessionList['subagentsByParent']>[string]['entries']) => ({
    entries,
    parentAvailable: true,
    state: 'ready' as const,
    error: null,
  })
  const child = (id: string, activity: 'running' | 'inactive', hasChildren = false) => ({
    kind: 'child' as const,
    id,
    activity,
    hasChildren,
    mode: 'one-shot' as const,
  })
  return {
    current: 'root',
    byId: {
      root: { id: 'root', displayTitle: 'Main', running: true },
      active: { id: 'active', displayTitle: 'Active child', origin: 'subagent', parentId: 'root', running: true },
      done: { id: 'done', displayTitle: 'Completed child', origin: 'subagent', parentId: 'root', running: false },
      ancestor: { id: 'ancestor', displayTitle: 'Ancestor context', origin: 'subagent', parentId: 'root', running: false },
      nested: { id: 'nested', displayTitle: 'Nested active', origin: 'subagent', parentId: 'ancestor', running: true },
    },
    subagentsByParent: {
      root: catalog([
        child('active', 'running'),
        child('done', 'inactive'),
        child('ancestor', 'inactive', true),
      ]),
      ancestor: catalog([child('nested', 'running')]),
    },
    jobsBySession: {},
  }
}

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const element of document.querySelectorAll('body > div')) element.remove()
})

describe('SubagentView active-only filter', () => {
  it('defaults on and hides completed subagents while preserving active branches', () => {
    const list = makeStore(snapshot())
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: false, ctx: makeCtx(list) }),
    )

    const toggle = container.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.textContent).toContain('Active only')
    expect(container.textContent).toContain('Active child')
    expect(container.textContent).toContain('Nested active')
    expect(container.textContent).toContain('Ancestor context')
    expect(container.textContent).not.toContain('Completed child')
    unmount()
  })

  it('explains an empty filtered result instead of rendering a blank tree', () => {
    const settled = snapshot()
    settled.byId.active!.running = false
    settled.byId.nested!.running = false
    const rootEntries = settled.subagentsByParent!.root!.entries
    for (const entry of rootEntries) if (entry.kind === 'child') entry.activity = 'inactive'
    const nestedEntries = settled.subagentsByParent!.ancestor!.entries
    for (const entry of nestedEntries) if (entry.kind === 'child') entry.activity = 'inactive'
    const list = makeStore(settled)
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: false, ctx: makeCtx(list) }),
    )

    expect(container.textContent).not.toContain('Completed child')
    expect(container.textContent).toContain('Hide completed or inactive subagents')
    expect(container.textContent).toContain('4 subagents')
    unmount()
  })

  it('keeps the selected inactive subagent visible as navigation context', () => {
    const selected = snapshot()
    selected.current = 'done'
    const list = makeStore(selected)
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'done', active: false, ctx: makeCtx(list) }),
    )

    const row = Array.from(container.querySelectorAll('[role="treeitem"]')).find(
      element => element.textContent?.includes('Completed child') ?? false,
    )
    expect(row?.getAttribute('aria-current')).toBe('true')
    unmount()
  })

  it('honors a persisted opt-out from the shared sidebar settings', () => {
    const list = makeStore(snapshot())
    const sidebarStore = {
      getPrefs: () => ({
        ...SIDEBAR_PREFS_DEFAULTS,
        hideCompletedSubagents: false,
      }),
      subscribe: () => () => {},
    } as unknown as SidebarStore
    const { container, unmount } = mount(
      createElement(SubagentView, {
        sessionId: 'root', active: false, ctx: makeCtx(list), store: sidebarStore,
      }),
    )

    expect(container.querySelector('button[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('Completed child')
    unmount()
  })

  it('reveals completed subagents and persists the switch through shared settings', async () => {
    const list = makeStore(snapshot())
    const prefs = { ...SIDEBAR_PREFS_DEFAULTS }
    const setPrefs = vi.fn()
    const sidebarStore = {
      getPrefs: () => prefs,
      setPrefs,
      subscribe: () => () => {},
    } as unknown as SidebarStore
    const update = vi.spyOn(api, 'settingsUpdate').mockResolvedValue({
      value: { ...prefs, hideCompletedSubagents: false },
    })
    const { container, unmount } = mount(
      createElement(SubagentView, {
        sessionId: 'root', active: false, ctx: makeCtx(list), store: sidebarStore,
      }),
    )

    const toggle = container.querySelector('button[role="switch"]') as HTMLButtonElement
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('Completed child')
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ hideCompletedSubagents: false })
      expect(setPrefs).toHaveBeenCalledWith(expect.objectContaining({ hideCompletedSubagents: false }))
    })
    unmount()
  })
})
