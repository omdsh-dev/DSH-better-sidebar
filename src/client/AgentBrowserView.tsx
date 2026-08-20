import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionScope } from './api.ts'
import { api, type MirrorStateInfo } from './api.ts'
import css from './sidebar.module.css'

/** Map a DOM pointer position to browser CSS viewport coordinates,
 *  accounting for the canvas's object-fit: contain letterboxing. */
function mapToViewport(
  canvas: HTMLCanvasElement,
  state: MirrorStateInfo,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const scale = Math.min(rect.width / state.viewportWidth, rect.height / state.viewportHeight)
  const contentW = state.viewportWidth * scale
  const contentH = state.viewportHeight * scale
  const offsetX = rect.left + (rect.width - contentW) / 2
  const offsetY = rect.top + (rect.height - contentH) / 2
  const x = (clientX - offsetX) / scale
  const y = (clientY - offsetY) / scale
  // Clicks on the letterbox bars map outside the viewport — ignore them.
  if (x < 0 || y < 0 || x > state.viewportWidth || y > state.viewportHeight) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/** Special keys that should be sent as dispatchKeyEvent, not insertText. */
const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
])

export function AgentBrowserView(props: { scope: SessionScope; visible: boolean }): React.ReactNode {
  const { scope, visible } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imeRef = useRef<HTMLTextAreaElement>(null)
  const [mirrorState, setMirrorState] = useState<MirrorStateInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const stateRef = useRef<MirrorStateInfo | null>(null)
  const frameSeqRef = useRef(0)
  const renderingRef = useRef(false)
  const socketRef = useRef<WebSocket | null>(null)

  // ── Mirror lifecycle (auto-retries until the agent opens a browser) ───

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let retryTimer: number | undefined
    const start = async () => {
      try {
        // Measure the display area so the backend can lay the page out at
        // ~1:1 CSS px (keeps text readable in a narrow sidebar); dpr keeps
        // the frames 1:1 sharp on retina displays.
        const rect = containerRef.current?.getBoundingClientRect()
        const display = rect && rect.width >= 320 && rect.height >= 240
          ? { width: Math.floor(rect.width), height: Math.floor(rect.height), dpr: window.devicePixelRatio || 1 }
          : undefined
        const result = await api.mirrorStart(scope, display)
        if (cancelled) return
        const info: MirrorStateInfo = {
          controlOwner: result.controlOwner as MirrorStateInfo['controlOwner'],
          viewportWidth: result.viewportWidth,
          viewportHeight: result.viewportHeight,
        }
        stateRef.current = info
        setMirrorState(info)
        setError(null)
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        // The agent may not have opened a browser yet — keep retrying so the
        // mirror appears on its own once browser_open runs.
        retryTimer = window.setTimeout(start, 3000)
      }
    }
    void start()
    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
      void api.mirrorStop(scope).catch(() => {})
      stateRef.current = null
      setMirrorState(null)
      setHasFrame(false)
      frameSeqRef.current = 0
    }
  }, [scope.sessionId, scope.cwd, visible])

  // ── Frame push over WebSocket + canvas rendering ──────────────────────

  useEffect(() => {
    if (!visible || mirrorState === null) return
    let cancelled = false
    let socket: WebSocket | null = null
    let retry: number | undefined

    const renderFrame = async (seq: number, bytes: Uint8Array) => {
      if (renderingRef.current) return // busy — drop; the next frame is newer
      renderingRef.current = true
      try {
        const canvas = canvasRef.current
        if (!canvas) return
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
        // Stale-frame guard: a newer frame may have arrived during async
        // decode — never paint an older frame over a newer one.
        if (frameSeqRef.current !== seq) {
          bitmap.close()
          return
        }
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        setHasFrame(true)
      } catch { /* decode error — skip frame */ } finally {
        renderingRef.current = false
      }
    }

    const connect = () => {
      if (cancelled) return
      socket = new WebSocket(api.mirrorWsUrl(scope))
      socketRef.current = socket
      socket.binaryType = 'arraybuffer'
      socket.onmessage = (event) => {
        if (cancelled) return
        if (typeof event.data === 'string') {
          // Meta frame: control ownership / viewport changes
          try {
            const meta = JSON.parse(event.data) as { type?: string } & Partial<MirrorStateInfo>
            if (meta.type === 'meta'
              && typeof meta.viewportWidth === 'number'
              && typeof meta.viewportHeight === 'number'
              && typeof meta.controlOwner === 'string') {
              const info: MirrorStateInfo = {
                controlOwner: meta.controlOwner as MirrorStateInfo['controlOwner'],
                viewportWidth: meta.viewportWidth,
                viewportHeight: meta.viewportHeight,
              }
              stateRef.current = info
              setMirrorState(info)
            }
          } catch { /* malformed meta — ignore */ }
          return
        }
        // Binary frame: 4-byte LE uint32 seq + raw JPEG bytes
        const buf = event.data as ArrayBuffer
        if (buf.byteLength < 5) return
        const seq = new DataView(buf).getUint32(0, true)
        if (seq <= frameSeqRef.current) return // stale
        frameSeqRef.current = seq
        void renderFrame(seq, new Uint8Array(buf, 4))
      }
      socket.onclose = () => {
        if (cancelled) return
        retry = window.setTimeout(connect, 1000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      cancelled = true
      window.clearTimeout(retry)
      socketRef.current = null
      socket?.close()
    }
  }, [visible, mirrorState !== null, scope.sessionId, scope.cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sidebar resize: letterbox during the drag, then re-fit ────────────
  // While dragging, the canvas scales proportionally (object-fit: contain
  // can never overflow, so no layout feedback). 400ms after the drag
  // settles, the page re-lays-out at the new container size so the frame
  // fills the panel exactly — no persistent black bars, text stays ~1:1.

  useEffect(() => {
    if (!visible || mirrorState === null) return
    const el = containerRef.current
    if (!el) return
    let timer: number | undefined
    let lastW = el.clientWidth
    let lastH = el.clientHeight
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      // Ignore sub-pixel jitter and tiny adjustments.
      if (Math.abs(width - lastW) < 24 && Math.abs(height - lastH) < 24) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        lastW = width
        lastH = height
        const w = Math.floor(width)
        const h = Math.floor(height)
        if (w < 320 || h < 240) return
        void api.mirrorRefit(scope, { width: w, height: h }).catch(() => {})
      }, 400)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [visible, mirrorState !== null, scope.sessionId, scope.cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Input forwarding ──────────────────────────────────────────────────
  // Input rides the mirror WebSocket when it's open (no HTTP round-trip per
  // keystroke); falls back to the HTTP route while reconnecting.

  const sendInput = useCallback((event: Record<string, unknown>) => {
    const ws = socketRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
    else void api.mirrorInput(scope, event).catch(() => {})
  }, [scope])

  const sendMouse = useCallback((
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel',
    e: { clientX: number; clientY: number; button?: number; deltaX?: number; deltaY?: number },
  ) => {
    const canvas = canvasRef.current
    const state = stateRef.current
    if (!canvas || !state) return
    const coords = mapToViewport(canvas, state, e.clientX, e.clientY)
    if (!coords) return
    sendInput({
      type,
      x: coords.x,
      y: coords.y,
      button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
      clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
      deltaX: e.deltaX ?? 0,
      deltaY: e.deltaY ?? 0,
    })
  }, [sendInput])

  /** Move the hidden IME textarea to the click point and focus it, so the
   *  OS input method attaches there and its candidate window opens near
   *  where the user is typing. */
  const focusImeAt = useCallback((clientX: number, clientY: number) => {
    const ime = imeRef.current
    const container = containerRef.current
    if (!ime || !container) return
    const rect = container.getBoundingClientRect()
    ime.style.left = `${Math.max(0, Math.min(clientX - rect.left, rect.width - 8))}px`
    ime.style.top = `${Math.max(0, Math.min(clientY - rect.top, rect.height - 8))}px`
    ime.focus()
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    sendMouse('mousePressed', e)
    focusImeAt(e.clientX, e.clientY)
  }, [sendMouse, focusImeAt])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    sendMouse('mouseReleased', e)
  }, [sendMouse])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    sendMouse('mouseWheel', e)
  }, [sendMouse])

  // Keyboard lives on the hidden textarea (not the canvas) so IME
  // composition events fire on the same element that has focus.

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // While the IME is composing, let composition events drive the text.
    if (e.nativeEvent.isComposing) return
    // Leave modified keys (Cmd+C, Cmd+Q, …) to the local GUI.
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault()
      sendInput({ type: 'keyDown', key: e.key, code: e.code })
    } else if (e.key.length === 1) {
      e.preventDefault()
      sendInput({ type: 'insertText', text: e.key })
    }
    // Modifier-only presses (Shift, Ctrl, …) are ignored for now
  }, [sendInput])

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault()
      sendInput({ type: 'keyUp', key: e.key, code: e.code })
    }
  }, [sendInput])

  // IME composition: forward the marked text so the mirrored page shows the
  // same in-progress composition, then commit with insertText.

  const handleCompositionUpdate = useCallback((e: React.CompositionEvent) => {
    sendInput({ type: 'imeSetComposition', text: e.data })
  }, [sendInput])

  const handleCompositionEnd = useCallback((e: React.CompositionEvent) => {
    const text = e.data
    if (text) sendInput({ type: 'insertText', text })
    // Clear the hidden textarea so the next composition starts clean.
    window.setTimeout(() => { if (imeRef.current) imeRef.current.value = '' }, 0)
  }, [sendInput])

  // Non-composition input into the textarea (e.g. Cmd+V paste): forward the
  // whole inserted value as text, then clear.
  const handleImeInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as InputEvent).isComposing) return
    const el = imeRef.current
    if (!el || !el.value) return
    const text = el.value
    el.value = ''
    sendInput({ type: 'insertText', text })
  }, [sendInput])

  // ── Control ownership ─────────────────────────────────────────────────

  const takeControl = useCallback(() => {
    void api.mirrorControl(scope, 'human')
    setMirrorState(prev => prev ? { ...prev, controlOwner: 'human' } : prev)
  }, [scope])

  const returnControl = useCallback(() => {
    void api.mirrorControl(scope, 'agent')
    setMirrorState(prev => prev ? { ...prev, controlOwner: 'agent' } : prev)
  }, [scope])

  // ── Render ────────────────────────────────────────────────────────────

  const isHuman = mirrorState?.controlOwner === 'human'

  return <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 12,
      borderBottom: '1px solid var(--dsw-alias-border-secondary, #333)', flexShrink: 0,
    }}>
      <span style={{ opacity: 0.7 }}>
        {isHuman ? '● You are controlling' : '● Agent controlling'}
      </span>
      <span style={{ flex: 1 }} />
      {isHuman
        ? <button onClick={returnControl} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Return to Agent</button>
        : <button onClick={takeControl} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Take Control</button>}
    </div>
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      {/* Canvas fills the container and letterboxes the frame (object-fit:
          contain) — resizing the sidebar scales the picture proportionally
          instead of re-laying-out the page. Must stay mounted even before
          the first frame: renderFrame draws into it, then flips hasFrame. */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'contain', background: '#000',
          display: 'block', cursor: isHuman ? 'default' : 'pointer',
          outline: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onContextMenu={e => e.preventDefault()}
      />
      {/* Hidden textarea: the keyboard/IME focus target. Clicks on the canvas
          move it to the click point and focus it; it never intercepts
          pointer events itself. */}
      <textarea
        ref={imeRef}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          position: 'absolute', width: 8, height: 8, opacity: 0,
          padding: 0, border: 'none', resize: 'none', overflow: 'hidden',
          pointerEvents: 'none', fontSize: 16, outline: 'none',
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onCompositionUpdate={handleCompositionUpdate}
        onCompositionEnd={handleCompositionEnd}
        onInput={handleImeInput}
      />
      {error !== null && <div className={css.browserMessage} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        {error}
      </div>}
      {error === null && !hasFrame && <div className={css.browserStart} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <span>Waiting for browser mirror...</span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>Open a URL with browser_open first.</span>
      </div>}
    </div>
  </div>
}
