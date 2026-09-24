/**
 * The anchored floating popover of the Tasks page (node details, job output,
 * workflow run detail): a viewport-anchored card portaled to `document.body`,
 * positioned below its anchor and flipped above when the viewport bottom
 * would clip it. Dismissal follows the proven selection-popup contract
 * (fixes upstream issue #425): outside mousedown, Escape, document hidden,
 * window blur, and the ANCHOR leaving the viewport (tab switches flip the
 * pane to display:none, which has no DOM event — the IntersectionObserver
 * geometry signal is the only reliable one).
 *
 * DRAGGABLE mode: the job-output popover must be movable (a long log needs to
 * sit wherever the reader puts it). While `draggable`, dragging the card (or
 * its `data-popover-handle` area) moves it; the offset is clamped to the
 * viewport and a double click re-anchors it. The card stays portaled and
 * viewport-positioned — DSH 0.1.5 has no host free-window API, so the drag
 * is implemented here rather than reaching for a platform window.
 */
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

/** The popover's default visual width (viewport-clamped). */
const POP_WIDTH = 264
/** Free space kept at the viewport edges. */
const VIEWPORT_MARGIN = 8

export interface AnchoredPopoverProps {
  /** The anchor element (null = closed). */
  anchor: HTMLElement | null
  /** Dismiss (outside click / Escape / anchor off-screen). */
  onClose(): void
  /** Allow dragging the card (default false = pinned to the anchor). */
  draggable?: boolean
  /** Card width in px before viewport clamping (default 264). */
  width?: number
  children: ReactNode
}

/**
 * Render a viewport-anchored popover. The caller owns WHAT is shown inside;
 * this component owns geometry, dragging and dismissal. Changing the anchor
 * re-measures and resets any drag offset.
 */
export function AnchoredPopover(props: AnchoredPopoverProps): ReactNode {
  const { anchor, onClose, draggable = false, width = POP_WIDTH, children } = props
  const cardRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  /** Reader-applied drag offset (added to the anchored position). */
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const offsetRef = useRef(offset)
  offsetRef.current = offset
  /** The anchored baseline: a drag always starts from the measured position. */
  const baseRef = useRef({ left: 0, top: 0 })

  const cardWidth = Math.min(width, window.innerWidth - VIEWPORT_MARGIN * 2)

  // Measure + position once the card is in the DOM (and whenever the anchor
  // or content changes size). layout effect: no visible jump.
  useLayoutEffect(() => {
    if (anchor === null) { setPos(null); return }
    const card = cardRef.current
    if (card === null) return
    const rect = anchor.getBoundingClientRect()
    const height = card.offsetHeight
    let top = rect.bottom + 6
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, rect.top - height - 6)
    }
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - cardWidth - VIEWPORT_MARGIN),
    )
    baseRef.current = { left, top }
    setPos({ left: left + offsetRef.current.x, top: top + offsetRef.current.y })
  }, [anchor, children, cardWidth])

  // A new anchor starts a fresh placement (never inherit another node's drag).
  useEffect(() => { setOffset({ x: 0, y: 0 }) }, [anchor])

  /** Drag the card (buttons inside it keep working). */
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggable || event.button !== 0) return
    const target = event.target as HTMLElement
    // A control inside the card (copy, kill, follow…) must not start a drag.
    if (target.closest('button, input, textarea, select, a, [data-popover-no-drag]') !== null) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const start = offsetRef.current
    const base = baseRef.current
    const onMove = (move: PointerEvent): void => {
      const nextX = Math.min(
        Math.max(start.x + (move.clientX - startX), VIEWPORT_MARGIN - base.left),
        Math.max(VIEWPORT_MARGIN - base.left, window.innerWidth - cardWidth - VIEWPORT_MARGIN - base.left),
      )
      const nextY = Math.min(
        Math.max(start.y + (move.clientY - startY), VIEWPORT_MARGIN - base.top),
        Math.max(VIEWPORT_MARGIN - base.top, window.innerHeight - 48 - base.top),
      )
      setOffset({ x: nextX, y: nextY })
      setPos({ left: base.left + nextX, top: base.top + nextY })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [draggable, cardWidth])

  // Global dismissal (see the file header for the contract).
  useEffect(() => {
    if (anchor === null) return
    const onMouseDown = (event: MouseEvent): void => {
      const card = cardRef.current
      if (card !== null && (card === event.target || card.contains(event.target as Node))) return
      if (anchor === event.target || anchor.contains(event.target as Node)) return
      onCloseRef.current()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    const onHidden = (): void => { if (document.hidden) onCloseRef.current() }
    const onBlur = (): void => { onCloseRef.current() }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('blur', onBlur)
    // The anchor leaving the viewport (tab switch / panel collapse) closes.
    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) if (!entry.isIntersecting) onCloseRef.current()
      }, { threshold: 0 })
      observer.observe(anchor)
    }
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('blur', onBlur)
      observer?.disconnect()
    }
  }, [anchor])

  if (anchor === null) return null
  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      // Presentation only: geometry stays inline (the drag math owns
      // `left`/`top`/`width`). The wrapper is a bare positioning box — the
      // surface the reader sees is the card the caller renders inside it
      // (`popCard`): fill, 1px `border-l2` edge and the floating shadow. With
      // no padding or border of its own, the declared width is the measured
      // width, so the drag clamp above stays exact.
      style={{
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: cardWidth,
        zIndex: 90,
        visibility: pos === null ? 'hidden' : 'visible',
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={draggable ? () => { setOffset({ x: 0, y: 0 }) } : undefined}
    >
      {children}
    </div>,
    document.body,
  )
}
