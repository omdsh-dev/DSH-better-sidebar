/**
 * Truncated-read save protection (#732): a text load truncated at readLimit
 * only carries the file's first bytes, so the editor must not offer a save
 * surface for it — the truncation banner shows in every mode and the save
 * button stays out of the editor's own toolbar until a full read replaces
 * the content.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import './browser-globals.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { attachLocale } from '../src/client/locales.ts'
import type { FileViewerProps } from '../src/client/service.ts'

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): () => void {
    return () => {}
  }
}

const CTX = {} as Parameters<typeof TextEditor>[0]['ctx']

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/big.json',
    title: 'big.json',
    viewerId: 'code',
    content: '{"head": "…"}',
    ...overrides,
  }
}

afterEach(() => {
  attachLocale(undefined)
})

describe('TextEditor truncated-read save protection (#732)', () => {
  it('shows the truncation banner and no save button for a truncated load', () => {
    attachLocale(new FakeLocale())
    const html = renderToString(createElement(TextEditor, viewerProps({ truncated: true })))
    expect(html).toContain('File too large')
    expect(html).not.toContain('aria-label="Save"')
  })

  it('keeps the save button for a full (non-truncated) load', () => {
    attachLocale(new FakeLocale())
    const html = renderToString(createElement(TextEditor, viewerProps()))
    expect(html).toContain('aria-label="Save"')
  })
})
