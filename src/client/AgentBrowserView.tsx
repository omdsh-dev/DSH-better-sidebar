import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionScope } from './api.ts'
import { api, type MirrorFrame, type MirrorStateInfo } from './api.ts'
import css from './sidebar.module.css'

/** Map a DOM pointer position to browser CSS viewport coordinates. */
function mapToViewport(
  canvas: HTMLCanvasElement,
  state: MirrorStateInfo,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const scaleX = state.viewportWidth / rect.width
  const scaleY = state.viewportHeight / rect.height
  return {
    x: Math.round((clientX - rect.left) * scaleX),
    y: Math.round((clientY - rect.top) * scaleY),
  }
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
  const [mirrorState, setMirrorState] = useState<MirrorStateInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const stateRef = useRef<MirrorStateInfo | null>(null)
  const frameSeqRef = useRef(0)
  const renderingRef = useRef(false)
  const latestFrameRef = useRef<MirrorFrame | null>(null)

  // ── Mirror lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const start = async () => {
      try {
        // Measure the display area so the backend can lay the page out at
        // ~1:1 CSS px (keeps text readable in a narrow sidebar).
        const rect = containerRef.current?.getBoundingClientRect()
        const display = rect && rect.width >= 320 && rect.height >= 240
          ? { width: Math.floor(rect.width), height: Math.floor(rect.height) }
          : undefined
        const result = await api.mirrorStart(scope, display)
        if (!cancelled) {
          const info: MirrorStateInfo = {
            controlOwner: result.controlOwner as MirrorStateInfo['controlOwner'],
            viewportWidth: result.viewportWidth,
            viewportHeight: result.viewportHeight,
          }
          stateRef.current = info
          setMirrorState(info)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void start()
    return () => {
      cancelled = true
      void api.mirrorStop(scope).catch(() => {})
      stateRef.current = null
      setMirrorState(null)
      setHasFrame(false)
      frameSeqRef.current = 0
      latestFrameRef.current = null
    }
  }, [scope.sessionId, scope.cwd, visible])

  // ── Frame polling + canvas rendering ──────────────────────────────────

  useEffect(() => {
    if (!visible || mirrorState === null) return
    let cancelled = false

    const renderLatest = async () => {
      if (renderingRef.current) return
      renderingRef.current = true
      try {
        const frame = latestFrameRef.current
        if (!frame) return
        latestFrameRef.current = null
        const canvas = canvasRef.current
        if (!canvas) return
        const bytes = Uint8Array.from(atob(frame.data), c => c.charCodeAt(0))
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        const bitmap = await createImageBitmap(blob)
        // Stale-frame guard: a newer frame may have arrived during async decode —
        // never paint an older frame over a newer one.
        if (frameSeqRef.current !== frame.seq) {
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

    const poll = async () => {
      while (!cancelled) {
        try {
          const result = await api.mirrorFrame(scope)
          if (cancelled) break
          if (result.state) {
            stateRef.current = result.state
            setMirrorState(result.state)
          }
          if (result.frame && result.frame.seq > frameSeqRef.current) {
            frameSeqRef.current = result.frame.seq
            latestFrameRef.current = result.frame
            await renderLatest()
          }
        } catch { /* polling error — retry */ }
        if (!cancelled) await new Promise(r => setTimeout(r, 100))
      }
    }
    void poll()
    return () => { cancelled = true }
  }, [visible, mirrorState !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Input forwarding ──────────────────────────────────────────────────

  const sendMouse = useCallback((
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel',
    e: { clientX: number; clientY: number; button?: number; deltaX?: number; deltaY?: number },
  ) => {
    const canvas = canvasRef.current
    const state = stateRef.current
    if (!canvas || !state) return
    const coords = mapToViewport(canvas, state, e.clientX, e.clientY)
    if (!coords) return
    void api.mirrorInput(scope, {
      type,
      x: coords.x,
      y: coords.y,
      button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
      clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
      deltaX: e.deltaX ?? 0,
      deltaY: e.deltaY ?? 0,
    })
  }, [scope])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).focus()
    sendMouse('mousePressed', e)
  }, [sendMouse])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    sendMouse('mouseReleased', e)
  }, [sendMouse])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    sendMouse('mouseWheel', e)
  }, [sendMouse])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault()
    if (SPECIAL_KEYS.has(e.key)) {
      void api.mirrorInput(scope, { type: 'keyDown', key: e.key, code: e.code })
    } else if (e.key.length === 1) {
      // Printable character — use insertText for correct IME/composition handling
      void api.mirrorInput(scope, { type: 'insertText', text: e.key })
    }
    // Modifier-only presses (Shift, Ctrl, etc.) are ignored for MVP
  }, [scope])

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault()
    if (SPECIAL_KEYS.has(e.key)) {
      void api.mirrorInput(scope, { type: 'keyUp', key: e.key, code: e.code })
    }
  }, [scope])

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

  if (error !== null) return <div className={css.browserMessage}>{error}</div>

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
      {/* Canvas must stay mounted even before the first frame arrives —
          renderLatest draws into it and only then flips hasFrame. */}
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height: 'auto', objectFit: 'contain', background: '#000',
          display: 'block', cursor: isHuman ? 'default' : 'pointer',
          outline: 'none',
        }}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onContextMenu={e => e.preventDefault()}
      />
      {!hasFrame && <div className={css.browserStart} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <span>Waiting for browser mirror...</span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>Open a URL with browser_open first.</span>
      </div>}
    </div>
  </div>
}
