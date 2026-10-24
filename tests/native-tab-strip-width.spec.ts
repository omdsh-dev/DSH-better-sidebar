/**
 * The native right-sidebar tab strip's width contract (the HOST's chip row).
 *
 * The chips belong to the host's docking kit, which sizes each one from its
 * title (`flex: 0 1 auto`, min 80 / max 170) — so a strip of differently
 * titled tabs puts every close button at a different x, and "close a few tabs
 * in a row" turns into a hunt for the ×. There is no host API for chip
 * geometry, so the plugin's narrowest lever is three declarations in
 * layout.css, anchored on the semantic attributes the host's own layout code
 * reads (`data-dockkit-strip-tabs` / `data-dockkit-tab` /
 * `data-dockkit-strip-fill`) and scoped to `[data-sidebar-right-panel]`.
 *
 * This spec pins the three things that keep that lever safe:
 *  1. the declarations (chip row claims the slack, fill spacer yields, chips
 *     share it equally) — dropping any one leaves the row content-sized or
 *     half-split with the spacer, neither of which is equal-width;
 *  2. the SCOPE — every `[data-dockkit-*]` rule must carry the right-panel
 *     attribute, so the float panel header (which reuses the kit's `.tab` /
 *     `.stripFill` classes) can never be caught by them;
 *  3. no class names and no `!important` — class-anchored rules would ride the
 *     kit's CSS-module hashes (they change between versions), and specificity
 *     is already enough (two attributes out-specify the host's single class).
 *
 * Failure mode is silence by design: if a host version renames the attributes,
 * these selectors stop matching and the chips fall back to the host's own
 * sizing — so the guarded property is "we never restyle more than the strip",
 * not "the strip is always equal".
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/client/layout.css', 'utf8')
const css = source.replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  selector: string
  decls: Map<string, string>
}

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => {
  const decls = new Map<string, string>()
  for (const chunk of (match[2] ?? '').split(';')) {
    const colon = chunk.indexOf(':')
    if (colon < 0) continue
    decls.set(chunk.slice(0, colon).trim().toLowerCase(), chunk.slice(colon + 1).trim())
  }
  return { selector: (match[1] ?? '').trim().replace(/\s+/g, ' '), decls }
})

const HOST_HOOK = '[data-dockkit-'
const panelRules = rules.filter(rule => rule.selector.includes(HOST_HOOK))

/** The one rule whose selector is exactly `selector`. */
function ruleOf(selector: string): Rule {
  const found = rules.find(rule => rule.selector === selector)
  if (found === undefined) throw new Error(`rule not found: ${selector}`)
  return found
}

describe('native tab strip width', () => {
  it('anchors every host chip-row rule on the right-panel attribute', () => {
    expect(panelRules.length).toBeGreaterThanOrEqual(3)
    for (const rule of panelRules) {
      // A bare `[data-dockkit-tab]` would restyle every docking surface in
      // the page (the float header included); the panel scope is the contract.
      expect(rule.selector.startsWith('[data-sidebar-right-panel] ')).toBe(true)
    }
  })

  it('never names a host class or escalates specificity', () => {
    for (const rule of panelRules) {
      // `.tab` / `.stripFill` are the kit's CSS-module output: their hashes
      // change between versions, and the float header shares them.
      expect(rule.selector).not.toContain('.')
      expect(rule.selector).not.toContain('!')
      expect([...rule.decls.values()].some(value => value.includes('!important'))).toBe(false)
    }
  })

  it('lets the chip row claim the strip and the fill spacer yield', () => {
    expect(ruleOf('[data-sidebar-right-panel] [data-dockkit-strip-tabs]').decls.get('flex')).toBe('1 1 0')
    expect(ruleOf('[data-sidebar-right-panel] [data-dockkit-strip-fill]').decls.get('flex')).toBe('0 0 0')
  })

  it('gives every chip an equal share of that row', () => {
    const chip = ruleOf('[data-sidebar-right-panel] [data-dockkit-tab]')
    const flex = chip.decls.get('flex')?.split(/\s+/) ?? []
    expect(flex[0]).toBe('1')
    expect(flex[1]).toBe('1')
    expect(['0', '0%', '0px']).toContain(flex[2])
    // No width/max-width override: the host keeps its own floor and ceiling
    // (min 80 / max 170), so only the distribution changes.
    expect(chip.decls.has('width')).toBe(false)
    expect(chip.decls.has('max-width')).toBe(false)
    expect(chip.decls.has('min-width')).toBe(false)
  })
})
