/**
 * The unified panel host layer must clip WITHOUT being a scroll container —
 * the guard for the "panels / toggle cluster jumped away from the viewport
 * corner" bug class.
 *
 * `overflow: hidden` only clips: the box stays a scroll container, so any
 * script scroll or the browser's native scroll-into-view fixup (focus moving
 * into an off-viewport region, a nested workbench/iframe claiming focus
 * while it loads, focus() landing during a panel's slide-out transition)
 * walks up to the nearest scrollable ancestor — this layer — and scrolls it,
 * dragging every panel plus the toggle cluster off the corner while the
 * computed `left`/`right` still read correct (the offset hides in the box's
 * own scroll offset). `overflow: clip` declared AFTER `hidden` keeps the
 * `hidden` fallback for engines without clip support and removes the
 * scrollability everywhere else; the cascade order is part of the contract.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')

/** Body of the `:global([data-dsh-panel-host])` rule (up to the un-indented `}`). */
const hostRule = css.match(/:global\(\[data-dsh-panel-host\]\) \{([\s\S]*?)\n\}/)?.[1]

/** Strip /* ... *​/ comment blocks so prose mentions don't count as declarations. */
const stripComments = (cssText: string): string => cssText.replace(/\/\*[\s\S]*?\*\//g, '')

describe('panel host layer css', () => {
  it('declares the clip cascade: hidden first, clip last', () => {
    expect(hostRule, 'the [data-dsh-panel-host] rule must exist').toBeDefined()
    const declarations = stripComments(hostRule!).match(/overflow\s*:\s*\w+/g) ?? []
    expect(declarations).toEqual(['overflow: hidden', 'overflow: clip'])
  })

  it('stays the fixed viewport layer (containing block + BFC guarantee)', () => {
    expect(hostRule).toMatch(/position:\s*fixed/)
    expect(hostRule).toMatch(/inset:\s*0/)
  })

  it('does not reintroduce overflow on the degraded (absolute) layer', () => {
    const degraded = css.match(
      /:global\(\[data-dsh-panel-host\]\[data-dsh-panel-host-degraded\]\) \{([\s\S]*?)\n\}/,
    )?.[1]
    expect(degraded, 'the degraded-mode rule must exist').toBeDefined()
    expect(degraded).not.toMatch(/overflow\s*:/)
  })
})
