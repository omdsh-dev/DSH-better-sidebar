/**
 * Copy-button / chrome labels for DSH's shared `MarkdownText` (DSH
 * 0.1.2-alpha contract): the renderer takes a REQUIRED nested `labels` prop
 * — `labels.code.copyLabel` / `labels.code.copiedLabel` for the fence copy
 * buttons plus a screen-reader-only `labels.footnotes` heading — and the
 * MarkdownText/CodeBlock are cordis-free, falling back to HARDCODED Chinese
 * when the labels are omitted, so every render site threads the plugin
 * dictionary's localized pair through here. The VALUES are read per render (a
 * locale switch follows); the object handed downstream is reused while they do
 * not change — see the cache below.
 * `footnotes` is left empty (the heading is sr-only; give it a real string
 * only if a locale key ever earns its place in all 19 dictionaries).
 */
import type { ComponentProps } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

/** The flat copy-button pair the plugin threads through its own props (e.g.
 *  MermaidMarkdownProps.codeLabels — the chunk contract stays put). */
export interface MarkdownCopyLabels {
  copyLabel: string
  copiedLabel: string
}

/**
 * The nested chrome object, cached by VALUE.
 *
 * Every call site builds its props fresh, so this helper used to hand
 * `MarkdownText` a new `labels` identity on every render. That component is a
 * plain `memo`, so its identity is exactly what decides whether the body — and
 * the micromark/KaTeX parse behind it — runs again: a caller polling on a
 * timer re-parsed whole documents per tick without one character changing.
 * Keying on the values keeps the locale behaviour and gives the renderer a
 * stable identity to compare.
 *
 * The cached objects are shared and must never be mutated. The key space is
 * the shipped dictionaries, so the cap only ever trims after a locale churn.
 */
const chromeCache = new Map<string, ComponentProps<typeof MarkdownText>['labels']>()

/** MarkdownText props carrying the nested chrome labels. */
export function markdownTextProps(text: string, labels: MarkdownCopyLabels): ComponentProps<typeof MarkdownText> {
  // JSON, not a joined string: translations contain spaces, and a collision
  // would render another locale's copy-button text.
  const key = JSON.stringify([labels.copyLabel, labels.copiedLabel])
  let chrome = chromeCache.get(key)
  if (chrome === undefined) {
    chrome = Object.freeze({
      code: { copyLabel: labels.copyLabel, copiedLabel: labels.copiedLabel },
      footnotes: '',
    })
    if (chromeCache.size >= 8) chromeCache.clear()
    chromeCache.set(key, chrome)
  }
  return { text, labels: chrome }
}
