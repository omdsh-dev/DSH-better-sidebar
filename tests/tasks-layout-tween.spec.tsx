/**
 * Unit tests for the canvas layout tween: the geometry interpolation, the
 * easing, and the hook that hides every screen-space FLIP problem by animating
 * in the canvas's OWN coordinates.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot } from './test-utils.ts'
import { TWEEN_MS, easeOut, tweenBox, useTweenedLayout } from '../src/client/tasks-layout-tween.ts'
import type { GraphBox, GraphLayout } from '../src/client/tasks-graph-layout.ts'

/** One box. */
function box(id: string, x: number, y: number, h = 87): GraphBox {
  return { id, x, y, w: 190, h }
}

/** One layout. */
function layout(boxes: GraphBox[]): GraphLayout {
  return { boxes: new Map(boxes.map(entry => [entry.id, entry])), width: 400, height: 300 }
}

afterEach(() => {
  vi.useRealTimers()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('tweenBox', () => {
  it('interpolates every geometry channel', () => {
    const from = box('a', 0, 0, 80)
    const to = box('a', 100, 40, 120)
    expect(tweenBox(from, to, 0)).toMatchObject({ x: 0, y: 0, h: 80 })
    expect(tweenBox(from, to, 1)).toMatchObject({ x: 100, y: 40, h: 120 })
    expect(tweenBox(from, to, 0.5)).toMatchObject({ x: 50, y: 20, h: 100 })
  })

  it('leaves an ENTERING box at its target (the entrance animation owns that moment)', () => {
    const to = box('fresh', 42, 7)
    expect(tweenBox(undefined, to, 0.3)).toBe(to)
  })
})

describe('easeOut', () => {
  it('runs fast out of the gate and settles exactly at the ends', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    // Ease-out: past the halfway position halfway through the time.
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
    expect(easeOut(0.9)).toBeGreaterThan(easeOut(0.8))
    // Out-of-range progress is clamped (a late frame cannot overshoot).
    expect(easeOut(1.4)).toBe(1)
    expect(easeOut(-1)).toBe(0)
  })
})

/** Renders the tweened layout and lets a test swap the target layout. */
function Harness(props: { initial: GraphLayout; onDrawn?: (layout: GraphLayout) => void }): ReactNode {
  const [target, setTarget] = useState(props.initial)
  const drawn = useTweenedLayout(target)
  props.onDrawn?.(drawn)
  swap = setTarget
  return createElement('span', null, `${drawn.boxes.size}`)
}

/** The harness's setter, captured by the render above (one instance per test). */
let swap: (next: GraphLayout) => void = () => {}

describe('useTweenedLayout', () => {
  it('shows the target on the first paint, then travels to the next layout', async () => {
    vi.useFakeTimers()
    let drawn: GraphLayout = layout([])
    const { unmount } = renderRoot(
      createElement(Harness, {
        initial: layout([box('a', 0, 0)]),
        onDrawn: (value) => { drawn = value },
      }),
    )
    // First paint: no animation, the cards are where the layout put them.
    expect(drawn.boxes.get('a')?.x).toBe(0)

    await act(async () => { swap(layout([box('a', 100, 0)])) })
    // One frame in, the card is on its way — not teleported, not waiting.
    await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    const midway = drawn.boxes.get('a')?.x ?? 0
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(100)

    await act(async () => { await vi.advanceTimersByTimeAsync(TWEEN_MS) })
    expect(drawn.boxes.get('a')?.x).toBe(100)
    unmount()
  })

  it('keeps the canvas extent at the target while the cards travel', async () => {
    vi.useFakeTimers()
    let drawn: GraphLayout = layout([])
    const { unmount } = renderRoot(
      createElement(Harness, {
        initial: layout([box('a', 0, 0)]),
        onDrawn: (value) => { drawn = value },
      }),
    )
    const next = layout([box('a', 0, 0)])
    next.width = 900
    next.height = 700
    await act(async () => { swap(next) })
    await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    // The frame must not resize mid-flight (that would move the reader's view
    // under a tween that is still running).
    expect(drawn.width).toBe(900)
    expect(drawn.height).toBe(700)
    expect(drawn.boxes.get('a')?.x).toBe(0)
    unmount()
  })
})
