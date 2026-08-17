/**
 * MermaidMarkdown architecture spec: the preview renders the WHOLE document
 * through one MarkdownText pass (cross-fence reference-style links must
 * resolve — the P1 regression from the CR), then swaps every rendered
 * mermaid CodeBlock for a diagram. mermaid is mocked so the swap + semantics
 * are asserted without pulling the real layout engine into jsdom.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>MOCK-DIAGRAM</text></svg>',
    }),
  },
}))

import { MermaidMarkdown } from '../src/client/mermaid.tsx'

const codeLabels = { copyLabel: 'Copy', copiedLabel: 'Copied' }

async function renderMarkdown(text: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(MermaidMarkdown, { text, codeLabels }))
    // Let the mocked mermaid.render promise settle inside the act scope.
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
  return { container, root }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('MermaidMarkdown', () => {
  it('swaps the mermaid code block for a rendered diagram', async () => {
    const { container, root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    const diagram = container.querySelector('[data-mermaid-diagram] svg')
    expect(diagram, 'the mermaid fence must be swapped for a diagram').not.toBeNull()
    expect(diagram?.textContent).toContain('MOCK-DIAGRAM')
    await unmount(root)
  })

  it('resolves cross-fence reference-style links (single markdown parse)', async () => {
    const text = [
      '[before][shared]',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '[shared]: https://example.com',
    ].join('\n')
    const { container, root } = await renderMarkdown(text)
    const link = container.querySelector('a[href="https://example.com"]')
    expect(link, 'the definition after the fence must resolve the link before it').not.toBeNull()
    expect(link?.textContent).toContain('before')
    expect(container.querySelector('[data-mermaid-diagram] svg'), 'the diagram must still swap in').not.toBeNull()
    await unmount(root)
  })

  it('leaves non-mermaid fences untouched', async () => {
    const { container, root } = await renderMarkdown('```ts\nconst a = 1\n```')
    expect(container.querySelector('[data-mermaid-diagram]'), 'no mermaid fence → no swap').toBeNull()
    expect(container.querySelectorAll('.md-code-block').length, 'the ts fence stays a code block').toBe(1)
    await unmount(root)
  })
})
