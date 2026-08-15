/**
 * Lazy wrapper tests (src/client/lazy-chunk.tsx): the wrapper that mounts
 * chunk-resident components from the built-in descriptors. Pins the two
 * contracts that matter for the descriptor API:
 * - the wrapper is a plain render-prop function — `component(props)` can be
 *   called directly (Sidebar's style) without a chunk registered and
 *   without throwing; hooks live in the inner component only,
 * - loading → placeholder, failure → error + retry that recovers, success →
 *   the chunk component rendered.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import { builtinViewers } from '../src/client/builtins/viewers.tsx'
import { registerChunkForTests, resetChunks } from '../src/client/chunk-loader.ts'
import { lazyChunkComponent } from '../src/client/lazy-chunk.tsx'
import type { Context } from '../src/context-types.ts'
import type { FileViewerProps, TabComponentProps } from '../src/client/service.ts'
import css from '../src/client/sidebar.module.css'

/** Render `node` into a detached body container under React's act(). */
function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  // act() flushes the (concurrent) initial commit — the placeholder must be
  // in the DOM before the async load flushes below.
  act(() => { root.render(node) })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, unmount }
}

const Marker = (): ReactNode => createElement('div', { 'data-testid': 'chunk-rendered' }, 'loaded')

beforeEach(() => {
  resetChunks()
})

afterEach(() => {
  // Defensive: drop any containers left by failed assertions.
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('lazyChunkComponent', () => {
  it('renders the loading placeholder first, then the chunk component', async () => {
    let calls = 0
    registerChunkForTests('editor', async () => {
      calls += 1
      return { TextEditor: Marker }
    })
    const Wrapper = lazyChunkComponent<{ label: string }>('editor', (mod) => mod.TextEditor as ComponentType<{ label: string }> | undefined)
    const { container, unmount } = mount(createElement(Wrapper, { label: 'x' }))
    // Initial paint: the loading placeholder (no chunk loaded yet).
    expect(container.querySelector(`.${css.editorPlaceholder}`)).not.toBeNull()
    await act(async () => {})
    expect(container.querySelector('[data-testid="chunk-rendered"]')).not.toBeNull()
    expect(container.textContent).toContain('loaded')
    expect(calls).toBe(1)
    unmount()
  })

  it('shows the failure reason with a retry that recovers', async () => {
    let fail = true
    registerChunkForTests('editor', async () => {
      if (fail) throw new Error('boom')
      return { TextEditor: Marker }
    })
    const Wrapper = lazyChunkComponent<Record<string, never>>('editor', (mod) => mod.TextEditor as ComponentType<Record<string, never>> | undefined)
    const { container, unmount } = mount(createElement(Wrapper, {}))
    await act(async () => {})
    expect(container.textContent).toContain('boom')
    // The failed load cleared the loader cache; retry now succeeds.
    fail = false
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    await act(async () => { button!.click() })
    await act(async () => {})
    expect(container.querySelector('[data-testid="chunk-rendered"]')).not.toBeNull()
    unmount()
  })

  it('props flow through to the chunk component', async () => {
    const Recorder = (props: { label: string }): ReactNode => createElement('div', { 'data-testid': 'rec', 'data-label': props.label })
    registerChunkForTests('terminal', async () => ({ TerminalView: Recorder }))
    const Wrapper = lazyChunkComponent<{ label: string }>('terminal', (mod) => mod.TerminalView as ComponentType<{ label: string }> | undefined)
    const { container, unmount } = mount(createElement(Wrapper, { label: 'hello' }))
    await act(async () => {})
    expect(container.querySelector('[data-testid="rec"]')?.getAttribute('data-label')).toBe('hello')
    unmount()
  })
})

describe('built-in descriptor contract (render-prop functions)', () => {
  it('every heavy built-in viewer component is callable as a plain function without a chunk (returns an element)', () => {
    const viewers = builtinViewers()
    for (const id of ['markdown', 'html', 'code']) {
      const descriptor = viewers.find(viewer => viewer.id === id)
      expect(descriptor, id).toBeDefined()
      // No chunk registered: calling must not throw — it returns the lazy
      // element (the loading placeholder renders once mounted).
      expect(() => descriptor!.component({} as FileViewerProps), id).not.toThrow()
    }
  })

  it('the terminal tab component keeps the same contract', () => {
    const tabs = builtinTabs({} as Context)
    const terminal = tabs.find(tab => tab.id === 'terminal')
    expect(terminal).toBeDefined()
    // The descriptor reads tab.id (the tabId mapping); a real tab is part of
    // the contract — Sidebar always provides one.
    const props = { tab: { id: 'terminal:1', type: 'terminal', title: '终端 1' } } as unknown as TabComponentProps
    expect(() => terminal!.component(props)).not.toThrow()
  })

  it('a built-in viewer mounted without a chunk available degrades to the error + retry affordance (no crash)', async () => {
    // No test chunk registered and jsdom has no client module system: the
    // load fails and the wrapper must degrade gracefully, never throw.
    const viewers = builtinViewers()
    const code = viewers.find(viewer => viewer.id === 'code')!
    const { container, unmount } = mount(createElement(code.component, {} as FileViewerProps))
    await act(async () => {})
    expect(container.querySelector(`.${css.editorError}`)).not.toBeNull()
    expect(container.querySelector('button')).not.toBeNull()
    unmount()
  })

  it('a registered chunk makes the built-in viewer render through the real descriptor path', async () => {
    registerChunkForTests('editor', async () => ({ TextEditor: Marker }))
    const viewers = builtinViewers()
    const markdown = viewers.find(viewer => viewer.id === 'markdown')!
    // EditorHost renders viewer components via createElement(component, props).
    const { container, unmount } = mount(createElement(markdown.component, {
      ctx: {},
      store: undefined,
      scope: { sessionId: 's1', cwd: '/p' },
      path: '/p/a.md',
      title: 'a.md',
      viewerId: 'markdown',
    } as unknown as FileViewerProps))
    await act(async () => {})
    expect(container.querySelector('[data-testid="chunk-rendered"]')).not.toBeNull()
    unmount()
  })

  it('the terminal descriptor maps tab.id → tabId (TerminalView props are not TabComponentProps)', async () => {
    let received: unknown
    registerChunkForTests('terminal', async () => ({
      TerminalView: ((props: { tabId: string }) => {
        received = props.tabId
        return createElement('div', { 'data-testid': 'terminal-tabid' }, props.tabId)
      }) as unknown as ComponentType<Record<string, never>>,
    }))
    const tabs = builtinTabs({} as Context)
    const terminal = tabs.find(tab => tab.id === 'terminal')!
    const props = {
      ctx: {},
      store: undefined,
      scope: { sessionId: 's1', cwd: '/p' },
      tab: { id: 'terminal:2', type: 'terminal', title: '终端 2' },
      visible: true,
    } as unknown as TabComponentProps
    const { container, unmount } = mount(createElement(terminal.component, props))
    await act(async () => {})
    expect(container.querySelector('[data-testid="terminal-tabid"]')?.textContent).toBe('terminal:2')
    expect(received).toBe('terminal:2')
    unmount()
  })

  it('the loader cache survives across descriptor mounts (chunk fetched once)', async () => {
    let calls = 0
    registerChunkForTests('terminal', async () => {
      calls += 1
      return { TerminalView: Marker }
    })
    const tabs = builtinTabs({} as Context)
    const terminal = tabs.find(tab => tab.id === 'terminal')!
    const props = { tab: { id: 'terminal:1', type: 'terminal', title: '终端 1' } } as unknown as TabComponentProps
    const { container: first, unmount: unmountFirst } = mount(createElement(terminal.component, props))
    await act(async () => {})
    expect(first.querySelector('[data-testid="chunk-rendered"]')).not.toBeNull()
    unmountFirst()
    const { container: second, unmount: unmountSecond } = mount(createElement(terminal.component, props))
    await act(async () => {})
    expect(second.querySelector('[data-testid="chunk-rendered"]')).not.toBeNull()
    unmountSecond()
    expect(calls).toBe(1)
  })
})
