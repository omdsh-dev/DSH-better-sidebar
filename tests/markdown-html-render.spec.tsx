/**
 * MarkdownDocument spec: the split-document renderer — sanitized HTML leaves
 * (denylist + anchor hardening + local media rewrite), `<details>` nesting of
 * in-between markdown, cross-segment reference definitions, and the inline
 * pass that turns tag text inside rendered markdown back into elements.
 * Renders with the real shared MarkdownText in jsdom (same pattern as
 * tests/mermaid-markdown.spec.tsx).
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MarkdownDocument, type MarkdownHtmlMedia } from '../src/client/MarkdownHtml.tsx'
import { analyzeMarkdownHtml } from '../src/client/markdown-html.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

const media: MarkdownHtmlMedia = {
  scope: { sessionId: 's1', cwd: '/ws' },
  path: '/ws/docs/README.md',
  origin: 'http://gui.origin',
}
const codeLabels = { copyLabel: 'Copy', copiedLabel: 'Copied' }

async function renderDocument(text: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(MarkdownDocument, {
      info: analyzeMarkdownHtml(text),
      media,
      codeLabels,
    }))
    // Let the MutationObserver's queued inline pass settle inside the act scope.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
  return { container, root }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('MarkdownDocument (HTML leaves)', () => {
  it('renders a balanced HTML block as sanitized DOM, not literal text', async () => {
    const { container, root } = await renderDocument([
      '# Title',
      '',
      '<div align="center">',
      '  <img alt="badge" src="https://img.shields.io/badge/x-y-blue" />',
      '</div>',
    ].join('\n'))
    const leaf = container.querySelector('[data-dsh-html-segment]')
    expect(leaf, 'the html run must render as a sanitized leaf').not.toBeNull()
    expect(leaf?.querySelector('img[src*="img.shields.io"]')).not.toBeNull()
    expect(leaf?.firstElementChild?.getAttribute('align')).toBe('center')
    expect(container.textContent).not.toContain('<div')
    await unmount(root)
  })

  it('strips denied tags and hardens anchors', async () => {
    const { container, root } = await renderDocument([
      '<div>',
      '  <script>alert(1)</script>',
      '  <a href="https://example.com">link</a>',
      '</div>',
    ].join('\n'))
    expect(container.querySelector('script')).toBeNull()
    const anchor = container.querySelector('a[href="https://example.com"]')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer')
    await unmount(root)
  })

  it('rewrites local media sources through the /sidebar/file route', async () => {
    const { container, root } = await renderDocument('<picture><img src="./shot.png" alt="shot"/></picture>')
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('http://gui.origin/sidebar/file?sessionId=s1&path=%2Fws%2Fdocs%2Fshot.png&cwd=%2Fws')
    await unmount(root)
  })
})

describe('MarkdownDocument (nesting + markdown runs)', () => {
  it('nests markdown runs inside an unclosed <details> element', async () => {
    const { container, root } = await renderDocument([
      '<details>',
      '<summary><b>更新</b></summary>',
      '',
      '```sh',
      'dsh plugin --profile web add x',
      '```',
      '',
      '</details>',
      '',
      'after the fold',
    ].join('\n'))
    const details = container.querySelector('details')
    expect(details, 'the open part must lower following runs into a details element').not.toBeNull()
    expect(details?.querySelector('summary')).not.toBeNull()
    expect(details?.textContent).toContain('dsh plugin --profile web add x')
    // The close part pops the frame: the trailing markdown is a sibling.
    expect(details?.textContent).not.toContain('after the fold')
    expect(container.querySelector('details')?.nextElementSibling?.textContent).toContain('after the fold')
    await unmount(root)
  })

  it('keeps reference definitions resolving across lifted HTML runs', async () => {
    const { container, root } = await renderDocument([
      'see [the docs][shared]',
      '',
      '<div align="center">badges</div>',
      '',
      '[shared]: https://example.com/docs',
    ].join('\n'))
    const anchor = container.querySelector('a[href="https://example.com/docs"]')
    expect(anchor, 'a definition after an HTML run must still resolve').not.toBeNull()
    expect(anchor?.textContent).toContain('the docs')
    await unmount(root)
  })

  it('renders a forbidden wrapper as transparent (children survive)', async () => {
    const { container, root } = await renderDocument([
      '<form action="/x">',
      '',
      'inner text',
      '',
      '</form>',
    ].join('\n'))
    expect(container.querySelector('form')).toBeNull()
    expect(container.textContent).toContain('inner text')
    await unmount(root)
  })
})

describe('MarkdownDocument (inline pass)', () => {
  it('turns tag text in table cells back into elements', async () => {
    const { container, root } = await renderDocument([
      '| feature | notes |',
      '|---|---|',
      '| alpha | line one<br/>line two |',
    ].join('\n'))
    const cell = [...container.querySelectorAll('td')].find((td) => td.textContent?.includes('line one'))
    expect(cell?.querySelector('[data-html-inline] br'), 'the <br/> must render as a real element').not.toBeNull()
    await unmount(root)
  })

  it('leaves rendered code and comparison prose untouched', async () => {
    const { container, root } = await renderDocument([
      'a < b comparison stays text',
      '',
      '```html',
      '<div>demo</div>',
      '```',
    ].join('\n'))
    expect(container.querySelectorAll('[data-html-inline]').length).toBe(0)
    expect(container.textContent).toContain('a < b comparison stays text')
    const code = container.querySelector('code')
    expect(code?.textContent).toContain('<div>demo</div>')
    await unmount(root)
  })

  it('rewrites local image src inside inline-swapped tags', async () => {
    const { container, root } = await renderDocument('text <img src="./icon.png" alt="i"/> tail')
    const img = container.querySelector('[data-html-inline] img')
    expect(img?.getAttribute('src')).toContain('/sidebar/file?')
    await unmount(root)
  })
})
