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
 * close control and Escape end it — plus the two interactions a watched pane
 * needs: move it out of the way, and resize it to the log at hand.
 *
 * Since S6 it is also the SHELL of the public window host:
 * - geometry can be controlled (`box` + `onBoxChange`) so the host keeps the
 *   reader's placement across content updates;
 * - maximize/restore is built in (controlled through `maximized` +
 *   `onMaximizeChange`, or owned internally by the legacy callers);
 * - `onBeforeClose` is the draft guard for the close button AND Escape;
 * - z-order and Escape are shared with every other mounted window through
 *   {@link useWindowLayer}: Escape closes only the TOP window, and a pointer
 *   or focus raise brings a window above its siblings;
 * - the title bar carries identity/navigation/window controls only; resource
 *   actions render on a toolbar row below it, and primary actions stay in the
 *   stable footer.
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
import { Button, IconCloseFillRegular, IconFullscreenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { createFrameBatcher } from './frame-batcher.ts'
import { isNarrowWidth } from './breakpoints.ts'
import { clampNumber, clampWindowBox, maximizedWindowBox, placeWindowBox, type WindowBox } from './windows/geometry.ts'
import { useWindowLayer } from './windows/layer.ts'
import { t } from './locales.ts'
import css from './FloatingWindow.module.css'

/** Default share of the viewport a fresh (legacy, unchecked) window takes. */
const DEFAULT_WIDTH_RATIO = 0.7
const DEFAULT_HEIGHT_RATIO = 0.6
/** Default floor, and the hard floor a resize can never cross. */
const DEFAULT_MIN_WIDTH = 320
const DEFAULT_MIN_HEIGHT = 240
/** Free space kept at the viewport edges. */
const VIEWPORT_MARGIN = 8

export type { WindowBox }

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
  /**
   * Toolbar actions (resource actions), left of the window controls. The
   * legacy `actions` prop is the same row — the title bar itself carries only
   * identity, navigation and window controls.
   */
  actions?: ReactNode
  /** Explicit toolbar contents; wins over `actions` when both are given. */
  toolbar?: ReactNode
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
  /** Controlled geometry (the public window host owns the box). */
  box?: WindowBox
  /** Controlled geometry commit (drag/resize). */
  onBoxChange?(box: WindowBox): void
  /** Controlled maximize state; omitted = this component owns it. */
  maximized?: boolean
  /** Controlled maximize toggle. */
  onMaximizeChange?(maximized: boolean): void
  /** Hide the maximize control (a compact confirmation surface). */
  maximizable?: boolean
  /** Controlled z-index; omitted = the unified layer slot. */
  zIndex?: number
  /** Stable layer identity for the window host's `focus()` raise. */
  layerKey?: string
  /** Title-bar leading control (the in-surface back button). */
  titleLeading?: ReactNode
  /** Unsaved-edit marker in the title bar. */
  dirty?: boolean
  /** A source-owned save is in flight (rendered explicitly). */
  saving?: boolean
  /** Draft guard for the close control + Escape. False keeps the window open. */
  onBeforeClose?(): boolean | Promise<boolean>
  /** Close-button accessible name; defaults to the shared "Close" copy. */
  closeLabel?: string
  children: ReactNode
}

/** Clamp the legacy 70%/60% measurement into the live viewport. */
function initialBox(
  anchor: HTMLElement | null | undefined,
  size: { width: number; height: number } | undefined,
  min: { width: number; height: number },
  viewport: { width: number; height: number },
): WindowBox {
  // A caller-provided size (the task window's compact form, a log's explicit
  // box) is honoured. An unsized window on a NARROW viewport uses the
  // near-fullscreen form instead of a shrunken 70%/60% box — the same rule the
  // public host applies to its presets.
  const narrow = size === undefined && isNarrowWidth(viewport.width)
  const width = clampNumber(
    size?.width ?? (narrow ? viewport.width - VIEWPORT_MARGIN * 2 : viewport.width * DEFAULT_WIDTH_RATIO),
    min.width,
    Math.max(min.width, viewport.width - VIEWPORT_MARGIN * 2),
  )
  const height = clampNumber(
    size?.height ?? (narrow ? viewport.height - VIEWPORT_MARGIN * 2 : viewport.height * DEFAULT_HEIGHT_RATIO),
    min.height,
    Math.max(min.height, viewport.height - VIEWPORT_MARGIN * 2),
  )
  return placeWindowBox({
    size: { width, height },
    viewport,
    ...(anchor === undefined ? {} : { anchor }),
    min,
  })
}

/** The restore glyph (the host set ships only the fullscreen/maximize one). */
function RestoreIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 5.5V4.5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/**
 * Render a persistent floating window. The caller owns WHAT is shown (body,
 * toolbar, footer); this component owns the frame, the geometry, the two drag
 * gestures and the dismissal contract (close control + Escape only).
 */
export function FloatingWindow(props: FloatingWindowProps): ReactNode {
  const {
    title, onClose, initialSize, minSize, anchor, actions, toolbar, footer, bodyRef, bodyLayout,
    box: controlledBox, onBoxChange, maximized: controlledMaximized, onMaximizeChange, maximizable = true,
    zIndex, layerKey, titleLeading, dirty, saving, onBeforeClose, closeLabel, children,
  } = props
  const min = useMemo(() => ({
    width: minSize?.width ?? DEFAULT_MIN_WIDTH,
    height: minSize?.height ?? DEFAULT_MIN_HEIGHT,
  }), [minSize?.width, minSize?.height])
  const frameRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onBoxChangeRef = useRef(onBoxChange)
  onBoxChangeRef.current = onBoxChange
  const onMaximizeChangeRef = useRef(onMaximizeChange)
  onMaximizeChangeRef.current = onMaximizeChange
  const beforeCloseRef = useRef(onBeforeClose)
  beforeCloseRef.current = onBeforeClose
  const controlledRef = useRef(controlledBox !== undefined)
  controlledRef.current = controlledBox !== undefined
  const maximizeControlled = controlledMaximized !== undefined || onMaximizeChange !== undefined
  const maximizedControlledRef = useRef(maximizeControlled)
  maximizedControlledRef.current = maximizeControlled
  /**
   * The box is measured ONCE, on mount, from the live viewport: a later
   * re-render (a streamed output frame, a status flip) must never move or
   * resize a window the reader placed. A controlled box skips that entirely.
   */
  const [ownedBox, setOwnedBox] = useState<WindowBox | null>(null)
  const [ownedMaximized, setOwnedMaximized] = useState(false)
  const restoreBoxRef = useRef<WindowBox | null>(null)
  const currentBox = controlledBox ?? ownedBox
  const currentBoxRef = useRef<WindowBox | null>(currentBox)
  currentBoxRef.current = currentBox
  const maximized = controlledMaximized ?? ownedMaximized
  const maximizedRef = useRef(maximized)
  maximizedRef.current = maximized

  const commitBox = useCallback((next: WindowBox): void => {
    if (!controlledRef.current) setOwnedBox(next)
    onBoxChangeRef.current?.(next)
  }, [])

  useEffect(() => {
    if (controlledRef.current) return
    setOwnedBox(initialBox(anchor, initialSize, min, {
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    // Mount-only on purpose: see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Keep the box reachable after a viewport change (a rotation, a split pane). */
  useEffect(() => {
    const onResize = (): void => {
      if (controlledRef.current) return
      const current = currentBoxRef.current
      if (current === null) return
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      if (maximizedRef.current) {
        setOwnedBox(maximizedWindowBox(viewport))
        return
      }
      setOwnedBox(clampWindowBox(current, viewport, min))
      const restore = restoreBoxRef.current
      if (restore !== null) restoreBoxRef.current = clampWindowBox(restore, viewport, min)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [min])

  /**
   * Close path shared by the button and Escape: run the draft guard first.
   * The layer's Escape handler calls exactly this method, so a dirty window is
   * never discarded silently.
   */
  const closingRef = useRef(false)
  const requestClose = useCallback(async (): Promise<void> => {
    if (closingRef.current) return
    closingRef.current = true
    try {
      const guard = beforeCloseRef.current
      if (guard !== undefined) {
        const allowed = await guard()
        if (allowed === false) return
      }
      onCloseRef.current()
    } finally {
      closingRef.current = false
    }
  }, [])
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  // Unified layer: z-order + Escape (only the top window closes).
  const layer = useWindowLayer({
    ...(layerKey === undefined ? {} : { key: layerKey }),
    close: () => { void requestCloseRef.current() },
  })

  const toggleMaximize = useCallback((): void => {
    const next = !maximizedRef.current
    if (maximizedControlledRef.current) {
      onMaximizeChangeRef.current?.(next)
      return
    }
    const current = currentBoxRef.current
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    if (next) {
      restoreBoxRef.current = current
      setOwnedMaximized(true)
      setOwnedBox(maximizedWindowBox(viewport))
    } else {
      setOwnedMaximized(false)
      setOwnedBox(clampWindowBox(restoreBoxRef.current ?? current ?? maxBox(viewport), viewport, min))
    }
  }, [min])

  /** Live drag teardown: a window closed mid-drag must not leave window listeners behind. */
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  /** Drag the window by its title bar (buttons inside it keep working). */
  const dragBatcher = useRef(createFrameBatcher()).current
  const pendingDragRef = useRef<WindowBox | null>(null)
  useEffect(() => () => { dragBatcher.dispose() }, [dragBatcher])
  const onTitlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || maximizedRef.current) return
    const target = event.target as HTMLElement
    // The header's own controls (back, maximize, close) must not start a drag.
    if (target.closest('button, input, textarea, select, a, [data-window-no-drag]') !== null) return
    const start = currentBoxRef.current
    if (start === null) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const onMove = (move: PointerEvent): void => {
      pendingDragRef.current = clampWindowBox({
        ...start,
        left: start.left + (move.clientX - startX),
        top: start.top + (move.clientY - startY),
      }, { width: window.innerWidth, height: window.innerHeight }, min)
      dragBatcher.schedule(() => {
        const pending = pendingDragRef.current
        if (pending === null) return
        pendingDragRef.current = null
        commitBox(pending)
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      dragCleanupRef.current = null
      dragBatcher.flushNow()
    }
    dragCleanupRef.current = onUp
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [dragBatcher, commitBox, min])

  /** Resize from one edge handle: `axis` picks which dimension the handle owns. */
  const resizeBatcher = useRef(createFrameBatcher()).current
  useEffect(() => () => { resizeBatcher.dispose() }, [resizeBatcher])
  const resizeRef = useRef<{ startX: number; startY: number; box: WindowBox; axis: 'x' | 'y' | 'both' } | null>(null)
  const pendingBoxRef = useRef<WindowBox | null>(null)

  const onResizeStart = useCallback((axis: 'x' | 'y' | 'both') => (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = currentBoxRef.current
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
    pendingBoxRef.current = clampWindowBox({
      ...drag.box,
      width: drag.box.width + growX,
      height: drag.box.height + growY,
    }, { width: window.innerWidth, height: window.innerHeight }, min)
    resizeBatcher.schedule(() => {
      const pending = pendingBoxRef.current
      if (pending !== null) commitBox(pending)
    })
  }, [min, resizeBatcher, commitBox])

  const onResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resizeRef.current === null) return
    // Flush the last frame: a release can land with the final move still
    // queued (the committed box would otherwise lose it).
    resizeBatcher.flushNow()
    resizeRef.current = null
    pendingBoxRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [resizeBatcher])

  const resolvedZ = zIndex ?? layer.zIndex
  const toolbarRow = toolbar ?? actions
  const closeText = closeLabel ?? t('close')
  const style = currentBox === null
    ? { left: -9999, top: -9999, width: DEFAULT_MIN_WIDTH, height: DEFAULT_MIN_HEIGHT, zIndex: resolvedZ }
    : { left: currentBox.left, top: currentBox.top, width: currentBox.width, height: currentBox.height, zIndex: resolvedZ }

  return createPortal(
    <div
      ref={frameRef}
      role="dialog"
      aria-label={title}
      data-floating-window
      data-window-maximized={maximized ? 'true' : 'false'}
      className={css.window}
      style={style}
      onPointerDownCapture={() => { layer.raise() }}
      onFocusCapture={() => { layer.raise() }}
    >
      <div className={css.titleBar} data-window-handle onPointerDown={onTitlePointerDown}>
        {titleLeading !== undefined && (
          <span className={css.titleLeading} data-window-no-drag>{titleLeading}</span>
        )}
        <span className={css.title} title={title}>{title}</span>
        {dirty === true && (
          <span
            className={css.dirty}
            data-window-dirty
            role="status"
            aria-label={t('unsaved')}
            title={t('unsaved')}
          />
        )}
        {saving === true && (
          <span className={css.saving} data-window-saving>{t('windowSaving')}</span>
        )}
        <span className={css.titleActions} data-window-no-drag>
          {maximizable && (
            <Button
              variant="ghost"
              size="sm"
              className={css.windowControl}
              icon={maximized
                ? <RestoreIcon size={14} />
                : <IconFullscreenOutlineRegular size={14} />}
              aria-label={maximized ? t('windowRestore') : t('windowMaximize')}
              title={maximized ? t('windowRestore') : t('windowMaximize')}
              data-window-maximize={maximized ? 'restore' : 'maximize'}
              onClick={toggleMaximize}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            className={css.close}
            icon={<IconCloseFillRegular size={14} />}
            aria-label={closeText}
            title={closeText}
            onClick={() => { void requestCloseRef.current() }}
          />
        </span>
      </div>
      {toolbarRow !== undefined && toolbarRow !== null && (
        <div className={css.toolbar} data-window-toolbar data-window-no-drag>{toolbarRow}</div>
      )}
      <div
        ref={bodyRef}
        className={bodyLayout === 'fill' ? `${css.body} ${css.bodyFill}` : css.body}
        data-window-body
        data-window-body-layout={bodyLayout ?? 'scroll'}
      >
        {children}
      </div>
      {footer !== undefined && <div className={css.footer} data-window-footer>{footer}</div>}
      {!maximized && (
        <>
          {/*
            Three handles rather than eight: the window grows from the
            bottom-right in practice (a log gets longer), and the two edges
            keep a single-axis resize possible. They sit above the body's
            scrollbar as thin strips.
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
        </>
      )}
    </div>,
    document.body,
  )
}

/** A safety fallback for the internal restore path (never shown). */
function maxBox(viewport: { width: number; height: number }): WindowBox {
  return maximizedWindowBox(viewport)
}
