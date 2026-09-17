/**
 * Tailwind v4 + shadcn/ui foundation guards.
 *
 * The plugin ships ONE global stylesheet (src/client/ui/theme.css, compiled by
 * tsdown's css-inline plugin into `<style data-plugin>`), and the two ways that
 * can go wrong are silent:
 *
 * 1. Someone adds `@import "tailwindcss"` (or preflight) — the reset then
 *    repaints the entire DSH host page, because plugin CSS is not scoped by a
 *    shadow root. The first test locks the import list and the layer names; the
 *    bundle test looks for preflight's own selectors in the built artifact.
 * 2. Someone bridge a shadcn token to a literal instead of a `--dsw-*` token —
 *    a dark/light theme switch then leaves the plugin's controls unreadable.
 *    That is the skin contract (docs/external-plugin-guide.md §12).
 *
 * `@source` is also guarded: if it disappears, Tailwind falls back to scanning
 * the project root (lib/, tests/, node_modules/), which both bloats the bundle
 * and lets `lib/*.js` class-like strings feed the scanner.
 */
// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileTailwind } from '../tsdown.config.ts'

const ROOT = process.cwd()
const THEME_CSS = resolve(ROOT, 'src/client/ui/theme.css')
const CLIENT_BUNDLE = resolve(ROOT, 'lib/client.js')
/** The lazy chunk that carries the Tasks page and the shadcn layer. */
const TASKS_CHUNK = resolve(ROOT, 'lib/client-tasks.js')

/** The shadcn token -> DSH token bridge, as specified by the design language. */
const TOKEN_BRIDGE: Array<[shadcn: string, dsw: string]> = [
  ['--background', '--dsw-alias-bg-base'],
  ['--foreground', '--dsw-alias-label-primary'],
  ['--card', '--dsw-alias-bg-layer-1'],
  ['--card-foreground', '--dsw-alias-label-primary'],
  ['--popover', '--dsw-alias-bg-layer-2'],
  ['--popover-foreground', '--dsw-alias-label-primary'],
  ['--primary', '--dsw-alias-state-business-primary'],
  ['--primary-foreground', '--dsw-alias-label-primary-foreground'],
  ['--secondary', '--dsw-alias-interactive-bg-hover'],
  ['--secondary-foreground', '--dsw-alias-label-primary'],
  ['--muted', '--dsw-alias-interactive-bg-hover'],
  ['--muted-foreground', '--dsw-alias-label-secondary'],
  ['--accent', '--dsw-alias-interactive-bg-hover'],
  ['--accent-foreground', '--dsw-alias-label-primary'],
  ['--destructive', '--dsw-alias-state-error-primary'],
  ['--destructive-foreground', '--dsw-alias-label-primary-foreground'],
  ['--border', '--dsw-alias-border-l4'],
  ['--input', '--dsw-alias-border-l4'],
  ['--ring', '--dsw-alias-state-business-primary'],
  ['--success', '--dsw-alias-state-success-primary'],
  ['--warning', '--dsw-alias-state-warn-primary'],
  ['--foreground-3', '--dsw-alias-label-tertiary'],
  ['--border-strong', '--dsw-alias-label-tertiary'],
]

describe('tailwind entry: theme + utilities only', () => {
  const theme = readFileSync(THEME_CSS, 'utf8')

  it('imports exactly the theme and utilities layers, and never preflight', () => {
    const imports = [...theme.matchAll(/@import\s+"([^"]+)"\s+layer\(([^)]+)\);/g)]
      .map(match => [match[1], match[2]])
    expect(imports).toEqual([
      ['tailwindcss/theme.css', 'theme'],
      ['tailwindcss/utilities.css', 'utilities'],
    ])
    // No bare `@import "tailwindcss"` and no stylesheet path that could be the
    // reset (both forms pull preflight in; the file's own comment is prose).
    expect(theme).not.toMatch(/@import\s+"tailwindcss"/)
    expect(theme).not.toMatch(/@import\s+"[^"]*preflight/)
  })

  it('scans only the client TSX tree', () => {
    expect(theme).toMatch(/@source\s+"\.\.\/\*\*\/\*\.tsx";/)
  })

  it('defines the dark variant from the host attribute, not a .dark class', () => {
    expect(theme).toMatch(/@custom-variant\s+dark\s+\(&:where\(\[data-ds-dark-theme\],\s*\[data-ds-dark-theme\]\s*\*\)\);/)
    expect(theme).not.toMatch(/@custom-variant\s+dark\s+\(&:where\(\.dark/)
  })

  it('bridges every shadcn token to a DSH token', () => {
    for (const [name, dsw] of TOKEN_BRIDGE) {
      expect(theme, name).toContain(`${name}: var(${dsw})`)
    }
  })

  it('carries the radius scale and the scoped base reset', () => {
    for (const [name, value] of [['--radius', '6px'], ['--radius-sm', '4px'], ['--radius-md', '6px'], ['--radius-lg', '8px'], ['--radius-xl', '12px']]) {
      expect(theme, name).toContain(`${name}: ${value}`)
    }
    expect(theme).toMatch(/\.dsw-tasks\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary\)/)
    expect(theme).toMatch(/\.dsw-tasks\s+:where\(button, input, textarea, select\)\s*\{[^}]*font:\s*inherit/)
    expect(theme).toMatch(/\.dsw-tasks\s+:where\(\*, \*::before, \*::after\)\s*\{[^}]*box-sizing:\s*border-box/)
    // Motion is opt-out-able.
    expect(theme).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })

  it('scopes every portal-rendered popover root back under .dsw-tasks', () => {
    // The popovers are portaled to document.body, i.e. OUTSIDE the page root
    // that carries `.dsw-tasks` — without the class on their own root the
    // scoped base reset (font inheritance, box-sizing, focus-visible ring on
    // bare controls) silently stops applying there. Regression: the first
    // migration shipped TaskWindow with the class but not the two node
    // popovers nor the job-output popover.
    const portalContents = [
      'src/client/TaskWindow.tsx',
      'src/client/TasksPopovers.tsx',
      'src/client/JobsDrawer.tsx',
    ]
    for (const file of portalContents) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      expect(source, file).toContain('dsw-tasks')
    }
    // The shell itself portals — that is the reason the class is needed.
    const shell = readFileSync(resolve(ROOT, 'src/client/AnchoredPopover.tsx'), 'utf8')
    expect(shell).toContain('createPortal')
  })

  it('holds the skin contract: no color literal anywhere in the entry', () => {
    // Comments carry prose, not values — strip them before looking.
    const withoutComments = theme.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(withoutComments).not.toMatch(/\b(?:rgba?|hsla?|oklch|lab|lch|color-mix)\(/)
    // Every custom-property value is either a DSH token, another token defined
    // in this file (the @theme inline block), or a length from the radius
    // scale — never a paint value of its own.
    const definedElsewhere = new Set([
      ...TOKEN_BRIDGE.map(([name]) => name.slice(2)),
      'radius', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl',
    ])
    for (const declaration of withoutComments.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
      const [, name, raw] = declaration
      const value = (raw ?? '').trim()
      const reference = value.match(/^var\(--([a-z0-9-]+)/)
      const refName = reference?.[1]
      const ok = (refName !== undefined && (refName.startsWith('dsw-') || definedElsewhere.has(refName)))
        || /^[0-9.]+(?:px|rem|em|%)$/.test(value)
      expect(ok, `${name}: ${value}`).toBe(true)
    }
  })
})

describe('tailwind compile: the shared pipeline produces utilities bound to DSH tokens', () => {
  it('emits utilities and the token indirection, and no preflight', async () => {
    const css = await compileTailwind(readFileSync(THEME_CSS, 'utf8'), THEME_CSS, { minify: true })
    expect(css).toMatch(/--tw-/)
    expect(css).toMatch(/\.flex\{/)
    expect(css).toContain('var(--dsw-alias-state-business-primary)')
    expect(css).toContain('.dsw-tasks')
    // Preflight's actual signature is its universal reset block. The selector
    // spelling alone is not enough (minification rewrites `::before` to
    // `:before`, and the utilities layer's own `*,:before,:after,::backdrop`
    // @property fallback shares the selector list), and
    // `::file-selector-button` is not a signature at all: Tailwind's `file:`
    // variant emits it legitimately for the vendored Input's file button.
    expect(css).not.toMatch(/box-sizing:\s*border-box;\s*margin:\s*0/)
    expect(css).not.toContain('-webkit-text-size-adjust')
  })
})

describe('built artifacts: tailwind inlined, no preflight, no new deps', () => {
  const built = existsSync(CLIENT_BUNDLE)
  // `pnpm build` is a gate command, not a test prerequisite; skip loudly rather
  // than fail a checkout that has not been built yet.
  //
  // The Tasks page (and therefore the shadcn layer's stylesheet) lives in the
  // lazy `tasks` chunk, so the compiled utilities are asserted against THAT
  // artifact; tests/ui-bundle.spec.ts owns the core/chunk split contract.
  const chunkBuilt = existsSync(TASKS_CHUNK)
  it.skipIf(!chunkBuilt)('inlines the compiled utilities into the tasks chunk', () => {
    const bundle = readFileSync(TASKS_CHUNK, 'utf8')
    expect(bundle).toMatch(/--tw-/)
    expect(bundle).toMatch(/\.flex\{/)
    // The scoped base reset travels with the utilities.
    expect(bundle).toContain('.dsw-tasks')
    expect(bundle).toContain('--dsw-alias-state-business-primary')
  })

  it.skipIf(!built)('keeps the core bundle free of the tailwind layer', () => {
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    expect(bundle).not.toMatch(/--tw-/)
    expect(bundle).not.toContain('radix-ui')
  })

  it.skipIf(!built)('ships no preflight reset', () => {
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    expect(bundle).not.toMatch(/\*,::before,::after/)
    expect(bundle).not.toMatch(/\*, ::before, ::after/)
    // The minifier rewrites `::before` to `:before`, so the selector spelling
    // is not a complete signature — the reset's declaration payload is.
    expect(bundle).not.toMatch(/box-sizing:\s*border-box;\s*margin:\s*0/)
    expect(bundle).not.toContain('-webkit-text-size-adjust')
  })

  it.skipIf(!built)('ships no color literal from the tailwind palette', () => {
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    // Tailwind's default palette is defined in oklch; any hit means a palette
    // value leaked into the sheet instead of a --dsw-* token.
    expect(bundle).not.toContain('oklch(')
    expect(bundle).not.toContain('lucide-react')
  })
})
