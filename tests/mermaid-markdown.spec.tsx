/**
 * MermaidMarkdown architecture spec: the preview renders the WHOLE document
 * through one MarkdownText pass (cross-fence reference-style links must
 * resolve — the P1 regression from the CR), then swaps every rendered
 * mermaid CodeBlock for a diagram. The actual mermaid layout engine runs in
 * the isolated iframe (see mermaid-frame.ts), so the specs inject a stub
 * renderer instead of pulling mermaid into jsdom.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { MermaidMarkdown, resetMermaidRenderQueueForTests } from '../src/client/mermaid.tsx'
import { setMermaidFrameRendererForTests, type MermaidTheme } from '../src/client/mermaid-frame.ts'

/** The stub renderer the specs install; each test clears its call log. */
const renderDiagram = vi.fn(async (_code: string, _theme: MermaidTheme) => (
  '<svg xmlns="http://www.w3.org/2000/svg"><text>MOCK-DIAGRAM</text></svg>'
))

const codeLabels = {
  copyLabel: 'Copy', copiedLabel: 'Copied', codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines',
}

async function renderMarkdown(text: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(MermaidMarkdown, { text, codeLabels }))
    // Let the queued render + its state update settle inside the act scope.
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
  return { container, root }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
}

/**
 * Wait until `check` returns a truthy value. Diagram rendering is queued (one
 * render at a time, idle slots between them — the whole point of the queue), so
 * a swap lands asynchronously instead of in the mount commit.
 */
async function waitFor<T>(check: () => T | null | false, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now()
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the diagram render')
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 10) }) })
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  renderDiagram.mockClear()
  setMermaidFrameRendererForTests(renderDiagram)
})

afterEach(() => {
  setMermaidFrameRendererForTests(null)
  resetMermaidRenderQueueForTests()
})

describe('MermaidMarkdown', () => {
  it('swaps the mermaid code block for a rendered diagram', async () => {
    const { container, root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    const diagram = await waitFor(() => container.querySelector('[data-mermaid-diagram] svg'))
    expect(diagram, 'the mermaid fence must be swapped for a diagram').not.toBeNull()
    expect(diagram?.textContent).toContain('MOCK-DIAGRAM')
    await unmount(root)
  })

  it('renders with the current scheme theme through the isolated renderer', async () => {
    const { root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    await waitFor(() => renderDiagram.mock.calls.length > 0)
    expect(renderDiagram).toHaveBeenCalledWith(expect.stringContaining('graph TD'), 'default')
    await unmount(root)
  })

  it('shows a sized placeholder while the render is queued, then swaps it out', async () => {
    let release: ((svg: string) => void) | null = null
    setMermaidFrameRendererForTests(() => new Promise<string>((resolve) => { release = resolve }))
    const { container, root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    const placeholder = await waitFor(() => container.querySelector<HTMLElement>('[data-mermaid-pending]'))
    expect(placeholder, 'a diagram placeholder is shown while the render is queued').not.toBeNull()
    expect(placeholder.style.minHeight, 'the placeholder reserves height so the article does not jump').not.toBe('')
    // The queue starts the render on the next idle slot; release it only after
    // the stub renderer was actually invoked.
    await waitFor(() => (release === null ? null : true))
    await act(async () => {
      release?.('<svg xmlns="http://www.w3.org/2000/svg"><text>LATE-DIAGRAM</text></svg>')
      await new Promise(resolve => { setTimeout(resolve, 30) })
    })
    await waitFor(() => container.querySelector('[data-mermaid-diagram] svg'))
    expect(container.querySelector('[data-mermaid-pending]'), 'the placeholder is gone once the diagram is in').toBeNull()
    await unmount(root)
  })

  it('falls back to the fence source when the renderer fails', async () => {
    setMermaidFrameRendererForTests(async () => { throw new Error('boom') })
    const { container, root } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
    const source = await waitFor(() => container.querySelector('pre code'))
    expect(source?.textContent, 'a failed render keeps the source visible').toContain('graph TD')
    expect(container.textContent, 'the mermaid error itself is shown, not only a generic label').toContain('boom')
    expect(container.querySelector('[data-mermaid-diagram]'), 'no diagram is injected for a failed render').toBeNull()
    await unmount(root)
  })

  it('drains every diagram of a multi-fence document', async () => {
    const text = [
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      'prose between fences',
      '',
      '```mermaid',
      'graph LR',
      '  C --> D',
      '```',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hi',
      '```',
    ].join('\n')
    const { container, root } = await renderMarkdown(text)
    await waitFor(() => container.querySelectorAll('[data-mermaid-diagram] svg').length >= 3 && true)
    expect(container.querySelectorAll('[data-mermaid-diagram] svg').length, 'every fence must render, none may stay a code block').toBe(3)
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
    await waitFor(() => container.querySelector('[data-mermaid-diagram] svg'))
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
