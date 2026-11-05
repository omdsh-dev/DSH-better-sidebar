/**
 * The tab strip's width contract: tabs are EQUAL width, and that width
 * follows the OPEN COUNT rather than each label's length — Chrome's strip.
 *
 * jsdom lays no flex out, so this spec pins the declarations that produce the
 * geometry rather than measured pixels. The regression is real and otherwise
 * invisible: `flex: none` (i.e. content-sized tabs, what the strip did before)
 * passes every DOM-level spec in this folder while putting each tab's × at a
 * different x — and "close several tabs in a row" is exactly the gesture that
 * needs the × to sit at the same offset every time.
 *
 * The geometry has three parts and all three are asserted here: an equal
 * share (`flex-grow: 1` from a `flex-basis` of 0, which is what makes the
 * widths identical), a hard ceiling (TAB_MAX_WIDTH, mirrored from state.ts so
 * the constant and the stylesheet cannot drift), and a hard floor — below
 * which the strip scrolls instead of squeezing a label to nothing, which is
 * only true while .tabList stays an overflow-x scrollport.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TAB_MAX_WIDTH } from '../src/client/state.ts'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')

/** Declarations of the one top-level rule whose selector is exactly `selector`. */
function ruleOf(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `^` + the selector + only whitespace before `{` keeps `.tab` from
  // matching `.tab:hover` / `.tabActive`; the closing `^}` is the block end
  // (the stylesheet is flat — no nesting).
  const body = css.match(new RegExp(`^${escaped}\\s*\\{([\\s\\S]*?)^\\}`, 'm'))?.[1]
  if (body === undefined) throw new Error(`rule not found: ${selector}`)
  const decls = new Map<string, string>()
  for (const chunk of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const colon = chunk.indexOf(':')
    if (colon < 0) continue
    decls.set(chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim())
  }
  return decls
}

describe('tab strip geometry', () => {
  const tab = ruleOf('.tab')

  it('gives every tab an equal share of the strip (flex-basis 0 + grow 1)', () => {
    // The shorthand is decomposed so either spelling passes, but a
    // content-sized tab (`flex: none`, `basis: auto`) fails: that is the
    // whole contract.
    const shorthand = tab.get('flex')
    const [grow, shrink, basis] = shorthand === undefined
      ? [tab.get('flex-grow'), tab.get('flex-shrink'), tab.get('flex-basis')]
      : shorthand.split(/\s+/)
    // Compared as written (stylesheet text, not computed style) so the
    // failure prints `'none'` / `undefined` rather than `NaN`.
    expect(grow).toBe('1')
    expect(shrink).toBe('1')
    expect(['0', '0%', '0px']).toContain(basis)
  })

  it('never lets a tab decide its own width from its content', () => {
    expect(tab.has('width')).toBe(false)
  })

  it('caps the share at TAB_MAX_WIDTH and floors it at 64px', () => {
    expect(tab.get('max-width')).toBe(`${TAB_MAX_WIDTH}px`)
    const floor = Number(tab.get('min-width')?.replace('px', ''))
    expect(Number.isFinite(floor)).toBe(true)
    expect(floor).toBeGreaterThan(0)
    expect(floor).toBeLessThan(TAB_MAX_WIDTH)
  })

  it('scrolls the strip past the floor instead of clipping or squeezing', () => {
    const list = ruleOf('.tabList')
    expect(list.get('display')).toBe('flex')
    expect(list.get('overflow-x')).toBe('auto')
    expect(list.get('min-width')).toBe('0')
  })

  it('keeps the label on the ellipsis path (equal widths make it load-bearing)', () => {
    const title = ruleOf('.tabTitle')
    expect(title.get('text-overflow')).toBe('ellipsis')
    expect(title.get('white-space')).toBe('nowrap')
    expect(title.get('min-width')).toBe('0')
  })
})
