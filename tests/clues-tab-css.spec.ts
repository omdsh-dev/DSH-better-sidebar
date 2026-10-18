/**
 * The clue tab's responsive contract (S9).
 *
 * The native right sidebar is a COLUMN whose width is independent of the
 * browser viewport: it can be 390px on a 1920px desktop, or a wide 600px rail
 * beside a narrow window. A viewport `@media` breakpoint therefore stacks or
 * un-stacks the wrong way. This spec pins the tab root as an inline-size
 * container and the wide layout as a `@container` query on that column.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/clues/tab/clues-tab.module.css', 'utf8')
/** Strip comments so prose about breakpoints cannot satisfy a match. */
const text = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('clue tab container-query layout', () => {
  it('makes the tab root an inline-size container', () => {
    expect(text).toMatch(/\.root\s*\{[^}]*container-type:\s*inline-size/)
  })

  it('uses the column width for the wide side-rail layout, never the viewport', () => {
    expect(text).not.toMatch(/@media[^{]*min-width/)
    expect(text).toMatch(/@container\s+clue-tab\s*\(min-width:\s*520px\)/)
    const containerBlock = text.slice(text.indexOf('@container clue-tab'))
    expect(containerBlock).toMatch(/\.browserBody\s*\{[^}]*flex-direction:\s*row/)
    expect(containerBlock).toMatch(/\.sourceNav\s*\{[^}]*flex-direction:\s*column/)
  })

  it('keeps the 320/390px column in the stacked layout', () => {
    // The wide breakpoint must stay above the narrow phone widths the native
    // sidebar can take, otherwise those columns get the side rail.
    const width = Number(/@container\s+clue-tab\s*\(min-width:\s*(\d+)px\)/.exec(text)?.[1])
    expect(width).toBeGreaterThanOrEqual(480)
    expect(width).toBeLessThanOrEqual(600)
  })
})
