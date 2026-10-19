/**
 * Middle-click close for the host right-Sidebar tab chips.
 *
 * The host's dockkit strip treats a chip press as a drag or a selection and
 * only special-cases the secondary button, and its callback bag has no
 * middle-button route a plugin could hook. The chips do carry the tab id
 * (`data-dockkit-tab`) and, while the host's own closability rule allows, a
 * nested `data-dockkit-tab-close` control — that rule projected onto the DOM —
 * so the gesture is delegated here instead.
 *
 * The press is taken in the CAPTURE phase on two events for two reasons:
 * `pointerdown` must not reach the chip handler (the host starts a drag from
 * it), and `mousedown` must be preventDefaulted to disarm the browser's
 * middle-click autoscroll. The close settles on the first middle `mouseup` over
 * the pressed chip — release-position semantics matching the plugin's own tab
 * strip and VS Code: pressing a chip and releasing elsewhere cancels.
 */

/** A chip this module may act on: its element and the tab id it names. */
interface ChipPress {
  readonly chip: HTMLElement
  readonly id: string
}

export interface TabMiddleClickDeps {
  /** Close one tab id through the plugin's own close path, lifecycle included. */
  closeTab: (tabId: string) => void
}

const CHIP = '[data-dockkit-tab]'
const CHIP_CLOSE = '[data-dockkit-tab-close]'

/**
 * The closable chip a pointer event landed in.
 * @param target - the event target.
 * @returns the chip and its tab id, or undefined when the press is not on a closable chip.
 */
function chipOf(target: EventTarget | null): ChipPress | undefined {
  if (!(target instanceof Element)) return undefined
  const chip = target.closest(CHIP)
  if (!(chip instanceof HTMLElement)) return undefined
  // Only a closable chip answers: the host draws the nested close control
  // exactly while its own rule allows, so the gesture inherits that rule
  // instead of restating it. A lone, unclosable chip keeps browser defaults.
  if (chip.querySelector(CHIP_CLOSE) === null) return undefined
  const id = chip.dataset.dockkitTab
  if (id === undefined || id === '') return undefined
  return { chip, id }
}

/**
 * Install the delegated middle-click close.
 * @param deps - the close entry point.
 * @returns a disposer removing every listener and dropping a pending press.
 */
export function registerTabMiddleClick(deps: TabMiddleClickDeps): () => void {
  let pressed: ChipPress | undefined

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 1) return
    const target = chipOf(event.target)
    if (target === undefined) return
    // The host begins a chip drag from this event.
    event.stopPropagation()
    pressed = target
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 1) return
    const target = chipOf(event.target)
    if (target === undefined) return
    // Chromium's middle-click autoscroll starts here.
    event.preventDefault()
    pressed = target
  }

  const onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 1) return
    const target = pressed
    pressed = undefined
    if (target === undefined) return
    // Close only when the release lands on the pressed chip; a drag-away
    // release cancels the press (one-shot per press).
    if (!target.chip.isConnected) return
    if (event.target instanceof Node && !target.chip.contains(event.target)) return
    deps.closeTab(target.id)
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onMouseUp, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    pressed = undefined
  }
}
