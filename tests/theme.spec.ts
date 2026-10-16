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
import { resolve, sep } from 'node:path'
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
 * simply that no plugin module carries a color literal, that every module
 * stylesheet paints `color` from a token, and that no icon dataset sneaked
 * back in as a chunk.
 */
// jsdom has no file:// import.meta.url; vitest runs from the repo root.
const ROOT = process.cwd()

/** `color` as a property — never `background-color` / `scrollbar-color` / `-webkit-text-fill-color`. */
const COLOR_PROPERTY = /(?:^|[;{\s])color\s*:\s*([^;}]+)/g

/** Values that name no paint of their own and are therefore exempt. */
const INERT_COLOR = /^(?:inherit|currentcolor|transparent)$/i

/** A token allowed by the contract: the plugin's own `--dsw-*` or the host's `--ds-*`. */
function isThemeToken(name: string): boolean {
  return name.startsWith('dsw-') || name.startsWith('ds-')
}

/** Every `*.module.css` sheet under `src/client/`, as repo-relative POSIX paths. */
function moduleStylesheets(): string[] {
  return readdirSync(resolve(ROOT, 'src/client'), { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.module.css'))
    .map(name => `src/client/${name.split(sep).join('/')}`)
}

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

  it('every module stylesheet paints `color` from a theme token', () => {
    const sheets = moduleStylesheets()
    // Guard the scan itself: a glob that silently matches nothing would make
    // this contract vacuous.
    expect(sheets.length).toBeGreaterThan(5)
    for (const file of sheets) {
      const styles = readFileSync(resolve(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const declaration of styles.matchAll(COLOR_PROPERTY)) {
        const value = declaration[1]!.trim()
        // `color: inherit` / `currentcolor` / `transparent` is the plugin
        // deliberately taking the surrounding color, not painting one.
        if (INERT_COLOR.test(value)) continue
        // Dereference every var() — `color-mix()` chains are fine as long as
        // the whole expression bottoms out in theme tokens.
        const tokens = [...value.matchAll(/var\(--([a-z0-9-]+)/gi)].map(match => match[1]!)
        expect(tokens.length, `${file}: color: ${value}`).toBeGreaterThan(0)
        for (const name of tokens) expect(isThemeToken(name), `${file}: color: ${value}`).toBe(true)
      }
    }
  })

  it('the running bar sweeps the FULL width (a band either side, not a partial blob)', () => {
    // Reader report: the first cut moved a 45%-wide band with
    // `background-position`, so the bar was only ever partially lit. The
    // corrected rule is a bar-wide band whose TRANSFORM travels one full width
    // either side of the bar — entered at the left edge, covering the bar
    // mid-flight, gone past the right edge.
    const styles = readFileSync(resolve(ROOT, 'src/client/tasks-graph.module.css'), 'utf8')
    const block = /\.cardBar\[data-running='true'\]::after \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (block === undefined) throw new Error('the running bar sweep rule must exist')
    expect(block).toContain('width: 100%')
    expect(block).toContain('transform: translateX(-100%)')
    // No residual background-position travel (the partial-sweep mechanism).
    expect(block).not.toContain('background-position')
    expect(block).not.toContain('background-size')
    const frames = /@keyframes dsh-tasks-bar-sweep \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (frames === undefined) throw new Error('the sweep keyframes must exist')
    expect(frames).toContain('transform: translateX(-100%)')
    expect(frames).toContain('transform: translateX(100%)')
  })

  it('the running bar keeps its state word and activity on ONE font stack', () => {
    // Reader report: 运行中 and 正在分析请求 sat at different heights. The
    // cause is metric, not layout — at 11px the sans stack is ascent/descent
    // 11/2 against the mono stack's 10/3, so a mono activity line rests 1px
    // lower. Both texts must therefore inherit the bar's own font.
    const styles = readFileSync(resolve(ROOT, 'src/client/tasks-graph.module.css'), 'utf8')
    const block = /\.barActivity \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (block === undefined) throw new Error('the .barActivity rule must exist')
    expect(block).not.toContain('font-family')
    expect(block).not.toContain('--ds-font-family-code')
  })

  it('the mermaid zoom toolbar yields the shell title-bar strip (issue #805)', () => {
    // A viewport-sized overlay pinned at a bare `top: 16px` loses its click
    // area to the native caption strip the shell draws OVER the page (Electron
    // `titleBarOverlay`; 36–44px across the shells reported so far), while
    // `elementFromPoint` still answers the button — so the control reads as
    // dead. The toolbar must consume the strip variable the shell publishes
    // (`titlebar-strip.ts`), and the 0px fallback must keep plain browsers at
    // the original 16px inset.
    const styles = readFileSync(resolve(ROOT, 'src/client/sidebar.module.css'), 'utf8')
    const block = /\.mermaidModalToolbar \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (block === undefined) throw new Error('the .mermaidModalToolbar rule must exist')
    expect(block).toContain('top: calc(var(--dsh-title-bar-strip, 0px) + 16px)')
    // The bare inset must not come back as the whole declaration.
    expect(block).not.toMatch(/\n\s*top: 16px;/)
  })

  it('the empty-pane welcome capsule follows the host guide recipe', () => {
    // The card is the same surface as DSH's own guide capsule ("pick what
    // opens here"), so this pins the shared geometry and the token-only
    // paint. A literal here would drift away from the host under every skin.
    const styles = readFileSync(resolve(ROOT, 'src/client/sidebar.module.css'), 'utf8')
    const block = /\.paneCard \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (block === undefined) throw new Error('the .paneCard rule must exist in src/client/sidebar.module.css')
    expect(block).toContain('border: 0.5px solid var(--dsw-alias-border-l4)')
    expect(block).toContain('border-radius: 24px')
    expect(block).toContain('background: var(--dsw-alias-bg-layer-1)')
    expect(block).toContain('min-height: 56px')
    expect(block).toContain('padding: 14px 20px')
    // No paint of its own: every color-ish declaration resolves to a token,
    // and the upstream-only spellings this repo must not copy are absent.
    for (const declaration of block.matchAll(/(?:^|\n)\s*(?:background|border|color|font):\s*([^;]*);/g)) {
      const value = declaration[1] ?? ''
      // A literal here (hex, rgba, a named colour) would drift from the host
      // under every skin, so any keyword whose value is not a token fails.
      expect(
        value === '' || value.includes('var(--dsw-'),
        `${declaration[0].trim()} must paint through a --dsw-* token (got: ${value})`,
      ).toBe(true)
    }
    expect(block).not.toContain('--dsw-alias-bg-l1')
    expect(block).not.toContain('--dsw-alias-bg-l2')
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
