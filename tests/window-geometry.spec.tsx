/**
 * Window geometry: the pure rules behind the public window host — the three
 * size presets, centring/anchor placement, viewport clamping, the narrow
 * "near fullscreen" form, maximize and resize-by-preset.
 *
 * jsdom has no layout engine, so an anchor's rect is stubbed (the component
 * specs do exactly the same); everything else is arithmetic.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_SIZE_PRESETS,
  clampWindowBox,
  clampWindowOrigin,
  initialWindowBox,
  maximizedWindowBox,
  resizeWindowBox,
  resizeWindowFromEdge,
  resolveWindowSize,
} from '../src/client/windows/geometry.ts'

const DESKTOP = { width: 1_000, height: 800 }

describe('window size presets', () => {
  it('exposes the documented default sizes', () => {
    expect(WINDOW_SIZE_PRESETS.collection).toEqual({ width: 720, height: 560 })
    expect(WINDOW_SIZE_PRESETS.document).toEqual({ width: 880, height: 640 })
    expect(WINDOW_SIZE_PRESETS.compact).toEqual({ width: 440, height: 360 })
  })

  it('centres each preset without an anchor', () => {
    expect(initialWindowBox({ preset: 'collection', viewport: DESKTOP })).toEqual({
      left: 140, top: 120, width: 720, height: 560,
    })
    expect(initialWindowBox({ preset: 'document', viewport: DESKTOP })).toEqual({
      left: 60, top: 80, width: 880, height: 640,
    })
    expect(initialWindowBox({ preset: 'compact', viewport: DESKTOP })).toEqual({
      left: 280, top: 220, width: 440, height: 360,
    })
  })

  it('uses the near-fullscreen form on narrow viewports', () => {
    const phone = initialWindowBox({ preset: 'document', viewport: { width: 390, height: 844 } })
    expect(phone).toEqual({ left: 8, top: 8, width: 374, height: 828 })
    const small = initialWindowBox({ preset: 'collection', viewport: { width: 320, height: 568 } })
    expect(small).toEqual({ left: 8, top: 8, width: 304, height: 552 })
  })

  it('sizes a desktop preset down to the available area', () => {
    // 800 ≥ the 768px narrow breakpoint, so this is the DESKTOP branch with a
    // preset larger than the viewport: the target shrinks to viewport − 16.
    expect(resolveWindowSize('document', { width: 800, height: 600 })).toEqual({
      width: 784, height: 584,
    })
  })

  it('still uses the near-fullscreen branch just below the breakpoint', () => {
    expect(resolveWindowSize('document', { width: 700, height: 500 })).toEqual({
      width: 684, height: 484,
    })
  })

  it('places a window next to its anchor and keeps it inside the viewport', () => {
    const anchor = document.createElement('button')
    anchor.getBoundingClientRect = () => ({
      left: 940, top: 700, right: 990, bottom: 720, width: 50, height: 20,
      x: 940, y: 700, toJSON: () => ({}),
    }) as DOMRect
    const box = initialWindowBox({ preset: 'collection', viewport: DESKTOP, anchor })
    expect(box.left).toBe(272)
    expect(box.top).toBe(232)
    expect(box.left + box.width).toBeLessThanOrEqual(DESKTOP.width - 8)
    expect(box.top + box.height).toBeLessThanOrEqual(DESKTOP.height - 8)
  })

  it('keeps the title bar reachable for a window larger than the viewport', () => {
    const box = initialWindowBox({ preset: 'document', viewport: { width: 500, height: 400 } })
    expect(box).toEqual({ left: 8, top: 8, width: 484, height: 384 })
  })

  it('keeps a KEEP_ON_SCREEN sliver for an origin that cannot fit the window', () => {
    // 1200px window in a 1000px viewport: the "fully inside" branch is
    // impossible, so the origin may slide until 48px stays reachable.
    expect(clampWindowOrigin(100, 1_200, 1_000)).toBe(100)
    expect(clampWindowOrigin(-5_000, 1_200, 1_000)).toBe(48 - 1_200)
    expect(clampWindowOrigin(5_000, 1_200, 1_000)).toBe(1_000 - 48)
  })
})

describe('window clamping and maximize', () => {
  it('pulls an off-screen window back and honours the resize floor', () => {
    const clamped = clampWindowBox({ left: -100, top: 900, width: 720, height: 560 }, DESKTOP)
    expect(clamped).toEqual({ left: 8, top: 232, width: 720, height: 560 })
    const floored = clampWindowBox({ left: 10, top: 10, width: 10, height: 10 }, DESKTOP)
    expect(floored.width).toBe(WINDOW_MIN_WIDTH)
    expect(floored.height).toBe(WINDOW_MIN_HEIGHT)
  })

  it('clamps after a viewport shrink without moving the window off screen', () => {
    const clamped = clampWindowBox(
      { left: 140, top: 120, width: 720, height: 560 },
      { width: 500, height: 400 },
    )
    expect(clamped).toEqual({ left: 8, top: 8, width: 484, height: 384 })
  })

  it('maximizes to the full viewport', () => {
    expect(maximizedWindowBox(DESKTOP)).toEqual({ left: 0, top: 0, width: 1_000, height: 800 })
  })

  it('resizes to a preset around the current centre', () => {
    expect(resizeWindowBox({ left: 140, top: 120, width: 720, height: 560 }, 'compact', DESKTOP))
      .toEqual({ left: 280, top: 220, width: 440, height: 360 })
  })

  it('caps an edge resize in place instead of panning the window', () => {
    const resized = resizeWindowFromEdge(
      { left: 400, top: 300, width: 500, height: 400 },
      { width: 800, height: 700 },
      DESKTOP,
    )
    // The right edge can only grow to the viewport minus margin: 1000−400−8.
    expect(resized).toEqual({ left: 400, top: 300, width: 592, height: 492 })
    const floored = resizeWindowFromEdge(
      { left: 100, top: 100, width: 500, height: 400 },
      { width: 10, height: 10 },
      DESKTOP,
    )
    expect(floored).toMatchObject({ width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT })
  })
})
