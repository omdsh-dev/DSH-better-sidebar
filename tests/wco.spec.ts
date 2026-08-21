/**
 * Window Controls Overlay (WCO) geometry store tests: feature detection,
 * subscribe/getSnapshot, geometrychange re-reads, and the absent-API
 * fallback (the conservative "auto" signal — plain browsers and non-overlay
 * shells report NONE and the sidebar adapts nothing).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import './browser-globals.ts'
import {
  getWcoSnapshot, setWcoSourceForTests, subscribeWco, WCO_NONE,
  type WcoSource,
} from '../src/client/wco.ts'

/** A controllable fake of the standard API surface. */
function makeSource(initial: { width: number; height: number; visible?: boolean }): {
  source: WcoSource
  setRect: (width: number, height: number) => void
  fireGeometryChange: () => void
  listeners: Set<() => void>
} {
  const listeners = new Set<() => void>()
  let rect = { x: 0, y: 0, width: initial.width, height: initial.height }
  const source: WcoSource = {
    visible: initial.visible ?? true,
    getTitlebarAreaRect: () => rect,
    addEventListener: (type, listener) => { if (type === 'geometrychange') listeners.add(listener) },
    removeEventListener: (type, listener) => { if (type === 'geometrychange') listeners.delete(listener) },
  }
  return {
    source,
    setRect: (width, height) => { rect = { x: 0, y: 0, width, height } },
    fireGeometryChange: () => { for (const listener of listeners) listener() },
    listeners,
  }
}

beforeEach(() => {
  setWcoSourceForTests(undefined)
})

afterEach(() => {
  setWcoSourceForTests(undefined)
})

describe('wco geometry store', () => {
  it('reports NONE (absent API) in plain browsers / non-overlay shells', () => {
    expect(getWcoSnapshot()).toBe(WCO_NONE)
    expect(getWcoSnapshot().present).toBe(false)
    expect(getWcoSnapshot().height).toBe(0)
  })

  it('reads the real overlay rect once a source is present', () => {
    const { source } = makeSource({ width: 138, height: 36 })
    setWcoSourceForTests(source)
    expect(getWcoSnapshot()).toEqual({ present: true, height: 36 })
  })

  it('rounds fractional overlay heights to whole pixels', () => {
    const { source } = makeSource({ width: 100, height: 35.6 })
    setWcoSourceForTests(source)
    expect(getWcoSnapshot().height).toBe(36)
  })

  it('re-reads geometry on geometrychange (maximize/restore) and notifies subscribers', () => {
    const { source, setRect, fireGeometryChange, listeners } = makeSource({ width: 138, height: 32 })
    setWcoSourceForTests(source)
    const calls: number[] = []
    const off = subscribeWco(() => { calls.push(getWcoSnapshot().height) })
    // Maximized: the overlay reports a zero/empty rect.
    setRect(0, 0)
    fireGeometryChange()
    expect(getWcoSnapshot()).toEqual({ present: true, height: 0 })
    expect(calls).toEqual([0])
    // Restored.
    setRect(138, 36)
    fireGeometryChange()
    expect(getWcoSnapshot()).toEqual({ present: true, height: 36 })
    expect(calls).toEqual([0, 36])
    // The disposer stops notifications.
    off()
    setRect(138, 40)
    fireGeometryChange()
    expect(calls).toEqual([0, 36])
    expect(listeners.size).toBe(0)
  })

  it('treats a PHANTOM API (present but not visible) as absent — headless/macOS expose the interface with no overlay', () => {
    const { source } = makeSource({ width: 0, height: 0, visible: false })
    setWcoSourceForTests(source)
    // present=false lets the strip chain fall through to the inset / preset
    // / custom scheme instead of trusting an empty rect.
    expect(getWcoSnapshot()).toEqual({ present: false, height: 0 })
    // A real overlay flips to authoritative immediately.
    const real = makeSource({ width: 138, height: 36, visible: true })
    setWcoSourceForTests(real.source)
    expect(getWcoSnapshot()).toEqual({ present: true, height: 36 })
  })

  it('treats a throwing API as absent (never breaks the layout)', () => {
    const source: WcoSource = {
      visible: true,
      getTitlebarAreaRect: () => { throw new Error('racy API') },
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    setWcoSourceForTests(source)
    expect(getWcoSnapshot()).toEqual({ present: false, height: 0 })
  })

  it('re-attaches cleanly when the source is swapped (test hook)', () => {
    const first = makeSource({ width: 138, height: 32 })
    const second = makeSource({ width: 138, height: 36 })
    setWcoSourceForTests(first.source)
    expect(first.listeners.size).toBe(0) // no subscriber yet
    const off = subscribeWco(() => {})
    expect(first.listeners.size).toBe(1)
    setWcoSourceForTests(second.source)
    expect(first.listeners.size).toBe(0)
    expect(second.listeners.size).toBe(1)
    expect(getWcoSnapshot().height).toBe(36)
    off()
    setWcoSourceForTests(undefined)
    expect(getWcoSnapshot()).toBe(WCO_NONE)
  })
})
