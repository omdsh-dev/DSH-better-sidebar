/** WindowDocumentContent: source body wrapper and discussion siblings do not mix body-only TOC scope. */
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { ClueFormatHost } from '../src/client/windows/format-content.tsx'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()
afterEach(() => document.body.replaceChildren())
it('wraps just the preview body and renders a supplement outside that scope', () => {
  const view = renderRoot(createElement(ClueFormatHost, {
    kind: 'document', sourceId: 'source', typeId: 'type', format: 'text/plain',
    document: { format: 'text/plain', data: 'body-only' }, readOnly: true,
    registry: { subscribe: () => () => {}, getFormatRenderer: () => undefined },
    bodyWrapper: body => createElement('div', { 'data-body-scope': '' }, body),
    afterBody: createElement('h2', null, 'Discussion heading'),
  }))
  try {
    expect(view.container.querySelector('[data-body-scope]')?.textContent).toBe('body-only')
    expect(view.container.querySelector('[data-window-document-after-body]')?.textContent).toBe('Discussion heading')
    expect(view.container.querySelector('[data-body-scope] h2')).toBeNull()
  } finally { view.unmount() }
})

it('offers an outline of body headings without including comment headings', () => {
  const view = renderRoot(createElement(ClueFormatHost, {
    kind: 'document', sourceId: 'source', typeId: 'type', format: 'text/markdown', readOnly: true,
    document: { format: 'text/markdown', data: '# Body one\n## Body two\n### Body three' },
    registry: { subscribe: () => () => {}, getFormatRenderer: () => undefined },
    afterBody: createElement('h2', null, 'Comment heading'),
  }))
  try {
    const button = view.container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!
    expect(button).not.toBeNull()
    act(() => { button.click() })
    const outline = view.container.querySelector('[data-dsh-md-toc-panel]')!
    expect(outline.textContent).toContain('Body one')
    expect(outline.textContent).not.toContain('Comment heading')
  } finally { view.unmount() }
})
