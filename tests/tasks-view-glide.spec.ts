/**
 * Unit tests for the canvas's auto-fit arithmetic and its glide — the two
 * pieces of the view transform that a jsdom test can reach (a container there
 * measures 0×0, so the graph's own `fit` cannot be exercised).
 */
import { describe, expect, it } from 'vitest'
import {
  fitTransform, lerpTransform, type FitInput,
} from '../src/client/tasks-view-glide.ts'

/** The graph's own fit inputs, centred on a small tree in a narrow panel. */
function input(over: Partial<FitInput> = {}): FitInput {
  return {
    containerW: 360,
    containerH: 600,
    layoutW: 430,
    layoutH: 260,
    pad: 16,
    minContentW: 190,
    minContentH: 87,
    margin: 24,
    minScale: 0.78,
    maxScale: 1.3,
    ...over,
  }
}

describe('fitTransform', () => {
  it('scales to the CONTENT box and centres it on both axes', () => {
    const transform = fitTransform(input())
    expect(transform).toBeDefined()
    const { x, y, k } = transform!
    // Content = 430-32 × 260-32 = 398 × 228; the panel is 360 wide, so the
    // WIDTH is what limits the scale (the height would allow 2.4×).
    expect(k).toBeCloseTo((360 - 48) / 398, 6)
    expect(x).toBeCloseTo((360 - 398 * k) / 2 - 16 * k, 6)
    expect(y).toBeCloseTo(Math.max(12, (600 - 228 * k) / 2) - 16 * k, 6)
    // …and the content really is inside the panel and centred: equal margins.
    const leftEdge = x + 16 * k
    const rightEdge = x + 16 * k + 398 * k
    expect(360 - rightEdge).toBeCloseTo(leftEdge, 6)
  })

  it('never balloons a small tree past the cap, and never shrinks below the floor', () => {
    expect(fitTransform(input({ layoutW: 200, layoutH: 100 }))?.k).toBe(1.3)
    expect(fitTransform(input({ layoutW: 4_000, layoutH: 4_000 }))?.k).toBe(0.78)
  })

  it('answers nothing before the container has been measured', () => {
    // The sidebar mounts hidden at zero size: a fit then must not divide by it.
    expect(fitTransform(input({ containerW: 0 }))).toBeUndefined()
    expect(fitTransform(input({ containerH: 0 }))).toBeUndefined()
  })
})

describe('lerpTransform', () => {
  it('walks the frame between two transforms', () => {
    const from = { x: 0, y: 0, k: 1 }
    const to = { x: 100, y: -40, k: 0.5 }
    expect(lerpTransform(from, to, 0)).toEqual(from)
    expect(lerpTransform(from, to, 1)).toEqual(to)
    expect(lerpTransform(from, to, 0.5)).toEqual({ x: 50, y: -20, k: 0.75 })
  })
})
