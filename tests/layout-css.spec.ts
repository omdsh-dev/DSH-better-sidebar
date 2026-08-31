/**
 * layout.css must let the DSH conversation column shrink below its content
 * size. Without min-height:0 a long unbreakable URL grows the grid item
 * past the viewport and clips the composer.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/layout.css', 'utf8')

describe('layout.css conversation column', () => {
  it('targets the AppFrame center column', () => {
    expect(css).toContain('[data-pane="conversation"]')
    expect(css).toContain('[data-slot="conversation"]')
  })

  it('allows the center column to shrink and wrap long tokens', () => {
    expect(css).toMatch(/min-height:\s*0/)
    expect(css).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('leaves overflow ownership to the host conversation descendants', () => {
    const conversationRule = css.match(
      /#root \[data-dsh-frame\][\s\S]*?\{([\s\S]*?)\n\}/,
    )?.[1]
    expect(conversationRule).toBeDefined()
    expect(conversationRule).not.toMatch(/(?:^|[;\s])overflow\s*:/)
  })
})

/**
 * The layout push has to outrank the host shell's own #root rule by
 * SPECIFICITY, not by <style> order. DSH Desktop (dsh-plugin-desktop) injects
 * `html, body, #root { width: 100% }` at runtime; against a bare `#root` push
 * rule that is a tie broken by whichever plugin's <style> lands in <head>
 * last. When the shell wins, `width: 100%` beats the calc and `margin-right`
 * just shoves a full-width #root off the right edge — the conversation keeps
 * the whole viewport and the panel COVERS it instead of squeezing it
 * (reproduced on DSH Desktop `mode: advanced`). Two leading type selectors
 * make the push win the cascade outright.
 */
describe('layout.css push specificity', () => {
  /** Push declarations that a same-specificity host rule could otherwise win. */
  const pushRules = [
    'html body #root {',
    'html body #root [data-dsh-frame] > [data-pane="conversation"],',
    'html body #root :has(> [data-slot="conversation"]) {',
  ]

  it('anchors every push rule above a bare #root', () => {
    for (const rule of pushRules) expect(css).toContain(rule)
  })

  it('never declares the push against a bare #root selector', () => {
    // A line starting `#root` (no `html body` prefix) is the regression.
    expect(css).not.toMatch(/^#root\b/m)
  })

  it('keeps the drag and reduced-motion overrides able to beat the push', () => {
    // Dragging: `body[...]` adds an attribute (b=1) and outranks the push's
    // b=0, so the transition-disable still wins at any type-selector count.
    expect(css).toMatch(/^body\[data-dsh-sidebar-dragging\] #root,$/m)
    // Reduced motion: same specificity as the push, so it must stay LATER in
    // the file to win.
    const push = css.indexOf('html body #root {')
    const reduced = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(push).toBeGreaterThan(-1)
    expect(reduced).toBeGreaterThan(push)
    expect(css.slice(reduced)).toContain('html body #root,')
  })
})
