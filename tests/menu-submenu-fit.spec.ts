/**
 * Submenu viewport fit (fix for #490).
 *
 * The DSH Menu primitive opens submenus purely via CSS (`left: calc(100% + 10px)`)
 * with no viewport clamp, so a menu at the window's right edge spills its
 * submenu off-screen and unclickable. The plugin's fit applies the standard
 * measure → flip → clamp correction from the outside (see
 * src/client/menu-submenu-fit.ts). These tests lock the pure flip decision and
 * the DOM applier.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  FLIP_ATTR, FLIP_LEFT, fitSubmenuElement, shouldFlipSubmenu, useMenuSubmenuFit, VIEWPORT_MARGIN,
} from '../src/client/menu-submenu-fit.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const VW = 1600
const VH = 900

/** A jsdom-friendly rect mock (jsdom's getBoundingClientRect returns zeros). */
function rect(left: number, right: number, top: number, bottom: number): DOMRect {
  return {
    left, right, top, bottom,
    width: right - left,
    height: bottom - top,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/** Mount a menu list + one submenu in body with the given geometry. */
function mountSubmenu(
  wrap: { left: number; right: number; top: number; bottom: number },
  sub: { left: number; right: number; top: number; bottom: number },
): { list: HTMLDivElement; wrap: HTMLDivElement; submenu: HTMLDivElement } {
  const list = document.createElement('div')
  list.setAttribute('role', 'menu')
  const w = document.createElement('div')
  const s = document.createElement('div')
  s.setAttribute('role', 'menu')
  w.appendChild(s)
  list.appendChild(w)
  document.body.appendChild(list)
  w.getBoundingClientRect = () => rect(wrap.left, wrap.right, wrap.top, wrap.bottom)
  s.getBoundingClientRect = () => rect(sub.left, sub.right, sub.top, sub.bottom)
  return { list, wrap: w, submenu: s }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('shouldFlipSubmenu', () => {
  it('keeps the submenu right-anchored when it fits', () => {
    // Menu mid-screen: 400 + 10 gap + 170 wide = 580, comfortably inside.
    expect(shouldFlipSubmenu(200, 400, 170, VW)).toBe(false)
  })

  it('flips left when the right edge would overflow', () => {
    // Menu right-clamped: 1588 + 10 + 170 = 1768 > 1588; flipped left edge
    // 1388 - 10 - 170 = 1208 still clears the 12px margin.
    expect(shouldFlipSubmenu(1388, 1588, 170, VW)).toBe(true)
  })

  it('stays right-anchored when both sides fail (no fallback side)', () => {
    // Narrow viewport: right overflows AND the flipped edge (-290) is off-screen.
    expect(shouldFlipSubmenu(20, 200, 300, 400)).toBe(false)
  })

  it('does not flip at the exact boundary', () => {
    // Right edge lands exactly on vw - margin: not strictly greater.
    expect(shouldFlipSubmenu(200, 400, 170, 400 + 10 + 170 + VIEWPORT_MARGIN)).toBe(false)
  })
})

describe('fitSubmenuElement', () => {
  it('marks an overflowing submenu with the left-flip attribute', () => {
    const { submenu } = mountSubmenu(
      { left: 1388, right: 1588, top: 100, bottom: 200 },
      { left: 1610, right: 1780, top: 100, bottom: 270 },
    )
    fitSubmenuElement(submenu, VW, VH)
    expect(submenu.getAttribute(FLIP_ATTR)).toBe(FLIP_LEFT)
  })

  it('clears the flip when the submenu fits again', () => {
    const { submenu } = mountSubmenu(
      { left: 1388, right: 1588, top: 100, bottom: 200 },
      { left: 1610, right: 1780, top: 100, bottom: 270 },
    )
    fitSubmenuElement(submenu, VW, VH)
    expect(submenu.getAttribute(FLIP_ATTR)).toBe(FLIP_LEFT)
    // The list moves mid-screen: the right-anchored submenu fits again.
    submenu.parentElement!.getBoundingClientRect = () => rect(200, 400, 100, 200)
    fitSubmenuElement(submenu, VW, VH)
    expect(submenu.getAttribute(FLIP_ATTR)).toBeNull()
  })

  it('re-anchors to the top edge when the submenu would start above the margin', () => {
    const { submenu } = mountSubmenu(
      { left: 1388, right: 1588, top: 100, bottom: 200 },
      { left: 1610, right: 1780, top: -20, bottom: 150 },
    )
    fitSubmenuElement(submenu, VW, VH)
    expect(submenu.style.bottom).toBe('auto')
    expect(submenu.style.top).toBe(`${VIEWPORT_MARGIN - 100}px`)
  })

  it('caps an over-tall submenu with a scroll region', () => {
    const { submenu } = mountSubmenu(
      { left: 1388, right: 1588, top: 100, bottom: 200 },
      { left: 1610, right: 1780, top: -400, bottom: 500 }, // 900px tall
    )
    fitSubmenuElement(submenu, VW, VH)
    expect(submenu.style.maxHeight).toBe(`${VH - VIEWPORT_MARGIN * 2}px`)
    expect(submenu.style.overflowY).toBe('auto')
  })
})

describe('useMenuSubmenuFit', () => {
  it('flips a submenu that mounts while the menu is open, and stops after close', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const Comp = ({ open }: { open: boolean }) => { useMenuSubmenuFit(open); return null }
    await act(async () => { root = createRoot(container); root.render(createElement(Comp, { open: true })) })

    const { submenu } = mountSubmenu(
      { left: 1388, right: 1588, top: 100, bottom: 200 },
      { left: 1610, right: 1780, top: 100, bottom: 270 },
    )
    // The MutationObserver schedules a rAF pass; give it a frame.
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(submenu.getAttribute(FLIP_ATTR)).toBe(FLIP_LEFT)

    // Menu closes: the observer disconnects, later mounts stay untouched.
    await act(async () => { root.render(createElement(Comp, { open: false })) })
    const late = mountSubmenu(
      { left: 1388, right: 1588, top: 100, bottom: 200 },
      { left: 1610, right: 1780, top: 100, bottom: 270 },
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(late.submenu.getAttribute(FLIP_ATTR)).toBeNull()

    await act(async () => { root.unmount() })
    container.remove()
  })
})
