/**
 * Image preview with wheel zoom and drag panning.
 *
 * The picture starts at FIT — stretched to the stage's content box and
 * `object-fit: contain`ed inside it, which is the box the viewer also measures
 * its panning against — and every gesture only ever scales it UP from there:
 * the wheel zooms around the cursor, a pointer drag pans, a double click
 * toggles fit ↔ 2×, and the toolbar carries the zoom readout plus −/reset/+
 * commands. Zooming out below fit would only shrink the picture inside a box
 * it already fits, so `1` is the floor — the one baseline the layout defines.
 *
 * Panning is bounded by that same box: at zoom `z` the picture is `box × z`
 * wide against a `box`-wide window, so the slack is `box × (z - 1) / 2` and
 * the picture can never be dragged away from its own edge (which is what a
 * naive bound — the picture's untransformed layout box — would allow at low
 * zoom levels).
 *
 * Why the transforms are written to the DOM instead of through state: a wheel
 * gesture fires dozens of times per second, and a React render per tick would
 * re-run this viewer's whole subtree for a transform that only the browser
 * needs to hear about. `zoomRef` is the source of truth; the `zoom` state
 * exists solely for the toolbar readout, so it changes at most once per
 * gesture step.
 *
 * The pinch gesture and the wheel share one path: a trackpad pinch arrives as
 * a wheel event with `ctrlKey` set, so it is handled by the same handler and
 * `preventDefault()`ed — which also keeps the browser's page zoom out of it.
 * The native (non-passive) listener is required for that `preventDefault`, as
 * React's synthetic wheel listener is passive (same reason as the mermaid zoom
 * modal, whose gesture maths this viewer follows).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Largest zoom the gestures may reach (the readout shows e.g. `1600%`). */
const MAX_ZOOM = 16
/** One wheel notch / button click step. */
const ZOOM_STEP = 1.1
/** What a double click zooms to from fit. */
const DOUBLE_CLICK_ZOOM = 2

/** Clamp `value` into `[min, max]` (inverted ranges collapse to `min`). */
export function clampZoom(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * New zoom + translation for a zoom step anchored at one stage point.
 *
 * The stage centers its child with flexbox, so the picture's center sits at
 * the stage's center and the transform only has to keep the anchor point
 * stationary while the scale changes: the offset between the anchor and the
 * center shrinks (or grows) by exactly the scale ratio. `translate` is applied
 * BEFORE `scale` in the transform list, so the translation itself is in
 * unscaled stage pixels — which is what the anchor maths assumes.
 *
 * @param current - The zoom/translation in effect before the step.
 * @param ratio - Scale multiplier (`newZoom / current.zoom`).
 * @param anchor - The point to keep fixed, in stage coordinates.
 * @param stageWidth - The stage's width in CSS pixels.
 * @param stageHeight - The stage's height in CSS pixels.
 * @returns The new zoom and translation (both in stage pixels).
 */
export function zoomedTransform(
  current: { zoom: number; tx: number; ty: number },
  ratio: number,
  anchor: { x: number; y: number },
  stageWidth: number,
  stageHeight: number,
): { zoom: number; tx: number; ty: number } {
  const zoom = current.zoom * ratio
  const grow = zoom / current.zoom
  const cx = stageWidth / 2
  const cy = stageHeight / 2
  return {
    zoom,
    tx: anchor.x - cx - (anchor.x - cx - current.tx) * grow,
    ty: anchor.y - cy - (anchor.y - cy - current.ty) * grow,
  }
}

/** The pan offsets that keep `zoom`ed content inside its stage. */
export function clampPan(
  zoom: number,
  tx: number,
  ty: number,
  imageWidth: number,
  imageHeight: number,
  stageWidth: number,
  stageHeight: number,
): { tx: number; ty: number } {
  const span = (scaled: number, box: number): number => Math.max(0, (scaled - box) / 2)
  const limitX = span(imageWidth * zoom, stageWidth)
  const limitY = span(imageHeight * zoom, stageHeight)
  // `+ 0` folds the -0 that `Math.max(-limit, ...)` can produce: the offsets
  // are written into a transform string, and `translate(-0px)` is only noise.
  return {
    tx: Math.min(limitX, Math.max(-limitX, tx)) + 0,
    ty: Math.min(limitY, Math.max(-limitY, ty)) + 0,
  }
}

/**
 * The box a fitted picture fills: the stage's own content box.
 *
 * NOT the image's `offsetWidth`: the picture is stretched to 100% of this box
 * and then scaled by the transform, so its layout size stays fixed while its
 * painted size grows. Panning has to be bounded by what is on screen —
 * `content × zoom` against `content` — which is exactly what this gives.
 */
function stageContentBox(stage: HTMLElement): { width: number; height: number } {
  let padX = 0
  let padY = 0
  const view = stage.ownerDocument.defaultView
  if (view !== null) {
    const style = view.getComputedStyle(stage)
    const px = (value: string): number => {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    padX = px(style.paddingLeft) + px(style.paddingRight)
    padY = px(style.paddingTop) + px(style.paddingBottom)
  }
  return { width: Math.max(0, stage.offsetWidth - padX), height: Math.max(0, stage.offsetHeight - padY) }
}

/**
 * A stretched image draws at its intrinsic size and lets the transform scale
 * it down; `object-fit: contain` (the CSS default here) letterboxes the image
 * inside that box instead, so the painted picture and its hit area disagree
 * and the cursor-anchored zoom drifts. `stretch` (below) is what makes the
 * box and the fit box the same thing.
 */
const STRETCH_STYLE = { width: '100%', height: '100%', objectFit: 'contain' } as const

export function ImageView(props: { mediaUrl?: string; title: string }) {
  const { mediaUrl: url, title } = props
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const zoomRef = useRef({ zoom: 1, tx: 0, ty: 0 })
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null)
  const [zoom, setZoom] = useState(1)

  /** Push `zoomRef` onto the image and remember the readout's zoom. */
  const apply = useCallback((): void => {
    const img = imgRef.current
    if (img === null) return
    const current = zoomRef.current
    current.zoom = clampZoom(current.zoom, 1, MAX_ZOOM)
    const stage = stageRef.current
    if (stage !== null) {
      const box = stageContentBox(stage)
      const fixed = clampPan(current.zoom, current.tx, current.ty, box.width, box.height, box.width, box.height)
      current.tx = fixed.tx
      current.ty = fixed.ty
    }
    img.style.transform = `translate(${current.tx}px, ${current.ty}px) scale(${current.zoom})`
    if (img.dataset.imageZoom !== String(current.zoom)) img.dataset.imageZoom = String(current.zoom)
    setZoom(previous => (previous === current.zoom ? previous : current.zoom))
  }, [])

  /** Zoom by `ratio`, keeping `anchor` (stage coordinates) stationary. */
  const zoomBy = useCallback((ratio: number, anchor?: { x: number; y: number }): void => {
    const stage = stageRef.current
    if (stage === null) return
    const current = zoomRef.current
    const next = clampZoom(current.zoom * ratio, 1, MAX_ZOOM)
    if (next === current.zoom) return
    // The stage's content box, not getBoundingClientRect(): it is the box the
    // offsets are clamped against (see `apply`) and it stays meaningful where
    // a rect is unavailable or degenerate. The picture's centre sits at the
    // stage's centre because the stage is a flex centring container.
    const box = stageContentBox(stage)
    const point = anchor ?? { x: box.width / 2, y: box.height / 2 }
    zoomRef.current = zoomedTransform(current, next / current.zoom, point, box.width, box.height)
    apply()
  }, [apply])

  /** Back to fit: no scale, no offset. */
  const reset = useCallback((): void => {
    zoomRef.current = { zoom: 1, tx: 0, ty: 0 }
    apply()
  }, [apply])

  // Wheel + drag. Both run on the stage node rather than through React
  // handlers: the wheel listener must be non-passive to preventDefault, and
  // pointer capture on the stage keeps a drag alive outside the pane.
  useEffect(() => {
    const stage = stageRef.current
    const img = imgRef.current
    if (stage === null || img === null) return

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      event.preventDefault()
      // Client coordinates are viewport-relative; the anchor must be stage-
      // relative, hence the offset by the stage's own top-left corner.
      const rect = stage.getBoundingClientRect()
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      event.preventDefault()
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX - zoomRef.current.tx,
        startY: event.clientY - zoomRef.current.ty,
      }
      // Capture keeps the drag alive when the pointer leaves the pane. It can
      // be refused (a synthetic event with no active pointer, an embedder
      // without the API), and a refused capture must not cost us the drag —
      // the move handler below works on the stage either way.
      try { stage.setPointerCapture(event.pointerId) } catch { /* drag still works */ }
      stage.dataset.imageDragging = ''
    }
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      zoomRef.current.tx = event.clientX - drag.startX
      zoomRef.current.ty = event.clientY - drag.startY
      apply()
    }
    const endDrag = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      // The last move may have carried the picture past its clamp (or the
      // zoom may have changed under the pointer); settle it against the
      // current limits before the drag goes away. Dropping the ref first
      // makes this the final word — no further move can follow this release.
      dragRef.current = null
      apply()
      delete stage.dataset.imageDragging
      try { if (stage.hasPointerCapture(drag.pointerId)) stage.releasePointerCapture(drag.pointerId) } catch { /* already gone */ }
    }
    const onDoubleClick = (event: MouseEvent): void => {
      if (zoomRef.current.zoom > 1) {
        reset()
        return
      }
      const rect = stage.getBoundingClientRect()
      zoomBy(DOUBLE_CLICK_ZOOM, { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === '+' || event.key === '=') zoomBy(1.2)
      else if (event.key === '-' || event.key === '_') zoomBy(1 / 1.2)
      else if (event.key === '0') reset()
    }
    // A pane resize changes the room the offsets were clamped against; without
    // this the picture can sit outside the visible box after the drag that
    // widened the sidebar, or stay off-center after it narrowed.
    const onResize = (): void => { apply() }

    stage.addEventListener('wheel', onWheel, { passive: false })
    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointermove', onPointerMove)
    stage.addEventListener('pointerup', endDrag)
    stage.addEventListener('pointercancel', endDrag)
    stage.addEventListener('dblclick', onDoubleClick)
    stage.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointermove', onPointerMove)
      stage.removeEventListener('pointerup', endDrag)
      stage.removeEventListener('pointercancel', endDrag)
      stage.removeEventListener('dblclick', onDoubleClick)
      stage.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  }, [apply, reset, zoomBy])

  // A different picture starts from fit again: the previous offsets were
  // clamped against the previous image's size.
  useEffect(() => {
    zoomRef.current = { zoom: 1, tx: 0, ty: 0 }
    apply()
  }, [url, apply])

  const percent = useMemo(() => `${Math.round(zoom * 100)}%`, [zoom])

  return (
    <div className={css.editorImageView}>
      <div className={css.editorImageToolbar}>
        <button
          type="button"
          className={css.editorImageButton}
          title={t('mermaidZoomOut')}
          aria-label={t('mermaidZoomOut')}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          −
        </button>
        <span className={css.editorImageZoom} data-image-zoom-readout>{percent}</span>
        <button
          type="button"
          className={css.editorImageButton}
          title={t('mermaidZoomIn')}
          aria-label={t('mermaidZoomIn')}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className={css.editorImageButton}
          title={t('mermaidZoomReset')}
          aria-label={t('mermaidZoomReset')}
          onClick={reset}
        >
          ⟲
        </button>
      </div>
      <div
        className={css.editorImageStage}
        ref={stageRef}
        tabIndex={0}
        role="group"
        aria-label={title}
        data-image-stage=""
      >
        <img
          className={css.editorImage}
          ref={imgRef}
          data-image=""
          src={url}
          alt={title}
          draggable={false}
          onLoad={apply}
          style={STRETCH_STYLE}
        />
      </div>
    </div>
  )
}
