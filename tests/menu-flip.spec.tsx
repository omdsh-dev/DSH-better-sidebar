/**
 * The context-menu submenu flip geometry: the pure token computation behind
 * the body attribute layout.css consumes (see src/client/menu-flip.ts for
 * the contract) plus the attribute lifecycle of the hook itself.
 */
// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { readFileSync } from 'node:fs'
import { act } from 'react-dom/test-utils'
import { describe, expect, it } from 'vitest'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SUBMENU_FLIP_ATTR, submenuFlipTokens, useSubmenuFlip } from '../src/client/menu-flip.ts'

setupReactAct()

describe('layout.css contract', () => {
  it('consumes the exact attribute name menu-flip.ts publishes', () => {
    // The two halves of the flip mechanism can drift silently: renaming the
    // attribute here would leave layout.css matching nothing (submenus revert
    // to overflowing) with every test still green. Tie them together. Specs
    // run from the repo root (chunk-artifact.spec.ts reads lib/ the same way).
    const css = readFileSync('src/client/layout.css', 'utf8')
    expect(css).toContain(`body[${SUBMENU_FLIP_ATTR}~="down"] div[role="menu"] div[role="menu"]`)
    expect(css).toContain(`body[${SUBMENU_FLIP_ATTR}~="left"] div[role="menu"] div[role="menu"]`)
    expect(css).toContain(`body[${SUBMENU_FLIP_ATTR}~="left"] div[role="menu"] div[role="menu"]::before`)
  })

  it('keeps the submenu visual tether rules (parent highlight + tight gap)', () => {
    // Part 1 keeps the parent row lit while its submenu is open (the Menu
    // marks it aria-expanded); part 2 tightens the card gap to 4px with the
    // hover corridor narrowed to match. Losing either sends the submenu back
    // to reading as an unrelated floating card.
    const css = readFileSync('src/client/layout.css', 'utf8')
    expect(css).toContain(`body[${SUBMENU_FLIP_ATTR}] div[role="menu"] button[aria-expanded="true"]`)
    expect(css).toContain('left: calc(100% + 4px)')
    expect(css).toContain('right: calc(100% + 4px)')
    expect(css).toContain('width: 4px')
  })
})

describe('submenuFlipTokens', () => {
  // Default geometry (1024x768): the panel is docked right, so the
  // interesting split is the right-hand 400px strip and the vertical half.
  it('flips down for a cursor in the upper half, keeps primitive defaults below', () => {
    expect(submenuFlipTokens(500, 20, 1024, 768)).toBe('down')
    expect(submenuFlipTokens(500, 700, 1024, 768)).toBe('')
  })

  it('flips left when the right-hand room cannot fit card + submenu', () => {
    // 700 + 400 > 1024 → left; the cursor is low, so no down token.
    expect(submenuFlipTokens(700, 700, 1024, 768)).toBe('left')
    // Both tokens compose for a top-right opening.
    expect(submenuFlipTokens(700, 20, 1024, 768)).toBe('down left')
  })

  it('uses the exact boundary inclusively (midpoint and width-minus-room still flip)', () => {
    expect(submenuFlipTokens(500, 384, 1024, 768)).toBe('')
    expect(submenuFlipTokens(500, 383, 1024, 768)).toBe('down')
    expect(submenuFlipTokens(624, 700, 1024, 768)).toBe('')
    expect(submenuFlipTokens(625, 700, 1024, 768)).toBe('left')
  })

  it('flips left throughout a narrow panel viewport (PANEL_MIN 280)', () => {
    // A 600px window: any cursor past x=200 flips; the left strip cannot
    // fit a right-growing submenu beside the 218px card either way.
    expect(submenuFlipTokens(300, 100, 600, 800)).toBe('down left')
    expect(submenuFlipTokens(500, 700, 600, 800)).toBe('left')
  })
})

describe('useSubmenuFlip', () => {
  const ATTR = 'data-dsh-sidebar-submenu'

  /** Mount a probe whose menu state the spec drives via the returned setter. */
  function mountFlipProbe(initial: { x: number; y: number } | null): { setMenu: (next: { x: number; y: number } | null) => void, unmount: () => void } {
    let applyMenu: (next: { x: number; y: number } | null) => void = () => {}
    function Probe(): React.ReactElement {
      const [menu, setMenu] = useState<{ x: number; y: number } | null>(initial)
      applyMenu = setMenu
      useSubmenuFlip(menu)
      return <div />
    }
    const rendered = renderRoot(createElement(Probe))
    return {
      setMenu: (next) => { act(() => { applyMenu(next) }) },
      unmount: rendered.unmount,
    }
  }

  it('publishes tokens while the menu is open and clears on close', () => {
    const probe = mountFlipProbe({ x: 700, y: 20 })
    try {
      expect(document.body.getAttribute(ATTR)).toBe('down left')
      probe.setMenu(null)
      expect(document.body.hasAttribute(ATTR)).toBe(false)
    } finally {
      probe.unmount()
    }
  })

  it('tracks the position across consecutive openings', () => {
    const probe = mountFlipProbe({ x: 100, y: 20 })
    try {
      expect(document.body.getAttribute(ATTR)).toBe('down')
      // Still open, now lower-left: the attribute stays (menu lifetime) but
      // carries no token, so the primitive's own geometry applies.
      probe.setMenu({ x: 100, y: 700 })
      expect(document.body.getAttribute(ATTR)).toBe('')
      probe.setMenu({ x: 700, y: 700 })
      expect(document.body.getAttribute(ATTR)).toBe('left')
    } finally {
      probe.unmount()
    }
  })

  it('clears the attribute when the owner unmounts with the menu still open', () => {
    const probe = mountFlipProbe({ x: 100, y: 20 })
    expect(document.body.getAttribute(ATTR)).toBe('down')
    probe.unmount()
    expect(document.body.hasAttribute(ATTR)).toBe(false)
  })
})
