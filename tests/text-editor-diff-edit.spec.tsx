// @vitest-environment jsdom
import './browser-globals.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EditorView } from '@codemirror/view'
import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

const markdownSet = vi.hoisted(() => vi.fn())

vi.mock('../src/client/MarkdownVisualEditor.tsx', () => ({
  MarkdownVisualEditor: forwardRef(function MockMarkdownVisualEditor(props: {
    markdown: string
    onChange: (markdown: string, initialMarkdownNormalize: boolean) => void
  }, ref) {
    const valueRef = useRef(props.markdown)
    const [value, setValue] = useState(props.markdown)
    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      setMarkdown: (next: string) => {
        valueRef.current = next
        setValue(next)
        markdownSet(next)
        props.onChange(next, false)
      },
    }), [props])
    return createElement('div', { 'data-testid': 'markdown-document' }, value)
  }),
}))

import { TextEditor } from '../src/client/TextEditor.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const CTX = {} as Context

function props(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/repo', repoRoot: '/repo' },
    path: '/repo/a.ts',
    title: 'a.ts',
    viewerId: 'code',
    content: 'one\nlocal\nthree\n',
    ...overrides,
  }
}

function mountEditor(viewerProps: FileViewerProps) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(TextEditor, viewerProps)) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent === text)
  expect(found).toBeDefined()
  return found!
}

function cmView(container: HTMLElement, selector: string): EditorView {
  const content = container.querySelector<HTMLElement>(`${selector} .cm-content`)
  expect(content).not.toBeNull()
  const view = EditorView.findFromDOM(content!)
  expect(view).not.toBeNull()
  return view!
}

beforeEach(() => {
  markdownSet.mockReset()
  vi.restoreAllMocks()
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

describe('TextEditor diff editing', () => {
  it('persists code edits across file/diff switches and saves the synchronized draft', async () => {
    vi.spyOn(api, 'gitShow').mockResolvedValue({ content: 'one\nHEAD\nthree\n' })
    const write = vi.spyOn(api, 'fsWrite').mockResolvedValue({ ok: true })
    const mounted = mountEditor(props())
    try {
      act(() => { button(mounted.container, '差异').click() })
      await flush()
      const current = cmView(mounted.container, '.cm-merge-b')
      act(() => { current.dispatch({ changes: { from: 4, to: 9, insert: 'edited' } }) })

      expect(mounted.container.querySelector('[title="未保存"]')).not.toBeNull()
      const save = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')
      expect(save).not.toBeNull()
      act(() => { save!.click() })
      await flush()
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1' }),
        '/repo/a.ts',
        'one\nedited\nthree\n',
      )

      act(() => { button(mounted.container, '文件').click() })
      const primary = cmView(mounted.container, '.cm-editor')
      expect(primary.state.doc.toString()).toBe('one\nedited\nthree\n')

      act(() => { button(mounted.container, '差异').click() })
      await flush()
      expect(cmView(mounted.container, '.cm-merge-b').state.doc.toString()).toBe('one\nedited\nthree\n')
    } finally {
      mounted.unmount()
    }
  })

  it('writes markdown diff edits into the visual editor document before saving', async () => {
    vi.spyOn(api, 'gitShow').mockResolvedValue({ content: '# HEAD\n' })
    const write = vi.spyOn(api, 'fsWrite').mockResolvedValue({ ok: true })
    const mounted = mountEditor(props({
      path: '/repo/readme.md',
      title: 'readme.md',
      viewerId: 'markdown',
      content: '# Local\n',
    }))
    try {
      await flush()
      markdownSet.mockClear()
      act(() => { button(mounted.container, '差异').click() })
      await flush()
      const current = cmView(mounted.container, '.cm-merge-b')
      act(() => {
        current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: '# Edited\n' } })
      })

      expect(markdownSet).toHaveBeenLastCalledWith('# Edited\n')
      expect(mounted.container.querySelector('[title="未保存"]')).not.toBeNull()
      const save = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')
      act(() => { save!.click() })
      await flush()
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1' }),
        '/repo/readme.md',
        '# Edited\n',
      )

      act(() => { button(mounted.container, '文件').click() })
      expect(mounted.container.querySelector('[data-testid="markdown-document"]')?.textContent).toBe('# Edited\n')
    } finally {
      mounted.unmount()
    }
  })
})
