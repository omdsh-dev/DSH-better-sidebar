/**
 * The floating "add selection to conversation" popup shared by the text
 * viewers (markdown preview + the catch-all code viewer): a viewport-anchored
 * button portaled to `document.body`, kept alive across the selection gesture
 * and committed on click.
 *
 * Dismissal contract (fixes upstream issue #425): the popup must never
 * outlive its editor surface. The sidebar keeps every tab MOUNTED — switching
 * tabs only flips the pane cell to `display:none` and collapsing the panel
 * translates it off-screen — while the portaled `position:fixed` button stays
 * pinned to its viewport anchor, ignoring both. The caller already hides on
 * surface scrolls, selection collapse and mode flips; this hook adds the
 * global dismissal that covers everything else:
 *
 * - any `mousedown` outside the button (tab bar, composer, another pane,
 *   the collapse toggle, …) closes it;
 * - `Escape` closes it;
 * - the document going hidden (`visibilitychange`) or the window losing
 *   focus closes it;
 * - an `IntersectionObserver` on the editor surface closes it as soon as the
 *   surface leaves the viewport — the tab-switch (`display:none`) and
 *   panel-collapse (translated off-screen) paths have no DOM events of their
 *   own, so the geometry signal is the only reliable one.
 *
 * The button's own `mousedown` is never treated as an outside click: the
 * caller preventDefaults it to keep the selection/caret alive until the
 * click commits (the hook's capture-phase listener runs first and must not
 * hide for it).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'

/** The floating "add to conversation" action: payload + viewport anchor. */
export interface SelectionPopup {
  insert: string
  left: number
  top: number
}

export interface SelectionPopupOptions {
  /** Commit the payload into the composer draft (button click). */
  onCommit(insert: string): void
  /**
   * The DOM surface that must stay on screen for the popup to live: the
   * markdown preview container in preview mode, the CodeMirror host
   * otherwise. Called lazily (refs are null until the content loads).
   */
  getSurface(): HTMLElement | null
}

export interface SelectionPopupControls {
  /** The current popup (null = hidden). */
  popup: SelectionPopup | null
  /** Attach to the portaled button element. */
  buttonRef: RefObject<HTMLButtonElement>
  /** Anchor the popup above a selection (viewport-clamped). */
  show(insert: string, left: number, top: number): void
  /** Hide the popup (idempotent). */
  hide(): void
  /** The button's click: commit the stored payload, then hide. */
  commit(): void
}

export function useSelectionPopup(options: SelectionPopupOptions): SelectionPopupControls {
  // Latest-callback refs: the dismissal listeners live for the mount's
  // lifetime, so they must not capture stale closures across renders.
  const onCommitRef = useRef(options.onCommit)
  const getSurfaceRef = useRef(options.getSurface)
  onCommitRef.current = options.onCommit
  getSurfaceRef.current = options.getSurface

  const [popup, setPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror for click/event-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup | null>(null)
  /** The portaled button itself (for the outside-click guard). */
  const buttonRef = useRef<HTMLButtonElement>(null)
  /** The surface visibility observer (created lazily on open). */
  const observerRef = useRef<IntersectionObserver | null>(null)

  const show = (insert: string, left: number, top: number): void => {
    const next: SelectionPopup = {
      insert,
      left: Math.min(Math.max(left, 80), window.innerWidth - 80),
      top,
    }
    popupRef.current = next
    setPopup(next)
  }

  const hide = (): void => {
    popupRef.current = null
    setPopup(null)
  }

  const commit = (): void => {
    const current = popupRef.current
    if (current === null) return
    onCommitRef.current(current.insert)
    hide()
  }

  // Global dismissal listeners, registered once; every handler reads the
  // live popup ref so it no-ops while no popup is open.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (popupRef.current === null) return
      const button = buttonRef.current
      if (button !== null && (button === event.target || button.contains(event.target as Node))) return
      hide()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && popupRef.current !== null) hide()
    }
    const onVisibilityChange = (): void => {
      if (document.hidden && popupRef.current !== null) hide()
    }
    const onWindowBlur = (): void => {
      if (popupRef.current !== null) hide()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onWindowBlur)
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [])

  // Re-target the visibility observer whenever a popup opens: the surface
  // refs may have been null at mount (content loads async, mode flips swap
  // the preview container for the CodeMirror host), so the surface is only
  // trustworthy at open time.
  useEffect(() => {
    if (popup === null) return
    observerRef.current?.disconnect()
    observerRef.current = null
    if (typeof IntersectionObserver === 'undefined') return
    const surface = getSurfaceRef.current()
    if (surface === null) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) hide()
      }
    }, { threshold: 0 })
    observerRef.current = observer
    observer.observe(surface)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the boolean
    // flip is the only thing that must re-run this; an anchor move while
    // open keeps the same surface.
  }, [popup !== null])

  return { popup, buttonRef, show, hide, commit }
}