/**
 * The visible slice of a fixed-height row list (the commit graph's history).
 *
 * `page.entries` grows by one infinite-scroll page at a time (50 rows; the
 * host caps the walk at 10000) and every row carries an SVG rail, so mounting
 * the whole history made each append and each scroll cost O(history). Only
 * the viewport window (± overscan) is mounted; the two spacer heights keep the
 * real scrollbar, the end sentinel's position and the `data-graph-count` page
 * size intact.
 *
 * The arithmetic is pure and clamped on purpose: the list can shrink under the
 * scroll position (a branch switch, a refresh collapses the page), and the
 * browser only clamps `scrollTop` afterwards — a stale `scrollTop` must never
 * translate into an out-of-range window (that would render the wrong rows
 * while the scrollbar sits at the top).
 */
export interface WindowedRange {
  /** First mounted row (inclusive). */
  start: number
  /** One past the last mounted row. */
  end: number
  /** Pixel height of the rows above the window. */
  top: number
  /** Pixel height of the rows below the window. */
  bottom: number
}

export interface WindowedRangeOptions {
  /** Total number of rows in the list. */
  count: number
  /** Height of one row in pixels (the graph's rows are a fixed 28). */
  rowHeight: number
  /** The scroll container's current `scrollTop`. */
  scrollTop: number
  /** The scroll container's client height; 0 before it is measured. */
  viewportHeight: number
  /** Extra rows kept mounted above and below the viewport (default 8). */
  overscan?: number
}

/**
 * Compute the mounted row range for one scroll position.
 * @param options - row count/height, scroll position, viewport height and overscan.
 * @returns The clamped half-open range plus the two spacer heights.
 */
export function windowedRange(options: WindowedRangeOptions): WindowedRange {
  const { count, rowHeight, scrollTop, viewportHeight } = options
  const overscan = Math.max(0, options.overscan ?? 8)
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, top: 0, bottom: 0 }
  // A container that is not measured yet still mounts one row plus the
  // overscan band, so the first paint is not empty and the height feedback
  // loop (measure → render) has content to measure.
  const rowsInView = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight))
  const visible = rowsInView + overscan * 2
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan
  const start = Math.min(Math.max(0, first), count - 1)
  const end = Math.min(count, start + visible)
  return {
    start,
    end,
    top: start * rowHeight,
    bottom: (count - end) * rowHeight,
  }
}
