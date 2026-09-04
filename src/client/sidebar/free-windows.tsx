/**
 * Free windows (extracted from Sidebar.tsx, behavior identical): the
 * drag-out gesture that floats a tab onto the conversation column, plus the
 * render layer for the floating windows and its drop-zone hint overlay.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from '../../context-types.ts'
import {
  dockFloat, floatTab, moveFloat, raiseFloat, resizeFloat,
  type FloatWindow, type SidebarStore, type SidebarTab,
} from '../state.ts'
import { TAB_DRAG_TYPE, parseDrag } from '../TabBar.tsx'
import { FreeWindow } from '../FreeWindow.tsx'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

/** The dashed drop-zone hint's geometry (viewport coordinates). */
export interface FloatDropHint {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Free windows — drag-out detection. The tab strips already drive HTML5
 * DnD (payload application/x-dsh-tab) with drops owned by the panes
 * (split/merge); this hook watches the DOCUMENT (capture) for the same
 * drag hovering OUTSIDE the panel host: while the pointer is over the
 * conversation column it arms the drop (preventDefault) and shows a hint
 * overlay there, and the drop floats the tab at the release point. Targets
 * inside the host are ignored here, so pane drops keep their behavior
 * untouched. Only OUR tab drags count (the body flag is the tab strip's;
 * OS file drags and any DSH drags pass through). Narrow viewports skip
 * the gesture — the merged drawer covers the conversation, leaving
 * nothing to drop onto (the tab context menu entry still floats tabs).
 */
export function useFloatDragout(input: {
  narrow: boolean
  sessionId: string | undefined
  store: SidebarStore
  /** The AppFrame center column (from useCenterColumn); stable ref object. */
  centerColRef: { readonly current: HTMLElement | null }
}): { floatHint: FloatDropHint | null } {
  const { narrow, sessionId, store, centerColRef } = input
  const [floatHint, setFloatHint] = useState<FloatDropHint | null>(null)
  const floatHintRef = useRef(false)
  useEffect(() => {
    if (narrow || sessionId === undefined) return
    const inPanelHost = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest('[data-dsh-panel-host]') !== null
    /** The conversation column's rect when the pointer is over it (and not
     *  over our own surfaces); null otherwise. */
    const overConversation = (event: DragEvent): DOMRect | null => {
      if (inPanelHost(event.target)) return null
      const col = centerColRef.current
      if (col === null || !col.isConnected) return null
      const rect = col.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const { clientX: x, clientY: y } = event
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null
      return rect
    }
    const onDragOver = (event: DragEvent): void => {
      if (!document.body.hasAttribute('data-dsh-tab-dragging')) return
      const rect = overConversation(event)
      if (rect !== null) {
        // preventDefault on dragover is what makes the browser deliver the
        // drop (and drop the "no" cursor) over the conversation area.
        event.preventDefault()
        setFloatHint((prev) => {
          const next = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          if (prev !== null && prev.left === next.left && prev.top === next.top
            && prev.width === next.width && prev.height === next.height) return prev
          return next
        })
        floatHintRef.current = true
      } else if (floatHintRef.current) {
        floatHintRef.current = false
        setFloatHint(null)
      }
    }
    const onDrop = (event: DragEvent): void => {
      if (!floatHintRef.current) return
      floatHintRef.current = false
      setFloatHint(null)
      const rect = overConversation(event)
      if (rect === null) return
      event.preventDefault()
      event.stopPropagation()
      const payload = parseDrag(event.dataTransfer?.getData(TAB_DRAG_TYPE) ?? '')
      if (payload === null) return
      store.reduce(s => floatTab(s, payload.tabId, event.clientX, event.clientY))
    }
    const clear = (): void => {
      if (!floatHintRef.current) return
      floatHintRef.current = false
      setFloatHint(null)
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('blur', clear)
    }
    // centerColRef is a stable ref object from useCenterColumn (it lost its
    // useRef provenance crossing the hook boundary, so it is listed here).
  }, [narrow, sessionId, store, centerColRef])

  return { floatHint }
}

/**
 * The free-window render layer: tabs dragged out onto the conversation area
 * (or floated from the tab context menu). They live in the panel host like
 * the panels (viewport coordinates, immune to desktop-shell transforms) but
 * are independent of panel state — a window stays up while panels collapse.
 * The floats array's order is the stacking order; the content reuses the
 * regular tab renderer, so every tab type floats unchanged. Renders a
 * fragment so the DOM is exactly the floats followed by the drag-out hint.
 */
export function FreeWindowLayer(props: {
  floats: readonly FloatWindow[]
  hint: FloatDropHint | null
  renderTab: (tab: SidebarTab, active: boolean, paneId: string, placement: 'top' | 'bottom' | 'float') => ReactNode
  getTabIcon: (tab: SidebarTab) => ReactNode
  store: SidebarStore
  ctx: Context
  sessionId: string
  cwd: string | undefined
}) {
  const { floats, hint, renderTab, getTabIcon, store, ctx, sessionId, cwd } = props
  return (
    <>
      {floats.map(float => (
        <FreeWindow
          key={float.id}
          float={float}
          renderTab={(tab, active, paneId) => renderTab(tab, active, paneId, 'float')}
          getTabIcon={getTabIcon}
          onRaise={() => { store.reduce(s => raiseFloat(s, float.id)) }}
          onMove={(x, y) => { store.reduce(s => moveFloat(s, float.id, x, y)) }}
          onResize={(w, h) => { store.reduce(s => resizeFloat(s, float.id, w, h)) }}
          onDock={(paneId) => { store.reduce(s => dockFloat(s, float.id, paneId ?? undefined)) }}
          onClose={() => { ctx.get('betterSidebar')?.closeTab(float.tab.id, sessionId === undefined ? undefined : { sessionId, cwd }) }}
        />
      ))}
      {/*
        The drag-out hint: while a tab drag hovers the conversation column,
        a dashed overlay marks the drop zone there (pointer-transparent — it
        must not disturb the drag it describes).
      */}
      {hint !== null && (
        <div
          className={css.floatDropHint}
          style={{ left: hint.left, top: hint.top, width: hint.width, height: hint.height }}
        >
          <span className={css.floatDropHintLabel}>{t('floatDropHint')}</span>
        </div>
      )}
    </>
  )
}
