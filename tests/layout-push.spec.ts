/**
 * Layout-push size contract: the conversation column (output + composer)
 * must keep at least PANEL_MIN of the viewport after the bottom panel
 * claims its height. A stale persisted bottomHeight (or a cap at 100vh)
 * used to crush the composer off-screen.
 */
import { describe, expect, it } from 'vitest'
import { BOTTOM_MIN, PANEL_MIN } from '../src/client/state.ts'
import { layoutPushSize } from '../src/client/layout-push.ts'

describe('layoutPushSize', () => {
  it('pushes nothing on a narrow drawer viewport', () => {
    expect(layoutPushSize({
      narrow: true,
      panelOpen: true,
      bottomOpen: true,
      width: 400,
      bottomHeight: 400,
      viewportWidth: 390,
      viewportHeight: 700,
    })).toEqual({ width: 0, height: 0 })
  })

  it('pushes nothing when both panels are collapsed', () => {
    expect(layoutPushSize({
      narrow: false,
      panelOpen: false,
      bottomOpen: false,
      width: 400,
      bottomHeight: 400,
      viewportWidth: 1280,
      viewportHeight: 800,
    })).toEqual({ width: 0, height: 0 })
  })

  it('caps an oversize bottom panel so the conversation keeps PANEL_MIN', () => {
    const viewportHeight = 800
    const size = layoutPushSize({
      narrow: false,
      panelOpen: false,
      bottomOpen: true,
      width: 0,
      bottomHeight: 10_000,
      viewportWidth: 1280,
      viewportHeight,
    })
    expect(size.height).toBe(viewportHeight - PANEL_MIN)
    expect(size.height).toBeGreaterThanOrEqual(BOTTOM_MIN)
    expect(viewportHeight - size.height).toBeGreaterThanOrEqual(PANEL_MIN)
  })

  it('caps an oversize right panel at the viewport width', () => {
    expect(layoutPushSize({
      narrow: false,
      panelOpen: true,
      bottomOpen: false,
      width: 10_000,
      bottomHeight: 0,
      viewportWidth: 1280,
      viewportHeight: 800,
    })).toEqual({ width: 1280, height: 0 })
  })

  it('passes through in-range open sizes', () => {
    expect(layoutPushSize({
      narrow: false,
      panelOpen: true,
      bottomOpen: true,
      width: 400,
      bottomHeight: 220,
      viewportWidth: 1280,
      viewportHeight: 800,
    })).toEqual({ width: 400, height: 220 })
  })

  it('never pushes beyond a viewport smaller than the normal panel minima', () => {
    expect(layoutPushSize({
      narrow: false,
      panelOpen: true,
      bottomOpen: true,
      width: 400,
      bottomHeight: 220,
      viewportWidth: 200,
      viewportHeight: 200,
    })).toEqual({ width: 200, height: 0 })
  })

  it('turns non-finite geometry into a safe zero push', () => {
    expect(layoutPushSize({
      narrow: false,
      panelOpen: true,
      bottomOpen: true,
      width: Number.NaN,
      bottomHeight: Number.POSITIVE_INFINITY,
      viewportWidth: Number.NaN,
      viewportHeight: Number.POSITIVE_INFINITY,
    })).toEqual({ width: 0, height: 0 })
  })
})
