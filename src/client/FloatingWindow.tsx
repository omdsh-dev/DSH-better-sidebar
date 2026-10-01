/**
 * The plugin's reusable PERSISTENT floating window: a draggable, resizable,
 * body-portaled card with its own title bar, close button and scrolling body.
 *
 * Why a second window primitive next to {@link AnchoredPopover}: that one is a
 * POPOVER — it is anchored to an element, sized to its content, and dismissed
 * by any interaction outside it (outside mousedown, window blur, its anchor
 * leaving the viewport). That contract is exactly wrong for a surface the
 * reader WATCHES for minutes: a job's output must survive clicking elsewhere,
 * must not grow past the viewport, and must keep its place while the work
 * runs. This component therefore carries the opposite lifecycle — only the
 * close button and Escape end it — plus the two interactions a watched pane
 * needs: move it out of the way, and resize it to the log at hand.
 *
 * The body is the window's own scroll container, which is what bounds a long
 * output (the popover it replaces had no height limit at all, so a chatty job
 * simply ran off screen). Callers that follow a live tail pass `bodyRef` and
 * scroll it themselves.
 *
 * Mechanics reuse the two proven patterns of this codebase rather than
 * inventing a third: the MOVE rides window-level pointer listeners (the
 * `AnchoredPopover` drag — capture on the container would retarget the
 * derived click and kill the buttons inside), and the RESIZE rides
 * `setPointerCapture` on the handle plus a `createFrameBatcher` per-frame
 * commit (the `EditorHost` docked-panel resize; a per-event setState on a
 * streamed log is the visible drag lag of #315).
 *
 * Skin contract: tokens only (`--dsw-alias-*` / `--dsw-font-*`), the floating
 * layer keeps the app's `--dsw-shadow-lv3`, and the radius matches the Tasks
 * page's node cards (8px).
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Button, IconCloseFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { createFrameBatcher } from './frame-batcher.ts'
import { t } from './locales.ts'
import css from './FloatingWindow.module.css'

/** Default share of the viewport a fresh window takes. */
const DEFAULT_WIDTH_RATIO = 0.7
const DEFAULT_HEIGHT_RATIO = 0.6
/** Default floor, and the hard floor a resize can never cross. */
const DEFAULT_MIN_WIDTH = 320
const DEFAULT_MIN_HEIGHT = 240
/** How much of the title bar must stay on screen while dragging. */
const KEEP_ON_SCREEN = 48
/** Free space kept at the viewport edges. */
const VIEWPORT_MARGIN = 8
/** Room a window never takes from the viewport (title bar + margins). */
const MIN_VIEWPORT_HEIGHT = 160

/** One window box, viewport coordinates. */
interface WindowBox {
  left: number
  top: number
  width: number
  height: number
}

export interface FloatingWindowProps {
  /** Title-bar text (also the dialog's accessible name). */
  title: string
  /** Close (the button, or Escape). */
  onClose(): void
  /** Initial size; omitted → 70% × 60% of the viewport, then clamped. */
  initialSize?: { width: number; height: number }
  /** Resize floor; omitted → 320 × 240. */
  minSize?: { width: number; height: number }
  /**
   * Where the window first appears: just below-right of this element (the
   * row that opened it). Omitted / off-screen anchors centre it.
   */
  anchor?: HTMLElement | null
  /** Header controls, left of the close button (a job's copy action). */
  actions?: ReactNode
  /** Bottom action row (a job's follow switch + stop control). */
  footer?: ReactNode
  /**
   * The scrollable body element, for callers that follow a live tail. The
   * caller scrolls it; the window owns its size and its overflow.
   */
  bodyRef?: RefObject<HTMLDivElement>
  /**
   * How the body stacks its children. `scroll` (default) flows them from the
   * top inside the scrolling box — right for a log or a table. `fill` makes
   * the body a column whose children stretch to the window's height — right
   * for a detail view or a form, where the point of enlarging the window is
   * more room for the content, not more empty space under it.
   */
  bodyLayout?: 'scroll' | 'fill'
  children: ReactNode
}

/** Clamp one number into `[min, max]` (max first, so an inverted range is safe). */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), Math.max(min, max))
}

/**
 * Clamp one axis of a window's origin. The rule is "keep the WHOLE window on
 * screen when it fits, and otherwise keep {@link KEEP_ON_SCREEN}px of it (its
 * title bar / its right edge) reachable": a window that hangs off the bottom
 * edge hides its own resize corner, which is exactly how the first real-host
 * check lost it.
 */
function clampOrigin(start: number, size: number, viewport: number): number {
  const fullyInside = viewport - size - VIEWPORT_MARGIN
  return fullyInside >= VIEWPORT_MARGIN
    ? clamp(start, VIEWPORT_MARGIN, fullyInside)
    : clamp(start, KEEP_ON_SCREEN - size, viewport - KEEP_ON_SCREEN)
}

/** The viewport-clamped initial box of one window. */
function initialBox(
  anchor: HTMLElement | null | undefined,
  size: { width: number; height: number } | undefined,
  min: { width: number; height: number },
  viewport: { width: number; height: number },
): WindowBox {
  const width = clamp(
    size?.width ?? viewport.width * DEFAULT_WIDTH_RATIO,
    min.width,
    Math.max(min.width, viewport.width - VIEWPORT_MARGIN * 2),
  )
  const height = clamp(
    size?.height ?? viewport.height * DEFAULT_HEIGHT_RATIO,
    min.height,
    Math.max(min.height, viewport.height - VIEWPORT_MARGIN * 2),
  )
  const rect = anchor?.getBoundingClientRect()
  const left = rect === undefined
    ? (viewport.width - width) / 2
    : clamp(rect.left, VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN)
  const top = rect === undefined
    ? Math.max(VIEWPORT_MARGIN, (viewport.height - height) / 2)
    : clamp(rect.bottom + 6, VIEWPORT_MARGIN, viewport.height - height - VIEWPORT_MARGIN)
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * Render a persistent floating window. The caller owns WHAT is shown (body,
 * header actions, footer); this component owns the frame, the geometry, the
 * two drag gestures and the dismissal contract (close button + Escape only).
 */
export function FloatingWindow(props: FloatingWindowProps): ReactNode {
  const {
    title, onClose, initialSize, minSize, anchor, actions, footer, bodyRef, bodyLayout, children,
  } = props
  const min = useMemo(() => ({
    width: minSize?.width ?? DEFAULT_MIN_WIDTH,
    height: minSize?.height ?? DEFAULT_MIN_HEIGHT,
  }), [minSize?.width, minSize?.height])
  const frameRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  /**
   * The box is measured ONCE, on mount, from the live viewport: a later
   * re-render (a streamed output frame, a status flip) must never move or
   * resize a window the reader placed.
   */
  const [box, setBox] = useState<WindowBox | null>(null)
  const boxRef = useRef(box)
  boxRef.current = box

  useEffect(() => {
    setBox(initialBox(anchor, initialSize, min, {
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    // Mount-only on purpose: see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Keep the box reachable after a viewport change (a rotation, a split pane). */
  useEffect(() => {
    const onResize = (): void => {
      const current = boxRef.current
      if (current === null) return
      const width = clamp(current.width, min.width, Math.max(min.width, window.innerWidth - VIEWPORT_MARGIN * 2))
      const height = clamp(
        current.height,
        min.height,
        Math.max(min.height, window.innerHeight - MIN_VIEWPORT_HEIGHT),
      )
      setBox({
        width,
        height,
        left: clampOrigin(current.left, width, window.innerWidth),
        top: clampOrigin(current.top, height, window.innerHeight),
      })
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [min.width, min.height])

  // Escape only: no outside-click, no blur, no anchor observer (see the header).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [])

  /** Drag the window by its title bar (buttons inside it keep working). */
  const onTitlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    // The header's own controls (copy, close) must not start a drag.
    if (target.closest('button, input, textarea, select, a, [data-window-no-drag]') !== null) return
    const start = boxRef.current
    if (start === null) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const onMove = (move: PointerEvent): void => {
      setBox({
        ...start,
        left: clampOrigin(start.left + (move.clientX - startX), start.width, window.innerWidth),
        top: clampOrigin(start.top + (move.clientY - startY), start.height, window.innerHeight),
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  /** Resize from one edge handle: `axis` picks which dimension the handle owns. */
  const resizeBatcher = useRef(createFrameBatcher()).current
  useEffect(() => () => { resizeBatcher.dispose() }, [resizeBatcher])
  const resizeRef = useRef<{ startX: number; startY: number; box: WindowBox; axis: 'x' | 'y' | 'both' } | null>(null)
  const pendingBoxRef = useRef<WindowBox | null>(null)

  const onResizeStart = useCallback((axis: 'x' | 'y' | 'both') => (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = boxRef.current
    if (start === null || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    // jsdom lacks setPointerCapture — the tests dispatch plain pointer events.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    resizeRef.current = { startX: event.clientX, startY: event.clientY, box: start, axis }
  }, [])

  const onResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = resizeRef.current
    if (drag === null) return
    const growX = drag.axis === 'y' ? 0 : event.clientX - drag.startX
    const growY = drag.axis === 'x' ? 0 : event.clientY - drag.startY
    pendingBoxRef.current = {
      ...drag.box,
      width: clamp(
        drag.box.width + growX,
        min.width,
        Math.max(min.width, window.innerWidth - drag.box.left - VIEWPORT_MARGIN),
      ),
      height: clamp(
        drag.box.height + growY,
        min.height,
        Math.max(min.height, window.innerHeight - drag.box.top - VIEWPORT_MARGIN),
      ),
    }
    resizeBatcher.schedule(() => {
      const pending = pendingBoxRef.current
      if (pending !== null) setBox(pending)
    })
  }, [min.width, min.height, resizeBatcher])

  const onResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resizeRef.current === null) return
    // Flush the last frame: a release can land with the final move still
    // queued (the committed box would otherwise lose it).
    resizeBatcher.flushNow()
    resizeRef.current = null
    pendingBoxRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [resizeBatcher])

  return createPortal(
    <div
      ref={frameRef}
      role="dialog"
      aria-label={title}
      data-floating-window
      className={css.window}
      style={box === null
        ? { left: -9999, top: -9999, width: DEFAULT_MIN_WIDTH, height: DEFAULT_MIN_HEIGHT }
        : { left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <div className={css.titleBar} data-window-handle onPointerDown={onTitlePointerDown}>
        <span className={css.title} title={title}>{title}</span>
        <span className={css.titleActions} data-window-no-drag>
          {actions}
          <Button
            variant="ghost"
            size="sm"
            className={css.close}
            icon={<IconCloseFillRegular size={14} />}
            aria-label={t('close')}
            title={t('close')}
            onClick={onClose}
          />
        </span>
      </div>
      <div
        ref={bodyRef}
        className={bodyLayout === 'fill' ? `${css.body} ${css.bodyFill}` : css.body}
        data-window-body
        data-window-body-layout={bodyLayout ?? 'scroll'}
      >
        {children}
      </div>
      {footer !== undefined && <div className={css.footer} data-window-footer>{footer}</div>}
      {/*
        Three handles rather than eight: the window grows from the bottom-right
        in practice (a log gets longer), and the two edges keep a single-axis
        resize possible. They sit above the body's scrollbar as thin strips.
      */}
      <div
        className={`${css.handle} ${css.handleRight}`}
        data-window-resize="x"
        aria-hidden="true"
        onPointerDown={onResizeStart('x')}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
      <div
        className={`${css.handle} ${css.handleBottom}`}
        data-window-resize="y"
        aria-hidden="true"
        onPointerDown={onResizeStart('y')}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
      <div
        className={`${css.handle} ${css.handleCorner}`}
        data-window-resize="both"
        aria-hidden="true"
        onPointerDown={onResizeStart('both')}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
    </div>,
    document.body,
  )
}
