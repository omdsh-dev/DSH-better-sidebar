/**
 * Pure geometry for the window host: size presets, centring, anchor
 * placement, viewport clamping, maximize/restore and resize-by-preset.
 *
 * Nothing here touches React or the DOM beyond reading a plain viewport
 * rectangle, so the rules are unit-testable and shared by the (uncontrolled)
 * FloatingWindow and the public window host. The contract mirrors the old
 * floating primitive deliberately: a window is kept fully on screen when it
 * fits, and otherwise keeps 48px (its title bar / its right edge) reachable —
 * a window hanging off the bottom hides its own resize corner.
 */
import { isNarrowWidth } from '../breakpoints.ts'

/** One viewport rectangle. */
export interface ViewportSize {
  readonly width: number
  readonly height: number
}

/** One window box in viewport coordinates. */
export interface WindowBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** A plain width/height pair (initial/minimum size). */
export interface WindowSize {
  readonly width: number
  readonly height: number
}

/**
 * The public content size presets. They are DEFAULTS, never absolute: every
 * one is clamped by the live viewport and the safe margin below.
 */
export type WindowSizePreset = 'collection' | 'document' | 'compact'

/** The default target size of each preset. */
export const WINDOW_SIZE_PRESETS: Record<WindowSizePreset, WindowSize> = {
  collection: { width: 720, height: 560 },
  document: { width: 880, height: 640 },
  compact: { width: 440, height: 360 },
}

/** Free space kept between a window and the viewport edge. */
export const WINDOW_VIEWPORT_MARGIN = 8
/** The resize floor (the same one the old floating window used). */
export const WINDOW_MIN_WIDTH = 320
export const WINDOW_MIN_HEIGHT = 240
/** How much of the title bar / an edge must stay reachable when a window is larger than the viewport. */
const KEEP_ON_SCREEN = 48

/** Clamp one number into `[min, max]` (max first, so an inverted range is safe). */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), Math.max(min, max))
}

/**
 * Clamp one axis of a window's origin: keep the whole window on screen when
 * it fits, otherwise keep {@link KEEP_ON_SCREEN}px of it reachable.
 */
export function clampWindowOrigin(start: number, size: number, viewport: number): number {
  const fullyInside = viewport - size - WINDOW_VIEWPORT_MARGIN
  return fullyInside >= WINDOW_VIEWPORT_MARGIN
    ? clampNumber(start, WINDOW_VIEWPORT_MARGIN, fullyInside)
    : clampNumber(start, KEEP_ON_SCREEN - size, viewport - KEEP_ON_SCREEN)
}

/**
 * The resize floor that actually fits the viewport. The 320×240 floor is a
 * DESKTOP floor: on a 320px-wide viewport a literal 320px window could not
 * honour the safe margin at all, so the floor yields to the available area
 * (a 320px phone gets a 304px window, not a window whose edges are clipped).
 */
function effectiveMin(viewport: ViewportSize, min: WindowSize): WindowSize {
  return {
    width: Math.min(min.width, Math.max(1, viewport.width - WINDOW_VIEWPORT_MARGIN * 2)),
    height: Math.min(min.height, Math.max(1, viewport.height - WINDOW_VIEWPORT_MARGIN * 2)),
  }
}

/** The usable content area after the safe margin. */
function availableSize(viewport: ViewportSize, min: WindowSize): WindowSize {
  const floor = effectiveMin(viewport, min)
  return {
    width: Math.max(floor.width, viewport.width - WINDOW_VIEWPORT_MARGIN * 2),
    height: Math.max(floor.height, viewport.height - WINDOW_VIEWPORT_MARGIN * 2),
  }
}

/**
 * The target box of one preset in the current viewport.
 *
 * Narrow viewports (phones and portrait tablets, the repo's `< 768px`
 * breakpoint) switch to the near-fullscreen form: the content scrolls and the
 * title bar stays reachable. Everything else gets the preset size, clamped.
 */
export function resolveWindowSize(
  preset: WindowSizePreset,
  viewport: ViewportSize,
  min: WindowSize = { width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT },
): WindowSize {
  const available = availableSize(viewport, min)
  if (isNarrowWidth(viewport.width)) return available
  const target = WINDOW_SIZE_PRESETS[preset]
  const floor = effectiveMin(viewport, min)
  return {
    width: clampNumber(target.width, floor.width, available.width),
    height: clampNumber(target.height, floor.height, available.height),
  }
}

/**
 * Place one already-resolved size: below-right of `anchor` when given,
 * otherwise centred, then clamped into the viewport.
 */
export function placeWindowBox(options: {
  size: WindowSize
  viewport: ViewportSize
  anchor?: HTMLElement | null
  min?: WindowSize
}): WindowBox {
  const { size, viewport, anchor } = options
  const min = options.min ?? { width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT }
  const rect = anchor?.getBoundingClientRect()
  const left = rect === undefined
    ? (viewport.width - size.width) / 2
    : rect.left
  const top = rect === undefined
    ? Math.max(WINDOW_VIEWPORT_MARGIN, (viewport.height - size.height) / 2)
    : rect.bottom + 6
  return clampWindowBox({ left, top, width: size.width, height: size.height }, viewport, min)
}

/**
 * The initial box of one window: centred by default, below-right of `anchor`
 * when the caller passed one, always clamped into the viewport.
 */
export function initialWindowBox(options: {
  preset: WindowSizePreset
  viewport: ViewportSize
  anchor?: HTMLElement | null
  min?: WindowSize
}): WindowBox {
  const { preset, viewport, anchor } = options
  const min = options.min ?? { width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT }
  const size = resolveWindowSize(preset, viewport, min)
  return placeWindowBox({ size, viewport, ...(anchor === undefined ? {} : { anchor }), min })
}

/** Clamp one box into the viewport (size first, then origin). */
export function clampWindowBox(
  box: WindowBox,
  viewport: ViewportSize,
  min: WindowSize = { width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT },
): WindowBox {
  const floor = effectiveMin(viewport, min)
  const available = availableSize(viewport, min)
  const width = clampNumber(box.width, floor.width, available.width)
  const height = clampNumber(box.height, floor.height, available.height)
  return {
    width: Math.round(width),
    height: Math.round(height),
    left: Math.round(clampWindowOrigin(box.left, width, viewport.width)),
    top: Math.round(clampWindowOrigin(box.top, height, viewport.height)),
  }
}

/** The full-viewport box a maximized window occupies. */
export function maximizedWindowBox(viewport: ViewportSize): WindowBox {
  return {
    left: 0,
    top: 0,
    width: Math.max(1, Math.round(viewport.width)),
    height: Math.max(1, Math.round(viewport.height)),
  }
}

/**
 * Resize one box to a preset while keeping its centre: an explicit size
 * change (a `size` field on `update`) must not teleport the window to the
 * corner the reader has been avoiding.
 */
export function resizeWindowBox(
  box: WindowBox,
  preset: WindowSizePreset,
  viewport: ViewportSize,
  min: WindowSize = { width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT },
): WindowBox {
  const size = resolveWindowSize(preset, viewport, min)
  const centreX = box.left + box.width / 2
  const centreY = box.top + box.height / 2
  return clampWindowBox(
    { left: centreX - size.width / 2, top: centreY - size.height / 2, ...size },
    viewport,
    min,
  )
}
