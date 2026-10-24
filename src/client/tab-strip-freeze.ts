/**
 * Freeze the native strip's tab widths while a close is happening, so the
 * survivors do not re-lay-out under the cursor.
 *
 * Equal-width chips are the point, but they also mean every close widens the
 * rest — so closing a run of tabs turns into a chase for the next ×. Chrome
 * pins the strip's widths for as long as the pointer stays on it and
 * re-lays-out when the pointer leaves. This module reproduces that for the
 * HOST's native right-sidebar strip, which the plugin does not render:
 *
 *  - ARM on the close gesture, not on the mutation. A `pointerdown` on the
 *    kit's close control (`[data-dockkit-tab-close]`), or a middle-button press
 *    on a chip, pins the width a chip has right now — measured BEFORE the
 *    close, which is the whole point.
 *  - PIN globally, on `<html>`. The host REBUILDS the strip's DOM on a close
 *    (measured: the `[data-dockkit-strip]` node is replaced, so a per-element
 *    attribute or observer would be discarded exactly when it is needed). An
 *    attribute plus a custom property on the root survive that rebuild, and
 *    the stylesheet's `html[data-dsh-tabs-frozen] [data-sidebar-right-panel]
 *    [data-dockkit-tab]` rule applies to whatever chips exist next.
 *  - RELEASE when the pointer is no longer on that strip: a `pointerout`
 *    whose related target is outside it releases immediately; one with no
 *    related target (the node under the pointer was removed, or the window was
 *    left) is confirmed by a hit test on the next task, so the close itself
 *    cannot release the pin. A `pointerover` anywhere else releases too.
 *
 * Only closing arms it: opening a tab, dragging, or just clicking around keeps
 * the normal equal-share reflow. Failure is silent — a host that renames its
 * attributes simply never arms.
 */

/** Chip of the host's docking kit. */
const CHIP = '[data-dockkit-tab]'
/** The kit's close control inside a chip. */
const CLOSE = '[data-dockkit-tab-close]'
/** The kit's whole strip line (chips row + empty tail + controls). */
const STRIP = '[data-dockkit-strip]'
/** Root attribute the stylesheet keys the pinned widths on. */
export const FROZEN_ATTR = 'data-dsh-tabs-frozen'
/** Root custom property holding the pinned content-box width, in px. */
export const FROZEN_VAR = '--dsh-tab-frozen-width'

/** What the installer needs; both halves are injectable so jsdom can test it. */
export interface StripFreezeOptions {
  /**
   * Measure one chip's content-box width, in px (`flex-basis` on a content-box
   * element is a content size, not the border box the rect reports).
   * @returns the width, or `undefined` when it cannot be measured yet.
   */
  readonly measure?: (chip: HTMLElement, strip: HTMLElement) => number | undefined
  /** Document to bind (tests pass jsdom's). */
  readonly doc?: Document
}

/**
 * One chip's content-box width, in px.
 * @param chip - the chip to measure.
 * @returns the content width, or `undefined` while it has no box yet.
 */
export function contentWidthOf(chip: HTMLElement): number | undefined {
  const rect = chip.getBoundingClientRect().width
  if (!(rect > 0)) return undefined
  const style = getComputedStyle(chip)
  const px = (value: string): number => Number.parseFloat(value) || 0
  const inner = px(style.paddingLeft) + px(style.paddingRight)
    + px(style.borderLeftWidth) + px(style.borderRightWidth)
  return Math.max(0, rect - inner)
}

/**
 * Install the freeze for the host's native tab strips.
 * @param options - measurer/document overrides (tests).
 * @returns the disposer (removes listeners and any pin).
 */
export function installNativeStripFreeze(options: StripFreezeOptions = {}): () => void {
  const doc = options.doc ?? document
  const root = doc.documentElement
  const measure = options.measure ?? contentWidthOf
  /** The strip we pinned, by its stable pane id; `null` while released. */
  let pinned: { readonly paneId: string; readonly width: number } | null = null

  const stripOf = (target: EventTarget | null): HTMLElement | null =>
    (target as Element | null)?.closest?.(STRIP) as HTMLElement | null | undefined ?? null

  /** The live strip with that pane id (the host rebuilds the node on close). */
  const resolve = (paneId: string): HTMLElement | null =>
    [...doc.querySelectorAll<HTMLElement>(STRIP)].find(el => el.getAttribute('data-dockkit-strip') === paneId) ?? null

  const release = (): void => {
    pinned = null
    root.removeAttribute(FROZEN_ATTR)
    root.style.removeProperty(FROZEN_VAR)
  }

  const pin = (strip: HTMLElement): void => {
    if (pinned !== null) return
    const chip = strip.querySelector<HTMLElement>(CHIP)
    const paneId = strip.getAttribute('data-dockkit-strip')
    if (chip === null || paneId === null) return
    const width = measure(chip, strip)
    if (width === undefined || !(width > 0)) return
    pinned = { paneId, width }
    root.style.setProperty(FROZEN_VAR, `${width}px`)
    root.setAttribute(FROZEN_ATTR, '')
  }

  const onPointerDown = (event: Event): void => {
    const target = event.target as Element | null
    const strip = stripOf(target)
    if (strip === null) return
    const middle = (event as MouseEvent).button === 1
    const onClose = target?.closest?.(CLOSE) != null
    if (middle || onClose) pin(strip)
  }

  /** Whether the pointer is still over the pinned strip (hit test). */
  const stillInside = (x: number, y: number): boolean => {
    if (pinned === null) return false
    const strip = resolve(pinned.paneId)
    if (strip === null) return false
    try {
      const under = doc.elementFromPoint(x, y)
      return under !== null && strip.contains(under)
    } catch {
      // No hit testing on this document (jsdom): treat it as a leave.
      return false
    }
  }

  const onPointerOut = (event: Event): void => {
    const current = pinned
    if (current === null) return
    const pointer = event as PointerEvent
    const strip = resolve(current.paneId)
    const related = pointer.relatedTarget as Element | null
    if (strip !== null && related !== null && strip.contains(related)) return
    // Ambiguous (removal under the pointer / window leave): confirm next task.
    setTimeout(() => {
      if (pinned === current && !stillInside(pointer.clientX, pointer.clientY)) release()
    }, 0)
  }

  const onPointerOver = (event: Event): void => {
    if (pinned === null) return
    const strip = resolve(pinned.paneId)
    const target = event.target as Element | null
    if (strip !== null && target !== null && strip.contains(target)) return
    // The pointer is over something that is not the pinned strip any more.
    release()
  }

  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('pointerout', onPointerOut, true)
  doc.addEventListener('pointerover', onPointerOver, true)

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('pointerout', onPointerOut, true)
    doc.removeEventListener('pointerover', onPointerOver, true)
    if (pinned !== null) release()
  }
}
