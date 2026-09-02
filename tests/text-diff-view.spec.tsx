// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { TextDiffView, TEXT_DIFF_CONFIG, type TextDiffViewProps } from '../src/client/TextDiffView.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface MountedDiff {
  container: HTMLDivElement
  root: Root
  render: (props: TextDiffViewProps) => void
  unmount: () => void
}

function mountDiff(overrides: Partial<TextDiffViewProps> = {}): MountedDiff {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const base: TextDiffViewProps = {
    original: 'one\nHEAD\nthree\n',
    current: 'one\nlocal\nthree\n',
    path: '/repo/a.ts',
    dark: false,
    onCurrentChange: () => {},
    onSave: () => {},
  }
  const render = (props: TextDiffViewProps): void => {
    act(() => { root.render(createElement(TextDiffView, props)) })
  }
  render({ ...base, ...overrides })
  return {
    container,
    root,
    render,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

function cmView(container: HTMLElement, selector: string): EditorView {
  const content = container.querySelector<HTMLElement>(`${selector} .cm-content`)
  expect(content).not.toBeNull()
  const view = EditorView.findFromDOM(content!)
  expect(view).not.toBeNull()
  return view!
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('TextDiffView editable current document', () => {
  it('marks exact changed characters inside long prose lines', () => {
    const filler = Array.from({ length: 20 }, (_, index) => `未改变的背景资料第${index + 1}段。`).join('\n')
    const mounted = mountDiff({
      original: `${filler}\n## 当前状态（截至第003章）\n- 位置：桑河镇，林家铺面。\n`,
      current: `${filler}\n## 当前状态（截至第005章）\n- 位置：桑河镇，林记铺面 / 后院。\n`,
    })
    try {
      const removed = Array.from(mounted.container.querySelectorAll('.cm-merge-a .cm-changedText'))
        .map(node => node.textContent).join('|')
      const added = Array.from(mounted.container.querySelectorAll('.cm-merge-b .cm-changedText'))
        .map(node => node.textContent).join('|')
      expect(removed).toContain('3章')
      expect(removed).toContain('林家铺面')
      expect(added).toContain('5章')
      expect(added).toContain('林记铺面 / 后院')
      expect(TEXT_DIFF_CONFIG.scanLimit).toBeGreaterThan(500)
    } finally {
      mounted.unmount()
    }
  })

  it('keeps HEAD read-only and synchronizes edits from the current side', () => {
    const onCurrentChange = vi.fn()
    const mounted = mountDiff({ onCurrentChange })
    try {
      const head = cmView(mounted.container, '.cm-merge-a')
      const current = cmView(mounted.container, '.cm-merge-b')
      expect(head.state.facet(EditorState.readOnly)).toBe(true)
      expect(head.contentDOM.getAttribute('contenteditable')).toBe('false')
      expect(current.state.facet(EditorState.readOnly)).toBe(false)
      expect(current.contentDOM.getAttribute('contenteditable')).toBe('true')

      act(() => {
        current.dispatch({ changes: { from: 4, to: 9, insert: 'edited' } })
      })

      expect(head.state.doc.toString()).toBe('one\nHEAD\nthree\n')
      expect(current.state.doc.toString()).toBe('one\nedited\nthree\n')
      expect(onCurrentChange).toHaveBeenLastCalledWith('one\nedited\nthree\n')
    } finally {
      mounted.unmount()
    }
  })

  it('keeps unified mode editable and applies external content without a callback loop', () => {
    const onCurrentChange = vi.fn()
    const onSave = vi.fn()
    const props: TextDiffViewProps = {
      original: 'one\nHEAD\nthree\n',
      current: 'one\nlocal\nthree\n',
      path: '/repo/a.ts',
      dark: false,
      onCurrentChange,
      onSave,
    }
    const mounted = mountDiff(props)
    try {
      const unifiedButton = Array.from(mounted.container.querySelectorAll('button'))
        .find(button => button.textContent?.includes('单栏') === true || button.textContent?.includes('Unified') === true)
      expect(unifiedButton).toBeDefined()
      act(() => { unifiedButton!.click() })

      const unified = cmView(mounted.container, '[data-text-diff-view]')
      expect(unified.state.facet(EditorState.readOnly)).toBe(false)
      act(() => {
        unified.dispatch({ changes: { from: unified.state.doc.length, insert: 'tail\n' } })
      })
      expect(onCurrentChange).toHaveBeenLastCalledWith('one\nlocal\nthree\ntail\n')

      onCurrentChange.mockClear()
      mounted.render({ ...props, current: 'external\n' })
      const synchronized = cmView(mounted.container, '[data-text-diff-view]')
      expect(synchronized.state.doc.toString()).toBe('external\n')
      expect(onCurrentChange).not.toHaveBeenCalled()
    } finally {
      mounted.unmount()
    }
  })
})
