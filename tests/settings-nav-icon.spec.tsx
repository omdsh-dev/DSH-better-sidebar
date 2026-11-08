/**
 * The settings-nav glyph the plugin contributes through
 * `settings.section.icon`.
 *
 * The shell owns the nav button and label and asks the registrant for a square
 * glyph: it passes the requested edge as `size` and tints the SVG with
 * `currentColor`, so the component must scale with that prop and must not carry
 * its own color. This replaced a marker + CSS-mask hack that assumed the
 * fallback gear was a direct `svg` child of the button; once the shell wrapped
 * it in a span the stale rule stopped hiding it and the row painted two glyphs.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderRoot } from './test-utils.ts'
import { IconSideCardNav } from '../src/client/icons.tsx'

describe('settings navigation icon', () => {
  it.each([16, 24])('honours the requested square edge (%i px)', (size) => {
    const { container, unmount } = renderRoot(createElement(IconSideCardNav, { size }))
    try {
      const svg = container.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg!.getAttribute('width')).toBe(String(size))
      expect(svg!.getAttribute('height')).toBe(String(size))
      expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24')
    } finally {
      unmount()
    }
  })

  it('paints with currentColor only (the shell owns the tint)', () => {
    const { container, unmount } = renderRoot(createElement(IconSideCardNav, { size: 16 }))
    try {
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('fill')).toBe('none')
      for (const element of svg.querySelectorAll('path, rect, circle, line, polygon')) {
        const stroke = element.getAttribute('stroke')
        if (stroke !== null) expect(stroke).toBe('currentColor')
        expect(element.getAttribute('fill')).toBeNull()
        expect(element.getAttribute('style')).toBeNull()
      }
    } finally {
      unmount()
    }
  })
})
