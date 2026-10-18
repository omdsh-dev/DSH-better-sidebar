/**
 * The Tasks graph's layout TWEEN: the canvas animates in ITS OWN coordinate
 * space (each card's `x` / `y` / height), not with screen-space transforms.
 *
 * Why not a FLIP library: the card layer carries the fit's
 * `transform: scale(k)`, so a library that measures `getBoundingClientRect()`
 * and replays `translate()` in unscaled units is off by k on every move — and
 * `@formkit/auto-animate` additionally pins a leaving card with absolute
 * `left/top` derived from those rects, a box the scaled layer cannot express at
 * all (the card jumps). Measured live, both read as "折叠展开的动效都特别怪".
 *
 * Animating the layout coordinates has neither problem: `left`/`top` are the
 * canvas's own units, so the fit's scale applies to the tween exactly as it
 * applies to the final positions. And because every derived surface — the
 * connector paths, the phase frames — is a pure function of the boxes, they
 * follow the cards frame by frame instead of snapping to the new geometry while
 * the cards are still travelling.
 *
 * Scope: this animates POSITION only (x / y / height). A card that ENTERS gets
 * its CSS entrance (see tasks-graph.module.css) and a card that LEAVES is
 * removed at once — a ghost layer for exits is not worth its bookkeeping here,
 * and the aggregate that replaces the members is itself an entering card.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphBox, GraphLayout } from './tasks-graph-layout.ts'

/** How long one layout change takes to settle (ms). */
export const TWEEN_MS = 220

/** The tween's easing: fast out of the gate, gently into place (ease-out cubic). */
export function easeOut(progress: number): number {
  const t = Math.min(1, Math.max(0, progress))
  return 1 - (1 - t) ** 3
}

/** One box's geometry, the part a tween interpolates. */
interface BoxGeometry {
  x: number
  y: number
  w: number
  h: number
}

/** Geometry of one box, or undefined when the tween has no previous slot for it. */
function geometryOf(box: GraphBox | undefined): BoxGeometry | undefined {
  return box === undefined ? undefined : { x: box.x, y: box.y, w: box.w, h: box.h }
}

/**
 * Interpolate one box between two geometries. A box with no `from` (it just
 * entered) stays at its target — the entrance animation owns that moment, and
 * sliding it in from a slot it never had would be a lie.
 *
 * @param from - the previously displayed geometry (undefined = just entered).
 * @param to - the target box.
 * @param progress - 0…1, already eased by the caller.
 */
export function tweenBox(from: BoxGeometry | undefined, to: GraphBox, progress: number): GraphBox {
  if (from === undefined) return to
  const mix = (a: number, b: number): number => a + (b - a) * progress
  return {
    id: to.id,
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    w: mix(from.w, to.w),
    h: mix(from.h, to.h),
  }
}

/**
 * The layout as it should be DRAWN right now: the target for a first render and
 * for a reader who asked for less motion, a tweened copy after that.
 *
 * @param layout - the freshly computed layout (the tween's target).
 * @returns boxes to render, plus the target canvas extent (the canvas never
 *   resizes mid-flight: the tween only moves the cards inside it).
 */
export function useTweenedLayout(layout: GraphLayout): GraphLayout {
  /** The geometry the current animation starts from (the last drawn state). */
  const fromRef = useRef<ReadonlyMap<string, GraphBox> | undefined>(undefined)
  const [drawnBoxes, setDrawnBoxes] = useState<ReadonlyMap<string, GraphBox>>(layout.boxes)

  useEffect(() => {
    const from = fromRef.current
    // First paint, or a reader who opted out of motion: snap to the target.
    if (from === undefined || prefersReducedMotion()) {
      fromRef.current = layout.boxes
      setDrawnBoxes(layout.boxes)
      return
    }
    // Nothing moved (a poll that changed only labels/state): keep the boxes we
    // have, so React does not re-render every card for an identical Map.
    if (sameGeometry(from, layout.boxes)) {
      fromRef.current = layout.boxes
      return
    }
    let frame = 0
    const started = performance.now()
    const step = (): void => {
      const progress = easeOut((performance.now() - started) / TWEEN_MS)
      const next = interpolate(from, layout.boxes, progress)
      // The ref follows the DRAWN state, not the target: a layout change that
      // interrupts a running tween then resumes from where the cards actually
      // are instead of snapping them back to the previous target.
      fromRef.current = progress < 1 ? next : layout.boxes
      setDrawnBoxes(next)
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(frame) }
  }, [layout])

  useEffect(() => () => { fromRef.current = undefined }, [])

  /**
   * What to draw. The tween's boxes are completed with the TARGET geometry for
   * any node they do not carry yet: a node that just entered has no previous
   * slot to travel from, and the render that introduces it must already have a
   * box for it (its CSS entrance is that moment — leaving it out for the one
   * render before the effect runs would blink the whole node away).
   */
  const boxes = useMemo(() => {
    for (const id of layout.boxes.keys()) if (!drawnBoxes.has(id)) {
      const merged = new Map(drawnBoxes)
      for (const [targetId, box] of layout.boxes) if (!merged.has(targetId)) merged.set(targetId, box)
      return merged
    }
    return drawnBoxes
  }, [drawnBoxes, layout])

  // The extent is always the target's: a canvas that resized while the cards
  // were still travelling would move the reader's frame under them.
  return useMemo(
    () => ({ boxes, width: layout.width, height: layout.height }),
    [boxes, layout.width, layout.height],
  )
}

/** Whether the reader asked the platform for less motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Whether two box maps already agree on every geometry. */
function sameGeometry(
  a: ReadonlyMap<string, GraphBox>,
  b: ReadonlyMap<string, GraphBox>,
): boolean {
  if (a.size !== b.size) return false
  for (const [id, box] of b) {
    const previous = a.get(id)
    if (previous === undefined) return false
    if (previous.x !== box.x || previous.y !== box.y || previous.w !== box.w || previous.h !== box.h) {
      return false
    }
  }
  return true
}

/** One tweened copy of `to`, using `from` for the boxes that were on screen. */
function interpolate(
  from: ReadonlyMap<string, GraphBox>,
  to: ReadonlyMap<string, GraphBox>,
  progress: number,
): ReadonlyMap<string, GraphBox> {
  const out = new Map<string, GraphBox>()
  for (const [id, box] of to) {
    out.set(id, tweenBox(geometryOf(from.get(id)), box, progress))
  }
  return out
}
