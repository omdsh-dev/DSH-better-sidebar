/**
 * Mermaid diagram renderer for the markdown preview, resident in the
 * `mermaid` lazy chunk (src/client/chunks/mermaid.tsx): the mermaid library
 * and its transitive graph deps (d3/dagre/cytoscape) are inlined into
 * lib/client-mermaid.js and fetched only when a previewed markdown file
 * actually contains a mermaid fence (see mermaid-blocks.ts).
 *
 * Rendering is client-side: mermaid.render → sanitized SVG injected into
 * the block. `bindFunctions` is intentionally NOT applied (static diagrams;
 * no flowchart click handlers), `securityLevel` stays 'strict' (labels are
 * escaped, no raw-HTML foreignObject), and the emitted SVG is re-sanitized
 * (foreignObject stripped, @-prefixed/on* attributes removed) before it
 * reaches dangerouslySetInnerHTML.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { IconCopyOutline16, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { t } from './locales.ts'
import type { MdBlock, MermaidBlocksProps } from './mermaid-blocks.ts'
import css from './sidebar.module.css'

/** Monotonic id seed: every render call gets a fresh, document-unique id. */
let mermaidSeq = 0

/** Configure mermaid for the current color scheme (idempotent). */
function configureMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // Labels as real SVG <text>: mermaid's default htmlLabels renders node
    // text inside <foreignObject>, which the sanitizer strips wholesale —
    // forcing pure SVG text keeps labels visible and the HTML label channel
    // closed (strict already escapes label content).
    htmlLabels: false,
    theme: isDarkScheme() ? 'dark' : 'default',
  })
}

/** Strip foreignObject and interactive/event attributes from rendered SVG. */
function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  doc.querySelectorAll('foreignObject').forEach((node) => { node.remove() })
  doc.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.startsWith('@') || attribute.name.startsWith('on')) {
        node.removeAttribute(attribute.name)
      }
    }
  })
  return new XMLSerializer().serializeToString(doc.documentElement)
}

/** First lines of a mermaid error (its dumps are huge; the head explains). */
function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').slice(0, 6).join('\n')
}

/** One rendered mermaid fence: header chrome + diagram (or error + source). */
function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Scheme state: a flip re-renders the diagram with the matching theme. */
  const [dark, setDark] = useState(() => isDarkScheme())
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    if (code.trim() === '') return () => { cancelled = true }
    configureMermaid()
    const id = `dsh-md-mermaid-${mermaidSeq += 1}`
    mermaid.render(id, code)
      .then(({ svg: rendered }) => {
        if (cancelled) return
        setSvg(sanitizeSvg(rendered))
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(summarizeError(reason))
      })
    return () => { cancelled = true }
  }, [code, dark])

  const onCopy = useCallback(() => {
    if (copied) return
    writeClipboard(code).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [code, copied])

  return (
    <div className={css.mermaidWrap}>
      <div className={css.mermaidHeader}>
        <span className={css.mermaidInfo}>mermaid</span>
        <button
          type="button"
          className={css.mermaidCopy}
          onClick={onCopy}
          aria-label={t('copy')}
          title={t('copy')}
        >
          <IconCopyOutline16 />
          <span>{copied ? t('copied') : t('copy')}</span>
        </button>
      </div>
      {error !== null && <div className={css.mermaidError} title={error}>{t('mermaidError')}</div>}
      {svg !== null && (
        <div
          className={css.mermaidBody}
          data-mermaid-diagram
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {error !== null && <pre className={css.mermaidCode}><code>{code}</code></pre>}
    </div>
  )
}

/**
 * The chunk-resident markdown preview renderer: interleaves plain markdown
 * spans (through the DSH MarkdownText renderer) with rendered mermaid
 * diagrams, preserving the source order. Only mounted when the source
 * contains at least one mermaid fence (see TextEditor.tsx).
 */
export function MermaidBlocks({ blocks, codeLabels }: MermaidBlocksProps) {
  return (
    <>
      {blocks.map((block: MdBlock, index: number) => (
        block.kind === 'mermaid'
          ? <MermaidDiagram key={index} code={block.code} />
          : <MarkdownText key={index} text={block.text} codeLabels={codeLabels} />
      ))}
    </>
  )
}
