/**
 * The highlight engine's v0.2.1-ported expansion: JS/TS module suffixes,
 * CSS/SCSS/Less (block comments + hyphenated properties), markup files
 * (comments + tags), and GraphQL mapping — the same coverage the standalone
 * dsh-file-trace plugin ships.
 */
import { describe, expect, it } from 'vitest'
import { langOfPath, tokenizeLine, scanLine, hasBlockComment } from '../src/client/diff/highlight.ts'

describe('langOfPath: expanded suffixes', () => {
  it('maps the JS/TS module suffixes to their families', () => {
    expect(langOfPath('tool/config.mjs')).toBe('mjs')
    expect(langOfPath('tool/config.cjs')).toBe('cjs')
    expect(langOfPath('src/env.mts')).toBe('mts')
    expect(langOfPath('src/env.cts')).toBe('cts')
  })

  it('maps markup, style and graphql suffixes', () => {
    expect(langOfPath('site/index.html')).toBe('html')
    expect(langOfPath('site/logo.svg')).toBe('svg')
    expect(langOfPath('app/App.vue')).toBe('vue')
    expect(langOfPath('data/feed.xml')).toBe('xml')
    expect(langOfPath('style/main.css')).toBe('css')
    expect(langOfPath('style/theme.scss')).toBe('scss')
    expect(langOfPath('style/vars.less')).toBe('less')
    expect(langOfPath('api/schema.graphql')).toBe('graphql')
    expect(langOfPath('api/query.gql')).toBe('gql')
    expect(langOfPath('cfg/settings.jsonc')).toBe('jsonc')
  })
})

describe('tokenizeLine: CSS / markup', () => {
  it('colors CSS block comments, hyphenated properties, strings and hex numbers', () => {
    const toks = tokenizeLine('body { color: #333; background-color: var(--fg); content: "x" }', 'css')
    expect(toks).toContainEqual(expect.objectContaining({ text: 'body', type: 'keyword' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: 'color', type: 'keyword' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: 'background-color', type: 'keyword' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: '"x"', type: 'string' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: '333', type: 'number' }))
    const cmt = tokenizeLine('/* one line comment */ body', 'css')
    expect(cmt[0]).toMatchObject({ text: '/* one line comment */', type: 'comment' })
  })

  it('threads CSS block comments across lines', () => {
    expect(hasBlockComment('css')).toBe(true)
    const open = scanLine('/* starts here', 'css')
    expect(open.inBlock).toBe(true)
    expect(open.tokens[0]).toMatchObject({ type: 'comment' })
    const close = scanLine('ends here */ p {}', 'css', true)
    expect(close.tokens[0]).toMatchObject({ type: 'comment' })
    expect(close.tokens).toContainEqual(expect.objectContaining({ text: 'p', type: 'keyword' }))
  })

  it('colors markup comments, tags and attributes', () => {
    const toks = tokenizeLine('<div class="box">hi</div>', 'html')
    expect(toks).toContainEqual(expect.objectContaining({ text: 'div', type: 'keyword' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: 'class', type: 'keyword' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: '"box"', type: 'string' }))
    const cmt = tokenizeLine('<!-- header -->', 'html')
    expect(cmt[0]).toMatchObject({ text: '<!-- header -->', type: 'comment' })
    expect(hasBlockComment('html')).toBe(true)
  })

  it('colors mjs like js (await keyword wins over the call-site rule)', () => {
    const toks = tokenizeLine('const x = await import("./mod.js")', 'mjs')
    expect(toks).toContainEqual(expect.objectContaining({ text: 'const', type: 'keyword' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: 'await', type: 'keyword' }))
    expect(toks).toContainEqual(expect.objectContaining({ text: 'import', type: 'keyword' }))
  })
})
