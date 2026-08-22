/**
 * Frame-batcher: coalesce bursty schedules into one task per animation
 * frame, flush synchronously on release, and drop pending work on dispose.
 * Uses a deterministic rAF stub so the coalescing contract is exact.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFrameBatcher } from '../src/client/frame-batcher.ts'

let frames: Map<number, () => void>
let nextId: number

function stepFrame(): void {
  const callbacks = [...frames.values()]
  frames.clear()
  for (const callback of callbacks) callback()
}

beforeEach(() => {
  frames = new Map()
  nextId = 1
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.set(nextId, callback)
    return nextId++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createFrameBatcher', () => {
  it('coalesces many schedules into one task per frame (latest wins)', () => {
    const batcher = createFrameBatcher()
    const calls: number[] = []
    let pending = 0
    const apply = (value: number): void => { calls.push(value) }

    // Caller pattern: compose into a ref, schedule a reader of that ref.
    for (const value of [1, 2, 3, 4]) {
      pending = value
      batcher.schedule(() => apply(pending))
    }
    expect(calls).toEqual([])
    stepFrame()
    expect(calls).toEqual([4])
    expect(frames.size).toBe(0)

    // The next burst starts a fresh frame.
    pending = 7
    batcher.schedule(() => apply(pending))
    stepFrame()
    expect(calls).toEqual([4, 7])
  })

  it('flushNow runs the pending task synchronously and cancels the frame', () => {
    const batcher = createFrameBatcher()
    const calls: number[] = []
    batcher.schedule(() => calls.push(1))
    batcher.schedule(() => calls.push(2))
    expect(frames.size).toBe(1) // still one pending frame

    batcher.flushNow()
    expect(calls).toEqual([2]) // latest task, synchronously
    expect(frames.size).toBe(0) // frame cancelled

    stepFrame() // the cancelled frame must not fire again
    expect(calls).toEqual([2])

    // flushNow when nothing is scheduled is a no-op.
    batcher.flushNow()
    expect(calls).toEqual([2])
  })

  it('dispose drops the pending task without running it', () => {
    const batcher = createFrameBatcher()
    const calls: number[] = []
    batcher.schedule(() => calls.push(1))
    batcher.dispose()
    expect(frames.size).toBe(0)
    stepFrame()
    expect(calls).toEqual([])

    // A disposed batcher accepts new schedules (React strict-mode remounts
    // reuse the same ref-created instance semantics).
    batcher.schedule(() => calls.push(2))
    stepFrame()
    expect(calls).toEqual([2])
  })
})
