/**
 * useSelectionPopup spec — the "add to conversation" popup's global dismissal
 * contract (upstream issue #425 ①). The portaled fixed button must hide on an
 * outside mousedown, on Escape, when the document goes hidden, when the
 * window loses focus, and as soon as the editor surface leaves the viewport
 * (the geometry signal behind tab switches and panel collapse) — yet it must
 * survive a mousedown ON the button so the click can still commit the
 * selection.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement, useRef } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useSelectionPopup } from '../src/client/selection-popup.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** jsdom ships no IntersectionObserver; a controllable stand-in. */
class FakeIntersectionObserver implements IntersectionObserver {
  static last: FakeIntersectionObserver | null = null
  readonly root: Element | Document | null = null
  readonly rootMargin = '0px'
  readonly thresholds: readonly number[] = [0]
  readonly targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.last = this
  }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(target: Element): void { this.targets.delete(target) }
  disconnect(): void { this.targets.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  /** Test hook: report that every observed target is (or is not) intersecting. */
  fire(intersecting: boolean): void {
    this.callback([{ isIntersecting: intersecting } as IntersectionObserverEntry], this)
  }
}

interface HarnessCtl {
  show(insert: string): void
  button(): HTMLButtonElement | null
}

let ctl: HarnessCtl

/** The popup consumer's rendering shape: the hook + a portaled button. */
function Harness(props: { onCommit: (insert: string) => void }) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const surface = useSelectionPopup({
    onCommit: props.onCommit,
    getSurface: () => surfaceRef.current,
  })
  ctl = {
    show: (insert: string) => act(() => { surface.show(insert, 100, 100) }),
    button: () => document.querySelector<HTMLButtonElement>('[data-popup]'),
  }
  return createElement('div', null,
    createElement('div', { ref: surfaceRef, 'data-surface': true }),
    surface.popup === null ? null : createPortal(
      createElement('button', {
        type: 'button',
        ref: surface.buttonRef,
        'data-popup': true,
        onClick: surface.commit,
      }, surface.popup.insert),
      document.body,
    ),
  )
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let commitCalls: string[]

function mount(): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  commitCalls = []
  act(() => {
    root.render(createElement(Harness, { onCommit: (insert: string) => { commitCalls.push(insert) } }))
  })
}

function unmount(): void {
  act(() => { root.unmount() })
  container.remove()
}

const RealIntersectionObserver = globalThis.IntersectionObserver

beforeEach(() => {
  ;(globalThis as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver
  FakeIntersectionObserver.last = null
})

afterEach(() => {
  ;(globalThis as { IntersectionObserver: unknown }).IntersectionObserver = RealIntersectionObserver
  document.body.innerHTML = ''
})

describe('useSelectionPopup', () => {
  it('shows the popup button with the payload', () => {
    mount()
    ctl.show('PAYLOAD')
    const button = ctl.button()
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('PAYLOAD')
    unmount()
  })

  it('commits the payload on click, then hides', () => {
    mount()
    ctl.show('PAYLOAD')
    const button = ctl.button()!
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(commitCalls).toEqual(['PAYLOAD'])
    expect(ctl.button()).toBeNull()
    unmount()
  })

  it('hides on a mousedown outside the button', () => {
    mount()
    ctl.show('PAYLOAD')
    const elsewhere = document.createElement('div')
    document.body.append(elsewhere)
    act(() => { elsewhere.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(ctl.button()).toBeNull()
    unmount()
  })

  it('survives a mousedown ON the button so the click can commit', () => {
    mount()
    ctl.show('PAYLOAD')
    const button = ctl.button()!
    act(() => { button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(ctl.button()).not.toBeNull()
    unmount()
  })

  it('hides on Escape', () => {
    mount()
    ctl.show('PAYLOAD')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(ctl.button()).toBeNull()
    unmount()
  })

  it('hides when the document goes hidden (browser tab switched away)', () => {
    mount()
    ctl.show('PAYLOAD')
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    try {
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(ctl.button()).toBeNull()
    } finally {
      if (prototypeDescriptor !== undefined) Object.defineProperty(document, 'hidden', prototypeDescriptor)
      else delete (document as { hidden?: boolean }).hidden
    }
    unmount()
  })

  it('hides when the window loses focus', () => {
    mount()
    ctl.show('PAYLOAD')
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(ctl.button()).toBeNull()
    unmount()
  })

  it('watches the editor surface: off-viewport (tab switch / collapse) hides, on-viewport keeps', () => {
    mount()
    ctl.show('PAYLOAD')
    const observer = FakeIntersectionObserver.last
    expect(observer).not.toBeNull()
    expect(observer!.targets.size).toBe(1)
    // The observed target is the hook's surface element.
    expect([...observer!.targets][0]?.getAttribute('data-surface')).toBe('true')
    // Surfaced on screen (or display:none removed): the popup stays.
    act(() => { observer!.fire(true) })
    expect(ctl.button()).not.toBeNull()
    // Hidden / translated off-screen: the popup must not survive it.
    act(() => { observer!.fire(false) })
    expect(ctl.button()).toBeNull()
    unmount()
  })
})