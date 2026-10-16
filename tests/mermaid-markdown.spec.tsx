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
import { setupReactAct } from './test-utils.ts'
setupReactAct()

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>MOCK-DIAGRAM</text></svg>',
    }),
  },
}))

import mermaid from 'mermaid'
import { MermaidMarkdown } from '../src/client/mermaid.tsx'

const codeLabels = {
  copyLabel: 'Copy', copiedLabel: 'Copied', codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines',
}

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

  it('suppresses Mermaid global error rendering', async () => {
    vi.mocked(mermaid.initialize).mockClear()
    const { root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      suppressErrorRendering: true,
    }))
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

/** Open the zoom modal by clicking the rendered diagram. */
async function openModal(container: HTMLElement): Promise<HTMLElement> {
  const diagram = container.querySelector('[data-mermaid-diagram] svg')
  expect(diagram, 'the diagram must render before it can be enlarged').not.toBeNull()
  await act(async () => {
    diagram!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const modal = document.querySelector<HTMLElement>('[data-mermaid-modal]')
  expect(modal, 'clicking the diagram opens the zoom modal').not.toBeNull()
  return modal!
}

/** The modal's viewport (the fixed white surface) and its content svg. */
function modalParts(modal: HTMLElement): { viewport: HTMLElement; content: SVGSVGElement } {
  const viewport = modal.querySelector<HTMLElement>('[data-mermaid-viewport]')
  expect(viewport, 'the modal must own a viewport element').not.toBeNull()
  const content = viewport!.querySelector<SVGSVGElement>('svg')
  expect(content, 'the enlarged diagram must live inside the viewport').not.toBeNull()
  return { viewport: viewport!, content: content! }
}

const toolbarButton = (modal: HTMLElement, label: string): HTMLButtonElement =>
  [...modal.querySelectorAll('button')].find(button => button.textContent === label) as HTMLButtonElement

describe('MermaidZoomModal (issue #683)', () => {
  it('transforms only the content, never the viewport that paints the card', async () => {
    const { container, root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    const modal = await openModal(container)
    const { viewport, content } = modalParts(modal)

    expect(content.style.transform, 'the content carries the zoom transform').toMatch(/scale\(/)
    expect(viewport.style.transform, 'the viewport (the painted card) must not be transformed').toBe('')
    // The card's fix is structural: the paint sits on the stage, the transform
    // on the svg — tests/panel-host-css.spec.ts pins the CSS half of that.
    expect(content.parentElement, 'the svg is the viewport\'s child').toBe(viewport)
    await unmount(root)
  })

  it('zooms from the toolbar and returns to the framed view on reset', async () => {
    const { container, root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    const modal = await openModal(container)
    const { content } = modalParts(modal)
    // jsdom has no layout, so the frame falls back to 1:1 and the reset target
    // is 1 — the assertions below are about the wiring, not about pixels.
    const framed = content.style.transform
    expect(framed).toContain('scale(1)')

    await act(async () => { toolbarButton(modal, '+').click() })
    expect(content.style.transform, 'the + button must zoom the content').toContain('scale(1.2)')

    await act(async () => { toolbarButton(modal, '⟳').click() })
    expect(content.style.transform, 'reset returns to the framed view').toBe(framed)
    await unmount(root)
  })

  it('closes on Escape and leaves the preview diagram untouched', async () => {
    const { container, root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    const modal = await openModal(container)
    const preview = container.querySelector('[data-mermaid-diagram] svg')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(document.querySelector('[data-mermaid-modal]'), 'Escape must close the modal').toBeNull()
    expect(preview?.isConnected, 'the preview copy stays where it was').toBe(true)
    expect(modal.isConnected, 'the enlarged clone is gone').toBe(false)
    await unmount(root)
  })
})
