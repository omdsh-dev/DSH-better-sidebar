/**
 * How many CSS pixels at the top of the viewport the DESKTOP SHELL paints its
 * native window controls over (minimize / maximize / close).
 *
 * Why this exists: on Windows the shell enables Electron's `titleBarOverlay`,
 * which draws those buttons OVER the page and takes every pointer event in
 * that band before it can reach the DOM. A floating surface pinned to the
 * viewport top therefore loses its whole title bar: the close button looks
 * dead while `document.elementFromPoint` still answers it (the two-point
 * bisection in issue #805 measured the same mechanism for the mermaid zoom
 * toolbar; the Tasks detail window is the same bug one component over).
 *
 * The ONE source is the standard Window Controls Overlay geometry. No
 * preference, no settings row, no URL stamp, no shell-supplied service, and
 * nothing is published to the DOM — the previous configurable "title-bar
 * strip" was removed in #430 because it had grown five sources and zero
 * consumers; this has one source and three real consumers.
 */
import { useSyncExternalStore } from 'react'

/** The slice of `navigator.windowControlsOverlay` this module needs. */
export interface WindowControlsOverlayLike {
  readonly visible: boolean
  getTitlebarAreaRect(): {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  addEventListener(type: 'geometrychange', listener: () => void): void
  removeEventListener(type: 'geometrychange', listener: () => void): void
}

/** The part of the viewport a floating surface must not cover. */
export interface ViewportInset {
  readonly top: number
}

export const NO_VIEWPORT_INSET: ViewportInset = Object.freeze({ top: 0 })

function overlayOf(navigatorLike: Navigator | undefined): WindowControlsOverlayLike | undefined {
  const candidate = (navigatorLike as
    | (Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    | undefined)?.windowControlsOverlay
  return candidate ?? undefined
}

/**
 * The safe gap below the native control band.
 *
 * `y + height` rather than `height` alone: the rect names the title-bar AREA,
 * so its bottom edge is the first pixel the page can own (the two coincide on
 * Windows, where `y` is 0, but a shell may inset the band).
 *
 * Everything unusable collapses to 0 — no API, `visible: false` (headless
 * Chromium and some macOS builds expose the interface with no overlay), a
 * zero-height band (full screen), or a throwing call. 0 keeps plain browsers
 * and web profiles exactly as they were.
 */
function computeInset(candidate: WindowControlsOverlayLike | undefined): ViewportInset {
  if (candidate === undefined) return NO_VIEWPORT_INSET
  try {
    if (candidate.visible !== true) return NO_VIEWPORT_INSET
    const rect = candidate.getTitlebarAreaRect()
    const top = Math.round(rect.y + rect.height)
    return Number.isFinite(top) && top > 0 ? { top } : NO_VIEWPORT_INSET
  } catch {
    return NO_VIEWPORT_INSET
  }
}

let source: WindowControlsOverlayLike | undefined
let snapshot: ViewportInset = NO_VIEWPORT_INSET
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function reread(): void {
  const next = computeInset(source)
  if (next === snapshot) return
  snapshot = next
  emit()
}

// Probe at module evaluation, not on the first subscriber: `useSyncExternalStore`
// reads the snapshot before it subscribes, so a lazy mount would paint the
// first frame at the unsafe position and then jump the window down.
if (typeof navigator !== 'undefined') {
  source = overlayOf(navigator)
  if (source !== undefined) {
    snapshot = computeInset(source)
    source.addEventListener('geometrychange', reread)
  }
}

// Some Electron builds expose the overlay without firing `geometrychange` on
// maximize / restore; a resize is the same event in practice. Event-driven, so
// it costs nothing while idle (unlike the polling the steady-state rules guard).
if (typeof window !== 'undefined') {
  window.addEventListener('resize', reread)
}

/** The current inset. Stable reference until the geometry actually changes. */
export function getViewportInset(): ViewportInset {
  return snapshot
}

/** Subscribe to geometry changes; returns the disposer. */
export function subscribeViewportInset(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Swap the overlay source (tests). `undefined` = no overlay API. */
export function setViewportInsetSourceForTests(
  next: WindowControlsOverlayLike | undefined,
): void {
  source?.removeEventListener('geometrychange', reread)
  source = next
  const computed = computeInset(next)
  if (computed !== snapshot) {
    snapshot = computed
    emit()
  }
  next?.addEventListener('geometrychange', reread)
}

/** React consumer: the inset, re-rendering when the shell band changes. */
export function useViewportInset(): ViewportInset {
  return useSyncExternalStore(subscribeViewportInset, getViewportInset, getViewportInset)
}

/** Convenience for callers that only need the number. */
export function useViewportInsetTop(): number {
  return useViewportInset().top
}
