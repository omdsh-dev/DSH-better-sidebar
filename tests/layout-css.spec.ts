/**
 * layout.css must let the DSH conversation column shrink below its content
 * size. Without min-height:0 a long unbreakable URL grows the grid item
 * past the viewport and clips the composer.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/layout.css', 'utf8')

describe('layout.css conversation column', () => {
  it('targets the AppFrame center column through the shell-written tag', () => {
    // The bottom-push rule anchors on the [data-dsh-center-col] tag the
    // Sidebar shell's locator writes onto the measured column node (see
    // Sidebar.tsx locate) — not on a `:has()` selector, whose cache
    // invalidates on every #root subtree mutation (the streaming chat).
    expect(css).toContain('[data-dsh-center-col]')
    expect(css).not.toContain(':has(')
  })

  it('allows the center column to shrink and wrap long tokens', () => {
    expect(css).toMatch(/min-height:\s*0/)
    expect(css).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('leaves overflow ownership to the host conversation descendants', () => {
    const conversationRule = css.match(
      /#root \[data-dsh-center-col\][\s\S]*?\{([\s\S]*?)\n\}/,
    )?.[1]
    expect(conversationRule).toBeDefined()
    expect(conversationRule).not.toMatch(/(?:^|[;\s])overflow\s*:/)
  })
})
