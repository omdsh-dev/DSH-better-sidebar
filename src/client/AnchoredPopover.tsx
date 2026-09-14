/**
 * The anchored floating popover of the Tasks page (node details, job output,
 * workflow run detail, team task editor): a viewport-anchored card portaled
 * to `document.body`, positioned below its anchor and flipped above when the
 * viewport bottom would clip it. Dismissal follows the proven
 * selection-popup contract (fixes upstream issue #425): outside mousedown,
 * Escape, document hidden, window blur, and the ANCHOR leaving the viewport
 * (tab switches flip the pane to display:none, which has no DOM event — the
 * IntersectionObserver geometry signal is the only reliable one).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The popover's visual width (viewport-clamped). */
const POP_WIDTH = 264

export interface AnchoredPopoverProps {
  /** The anchor element (null = closed). */
  anchor: HTMLElement | null
  /** Dismiss (outside click / Escape / anchor off-screen). */
  onClose(): void
  children: ReactNode
}

/**
 * Render a viewport-anchored popover. The caller owns WHAT is shown inside;
 * this component owns geometry + dismissal. Re-anchoring while open (a new
 * anchor) re-measures and keeps the card on screen.
 */
export function AnchoredPopover(props: AnchoredPopoverProps): ReactNode {
  const { anchor, onClose, children } = props
  const cardRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Measure + position once the card is in the DOM (and whenever the anchor
  // or content changes size). layout effect: no visible jump.
  useLayoutEffect(() => {
    if (anchor === null) { setPos(null); return }
    const card = cardRef.current
    if (card === null) return
    const rect = anchor.getBoundingClientRect()
    const width = Math.min(POP_WIDTH, window.innerWidth - 16)
    const height = card.offsetHeight
    let top = rect.bottom + 6
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6)
    }
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
    setPos({ left, top })
  }, [anchor, children])

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
      style={{
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: Math.min(POP_WIDTH, window.innerWidth - 16),
        zIndex: 90,
        visibility: pos === null ? 'hidden' : 'visible',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
