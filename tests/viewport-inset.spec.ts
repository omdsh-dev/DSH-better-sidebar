/**
 * The viewport's top inset (viewport-inset.ts): the band the desktop shell
 * paints its native window controls over, which floating surfaces must stay
 * out of (issue #805; the Tasks detail window's close button is the same bug).
 *
 * Every unusable shape collapses to 0 so plain browsers keep their exact
 * behaviour: no API, a `visible: false` ghost interface (headless Chromium,
 * some macOS builds), a zero-height band, and a throwing read.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getViewportInset,
  setViewportInsetSourceForTests,
  subscribeViewportInset,
  type WindowControlsOverlayLike,
} from '../src/client/viewport-inset.ts'

interface Rect { x: number; y: number; width: number; height: number }

/** A controllable WCO source: `emit()` plays the browser's geometrychange. */
function overlay(initial: Rect, visible = true): {
  source: WindowControlsOverlayLike
  set(next: Partial<Rect>): void
  setVisible(next: boolean): void
  emit(): void
  listenerCount(): number
  boom(): void
} {
  let rect = { ...initial }
  let isVisible = visible
  let throws = false
  const listeners = new Set<() => void>()
  return {
    source: {
      get visible() { return isVisible },
      getTitlebarAreaRect() {
        if (throws) throw new Error('geometry raced the layout')
        return { ...rect }
      },
      addEventListener(_type, listener) { listeners.add(listener) },
      removeEventListener(_type, listener) { listeners.delete(listener) },
    },
    set(next) { rect = { ...rect, ...next } },
    setVisible(next) { isVisible = next },
    emit() { for (const listener of listeners) listener() },
    listenerCount: () => listeners.size,
    boom() { throws = true },
  }
}

beforeEach(() => {
  setViewportInsetSourceForTests(undefined)
})

afterEach(() => {
  setViewportInsetSourceForTests(undefined)
})

describe('viewport inset: the shape of the native control band', () => {
  it('is zero without the Window Controls Overlay API', () => {
    expect(getViewportInset()).toBe(0)
  })

  it('reads the band height', () => {
    setViewportInsetSourceForTests(overlay({ x: 0, y: 0, width: 1_000, height: 36 }).source)
    expect(getViewportInset()).toBe(36)
  })

  it('rounds a fractional height', () => {
    setViewportInsetSourceForTests(overlay({ x: 0, y: 0, width: 1_000, height: 35.6 }).source)
    expect(getViewportInset()).toBe(36)
  })

  it('uses the rect bottom edge, not the raw height', () => {
    // A shell that insets the band: the page may start at y + height.
    setViewportInsetSourceForTests(overlay({ x: 0, y: 4, width: 1_000, height: 32 }).source)
    expect(getViewportInset()).toBe(36)
  })

  it('treats a non-visible overlay as absent (ghost interface)', () => {
    setViewportInsetSourceForTests(overlay({ x: 0, y: 0, width: 1_000, height: 44 }, false).source)
    expect(getViewportInset()).toBe(0)
  })

  it('treats a zero-height band as no band', () => {
    setViewportInsetSourceForTests(overlay({ x: 0, y: 0, width: 1_000, height: 0 }).source)
    expect(getViewportInset()).toBe(0)
  })

  it('does not throw when the geometry read races the layout', () => {
    const fake = overlay({ x: 0, y: 0, width: 1_000, height: 44 })
    setViewportInsetSourceForTests(fake.source)
    expect(getViewportInset()).toBe(44)
    fake.boom()
    expect(() => { fake.emit() }).not.toThrow()
    expect(getViewportInset()).toBe(0)
  })
})

describe('viewport inset: live geometry', () => {
  it('notifies subscribers only when the band actually changes', () => {
    const fake = overlay({ x: 0, y: 0, width: 1_000, height: 0 })
    setViewportInsetSourceForTests(fake.source)
    let calls = 0
    const dispose = subscribeViewportInset(() => { calls += 1 })
    expect(getViewportInset()).toBe(0)

    fake.set({ height: 36 })
    fake.emit()
    expect(getViewportInset()).toBe(36)
    expect(calls).toBe(1)

    // A later event with the same geometry must not wake React again.
    fake.emit()
    expect(calls).toBe(1)

    fake.set({ height: 0 })
    fake.emit()
    expect(getViewportInset()).toBe(0)
    expect(calls).toBe(2)

    dispose()
    fake.set({ height: 36 })
    fake.emit()
    expect(calls).toBe(2)
  })

  it('re-reads on window resize (the maximize / restore fallback)', () => {
    // Some Electron builds expose the overlay without firing geometrychange.
    const fake = overlay({ x: 0, y: 0, width: 1_000, height: 0 })
    setViewportInsetSourceForTests(fake.source)
    fake.set({ height: 36 })
    window.dispatchEvent(new Event('resize'))
    expect(getViewportInset()).toBe(36)
  })

  it('drops and restores the inset when visibility flips at runtime', () => {
    const fake = overlay({ x: 0, y: 0, width: 1_000, height: 36 })
    setViewportInsetSourceForTests(fake.source)
    expect(getViewportInset()).toBe(36)
    fake.setVisible(false)
    fake.emit()
    expect(getViewportInset()).toBe(0)
    fake.setVisible(true)
    fake.emit()
    expect(getViewportInset()).toBe(36)
  })

  it('detaches the previous source when tests swap it', () => {
    const first = overlay({ x: 0, y: 0, width: 1_000, height: 36 })
    setViewportInsetSourceForTests(first.source)
    expect(first.listenerCount()).toBe(1)
    const second = overlay({ x: 0, y: 0, width: 1_000, height: 44 })
    setViewportInsetSourceForTests(second.source)
    expect(first.listenerCount()).toBe(0)
    expect(getViewportInset()).toBe(44)
  })
})
