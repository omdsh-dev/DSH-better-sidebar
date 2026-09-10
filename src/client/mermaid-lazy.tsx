/**
 * The chunk-resident markdown renderer (mermaid lazy chunk): a light stub
 * module so core-bundle consumers (the changes tab's reading mode) can mount
 * the mermaid-aware renderer without statically pulling MarkdownHtml's
 * DOMPurify/HTML-analysis machinery into the core bundle. The chunk itself
 * (src/client/chunks/mermaid) loads on first render via /sidebar/bundle.
 */
import type { ComponentType } from 'react'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import type { MermaidMarkdownProps } from './mermaid-blocks.ts'

/** Shared with the legacy no-HTML preview path in TextEditor (re-exported). */
export const LazyMermaidMarkdown = lazyChunkComponent<MermaidMarkdownProps>(
  'mermaid',
  (mod) => mod.MermaidMarkdown as ComponentType<MermaidMarkdownProps> | undefined,
)
