/**
 * The produced-files row's "Show in folder" action must not render as the UA's
 * default dialog button.
 *
 * `SidebarProducedFiles` renders that `<button>` with `.producedAction` on top
 * of the label class it shares with the plain `+N` counter `<span>`, so
 * everything the browser applies on its own would otherwise show through: an
 * opaque `ButtonFace` fill, a 2px `outset` bevel, square 0-radius corners and a
 * 1px/6px padding of its own — a foreign control sitting beside the transparent
 * tertiary text of the row (on the dark skin the fill reads as a bright slab).
 * `.producedAction` owns that reset, and the element must not carry a style
 * prop that would re-assert the old underline.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')
const source = readFileSync('src/client/intercept.tsx', 'utf8')

/** Declarations of the `.producedAction` rule, comments stripped. */
const buttonRule = (() => {
  const rule = css.match(/^\.producedAction \{([\s\S]*?)\n\}/m)?.[1]
  return rule?.replace(/\/\*[\s\S]*?\*\//g, '')
})()

describe('produced-files row: the show-in-folder action', () => {
  it('resets the UA button chrome the label class alone cannot remove', () => {
    expect(buttonRule, '.producedAction must exist').toBeDefined()
    expect(buttonRule).toMatch(/border:\s*none/)
    expect(buttonRule).toMatch(/background:\s*transparent/)
    expect(buttonRule).toMatch(/border-radius:\s*999px/)
    expect(buttonRule).toMatch(/padding:\s*0\s+8px/)
  })

  it('keeps the action on the chips optical line', () => {
    expect(buttonRule).toMatch(/display:\s*inline-flex/)
    expect(buttonRule).toMatch(/align-items:\s*center/)
    expect(buttonRule).toMatch(/height:\s*20px/)
    expect(buttonRule).toMatch(/flex:\s*none/)
  })

  it('promotes the label on hover through tokens (no color of its own)', () => {
    const hover = css.match(/^\.producedAction:hover \{([\s\S]*?)\n\}/m)?.[1]
    expect(hover, 'the hover rule must exist').toBeDefined()
    expect(hover).toMatch(/background:\s*var\(--dsw-alias-interactive-bg-hover\)/)
    expect(hover).toMatch(/color:\s*var\(--dsw-alias-label-primary\)/)
  })

  it('keeps the keyboard focus ring', () => {
    const focusList = css.match(/^\.toggleButton:focus-visible,[\s\S]*?\{/m)?.[0]
    expect(focusList).toBeDefined()
    expect(focusList).toContain('.producedAction:focus-visible')
  })

  it('carries no inline style prop that would re-assert the old underline', () => {
    // The row's only inline-styled element was this button; the reset above is
    // the single source of truth for the action's appearance.
    expect(source).not.toMatch(/textDecoration|textUnderlineOffset/)
    expect(source).not.toMatch(/<button[\s\S]{0,200}?style=\{/)
  })
})
