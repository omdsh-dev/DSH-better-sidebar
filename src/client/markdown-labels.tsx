/**
 * Chrome labels for DSH's shared `MarkdownText` (DSH
 * 0.1.2-alpha contract): the renderer takes a REQUIRED nested `labels` prop
 * — `labels.code.copyLabel` / `labels.code.copiedLabel` for the fence copy
 * buttons plus a screen-reader-only `labels.footnotes` heading — and the
 * MarkdownText/CodeBlock are cordis-free, falling back to HARDCODED Chinese
 * when the labels are omitted, so every render site threads the plugin
 * dictionary's localized pair through here.
 * `footnotes` is left empty (the heading is sr-only; give it a real string
 * only if a locale key ever earns its place in all 19 dictionaries).
 *
 * The nested object is built ONCE per distinct set of label VALUES
 * ({@link cachedLabels}): `MarkdownText` is memoized on the `labels` identity
 * (its streaming render cache is dropped when the identity changes), so a
 * fresh object per render re-parsed every markdown row on every parent
 * re-render — a composer keystroke or one streaming push. Callers pass a
 * plain value bag and may build that bag inline; identity is never the key.
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

/** The nested `labels` prop the host renderer takes. */
type HostMarkdownLabels = ComponentProps<typeof MarkdownText>['labels']

/**
 * How many distinct label sets the identity cache keeps. The plugin renders
 * one label set per locale revision (zh/en plus the better-locale override,
 * and one per mounted view), so this is far above the real cardinality; the
 * bound only keeps a pathological caller from growing the map forever.
 */
const LABELS_CACHE_CAP = 32

/**
 * Identity-stable nested label objects, keyed by the five label VALUES.
 *
 * A `Map` (not a `WeakMap`) on purpose: callers build their `MarkdownCopyLabels`
 * bag inline on every render, so object identity is worthless as a key —
 * only the rendered strings are. Every entry is a pure function of its key,
 * so eviction costs a rebuild, never a wrong label.
 */
const labelsCache = new Map<string, HostMarkdownLabels>()

/** The nested host `labels` for one label-value set, shared across renders. */
function cachedLabels(labels: MarkdownCopyLabels): HostMarkdownLabels {
  // JSON keeps the five fields unambiguously separated: a separator character
  // would collide with label text that contains it.
  const key = JSON.stringify([labels.copyLabel, labels.copiedLabel, labels.codeLabel, labels.wrapLabel, labels.unwrapLabel])
  const cached = labelsCache.get(key)
  if (cached !== undefined) return cached
  const built: HostMarkdownLabels = {
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
  }
  if (labelsCache.size >= LABELS_CACHE_CAP) {
    const oldest = labelsCache.keys().next()
    if (oldest.done !== true) labelsCache.delete(oldest.value)
  }
  labelsCache.set(key, built)
  return built
}

/** MarkdownText props carrying the nested chrome labels. */
export function markdownTextProps(text: string, labels: MarkdownCopyLabels): ComponentProps<typeof MarkdownText> {
  return {
    text,
    labels: cachedLabels(labels),
  }
}
