/**
 * The built-in text editor's find/replace TOOLBAR affordance: the header's
 * magnifier button opens CodeMirror's search panel — the same panel the
 * Ctrl/Cmd+F keymap opens (find-in-file wiring itself is pinned by
 * editor-find.spec.tsx, which owns the extensions, the keymap and the panel
 * copy) — and the panel carries the REPLACE row, so the button reaches both
 * halves of the find/replace surface. The button also flips a markdown
 * preview to edit first, since the panel lives in the hidden CodeMirror
 * surface.
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

/** The header's preview/edit toggle buttons, keyed by their label. */
function modeButton(container: HTMLDivElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`mode button "${label}" not found`)
  return button
}

/** The active mode toggle carries one extra class (the "active" marker). */
function activeMode(container: HTMLDivElement): string {
  const preview = modeButton(container, 'Preview')
  const edit = modeButton(container, 'Edit')
  return edit.classList.length > preview.classList.length ? 'edit' : 'preview'
}

afterEach(() => {
  attachLocale(undefined)
  document.body.innerHTML = ''
})

describe('TextEditor find/replace toolbar button', () => {
  it('opens the search panel, replace row included, from the toolbar button', () => {
    attachLocale(new FakeLocale())
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      expect(searchPanel(mounted.container)).toBeNull()
      // The markdown viewer starts in preview, where the CodeMirror surface
      // (and therefore the panel) is hidden — the button must flip first.
      expect(activeMode(mounted.container)).toBe('preview')
      click(searchButton(mounted.container))
      const panel = searchPanel(mounted.container)
      expect(panel).not.toBeNull()
      // The button reaches the REPLACE half too (an editable view's panel
      // renders the second field; a read-only one would not).
      expect(panel!.querySelector('input[name="replace"]')).not.toBeNull()
      expect(activeMode(mounted.container)).toBe('edit')
    } finally {
      mounted.unmount()
    }
  })
})
