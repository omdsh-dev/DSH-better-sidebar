import { describe, expect, it } from 'vitest'
import { markdownLinkTarget, resolveMarkdownAnchor, resolveMarkdownLink, rewriteMarkdownFileLinks, stripMarkdownAnchorTags } from '../src/client/markdown-links.ts'

describe('resolveMarkdownLink', () => {
  const source = 'E:/document/dsh/guide/intro.md'

  it('resolves a sibling Markdown file and removes the fragment', () => {
    expect(resolveMarkdownLink(source, './chapter-2.md#summary'))
      .toBe('E:/document/dsh/guide/chapter-2.md')
  })

  it('resolves parent directories and encoded names', () => {
    expect(resolveMarkdownLink(source, '../shared/My%20Notes.markdown'))
      .toBe('E:/document/dsh/shared/My Notes.markdown')
  })

  it('ignores anchors, web URLs and non-Markdown files', () => {
    expect(resolveMarkdownLink(source, '#intro')).toBeNull()
    expect(resolveMarkdownLink(source, 'https://example.com/other.md')).toBeNull()
    expect(resolveMarkdownLink(source, 'image.png')).toBeNull()
  })

  it('recognizes an in-page heading anchor', () => {
    expect(resolveMarkdownAnchor('#安装说明')).toBe('安装说明')
    expect(resolveMarkdownAnchor('two.md#summary')).toBeNull()
    expect(resolveMarkdownAnchor('#')).toBeNull()
  })

  it('removes explicit HTML anchor markers from preview text', () => {
    expect(stripMarkdownAnchorTags('before\n<a id="sec01"></a>\n## 标题\nafter'))
      .toBe('before\n\n## 标题\nafter')
    expect(stripMarkdownAnchorTags('<a class="x" id=\'sec02\'></a>')).toBe('')
  })

  it('rewrites local links into same-origin marker URLs', () => {
    const rewritten = rewriteMarkdownFileLinks('See [next](two.md) and ` [code](two.md) `.', source, 'http://127.0.0.1:3080')
    expect(rewritten).toContain('http://127.0.0.1:3080/__dsh-better-sidebar-markdown-link?target=two.md')
    expect(rewriteMarkdownFileLinks('See [section](#安装说明).', source, 'http://127.0.0.1:3080'))
      .toContain('target=%23%E5%AE%89%E8%A3%85%E8%AF%B4%E6%98%8E')
    expect(rewritten).toContain('` [code](two.md) `')
    expect(markdownLinkTarget('http://127.0.0.1:3080/__dsh-better-sidebar-markdown-link?target=two.md', 'http://127.0.0.1:3080'))
      .toBe('two.md')
  })
})
