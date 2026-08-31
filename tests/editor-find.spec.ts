/**
 * Cmd/Ctrl+F must work in EDIT mode too. The preview has its own find bar
 * (md-find.tsx); the source side rides CodeMirror's search panel, which only
 * exists if the extension AND its keymap are both wired — the extension alone
 * gives no key binding, and the keymap alone has no panel to open.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/client/TextEditor.tsx', 'utf8')
const themes = readFileSync('src/client/cm-themes.ts', 'utf8')

describe('editor find', () => {
  it('installs the search extension', () => {
    expect(source).toContain("from '@codemirror/search'")
    expect(source).toMatch(/search\(\{\s*top:\s*true\s*\}\)/)
  })

  it('binds the search keymap ahead of the default one', () => {
    // searchKeymap owns Escape (close the panel); defaultKeymap binds Escape
    // too, so the search bindings have to come first or the panel could not
    // be dismissed from inside the editor.
    const searchAt = source.indexOf('...searchKeymap')
    const defaultAt = source.indexOf('...defaultKeymap')
    expect(searchAt).toBeGreaterThan(-1)
    expect(defaultAt).toBeGreaterThan(-1)
    expect(searchAt).toBeLessThan(defaultAt)
  })

  it('keeps the save binding ahead of both', () => {
    expect(source.indexOf("key: 'Mod-s'")).toBeLessThan(source.indexOf('...searchKeymap'))
  })

  it('re-themes the stock search panel', () => {
    // CodeMirror's default panel chrome is a grey browser default that reads
    // as broken against the DSH surfaces.
    expect(themes).toContain('.cm-panel.cm-search')
    expect(themes).toContain('.cm-searchMatch')
    expect(themes).toContain('.cm-searchMatch.cm-searchMatch-selected')
  })
})
