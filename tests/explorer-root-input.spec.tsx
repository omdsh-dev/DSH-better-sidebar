/**
 * Explorer root-input tests: the header root label turns into an editable
 * path input. Entering a directory roots the tree at it, entering a file
 * roots at its parent directory, a failing resolve keeps the input open
 * with an error strip, and Escape/blur cancel without changes. The default
 * root is the session cwd; the override lives in the per-session state
 * (surviving tab switches, reset per conversation).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { ExplorerView } from '../src/client/ExplorerView.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'

const resolveCalls: Array<{ path: string; base: string }> = []
const treeCalls: string[] = []

/** Wire answers for the fs.resolve / fs.tree routes (the client api posts to
 *  /sidebar/api/<method> and expects { ok, value } / { ok, error }). */
let resolveAnswer: (payload: { path: string; base: string }) => { ok: boolean; value?: unknown; error?: { code: string; message: string } }
let treeEntries: Array<{ name: string; path: string; isDir: boolean; hidden: boolean }>

beforeEach(() => {
  resolveCalls.length = 0
  treeCalls.length = 0
  resolveAnswer = () => ({ ok: true, value: { path: '/srv/app', root: '/srv/app', isDir: true } })
  treeEntries = []
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (method === 'fs.resolve') {
      const payload = body as { path: string; base: string }
      resolveCalls.push({ path: payload.path, base: payload.base })
      return { ok: true, status: 200, json: async () => resolveAnswer(payload) } as unknown as Response
    }
    if (method === 'fs.tree') {
      treeCalls.push(String(body.path))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { path: body.path, entries: treeEntries, truncated: false } }),
      } as unknown as Response
    }
    throw new Error('unexpected fetch ' + String(url))
  })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'en', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

interface Mounted {
  container: HTMLDivElement
  store: SidebarStore
  unmount: () => void
}

function mount(): Mounted {
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  store.setSession('s1')
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(ExplorerView, {
      sessionId: 's1',
      cwd: '/home/work',
      store,
      expanded: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
    }))
  })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, store, unmount }
}

/** Flush the resolve promise chain (the stub fetch + response.json). */
async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

/** The root label button (aria-label 'Edit the explorer root', locale en). */
function rootLabelButton(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector('button[aria-label="Edit the explorer root"]')
  if (button === null) throw new Error('root label button not found')
  return button as HTMLButtonElement
}

function rootInput(container: HTMLDivElement): HTMLInputElement {
  const input = container.querySelector('input')
  if (input === null) throw new Error('root input not found')
  return input as HTMLInputElement
}

/** Type into the controlled input (jsdom has no user typing). */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressEnter(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('ExplorerView root input', () => {
  it('defaults the root to the session cwd (basename label, no input)', async () => {
    const { container, store, unmount } = mount()
    try {
      expect(container.textContent).toContain('work')
      expect(container.querySelector('input')).toBeNull()
      expect(treeCalls).toEqual(['/home/work'])
      expect(store.getSnapshot().state?.explorerRoot).toBeUndefined()
    } finally {
      unmount()
    }
  })

  it('clicking the label opens an input pre-filled with the full root path', () => {
    const { container, unmount } = mount()
    try {
      act(() => { rootLabelButton(container).click() })
      expect(rootInput(container).value).toBe('/home/work')
    } finally {
      unmount()
    }
  })

  it('entering a directory switches the root and reloads the tree from it', async () => {
    const { container, store, unmount } = mount()
    try {
      act(() => { rootLabelButton(container).click() })
      type(rootInput(container), '/srv/app')
      pressEnter(rootInput(container))
      await flush()
      expect(resolveCalls).toEqual([{ path: '/srv/app', base: '/home/work' }])
      expect(store.getSnapshot().state?.explorerRoot).toBe('/srv/app')
      expect(container.textContent).toContain('app')
      expect(container.querySelector('input')).toBeNull()
      expect(treeCalls).toContain('/srv/app')
    } finally {
      unmount()
    }
  })

  it('entering a file roots at its parent directory', async () => {
    const { container, store, unmount } = mount()
    try {
      resolveAnswer = () => ({ ok: true, value: { path: '/srv/app/readme.md', root: '/srv/app', isDir: false } })
      act(() => { rootLabelButton(container).click() })
      type(rootInput(container), '/srv/app/readme.md')
      pressEnter(rootInput(container))
      await flush()
      expect(store.getSnapshot().state?.explorerRoot).toBe('/srv/app')
      expect(container.textContent).toContain('app')
    } finally {
      unmount()
    }
  })

  it('resolves a relative input against the current root', async () => {
    const { container, store, unmount } = mount()
    try {
      resolveAnswer = (payload) => ({ ok: true, value: { path: payload.path, root: payload.base + '/sub', isDir: true } })
      act(() => { rootLabelButton(container).click() })
      type(rootInput(container), 'sub')
      pressEnter(rootInput(container))
      await flush()
      expect(resolveCalls).toEqual([{ path: 'sub', base: '/home/work' }])
      expect(store.getSnapshot().state?.explorerRoot).toBe('/home/work/sub')
    } finally {
      unmount()
    }
  })

  it('a failed resolve keeps the input open with the error strip and the root unchanged', async () => {
    const { container, store, unmount } = mount()
    try {
      resolveAnswer = () => ({ ok: false, error: { code: 'fs-error', message: 'cannot resolve /nope: ENOENT' } })
      act(() => { rootLabelButton(container).click() })
      type(rootInput(container), '/nope')
      pressEnter(rootInput(container))
      // While the resolve is in flight the input is readonly, NOT disabled:
      // disabling a focused input fires blur (the HTML focus-fixup rule),
      // which would cancel the edit in a real browser before the error
      // could keep it open.
      expect(rootInput(container).readOnly).toBe(true)
      expect(rootInput(container).disabled).toBe(false)
      await flush()
      expect(store.getSnapshot().state?.explorerRoot).toBeUndefined()
      expect(rootInput(container).value).toBe('/nope')
      const alert = container.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain('cannot resolve')
      // Fixing the input and resubmitting clears the error and switches.
      resolveAnswer = () => ({ ok: true, value: { path: '/srv/app', root: '/srv/app', isDir: true } })
      type(rootInput(container), '/srv/app')
      pressEnter(rootInput(container))
      await flush()
      expect(store.getSnapshot().state?.explorerRoot).toBe('/srv/app')
      expect(container.querySelector('[role="alert"]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('Escape cancels the edit without resolving', async () => {
    const { container, store, unmount } = mount()
    try {
      act(() => { rootLabelButton(container).click() })
      type(rootInput(container), '/srv/app')
      act(() => {
        rootInput(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await flush()
      expect(resolveCalls).toEqual([])
      expect(store.getSnapshot().state?.explorerRoot).toBeUndefined()
      expect(container.querySelector('input')).toBeNull()
      expect(container.textContent).toContain('work')
    } finally {
      unmount()
    }
  })

  it('blur cancels the edit without resolving', async () => {
    const { container, store, unmount } = mount()
    try {
      act(() => { rootLabelButton(container).click() })
      type(rootInput(container), '/srv/app')
      act(() => { rootInput(container).blur() })
      await flush()
      expect(resolveCalls).toEqual([])
      expect(store.getSnapshot().state?.explorerRoot).toBeUndefined()
      expect(container.querySelector('input')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('an empty submit just cancels the edit', async () => {
    const { container, store, unmount } = mount()
    try {
      act(() => { rootLabelButton(container).click() })
      type(rootInput(container), '   ')
      pressEnter(rootInput(container))
      await flush()
      expect(resolveCalls).toEqual([])
      expect(container.querySelector('input')).toBeNull()
      expect(store.getSnapshot().state?.explorerRoot).toBeUndefined()
    } finally {
      unmount()
    }
  })
})
