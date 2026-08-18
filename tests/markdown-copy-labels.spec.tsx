/**
 * Markdown preview copy-label spec: the fence copy buttons ("复制" / "Copy")
 * must follow the DSH locale service through `codeLabels` — the DSH
 * MarkdownText/CodeBlock are cordis-free and fall back to HARDCODED Chinese
 * when the caller omits the labels, so TextEditor must pass its own
 * dictionary copy (`t('copy')` / `t('copied')`), re-evaluated per render.
 * The exact preview-content component used by TextEditor is rendered directly,
 * so Markdown can independently default to Visual mode without weakening this guard.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import './browser-globals.ts'
import { MarkdownPreviewContent } from '../src/client/TextEditor.tsx'
import { attachLocale } from '../src/client/locales.ts'

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

/** A markdown source with one fenced code block (the copy-button surface). */
const MD_WITH_FENCE = '```ts\nconst a = 1\n```'

function renderPreview(): string {
  return renderToString(createElement(MarkdownPreviewContent, { text: MD_WITH_FENCE, hasMermaid: false }))
}

afterEach(() => {
  attachLocale(undefined)
})

describe('markdown preview code-block copy labels (DSH i18n following)', () => {
  it('renders the fence copy button with the zh dictionary label by default', () => {
    const locale = new FakeLocale()
    locale.active = 'zh'
    attachLocale(locale)
    const html = renderPreview()
    expect(html).toContain('复制')
    expect(html).not.toContain('Copy')
  })

  it('follows the attached locale service live: en renders "Copy" instead of the zh label', () => {
    const locale = new FakeLocale()
    locale.active = 'en'
    attachLocale(locale)
    const html = renderPreview()
    expect(html).toContain('Copy')
    expect(html).not.toContain('复制')
  })
})
