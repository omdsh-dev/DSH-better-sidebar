// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  MarkdownVisualEditor,
  type MarkdownVisualEditorHandle,
} from '../src/client/MarkdownVisualEditor.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

async function mountEditor() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const ref = createRef<MarkdownVisualEditorHandle>()
  await act(async () => {
    root.render(createElement(MarkdownVisualEditor, {
      ref,
      markdown: '# Heading\n\nBody',
      onChange: () => {},
      onError: () => {},
      imagePreviewHandler: async source => source,
    }))
    await Promise.resolve()
  })
  mounted.push(() => {
    act(() => { root.unmount() })
    container.remove()
  })
  return { container, ref }
}

describe('Markdown source/preview toolbar', () => {
  it('keeps the mode switch at the far right and swaps one document between views', async () => {
    const { container, ref } = await mountEditor()
    const toolbar = container.querySelector('.mdxeditor-toolbar')!
    const group = toolbar.querySelector('[role="group"][aria-label="Content view mode"]')!
    const actions = toolbar.querySelector('[data-markdown-toolbar-actions]')!
    expect(group).not.toBeNull()
    expect(actions).not.toBeNull()
    expect(actions.getAttribute('data-hidden')).toBe('false')
    expect(toolbar.lastElementChild).toBe(group)

    const buttons = [...group.querySelectorAll('button')]
    const source = buttons.find(button => button.textContent === 'Source')!
    const preview = buttons.find(button => button.textContent === 'Preview')!
    expect(preview.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.mdxeditor-source-editor')).toBeNull()

    await act(async () => { source.click(); await Promise.resolve() })
    expect(source.getAttribute('aria-pressed')).toBe('true')
    expect(toolbar.querySelector('[data-markdown-toolbar-actions]')).toBe(actions)
    expect(actions.getAttribute('data-hidden')).toBe('true')
    expect(container.querySelector('.mdxeditor-source-editor')).not.toBeNull()
    expect(ref.current?.getMarkdown()).toContain('# Heading')

    await act(async () => { preview.click(); await Promise.resolve() })
    expect(preview.getAttribute('aria-pressed')).toBe('true')
    expect(actions.getAttribute('data-hidden')).toBe('false')
    expect(container.querySelector('.mdxeditor-source-editor')).toBeNull()
    expect(ref.current?.getMarkdown()).toContain('# Heading')
  })
})
