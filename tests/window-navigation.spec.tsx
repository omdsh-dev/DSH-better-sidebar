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

/** Dispatch one pointer event with coordinates (jsdom has no real pointer). */
function pointer(target: EventTarget, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  target.dispatchEvent(event)
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

  it('wires the title bar gestures and window controls to the host store', () => {
    const controller = mountHost()
    let handle!: ReturnType<WindowHostController['open']>
    act(() => { handle = controller.open({ id: 'gesture', title: 'Gesture', content: 'x' }) })
    const placed = boxOf('Gesture')

    // Drag by the title bar: the store owns the box, the shell reports the move.
    act(() => {
      pointer(frame('Gesture').querySelector('[data-window-handle]')!, 'pointerdown', 300, 100)
      pointer(window, 'pointermove', 340, 130)
      pointer(window, 'pointerup', 340, 130)
    })
    expect(boxOf('Gesture')).toEqual({
      left: placed.left + 40, top: placed.top + 30, width: placed.width, height: placed.height,
    })
    expect(controller.getSnapshot().windows[0]!.box).toEqual(boxOf('Gesture'))

    // Maximize through the control; restore brings the same box back.
    const maximize = frame('Gesture').querySelector('[data-window-maximize]') as HTMLButtonElement
    act(() => { maximize.click() })
    expect(boxOf('Gesture')).toEqual({ left: 0, top: 0, width: 1_000, height: 800 })
    expect(controller.getSnapshot().windows[0]!.maximized).toBe(true)
    const restore = frame('Gesture').querySelector('[data-window-maximize]') as HTMLButtonElement
    expect(restore.getAttribute('data-window-maximize')).toBe('restore')
    act(() => { restore.click() })
    expect(controller.getSnapshot().windows[0]!.maximized).toBe(false)
    expect(boxOf('Gesture')).toEqual({
      left: placed.left + 40, top: placed.top + 30, width: placed.width, height: placed.height,
    })
    void handle
  })

  it('honours a caller minSize below the 320×240 legacy floor', () => {
    const controller = mountHost()
    act(() => {
      controller.open({
        id: 'small-floor', title: 'Small floor', content: 'x', minSize: { width: 280, height: 200 },
      })
    })
    const corner = frame('Small floor').querySelector('[data-window-resize="both"]') as HTMLElement
    act(() => {
      pointer(corner, 'pointerdown', 0, 0)
      pointer(corner, 'pointermove', -5_000, -5_000)
      pointer(corner, 'pointerup', -5_000, -5_000)
    })
    expect(boxOf('Small floor').width).toBe(280)
    expect(boxOf('Small floor').height).toBe(200)
  })

  it('restores to the re-clamped box after a maximize + viewport shrink', () => {
    const controller = mountHost()
    act(() => { controller.open({ id: 'restore', title: 'Restore', content: 'x' }) })
    act(() => { (frame('Restore').querySelector('[data-window-maximize]') as HTMLButtonElement).click() })
    act(() => { controller.setViewport({ width: 500, height: 400 }) })
    expect(boxOf('Restore')).toEqual({ left: 0, top: 0, width: 500, height: 400 })
    act(() => { (frame('Restore').querySelector('[data-window-maximize]') as HTMLButtonElement).click() })
    expect(boxOf('Restore')).toEqual({ left: 8, top: 8, width: 484, height: 384 })
    expect(controller.getSnapshot().windows[0]!.maximized).toBe(false)
  })

  it('keeps the window chrome reachable for a long title and a long action row', () => {
    const controller = mountHost()
    const title = `clue:${'very-long-identity-'.repeat(24)}`
    const actions = Array.from({ length: 8 }, (_, index) => createElement('button', {
      key: index, type: 'button', 'data-long-action': String(index),
    }, `action ${index}`))
    act(() => {
      controller.open({ id: 'long', title, content: 'body', actions: createElement('div', null, ...actions) })
    })
    const node = frame(title)
    const titleNode = [...node.querySelectorAll<HTMLElement>('[data-window-handle] span')]
      .find(candidate => candidate.getAttribute('title') === title)
    expect(titleNode?.textContent).toBe(title)
    expect(node.querySelector('button[aria-label="关闭"]')).not.toBeNull()
    expect(node.querySelector('button[aria-label="最大化"]')).not.toBeNull()
    const toolbar = node.querySelector('[data-window-toolbar]') as HTMLElement
    expect(toolbar.textContent).toContain('action 7')
    expect([...toolbar.querySelectorAll('[data-long-action]')]).toHaveLength(8)
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

  it('uses the near-fullscreen form on a 320px viewport (host path)', () => {
    mounted?.unmount()
    host?.dispose()
    const controller = mountHost({ width: 320, height: 568 })
    act(() => { controller.open({ id: 'phone', title: 'Phone 320', content: 'x' }) })
    expect(boxOf('Phone 320')).toEqual({ left: 8, top: 8, width: 304, height: 552 })
    expect(frame('Phone 320').querySelector('button[aria-label="关闭"]')).not.toBeNull()
  })

  it('honours an explicit initialSize on a narrow viewport (clamped, not near-fullscreen)', () => {
    mounted?.unmount()
    host?.dispose()
    const controller = mountHost({ width: 390, height: 844 })
    act(() => {
      controller.open({
        id: 'explicit', title: 'Explicit', content: 'x', initialSize: { width: 700, height: 600 },
      })
    })
    expect(boxOf('Explicit')).toEqual({ left: 8, top: 122, width: 374, height: 600 })
  })

  it('does not overwrite an injected viewport with the mounted window metrics', () => {
    // The browser viewport is narrow; the injected one is a desktop seam.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    host = createWindowHost({ viewport: () => VIEWPORT })
    const formats = createCluesClientRegistry(() => SIDEBAR_PREFS_DEFAULTS)
    mounted = renderRoot(createElement(WindowHost, { host, formats }))
    act(() => { host!.open({ id: 'injected', title: 'Injected', content: 'x' }) })
    expect(boxOf('Injected')).toEqual({ left: 140, top: 120, width: 720, height: 560 })
  })

  it('ignores Escape while an IME composition is active, then closes on a plain Escape', () => {
    const controller = mountHost()
    let guard = 0
    act(() => {
      controller.open({
        id: 'ime', title: 'Ime', content: 'x', onBeforeClose: () => { guard += 1; return false },
      })
    })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    })
    // The composition key never reaches the window (and never runs the guard).
    expect(document.querySelectorAll('[data-floating-window]')).toHaveLength(1)
    expect(guard).toBe(0)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    // A plain Escape DOES run the draft guard (which refuses here).
    expect(guard).toBe(1)
    expect(document.querySelectorAll('[data-floating-window]')).toHaveLength(1)
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
