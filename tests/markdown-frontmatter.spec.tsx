/**
 * Markdown frontmatter preview regression (#251): a leading, closed YAML
 * metadata block must not reach the shared MarkdownText parser, where its
 * delimiters are otherwise interpreted as a thematic break and setext H2.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import './browser-globals.ts'
import { markdownPreviewSource } from '../src/client/markdown-frontmatter.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { attachLocale } from '../src/client/locales.ts'
import type { FileViewerProps } from '../src/client/service.ts'

const FRONTMATTER = [
  '---',
  'name: example',
  'description: hello',
  '---',
  '# Title',
  '',
  'Body',
].join('\n')

const CTX = {} as Parameters<typeof TextEditor>[0]['ctx']

function viewerProps(content: string): FileViewerProps {
  return {
    ctx: CTX,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/SKILL.md',
    title: 'SKILL.md',
    viewerId: 'markdown',
    content,
  }
}

afterEach(() => {
  attachLocale(undefined)
})

describe('markdownPreviewSource', () => {
  it('removes a closed YAML frontmatter block only from the preview source', () => {
    expect(markdownPreviewSource(FRONTMATTER)).toBe('# Title\n\nBody')
  })

  it('supports CRLF without normalizing the body', () => {
    expect(markdownPreviewSource('---\r\nname: example\r\n---\r\n# Title\r\nBody'))
      .toBe('# Title\r\nBody')
  })

  it('leaves unclosed and non-leading delimiters unchanged', () => {
    const unclosed = '---\nname: example\n# Title'
    const nonLeading = '# Title\n\n---\nname: example\n---\n'
    expect(markdownPreviewSource(unclosed)).toBe(unclosed)
    expect(markdownPreviewSource(nonLeading)).toBe(nonLeading)
  })
})

describe('TextEditor markdown frontmatter preview', () => {
  it('renders the body without exposing YAML metadata as a heading', () => {
    const html = renderToString(createElement(TextEditor, viewerProps(FRONTMATTER)))
    expect(html).toContain('<h1')
    expect(html).not.toContain('<h2')
    expect(html).toContain('Title')
    expect(html).toContain('Body')
    expect(html).not.toContain('name: example')
    expect(html).not.toContain('description: hello')
  })
})
