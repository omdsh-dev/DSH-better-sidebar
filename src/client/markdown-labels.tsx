/**
 * Copy-button / chrome labels for DSH's shared `MarkdownText` (DSH
 * 0.1.2-alpha contract): the renderer takes a REQUIRED nested `labels` prop
 * — `labels.code.copyLabel` / `labels.code.copiedLabel` for the fence copy
 * buttons plus a screen-reader-only `labels.footnotes` heading — and the
 * MarkdownText/CodeBlock are cordis-free, falling back to HARDCODED Chinese
 * when the labels are omitted, so every render site threads the plugin
 * dictionary's localized pair through here (re-evaluated per render).
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

/** MarkdownText props carrying the nested chrome labels. */
export function markdownTextProps(text: string, labels: MarkdownCopyLabels): ComponentProps<typeof MarkdownText> {
  return {
    text,
    labels: {
      code: { copyLabel: labels.copyLabel, copiedLabel: labels.copiedLabel },
      footnotes: '',
    },
  }
}
