/**
 * Panel width ceiling: a width drag used to run to the full viewport, so the
 * layout push could squeeze the conversation column (and the app's own left
 * nav with it) down to nothing. The stop is the top of the Side card width
 * contract, and every path that sets a width — drag commit, cross-session
 * restore, persisted-state restore, prefs preset — has to honour it, or the
 * one that does not becomes the way back into the squashed layout.
 */
import { describe, expect, it, afterEach } from 'vitest'
import {
  PANEL_MAX_VIEWPORT_RATIO,
  PANEL_MIN,
  defaultWidthFor,
  makeDefaultState,
  maxPanelWidth,
  maxPanelWidthNow,
  sanitizeState,
  setWidth,
} from '../src/client/state.ts'
import { WIDTH_PERCENT_MAX } from '../src/prefs-shared.ts'

const savedWindow = (globalThis as Record<string, unknown>).window

/** Pin `window.innerWidth` for the viewport-relative clamps. */
function withViewport(width: number): void {
  ;(globalThis as Record<string, unknown>).window = { innerWidth: width, innerHeight: 900 }
}

afterEach(() => {
  ;(globalThis as Record<string, unknown>).window = savedWindow
})

describe('maxPanelWidth', () => {
  it('is the top of the Side card width contract, not a second number', () => {
    expect(PANEL_MAX_VIEWPORT_RATIO).toBe(WIDTH_PERCENT_MAX / 100)
  })

  it('scales with the viewport', () => {
    expect(maxPanelWidth(1000)).toBe(600)
    expect(maxPanelWidth(1440)).toBe(864)
    expect(maxPanelWidth(2560)).toBe(1536)
  })

  it('never drops below the panel floor', () => {
    // A viewport small enough that the ratio undercuts PANEL_MIN must still
    // leave the panel usable rather than collapsing it below its minimum.
    expect(maxPanelWidth(400)).toBe(PANEL_MIN)
    expect(maxPanelWidth(0)).toBe(PANEL_MIN)
  })

  it('leaves the conversation the rest of the window', () => {
    const viewport = 1440
    expect(viewport - maxPanelWidth(viewport)).toBeGreaterThanOrEqual(viewport * 0.4)
  })

  it('falls back to a fixed width with no window (SSR / node)', () => {
    ;(globalThis as Record<string, unknown>).window = undefined
    expect(maxPanelWidthNow()).toBeGreaterThanOrEqual(PANEL_MIN)
  })

  it('turns a non-finite viewport into a safe bound', () => {
    expect(maxPanelWidth(Number.NaN)).toBeGreaterThanOrEqual(PANEL_MIN)
    expect(maxPanelWidth(Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(PANEL_MIN)
  })
})

describe('width setters honour the ceiling', () => {
  it('caps a drag commit', () => {
    withViewport(1440)
    const state = makeDefaultState()
    expect(setWidth(state, 10_000).width).toBe(864)
    expect(setWidth(state, 900).width).toBe(864)
    // In-range widths pass through untouched.
    expect(setWidth(state, 700).width).toBe(700)
  })

  it('still enforces the floor', () => {
    withViewport(1440)
    expect(setWidth(makeDefaultState(), 10).width).toBe(PANEL_MIN)
  })

  it('caps a width persisted on a wider window', () => {
    withViewport(1000)
    const stale = { ...makeDefaultState(), width: 1900 }
    const restored = sanitizeState(JSON.parse(JSON.stringify(stale)))
    expect(restored?.width).toBe(maxPanelWidth(1000))
  })

  it('caps a preset from outside the percent contract', () => {
    expect(defaultWidthFor(1440, 100)).toBe(maxPanelWidth(1440))
  })

  it('leaves the whole percent contract reachable', () => {
    // Every value the settings slider offers must survive unclamped, or part
    // of the user's own range would silently do nothing.
    for (let percent = 20; percent <= WIDTH_PERCENT_MAX; percent += 5) {
      const viewport = 1440
      expect(defaultWidthFor(viewport, percent)).toBe(Math.round(viewport * percent / 100))
    }
  })
})
