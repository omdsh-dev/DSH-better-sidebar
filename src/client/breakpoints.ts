/**
 * Narrow-viewport ("mobile") breakpoint for the sidebar. Width-based, shared
 * by the layout logic (JS) and the style gates (CSS). The CSS side pairs
 * with this file via `@media (max-width: 767px)` rules (sidebar.module.css)
 * — 767px ≡ widths below NARROW_MAX_WIDTH, documented at both ends.
 *
 * "Real narrow" on purpose: the mobile layout (one full-screen drawer, the
 * bottom panel's tabs merged into the right sidebar) is a phone / portrait
 * tablet experience. The value is deliberately NOT aligned to the DSH app
 * shell's own 1024px breakpoint — 1024px windows (small laptops, split
 * panes) keep the desktop two-panel layout.
 */
import { useEffect, useState } from 'react'

/** Viewport widths strictly below this are "mobile" (paired CSS: max-width: 767px). */
export const NARROW_MAX_WIDTH = 768

/** Whether a viewport width is narrow (mobile). */
export function isNarrowWidth(width: number): boolean {
  return width < NARROW_MAX_WIDTH
}

export interface ViewportSize {
  width: number
  height: number
}

/**
 * Live narrow-viewport flag for components. Reads `window.innerWidth` and
 * re-measures on resize (rAF-throttled, the repo's existing drag pattern).
 * Deliberately avoids `matchMedia` (jsdom does not implement it) — the
 * resize listener is equally exact for a breakpoint that never changes
 * while the page is open.
 */
export function useViewportSize(target?: HTMLElement): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(() => ({
    width: target?.getBoundingClientRect().width ?? (typeof window === 'undefined' ? 0 : window.innerWidth),
    height: target?.getBoundingClientRect().height ?? (typeof window === 'undefined' ? 0 : window.innerHeight),
  }))
  useEffect(() => {
    if (typeof window === 'undefined') return
    const element = target
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      if (element === undefined) {
        setSize({ width: window.innerWidth, height: window.innerHeight })
      } else {
        const rect = element.getBoundingClientRect()
        setSize({ width: rect.width, height: rect.height })
      }
    }
    const onResize = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    if (element === undefined) window.addEventListener('resize', onResize)
    const observer = element === undefined ? undefined : new ResizeObserver(onResize)
    if (element !== undefined) observer?.observe(element)
    measure()
    return () => {
      if (element === undefined) window.removeEventListener('resize', onResize)
      observer?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [target])
  return size
}

export function useNarrowViewport(): boolean {
  return isNarrowWidth(useViewportSize().width)
}
