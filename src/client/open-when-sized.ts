/**
 * Deferred one-shot open for hosts that may not have a real size yet.
 *
 * xterm's `Terminal.open()` must not run in a zero-size container: the
 * renderer creation fails there (the DomRenderer is built from the host's
 * dimensions), leaving the render service's renderer `undefined`, and the
 * next Viewport refresh crashes reading `.dimensions` off it. WebKit-based
 * hosts (WKWebView) reliably report zero while the bottom panel's expand
 * slide is in flight; any `display:none`-hidden ancestor does the same.
 *
 * The caller's `open` callback (open + fit + resize) is invoked exactly
 * once, on the first check that finds the host attached and sized. Size
 * changes are observed through `ResizeObserver`, so a host that stays
 * mounted but hidden costs nothing: re-reading `clientWidth` on every frame
 * forces a synchronous layout whenever anything else in the document has
 * invalidated layout (scrolling, streaming updates, another plugin's
 * per-frame styles), and it spends a frame callback forever on a terminal
 * the user may never show again. A low-frequency interval stays as a
 * fallback for a host that gains a size without a resize entry, and for
 * hosts without `ResizeObserver`. The guard stops when the host leaves the
 * document (`isConnected`), so a pending open never fires after unmount. The
 * returned cancel function drops a pending open immediately (idempotent).
 *
 * `raf`, `caf`, `observe`, `setInterval` and `clearInterval` are injectable
 * so tests can drive the checks deterministically. Only the initial check
 * runs on a frame; later checks come from the observer and the interval.
 */
export interface OpenWhenSizedHooks {
  /** Schedules the first check, one frame after the host is mounted. */
  raf?: (callback: FrameRequestCallback) => number
  /** Cancels a pending first check. */
  caf?: (id: number) => void
  /** Subscribes to host box changes and returns a disposer. */
  observe?: (host: HTMLElement, check: () => void) => () => void
  /** Schedules the fallback size check. */
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Clears the fallback size check. */
  clearInterval?: (id: ReturnType<typeof setInterval>) => void
}

/** Fallback check period for a host that gains a size without a resize entry. */
const FALLBACK_INTERVAL_MS = 250

/** Subscribe to box changes through `ResizeObserver`, when the host provides one. */
function observeResize(host: HTMLElement, check: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => {}
  const observer = new ResizeObserver(check)
  observer.observe(host)
  return () => { observer.disconnect() }
}

/**
 * Run `open` once, on the first check that finds `host` attached and sized.
 * @param host - element whose box gates the one-shot open.
 * @param open - callback invoked exactly once, after the guard has stopped.
 * @param hooks - injectable scheduling seams; production callers pass none.
 * @returns cancel function that drops a pending open (idempotent).
 */
export function openWhenSized(
  host: HTMLElement,
  open: () => void,
  hooks: OpenWhenSizedHooks = {},
): () => void {
  const raf = hooks.raf ?? requestAnimationFrame
  const caf = hooks.caf ?? cancelAnimationFrame
  const observe = hooks.observe ?? observeResize
  const setIntervalFn = hooks.setInterval ?? setInterval
  const clearIntervalFn = hooks.clearInterval ?? clearInterval
  let done = false
  let frame: number | null = null
  let disconnect: (() => void) | null = null
  let interval: ReturnType<typeof setInterval> | null = null

  const teardown = (): void => {
    if (frame !== null) {
      caf(frame)
      frame = null
    }
    if (disconnect !== null) {
      disconnect()
      disconnect = null
    }
    if (interval !== null) {
      clearIntervalFn(interval)
      interval = null
    }
  }
  const check = (): void => {
    if (done) return
    if (!host.isConnected) {
      done = true
      teardown()
      return
    }
    if (host.clientWidth > 0 && host.clientHeight > 0) {
      done = true
      teardown()
      open()
    }
  }

  disconnect = observe(host, check)
  interval = setIntervalFn(check, FALLBACK_INTERVAL_MS)
  frame = raf(() => {
    frame = null
    check()
  })
  return () => {
    if (done) return
    done = true
    teardown()
  }
}
