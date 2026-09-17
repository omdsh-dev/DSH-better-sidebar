import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREVIEW_THEME,
  previewThemeOf,
} from '../src/client/markdown-preview-theme.ts'

describe('previewThemeOf', () => {
  it('defaults to vivid', () => {
    expect(DEFAULT_PREVIEW_THEME).toBe('vivid')
    expect(previewThemeOf(undefined)).toBe('vivid')
    expect(previewThemeOf(null)).toBe('vivid')
    expect(previewThemeOf('')).toBe('vivid')
  })

  it('accepts known theme ids', () => {
    expect(previewThemeOf('vivid')).toBe('vivid')
    expect(previewThemeOf('host')).toBe('host')
  })

  it('falls back on unknown or non-string values', () => {
    expect(previewThemeOf('github')).toBe('vivid')
    expect(previewThemeOf(1)).toBe('vivid')
    expect(previewThemeOf({ theme: 'host' })).toBe('vivid')
  })
})

/**
 * Host MarkdownText zeros first-column cell padding
 * (`.tableScroll th:first-child { padding-left: 0 }`, specificity 0,2,1).
 * The file-preview override must beat that; wrapping the cell selectors in
 * `:where()` drops specificity to (0,1,0) and the host rule wins — which is
 * exactly the "首列贴边" regression.
 */
describe('editorMd table cell padding override', () => {
  const css = readFileSync('src/client/sidebar.module.css', 'utf8')

  it('restores first-column padding with specificity above the host zeroing rule', () => {
    expect(css).toMatch(/\.editorMd table th:first-child/)
    expect(css).toMatch(/\.editorMd table td:first-child/)
    expect(css).toMatch(/padding-left:\s*16px/)
    // Guard the `:where()` foot-gun that made the first fix a no-op.
    expect(css).not.toMatch(/\.editorMd :where\(th,\s*td\):first-child/)
  })
})
