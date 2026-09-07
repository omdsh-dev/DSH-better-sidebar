/**
 * Markdown preview copy-label spec: the fence copy buttons ("复制" / "Copy")
 * must follow the DSH locale service through `codeLabels` — the DSH
 * MarkdownText/CodeBlock are cordis-free and fall back to HARDCODED Chinese
 * when the caller omits the labels, so TextEditor must pass its own
 * dictionary copy (`t('copy')` / `t('copied')`), re-evaluated per render.
 * Rendered with renderToString (the initial preview mode never mounts
 * CodeMirror, so no DOM/effects are needed).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import './browser-globals.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { attachLocale } from '../src/client/locales.ts'
import type { FileViewerProps } from '../src/client/service.ts'

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'zh'
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

/** A markdown source with one fenced code block (the copy-button surface). */
const MD_WITH_FENCE = '```ts\nconst a = 1\n```'

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a/README.md',
    title: 'README.md',
    viewerId: 'markdown',
    content: MD_WITH_FENCE,
    ...overrides,
  }
}

afterEach(() => {
  attachLocale(undefined)
})

describe('markdown preview code-block copy labels (DSH i18n following)', () => {
  it('renders the fence copy button with the zh dictionary label by default', () => {
    const locale = new FakeLocale()
    locale.active = 'zh'
    attachLocale(locale)
    const html = renderToString(createElement(TextEditor, viewerProps()))
    expect(html).toContain('复制')
    expect(html).not.toContain('Copy')
  })

  it('follows the attached locale service live: en renders "Copy" instead of the zh label', () => {
    const locale = new FakeLocale()
    locale.active = 'en'
    attachLocale(locale)
    const html = renderToString(createElement(TextEditor, viewerProps()))
    expect(html).toContain('Copy')
    expect(html).not.toContain('复制')
  })

  it('renders an authorized external Markdown document without edit/save controls', () => {
    const locale = new FakeLocale()
    locale.active = 'en'
    attachLocale(locale)
    const html = renderToString(createElement(TextEditor, viewerProps({
      content: '# External report',
      readOnly: true,
    })))
    expect(html).toContain('External report')
    expect(html).not.toContain('>Edit<')
    expect(html).not.toContain('aria-label="Save"')
  })
})
