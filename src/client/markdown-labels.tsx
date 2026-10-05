/**
 * Chrome labels for DSH's shared `MarkdownText` (DSH
 * 0.1.2-alpha contract): the renderer takes a REQUIRED nested `labels` prop
 * — `labels.code.copyLabel` / `labels.code.copiedLabel` for the fence copy
 * buttons plus a screen-reader-only `labels.footnotes` heading — and the
 * MarkdownText/CodeBlock are cordis-free, falling back to HARDCODED Chinese
 * when the labels are omitted, so every render site threads the plugin
 * dictionary's localized pair through here (re-evaluated per render).
 * `footnotes` is left empty (the heading is sr-only; give it a real string
 * only if a locale key ever earns its place in all 19 dictionaries).
 *
 * DSH 0.1.7-rc.1 added `labels.code.toolbarLabels` (language name + wrap
 * toggle + copy). Supplying it is what swaps the legacy info-string banner for
 * the host's code card, and the three strings are REQUIRED once supplied, so
 * every site that builds the flat pair has to carry them too — the code card
 * must look the same in the transcript, the diff card and the editor preview as
 * it does in DSH's own chat.
 */
import type { ComponentProps } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

/** The code-card chrome the plugin threads through its own props (e.g.
 *  MermaidMarkdownProps.codeLabels — the chunk contract carries the same
 *  fields). */
export interface MarkdownCopyLabels {
  copyLabel: string
  copiedLabel: string
  /** Code-card title for an absent or unsupported language. */
  codeLabel: string
  /** Code-card action that enables wrapping. */
  wrapLabel: string
  /** Code-card action that preserves source columns with horizontal scrolling. */
  unwrapLabel: string
}

/** MarkdownText props carrying the nested chrome labels. */
export function markdownTextProps(text: string, labels: MarkdownCopyLabels): ComponentProps<typeof MarkdownText> {
  return {
    text,
    labels: {
      code: {
        copyLabel: labels.copyLabel,
        copiedLabel: labels.copiedLabel,
        toolbarLabels: {
          codeLabel: labels.codeLabel,
          wrapLabel: labels.wrapLabel,
          unwrapLabel: labels.unwrapLabel,
        },
      },
      footnotes: '',
    },
  }
}
