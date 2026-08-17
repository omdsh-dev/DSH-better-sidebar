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
 * escaped, no raw-HTML foreignObject), `htmlLabels: false` keeps node text
 * as real SVG <text>, and the emitted SVG is re-sanitized (see
 * mermaid-sanitize.ts) before it reaches dangerouslySetInnerHTML. Clicking
 * a rendered diagram opens a zoom/pan modal (borrowed interaction design
 * from the mermaid PR #75, reimplemented on top of the sanitized SVG —
 * the clone carries no event surface, so the modal adds no attack surface).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import mermaid from 'mermaid'
import { IconCopyOutline16, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { t } from './locales.ts'
import { sanitizeSvg } from './mermaid-sanitize.ts'
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

/** First lines of a mermaid error (its dumps are huge; the head explains). */
function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').slice(0, 6).join('\n')
}

/** The zoom/pan modal for one rendered diagram (click-to-enlarge). */
function MermaidZoomModal({ svg, onClose }: { svg: SVGSVGElement; onClose: () => void }): React.ReactNode {
  const overlayRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef({ active: false, startX: 0, startY: 0 })
  const zoomRef = useRef({ scale: 1, tx: 0, ty: 0 })

  const applyTransform = (): void => {
    const node = svgRef.current
    if (node === null) return
    const { scale, tx, ty } = zoomRef.current
    node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  /** Zoom by `delta` keeping the stage point (centerX/centerY) fixed. */
  const zoom = useCallback((delta: number, centerX?: number, centerY?: number): void => {
    const stage = stageRef.current
    if (stage === null) return
    const rect = stage.getBoundingClientRect()
    const cx = centerX ?? rect.width / 2
    const cy = centerY ?? rect.height / 2
    const current = zoomRef.current
    const newScale = Math.min(8, Math.max(0.2, current.scale * delta))
    // The svg is flex-centered in the stage, so its center sits at
    // (rect.width/2, rect.height/2). Solve for the translate that keeps the
    // mouse point stationary in stage coordinates across the scale change.
    const sx = rect.width / 2
    const sy = rect.height / 2
    const ratio = newScale / current.scale
    current.tx = cx - sx - (cx - sx - current.tx) * ratio
    current.ty = cy - sy - (cy - sy - current.ty) * ratio
    current.scale = newScale
    applyTransform()
  }, [])

  const reset = useCallback((): void => {
    zoomRef.current = { scale: 1, tx: 0, ty: 0 }
    applyTransform()
  }, [])

  const close = useCallback((): void => { onClose() }, [onClose])

  // Mount the caller-provided (sanitized) svg clone imperatively: React
  // types don't accept a raw DOM node as a child, and the modal owns the
  // node's lifetime (removed on unmount; the preview copy is untouched).
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    svgRef.current = svg
    stage.appendChild(svg)
    return () => {
      svg.remove()
      svgRef.current = null
    }
  }, [svg])

  useEffect(() => {
    const stage = stageRef.current
    const node = svgRef.current
    const overlay = overlayRef.current
    if (stage === null || node === null || overlay === null) return

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { close(); return }
      if (event.key === '+' || event.key === '=') zoom(1.2)
      else if (event.key === '-') zoom(1 / 1.2)
      else if (event.key === '0') reset()
    }
    const onMouseDown = (event: MouseEvent): void => {
      event.preventDefault()
      dragRef.current = {
        active: true,
        startX: event.clientX - zoomRef.current.tx,
        startY: event.clientY - zoomRef.current.ty,
      }
    }
    const onMouseMove = (event: MouseEvent): void => {
      if (!dragRef.current.active) return
      zoomRef.current.tx = event.clientX - dragRef.current.startX
      zoomRef.current.ty = event.clientY - dragRef.current.startY
      applyTransform()
    }
    const onMouseUp = (): void => { dragRef.current.active = false }
    const onOverlayClick = (event: MouseEvent): void => {
      if (event.target === overlay) close()
    }

    // React's synthetic wheel is passive; a native listener is required to
    // preventDefault (the page must not scroll while zooming the modal).
    stage.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKey)
    overlay.addEventListener('click', onOverlayClick)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      node.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKey)
      overlay.removeEventListener('click', onOverlayClick)
    }
  }, [zoom, reset, close])

  return createPortal(
    <div className={css.mermaidModal} data-mermaid-modal ref={overlayRef}>
      <div className={css.mermaidModalToolbar}>
        <button
          type="button"
          className={css.mermaidModalButton}
          title={t('mermaidZoomOut')}
          onClick={() => zoom(1 / 1.2)}
        >
          −
        </button>
        <button
          type="button"
          className={css.mermaidModalButton}
          title={t('mermaidZoomIn')}
          onClick={() => zoom(1.2)}
        >
          +
        </button>
        <button
          type="button"
          className={css.mermaidModalButton}
          title={t('mermaidZoomReset')}
          onClick={reset}
        >
          ⟳
        </button>
        <button
          type="button"
          className={css.mermaidModalButton}
          title={t('close')}
          onClick={close}
        >
          ✕
        </button>
      </div>
      <div className={css.mermaidModalStage} ref={stageRef} />
      <div className={css.mermaidModalHint}>{t('mermaidZoomHint')}</div>
    </div>,
    document.body,
  )
}

/** One rendered mermaid fence: header chrome + diagram (or error + source). */
function MermaidDiagram({ code }: { code: string }): React.ReactNode {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Scheme state: a flip re-renders the diagram with the matching theme. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The cloned svg shown in the zoom modal (null = closed). */
  const [zoomSvg, setZoomSvg] = useState<SVGSVGElement | null>(null)
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
        const clean = sanitizeSvg(rendered)
        if (clean === '') {
          // Parse/sanitize rejection: never pass the raw string through.
          setError(t('mermaidError'))
          return
        }
        setSvg(clean)
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

  /** Clicking the diagram opens the zoom modal with a sanitized clone. */
  const onBodyClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const svgEl = (event.target as Element).closest('svg')
    if (svgEl === null) return
    const clone = svgEl.cloneNode(true) as SVGSVGElement
    // The modal owns sizing/transform; drop the preview's inline geometry.
    clone.removeAttribute('style')
    clone.removeAttribute('width')
    clone.removeAttribute('height')
    setZoomSvg(clone)
  }

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
          onClick={onBodyClick}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {error !== null && <pre className={css.mermaidCode}><code>{code}</code></pre>}
      {zoomSvg !== null && <MermaidZoomModal svg={zoomSvg} onClose={() => { setZoomSvg(null) }} />}
    </div>
  )
}

/**
 * The chunk-resident markdown preview renderer: interleaves plain markdown
 * spans (through the DSH MarkdownText renderer) with rendered mermaid
 * diagrams, preserving the source order. Only mounted when the source
 * contains at least one mermaid fence (see TextEditor.tsx).
 */
export function MermaidBlocks({ blocks, codeLabels }: MermaidBlocksProps): React.ReactNode {
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
