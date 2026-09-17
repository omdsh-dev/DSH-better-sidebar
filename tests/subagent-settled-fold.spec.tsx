/**
 * Subagent page tests for the settled-children fold: children that are no
 * longer running collapse into one disclosure at the bottom of their level, the
 * header still counts the whole tree, expanding restores catalog order, and the
 * session the user currently has open stays visible inside the fold.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

setupReactAct()

/** A subscribable sessions-list snapshot (mirror of the runtime list feed). */
function makeStore(initial: SidebarSessionList) {
  const snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

type Store = ReturnType<typeof makeStore>

/** The client context face SubagentView touches (everything else inert). */
function makeCtx(store: Store): Context {
  return {
    sessions: {
      list: store,
      setSubagentCatalogOpen: () => {},
      openSubagent: () => {},
      open: () => {},
      refreshSubagents: async () => {},
    },
    connection: {
      api: {
        subagents: {
          history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
        },
      },
    },
  } as unknown as Context
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** Root catalog: one running child between two settled ones, in catalog order. */
function foldSnapshot(): SidebarSessionList {
  return {
    current: 'root',
    byId: {
      root: { id: 'root', displayTitle: '主会话' },
      'done-b': { id: 'done-b', displayTitle: '子代理 B', origin: 'subagent', parentId: 'root', running: false },
      'run-a': { id: 'run-a', displayTitle: '子代理 A', origin: 'subagent', parentId: 'root', running: true },
      'done-c': { id: 'done-c', displayTitle: '子代理 C', origin: 'subagent', parentId: 'root', running: false },
    },
    subagentsByParent: {
      root: {
        state: 'ready',
        parentAvailable: true,
        error: null,
        entries: [
          { kind: 'child', id: 'done-b', activity: 'inactive', hasChildren: false, mode: 'continuable', label: '任务 B' },
          { kind: 'child', id: 'run-a', activity: 'running', hasChildren: false, mode: 'continuable', label: '任务 A' },
          { kind: 'child', id: 'done-c', activity: 'inactive', hasChildren: false, mode: 'continuable', label: '任务 C' },
        ],
      },
    },
    jobsBySession: {},
  }
}

/** The one disclosure row; the panel's other buttons carry no aria-expanded. */
function foldToggle(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button[aria-expanded]')
  if (button === null) throw new Error('the settled-children toggle did not render')
  return button as HTMLButtonElement
}

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    const method = String(url).split('/').pop()
    if (method === 'subagents.live') return jsonResponse({ ok: true, value: { live: {} } })
    throw new Error(`unexpected fetch ${String(url)}`)
  })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('SubagentView settled-children fold', () => {
  it('folds settled children away and keeps running ones in place', () => {
    const store = makeStore(foldSnapshot())
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const text = container.textContent ?? ''
    // The header still counts the whole tree…
    expect(text).toContain('3 个子代理 · 1 运行中')
    // …the running child renders in its catalog position…
    expect(text).toContain('任务 A')
    // …and both settled children collapse into one labeled disclosure.
    expect(text).not.toContain('任务 B')
    expect(text).not.toContain('任务 C')
    expect(text).toContain('已完成的子代理 (2)')
    expect(foldToggle(container).getAttribute('aria-expanded')).toBe('false')
    unmount()
  })

  it('expands back to catalog order and collapses again', async () => {
    const store = makeStore(foldSnapshot())
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { foldToggle(container).click() })
    const expanded = container.textContent ?? ''
    expect(expanded).toContain('任务 B')
    expect(expanded).toContain('任务 A')
    expect(expanded).toContain('任务 C')
    expect(foldToggle(container).getAttribute('aria-expanded')).toBe('true')
    // Catalog order is preserved: B was created before A before C.
    expect(expanded.indexOf('任务 B')).toBeLessThan(expanded.indexOf('任务 A'))
    expect(expanded.indexOf('任务 A')).toBeLessThan(expanded.indexOf('任务 C'))

    await act(async () => { foldToggle(container).click() })
    const collapsed = container.textContent ?? ''
    expect(collapsed).not.toContain('任务 B')
    expect(collapsed).toContain('任务 A')
    unmount()
  })

  it('keeps the session currently open visible while it is settled', () => {
    const store = makeStore(foldSnapshot())
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'done-b', active: true, ctx: makeCtx(store) }),
    )
    const text = container.textContent ?? ''
    // The open session is the settled child B: it stays visible, only C folds.
    expect(text).toContain('任务 B')
    expect(text).not.toContain('任务 C')
    expect(text).toContain('已完成的子代理 (1)')
    unmount()
  })
})