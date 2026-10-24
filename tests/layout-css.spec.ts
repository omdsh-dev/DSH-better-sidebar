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

describe('layout.css block structure', () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

  it('closes the reduced-motion block before the rest of the sheet', () => {
    // An unclosed @media block is implicitly closed at EOF, which silently
    // swallows every rule after it. That shipped from v0.26.0 through v0.28.0:
    // the submenu-flip/tether rules and the native-chip width rules compiled
    // into the bundle but never applied in a normal (no reduced-motion)
    // browser. Brace balance is the cheap tell; the block boundary is the
    // contract.
    const open = (bare.match(/\{/g) ?? []).length
    const close = (bare.match(/\}/g) ?? []).length
    expect(open).toBe(close)

    const start = bare.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    let end = -1
    for (let i = start; i < bare.length; i += 1) {
      if (bare[i] === '{') depth += 1
      else if (bare[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    expect(end, 'the reduced-motion block never closes').toBeGreaterThan(-1)
    const block = bare.slice(start, end)
    expect(block).toContain('#root [data-dsh-center-col]')
    // Everything else must stay OUT of it: these are unconditional rules.
    expect(block).not.toContain('[data-dsh-sidebar-submenu')
    expect(block).not.toContain('[data-dockkit-tab]')
    expect(block).not.toContain('[data-dsh-better-sidebar-settings-nav]')
  })
})
