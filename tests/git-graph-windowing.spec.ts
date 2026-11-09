/**
 * The commit graph mounts only the viewport window of its history rows (the
 * list is unbounded: infinite scroll appends 50 at a time up to the host's
 * 10000 cap, and every row carries an SVG rail). This is the pure arithmetic
 * behind it — the component test in `git-graph-ui.spec.tsx` pins the wiring.
 *
 * The clamping cases matter: the list SHRINKS under the scroll position when
 * the branch selection changes or a refresh drops the page, and the browser
 * clamps `scrollTop` a frame later. A stale scrollTop must never point the
 * window past the end of the new list.
 */
import { describe, expect, it } from 'vitest'
import { windowedRange } from '../src/client/changes/git-graph-windowing.ts'

const ROW = 28

describe('windowedRange', () => {
  it('renders nothing for an empty list', () => {
    expect(windowedRange({ count: 0, rowHeight: ROW, scrollTop: 0, viewportHeight: 560 }))
      .toEqual({ start: 0, end: 0, top: 0, bottom: 0 })
  })

  it('mounts the whole list when it is shorter than the viewport', () => {
    expect(windowedRange({ count: 10, rowHeight: ROW, scrollTop: 0, viewportHeight: 560 }))
      .toEqual({ start: 0, end: 10, top: 0, bottom: 0 })
  })

  it('mounts the first page plus overscan before the viewport is measured', () => {
    // viewportHeight 0 (jsdom, or a hidden panel): one row of view plus the
    // 8-row band on each side.
    expect(windowedRange({ count: 200, rowHeight: ROW, scrollTop: 0, viewportHeight: 0 }))
      .toEqual({ start: 0, end: 17, top: 0, bottom: 183 * ROW })
  })

  it('follows the scroll position with one overscan band on each side', () => {
    // 560px viewport = 20 rows; scrolled to row 50.
    expect(windowedRange({ count: 200, rowHeight: ROW, scrollTop: 50 * ROW, viewportHeight: 560 }))
      .toEqual({ start: 42, end: 78, top: 42 * ROW, bottom: 122 * ROW })
  })

  it('stops at the end of the list (no spacer below the last row)', () => {
    expect(windowedRange({ count: 200, rowHeight: ROW, scrollTop: 199 * ROW, viewportHeight: 560 }))
      .toEqual({ start: 191, end: 200, top: 191 * ROW, bottom: 0 })
  })

  it('clamps a stale scrollTop that outlived a shrinking list', () => {
    // Branch switch: 200 rows -> 5 rows, the browser has not clamped yet.
    expect(windowedRange({ count: 5, rowHeight: ROW, scrollTop: 100_000, viewportHeight: 560 }))
      .toEqual({ start: 4, end: 5, top: 4 * ROW, bottom: 0 })
  })

  it('honours an explicit overscan (0 = exactly the viewport)', () => {
    expect(windowedRange({ count: 200, rowHeight: ROW, scrollTop: 50 * ROW, viewportHeight: 560, overscan: 0 }))
      .toEqual({ start: 50, end: 70, top: 50 * ROW, bottom: 130 * ROW })
  })
})
