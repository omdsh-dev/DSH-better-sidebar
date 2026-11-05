/**
 * Pin only the closing pane's native strip. The host replaces strip DOM on
 * close: retain the panel/session + pane identity in this controller and move
 * the marker to its replacement in a MutationObserver microtask, before paint.
 * Hidden sessions, unknown markup and ambiguous panes are never eligible.
 */
import { visibleNativePanel } from './native/visible-panel.ts'

const CHIP = '[data-dockkit-tab]'
const CLOSE = '[data-dockkit-tab-close]'
const STRIP = '[data-dockkit-strip]'
/** Attribute and width live on exactly one strip, never on html or the panel. */
export const FROZEN_ATTR = 'data-dsh-tabs-frozen'
export const FROZEN_VAR = '--dsh-tab-frozen-width'

export interface StripFreezeOptions {
  /** Optional content-box measurer for DOM tests. */
  readonly measure?: (chip: HTMLElement, strip: HTMLElement) => number | undefined
  readonly doc?: Document
}

/** Measure the content box expected by the host's flex-basis. */
export function contentWidthOf(chip: HTMLElement): number | undefined {
  const rect = chip.getBoundingClientRect().width
  if (!(rect > 0)) return undefined
  const style = getComputedStyle(chip)
  const px = (value: string): number => Number.parseFloat(value) || 0
  const inner = px(style.paddingLeft) + px(style.paddingRight)
    + px(style.borderLeftWidth) + px(style.borderRightWidth)
  return Math.max(0, rect - inner)
}

/** Install gesture listeners; observers exist only for an active close run. */
export function installNativeStripFreeze(options: StripFreezeOptions = {}): () => void {
  const doc = options.doc ?? document
  const measure = options.measure ?? contentWidthOf
  type Pin = { panel: HTMLElement; session: string; pane: string; width: number; strip: HTMLElement }
  let pinned: Pin | undefined
  let observer: MutationObserver | undefined
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clearTimer = (): void => {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer)
    leaveTimer = undefined
  }
  const unmark = (strip: HTMLElement): void => {
    strip.removeAttribute(FROZEN_ATTR)
    strip.style.removeProperty(FROZEN_VAR)
  }
  const release = (): void => {
    observer?.disconnect()
    observer = undefined
    clearTimer()
    if (pinned !== undefined) unmark(pinned.strip)
    pinned = undefined
  }
  const resolve = (): HTMLElement | undefined => {
    const pin = pinned
    if (pin === undefined || visibleNativePanel(doc) !== pin.panel
      || pin.panel.getAttribute('data-sidebar-right-session') !== pin.session) return undefined
    const strips = [...pin.panel.querySelectorAll<HTMLElement>(STRIP)]
      .filter(strip => strip.getAttribute('data-dockkit-strip') === pin.pane)
    return strips.length === 1 ? strips[0] : undefined
  }
  const sync = (): void => {
    const pin = pinned
    if (pin === undefined) return
    const strip = resolve()
    if (strip === undefined) { release(); return }
    if (pin.strip !== strip) {
      unmark(pin.strip)
      pin.strip = strip
    }
    const value = `${pin.width}px`
    if (strip.style.getPropertyValue(FROZEN_VAR) !== value) strip.style.setProperty(FROZEN_VAR, value)
    if (!strip.hasAttribute(FROZEN_ATTR)) strip.setAttribute(FROZEN_ATTR, '')
  }
  const stripOf = (target: EventTarget | null): HTMLElement | undefined =>
    (target as Element | null)?.closest?.<HTMLElement>(STRIP) ?? undefined

  const onPointerDown = (event: Event): void => {
    if (disposed) return
    // Validate a stale pin even if no mutation microtask has run yet.
    if (pinned !== undefined && resolve() === undefined) release()
    const target = event.target as Element | null
    const strip = stripOf(target)
    const panel = visibleNativePanel(doc)
    if (strip === undefined || panel === undefined || !panel.contains(strip)) return
    const chip = target?.closest<HTMLElement>(CHIP)
    const mouse = event as MouseEvent
    if (chip == null || !strip.contains(chip)
      || !(mouse.button === 1 || (mouse.button === 0 && target?.closest(CLOSE) != null))) return
    if (pinned !== undefined) return
    const pane = strip.getAttribute('data-dockkit-strip')
    const session = panel.getAttribute('data-sidebar-right-session')
    if (pane === null || pane === '' || session === null) return
    const width = measure(chip, strip)
    if (width === undefined || !Number.isFinite(width) || width <= 0) return
    pinned = { panel, session, pane, width, strip }
    if (resolve() !== strip) { release(); return }
    sync()
    // The ancestor hidden flag is how the SDK parks retained sessions. Watch
    // only while pinned, and cancel both observation and deferred work on hide.
    const Observer = doc.defaultView?.MutationObserver
    if (Observer !== undefined) {
      observer = new Observer(records => {
        const pin = pinned
        if (pin === undefined) return
        const relevant = records.some(record => {
          if (record.type === 'attributes') {
            if (record.attributeName === 'data-dockkit-strip') return true
            return record.target === pin.panel || (record.target as Node).contains(pin.panel)
          }
          // Ignore text/chip-body streaming. Only strip/panel structure matters.
          return [...record.addedNodes, ...record.removedNodes].some(node => {
            if (node === pin.panel || node.contains(pin.panel)) return true
            if (node.nodeType !== 1) return false
            const element = node as Element
            return element.matches(STRIP) || element.querySelector(STRIP) !== null
          })
        })
        if (relevant) sync()
      })
      // Session parking/collapse lives on the panel and its ancestors. Observe
      // those attributes directly, never body subtree style/chat mutations.
      for (let ancestor: HTMLElement | null = panel; ancestor !== null; ancestor = ancestor.parentElement) {
        observer.observe(ancestor, { childList: true, attributes: true,
          attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'data-sidebar-right-session', 'data-sidebar-right-open'] })
      }
      // observe() replaces options for an already observed node: include the
      // panel's subtree again while excluding our own strip style writes.
      observer.observe(panel, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'data-sidebar-right-session', 'data-sidebar-right-open', 'data-dockkit-strip'] })
    }
  }
  const onPointerOut = (event: Event): void => {
    const pin = pinned
    if (pin === undefined) return
    // Ignore unrelated document pointerout traffic. The detached old strip is
    // also accepted so host replacement can still use the deferred hit test.
    const source = stripOf(event.target)
    if (source !== pin.strip && source?.getAttribute('data-dockkit-strip') !== pin.pane) return
    const pointer = event as PointerEvent
    const strip = resolve()
    if (strip !== undefined && pointer.relatedTarget !== null && strip.contains(pointer.relatedTarget as Node)) return
    clearTimer()
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined
      if (pinned !== pin) return
      const live = resolve()
      let under: Element | null = null
      try { under = doc.elementFromPoint(pointer.clientX, pointer.clientY) } catch { /* no hit test: release */ }
      if (live === undefined || under === null || !live.contains(under)) release()
    }, 0)
  }
  const onPointerOver = (event: Event): void => {
    if (pinned === undefined) return
    const strip = resolve()
    if (strip !== undefined && event.target !== null && strip.contains(event.target as Node)) return
    release()
  }
  const onBlur = (): void => { release() }
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('pointerout', onPointerOut, true)
  doc.addEventListener('pointerover', onPointerOver, true)
  doc.defaultView?.addEventListener('blur', onBlur)
  return () => {
    disposed = true
    release()
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('pointerout', onPointerOut, true)
    doc.removeEventListener('pointerover', onPointerOver, true)
    doc.defaultView?.removeEventListener('blur', onBlur)
  }
}
