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
  it('inherits the host palette with shared scoped geometry', () => {
    const design = readFileSync(resolve(ROOT, 'src/client/ui/design.module.css'), 'utf8')
    expect(design).toContain('--ds-sidebar-accent: var(--dsw-alias-state-business-primary)')
    expect(design).not.toContain('#3388BB')
    expect(design).not.toContain('--dsw-alias-brand-primary:')
    expect(design).not.toContain('--dsw-alias-button-primary-fill:')
    expect(design).toContain('--ds-sidebar-control-height: 32px')
    expect(design).toContain('--ds-sidebar-control-sm: 26px')
    expect(design).toContain('--ds-sidebar-radius: 6px')
  })

  it('pairs shared switch tracks and thumbs with the host palette', () => {
    const controls = readFileSync(resolve(ROOT, 'src/client/ui/controls.module.css'), 'utf8')
    expect(controls).toContain('.switchThumb')
    expect(controls).toContain('background: var(--dsw-alias-label-primary-foreground)')
    expect(controls).toContain('background: var(--dsw-alias-button-primary-fill)')
    expect(controls).toContain('.switch:focus-visible')
    expect(controls).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('keeps Context diagnostics feedback themed and bounded on narrow viewports', () => {
    const source = readFileSync(resolve(ROOT, 'src/client/context-diagnostics.module.css'), 'utf8')
    expect(source).toContain('var(--dsw-alias-bg-layer-3)')
    expect(source).toContain('var(--dsw-alias-state-warn-primary)')
    expect(source).toContain('calc(100vw - 24px)')
    expect(source).toContain('overflow-wrap: anywhere')
    const tokens = [...source.matchAll(/var\((--[\w-]+)/g)].map(match => match[1])
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(token).toMatch(/^--(?:dsw-alias-|dsw-font-|ds-)/)
  })

  it('clue surfaces keep every paint themed and pair primary foreground with fill', () => {
    for (const file of [
      'src/client/clues/tab/clues-tab.module.css',
      'src/client/clues/windows/pack.module.css',
      'src/client/clues/windows/share.module.css',
      'src/client/clues/windows/detail.module.css',
      'src/client/clues/settings/settings.module.css',
      'src/client/ui/workbench-section.module.css',
      'src/client/ui/patterns.module.css',
      'src/client/ui/loading-indicator.module.css',
      'src/client/windows/hosted-window.module.css',
      'src/client/windows/windows.module.css',
      'src/client/FloatingWindow.module.css',
      'src/client/clues/windows/create-pack.module.css',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
      if (file === 'src/client/clues/tab/clues-tab.module.css') {
        // Collection/results stay neutral. The visible source choice may use a
        // light business tint (user's native colorful UI request), never a stripe.
        expect(source).not.toMatch(/::(?:before|after)/)
        for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if (/\[(?:aria-(?:selected|pressed)|data-selected)=|:has\(input:checked\)|\.pack(?:Card|Row)\b/.test(rule[1]!)) {
            expect(rule[2]).not.toMatch(/box-shadow|border-(?:left|inline-start)/)
            if (!rule[1]!.includes('.sourceNavItem')) expect(rule[2]).not.toMatch(/brand-primary|state-business-primary/)
          }
        }
      }
      for (const token of source.matchAll(/var\(--([a-z0-9-]+)/gi)) {
        expect(isThemeToken(token[1]!), `${file}: ${token[0]}`).toBe(true)
      }
    }
    // Primary paint belongs to the shared recipe, not each consuming page.
    for (const file of ['src/client/ui/kit.module.css']) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      expect(source, file).toContain('var(--dsw-alias-button-primary-fill)')
      expect(source, file).toContain('var(--dsw-alias-label-primary-foreground)')
      expect(source, file).toContain('var(--dsw-alias-button-primary-hover)')
      expect(source, file).not.toMatch(/(?:^|[;{\s])color:\s*var\(--dsw-alias-bg-base\)/)
    }
  })

  it('the clue chrome separates surfaces with flat fills, never decorative shadows', () => {
    const source = readFileSync(resolve(ROOT, 'src/client/clues/tab/clues-tab.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const header = /\.header\s*\{([^}]+)\}/.exec(source)?.[1]
    expect(header).toContain('background: transparent')
    const packRegion = /\.packRegion\s*\{([^}]+)\}/.exec(source)?.[1]
    expect(packRegion).toContain('background: var(--dsw-alias-bg-layer-1)')
    expect(source).not.toMatch(/box-shadow/)
    expect(source).toMatch(/\.querySubmit\s*\{[^}]*background:\s*transparent/)
    const patterns = readFileSync(resolve(ROOT, 'src/client/ui/patterns.module.css'), 'utf8')
    expect(patterns).toMatch(/\.listRowActions > button\s*\{[^}]*color:\s*var\(--dsw-alias-label-tertiary\)/)
  })

  it('source identity remains themed while actions use the single shared recipe', () => {
    const source = readFileSync(resolve(ROOT, 'src/client/clues/tab/clues-tab.module.css'), 'utf8')
    const switcher = readFileSync(resolve(ROOT, 'src/client/ui/source-switcher.module.css'), 'utf8')
    const controls = readFileSync(resolve(ROOT, 'src/client/ui/controls.module.css'), 'utf8')
    const glyphs = readFileSync(resolve(ROOT, 'src/client/clues/sources/source-icons.module.css'), 'utf8')
    const kit = readFileSync(resolve(ROOT, 'src/client/ui/kit.module.css'), 'utf8')
    expect(switcher).toContain('.tabIcon')
    expect(switcher).toContain('.tabText')
    expect(controls).toContain('.tabsSegmented')
    expect(glyphs).toContain('state-business-primary')
    expect(glyphs).toContain('state-success-primary')
    expect(glyphs).toContain('state-warn-primary')
    expect(kit).toContain('background: var(--dsw-alias-button-primary-fill)')
    expect(kit).toContain('color: var(--dsw-alias-label-primary-foreground)')
    expect(kit).toContain('background: var(--dsw-alias-button-primary-hover)')
    expect(source).not.toContain('collectAction')
  })

  it('settings navigation is a 144px left rail at wide sizes and a group select below 640', () => {
    const settings = readFileSync(resolve(ROOT, 'src/client/SideCardSection.module.css'), 'utf8')
    expect(settings).toContain('.navRail')
    expect(settings).toMatch(/width:\s*144px/)
    expect(settings).toContain('border-inline-end: 1px solid var(--dsw-alias-border-l1)')
    expect(settings).toMatch(/@container sidebar-settings \(max-width:\s*639px\)/)
    expect(settings).toContain('.navSelect')
    expect(settings).toContain('.groupIcon')
    expect(settings).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(settings).not.toMatch(/\brgba?\(/)
    for (const match of settings.matchAll(/var\((--[\w-]+)/g)) expect(match[1]).toMatch(/^--(?:dsw-|ds-)/)
  })

  it('the icon modules carry no color literals', () => {
    for (const file of [
      'src/client/file-icons.tsx',
      'src/client/icons.tsx',
      'src/client/clues/artwork.tsx',
      'src/client/clues/sources/github/icons.tsx',
      'src/client/clues/sources/feishu/icons.tsx',
    ]) {
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

  it('tag ref pills take the neutral label token instead of a lane-palette slot', () => {
    // The graph's ref pills are painted by lane slot (`data-color` → the five
    // `--dsw-alias-state-*` colours); a tag is a decoration, not a lane, so its
    // rule must resolve to a NEUTRAL label token and keep the text marker
    // legible with a dashed outline.
    const styles = readFileSync(resolve(ROOT, 'src/client/changes/graph.module.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const block = /\.ref\[data-tone="tag"\] \{([^}]*)\}/.exec(styles)?.[1]
    if (block === undefined) throw new Error('the tag ref pill rule must exist in graph.module.css')
    expect(block).toContain('color: var(--dsw-alias-label-secondary)')
    expect(styles).toContain('border: 1px solid currentColor')
  })

  it('the graph viewport fills its container without a viewport-relative height cap', () => {
    const sheet = document.createElement('style')
    sheet.textContent = readFileSync(resolve(ROOT, 'src/client/changes/changes.module.css'), 'utf8')
    document.head.append(sheet)
    try {
      const rules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
      const graph = rules.find(rule => rule.selectorText === '.graphArea')!.style
      expect(graph.getPropertyValue('flex-grow')).toBe('1')
      expect(graph.getPropertyValue('height')).toBe('')
      expect(graph.getPropertyValue('max-height')).toBe('')
      expect(Number.parseFloat(graph.getPropertyValue('min-height'))).toBe(0)
      const section = rules.find(rule => rule.selectorText === '.graphSection')!.style
      expect(section.getPropertyValue('min-height')).toBe('calc(var(--ds-workbench-bar, 28px) + 221px)')
      expect(section.getPropertyValue('max-height')).toBe('')
      const touch = Array.from(sheet.sheet!.cssRules).find((rule): rule is CSSMediaRule =>
        'conditionText' in rule && rule.conditionText === '(hover: none), (pointer: coarse)')!
      const touchSection = Array.from(touch.cssRules).find((rule): rule is CSSStyleRule =>
        'selectorText' in rule && rule.selectorText === '.graphSection')!.style
      expect(touchSection.getPropertyValue('min-height')).toBe('calc(var(--ds-workbench-bar, 28px) + 233px)')
    } finally {
      sheet.remove()
    }
  })

  it('selected change rows keep their layout and separate their accent from indent guides', () => {
    const sheet = document.createElement('style')
    sheet.textContent = readFileSync(resolve(ROOT, 'src/client/changes/changes.module.css'), 'utf8')
    document.head.append(sheet)
    try {
      const rules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
      for (const name of ['row', 'opRow']) {
        const selector = `.${name}[data-selected='true']`
        const selected = rules.filter(rule => rule.selectorText.split(',').some(part => part.trim() === selector))
        expect(selected).toHaveLength(1)
        const style = selected[0]!.style
        expect(style.getPropertyValue('position')).toBe('')
        expect(style.getPropertyValue('width')).toBe('')
        expect(style.getPropertyValue('border-left')).toBe('')
        expect(style.getPropertyValue('background')).toBe('var(--dsw-alias-interactive-bg-active)')
        const marker = rules.find(rule => rule.selectorText.split(',').some(part => part.trim() === `${selector}::before`))!
        // Selected fill carries state without another decorative accent stripe.
        expect(marker).toBeUndefined()
      }
      const guide = rules.find(rule => rule.selectorText === '.guide')!
      expect(guide.style.getPropertyValue('position')).toBe('absolute')
      expect(guide.style.getPropertyValue('border-left')).toBe('1px solid var(--dsw-alias-border-l1)')
    } finally {
      sheet.remove()
    }
  })

  it('shows running activity without decorative sweep animations', () => {
    const styles = readFileSync(resolve(ROOT, 'src/client/tasks-graph.module.css'), 'utf8')
    expect(styles).toContain('.barState')
    expect(styles).toContain('.barActivity')
    expect(styles).not.toContain('dsh-tasks-bar-sweep')
    expect(styles).not.toContain('linear-gradient')
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

  it('paints empty pane choices with the host capsule recipe', () => {
    const styles = readFileSync(resolve(ROOT, 'src/client/sidebar.module.css'), 'utf8')
    const start = styles.indexOf('.paneCard {')
    const block = styles.slice(start, styles.indexOf('}', start))
    // The pane choices mirror the host's own guide capsules: a 56px row with
    // the session-entry radius, left-aligned content, and token-only paint.
    expect(block).toContain('min-height: 56px')
    expect(block).toContain('justify-content: flex-start')
    expect(block).toContain('border: 0.5px solid var(--dsw-alias-border-l4)')
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/)
  })

  it('the floating selection action paints from the host floating-button pair', () => {
    // The chip floats over live text; the menu fill it used before is
    // translucent by design and washed out over the code viewer. Scan the
    // parsed CSSOM, not raw text, so a later duplicate rule cannot win the
    // cascade behind this test's back.
    const sheet = document.createElement('style')
    sheet.textContent = readFileSync(resolve(ROOT, 'src/client/sidebar.module.css'), 'utf8')
    document.head.append(sheet)
    try {
      const rules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
      const base = rules.filter(rule => rule.selectorText.trim() === '.selectionPopup')
      expect(base).toHaveLength(1)
      expect(base[0]!.style.getPropertyValue('background')).toBe('var(--dsw-alias-button-floating-fill)')

      // Either selector alone would let a later plain :hover rule override
      // the pair, so accept both spellings only when they share one rule.
      const hover = rules.filter(rule => {
        const selectors = rule.selectorText.split(',').map(selector => selector.trim())
        return selectors.includes('.selectionPopup:hover') || selectors.includes('.selectionPopup:focus-visible')
      })
      expect(hover).toHaveLength(1)
      expect(hover[0]!.selectorText.split(',').map(selector => selector.trim()).sort()).toEqual([
        '.selectionPopup:focus-visible',
        '.selectionPopup:hover',
      ])
      expect(hover[0]!.style.getPropertyValue('background')).toBe('var(--dsw-alias-button-floating-hover)')
    } finally {
      sheet.remove()
    }
  })

  it('sidechat image previews fit the transcript and keep the host border token', () => {
    const sheet = document.createElement('style')
    sheet.textContent = readFileSync(resolve(ROOT, 'src/client/SideChatView.module.css'), 'utf8')
    document.head.append(sheet)
    try {
      const rules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
      const image = rules.find(rule => rule.selectorText === '.sidechatImage')!.style
      expect(image.getPropertyValue('object-fit')).toBe('contain')
      expect(image.getPropertyValue('max-width')).not.toBe('')
      expect(image.getPropertyValue('max-height')).not.toBe('')
      const preview = rules.find(rule => rule.selectorText === '.sidechatImagePreview')!.style
      expect(preview.getPropertyValue('border')).toMatch(/var\(--dsw-alias-/)
    } finally {
      sheet.remove()
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
