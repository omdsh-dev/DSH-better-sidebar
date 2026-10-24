// @vitest-environment jsdom
/**
 * Width pinning for the HOST's native tab strip.
 *
 * Closing a tab under the pointer must not re-lay-out its survivors: with
 * equal-width chips every close widens them, so the next × jumps away and a
 * run of closes turns into a chase. The host gives no API for this, and it
 * REBUILDS the strip's DOM on every close (measured on a real mount: the
 * `[data-dockkit-strip]` node is replaced), so the pin cannot live on the
 * strip. It lives on `<html>`:
 *
 *  - armed by the close GESTURE (pointerdown on the kit's close control, or a
 *    middle-button press on a chip), which measures the width BEFORE the
 *    close — no mutation watching needed;
 *  - released when the pointer is no longer on the pinned strip: an explicit
 *    outside `pointerout` releases at once, a "no related target" one (the
 *    node was removed / the window was left) is confirmed by a hit test on the
 *    next task, and a `pointerover` elsewhere releases too.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { FROZEN_ATTR, FROZEN_VAR, installNativeStripFreeze } from '../src/client/tab-strip-freeze.ts'

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  document.documentElement.removeAttribute(FROZEN_ATTR)
  document.documentElement.style.removeProperty(FROZEN_VAR)
})

interface KitStrip {
  /** The whole strip line (chips row + empty tail + a control). */
  line: HTMLElement
  /** The chips row inside it. */
  row: HTMLElement
}

/** One kit strip, shaped like `TabPanel` renders it. */
function strip(count: number, paneId = 'pane1'): KitStrip {
  const line = document.createElement('div')
  line.setAttribute('data-dockkit-strip', paneId)
  const row = document.createElement('div')
  row.setAttribute('data-dockkit-strip-tabs', paneId)
  for (let i = 0; i < count; i += 1) {
    const chip = document.createElement('div')
    chip.setAttribute('data-dockkit-tab', `t${i}`)
    const close = document.createElement('button')
    close.type = 'button'
    close.setAttribute('data-dockkit-tab-close', `t${i}`)
    chip.append(close)
    row.append(chip)
  }
  const tail = document.createElement('div')
  tail.setAttribute('data-dockkit-strip-fill', '')
  const control = document.createElement('button')
  control.type = 'button'
  line.append(row, tail, control)
  document.body.append(line)
  return { line, row }
}

function fire(type: string, target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }))
}

/** jsdom has no hit test; install one and hand back the remover. */
function stubHitTest(result: Element | null): () => void {
  Object.defineProperty(document, 'elementFromPoint', { value: () => result, configurable: true })
  return () => { Reflect.deleteProperty(document, 'elementFromPoint') }
}

/** Let the deferred leave check run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

function install(): void {
  disposers.push(installNativeStripFreeze({ measure: () => 120 }))
}

const frozen = (): boolean => document.documentElement.hasAttribute(FROZEN_ATTR)
const frozenVar = (): string => document.documentElement.style.getPropertyValue(FROZEN_VAR)
const closeOf = (kit: KitStrip, index: number): Element =>
  kit.row.children[index]?.querySelector('[data-dockkit-tab-close]') as Element

describe('native strip width freeze', () => {
  it('pins the measured width when the close gesture starts', () => {
    const kit = strip(4)
    install()
    expect(frozen()).toBe(false)

    fire('pointerdown', closeOf(kit, 1), { button: 0 })

    expect(frozen()).toBe(true)
    expect(frozenVar()).toBe('120px')
  })

  it('pins a middle-button press on a chip as well', () => {
    const kit = strip(3)
    install()
    fire('pointerdown', kit.row.children[2] as Element, { button: 1 })
    expect(frozen()).toBe(true)
  })

  it('does not pin a plain press elsewhere on the strip', () => {
    const kit = strip(3)
    install()
    fire('pointerdown', kit.row.children[0] as Element, { button: 0 })
    expect(frozen()).toBe(false)
    fire('pointerdown', kit.line.lastElementChild as Element, { button: 0 })
    expect(frozen()).toBe(false)
  })

  it('survives the host rebuilding the strip DOM on the close', () => {
    const kit = strip(3)
    install()
    fire('pointerdown', closeOf(kit, 0), { button: 0 })
    expect(frozen()).toBe(true)

    // The host replaces the whole strip node (real behavior); the pin is on
    // <html>, so it is still there for the rebuilt chips.
    kit.line.remove()
    const rebuilt = strip(2, 'pane1')
    expect(frozen()).toBe(true)
    expect(rebuilt.line.getAttribute('data-dockkit-strip')).toBe('pane1')
  })

  it('releases when the pointer leaves the strip explicitly', async () => {
    const kit = strip(3)
    const outside = document.createElement('div')
    document.body.append(outside)
    install()
    fire('pointerdown', closeOf(kit, 0), { button: 0 })

    // Every release is confirmed by the hit test (one task later): a
    // relatedTarget can itself be a node the rebuild detached, so "related is
    // outside" is not proof that the pointer left.
    const restore = stubHitTest(outside)
    fire('pointerout', kit.row.children[0] as Element, { relatedTarget: outside })
    await settle()
    expect(frozen()).toBe(false)
    expect(frozenVar()).toBe('')
    restore()
  })

  it('keeps the pin while the pointer stays on the strip, chips or empty tail', () => {
    const kit = strip(3)
    install()
    fire('pointerdown', closeOf(kit, 0), { button: 0 })

    fire('pointerout', kit.row.children[0] as Element, { relatedTarget: kit.row.children[1] })
    expect(frozen()).toBe(true)
    fire('pointerover', kit.line.lastElementChild as Element)
    expect(frozen()).toBe(true)
  })

  it('keeps the pin when the pointerout came from the closed chip leaving the DOM', async () => {
    const kit = strip(3)
    install()
    fire('pointerdown', closeOf(kit, 1), { button: 0 })
    kit.row.removeChild(kit.row.children[1] as Element)

    // Closing the hovered chip fires `pointerout` with NO related target. The
    // hit test must still land inside the strip, or the pin dies in the one
    // moment it exists for.
    const restore = stubHitTest(kit.line.querySelector('[data-dockkit-strip-fill]'))
    fire('pointerout', kit.row.children[0] as Element, {})
    await settle()
    expect(frozen()).toBe(true)
    restore()
  })

  it('releases when a no-related-target leave really points outside', async () => {
    const kit = strip(3)
    const outside = document.createElement('div')
    document.body.append(outside)
    install()
    fire('pointerdown', closeOf(kit, 1), { button: 0 })

    const restore = stubHitTest(outside)
    fire('pointerout', kit.row.children[0] as Element, {})
    await settle()
    expect(frozen()).toBe(false)
    restore()
  })

  it('releases when the strip is gone', async () => {
    const kit = strip(3)
    install()
    fire('pointerdown', closeOf(kit, 1), { button: 0 })
    kit.line.remove()

    const restore = stubHitTest(null)
    fire('pointerout', document.body, {})
    await settle()
    expect(frozen()).toBe(false)
    restore()
  })

  it('leaves a markup it does not know alone', () => {
    const unrelated = document.createElement('div')
    const close = document.createElement('button')
    close.setAttribute('data-dockkit-tab-close', 'x')
    unrelated.append(close)
    document.body.append(unrelated)
    install()

    fire('pointerdown', close, { button: 0 })
    expect(frozen()).toBe(false)
  })
})
