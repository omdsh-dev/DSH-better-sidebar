/**
 * Middle-click close over the plugin's tabs inside DSH's native right Sidebar.
 *
 * DSH's own strip closes a tab only through its × button or the right-click
 * menu: the kit's tab element handles pointerdown (drag tracking), click
 * (activate), keydown (arrow focus) and contextmenu, and never button 1. The
 * plugin cannot hang a handler on that element — it contributes a tab's BODY
 * and its TITLE, never the chip around them — so this module listens on the
 * document in the CAPTURE phase instead, and closes through the tab's own
 * `actions.close()`: the very call the host's × button ends in
 * (`navigator.closeIn(sessionId, tabId)`), so the close is session-exact and
 * needs no ownership probe beyond the marker the plugin's own title chip
 * stamps. A chip without that marker is a host tab (the built-in guide, the
 * document preview) and is left completely alone — and so is everything
 * outside a strip chip's box and a floating panel's header: middle-clicking a
 * terminal or a web page inside a tab keeps whatever the platform gave it.
 *
 * Semantics match the plugin's own strip (TabBar.tsx) and the platforms it
 * copies: the press is recorded on middle-button pointerdown OVER a plugin
 * tab, and the close settles on the first middle-button release over that
 * same tab — releasing elsewhere, or drifting past the drag slop, cancels
 * (VS Code microsoft/vscode#101028, Chrome crbug/40679924). The press is
 * `preventDefault`ed to disarm Chrome's middle-click autoscroll and
 * `stopPropagation`ed so the kit's drag tracking never sees the middle
 * button; both are scoped to presses on a chip this plugin rendered, so a
 * host tab keeps its native behaviour untouched.
 */

/** The marker a plugin tab's title chip stamps: ownership + native tab id. */
export const NATIVE_TAB_MARKER = 'data-dsh-better-sidebar-native-tab'

/** The docking kit's attribute on one strip chip (the whole clickable tab). */
const DOCK_TAB_ATTRIBUTE = 'data-dockkit-tab'

/** The kit's attribute on a floating panel's header (its title row). */
const FLOAT_HEADER_ATTRIBUTE = 'data-dockkit-float-grip'

/**
 * Where a release may land: the strip tab, or a floating panel's HEADER —
 * never the panel at large, whose body hosts terminals and web content where
 * the middle button means paste / open-in-background.
 */
const HIT_NODE_SELECTOR = `[${DOCK_TAB_ATTRIBUTE}], [${FLOAT_HEADER_ATTRIBUTE}]`

/**
 * The kit's own close controls. The kit renders one exactly where the tab may
 * close (`canCloseTab`), so requiring one keeps the gesture inside the host's
 * rule instead of inventing a second opinion about closability.
 */
const CLOSE_CONTROL_SELECTOR = '[data-dockkit-tab-close], [data-dockkit-float-close]'

/**
 * How far (CSS pixels) a middle press may drift before it counts as a drag.
 * A drag can end anywhere and the kit moves the tab with it, so closing then
 * would punish a gesture the user aimed at moving the tab.
 */
const DRAG_SLOP = 4

/** The attributes one title chip stamps to claim its tab. */
export function nativeTabMarker(tabId: string): Record<string, string> {
  return { [NATIVE_TAB_MARKER]: tabId }
}

/** Middle-click close over the plugin's native tabs. */
export interface NativeTabMiddleClick {
  /**
   * Publish one live tab's close action; called by that tab's title chip.
   * @param tabId - the native tab id the chip is rendered for.
   * @param close - the action ending the tab in its own session.
   * @returns a disposer unpublishing the action (the chip's effect cleanup).
   */
  register(tabId: string, close: () => void): () => void
  /** Stop listening; the chips this controller served are gone. */
  dispose(): void
}

/** One outstanding middle press. */
interface Press {
  readonly id: string
  /** Where the release must land (see {@link hitOf}). */
  readonly node: Element
  readonly x: number
  readonly y: number
}

/** One plugin tab a press resolved to. */
interface Hit {
  readonly id: string
  readonly node: Element
}

/**
 * Resolve an event target to a plugin tab: the chip itself, or — for the
 * parts of a strip tab the chip does not cover — the enclosing kit tab that
 * contains one. The chip's marker is the ownership test: a tab without one
 * belongs to the host and resolves to undefined.
 *
 * The node the release must land in is the kit's strip tab (so the tab's
 * padding and the gap before the × count) or a floating panel's header — not
 * the panel, whose body hosts terminals and web content where the middle
 * button means paste. A node that carries no close control is one the host
 * itself refuses to close, and is left alone.
 * @param target - the event target.
 * @returns the tab id and the node a release must land in, or undefined.
 */
function hitOf(target: EventTarget | null): Hit | undefined {
  const element = target as Element | null
  if (element === null || typeof element.closest !== 'function') return undefined
  // The kit's own box for this tab: the strip chip, or the floating header.
  // A press anywhere else (a pane body, the page) has no such box.
  const container = element.closest(HIT_NODE_SELECTOR)
  const chip = element.closest(`[${NATIVE_TAB_MARKER}]`)
    ?? container?.querySelector(`[${NATIVE_TAB_MARKER}]`)
    ?? null
  if (chip === null) return undefined
  const id = chip.getAttribute(NATIVE_TAB_MARKER)
  if (id === null || id === '') return undefined
  const node = chip.closest(HIT_NODE_SELECTOR) ?? chip
  if (node !== chip && node.querySelector(CLOSE_CONTROL_SELECTOR) === null) return undefined
  return { id, node }
}

/**
 * Create the middle-click controller for one client activation.
 *
 * Listeners are attached at creation and removed by {@link NativeTabMiddleClick.dispose};
 * the returned controller is one per activation (never a module singleton),
 * so a disposed plugin leaves no document-level listener behind.
 * @returns the controller the native title chips publish their closes to.
 */
export function createNativeTabMiddleClick(): NativeTabMiddleClick {
  const handlers = new Map<string, () => void>()
  let press: Press | undefined
  const clear = (): void => { press = undefined }

  const onDown = (event: Event): void => {
    const down = event as MouseEvent
    // Any other button starts a different gesture, so an outstanding middle
    // press can never settle.
    if (down.button !== 1) { clear(); return }
    const hit = hitOf(down.target)
    if (hit === undefined || !handlers.has(hit.id)) { clear(); return }
    down.preventDefault()
    down.stopPropagation()
    press = { id: hit.id, node: hit.node, x: down.clientX, y: down.clientY }
  }

  const onUp = (event: Event): void => {
    const up = event as MouseEvent
    if (up.button !== 1) return
    const held = press
    clear()
    if (held === undefined) return
    // Release-position semantics: the close only settles over the pressed
    // tab (and the tab must still be in the document — it may have been
    // closed under the press).
    if (!held.node.isConnected || !held.node.contains(up.target as Node)) return
    if (Math.abs(up.clientX - held.x) > DRAG_SLOP || Math.abs(up.clientY - held.y) > DRAG_SLOP) return
    handlers.get(held.id)?.()
  }

  const listening: Array<[EventTarget, string, EventListener]> = []
  const listen = (target: EventTarget, type: string, listener: EventListener): void => {
    target.addEventListener(type, listener, true)
    listening.push([target, type, listener])
  }
  let disposed = false
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    // Pointer events carry the press that the kit's own handler would
    // otherwise turn into a tab drag; the mouse pair is the fallback for
    // engines without PointerEvent (and for the jsdom lane).
    if (typeof (window as { PointerEvent?: unknown }).PointerEvent === 'function') {
      listen(document, 'pointerdown', onDown)
      listen(document, 'pointerup', onUp)
      listen(document, 'pointercancel', clear)
    }
    listen(document, 'mousedown', onDown)
    listen(document, 'mouseup', onUp)
    listen(window, 'blur', clear)
  }

  return {
    register(tabId, close) {
      handlers.set(tabId, close)
      return () => {
        // A chip that re-renders for the same tab must not unpublish a newer
        // action it no longer owns.
        if (handlers.get(tabId) === close) handlers.delete(tabId)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      handlers.clear()
      clear()
      for (const [target, type, listener] of listening) target.removeEventListener(type, listener, true)
      listening.length = 0
    },
  }
}
