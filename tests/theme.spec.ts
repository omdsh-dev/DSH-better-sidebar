/**
 * Live theme-token access tests — issue #90's guard.
 *
 * `effectiveTokenValue` must treat visually inert values (CSS reset
 * keywords, `transparent`, and any color below the opacity floor) as UNSET
 * so callers' `|| fallback` chains fire. Skin systems set global tokens like
 * `--dsw-alias-bg-base` to `transparent` or translucent glass values (the
 * dsh-web-ui skins use rgba 0.16–0.7); without this guard a
 * truthy-but-inert value would leave the terminal/editor see-through over
 * the skin's backdrop. Effectively opaque values (>= 0.9 alpha, including a
 * skin's scoped 0.96 porcelain) pass through so the skin still controls the
 * surface.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { colorAlpha, effectiveTokenValue, tokenValue } from '../src/client/theme.ts'

afterEach(() => {
  document.body.removeAttribute('style')
})

describe('colorAlpha', () => {
  it('parses the hex family', () => {
    expect(colorAlpha('#fff')).toBe(1)
    expect(colorAlpha('#fff8')).toBeCloseTo(0x88 / 255)
    expect(colorAlpha('#112233')).toBe(1)
    expect(colorAlpha('#11223344')).toBeCloseTo(0x44 / 255)
  })

  it('parses rgb()/rgba() in comma and space syntax', () => {
    expect(colorAlpha('rgb(1, 2, 3)')).toBe(1)
    expect(colorAlpha('rgba(255, 255, 255, 0.45)')).toBeCloseTo(0.45)
    expect(colorAlpha('rgb(255 255 255 / 0.7)')).toBeCloseTo(0.7)
  })

  it('parses hsl()/hsla()', () => {
    expect(colorAlpha('hsl(200, 50%, 50%)')).toBe(1)
    expect(colorAlpha('hsla(200, 50%, 50%, 0.3)')).toBeCloseTo(0.3)
  })

  it('treats unparseable formats as opaque', () => {
    expect(colorAlpha('white')).toBeNull()
    expect(colorAlpha('')).toBeNull()
  })
})

describe('effectiveTokenValue', () => {
  it('passes through real opaque paint values verbatim', () => {
    document.body.style.setProperty('--probe', '#112233')
    expect(effectiveTokenValue('--probe')).toBe('#112233')
    // Effectively opaque translucency (a skin's scoped 0.96 porcelain glass)
    // is a deliberate surface choice — it passes through.
    document.body.style.setProperty('--probe', 'rgba(10, 22, 54, 0.96)')
    expect(effectiveTokenValue('--probe')).toBe('rgba(10, 22, 54, 0.96)')
  })

  it('treats transparent and CSS reset keywords as unset', () => {
    for (const inert of ['transparent', 'initial', 'inherit', 'unset']) {
      document.body.style.setProperty('--probe', inert)
      expect(effectiveTokenValue('--probe'), inert).toBe('')
    }
  })

  it('treats translucent glass values below the opacity floor as unset', () => {
    // The dsh-web-ui skins set bg-base to rgba 0.16–0.7 for glass panels;
    // the terminal must fall back to an opaque background there.
    for (const glass of ['rgba(255, 255, 255, 0.45)', 'rgba(20, 26, 46, 0.7)', '#11223344']) {
      document.body.style.setProperty('--probe', glass)
      expect(effectiveTokenValue('--probe'), glass).toBe('')
    }
  })

  it('treats a missing token as unset', () => {
    expect(effectiveTokenValue('--never-defined')).toBe('')
  })

  it('tokenValue still returns the raw value', () => {
    document.body.style.setProperty('--probe', 'transparent')
    expect(tokenValue('--probe')).toBe('transparent')
    expect(effectiveTokenValue('--probe')).toBe('')
  })
})

/**
 * Skin contract (guide §12): every visual value rides a `--dsw-alias-*` /
 * `--dsw-font-*` / `--ds-*` token, and the plugin draws no color of its own.
 *
 * File icons are no exception to check any more: the built-in set IS DSH's
 * `FileTypeIcon` artwork from a platform module (the host owns those pixels
 * and its own palette), and everything the plugin renders around them —
 * including the colored tab glyphs — rides theme tokens. So the guard is
 * simply that no plugin module carries a color literal, and that no icon
 * dataset sneaked back in as a chunk.
 */
// jsdom has no file:// import.meta.url; vitest runs from the repo root.
const ROOT = process.cwd()

describe('skin contract: the plugin owns no color of its own', () => {
  it('the icon modules carry no color literals', () => {
    for (const file of ['src/client/file-icons.tsx', 'src/client/icons.tsx']) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(source, file).not.toMatch(/\brgba?\(/)
    }
  })

  it('the colored tab glyphs take their color from theme tokens, never from a literal', () => {
    const module = readFileSync(resolve(ROOT, 'src/client/builtins/tab-icons.tsx'), 'utf8')
    expect(module).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(module).not.toMatch(/\brgba?\(/)
    // Each glyph is wrapped in a themed class, which is how the color arrives.
    const styles = readFileSync(resolve(ROOT, 'src/client/builtins/tab-icons.module.css'), 'utf8')
    const classes = [...module.matchAll(/css\.([a-zA-Z]+)/g)].map(m => m[1])
    expect(classes.length).toBeGreaterThan(0)
    for (const name of new Set(classes)) expect(styles, name).toContain(`.${name}`)
    // Every declaration that paints a color resolves to a token.
    for (const declaration of styles.matchAll(/color:\s*([^;]+);/g)) {
      expect(declaration[1], declaration[0]).toContain('var(--dsw-')
    }
  })

  it('no icon dataset is shipped as a lazy chunk', () => {
    const chunkDir = resolve(ROOT, 'src/client/chunks')
    const chunks = readdirSync(chunkDir).filter(name => /\.tsx?$/.test(name))
    for (const name of chunks) {
      const source = readFileSync(resolve(chunkDir, name), 'utf8')
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{6}\b/)
    }
  })
})

/**
 * Task-page migration guard (the shadcn/ui rework).
 *
 * The vendored components under `src/client/ui/**` and every migrated
 * task-page module must take their colors from a DSH token — either directly
 * (`var(--dsw-…)`) or through one of the shadcn aliases bridged in
 * `src/client/ui/theme.css` (`--background`, `--border`, …). Three ways that
 * can rot silently:
 *
 * 1. A color literal (`#hex`, `rgb()`, `oklch()`, …) — the host skin can no
 *    longer repaint it, and the value stops flipping with dark mode.
 * 2. A Tailwind default-palette class (`bg-blue-500`, `text-white`) — its
 *    value is defined by Tailwind's own theme, not by DSH.
 * 3. A `var()` in a migrated stylesheet pointing at neither a `--dsw-*` token
 *    nor a bridged alias — a typo falls back to the initial color.
 *
 * Comments are stripped first: prose legitimately quotes the old values (the
 * Badge docstring records that upstream's `text-white` became the
 * `--destructive-foreground` token), and upstream issue numbers look like
 * three-digit hex colors.
 */
const VENDORED_UI_DIR = 'src/client/ui'
const MIGRATED_TASK_FILES = [
  'src/client/SubagentView.tsx',
  'src/client/SubagentView.module.css',
  'src/client/TasksGraph.tsx',
  'src/client/TasksTree.tsx',
  'src/client/TaskWindow.tsx',
  'src/client/TeamBoard.tsx',
  'src/client/JobsDrawer.tsx',
  'src/client/TasksPopovers.tsx',
  'src/client/AnchoredPopover.tsx',
  'src/client/tasks-shared.tsx',
  'src/client/tasks-canvas.module.css',
]

/** Drop block comments and whole-line `//` comments (URLs/strings stay intact). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Any spelled-out color value (the skin contract's forbidden set). */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix|light-dark)\(/

/** Tailwind's default palette families, which are not DSH tokens. */
const PALETTE_CLASS
  = /\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|shadow|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?\b/

/** Paint declarations whose value must resolve to a token. */
const PAINT_DECLARATION
  = /(?:^|;)\s*(background(?:-color|-image)?|color|border(?:-(?:top|right|bottom|left))?-color|border|outline(?:-color)?|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color|scrollbar-color)\s*:\s*([^;}]+)/g

/** A paint declaration naming no token at all may only be inert. */
const INERT_PAINT = /^(?:none|transparent|currentcolor|inherit|initial|unset|revert)$/i

/** Every variable the theme bridge defines (or forwards) — the alias allowlist. */
const THEME_ALIASES = new Set(
  [...readFileSync(resolve(ROOT, `${VENDORED_UI_DIR}/theme.css`), 'utf8').matchAll(/--([a-z0-9-]+)\s*:/g)]
    .map(match => match[1]),
)

/** `--dsw-*` is the contract; the bridged aliases and runtime vars are the only indirection. */
function tokenAllows(name: string): boolean {
  return name.startsWith('dsw-') || name.startsWith('tw-') || name.startsWith('radix-') || THEME_ALIASES.has(name)
}

describe('skin contract: the migrated task page and the vendored ui/ own no color', () => {
  const uiFiles = readdirSync(resolve(ROOT, VENDORED_UI_DIR))
    .filter(name => /\.(?:tsx|ts|css)$/.test(name))
    .map(name => `${VENDORED_UI_DIR}/${name}`)
  const files = [...uiFiles, ...MIGRATED_TASK_FILES]

  it('covers the vendored components and the migrated task-page modules', () => {
    expect(uiFiles.length).toBeGreaterThan(10)
    for (const file of files) expect(readFileSync(resolve(ROOT, file), 'utf8').length, file).toBeGreaterThan(0)
  })

  it.each(files)('%s carries no color literal', (file) => {
    expect(stripComments(readFileSync(resolve(ROOT, file), 'utf8')), file).not.toMatch(COLOR_LITERAL)
  })

  it.each(files)('%s uses no Tailwind default-palette class', (file) => {
    expect(stripComments(readFileSync(resolve(ROOT, file), 'utf8')), file).not.toMatch(PALETTE_CLASS)
  })

  it('binds every paint declaration in the migrated stylesheets to a token', () => {
    for (const file of files.filter(name => name.endsWith('.css'))) {
      const styles = stripComments(readFileSync(resolve(ROOT, file), 'utf8'))
      for (const declaration of styles.matchAll(PAINT_DECLARATION)) {
        const [, property, value] = declaration
        const vars = [...(value ?? '').matchAll(/var\(--([a-z0-9-]+)/gi)].map(match => match[1] ?? '')
        if (vars.length === 0) {
          expect(INERT_PAINT.test((value ?? '').trim()), `${file}: ${property}: ${value}`).toBe(true)
          continue
        }
        for (const name of vars) expect(tokenAllows(name), `${file}: ${property}: var(--${name})`).toBe(true)
      }
    }
  })
})
