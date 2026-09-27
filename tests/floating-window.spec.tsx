/**
 * The persistent floating window (FloatingWindow.tsx): its dismissal contract
 * (close button + Escape ONLY — no outside click, no blur, no anchor
 * observer), its two gestures (title-bar drag, edge/corner resize with a
 * floor), and the bounded scrolling body that makes a long job output
 * readable.
 *
 * jsdom has no layout engine, so geometry is asserted through the element's
 * inline box (which the component writes) and through pointer-event maths —
 * the real pixels are covered by the mount lane and the 3080 self-check.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef, type RefObject } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { FloatingWindow } from '../src/client/FloatingWindow.tsx'

setupReactAct()

/** The portaled window element. */
function frame(): HTMLElement {
  const node = document.querySelector('[data-floating-window]')
  if (node === null) throw new Error('no floating window rendered')
  return node as HTMLElement
}

/** The inline box the component wrote (jsdom performs no layout). */
function box(): { left: number; top: number; width: number; height: number } {
  const style = frame().style
  return {
    left: Number.parseFloat(style.left),
    top: Number.parseFloat(style.top),
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height),
  }
}

/** Dispatch one pointer event with coordinates. */
function pointer(target: EventTarget, type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    clientX?: number; clientY?: number; button?: number; pointerId?: number
  }
  Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId: 1 })
  target.dispatchEvent(event)
}

let closed = 0

beforeEach(() => {
  closed = 0
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_000 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  // The chrome's copy is localized: pin the language so the close button's
  // accessible name is the zh one (the other specs do the same).
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

/** Render one window (plus an optional anchor) and return its controls. */
function renderWindow(props: {
  anchor?: HTMLElement | null
  bodyRef?: RefObject<HTMLDivElement>
  footer?: boolean
  actions?: boolean
} = {}) {
  const rendered = renderRoot(createElement(FloatingWindow, {
    title: 'bash-1',
    onClose: () => { closed += 1 },
    ...(props.anchor === undefined ? {} : { anchor: props.anchor }),
    ...(props.bodyRef === undefined ? {} : { bodyRef: props.bodyRef }),
    ...(props.footer === true ? { footer: createElement('button', { type: 'button' }, 'stop') } : {}),
    ...(props.actions === true ? { actions: createElement('button', { type: 'button' }, 'copy') } : {}),
    children: createElement('div', null, 'line 1'),
  }))
  return rendered
}

describe('FloatingWindow frame', () => {
  it('renders the title, the actions, the footer and a scrollable body', () => {
    const bodyRef = createRef<HTMLDivElement>()
    const { unmount } = renderWindow({ actions: true, footer: true, bodyRef })
    expect(frame().getAttribute('role')).toBe('dialog')
    expect(frame().getAttribute('aria-label')).toBe('bash-1')
    expect(frame().textContent).toContain('bash-1')
    expect(frame().querySelector('[data-window-handle]')).not.toBeNull()
    expect(frame().querySelector('[data-window-body]')).not.toBeNull()
    expect(frame().querySelector('[data-window-footer]')).not.toBeNull()
    // The caller's follow-tail hook receives the real scroll container.
    expect(bodyRef.current).toBe(frame().querySelector('[data-window-body]'))
    unmount()
  })

  it('sizes itself from the viewport and centres without an anchor', () => {
    const { unmount } = renderWindow()
    const current = box()
    // 70% × 60% of 1000 × 800.
    expect(current.width).toBe(700)
    expect(current.height).toBe(480)
    expect(current.left).toBe(150)
    unmount()
  })

  it('opens next to its anchor, clamped into the viewport', () => {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    anchor.getBoundingClientRect = () => ({
      left: 940, top: 700, right: 990, bottom: 720, width: 50, height: 20,
      x: 940, y: 700, toJSON: () => ({}),
    }) as DOMRect
    const { unmount } = renderWindow({ anchor })
    const current = box()
    // The right edge would overflow: the window is pulled back inside.
    expect(current.left + current.width).toBeLessThanOrEqual(1_000 - 8 + 1)
    expect(current.top).toBeGreaterThan(0)
    expect(current.top).toBeLessThan(800)
    unmount()
  })
})

describe('FloatingWindow dismissal', () => {
  it('closes on the close button and on Escape', () => {
    const { unmount } = renderWindow()
    const close = frame().querySelector('button[aria-label="关闭"]') as HTMLButtonElement
    expect(close).not.toBeNull()
    act(() => { close.click() })
    expect(closed).toBe(1)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closed).toBe(2)
    unmount()
  })

  it('is PERSISTENT: an outside click, a window blur and an anchor observer never close it', () => {
    const observed: Element[] = []
    vi.stubGlobal('IntersectionObserver', class {
      observe(target: Element): void { observed.push(target) }
      disconnect(): void {}
    })
    const anchor = document.createElement('button')
    document.body.append(anchor)
    const { unmount } = renderWindow({ anchor })
    // An outside mousedown: the popover contract would close here.
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    act(() => { window.dispatchEvent(new Event('blur')) })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(closed).toBe(0)
    // No anchor observer is even registered (the window outlives its opener).
    expect(observed).toEqual([])
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()
    unmount()
  })
})

describe('FloatingWindow gestures', () => {
  it('drags by the title bar and keeps the whole window on screen', () => {
    const { unmount } = renderWindow()
    const handle = frame().querySelector('[data-window-handle]') as HTMLElement
    const before = box()
    act(() => {
      pointer(handle, 'pointerdown', 500, 100)
      pointer(window, 'pointermove', 420, 160)
      pointer(window, 'pointerup', 420, 160)
    })
    const moved = box()
    expect(moved.left).toBe(before.left - 80)
    expect(moved.top).toBe(before.top + 60)
    expect(moved.width).toBe(before.width)
    // A wild drag cannot hide the window (nor its resize corner): it parks in
    // the viewport's corner instead of hanging off an edge.
    act(() => {
      pointer(handle, 'pointerdown', 420, 160)
      pointer(window, 'pointermove', -5_000, -5_000)
      pointer(window, 'pointerup', -5_000, -5_000)
    })
    expect(box().top).toBe(8)
    expect(box().left).toBe(8)
    // …and the far corner of the box stays inside the viewport.
    expect(box().left + box().width).toBeLessThanOrEqual(1_000 - 8)
    expect(box().top + box().height).toBeLessThanOrEqual(800 - 8)
    unmount()
  })

  it('resizes from the corner and never shrinks below the floor', () => {
    const { unmount } = renderWindow()
    const corner = frame().querySelector('[data-window-resize="both"]') as HTMLElement
    const before = box()
    act(() => {
      pointer(corner, 'pointerdown', 0, 0)
      pointer(corner, 'pointermove', 60, 40)
      pointer(corner, 'pointerup', 60, 40)
    })
    // The per-frame batcher may hold the last move; a flush lands it (the
    // release path does exactly this).
    expect(box().width).toBeGreaterThanOrEqual(before.width)
    expect(box().height).toBeGreaterThanOrEqual(before.height)
    // Dragging far past the floor clamps to the minimum size.
    act(() => {
      pointer(corner, 'pointerdown', 0, 0)
      pointer(corner, 'pointermove', -5_000, -5_000)
      pointer(corner, 'pointerup', -5_000, -5_000)
    })
    expect(box().width).toBe(320)
    expect(box().height).toBe(240)
    unmount()
  })

  it('resizes one axis at a time from the edge handles', () => {
    const { unmount } = renderWindow()
    const right = frame().querySelector('[data-window-resize="x"]') as HTMLElement
    const before = box()
    act(() => {
      pointer(right, 'pointerdown', 0, 0)
      pointer(right, 'pointermove', -100, 90)
      pointer(right, 'pointerup', -100, 90)
    })
    const after = box()
    expect(after.width).toBeLessThan(before.width)
    // The vertical edge handle ignores horizontal travel entirely.
    expect(after.height).toBe(before.height)
    unmount()
  })

  it('does not start a drag from a header control', () => {
    const { unmount } = renderWindow({ actions: true })
    const before = box()
    const copy = [...frame().querySelectorAll('button')].find(b => b.textContent === 'copy') as HTMLButtonElement
    act(() => {
      pointer(copy, 'pointerdown', 500, 100)
      pointer(window, 'pointermove', 300, 300)
      pointer(window, 'pointerup', 300, 300)
    })
    expect(box().left).toBe(before.left)
    expect(box().top).toBe(before.top)
    unmount()
  })
})
