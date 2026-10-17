/**
 * The unified floating-window layer: one z-order and one Escape contract for
 * EVERY persistent floating window of the plugin — the public window host,
 * the task window and the job-output window all ride it.
 *
 * Why a module-level registry: those surfaces mount from different React
 * trees (the public host at the plugin root, the task/job windows inside the
 * Tasks page), yet they visually share one screen. Per-component Escape
 * listeners used to close every open window at once; a single layer owner
 * makes Escape close exactly the TOP window, and a pointer/focus raise moves
 * a window above its siblings.
 *
 * Lifecycle: a window registers on mount and disposes on unmount, and the
 * document listener exists only while at least one window is mounted. There
 * is no growing module-level map — the live entry list IS the set of mounted
 * windows, and it empties on teardown.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

/** The base z-index of the floating layer (the value the old window CSS used). */
export const WINDOW_LAYER_BASE_Z = 90

interface LayerEntry {
  readonly token: number
  readonly key: string | undefined
  readonly close: () => void
}

/** Bottom → top. */
const stack: LayerEntry[] = []
const listeners = new Set<() => void>()
let nextToken = 1
let keyDownInstalled = false

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // The top window owns Escape. Its close path runs the same draft guard as
  // the close button, so a dirty window is never discarded silently.
  const top = stack[stack.length - 1]
  top?.close()
}

function syncKeyDown(): void {
  if (typeof document === 'undefined') return
  if (stack.length > 0 && !keyDownInstalled) {
    document.addEventListener('keydown', onDocumentKeyDown, true)
    keyDownInstalled = true
  } else if (stack.length === 0 && keyDownInstalled) {
    document.removeEventListener('keydown', onDocumentKeyDown, true)
    keyDownInstalled = false
  }
}

function indexOf(entry: LayerEntry): number {
  return stack.indexOf(entry)
}

/** A mounted window's handle on the layer (raise/dispose/z lookup). */
export interface WindowLayerRegistration {
  /** Move this window to the top of the shared z-order. */
  raise(): void
  /** Remove this window from the layer (called on unmount). */
  dispose(): void
  /** The current z-index slot, bottom = {@link WINDOW_LAYER_BASE_Z}. */
  zIndex(): number
}

/** Register one mounted floating window. The returned registration owns its entry. */
export function registerWindowLayer(options: {
  /** Stable identity for imperative `raiseWindowLayer` calls (window host ids). */
  key?: string
  /** How Escape closes THIS window (must run its own draft guard). */
  close(): void
}): WindowLayerRegistration {
  const entry: LayerEntry = { token: nextToken++, key: options.key, close: options.close }
  // A stale registration with the same identity (a hot-reloaded host) must
  // never keep a second entry alive.
  if (entry.key !== undefined) {
    const stale = stack.findIndex(candidate => candidate.key === entry.key)
    if (stale !== -1) stack.splice(stale, 1)
  }
  stack.push(entry)
  syncKeyDown()
  notify()
  return {
    raise(): void {
      const at = indexOf(entry)
      if (at === -1 || at === stack.length - 1) return
      stack.splice(at, 1)
      stack.push(entry)
      notify()
    },
    dispose(): void {
      const at = indexOf(entry)
      if (at === -1) return
      stack.splice(at, 1)
      syncKeyDown()
      notify()
    },
    zIndex(): number {
      const at = indexOf(entry)
      return WINDOW_LAYER_BASE_Z + (at === -1 ? 0 : at)
    },
  }
}

/** Subscribe to z-order / membership changes. */
export function subscribeWindowLayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The current z-index of one keyed window (undefined when it is not mounted). */
export function windowLayerZ(key: string): number | undefined {
  const at = stack.findIndex(entry => entry.key === key)
  return at === -1 ? undefined : WINDOW_LAYER_BASE_Z + at
}

/** Raise one keyed window (the public handle's `focus()`); false when unknown. */
export function raiseWindowLayer(key: string): boolean {
  const at = stack.findIndex(entry => entry.key === key)
  if (at === -1) return false
  if (at === stack.length - 1) return true
  const [entry] = stack.splice(at, 1)
  if (entry !== undefined) stack.push(entry)
  notify()
  return true
}

/**
 * React binding for one floating window: registers on mount (with an
 * optional stable key), exposes the live z-index and returns a raise callback
 * for pointer/focus events.
 */
export function useWindowLayer(options: {
  key?: string
  close(): void
}): { zIndex: number; raise(): void } {
  const { key, close } = options
  const closeRef = useRef(close)
  closeRef.current = close
  const registrationRef = useRef<WindowLayerRegistration | null>(null)
  const zIndex = useSyncExternalStore(
    subscribeWindowLayer,
    useCallback(() => registrationRef.current?.zIndex() ?? WINDOW_LAYER_BASE_Z, []),
  )
  useEffect(() => {
    const registration = registerWindowLayer({
      ...(key === undefined ? {} : { key }),
      close: () => { closeRef.current() },
    })
    registrationRef.current = registration
    return () => {
      if (registrationRef.current === registration) registrationRef.current = null
      registration.dispose()
    }
  }, [key])
  const raise = useCallback((): void => { registrationRef.current?.raise() }, [])
  return { zIndex, raise }
}
