/**
 * Geometry spec for the built-in image viewer: the fit/zoom/pan transform and
 * the pixel-edge measurement rules. The inclusive count is the contract the
 * reader asked for (a 5 px image measured edge to edge reads 5 px, covering
 * pixel rows 0–4), so the examples here are the documentation.
 */
import { describe, expect, it } from 'vitest'
import {
  AUTO_SCROLL_EDGE,
  AUTO_SCROLL_MAX_STEP,
  OVERSCROLL_RATIO,
  PIXEL_GRID_MIN_SCALE,
  autoScrollDelta,
  clamp,
  clampTransform,
  constrainAxis,
  coveredRect,
  distanceOf,
  distanceToRectBorder,
  distanceToSegment,
  edgeToStage,
  endpointPixel,
  fitTransform,
  formatZoom,
  pixelUnderStage,
  quantizeZoom,
  snapToEdge,
  stageToEdge,
  zoomAt,
} from '../src/client/image-view.ts'

const IMAGE_5 = { width: 5, height: 5 }

describe('image view transform', () => {
  it('fits inside the stage with padding, centered', () => {
    const view = fitTransform({ width: 1000, height: 500 }, { width: 400, height: 400 })
    // 400 - 2×16 = 368 available on the limiting axis.
    expect(view.scale).toBe(0.368)
    expect(view.tx).toBe(16)
    expect(view.ty).toBe(108)
  })

  it('never upscales a small image on open', () => {
    const view = fitTransform({ width: 10, height: 10 }, { width: 400, height: 400 })
    expect(view.scale).toBe(1)
    expect(view.tx).toBe(195)
    expect(view.ty).toBe(195)
  })

  it('centers an image smaller than the stage when clamped', () => {
    expect(clampTransform({ scale: 1, tx: 0, ty: -900 }, { width: 10, height: 10 }, { width: 400, height: 400 }))
      .toEqual({ scale: 1, tx: 195, ty: 195 })
  })

  it('lets a larger image pan into an overscroll margin of 25% of the stage', () => {
    const image = { width: 1000, height: 1000 }
    const stage = { width: 400, height: 400 }
    // 25% of 400 = 100 CSS px of blank stage allowed on each side.
    expect(clampTransform({ scale: 1, tx: -200, ty: -100 }, image, stage))
      .toEqual({ scale: 1, tx: -200, ty: -100 })
    // Pulled past the left/top edge: stop at the overscroll limit, not at 0.
    expect(clampTransform({ scale: 1, tx: 100, ty: 100 }, image, stage))
      .toEqual({ scale: 1, tx: 100, ty: 100 })
    expect(clampTransform({ scale: 1, tx: 500, ty: 500 }, image, stage))
      .toEqual({ scale: 1, tx: 100, ty: 100 })
    // Pulled past the right/bottom edge: the image may leave 100 px of blank.
    expect(clampTransform({ scale: 1, tx: -1000, ty: -1000 }, image, stage))
      .toEqual({ scale: 1, tx: -700, ty: -700 })
  })

  it('allows the reader\'s example: a 100 px visible area may push the corner to (25,25)', () => {
    const stage = { width: 100, height: 100 }
    const view = clampTransform({ scale: 1, tx: 1000, ty: 1000 }, { width: 1000, height: 1000 }, stage)
    expect(view).toEqual({ scale: 1, tx: 25, ty: 25 })
    // The far side gets the same allowance: 100 - 1000 - 25.
    expect(clampTransform({ scale: 1, tx: -9999, ty: -9999 }, { width: 1000, height: 1000 }, stage))
      .toEqual({ scale: 1, tx: -925, ty: -925 })
  })

  it('keeps the overscroll per axis, so a fitting axis stays centered', () => {
    // 1000 × 10 at 100% in a 400 × 400 stage: only the x axis may pan.
    expect(clampTransform({ scale: 1, tx: 50, ty: 900 }, { width: 1000, height: 10 }, { width: 400, height: 400 }))
      .toEqual({ scale: 1, tx: 50, ty: 195 })
  })

  it('keeps a 25% stage margin as one constant', () => {
    expect(OVERSCROLL_RATIO).toBe(0.25)
  })

  it('zooms around the anchor point, keeping it stationary', () => {
    const zoomed = zoomAt({ scale: 1, tx: 0, ty: 0 }, 2, { x: 100, y: 50 })
    expect(zoomed).toEqual({ scale: 2, tx: -100, ty: -50 })
    expect(stageToEdge(zoomed, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 })
  })

  it('round-trips stage and edge coordinates', () => {
    const view = { scale: 2.5, tx: -30, ty: 12 }
    expect(stageToEdge(view, edgeToStage(view, { x: 7, y: 3 }))).toEqual({ x: 7, y: 3 })
  })
})

describe('pixel edges', () => {
  it('snaps to the nearest border and clamps to the image', () => {
    expect(snapToEdge({ x: 2.4, y: 2.6 }, IMAGE_5)).toEqual({ x: 2, y: 3 })
    expect(snapToEdge({ x: -4, y: 99 }, IMAGE_5)).toEqual({ x: 0, y: 5 })
  })

  it('reports the pixel under a stage point, or null outside the image', () => {
    const view = { scale: 10, tx: 20, ty: 30 }
    expect(pixelUnderStage(view, { x: 20, y: 30 }, IMAGE_5)).toEqual({ x: 0, y: 0 })
    // Right border belongs to no pixel.
    expect(pixelUnderStage(view, { x: 70, y: 30 }, IMAGE_5)).toBeNull()
    expect(pixelUnderStage(view, { x: 19, y: 30 }, IMAGE_5)).toBeNull()
    expect(pixelUnderStage(view, { x: 69.9, y: 30 }, IMAGE_5)).toEqual({ x: 4, y: 0 })
  })

  it('measures the edge difference as the length', () => {
    expect(distanceOf({ x: 0, y: 0 }, { x: 0, y: 5 })).toEqual({ dx: 0, dy: 5, length: 5 })
    expect(distanceOf({ x: 1, y: 2 }, { x: 4, y: 6 })).toEqual({ dx: 3, dy: 4, length: 5 })
  })

  it('locks a segment to its dominant axis, ties going horizontal', () => {
    // Mostly horizontal: keep the start row, take the pointer's column.
    expect(constrainAxis({ x: 2, y: 3 }, { x: 9, y: 4 })).toEqual({ x: 9, y: 3 })
    // Mostly vertical: keep the start column, take the pointer's row.
    expect(constrainAxis({ x: 2, y: 3 }, { x: 3, y: 9 })).toEqual({ x: 2, y: 9 })
    // A 45° drag is horizontal by the `|dx| >= |dy|` rule.
    expect(constrainAxis({ x: 2, y: 3 }, { x: 7, y: 8 })).toEqual({ x: 7, y: 3 })
    // Dragging backwards keeps working (the sign never matters).
    expect(constrainAxis({ x: 5, y: 5 }, { x: 1, y: 6 })).toEqual({ x: 1, y: 5 })
  })

  it('measures the distance from a point to a segment', () => {
    // Perpendicular drop onto the middle of a horizontal segment.
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3)
    // Past an end, the nearest point is that end (not the infinite line).
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
    // A degenerate segment behaves like a point.
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5)
  })

  it('measures the distance from a point to a rectangle border', () => {
    const topLeft = { x: 10, y: 10 }
    const bottomRight = { x: 30, y: 20 }
    // Inside: the nearest edge wins.
    expect(distanceToRectBorder({ x: 12, y: 15 }, topLeft, bottomRight)).toBe(2)
    expect(distanceToRectBorder({ x: 15, y: 18 }, topLeft, bottomRight)).toBe(2)
    // Outside on one axis: perpendicular distance to that edge.
    expect(distanceToRectBorder({ x: 5, y: 15 }, topLeft, bottomRight)).toBe(5)
    // Outside diagonally: the nearest corner is the target.
    expect(distanceToRectBorder({ x: 6, y: 6 }, topLeft, bottomRight)).toBeCloseTo(Math.hypot(4, 4), 6)
  })

  it('counts the covered pixels inclusively through the edge rectangle', () => {
    // Top border 0 to bottom border 5 on a 5 px image: rows 0–4, 25 pixels.
    expect(coveredRect({ x: 0, y: 0 }, { x: 5, y: 5 })).toEqual({
      left: 0, top: 0, right: 5, bottom: 5, width: 5, height: 5, count: 25,
    })
    // A partial span from border 2 to border 5 is 3 px / 9 pixels.
    expect(coveredRect({ x: 5, y: 5 }, { x: 2, y: 2 })).toEqual({
      left: 2, top: 2, right: 5, bottom: 5, width: 3, height: 3, count: 9,
    })
  })

  it('names the covered pixel nearest each endpoint, in either direction', () => {
    expect(endpointPixel({ x: 0, y: 0 }, { x: 0, y: 5 }, IMAGE_5)).toEqual({ x: 0, y: 0 })
    expect(endpointPixel({ x: 0, y: 5 }, { x: 0, y: 0 }, IMAGE_5)).toEqual({ x: 0, y: 4 })
    // Reversed drag: start label is the last covered row, end label the first.
    expect(endpointPixel({ x: 4, y: 5 }, { x: 0, y: 2 }, IMAGE_5)).toEqual({ x: 3, y: 4 })
    expect(endpointPixel({ x: 0, y: 2 }, { x: 4, y: 5 }, IMAGE_5)).toEqual({ x: 0, y: 2 })
    // A segment that sits on one border picks that row/column.
    expect(endpointPixel({ x: 5, y: 3 }, { x: 5, y: 3 }, IMAGE_5)).toEqual({ x: 4, y: 3 })
  })
})

describe('zoom display', () => {
  it('keeps no decimal percentage at normal zoom levels', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(32)).toBe('3200%')
    // Step values are quantized to whole percentages, so the display has no
    // decimal dot: 12.5% is shown as 13%, 33.333% as 33%.
    expect(formatZoom(0.125)).toBe('13%')
    expect(formatZoom(0.33333)).toBe('33%')
    // Only a huge document fitted below 1% keeps a decimal, or it would read 0%.
    expect(formatZoom(0.001)).toBe('0.1%')
  })

  it('quantizes interaction zoom to whole percentages', () => {
    expect(quantizeZoom(1.7562)).toBe(1.76)
    expect(formatZoom(quantizeZoom(17.562))).toBe('1756%')
    // Below 1% the step is 0.1% so a fitted huge image does not collapse to 0.
    expect(quantizeZoom(0.0056)).toBe(0.006)
    expect(formatZoom(quantizeZoom(0.0056))).toBe('0.6%')
  })

  it('shows the pixel grid from Photoshop\'s 600% threshold', () => {
    expect(PIXEL_GRID_MIN_SCALE).toBe(6)
  })

  it('clamps into a closed range', () => {
    expect(clamp(4, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
  })
})

describe('auto scroll while drawing', () => {
  const STAGE = { width: 400, height: 300 }

  it('does not scroll away from the edges', () => {
    expect(autoScrollDelta({ x: 200, y: 150 }, STAGE)).toEqual({ x: 0, y: 0 })
    expect(AUTO_SCROLL_EDGE).toBe(24)
    expect(AUTO_SCROLL_MAX_STEP).toBe(12)
  })

  it('ramps up linearly inside the edge band and caps at the border', () => {
    // 12 px inside a 24 px band is half speed.
    expect(autoScrollDelta({ x: 12, y: 150 }, STAGE).x).toBeCloseTo(6, 6)
    // At the border (and past it) the top speed is reached.
    expect(autoScrollDelta({ x: 0, y: 150 }, STAGE).x).toBeCloseTo(12, 6)
    expect(autoScrollDelta({ x: -50, y: 150 }, STAGE).x).toBeCloseTo(12, 6)
    // The right/bottom bands pan the other way: 14 px inside an edge at 390.
    expect(autoScrollDelta({ x: 390, y: 150 }, STAGE).x).toBeCloseTo(-7, 6)
    expect(autoScrollDelta({ x: 200, y: 288 }, STAGE).y).toBeCloseTo(-6, 6)
  })

  it('judges both axes independently, so a rectangle can grow two ways', () => {
    const delta = autoScrollDelta({ x: 395, y: 5 }, STAGE)
    expect(delta.x).toBeCloseTo(-9.5, 6)
    expect(delta.y).toBeCloseTo(9.5, 6)
  })

  it('takes an explicit band and speed, and ties go left/top', () => {
    expect(autoScrollDelta({ x: 5, y: 5 }, STAGE, 10, 4)).toEqual({ x: 2, y: 2 })
    // A stage narrower than two bands: the nearer edge wins, ties left/top.
    expect(autoScrollDelta({ x: 15, y: 50 }, { width: 30, height: 100 })).toEqual({ x: 4.5, y: 0 })
  })
})
