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

/** Strip block comments (`/*` to `*`-`/`) so prose mentions don't count as declarations. */
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

  it('keeps the app-region opt-out that un-breaks macOS window drag (issue #772)', () => {
    // The shell's `html[data-platform=darwin] body > :not(#root) { no-drag }`
    // carries an id in its specificity, so only `initial !important` wins;
    // `initial` computes to the NEUTRAL `none` (does not subtract from the
    // drag region) while `no-drag` is the subtracting value — and the literal
    // keyword `none` is NOT neutral (it computes to `no-drag`), which is
    // exactly why this guard pins `initial`. Hence the split: decorative
    // viewport-sized layers opt out, their panels stay no-drag so controls
    // keep receiving clicks. Dropping the `!important` silently re-breaks
    // window drag / double-click-title zoom on macOS (there is no macOS
    // runner to catch it), so pin the shape here where Linux `pnpm test`
    // fails instead.
    const text = stripComments(css)
    expect(text, 'the panel host must opt out of app-region computation').toMatch(
      /:global\(\[data-dsh-panel-host\]\)\s*\{[^}]*-webkit-app-region:\s*initial\s*!important/,
    )
    expect(text, 'panels must stay no-drag').toMatch(
      /:global\(\[data-dsh-panel-host\]\)\s*>\s*\*\s*\{[^}]*-webkit-app-region:\s*no-drag/,
    )
    expect(text, 'the mermaid zoom modal is the other persistent viewport-sized body child').toMatch(
      /\.mermaidModal\s*\{[^}]*-webkit-app-region:\s*initial\s*!important/,
    )
    // The interactive popups must NOT get `initial`: they are buttons/handles
    // the shell already keeps no-drag, and outranking that rule makes a press
    // start a window drag (the #103/#111 click-swallow class). Checked per
    // DECLARATION BLOCK, not per single-selector rule: a selector list
    // (`.selectionPopup, .other { … initial !important }`) would slip past a
    // simple "class immediately followed by {" pattern.
    const resets = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /-webkit-app-region:\s*initial/.test(body ?? ''))
    expect(resets.length, 'the file must declare the app-region opt-out').toBeGreaterThan(0)
    const resetSelectors = resets.map(([, selector]) => selector ?? '').join(',')
    for (const excluded of ['selectionPopup']) {
      expect(resetSelectors, `${excluded} must not opt out of app-region`).not.toContain(excluded)
    }
  })
})

/**
 * The mermaid zoom modal's surface must stay on the FIXED viewport, never on
 * the element the modal transforms (issue #683).
 *
 * The white card used to be painted on the diagram's own `<svg>`, and the
 * modal scales exactly that element — so every wheel step grew the white area
 * together with the diagram and the content:viewport ratio never changed
 * ("跟没有缩放没区别"). `mermaid.tsx` now transforms the content only; these
 * assertions pin the CSS half, which is the half that silently regresses when
 * someone moves the paint back for a cosmetic reason.
 */
describe('mermaid zoom modal surface css (issue #683)', () => {
  /** Body of one rule, up to the un-indented closing brace. */
  const ruleBody = (selector: string): string | undefined =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`)
      .exec(stripComments(css))?.[1]

  it('paints the card on the stage (the fixed viewport)', () => {
    const stage = ruleBody('.mermaidModalStage')
    expect(stage, 'the .mermaidModalStage rule must exist').toBeDefined()
    expect(stage, 'the viewport owns the surface').toMatch(/background:\s*var\(--dsw-alias-/)
    expect(stage, 'and the ring that survives zooming').toMatch(/padding:\s*16px/)
  })

  it('leaves the transformed svg with no surface of its own', () => {
    const svg = ruleBody('.mermaidModalStage :global(svg)')
    expect(svg, 'the .mermaidModalStage svg rule must exist').toBeDefined()
    for (const paint of ['background', 'padding', 'border-radius']) {
      expect(svg, `the transformed svg must not carry ${paint} (issue #683)`).not.toContain(paint)
    }
    expect(svg, 'the content still scales about its own centre').toMatch(/transform-origin:\s*center center/)
  })

  it('clips the transformed svg inside the padding ring', () => {
    const viewport = ruleBody('.mermaidViewport')
    expect(viewport, 'the .mermaidViewport rule must exist').toBeDefined()
    expect(viewport).toMatch(/overflow:\s*hidden/)
    expect(viewport).toMatch(/cursor:\s*grab/)
  })
})
