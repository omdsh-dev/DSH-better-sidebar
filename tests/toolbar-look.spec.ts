/**
 * The Browser toolbar as the approved stories draw it (acceptance of stage 5, TCH
 * `tasks/evidence/comment-thread/acceptance.md`, F10 + F17; stories `ToolbarCommentsSplit*` in
 * `browser-comment.mock.stories.tsx`). Read from the stylesheet and the component source: the tests'
 * CSS modules are stubbed (dsh's Pill classes do not reach the DOM here), and a colour or an offset is
 * what these two findings are about.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')
const layer = readFileSync('src/client/CommentLayer.tsx', 'utf8')

/** One rule's body, by its exact selector. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `no rule ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}
const px = (body: string, prop: string): number => {
  const m = new RegExp(`\\n\\s*${prop}: (-?\\d+)px`).exec(body)
  expect(m, `no ${prop} in px`).not.toBeNull()
  return Number(m![1])
}

describe('F10 · the zoom chip is neutral, as the stories draw it (not the brand tint)', () => {
  it('no brand colour on the chip, the label colour and an outline instead', () => {
    const chip = rule('.modeBar .zoomChip')
    expect(chip).not.toMatch(/brand-primary/)
    expect(chip).toMatch(/color: var\(--dsw-alias-label-primary\)/)
    expect(chip).toMatch(/border-l1/)
    expect(rule('.modeBar .zoomChip:hover')).not.toMatch(/brand-primary/)
  })

  it('the chip is not dsh\'s "active" Pill (its fill reads as a mode that is on)', () => {
    const pill = /<Pill\b[^>]*className=\{css\.zoomChip\}[^>]*>/s.exec(layer)
    expect(pill).not.toBeNull()
    expect(pill![0]).not.toMatch(/\bactive\b/)
  })
})

describe('F17 · the compact count badge stays inside the toolbar', () => {
  it('its offset above the button plus its 2 px ring fit in the bar\'s top padding', () => {
    const corner = rule('.commentsCountCorner')
    const ring = /box-shadow: 0 0 0 (\d+)px/.exec(corner)
    expect(ring).not.toBeNull()
    const barPadding = Number(/\n\s*padding: (\d+)px/.exec(rule('.browserBar'))![1])
    // The button sits 1 px under the split's border; the badge rises -top px above it, its ring more.
    expect(-px(corner, 'top') + Number(ring![1]) - 1).toBeLessThanOrEqual(barPadding - 1)
  })
})
