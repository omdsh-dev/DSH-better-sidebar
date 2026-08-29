/**
 * Copy-button / chrome labels for DSH's shared `MarkdownText`, shaped for
 * BOTH prop generations the plugin supports:
 *
 * - 0.1.1-rc.x: optional flat prop `codeLabels` — the renderer reads
 *   `labels.copyLabel` / `labels.copiedLabel` directly.
 * - 0.1.2-alpha.1+: renamed to a REQUIRED `labels` prop with a nested shape
 *   (`labels.code.copyLabel` + a screen-reader-only `labels.footnotes`
 *   heading). Passing only the old prop crashes the fence render with
 *   "Cannot read properties of undefined (reading 'code')" — the exact
 *   regression the mount lane caught on a real 0.1.2-alpha.1 host.
 *
 * The union object satisfies both readers, and {@link markdownTextProps}
 * passes it under BOTH prop names — each host ignores the one it does not
 * know. `footnotes` is left empty (the heading is sr-only; give it a real
 * string only if a locale key ever earns its place in all 19 dictionaries).
 */
import type { ComponentProps } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

/** The flat copy-button pair the plugin threads through its own props
 *  (e.g. MermaidMarkdownProps.codeLabels — the chunk contract stays put). */
export interface MarkdownCopyLabels {
  copyLabel: string
  copiedLabel: string
}

/** The dual-generation chrome labels object (see module doc). */
export interface MarkdownChromeLabels extends MarkdownCopyLabels {
  /** 0.1.2-alpha.1+ nested reads. */
  code: MarkdownCopyLabels
  /** 0.1.2-alpha.1+ sr-only footnotes heading. */
  footnotes: string
}

/** Build the dual-shape chrome labels from a flat copy-button pair. */
export function markdownChromeLabels(labels: MarkdownCopyLabels): MarkdownChromeLabels {
  return {
    copyLabel: labels.copyLabel,
    copiedLabel: labels.copiedLabel,
    code: { copyLabel: labels.copyLabel, copiedLabel: labels.copiedLabel },
    footnotes: '',
  }
}

/** MarkdownText props carrying the labels under BOTH prop names. The cast is
 *  load-bearing: the plugin builds against the 0.1.1-rc.x declaration, where
 *  `labels` does not exist yet (and vice versa on a 0.1.2-alpha.1+ host). */
export function markdownTextProps(text: string, labels: MarkdownCopyLabels): ComponentProps<typeof MarkdownText> {
  const chrome = markdownChromeLabels(labels)
  return { text, codeLabels: chrome, labels: chrome } as unknown as ComponentProps<typeof MarkdownText>
}
