/**
 * The mounted public window host (S6): open/close through the service face,
 * the single host mount, in-surface navigation with page state retention,
 * titlebar back control, body-layout handoff, multi-window Escape/z-order,
 * focus restoration and viewport clamping.
 *
 * jsdom performs no layout, so geometry is asserted through the inline box the
 * shell writes (the same convention the FloatingWindow spec uses).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import type { WindowHostController } from '../src/client/windows/types.ts'
import { createCluesClientRegistry } from '../src/client/clues/registry.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

setupReactAct()

const VIEWPORT = { width: 1_000, height: 800 }

/** The portaled window frame by its accessible name. */
function frame(title: string): HTMLElement {
  const node = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
    .find(candidate => candidate.getAttribute('aria-label') === title)
  if (node === undefined) throw new Error(`no floating window titled "${title}"`)
  return node
}

function boxOf(title: string): { left: number; top: number; width: number; height: number } {
  const style = frame(title).style
  return {
    left: Number.parseFloat(style.left),
    top: Number.parseFloat(style.top),
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height),
  }
}

/** A stateful stub page: its input proves covered pages are never unmounted. */
function SearchPage(): ReactNode {
  const [query, setQuery] = useState('')
  return createElement('input', {
    'data-search': '',
    value: query,
    onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

let host: WindowHostController | undefined
let mounted: RenderedRoot | undefined

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  host?.dispose()
  host = undefined
  document.body.innerHTML = ''
})

function mountHost(viewport = VIEWPORT): WindowHostController {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.height })
  host = createWindowHost({ viewport: () => viewport })
  const formats = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)
  mounted = renderRoot(createElement(WindowHost, { host, formats }))
  return host
}

describe('WindowHost: open / close / focus', () => {
  it('renders an opened window with the requested preset and closes it through the handle', async () => {
    const controller = mountHost()
    let handle!: ReturnType<WindowHostController['open']>
    act(() => {
      handle = controller.open({
        id: 'doc:1', title: 'Doc', size: 'document', content: createElement('p', null, 'hello'),
      })
    })
    expect(document.querySelectorAll('[data-floating-window]')).toHaveLength(1)
    expect(boxOf('Doc')).toEqual({ left: 60, top: 80, width: 880, height: 640 })
    expect(frame('Doc').textContent).toContain('hello')
    await act(async () => { await handle.close() })
    expect(document.querySelectorAll('[data-floating-window]')).toHaveLength(0)
  })

  it('keeps the reader placement across content updates and restores focus to the opener on close', async () => {
    const controller = mountHost()
    const opener = document.createElement('button')
    opener.textContent = 'open'
    document.body.append(opener)
    opener.focus()
    let handle!: ReturnType<WindowHostController['open']>
    act(() => { handle = controller.open({ id: 'stream', title: 'Stream', content: 'line 1' }) })
    const placed = boxOf('Stream')
    act(() => { handle.update({ content: 'line 2', dirty: true }) })
    expect(boxOf('Stream')).toEqual(placed)
    expect(frame('Stream').querySelector('[data-window-dirty]')).not.toBeNull()
    expect(frame('Stream').querySelector('[data-window-saving]')).toBeNull()
    await act(async () => { await handle.close() })
    expect(document.activeElement).toBe(opener)
  })

  it('raises the focused window above a newer one', () => {
    const controller = mountHost()
    let first!: ReturnType<WindowHostController['open']>
    act(() => {
      first = controller.open({ id: 'a', title: 'A', content: 'a' })
      controller.open({ id: 'b', title: 'B', content: 'b' })
    })
    expect(Number(frame('B').style.zIndex)).toBeGreaterThan(Number(frame('A').style.zIndex))
    act(() => { first.focus() })
    expect(Number(frame('A').style.zIndex)).toBeGreaterThan(Number(frame('B').style.zIndex))
  })

  it('closes only the top window on Escape (the lower one and its draft survive)', async () => {
    const controller = mountHost()
    act(() => {
      controller.open({ id: 'a', title: 'A', content: 'a' })
      controller.open({ id: 'b', title: 'B', content: 'b' })
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(document.querySelectorAll('[data-floating-window]')).toHaveLength(1)
    expect(frame('A')).toBeDefined()
    expect(controller.getSnapshot().windows).toHaveLength(1)
  })

  it('uses the near-fullscreen form on a 390px viewport and keeps every control reachable', () => {
    mounted?.unmount()
    host?.dispose()
    const controller = mountHost({ width: 390, height: 844 })
    act(() => {
      controller.open({ id: 'phone', title: 'Phone', size: 'document', content: 'x' })
    })
    expect(boxOf('Phone')).toEqual({ left: 8, top: 8, width: 374, height: 828 })
    // Title bar identity/navigation/window controls stay on screen.
    expect(frame('Phone').querySelector('button[aria-label="关闭"]')).not.toBeNull()
    expect(frame('Phone').querySelector('button[aria-label="最大化"]')).not.toBeNull()
    expect(frame('Phone').querySelector('[data-window-handle]')?.textContent).toContain('Phone')
  })

  it('re-clamps every window after a viewport shrink', () => {
    const controller = mountHost()
    act(() => { controller.open({ id: 'clamp', title: 'Clamp', content: 'x' }) })
    act(() => { controller.setViewport({ width: 500, height: 400 }) })
    expect(boxOf('Clamp')).toEqual({ left: 8, top: 8, width: 484, height: 384 })
  })
})

describe('WindowHost: in-surface navigation', () => {
  it('pushes/pops pages, follows the page title and preserves covered page state', () => {
    const controller = mountHost()
    let handle!: ReturnType<WindowHostController['open']>
    act(() => {
      handle = controller.open({
        id: 'pack:1', title: 'Pack manager', content: createElement(SearchPage),
      })
    })
    const input = frame('Pack manager').querySelector('[data-search]') as HTMLInputElement
    act(() => { typeInto(input, 'velocity') })
    expect(input.value).toBe('velocity')

    act(() => {
      handle.navigation.push({
        title: 'Add members',
        content: createElement('div', null, 'picker'),
        bodyLayout: 'fill',
      })
    })
    expect(frame('Add members').textContent).toContain('picker')
    expect(frame('Add members').querySelector('[data-window-body]')?.getAttribute('data-window-body-layout')).toBe('fill')
    const pages = [...frame('Add members').querySelectorAll('[data-window-page]')]
    expect(pages).toHaveLength(2)
    const covered = pages[0] as HTMLElement
    expect(covered.getAttribute('data-window-page')).toBe('hidden')
    // The covered page is still mounted (its input is the same node and keeps
    // the text), only hidden by CSS.
    expect(covered.querySelector('[data-search]')).toBe(input)
    expect((covered.querySelector('[data-search]') as HTMLInputElement).value).toBe('velocity')

    const back = frame('Add members').querySelector('button[aria-label="返回"]') as HTMLButtonElement
    expect(back).not.toBeNull()
    act(() => { back.click() })
    expect(frame('Pack manager')).toBeDefined()
    const restored = frame('Pack manager').querySelector('[data-search]') as HTMLInputElement
    expect(restored).toBe(input)
    expect(restored.value).toBe('velocity')
    expect(frame('Pack manager').querySelector('[data-window-body]')?.getAttribute('data-window-body-layout')).toBe('scroll')
    expect(frame('Pack manager').querySelector('button[aria-label="返回"]')).toBeNull()
  })

  it('shows the explicit read-only fallback for a format without a renderer', () => {
    const controller = mountHost()
    act(() => {
      controller.open({
        id: 'unknown', title: 'Unknown', content: {
        kind: 'document',
        sourceId: 'test.docs',
        typeId: 'test.docs.blocks',
        format: 'application/x-test-blocks',
        document: {
          format: 'application/x-test-blocks',
          data: { blocks: [{ kind: 'heading', text: 'raw, not markdown' }] },
        },
        },
      })
    })
    const fallback = frame('Unknown').querySelector('[data-window-unknown-format]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(fallback.querySelector('[data-window-read-only]')).not.toBeNull()
    expect(fallback.querySelector('[data-window-raw]')?.textContent).toContain('"kind": "heading"')
  })
})
