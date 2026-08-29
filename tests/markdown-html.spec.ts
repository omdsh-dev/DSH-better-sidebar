/**
 * markdown-html splitter spec: the pure lifting of raw-HTML runs out of the
 * markdown stream (fence-aware), the tag-balance part analysis (unclosed
 * `<details>` → wrapper opens, stray closes → pops), the doc-wide reference
 * definition collection, and the inline-html gate.
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeHtmlSegment,
  analyzeMarkdownHtml,
  collectReferenceDefinitions,
  splitHtmlBlocks,
  type HtmlPart,
} from '../src/client/markdown-html.ts'

/** Structural view of parts: html parts as [html <text>], opens/closes by kind. */
function shape(parts: readonly HtmlPart[]): string[] {
  return parts.map((part) => part.kind === 'html'
    ? `html(${part.html})`
    : part.kind === 'open'
      ? `open(${part.tag}${part.attrs.trim() !== '' ? ` ${part.attrs.trim()}` : ''})`
      : `close(${part.tag})`)
}

describe('splitHtmlBlocks', () => {
  it('returns one markdown segment for plain markdown (no HTML)', () => {
    const text = '# Title\n\nsome **markdown**\n\n- a\n- b\n'
    expect(splitHtmlBlocks(text)).toEqual([{ kind: 'markdown', text: text.replace(/\n$/, '') }])
  })

  it('lifts a balanced block-tag run out of the markdown stream', () => {
    const segments = splitHtmlBlocks([
      '# Title',
      '',
      '<div align="center">',
      '  <img alt="badge" src="https://img.shields.io/badge/x-y-blue" />',
      '</div>',
      '',
      'tail text',
    ].join('\n'))
    expect(segments).toEqual([
      { kind: 'markdown', text: '# Title' },
      { kind: 'html', text: '<div align="center">\n  <img alt="badge" src="https://img.shields.io/badge/x-y-blue" />\n</div>' },
      { kind: 'markdown', text: 'tail text' },
    ])
  })

  it('ends an HTML run at a blank line', () => {
    const segments = splitHtmlBlocks('<p>a</p>\n\nafter')
    expect(segments).toEqual([
      { kind: 'html', text: '<p>a</p>' },
      { kind: 'markdown', text: 'after' },
    ])
  })

  it('does not lift tag-like lines inside fenced code blocks', () => {
    const segments = splitHtmlBlocks([
      '```html',
      '<div class="demo">',
      '  <p>example</p>',
      '</div>',
      '```',
      '',
      '<div align="center">real</div>',
    ].join('\n'))
    expect(segments).toEqual([
      { kind: 'markdown', text: '```html\n<div class="demo">\n  <p>example</p>\n</div>\n```' },
      { kind: 'html', text: '<div align="center">real</div>' },
    ])
  })

  it('does not lift inline-only tags or prose starting with a comparison', () => {
    const segments = splitHtmlBlocks([
      'a < b and <code>x</code> inline',
      '<br/> alone on its line',
    ].join('\n'))
    expect(segments).toEqual([
      { kind: 'markdown', text: 'a < b and <code>x</code> inline\n<br/> alone on its line' },
    ])
  })

  it('treats a close-tag-only line as an HTML run', () => {
    const segments = splitHtmlBlocks('text\n\n</details>\n\nmore')
    expect(segments).toEqual([
      { kind: 'markdown', text: 'text' },
      { kind: 'html', text: '</details>' },
      { kind: 'markdown', text: 'more' },
    ])
  })

  it('accumulates a comment run until the closing marker line', () => {
    const segments = splitHtmlBlocks('<!-- section\n  banner\n-->\n\nbody')
    expect(segments).toEqual([
      { kind: 'html', text: '<!-- section\n  banner\n-->' },
      { kind: 'markdown', text: 'body' },
    ])
  })

  it('keeps an unterminated fence as markdown (CommonMark recovery)', () => {
    const segments = splitHtmlBlocks('```\n<div>x</div>')
    expect(segments).toEqual([{ kind: 'markdown', text: '```\n<div>x</div>' }])
  })

  it('keeps the README details shape as three segments', () => {
    const segments = splitHtmlBlocks([
      '<details>',
      '<summary><b>更新</b></summary>',
      '',
      '```sh',
      'dsh plugin --profile web add x',
      '```',
      '',
      '</details>',
    ].join('\n'))
    expect(segments.map((segment) => segment.kind)).toEqual(['html', 'markdown', 'html'])
    expect(segments[0]).toEqual({ kind: 'html', text: '<details>\n<summary><b>更新</b></summary>' })
    expect(segments[2]).toEqual({ kind: 'html', text: '</details>' })
  })
})

describe('analyzeHtmlSegment', () => {
  it('reduces a balanced run to a single html part', () => {
    expect(shape(analyzeHtmlSegment('<div align="center"><img src="https://x/y.png"/></div>').parts))
      .toEqual(['html(<div align="center"><img src="https://x/y.png"/></div>)'])
  })

  it('surfaces an unclosed open tag as a wrapper with its inner html', () => {
    expect(shape(analyzeHtmlSegment('<details>\n<summary><b>更新</b></summary>').parts))
      .toEqual(['open(details)', 'html(\n<summary><b>更新</b></summary>)'])
  })

  it('surfaces an unmatched close as a pop', () => {
    expect(shape(analyzeHtmlSegment('</details>').parts)).toEqual(['close(details)'])
  })

  it('orders mixed leading closes before following html and closes', () => {
    expect(shape(analyzeHtmlSegment('</div> mid </details>').parts))
      .toEqual(['close(div)', 'html( mid )', 'close(details)'])
  })

  it('nests multiple unclosed opens outermost-first', () => {
    expect(shape(analyzeHtmlSegment('<div align="center"><details>').parts))
      .toEqual(['open(div align="center")', 'open(details)'])
  })

  it('keeps attrs of the open token for the wrapper', () => {
    const parts = analyzeHtmlSegment('<details open class="x">body').parts
    expect(parts[0]).toEqual({ kind: 'open', tag: 'details', attrs: ' open class="x"' })
  })

  it('ignores void and self-closing tags for balance', () => {
    expect(shape(analyzeHtmlSegment('<img src="x"><br/><span/>after').parts))
      .toEqual(['html(<img src="x"><br/><span/>after)'])
  })

  it('ignores tags inside comments', () => {
    expect(shape(analyzeHtmlSegment('<!-- <div> commented out -->').parts))
      .toEqual(['html(<!-- <div> commented out -->)'])
  })

  it('pops implicitly through a mismatched close', () => {
    // <p> is implicitly closed by </div>: nothing structural remains.
    expect(shape(analyzeHtmlSegment('<div><p>text</div>').parts))
      .toEqual(['html(<div><p>text</div>)'])
  })
})

describe('collectReferenceDefinitions + analyzeMarkdownHtml', () => {
  it('collects definitions from markdown runs only, in document order', () => {
    const info = analyzeMarkdownHtml([
      'intro [link][shared]',
      '',
      '<div align="center">badges</div>',
      '',
      '[shared]: https://example.com',
      '[img]: ./local.png',
    ].join('\n'))
    expect(info.referenceDefinitions).toBe('[shared]: https://example.com\n[img]: ./local.png')
    expect(collectReferenceDefinitions(info.segments)).toBe(info.referenceDefinitions)
  })

  it('reports hasBlockHtml only when a run was lifted', () => {
    expect(analyzeMarkdownHtml('# plain\ntext').hasBlockHtml).toBe(false)
    expect(analyzeMarkdownHtml('<div>x</div>').hasBlockHtml).toBe(true)
    // Inline-only tags: no block html, but the inline gate is on.
    const inline = analyzeMarkdownHtml('| a | b |\n|---|---|\n| x<br/>y | z |')
    expect(inline.hasBlockHtml).toBe(false)
    expect(inline.hasInlineHtml).toBe(true)
  })

  it('gates inline html on tag-like source text', () => {
    expect(analyzeMarkdownHtml('a < b').hasInlineHtml).toBe(false)
    expect(analyzeMarkdownHtml('a <b>bold</b>').hasInlineHtml).toBe(true)
    expect(analyzeMarkdownHtml('plain markdown').hasInlineHtml).toBe(false)
  })
})
