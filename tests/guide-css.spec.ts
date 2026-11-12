/**
 * Start-page card subtitles are a single line: descriptions longer than the
 * card width must end in an ellipsis instead of wrapping to a second line.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/native/guide.module.css', 'utf8')

describe('start-page card description', () => {
  it('uses one-line ellipsis instead of a two-line clamp', () => {
    const rule = css.match(/\.cardDesc\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/white-space:\s*nowrap/)
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).not.toContain('line-clamp')
  })

  it('centers More-menu glyphs in a fixed box', () => {
    const rule = css.match(/\.menuIcon\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/display:\s*inline-flex/)
    expect(rule).toMatch(/align-items:\s*center/)
    expect(rule).toMatch(/justify-content:\s*center/)
    expect(rule).toMatch(/width:\s*14px/)
    expect(rule).toMatch(/height:\s*14px/)
    expect(css).toMatch(/\.menuIcon\s*>\s*span\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.menuIcon\s+svg\s*\{[^}]*display:\s*block/)
  })
})
