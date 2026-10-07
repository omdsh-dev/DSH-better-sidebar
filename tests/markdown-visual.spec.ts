import { describe, expect, it } from 'vitest'
import { supportsVisualMarkdown } from '../src/client/markdown-visual.ts'

describe('Markdown writing eligibility', () => {
  it('accepts headings, paragraphs, emphasis, links, lists, and code blocks', () => {
    expect(supportsVisualMarkdown('# Heading\n\nA **bold** [link](https://example.com).\n\n- Item\n\n```ts\nconst value = 1\n```')).toBe(true)
  })

  it.each([
    '---\ntitle: Draft\n---\nBody',
    '\uFEFF---\r\ntitle: Draft\r\n---\r\nBody',
    '- [ ] unfinished',
    '| Name | Value |\n| --- | --- |\n| A | B |',
    '![alt](./image.png)',
    'Claim[^1]\n\n[^1]: Source',
    '<aside>Note</aside>',
    '[text][target]\n\n[target]: https://example.com',
  ])('protects unsupported Markdown from visual editing: %s', source => {
    expect(supportsVisualMarkdown(source)).toBe(false)
  })
})
