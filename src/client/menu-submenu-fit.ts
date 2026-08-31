/**
 * Viewport fit for DSH Menu submenus (fix for #490).
 *
 * The harness Menu primitive positions a submenu with pure CSS — always to
 * the RIGHT of its parent row (`.submenu { left: calc(100% + 10px) }`) — and
 * never clamps it to the viewport. The main list IS clamped, so when the list
 * sits against the right edge (the Files panel is at the window's right edge)
 * the submenu falls off-screen and becomes unclickable.
 *
 * DSH source is off-limits for the plugin, so this module applies the
 * standard measure → flip → clamp correction (VS Code's menu positioner /
 * floating-ui's flip+shift) from the outside: while a plugin-owned Menu is
 * open, watch the portaled list for a nested `[role="menu"]` (the submenu),
 * measure it, and flip it LEFT — margin-clamped — when it would overflow the
 * viewport's right edge.
 *
 * The submenu is located through ARIA semantics (`role="menu"` nested inside
 * a `[role="menu"]` list), never through the primitive's class names; the
 * flip is expressed with the plugin's own `data-dshb-submenu-side` attribute
 * (driving menu-submenu-fit.css) plus inline styles, so no DSH class names or
 * stylesheet load order are depended on.
 */
import { useEffect } from 'react'
import './menu-submenu-fit.css'

/** The submenu gap mirrored from the primitive (`.submenu { left: calc(100% + 10px) }`). */
export const SUBMENU_GAP = 10
/** Safe viewport margin, mirrored from the primitive's portal MARGIN (12). */
export const VIEWPORT_MARGIN = 12
/** Attribute set on a flipped submenu (drives the [data-dshb-submenu-side] rules). */
export const FLIP_ATTR = 'data-dshb-submenu-side'
export const FLIP_LEFT = 'left'

/**
 * Pure flip decision: true when the right-anchored submenu would overflow the
 * viewport's right edge AND flipping it left still clears the left edge. When
 * both sides fail the submenu stays right-anchored (the host's own clamp keeps
 * the main list consistent) — floating-ui's "no fallback side" behavior.
 */
export function shouldFlipSubmenu(
  parentLeft: number,
  parentRight: number,
  submenuWidth: number,
  viewportWidth: number,
  margin: number = VIEWPORT_MARGIN,
): boolean {
  const rightAnchoredRight = parentRight + SUBMENU_GAP + submenuWidth
  const flippedLeft = parentLeft - SUBMENU_GAP - submenuWidth
  return rightAnchoredRight > viewportWidth - margin && flippedLeft >= margin
}

/** The submenus currently rendered: `[role="menu"]` lists nested inside another `[role="menu"]`. */
function nestedSubmenus(root: ParentNode): Element[] {
  const found = new Set<Element>()
  for (const outer of root.querySelectorAll('[role="menu"]')) {
    for (const inner of outer.querySelectorAll('[role="menu"]')) found.add(inner)
  }
  return [...found]
}

/** Apply the fit correction to one submenu element. */
export function fitSubmenuElement(el: Element, viewportWidth: number, viewportHeight: number): void {
  const menuEl = el as HTMLElement
  const parent = el.parentElement
  if (parent === null) return
  const parentRect = parent.getBoundingClientRect()
  const width = el.getBoundingClientRect().width
  if (shouldFlipSubmenu(parentRect.left, parentRect.right, width, viewportWidth)) {
    menuEl.setAttribute(FLIP_ATTR, FLIP_LEFT)
  } else {
    menuEl.removeAttribute(FLIP_ATTR)
  }
  // Re-measure after the side flip so the vertical math sees the final position.
  const rect = el.getBoundingClientRect()
  // Vertical hardening: the submenu is bottom-anchored (`bottom: -4px`), so
  // only its TOP can collide with the viewport. Cap the height first (the card
  // scrolls), then re-anchor to the top edge when it would still start above
  // the margin.
  const maxHeight = viewportHeight - VIEWPORT_MARGIN * 2
  if (rect.height > maxHeight) {
    menuEl.style.maxHeight = `${maxHeight}px`
    menuEl.style.overflowY = 'auto'
  } else {
    menuEl.style.maxHeight = ''
    menuEl.style.overflowY = ''
  }
  if (rect.top < VIEWPORT_MARGIN) {
    menuEl.style.bottom = 'auto'
    menuEl.style.top = `${VIEWPORT_MARGIN - parentRect.top}px`
  } else {
    menuEl.style.top = ''
    menuEl.style.bottom = ''
  }
}

/**
 * Keep every submenu of a plugin-owned Menu inside the viewport while `open`.
 * The primitive remounts a submenu on each hover of its parent row, so the
 * observer re-measures on every mount; resize/scroll re-place the main list,
 * so the fit follows them too. The whole body is observed (the portaled list
 * lives in `document.body`), coalesced to one pass per animation frame.
 */
export function useMenuSubmenuFit(open: boolean): void {
  useEffect(() => {
    if (!open) return
    let raf = 0
    const apply = (): void => {
      raf = 0
      const vw = window.innerWidth
      const vh = window.innerHeight
      for (const sub of nestedSubmenus(document.body)) fitSubmenuElement(sub, vw, vh)
    }
    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(apply)
    }
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [open])
}
