/** Skin/affordance contracts for the shared disclosure and retained transfer controls. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('gives the workbench header a visible resting border and distinct press/focus states', () => {
  const css = readFileSync('src/client/ui/workbench-section.module.css', 'utf8')
  expect(css).toMatch(/\.header\s*\{[^}]*border-top:\s*1px solid var\(--dsw-alias-border-l2\)/)
  expect(css).toMatch(/\.toggle:active\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-active\)/)
  expect(css).toMatch(/\.toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(/)
})
it('distinguishes floating frames with a slightly stronger token-driven edge', () => {
  const css = readFileSync('src/client/FloatingWindow.module.css', 'utf8')
  expect(css).toMatch(/\.window\s*\{[^}]*border:\s*2px solid var\(--dsw-alias-border-l4\)/)
})
it('keeps the icon+text transfer control nonshrinking at narrow widths', () => {
  const css = readFileSync('src/client/FloatingWindow.module.css', 'utf8')
  expect(css).toMatch(/\.surfaceControl\s*\{[^}]*flex:\s*none;[^}]*white-space:\s*nowrap/)
  expect(css).toMatch(/\.surfaceControl svg\s*\{[^}]*flex:\s*none/)
})
