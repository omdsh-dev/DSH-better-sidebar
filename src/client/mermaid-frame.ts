/**
 * Client half of the isolated mermaid renderer.
 *
 * Mermaid sizes every label with `SVGElement.getBBox()`. In the live DSH
 * window one such measurement costs ~60-75ms (the document is large and
 * style-heavy, and the measurement node is appended to its body), so a single
 * diagram takes seconds and a document with dozens of them keeps the renderer
 * busy for minutes — long enough for the desktop shell's surface watchdog to
 * kill the page. An iframe has its own small layout tree: the same measurement
 * costs ~1ms, so diagrams render in milliseconds and the host window never
 * blocks.
 *
 * The frame is self-contained (the mermaid UMD bundle and protocol are inlined
 * by scripts/build-mermaid-frame-asset.mjs) and sandboxed WITHOUT
 * `allow-same-origin`: it runs only our own rendering code, cannot touch the
 * GUI document, and needs no host route. It is created lazily on the first
 * diagram and reused for every following render on the page.
 */
import { MERMAID_FRAME_HTML } from './mermaid-frame-asset.generated.ts'

export type MermaidTheme = 'dark' | 'default'

/** Frame viewport width: the empty document diagrams are laid out against. */
const FRAME_WIDTH = 1200
const FRAME_HEIGHT = 900
const FRAME_READY_TIMEOUT_MS = 10_000
const FRAME_RENDER_TIMEOUT_MS = 30_000

/** One pending render waiting on the frame's postMessage answer. */
interface PendingRender {
  resolve: (svg: string) => void
  reject: (error: Error) => void
  timer: number
}

const pending = new Map<number, PendingRender>()
let requestSeq = 0
let frame: HTMLIFrameElement | null = null
let frameReady: Promise<void> | null = null
let frameObjectUrl: string | null = null
let messageListenerInstalled = false
/** Set once the frame failed to load twice: stop paying the timeout per diagram. */
let frameUnavailable = false

/** Test seam: jsdom cannot run the real frame asset, so specs replace the
 * renderer with a stub. `null` restores the real one. */
let testRenderer: ((code: string, theme: MermaidTheme) => Promise<string>) | null = null
export function setMermaidFrameRendererForTests(
  renderer: ((code: string, theme: MermaidTheme) => Promise<string>) | null,
): void {
  testRenderer = renderer
}

/** Route the frame's result/error messages to their pending render. */
function installMessageListener(): void {
  if (messageListenerInstalled) return
  messageListenerInstalled = true
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown; svg?: unknown; message?: unknown } | null
    if (data === null || typeof data !== 'object') return
    if (data.type !== 'mermaid-result' && data.type !== 'mermaid-error') return
    const id = typeof data.id === 'number' ? data.id : -1
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    window.clearTimeout(entry.timer)
    if (data.type === 'mermaid-result' && typeof data.svg === 'string') entry.resolve(data.svg)
    else entry.reject(new Error(typeof data.message === 'string' ? data.message : 'mermaid frame render failed'))
  })
}

/** Drop the current frame (failed load, page teardown) and its blob URL. */
function disposeFrame(): void {
  frameReady = null
  if (frame !== null) {
    frame.remove()
    frame = null
  }
  if (frameObjectUrl !== null) {
    URL.revokeObjectURL(frameObjectUrl)
    frameObjectUrl = null
  }
}

/** Create the hidden frame and resolve once its protocol posted `ready`. */
function ensureFrame(): Promise<void> {
  if (frameReady !== null) return frameReady
  installMessageListener()
  frameReady = new Promise<void>((resolve, reject) => {
    const iframe = document.createElement('iframe')
    // Opaque-origin sandbox: the frame runs only our inlined mermaid bundle and
    // not the host origin's APIs. postMessage is the only bridge.
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    iframe.style.cssText = `position:fixed;left:-12000px;top:0;width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;border:0;visibility:hidden;pointer-events:none`
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onReady)
      window.clearTimeout(timer)
      if (error !== undefined) {
        disposeFrame()
        reject(error)
        return
      }
      resolve()
    }
    const onReady = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow) return
      const data = event.data as { type?: unknown } | null
      if (data !== null && typeof data === 'object' && data.type === 'mermaid-frame-ready') settle()
    }
    const timer = window.setTimeout(() => {
      settle(new Error('mermaid frame did not become ready'))
    }, FRAME_READY_TIMEOUT_MS)
    window.addEventListener('message', onReady)
    frameObjectUrl = URL.createObjectURL(new Blob([MERMAID_FRAME_HTML], { type: 'text/html' }))
    iframe.src = frameObjectUrl
    document.body.appendChild(iframe)
    frame = iframe
  })
  return frameReady
}

/** Ask the frame to render one diagram and resolve with the raw SVG markup. */
async function renderInFrame(code: string, theme: MermaidTheme): Promise<string> {
  await ensureFrame()
  const target = frame?.contentWindow
  if (target === null || target === undefined) throw new Error('mermaid frame disappeared')
  const id = ++requestSeq
  return new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error('mermaid frame render timed out'))
    }, FRAME_RENDER_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    target.postMessage({ type: 'mermaid-render', id, code, theme }, '*')
  })
}

/**
 * Render one mermaid diagram off the host document's layout.
 * @param code - the diagram source (one fenced block body).
 * @param theme - mermaid theme to render with (follows the color scheme).
 * @returns the raw SVG markup (sanitized by the caller before injection).
 */
export async function renderMermaidDiagram(code: string, theme: MermaidTheme): Promise<string> {
  if (testRenderer !== null) return testRenderer(code, theme)
  if (frameUnavailable) throw new Error('mermaid rendering frame is unavailable')
  try {
    return await renderInFrame(code, theme)
  } catch (_firstError) {
    // One retry with a fresh frame covers a transient load failure; a second
    // failure marks the frame unusable so later diagrams fail fast (the
    // diagram body then shows the error + source instead of a placeholder).
    disposeFrame()
    try {
      return await renderInFrame(code, theme)
    } catch (secondError) {
      frameUnavailable = true
      throw new Error(
        `mermaid frame unavailable: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
        { cause: secondError },
      )
    }
  }
}
