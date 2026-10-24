/**
 * Find-in-file spec (Cmd/Ctrl+F): the editor wires CodeMirror's search
 * extension into EVERY TextEditor view — the extension list is shared by the
 * code and markdown viewers, so "preview" (read-mostly) and "edit" mode both
 * get the panel, and the read-only markdown preview cannot be the only mode
 * without it. Covers the three promises of the feature:
 *
 *  - the extensions carry the upstream search extension + keymap (Mod-f
 *    open, Mod-g / Shift-Mod-g next/previous, Escape close),
 *  - Mod-f really opens the TOP-pinned panel in a mounted editor, and Escape
 *    closes it (the editor keymap's own Escape binding — `simplifySelection`
 *    — must not shadow it),
 *  - the panel copy follows the plugin dictionary: it opens in the active
 *    language and re-resolves after a locale switch (the phrases facet is
 *    baked into the EditorState, so this proves the compartment
 *    reconfigure), while the editor's own Mod-s save binding still fires.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { cmSearchExtensions } from '../src/client/cm-search.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { attachLocale } from '../src/client/locales.ts'
import { api } from '../src/client/api.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face (live-switchable). */
class FakeLocale {
  active = 'zh'
  private readonly listeners = new Set<() => void>()

  getSnapshot(): { active: string } {
    return { active: this.active }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Switch the active locale and notify subscribers (the DSH live switch). */
  switchTo(id: string): void {
    this.active = id
    for (const listener of this.listeners) listener()
  }
}

let locale: FakeLocale

beforeEach(() => {
  locale = new FakeLocale()
  attachLocale(locale)
})

afterEach(() => {
  attachLocale(undefined)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

/** Mount the real editor for a plain-text file (the code viewer). */
function mountEditor(): { container: HTMLDivElement; unmount: () => void } {
  const props: FileViewerProps = {
    ctx: { locale, get: () => undefined } as unknown as FileViewerProps['ctx'],
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/hello.txt',
    title: 'hello.txt',
    viewerId: 'code',
    content: 'alpha\nbeta\nalpha\n',
  }
  return renderRoot(createElement(TextEditor, props))
}

/** Dispatch one keydown on `target` (jsdom is non-mac, so Mod = Ctrl). */
function press(target: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

/** The editor's content DOM (CodeMirror's keydown listener target). */
function contentOf(container: HTMLElement): Element {
  const content = container.querySelector('.cm-content')
  if (content === null) throw new Error('the mounted editor has no .cm-content')
  return content
}

/** The open search panel's search field (null while the panel is closed). */
function searchField(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('.cm-search input[name=search]')
}

describe('editor find-in-file (Cmd/Ctrl+F)', () => {
  it('carries the search extension and the upstream search keymap', () => {
    const state = EditorState.create({ doc: 'alpha', extensions: cmSearchExtensions() })
    const keys = state.facet(keymap).flatMap(bindings => bindings.map(binding => binding.key))
    // Open, next/previous, go-to-line, close — the upstream searchKeymap.
    expect(keys).toContain('Mod-f')
    expect(keys).toContain('Mod-g')
    expect(keys).toContain('Mod-Alt-g')
    expect(keys).toContain('Escape')
  })

  it('opens the top-pinned panel on Mod-f and closes it with Escape', () => {
    const { container, unmount } = mountEditor()
    expect(searchField(container), 'no panel before the shortcut').toBeNull()

    press(contentOf(container), 'f', { ctrlKey: true })
    const panel = container.querySelector('.cm-panels.cm-panels-top .cm-search')
    expect(panel, 'Mod-f must open the search panel pinned to the editor top').not.toBeNull()
    // The panel copy comes from the plugin dictionary (zh is the active one).
    expect(searchField(container)?.placeholder).toBe('查找')

    press(searchField(container)!, 'Escape')
    expect(searchField(container), 'Escape must close the panel').toBeNull()
    unmount()
  })

  it('keeps the editor\'s own Mod-s save binding working', () => {
    const write = vi.spyOn(api, 'fsWrite').mockResolvedValue({ ok: true })
    const { container, unmount } = mountEditor()

    press(contentOf(container), 's', { ctrlKey: true })
    expect(write, 'the editor keymap still owns Mod-s').toHaveBeenCalledTimes(1)
    unmount()
  })

  it('re-resolves the panel copy after a live locale switch', () => {
    const { container, unmount } = mountEditor()

    press(contentOf(container), 'f', { ctrlKey: true })
    expect(searchField(container)?.placeholder).toBe('查找')
    press(searchField(container)!, 'Escape')

    // The phrases facet is part of the EditorState: without the compartment
    // reconfigure the reopened panel would still show the old language.
    act(() => { locale.switchTo('en') })
    press(contentOf(container), 'f', { ctrlKey: true })
    expect(searchField(container)?.placeholder).toBe('Find')
    unmount()
  })
})
