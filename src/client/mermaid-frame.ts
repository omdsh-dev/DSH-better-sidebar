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
 *
 * Two failure classes stay separate on purpose: a diagram that mermaid itself
 * rejects is a per-diagram error (source + message on that block only), while a
 * frame that never loads, times out or answers with garbage is a transport
 * error (one retry, then a fast-fail breaker for the rest of the page). A bad
 * fence must never poison the diagrams after it.
 */
import { MERMAID_FRAME_HTML } from './mermaid-frame-asset.generated.ts'

export type MermaidTheme = 'dark' | 'default'

/** Frame viewport width: the empty document diagrams are laid out against. */
const FRAME_WIDTH = 1200
const FRAME_HEIGHT = 900
const FRAME_READY_TIMEOUT_MS = 10_000
const FRAME_RENDER_TIMEOUT_MS = 30_000
/** Guard against a hostile/broken payload being posted to the frame. */
const MAX_DIAGRAM_SOURCE_LENGTH = 500_000

/** mermaid rejected this diagram (syntax/unsupported feature). Only this
 * diagram falls back to its source; the frame stays healthy. */
export class MermaidDiagramError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MermaidDiagramError'
  }
}

/** The frame itself failed (load/handshake/timeout/protocol). Retry once, then
 * fail fast for the remaining diagrams on the page. */
export class MermaidFrameError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MermaidFrameError'
  }
}

/** One pending render waiting on the frame's postMessage answer. */
interface PendingRender {
  resolve: (svg: string) => void
  reject: (error: Error) => void
  timer: number
}

/** A validated answer from the frame. */
export type FrameMessage =
  | { kind: 'result'; id: number; svg: string }
  | { kind: 'error'; id: number; message: string }

/** The subset of MessageEvent the protocol needs (easy to unit-test). */
export interface MessageEventLike {
  source: unknown
  origin: string
  data: unknown
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

/** Test seam for the frame layer itself: replaces the postMessage transport
 * while keeping `renderMermaidDiagram`'s error classification/retry/breaker. */
let testTransport: ((code: string, theme: MermaidTheme) => Promise<string>) | null = null
export function setMermaidFrameTransportForTests(
  transport: ((code: string, theme: MermaidTheme) => Promise<string>) | null,
): void {
  testTransport = transport
  frameUnavailable = false
}

/** Restore the real frame and clear the breaker (module state persists across
 * specs in one vitest file). */
export function resetMermaidFrameForTests(): void {
  testRenderer = null
  testTransport = null
  frameUnavailable = false
}

/**
 * Validate one message against the frame protocol.
 *
 * The sandboxed frame has an opaque origin (`'null'`), so the source window is
 * the primary identity check; the origin allowlist keeps a same-origin page
 * that happens to reuse the message shape from being accepted.
 * @param event - the incoming message event (or a test double of it).
 * @param expectedWindow - the frame's `contentWindow`; `null` rejects all.
 * @returns the validated message, or `null` when it must be ignored.
 */
export function acceptFrameMessage(event: MessageEventLike, expectedWindow: Window | null): FrameMessage | null {
  if (expectedWindow === null || event.source !== expectedWindow) return null
  if (event.origin !== 'null' && event.origin !== '') return null
  const data = event.data as { type?: unknown; id?: unknown; svg?: unknown; message?: unknown } | null
  if (data === null || typeof data !== 'object') return null
  if (data.type !== 'mermaid-result' && data.type !== 'mermaid-error') return null
  if (typeof data.id !== 'number' || !Number.isInteger(data.id) || data.id <= 0) return null
  if (data.type === 'mermaid-result') {
    return typeof data.svg === 'string' ? { kind: 'result', id: data.id, svg: data.svg } : null
  }
  return typeof data.message === 'string'
    ? { kind: 'error', id: data.id, message: data.message }
    : null
}

/** Route the frame's result/error messages to their pending render. */
function installMessageListener(): void {
  if (messageListenerInstalled) return
  messageListenerInstalled = true
  window.addEventListener('message', (event: MessageEvent) => {
    const message = acceptFrameMessage(event, frame?.contentWindow ?? null)
    if (message === null) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    window.clearTimeout(entry.timer)
    if (message.kind === 'result') entry.resolve(message.svg)
    else entry.reject(new MermaidDiagramError(message.message))
  })
}

/** Reject every in-flight render (frame replaced/disposed) instead of leaving
 * them to their timeouts. */
function failPending(error: Error): void {
  for (const [id, entry] of pending) {
    pending.delete(id)
    window.clearTimeout(entry.timer)
    entry.reject(error)
  }
}

/** Drop the current frame (failed load, page teardown) and its blob URL. */
function disposeFrame(): void {
  failPending(new MermaidFrameError('mermaid frame was reset'))
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
      if (event.origin !== 'null' && event.origin !== '') return
      const data = event.data as { type?: unknown } | null
      if (data !== null && typeof data === 'object' && data.type === 'mermaid-frame-ready') settle()
    }
    const timer = window.setTimeout(() => {
      settle(new MermaidFrameError('mermaid frame did not become ready'))
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
  if (target === null || target === undefined) throw new MermaidFrameError('mermaid frame disappeared')
  const id = ++requestSeq
  return new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new MermaidFrameError('mermaid frame render timed out'))
    }, FRAME_RENDER_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    target.postMessage({ type: 'mermaid-render', id, code, theme }, '*')
  })
}

/**
 * Render one mermaid diagram off the host document's layout.
 *
 * A `MermaidDiagramError` is final for that one diagram (no retry, no breaker);
 * a transport failure gets one retry with a fresh frame, then flips the
 * page-level breaker so later diagrams fail fast instead of paying a timeout
 * each.
 * @param code - the diagram source (one fenced block body).
 * @param theme - mermaid theme to render with (follows the color scheme).
 * @returns the raw SVG markup (sanitized by the caller before injection).
 */
export async function renderMermaidDiagram(code: string, theme: MermaidTheme): Promise<string> {
  if (testRenderer !== null) return testRenderer(code, theme)
  if (code.length > MAX_DIAGRAM_SOURCE_LENGTH) {
    throw new MermaidDiagramError(`diagram source is too large (${code.length} chars)`)
  }
  if (frameUnavailable) throw new MermaidFrameError('mermaid rendering frame is unavailable')
  const renderOnce = async (): Promise<string> => (
    testTransport !== null ? testTransport(code, theme) : renderInFrame(code, theme)
  )
  try {
    return await renderOnce()
  } catch (firstError) {
    // A bad diagram is not a broken frame: report it and leave the frame alone.
    if (firstError instanceof MermaidDiagramError) throw firstError
    disposeFrame()
    try {
      return await renderOnce()
    } catch (secondError) {
      if (secondError instanceof MermaidDiagramError) throw secondError
      frameUnavailable = true
      throw new MermaidFrameError(
        `mermaid frame unavailable: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
        { cause: secondError },
      )
    }
  }
}
