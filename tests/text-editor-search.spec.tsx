/**
 * The built-in text editor's find/replace surface (CodeMirror's search
 * extension): the toolbar button opens the panel, the panel's labels follow
 * the sidebar's own dictionary (CodeMirror ships English-only strings), and
 * the panel is reachable in BOTH modes (the button flips a markdown/html
 * preview to edit first, since the panel lives in the editor surface).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): void {
    return () => {}
  }
}

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: {} as FileViewerProps['ctx'],
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a.md',
    title: 'a.md',
    viewerId: 'markdown',
    content: '# Title\n\nneedle here\n\nneedle again\n',
    ...overrides,
  }
}

function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** The toolbar's search button (locale-dependent aria-label). */
function searchButton(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector('button[aria-label="Find"], button[aria-label="查找"]')
  if (button === null) throw new Error('search button not found')
  return button as HTMLButtonElement
}

/** The CodeMirror search panel, or null while closed. */
function searchPanel(container: HTMLDivElement): HTMLElement | null {
  return container.querySelector('.cm-search')
}

afterEach(() => {
  attachLocale(undefined)
  document.body.innerHTML = ''
})

describe('TextEditor find/replace', () => {
  it('opens the search panel from the toolbar button, in edit mode', () => {
    const locale = new FakeLocale()
    attachLocale(locale)
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      expect(searchPanel(mounted.container)).toBeNull()
      click(searchButton(mounted.container))
      const panel = searchPanel(mounted.container)
      expect(panel).not.toBeNull()
      // The markdown editor flipped from preview to edit (the panel lives in
      // the CodeMirror surface, which is display:none while previewing).
      expect(panel!.closest('[hidden]')).toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('localizes the panel labels from the sidebar dictionary (en)', () => {
    const locale = new FakeLocale()
    locale.active = 'en'
    attachLocale(locale)
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ viewerId: 'code', path: '/p/a.ts' })))
    try {
      click(searchButton(mounted.container))
      const panel = searchPanel(mounted.container)
      expect(panel).not.toBeNull()
      const text = panel!.textContent ?? ''
      expect(text).toContain('Replace')
      expect(text).toContain('Match case')
      expect(text).toContain('Whole word')
      // The panel's Find input carries the placeholder/aria-label.
      const findInput = panel!.querySelector('input[name="search"]')
      expect(findInput?.getAttribute('aria-label')).toBe('Find')
    } finally {
      mounted.unmount()
    }
  })

  it('localizes the panel labels from the sidebar dictionary (zh)', () => {
    const locale = new FakeLocale()
    locale.active = 'zh'
    attachLocale(locale)
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ viewerId: 'code', path: '/p/a.ts' })))
    try {
      click(searchButton(mounted.container))
      const panel = searchPanel(mounted.container)
      expect(panel).not.toBeNull()
      const text = panel!.textContent ?? ''
      expect(text).toContain('替换')
      expect(text).toContain('区分大小写')
      expect(text).toContain('全词')
      const findInput = panel!.querySelector('input[name="search"]')
      expect(findInput?.getAttribute('aria-label')).toBe('查找')
    } finally {
      mounted.unmount()
    }
  })

  it('opens the panel with Mod-f on the editor surface', () => {
    attachLocale(new FakeLocale())
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ viewerId: 'code', path: '/p/a.ts' })))
    try {
      const content = mounted.container.querySelector('.cm-content')
      expect(content).not.toBeNull()
      act(() => {
        content!.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true,
        }))
      })
      expect(searchPanel(mounted.container)).not.toBeNull()
    } finally {
      mounted.unmount()
    }
  })
})
