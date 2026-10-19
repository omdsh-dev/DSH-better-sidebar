// @vitest-environment jsdom
/**
 * Right-Sidebar chip middle-click close (`src/client/native/tab-middle-click.ts`).
 *
 * The host's dockkit strip owns the chips and has no middle-button route, so
 * the plugin delegates the gesture at the document. The contract pinned here:
 * the press is taken in the CAPTURE phase on `pointerdown` (the host starts a
 * chip drag there) and `mousedown` (autoscroll), the close settles on the first
 * middle `mouseup` OVER the pressed chip, and a chip without the host's own
 * close control — its closability decision, projected onto the DOM — is left
 * completely alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTabMiddleClick } from '../src/client/native/tab-middle-click.ts'

/** One dockkit-shaped chip: the id attribute, a title, and (optionally) the close control. */
function chip(id: string, closable = true): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-dockkit-tab', id)
  element.textContent = id
  if (closable) {
    const close = document.createElement('button')
    close.setAttribute('data-dockkit-tab-close', id)
    element.append(close)
  }
  document.body.append(element)
  return element
}

/** Dispatch a native pointer/mouse event; the returned event exposes defaultPrevented. */
function fire(target: EventTarget, type: string, button: number): Event {
  const event = type.startsWith('pointer')
    ? new PointerEvent(type, { bubbles: true, cancelable: true, button })
    : new MouseEvent(type, { bubbles: true, cancelable: true, button })
  target.dispatchEvent(event)
  return event
}

/** Middle press + release on one target. */
function middleClick(target: EventTarget): void {
  fire(target, 'pointerdown', 1)
  fire(target, 'mousedown', 1)
  fire(target, 'mouseup', 1)
}

function install(): { closeTab: ReturnType<typeof vi.fn>; dispose: () => void } {
  const closeTab = vi.fn()
  return { closeTab, dispose: registerTabMiddleClick({ closeTab }) }
}

afterEach(() => { document.body.innerHTML = '' })

describe('right-Sidebar chip middle-click close', () => {
  it('closes when the middle mouseup lands on the same chip', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      middleClick(target)
      expect(closeTab).toHaveBeenCalledWith('t1')
      expect(closeTab).toHaveBeenCalledTimes(1)
    } finally { dispose() }
  })

  it('keeps the press from reaching the chip (the host starts a drag there)', () => {
    const { dispose } = install()
    const target = chip('t1')
    let reached = false
    target.addEventListener('pointerdown', () => { reached = true })
    try {
      fire(target, 'pointerdown', 1)
      expect(reached).toBe(false)
    } finally { dispose() }
  })

  it('disarms the middle-click autoscroll', () => {
    const { dispose } = install()
    const target = chip('t1')
    try {
      expect(fire(target, 'mousedown', 1).defaultPrevented).toBe(true)
    } finally { dispose() }
  })

  it('cancels when released elsewhere, once per press', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'pointerdown', 1)
      fire(target, 'mousedown', 1)
      fire(document.body, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
      // A later middle release over the chip, with no new press, must not close.
      fire(target, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('does not close when the release lands on a different chip', () => {
    const { closeTab, dispose } = install()
    const first = chip('t1')
    const second = chip('t2')
    try {
      fire(first, 'pointerdown', 1)
      fire(first, 'mousedown', 1)
      fire(second, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('closes when the press starts on the chip close control', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    const close = target.querySelector('button') as HTMLButtonElement
    try {
      middleClick(close)
      expect(closeTab).toHaveBeenCalledWith('t1')
    } finally { dispose() }
  })

  it('leaves a chip without a close control completely alone', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1', false)
    try {
      fire(target, 'pointerdown', 1)
      expect(fire(target, 'mousedown', 1).defaultPrevented).toBe(false)
      fire(target, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('ignores the left button entirely', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'pointerdown', 0)
      expect(fire(target, 'mousedown', 0).defaultPrevented).toBe(false)
      fire(target, 'mouseup', 0)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('does not close on a bare auxclick', () => {
    // Pins the settlement point: the close rides the mouseup of a recorded
    // press, not auxclick delivery.
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'auxclick', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('ignores a chip that carries no tab id', () => {
    const { closeTab, dispose } = install()
    const target = chip('')
    try {
      middleClick(target)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('drops a press whose chip left the document before the release', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    try {
      fire(target, 'pointerdown', 1)
      fire(target, 'mousedown', 1)
      target.remove()
      fire(target, 'mouseup', 1)
      expect(closeTab).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('stops closing after dispose', () => {
    const { closeTab, dispose } = install()
    const target = chip('t1')
    fire(target, 'pointerdown', 1)
    fire(target, 'mousedown', 1)
    dispose()
    fire(target, 'mouseup', 1)
    expect(closeTab).not.toHaveBeenCalled()
  })
})
