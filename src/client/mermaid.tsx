/**
 * Mermaid diagram renderer for the markdown preview, resident in the
 * `mermaid` lazy chunk (src/client/chunks/mermaid.tsx): the mermaid library
 * and its transitive graph deps (d3/dagre/cytoscape) are inlined into
 * lib/client-mermaid.js and fetched only when a previewed markdown file
 * actually contains a mermaid fence (see mermaid-blocks.ts).
 *
 * Rendering architecture: the whole document is rendered ONCE through the
 * DSH `MarkdownText` (so cross-fence semantics — reference-style links,
 * footnotes, ordered-list continuity — stay intact), then a layout effect
 * swaps every rendered `language-mermaid` CodeBlock for a diagram. The
 * swap keeps the React-managed `.md-code-block` host node in the tree and
 * only replaces its children (display:contents suppresses the code-block
 * chrome), so React reconciliation never loses the host; when a swapped
 * block stops being a mermaid fence, the original children are restored.
 *
 * Security: mermaid.render → sanitized SVG injected into the block.
 * `bindFunctions` is intentionally NOT applied (static diagrams; no
 * flowchart click handlers), `securityLevel` stays 'strict' (labels are
 * escaped, no raw-HTML foreignObject), `htmlLabels: false` keeps node text
 * as real SVG <text>, and the emitted SVG is re-sanitized (see
 * mermaid-sanitize.ts) before it reaches dangerouslySetInnerHTML. Clicking
 * a rendered diagram opens a zoom/pan modal (borrowed interaction design
 * from the mermaid PR #75, reimplemented on top of the sanitized SVG —
 * the clone carries no event surface, so the modal adds no attack surface).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { IconCopyOutlineRegular, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { markdownTextProps } from './markdown-labels.tsx'
import { t } from './locales.ts'
import { sanitizeSvg } from './mermaid-sanitize.ts'
import type { MermaidMarkdownProps } from './mermaid-blocks.ts'
import { splitMermaidBlocks } from './mermaid-blocks.ts'
import { renderMermaidDiagram, type MermaidTheme } from './mermaid-frame.ts'
import css from './sidebar.module.css'

/** Render queue priorities: a diagram the reader can see goes first, the rest
 * render while the browser is idle. */
type MermaidPriority = 0 | 1

/** One mounted preview's visibility. Background diagrams of a hidden preview
 *  (parked tab, collapsed dock) must not warm-render: they would spend CPU on
 *  content nobody can see and make the visible document's scrolling compete
 *  with diagrams from other tabs. */
interface MermaidPreviewHandle {
  visible: boolean
  wake: () => void
}

interface MermaidTask {
  priority: MermaidPriority
  run: () => Promise<void>
  /** The preview this render belongs to. */
  owner: MermaidPreviewHandle
}

/** Pending renders, shared by every mounted preview on the page. */
const mermaidQueue: MermaidTask[] = []
let mermaidPumping = false
/** Incremented when a test tears the queue down; a drain loop from an older
 * epoch stops at its next await instead of driving the fresh queue. */
let mermaidQueueEpoch = 0

/** How long after the last scroll event background rendering stays paused.
 *  Scrolling must not compete with diagram layout for the main thread. */
const SCROLL_QUIET_MS = 350
/** Timestamp of the most recent captured scroll event on the page. */
let lastScrollAt = 0
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => { lastScrollAt = performance.now() }, { capture: true, passive: true })
}

/** Resolve once the page has stopped scrolling for {@link SCROLL_QUIET_MS}. */
async function waitForScrollQuiet(): Promise<void> {
  while (performance.now() - lastScrollAt < SCROLL_QUIET_MS) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 120) })
  }
}

/** Register one preview's visibility gate (see {@link MermaidPreviewHandle}). */
function createPreviewHandle(): MermaidPreviewHandle {
  return {
    visible: true,
    wake: () => { void drainMermaidQueue() },
  }
}

/** Drop queued renders that belong to a preview that is going away. */
function dropPreviewTasks(handle: MermaidPreviewHandle): void {
  for (let index = mermaidQueue.length - 1; index >= 0; index -= 1) {
    const task = mermaidQueue[index]
    if (task !== undefined && task.owner === handle) mermaidQueue.splice(index, 1)
  }
}

/** Drop every queued render and detach the current drain loop (test seam:
 * module state persists across specs in one vitest file). */
export function resetMermaidRenderQueueForTests(): void {
  mermaidQueueEpoch += 1
  mermaidQueue.length = 0
  mermaidPumping = false
  lastScrollAt = 0
}

/** Run a callback once the main thread is idle (bounded, so diagrams cannot
 * starve forever while the page stays busy). */
function whenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { callback() }, { timeout: 400 })
    return
  }
  setTimeout(callback, 0)
}

/**
 * Drain the render queue one diagram at a time.
 *
 * Rendering every fence of a document in one commit (the behaviour this
 * replaced) could hold the main thread for minutes on diagram-heavy documents
 * — long enough for the desktop shell's surface watchdog to declare the page
 * unresponsive and kill it. The queue interleaves a visible diagram ahead of
 * the background ones, gives the browser (input, layout, the watchdog's probe)
 * a turn between two renders, and yields entirely while the reader is
 * scrolling or while a preview is off screen — so a document with dozens of
 * diagrams stays scrollable and every diagram still ends up rendered.
 */
async function drainMermaidQueue(): Promise<void> {
  if (mermaidPumping) return
  mermaidPumping = true
  const epoch = mermaidQueueEpoch
  try {
    while (epoch === mermaidQueueEpoch) {
      mermaidQueue.sort((a, b) => a.priority - b.priority)
      // Hidden previews keep their diagrams queued, not rendered: the visible
      // document owns the main thread until its own diagrams are warm.
      const runnable = mermaidQueue.findIndex((task) => task.owner.visible)
      if (runnable === -1) break
      const [task] = mermaidQueue.splice(runnable, 1)
      if (task === undefined) break
      if (task.priority > 0) await waitForScrollQuiet()
      await new Promise<void>((resolve) => { whenIdle(resolve) })
      if (epoch !== mermaidQueueEpoch) break
      try {
        await task.run()
      } catch (error) {
        // One broken fence must not stall the queue behind it.
        console.error('[dsh-better-sidebar] mermaid render failed', error)
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 16) })
    }
  } finally {
    if (epoch === mermaidQueueEpoch) mermaidPumping = false
  }
}

/** Queue one diagram render; {@link drainMermaidQueue} runs it. */
function pushMermaidTask(priority: MermaidPriority, run: () => Promise<void>, owner: MermaidPreviewHandle): void {
  mermaidQueue.push({ priority, run, owner })
  void drainMermaidQueue()
}

/** True when the block is at most about one viewport away from the visible
 *  area. A mounted-but-hidden body (parked tab, closed drawer) has a zero box;
 *  it is treated as off-screen so its diagrams take the idle path. */
function isNearViewportRect(rect: DOMRect): boolean {
  if (rect.width === 0 && rect.height === 0) return false
  const margin = window.innerHeight * 1.25
  return rect.bottom > -margin && rect.top < window.innerHeight + margin
}

/** Rough first-paint height for the placeholder, derived from the fence's line
 * count. Reserving some height keeps the article from jumping under the
 * reader's cursor when the diagram arrives. */
function placeholderHeight(code: string): number {
  const lines = code.split('\n').length
  return Math.min(480, Math.max(120, lines * 14))
}

/** First lines of a mermaid error (its dumps are huge; the head explains). */
function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').slice(0, 6).join('\n')
}

/** The svg's own LAYOUT box, measured with any transform lifted off it (a
 *  transform would return the visual box and a scale-1 measure is what
 *  framing needs). The modal is the only writer of that style, so
 *  save/restore is safe. */
function measureSvgLayout(node: SVGSVGElement): { width: number; height: number } {
  const previous = node.style.transform
  node.style.transform = 'none'
  const rect = node.getBoundingClientRect()
  node.style.transform = previous
  return { width: rect.width, height: rect.height }
}

/** The zoom/pan modal for one rendered diagram (click-to-enlarge). */
function MermaidZoomModal({ svg, onClose }: { svg: SVGSVGElement; onClose: () => void }): React.ReactNode {
  const overlayRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef({ active: false, startX: 0, startY: 0 })
  const zoomRef = useRef({ scale: 1, tx: 0, ty: 0 })
  /** The scale that shows the whole diagram; `reset` returns to it. */
  const fitRef = useRef(1)

  const applyTransform = (): void => {
    const node = svgRef.current
    if (node === null) return
    const { scale, tx, ty } = zoomRef.current
    node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  /** Frame the whole diagram (never upscaled past 1:1), centered. */
  const applyFit = useCallback((): void => {
    const viewport = viewportRef.current
    const node = svgRef.current
    let scale = 1
    if (viewport !== null && node !== null) {
      const box = viewport.getBoundingClientRect()
      const { width, height } = measureSvgLayout(node)
      if (box.width > 0 && box.height > 0 && width > 0 && height > 0) {
        scale = Math.min(1, box.width / width, box.height / height)
      }
    }
    const clamped = Math.min(8, Math.max(0.2, scale))
    fitRef.current = clamped
    zoomRef.current = { scale: clamped, tx: 0, ty: 0 }
    applyTransform()
  }, [])

  /** Zoom by `delta` keeping the viewport point (centerX/centerY) fixed. */
  const zoom = useCallback((delta: number, centerX?: number, centerY?: number): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    const cx = centerX ?? rect.width / 2
    const cy = centerY ?? rect.height / 2
    const current = zoomRef.current
    const newScale = Math.min(8, Math.max(0.2, current.scale * delta))
    // The svg is flex-centered in the viewport, so its center sits at
    // (rect.width/2, rect.height/2). Solve for the translate that keeps the
    // mouse point stationary in viewport coordinates across the scale change.
    const sx = rect.width / 2
    const sy = rect.height / 2
    const ratio = newScale / current.scale
    current.tx = cx - sx - (cx - sx - current.tx) * ratio
    current.ty = cy - sy - (cy - sy - current.ty) * ratio
    current.scale = newScale
    applyTransform()
  }, [])

  /** Back to the framed view the modal opened with. */
  const reset = useCallback((): void => {
    zoomRef.current = { scale: fitRef.current, tx: 0, ty: 0 }
    applyTransform()
  }, [])

  const close = useCallback((): void => { onClose() }, [onClose])

  // Mount the caller-provided (sanitized) svg clone imperatively: React
  // types don't accept a raw DOM node as a child, and the modal owns the
  // node's lifetime (removed on unmount; the preview copy is untouched).
  // Framing happens here, after the append, because it needs the svg's laid
  // out box: `getBoundingClientRect()` forces the layout the measure needs.
  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    svgRef.current = svg
    viewport.appendChild(svg)
    applyFit()
    return () => {
      svg.remove()
      svgRef.current = null
    }
  }, [svg, applyFit])

  useEffect(() => {
    const stage = stageRef.current
    const viewport = viewportRef.current
    const overlay = overlayRef.current
    if (stage === null || viewport === null || overlay === null) return

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
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
    // The wheel rides the whole stage (the padding ring zooms too), the drag
    // rides the viewport (so the empty white area pans as well).
    stage.addEventListener('wheel', onWheel, { passive: false })
    viewport.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKey)
    overlay.addEventListener('click', onOverlayClick)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('mousedown', onMouseDown)
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
      <div className={css.mermaidModalStage} ref={stageRef}>
        <div className={css.mermaidViewport} data-mermaid-viewport ref={viewportRef} />
      </div>
      <div className={css.mermaidModalHint}>{t('mermaidZoomHint')}</div>
    </div>,
    document.body,
  )
}

interface MermaidDiagramProps {
  code: string
  /** The preview this diagram belongs to (queue visibility owner). */
  owner: MermaidPreviewHandle
  /** True when the fence was already near the viewport at mount; the whole
   *  document reads its rects in one batch (see MermaidMarkdown). */
  initiallyNearViewport: boolean
}

/** One rendered mermaid fence: header chrome + diagram (or error + source). */
function MermaidDiagram({ code, owner, initiallyNearViewport }: MermaidDiagramProps): React.ReactNode {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Scheme state: a flip re-renders the diagram with the matching theme. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The cloned svg shown in the zoom modal (null = closed). */
  const [zoomSvg, setZoomSvg] = useState<SVGSVGElement | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  /** The wrapper the visibility observer watches; also the placeholder host. */
  const wrapRef = useRef<HTMLDivElement>(null)
  /** Bumped whenever the source/theme changes or the component unmounts; a
   * render result belonging to an older generation is dropped. */
  const generationRef = useRef(0)
  /** Generation whose render is already queued (one task per generation). */
  const scheduledRef = useRef(-1)

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  /** Render the current source and publish the sanitized SVG. */
  const renderNow = useCallback(async (): Promise<void> => {
    const generation = generationRef.current
    const theme: MermaidTheme = dark ? 'dark' : 'default'
    try {
      const rendered = await renderMermaidDiagram(code, theme)
      if (generation !== generationRef.current) return
      const clean = sanitizeSvg(rendered)
      if (clean === '') {
        // Parse/sanitize rejection: never pass the raw string through.
        setError(t('mermaidError'))
        return
      }
      setSvg(clean)
    } catch (reason) {
      if (generation !== generationRef.current) return
      setError(summarizeError(reason))
    }
  }, [code, dark])

  /** Queue one render of the current generation: a visible diagram goes
   * first, the rest render on the idle path. */
  const scheduleRender = useCallback((priority: MermaidPriority): void => {
    const generation = generationRef.current
    if (scheduledRef.current === generation) return
    scheduledRef.current = generation
    pushMermaidTask(priority, async () => {
      if (generation !== generationRef.current) return
      await renderNow()
    }, owner)
  }, [renderNow, owner])

  // A new source or theme invalidates what is on screen and schedules a render.
  useEffect(() => {
    generationRef.current += 1
    scheduledRef.current = -1
    setSvg(null)
    setError(null)
    if (code.trim() === '') return
    scheduleRender(initiallyNearViewport ? 0 : 1)
  }, [code, dark, initiallyNearViewport, scheduleRender])

  // A placeholder that scrolls into view jumps ahead of the background queue.
  useEffect(() => {
    const node = wrapRef.current
    if (node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      scheduleRender(0)
    }, { rootMargin: '800px 0px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [scheduleRender])

  // Unmounting the preview drops renders that are still queued.
  useEffect(() => () => { generationRef.current += 1 }, [])

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
    <div className={css.mermaidWrap} ref={wrapRef}>
      <div className={css.mermaidHeader}>
        <span className={css.mermaidInfo}>mermaid</span>
        <button
          type="button"
          className={css.mermaidCopy}
          onClick={onCopy}
          aria-label={t('copy')}
          title={t('copy')}
        >
          <IconCopyOutlineRegular />
          <span>{copied ? t('copied') : t('copy')}</span>
        </button>
      </div>
      {svg === null && error === null && (
        <div
          className={css.mermaidPending}
          style={{ minHeight: `${placeholderHeight(code)}px` }}
          data-mermaid-pending
          aria-busy="true"
        >
          <span className={css.mermaidPendingBar} />
          <span className={css.mermaidPendingBar} />
          <span className={css.mermaidPendingBar} />
        </div>
      )}
      {error !== null && (
        <div className={css.mermaidError} title={error}>
          <span>{t('mermaidError')}</span>
          <span className={css.mermaidErrorDetail}>{error.split('\n').slice(0, 2).join(' ').slice(0, 240)}</span>
        </div>
      )}
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

/** One swapped mount: the diagram root + the CodeBlock children it displaced. */
interface MermaidMount {
  root: Root
  source: string
  removed: ChildNode[]
}

/**
 * Fence bodies of every mermaid fence in the source, normalized for matching
 * against the rendered block.
 * @param text - the markdown source the same component renders.
 * @returns the trailing-whitespace-normalized diagram sources.
 */
function mermaidFenceBodies(text: string): Set<string> {
  const bodies = new Set<string>()
  for (const block of splitMermaidBlocks(text)) {
    if (block.kind === 'mermaid') bodies.add(block.code.trimEnd())
  }
  return bodies
}

/** The block's fence body as rendered: CodeBlock trims one trailing newline. */
function blockBody(block: HTMLElement): string {
  return (block.querySelector('code')?.textContent ?? '').trimEnd()
}

/**
 * True when a rendered CodeBlock is a mermaid fence.
 *
 * The match is by FENCE BODY, not by the header: DSH ≤ 0.1.7-alpha.1 rendered a
 * banner whose info string said `mermaid`, but rc.1's code card shows
 * `labels.codeLabel` for any language the highlighter does not know, and
 * mermaid has no shiki grammar — so once the card is adopted the language word
 * is nowhere in the DOM. The body is, in both card variants, and the component
 * already has the source that produced it.
 *
 * The `language-mermaid` class stays as the first probe: the highlighted arm
 * would carry it if a grammar ever appears for the fence.
 * @param block - one rendered `.md-code-block`.
 * @param bodies - {@link mermaidFenceBodies} of the source being rendered.
 * @returns whether this block holds a mermaid diagram.
 */
function isMermaidBlock(block: HTMLElement, bodies: ReadonlySet<string>): boolean {
  const code = block.querySelector('code')
  if (code === null) return false
  if ([...code.classList].some(c => c.startsWith('language-mermaid'))) return true
  return bodies.has(blockBody(block))
}

/**
 * The chunk-resident markdown preview renderer: ONE MarkdownText pass over
 * the full source (cross-fence reference/footnote/list semantics intact),
 * then every rendered `language-mermaid` code block is swapped for a
 * `MermaidDiagram`. The `.md-code-block` host stays in the React tree —
 * only its children are replaced — so reconciliation never loses the host;
 * a block that stops being a mermaid fence gets its original children back.
 * Only mounted when the source contains at least one mermaid fence (see
 * TextEditor.tsx).
 */
export function MermaidMarkdown({ text, codeLabels }: MermaidMarkdownProps): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const mountsRef = useRef(new Map<HTMLElement, MermaidMount>())
  /** Visibility gate shared by every diagram of this document. */
  const handleRef = useRef<MermaidPreviewHandle | null>(null)
  if (handleRef.current === null) handleRef.current = createPreviewHandle()
  const handle = handleRef.current

  // Background renders wait while this preview is off screen (parked tab,
  // collapsed dock, hidden page); showing it again wakes the shared queue.
  // jsdom has neither layout nor IntersectionObserver, so specs keep the
  // default (visible) gate with only the document-visibility guard.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return () => { dropPreviewTasks(handle) }
    const update = (visible: boolean): void => {
      if (handle.visible === visible) return
      handle.visible = visible
      if (visible) handle.wake()
    }
    const present = (): boolean =>
      document.visibilityState !== 'hidden' && container.getClientRects().length > 0
    const onVisibilityChange = (): void => {
      if (typeof IntersectionObserver === 'undefined') update(document.visibilityState !== 'hidden')
      else update(present())
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (typeof IntersectionObserver === 'undefined') {
      return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange)
        dropPreviewTasks(handle)
      }
    }
    update(present())
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) update(entry.isIntersecting && document.visibilityState !== 'hidden')
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      dropPreviewTasks(handle)
    }
  }, [handle])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const mounts = mountsRef.current
    const seen = new Set<HTMLElement>()
    const bodies = mermaidFenceBodies(text)
    const blocks = [...container.querySelectorAll<HTMLElement>('.md-code-block')]

    // One read phase, then one write phase. Reading each diagram's rect inside
    // the swap loop (between root renders) forces a full layout per diagram —
    // dozens of forced reflows when a diagram-heavy document opens.
    const near = new Map<HTMLElement, boolean>()
    for (const block of blocks) {
      if (!isMermaidBlock(block, bodies)) continue
      near.set(block, isNearViewportRect(block.getBoundingClientRect()))
    }

    for (const block of blocks) {
      const mount = mounts.get(block)
      const isMermaid = near.has(block)
      if (!isMermaid) {
        // A previously swapped block that is no longer a mermaid fence:
        // restore the CodeBlock children React still manages, so the plain
        // fence renders normally again.
        if (mount !== undefined) {
          mount.root.unmount()
          block.replaceChildren(...mount.removed)
          block.removeAttribute('data-mermaid-processed')
          mounts.delete(block)
        }
        continue
      }
      seen.add(block)
      // The plain body always carries the fence source in <code>.
      const source = block.querySelector('code')?.textContent ?? ''
      if (mount !== undefined && mount.source === source) continue
      if (mount === undefined) {
        const host = document.createElement('div')
        const removed = [...block.childNodes]
        block.replaceChildren(host)
        block.setAttribute('data-mermaid-processed', 'true')
        const root = createRoot(host)
        mounts.set(block, { root, source, removed })
        root.render(
          <MermaidDiagram code={source} owner={handle} initiallyNearViewport={near.get(block) ?? false} />,
        )
      } else {
        mount.source = source
        mount.root.render(
          <MermaidDiagram code={source} owner={handle} initiallyNearViewport={near.get(block) ?? false} />,
        )
      }
    }

    // Drop mounts whose code block left the tree (fence removed, document
    // restructured): the host node is gone with it.
    for (const [block, mount] of mounts) {
      if (seen.has(block)) continue
      mount.root.unmount()
      mounts.delete(block)
    }
  }, [text, handle])

  useEffect(() => () => {
    for (const { root } of mountsRef.current.values()) root.unmount()
    mountsRef.current.clear()
    dropPreviewTasks(handle)
  }, [handle])

  return (
    <div className={css.mermaidMarkdown} ref={containerRef}>
      <MarkdownText {...markdownTextProps(text, codeLabels)} />
    </div>
  )
}
