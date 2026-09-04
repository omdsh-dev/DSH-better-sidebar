/**
 * Terminal font resolution tests: the custom font prefs (side card settings,
 * terminal card) resolve into xterm options with a strict fallback chain —
 * user family > theme code font > the built-in monospace stack, and the size
 * clamped into the 9–32 contract.
 *
 * On top of the base family, icon fonts (Nerd Font + color emoji) are
 * appended so shell prompts drawing from the Private Use Areas render real
 * glyphs instead of the missing-glyph box, and the stack is terminated with
 * a generic family so an unresolvable name degrades to a monospace instead
 * of the proportional standard font.
 */
import { describe, expect, it } from 'vitest'
import { SIDEBAR_PREFS_DEFAULTS, clampTerminalFontSize, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../src/prefs-shared.ts'
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  ICON_FONT_FALLBACKS,
  resolveTerminalFont,
  withIconFontFallbacks,
  withMonospaceFallback,
} from '../src/client/terminal-font.ts'

describe('clampTerminalFontSize', () => {
  it('rounds and clamps into the 9–32 contract', () => {
    expect(clampTerminalFontSize(13)).toBe(13)
    expect(clampTerminalFontSize(15.6)).toBe(16)
    expect(clampTerminalFontSize(5)).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(clampTerminalFontSize(40)).toBe(TERMINAL_FONT_SIZE_MAX)
  })
})

describe('withIconFontFallbacks', () => {
  /** Index of a family in a resolved stack, -1 when absent. */
  function indexOfFamily(stack: string, family: string): number {
    return stack.split(',').map(part => part.trim()).indexOf(family)
  }

  it('keeps the base font first so xterm measures cells against it', () => {
    const stack = withIconFontFallbacks('"JetBrains Mono", monospace')
    expect(stack.startsWith('"JetBrains Mono"')).toBe(true)
  })

  it('splices icon fonts ahead of a trailing generic family (a generic always resolves)', () => {
    const stack = withIconFontFallbacks('"JetBrains Mono", monospace')
    const parts = stack.split(',').map(part => part.trim())
    expect(parts[parts.length - 1]).toBe('monospace')
    expect(parts.indexOf('"Symbols Nerd Font Mono"')).toBeGreaterThan(0)
    expect(parts.indexOf('"Symbols Nerd Font Mono"')).toBeLessThan(parts.length - 1)
  })

  it('splices ahead of a generic sitting MID-stack, not just a trailing one', () => {
    // Regression guard: a generic anywhere is a catch-all, so appending
    // after it silently defeats the whole fix (the icon fonts would never
    // be consulted). Stacks of this shape come from theme tokens.
    const stack = withIconFontFallbacks('ui-monospace, Menlo, monospace, "Apple Color Emoji"')
    expect(indexOfFamily(stack, '"Symbols Nerd Font Mono"'))
      .toBeLessThan(indexOfFamily(stack, 'ui-monospace'))
  })

  it('keeps fully-patched fonts BEHIND a leading generic (they carry Latin and would become the base)', () => {
    // A leading generic resolves, so prepending a fully-patched Nerd Font
    // (which ships Latin glyphs) would make it xterm's measuring/base font
    // and override the user/theme family precedence. Only the symbols-only
    // patches (no Latin) may precede it.
    const stack = withIconFontFallbacks('monospace')
    expect(indexOfFamily(stack, '"Symbols Nerd Font Mono"')).toBeLessThan(indexOfFamily(stack, 'monospace'))
    expect(indexOfFamily(stack, '"Hack Nerd Font Mono"')).toBeGreaterThan(indexOfFamily(stack, 'monospace'))
    expect(indexOfFamily(stack, '"JetBrainsMono Nerd Font Mono"')).toBeGreaterThan(indexOfFamily(stack, 'monospace'))
  })

  it('splices ahead of the FIRST generic when several are present', () => {
    const stack = withIconFontFallbacks('Menlo, monospace, sans-serif')
    const nerd = indexOfFamily(stack, '"Symbols Nerd Font Mono"')
    expect(nerd).toBeGreaterThan(indexOfFamily(stack, 'Menlo'))
    expect(nerd).toBeLessThan(indexOfFamily(stack, 'monospace'))
    expect(indexOfFamily(stack, 'sans-serif')).toBe(stack.split(',').length - 1)
  })

  it('appends at the end when the stack has no generic family', () => {
    const stack = withIconFontFallbacks('"JetBrains Mono"')
    expect(stack.startsWith('"JetBrains Mono", "Symbols Nerd Font Mono"')).toBe(true)
  })

  it('orders symbols-only patches ahead of fully-patched distributions', () => {
    // Order IS the priority contract: the symbols-only families carry no
    // Latin glyphs, so they can never hijack ASCII cell metrics.
    const stack = withIconFontFallbacks('Menlo, monospace')
    expect(indexOfFamily(stack, '"Symbols Nerd Font Mono"'))
      .toBeLessThan(indexOfFamily(stack, '"Hack Nerd Font Mono"'))
  })

  it('names Nerd Font families explicitly to cover both PUA planes', () => {
    const stack = withIconFontFallbacks('Menlo, monospace')
    expect(stack).toContain('"Symbols Nerd Font Mono"')
    expect(stack).toContain('"Hack Nerd Font Mono"')
  })

  it('omits color-emoji families (Chromium routes emoji through its own fallback)', () => {
    // Listing a color font ahead of the generic would let it capture BMP
    // symbols the prompt expects in monospace and break the cell grid.
    const stack = withIconFontFallbacks('Menlo, monospace')
    expect(stack).not.toContain('Apple Color Emoji')
    expect(stack).not.toContain('Segoe UI Emoji')
    expect(stack).not.toContain('Noto Color Emoji')
  })

  it('does not duplicate a family the caller already listed, preserving its priority', () => {
    const stack = withIconFontFallbacks("'hack nerd font mono', monospace")
    expect(stack.toLowerCase().split('hack nerd font mono').length - 1).toBe(1)
    // The caller's entry keeps pole position.
    expect(stack.startsWith("'hack nerd font mono'")).toBe(true)
  })

  it('treats quote, case and whitespace differences as the same family', () => {
    const stack = withIconFontFallbacks('"Symbols  Nerd  Font  Mono", monospace')
    expect(stack.toLowerCase().split('symbols').length - 1).toBe(2) // Mono + proportional
  })

  it('is idempotent so TerminalView\'s option diff does not thrash', () => {
    const once = withIconFontFallbacks('Menlo, monospace')
    expect(withIconFontFallbacks(once)).toBe(once)
  })

  it('splits on top-level commas only, keeping quoted and function values whole', () => {
    expect(withIconFontFallbacks('"Foo,Bar", monospace')).toContain('"Foo,Bar"')
    expect(withIconFontFallbacks('var(--code, monospace)')).toContain('var(--code, monospace)')
  })

  it('falls back to the icon list alone for an empty stack (defensive)', () => {
    expect(withIconFontFallbacks('')).toBe(ICON_FONT_FALLBACKS.join(', '))
    expect(withIconFontFallbacks('  ,  ')).toBe(ICON_FONT_FALLBACKS.join(', '))
  })
})

describe('resolveTerminalFont', () => {
  it('falls back to the theme code font when the family pref is empty', () => {
    const { fontFamily, fontSize } = resolveTerminalFont(SIDEBAR_PREFS_DEFAULTS, 'var-theme-font')
    // The theme font stays the base (first) entry; the monospace tail keeps
    // the grid alive, and icon fonts top it up.
    expect(fontFamily).toBe(withIconFontFallbacks(withMonospaceFallback('var-theme-font')))
    expect(fontFamily.startsWith('var-theme-font')).toBe(true)
    expect(fontFamily.endsWith('monospace')).toBe(true)
    expect(fontSize).toBe(13)
  })

  it('terminates a custom family that names no generic, keeping the grid monospaced', () => {
    // The reported failure: a family installed only on the machine running the
    // shell resolves to nothing in the browser, and without a generic tail the
    // fallback is the proportional standard font (PingFang SC on macOS), whose
    // advance xterm then measures the cell from.
    const { fontFamily } = resolveTerminalFont(
      { ...SIDEBAR_PREFS_DEFAULTS, terminalFontFamily: 'Maple Mono NF CN' },
      undefined,
    )
    expect(fontFamily.startsWith('Maple Mono NF CN')).toBe(true)
    expect(fontFamily.endsWith('monospace')).toBe(true)
  })

  it('falls back to the built-in monospace stack when neither the pref nor the theme provides one', () => {
    expect(resolveTerminalFont(SIDEBAR_PREFS_DEFAULTS, undefined).fontFamily)
      .toBe(withIconFontFallbacks(DEFAULT_TERMINAL_FONT_FAMILY))
    // A whitespace-only pref counts as empty (theme default).
    expect(resolveTerminalFont({ ...SIDEBAR_PREFS_DEFAULTS, terminalFontFamily: '   ' }, undefined).fontFamily)
      .toBe(withIconFontFallbacks(DEFAULT_TERMINAL_FONT_FAMILY))
  })

  it('skips a CSS-wide keyword instead of building an invalid declaration', () => {
    // Skins do set tokens to these; appending to one yields an invalid
    // font-family that the CSSOM discards, losing every font at once.
    for (const keyword of ['inherit', 'initial', 'unset', 'revert', 'REVERT-LAYER']) {
      const { fontFamily } = resolveTerminalFont(SIDEBAR_PREFS_DEFAULTS, keyword)
      expect(fontFamily).toBe(withIconFontFallbacks(DEFAULT_TERMINAL_FONT_FAMILY))
      expect(fontFamily.toLowerCase()).not.toContain(keyword.toLowerCase())
    }
    // Same guard on the user pref, which then defers to the theme font.
    expect(resolveTerminalFont({ ...SIDEBAR_PREFS_DEFAULTS, terminalFontFamily: 'inherit' }, 'var-theme-font').fontFamily)
      .toBe(withIconFontFallbacks(withMonospaceFallback('var-theme-font')))
  })

  it('prefers the custom family as the base and clamps the size', () => {
    const { fontFamily, fontSize } = resolveTerminalFont(
      { ...SIDEBAR_PREFS_DEFAULTS, terminalFontFamily: '"JetBrains Mono", monospace', terminalFontSize: 40 },
      'var-theme-font',
    )
    expect(fontFamily).toBe(withIconFontFallbacks('"JetBrains Mono", monospace'))
    expect(fontFamily.startsWith('"JetBrains Mono"')).toBe(true)
    expect(fontFamily).not.toContain('var-theme-font')
    expect(fontSize).toBe(TERMINAL_FONT_SIZE_MAX)
  })

  it('applies icon fallbacks no matter which base family wins', () => {
    for (const resolved of [
      resolveTerminalFont(SIDEBAR_PREFS_DEFAULTS, 'var-theme-font'),
      resolveTerminalFont(SIDEBAR_PREFS_DEFAULTS, undefined),
      resolveTerminalFont({ ...SIDEBAR_PREFS_DEFAULTS, terminalFontFamily: 'Menlo' }, undefined),
    ]) {
      expect(resolved.fontFamily).toContain('"Symbols Nerd Font Mono"')
      expect(resolved.fontFamily.endsWith('monospace')).toBe(true)
    }
  })
})
describe('withMonospaceFallback', () => {
  it('appends a monospace tail when the stack names no generic family', () => {
    expect(withMonospaceFallback('"Maple Mono NF CN"')).toBe('"Maple Mono NF CN", monospace')
    expect(withMonospaceFallback('Menlo, Consolas')).toBe('Menlo, Consolas, monospace')
  })

  it('leaves a stack that already names a generic family untouched', () => {
    expect(withMonospaceFallback('"JetBrains Mono", monospace')).toBe('"JetBrains Mono", monospace')
    expect(withMonospaceFallback('ui-monospace, "SF Mono"')).toBe('ui-monospace, "SF Mono"')
    // A deliberate non-monospace generic is the user's call, not ours to override.
    expect(withMonospaceFallback('"Foo", sans-serif')).toBe('"Foo", sans-serif')
  })

  it('matches generic families case-insensitively and only when unquoted', () => {
    expect(withMonospaceFallback('"Foo", MONOSPACE')).toBe('"Foo", MONOSPACE')
    // A quoted name merely containing the word is a family, not a generic.
    expect(withMonospaceFallback('"My monospace Font"')).toBe('"My monospace Font", monospace')
  })

  it('splits on top-level commas only, keeping quoted names and var() intact', () => {
    expect(withMonospaceFallback('"Foo, Bar"')).toBe('"Foo, Bar", monospace')
    expect(withMonospaceFallback('var(--code, Menlo)')).toBe('var(--code, Menlo), monospace')
    expect(withMonospaceFallback("'Esc\\'aped, Name'")).toBe("'Esc\\'aped, Name', monospace")
  })

  it('drops the empty entries a stray comma produces', () => {
    expect(withMonospaceFallback('"Foo",')).toBe('"Foo", monospace')
    expect(withMonospaceFallback('  "Foo" ,, Menlo  ')).toBe('"Foo", Menlo, monospace')
  })

  it('is idempotent', () => {
    const once = withMonospaceFallback('"Maple Mono NF CN"')
    expect(withMonospaceFallback(once)).toBe(once)
    expect(withMonospaceFallback(DEFAULT_TERMINAL_FONT_FAMILY)).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
  })

  it('falls back to the built-in stack for an empty value or a CSS-wide keyword', () => {
    // Appending to a CSS-wide keyword yields invalid CSS the CSSOM drops
    // wholesale, which would leave xterm with no font at all.
    expect(withMonospaceFallback('')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
    expect(withMonospaceFallback('   ,  ')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
    expect(withMonospaceFallback('inherit')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
    expect(withMonospaceFallback('REVERT-LAYER')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
    // Only a lone keyword is one; as part of a stack it is just a family name.
    expect(withMonospaceFallback('inherit, Menlo')).toBe('inherit, Menlo, monospace')
  })
})
