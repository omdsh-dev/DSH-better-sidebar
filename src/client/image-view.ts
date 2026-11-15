/**
 * Geometry behind the built-in image viewer.
 *
 * The viewer works in three coordinate spaces:
 *
 * - **image edge** — origin at the image's top-left corner, one unit per pixel
 *   BORDER (`0 … width`, `0 … height`). Pixel `i` spans `[i, i+1]`. This is the
 *   only space where a measurement's two boundary lines land on exact pixel
 *   edges, and it matches Photoshop's Info panel: measuring a 5 px tall image
 *   from its top edge (0) to its bottom edge (5) reads 5 px and covers rows
 *   0–4. Measurements are stored in this space, snapped to integer edges.
 * - **image pixel** — origin at the same corner, one unit per pixel CELL
 *   (`0 … width-1`, `0 … height-1`). Labels use it to answer "which pixel".
 * - **stage** — CSS pixels relative to the stage's top-left corner. The view
 *   renders `stage = origin + imageEdge × scale`.
 *
 * Pure (no React, no DOM) so every rule here is unit-testable.
 */

/** A point on the pixel grid, in image edge coordinates (integers after snap). */
export interface EdgePoint {
  x: number
  y: number
}

/** A pixel cell index (integers, `0 … size-1`). */
export interface PixelPoint {
  x: number
  y: number
}

/** The image's natural size in pixels. */
export interface ImageSize {
  width: number
  height: number
}

/** A stage's content size in CSS pixels. */
export interface StageSize {
  width: number
  height: number
}

/** One point in stage coordinates. */
export interface StagePoint {
  x: number
  y: number
}

/** Zoom + pan state: `stage = origin + imageEdge × scale`. */
export interface ViewTransform {
  /** CSS pixels per image pixel. */
  scale: number
  /** Stage x of the image's left edge. */
  tx: number
  /** Stage y of the image's top edge. */
  ty: number
}

/** Smallest zoom (0.1%); below it a large document would lose its frame. */
export const MIN_SCALE = 0.001

/** Largest zoom (3200%), Photoshop's own ceiling. */
export const MAX_SCALE = 32

/**
 * The zoom at which the pixel grid appears. Photoshop draws its pixel grid
 * from 600% up, and below that a 1 px line would eat too much of a pixel to
 * read the artwork.
 */
export const PIXEL_GRID_MIN_SCALE = 6

/** Breathing room around a fitted image, in CSS pixels. */
export const FIT_PADDING = 16

/**
 * How much empty stage a zoomed-in image may be pushed aside by, as a share of
 * the stage's own width/height. A percentage (not a pixel count) keeps the same
 * hand-feel whatever the sidebar's width is: the reader can always push one
 * image edge a quarter of the stage inward, so at most half the stage is blank
 * at a time. Images that fit the stage are still centered; only the axis that
 * overflows gets the allowance.
 */
export const OVERSCROLL_RATIO = 0.25

/** How close to a stage edge a drawing pointer may get before the view scrolls. */
export const AUTO_SCROLL_EDGE = 24

/** Fastest auto-scroll speed, in CSS pixels per animation frame. */
export const AUTO_SCROLL_MAX_STEP = 12

/** Clamp `value` into `[min, max]` (inclusive). */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Whether a size can be laid out (a decoded image may report 0 while loading). */
function hasSize(size: ImageSize | StageSize): boolean {
  return size.width > 0 && size.height > 0
}

/**
 * The transform that shows the whole image, centered and never upscaled past
 * 100% (a 16×16 icon should not open as a blurry 400 px square). An invalid
 * size answers the unmoved identity so the caller can render before decode.
 * @param image - the decoded image size.
 * @param stage - the stage's content size.
 * @returns the fit transform.
 */
export function fitTransform(image: ImageSize, stage: StageSize): ViewTransform {
  if (!hasSize(image) || !hasSize(stage)) return { scale: 1, tx: 0, ty: 0 }
  const availableWidth = Math.max(1, stage.width - FIT_PADDING * 2)
  const availableHeight = Math.max(1, stage.height - FIT_PADDING * 2)
  const scale = clamp(
    Math.min(1, availableWidth / image.width, availableHeight / image.height),
    MIN_SCALE,
    MAX_SCALE,
  )
  return centerTransform(scale, image, stage)
}

/**
 * Center an image at `scale` inside the stage.
 * @param scale - CSS pixels per image pixel.
 * @param image - the decoded image size.
 * @param stage - the stage's content size.
 * @returns the centered transform.
 */
export function centerTransform(scale: number, image: ImageSize, stage: StageSize): ViewTransform {
  return {
    scale,
    tx: (stage.width - image.width * scale) / 2,
    ty: (stage.height - image.height * scale) / 2,
  }
}

/**
 * Keep the view reachable: an image smaller than the stage is centered (there
 * is nothing to pan), a larger one may be pushed up to {@link OVERSCROLL_RATIO}
 * of the stage inward on each overflowing axis, leaving blank stage there. That
 * blank is pannable space, not drawable space: the measurement start check still
 * requires the pointer to be on the image.
 * @param view - the candidate transform.
 * @param image - the decoded image size.
 * @param stage - the stage's content size.
 * @returns the clamped transform (the input object when it already fits).
 */
export function clampTransform(view: ViewTransform, image: ImageSize, stage: StageSize): ViewTransform {
  if (!hasSize(image) || !hasSize(stage)) return view
  const scaledWidth = image.width * view.scale
  const scaledHeight = image.height * view.scale
  const overscrollX = stage.width * OVERSCROLL_RATIO
  const overscrollY = stage.height * OVERSCROLL_RATIO
  const tx = scaledWidth <= stage.width
    ? (stage.width - scaledWidth) / 2
    : clamp(view.tx, stage.width - scaledWidth - overscrollX, overscrollX)
  const ty = scaledHeight <= stage.height
    ? (stage.height - scaledHeight) / 2
    : clamp(view.ty, stage.height - scaledHeight - overscrollY, overscrollY)
  if (tx === view.tx && ty === view.ty) return view
  return { scale: view.scale, tx, ty }
}

/**
 * One axis of the auto-scroll rule: how far the view should pan this frame when
 * the drawing pointer sits near (or past) a stage edge. Speed ramps linearly
 * from 0 at `edge` px inside the stage to `maxStep` at the stage border and
 * stays there outside it. The nearer edge wins if the stage is very narrow.
 * @param position - the pointer's coordinate on this axis, in stage px.
 * @param length - the stage's size on this axis, in CSS px.
 * @param edge - the trigger band width.
 * @param maxStep - the speed at (and past) the stage border.
 * @returns the pan delta for this axis (positive = content moves right/down).
 */
function autoScrollAxis(position: number, length: number, edge: number, maxStep: number): number {
  if (!(length > 0)) return 0
  const leftDepth = edge - position
  const rightDepth = position - (length - edge)
  if (leftDepth <= 0 && rightDepth <= 0) return 0
  const depth = Math.max(leftDepth, rightDepth)
  const speed = maxStep * clamp(depth / edge, 0, 1)
  return leftDepth >= rightDepth ? speed : -speed
}

/**
 * The view pan a drawing gesture should get this frame. Both axes are judged
 * independently, so a rectangle can grow in two directions at once. The caller
 * still clamps the result, which is what stops the scroll at the overscroll
 * boundary instead of running forever.
 * @param point - the pointer in stage coordinates (may be outside the stage).
 * @param stage - the stage's content size.
 * @param edge - the trigger band width (default {@link AUTO_SCROLL_EDGE}).
 * @param maxStep - the top speed (default {@link AUTO_SCROLL_MAX_STEP}).
 * @returns the pan delta; `{ x: 0, y: 0 }` means "no scrolling".
 */
export function autoScrollDelta(
  point: StagePoint,
  stage: StageSize,
  edge: number = AUTO_SCROLL_EDGE,
  maxStep: number = AUTO_SCROLL_MAX_STEP,
): StagePoint {
  return {
    x: autoScrollAxis(point.x, stage.width, edge, maxStep),
    y: autoScrollAxis(point.y, stage.height, edge, maxStep),
  }
}

/**
 * Zoom around one stage point, keeping the image point under it stationary.
 * The caller still clamps the result (an edge anchor may be pulled back).
 * @param view - the current transform.
 * @param scale - the requested scale.
 * @param anchor - the stage point that must not move.
 * @returns the anchored transform.
 */
export function zoomAt(view: ViewTransform, scale: number, anchor: StagePoint): ViewTransform {
  if (view.scale <= 0) return { scale, tx: 0, ty: 0 }
  const ratio = scale / view.scale
  return {
    scale,
    tx: anchor.x - (anchor.x - view.tx) * ratio,
    ty: anchor.y - (anchor.y - view.ty) * ratio,
  }
}

/**
 * Convert a stage point into image edge coordinates (fractional until snapped).
 * @param view - the current transform.
 * @param point - the stage point.
 * @returns the edge coordinates (may sit outside the image).
 */
export function stageToEdge(view: ViewTransform, point: StagePoint): EdgePoint {
  return {
    x: (point.x - view.tx) / view.scale,
    y: (point.y - view.ty) / view.scale,
  }
}

/**
 * Convert an image edge point back into stage coordinates.
 * @param view - the current transform.
 * @param point - the edge coordinates.
 * @returns the stage point.
 */
export function edgeToStage(view: ViewTransform, point: EdgePoint): StagePoint {
  return {
    x: view.tx + point.x * view.scale,
    y: view.ty + point.y * view.scale,
  }
}

/**
 * Snap a fractional edge point to the nearest pixel border inside the image.
 * 0 is the top/left outer border, `width`/`height` the bottom/right one.
 * @param point - the fractional edge coordinates.
 * @param image - the decoded image size.
 * @returns the snapped edge point.
 */
export function snapToEdge(point: EdgePoint, image: ImageSize): EdgePoint {
  return {
    x: clamp(Math.round(point.x), 0, image.width),
    y: clamp(Math.round(point.y), 0, image.height),
  }
}

/**
 * The pixel cell under a stage point, or `null` when the point is outside the
 * image. Used by the status bar readout.
 * @param view - the current transform.
 * @param point - the stage point.
 * @param image - the decoded image size.
 * @returns the 0-based pixel index.
 */
export function pixelUnderStage(view: ViewTransform, point: StagePoint, image: ImageSize): PixelPoint | null {
  const edge = stageToEdge(view, point)
  if (edge.x < 0 || edge.y < 0 || edge.x >= image.width || edge.y >= image.height) return null
  return {
    x: clamp(Math.floor(edge.x), 0, image.width - 1),
    y: clamp(Math.floor(edge.y), 0, image.height - 1),
  }
}

/** The geometric length of a measured segment, in pixels. */
export interface DistanceMeasurement {
  /** Horizontal edge difference (`b.x - a.x`). */
  dx: number
  /** Vertical edge difference (`b.y - a.y`). */
  dy: number
  /** Euclidean length. */
  length: number
}

/**
 * Measure one segment between two snapped edge points.
 * @param a - the start edge.
 * @param b - the end edge.
 * @returns dx / dy / Euclidean length.
 */
export function distanceOf(a: EdgePoint, b: EdgePoint): DistanceMeasurement {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return { dx, dy, length: Math.hypot(dx, dy) }
}

/**
 * Lock one segment to its dominant axis. A single-axis measurement may only be
 * horizontal or vertical: a mostly horizontal drag keeps the start row, a
 * mostly vertical drag keeps the start column. Ties (`|dx| === |dy|`) go
 * horizontal.
 * @param a - the fixed start edge.
 * @param b - the pointer's snapped edge.
 * @returns the end edge, moved onto the dominant axis.
 */
export function constrainAxis(a: EdgePoint, b: EdgePoint): EdgePoint {
  if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) return { x: b.x, y: a.y }
  return { x: a.x, y: b.y }
}

/**
 * Distance from a point to a segment, in the segment's own units (the caller
 * passes stage-space points, so the answer is CSS px).
 * @param point - the query point.
 * @param a - the segment's start.
 * @param b - the segment's end.
 * @returns the shortest distance to the segment.
 */
export function distanceToSegment(point: StagePoint, a: StagePoint, b: StagePoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1)
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/**
 * Distance from a point to a rectangle's border, in the caller's units. A point
 * inside answers the distance to the nearest edge; an outside point answers the
 * distance to the nearest point of the rectangle (an edge or a corner).
 * @param point - the query point.
 * @param topLeft - the rectangle's top-left corner.
 * @param bottomRight - the rectangle's bottom-right corner.
 * @returns the shortest distance to the border.
 */
export function distanceToRectBorder(
  point: StagePoint,
  topLeft: StagePoint,
  bottomRight: StagePoint,
): number {
  const insideX = point.x >= topLeft.x && point.x <= bottomRight.x
  const insideY = point.y >= topLeft.y && point.y <= bottomRight.y
  if (insideX && insideY) {
    return Math.min(
      point.x - topLeft.x,
      bottomRight.x - point.x,
      point.y - topLeft.y,
      bottomRight.y - point.y,
    )
  }
  const nearestX = clamp(point.x, topLeft.x, bottomRight.x)
  const nearestY = clamp(point.y, topLeft.y, bottomRight.y)
  return Math.hypot(point.x - nearestX, point.y - nearestY)
}

/** One measured rectangle, normalized to a top-left origin. */
export interface CoveredRect {
  /** Left edge of the covered range. */
  left: number
  /** Top edge of the covered range. */
  top: number
  /** Right edge (exclusive in pixel cells). */
  right: number
  /** Bottom edge (exclusive in pixel cells). */
  bottom: number
  /** Width in pixel cells. */
  width: number
  /** Height in pixel cells. */
  height: number
  /** Number of pixel cells covered (`width × height`). */
  count: number
}

/**
 * The pixel-cell rectangle enclosed by two snapped edges, normalized.
 * @param a - one edge point.
 * @param b - the other edge point.
 * @returns the covered rectangle; `width`/`height` are the edge differences.
 */
export function coveredRect(a: EdgePoint, b: EdgePoint): CoveredRect {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(a.x, b.x)
  const bottom = Math.max(a.y, b.y)
  const width = right - left
  const height = bottom - top
  return { left, top, right, bottom, width, height, count: width * height }
}

/** One axis of the "covered pixel nearest this endpoint" rule. */
function endpointAxis(edge: number, other: number, size: number): number {
  if (edge === other) return clamp(edge, 0, size - 1)
  // The lower edge is the first covered pixel's border; the higher edge is
  // the last covered pixel's far border, so the pixel before it is covered.
  return clamp(edge > other ? edge - 1 : edge, 0, size - 1)
}

/**
 * The pixel cell nearest one endpoint of a segment, on each axis.
 *
 * A vertical segment from edge 0 to edge 5 covers rows 0–4: the start label is
 * row 0 and the end label is row 4. Selecting the other way around flips the
 * labels, never the count.
 * @param point - this endpoint (snapped edge coordinates).
 * @param other - the other endpoint.
 * @param image - the decoded image size.
 * @returns the 0-based pixel label for this endpoint.
 */
export function endpointPixel(point: EdgePoint, other: EdgePoint, image: ImageSize): PixelPoint {
  return {
    x: endpointAxis(point.x, other.x, image.width),
    y: endpointAxis(point.y, other.y, image.height),
  }
}

/**
 * Format a zoom scale as the percentage the toolbar shows. The reader asked
 * for no decimal percentages: every interaction step is quantized to 1%
 * first (see {@link quantizeZoom}), so the display is a whole number above 1%.
 * Below 1% (only a very large document fitted down) one decimal still has to
 * exist, or the readout would collapse to 0%.
 * @param scale - CSS pixels per image pixel (1 = 100%).
 * @returns a compact percentage.
 */
export function formatZoom(scale: number): string {
  const percent = scale * 100
  if (percent >= 1) return `${Math.round(percent)}%`
  if (percent >= 0.1) return `${percent.toFixed(1)}%`
  return `${percent.toFixed(2)}%`
}

/**
 * Snap a zoom scale to a whole percentage point (0.1% below 1%).
 *
 * Why: fractional zoom percentages were the visible symptom of the old
 * screen-space overlay drifting off the bitmap's pixel borders. The geometry
 * now shares the bitmap's scaled layer (so that is fixed structurally), and
 * this keeps the reader's zoom steps on clean values: 1756%, never 1756.2%.
 * The fit scale is intentionally left exact; it is a one-shot framing, not a
 * step the reader takes.
 * @param scale - the raw scale produced by a wheel notch or a toolbar button.
 * @returns the quantized scale, inside the supported range.
 */
export function quantizeZoom(scale: number): number {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
  if (clamped >= 0.01) return Math.round(clamped * 100) / 100
  return Math.round(clamped * 1000) / 1000
}
