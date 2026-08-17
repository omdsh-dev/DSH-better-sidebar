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
