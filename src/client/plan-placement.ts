/**
 * Placement for the plan page's floating action and note box. The viewport
 * alone is the wrong bound: a fixed-position surface clamped only to it can
 * cover the host's title bar (window controls) when a selection sits near the
 * top of the pane, and can spill out of the sidebar into the conversation.
 * Both surfaces therefore clamp to the viewport INTERSECTED with the plan
 * document's own box.
 *
 * Pure and viewport-injectable so the rules stay unit-testable.
 */

/** The usable viewport in CSS pixels. */
export interface ViewportSize {
  readonly width: number
  readonly height: number
}

/** A rectangle in client (viewport) coordinates. */
export interface ViewportRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** The selection's viewport anchor plus the plan document's box. */
export interface PlanPopupAnchor {
  /** The selection's horizontal midpoint. */
  readonly left: number
  readonly top: number
  readonly bottom: number
  /** The plan document's border box; absent or empty falls back to the viewport. */
  readonly surface?: ViewportRect
}

export interface NoteBoxPlacement {
  readonly left: number
  readonly top: number
  /** Never wider than the document, so a narrow pane still contains it. */
  readonly width: number
  /** Caps the box height inside the document instead of the whole window. */
  readonly maxHeight: number
}

export interface FloatingActionPlacement {
  readonly left: number
  readonly top: number
  /** True when the button sits above the selection (its transform flips). */
  readonly above: boolean
}

/** The note box's natural width. */
const NOTE_WIDTH = 320
/** Upper bound for the note box's height (a textarea resized to 220px + chrome). */
const NOTE_HEIGHT = 400
/** Approximate height of the host's small button. */
const ACTION_HEIGHT = 30
/** Half-width reserved for the floating action's label when clamping. */
const ACTION_HALF_WIDTH = 80
/** Keep every floating surface this far from the safe area's edges. */
const EDGE = 12
/** Gap between the selection and either floating surface. */
const GAP = 8

interface SafeArea {
  left: number
  top: number
  right: number
  bottom: number
}

function viewportOf(size?: ViewportSize): ViewportSize {
  if (size !== undefined) return size
  return {
    width: typeof window === 'undefined' ? 1024 : window.innerWidth || 1024,
    height: typeof window === 'undefined' ? 768 : window.innerHeight || 768,
  }
}

/** The element's border box, or undefined when missing or empty (jsdom, a detached tab). */
export function surfaceOf(element: Element | null): ViewportRect | undefined {
  if (element === null) return undefined
  const box = element.getBoundingClientRect()
  return box.right > box.left && box.bottom > box.top
    ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    : undefined
}

/** The viewport minus a margin, intersected with the plan document. */
function safeAreaOf(anchor: PlanPopupAnchor, viewport: ViewportSize): SafeArea {
  const viewportArea: SafeArea = {
    left: EDGE,
    top: EDGE,
    right: viewport.width - EDGE,
    bottom: viewport.height - EDGE,
  }
  const surface = anchor.surface
  if (surface === undefined || surface.right <= surface.left || surface.bottom <= surface.top) {
    return viewportArea
  }
  const area: SafeArea = {
    left: Math.max(EDGE, surface.left),
    top: Math.max(EDGE, surface.top),
    right: Math.min(viewport.width - EDGE, surface.right),
    bottom: Math.min(viewport.height - EDGE, surface.bottom),
  }
  return area.right > area.left && area.bottom > area.top ? area : viewportArea
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Place the note box near the selection: below it when the whole box fits,
 * otherwise above it, and otherwise as close to the selection's top as the
 * safe area allows. The fallback never pins the box to the window edge — that
 * was the "random position" jump over the title bar.
 */
export function noteBoxPlacement(anchor: PlanPopupAnchor, viewportSize?: ViewportSize): NoteBoxPlacement {
  const viewport = viewportOf(viewportSize)
  const area = safeAreaOf(anchor, viewport)
  const availableWidth = Math.max(area.right - area.left, 0)
  const width = Math.min(NOTE_WIDTH, availableWidth > 0 ? availableWidth : NOTE_WIDTH)
  const left = clamp(
    anchor.left - width / 2,
    area.left,
    Math.max(area.right - width, area.left),
  )
  const height = Math.min(NOTE_HEIGHT, Math.max(area.bottom - area.top, 0))
  const below = anchor.bottom + GAP
  const above = anchor.top - height - GAP
  let top: number
  if (below + height <= area.bottom) top = below
  else if (above >= area.top) top = above
  else top = clamp(anchor.top, area.top, Math.max(area.bottom - height, area.top))
  return { left, top, width, maxHeight: Math.max(area.bottom - area.top, 0) }
}

/**
 * Place the floating "add annotation" button above the selection, flipping to
 * below it when the pane's top edge leaves no room for the flipped button.
 */
export function floatingActionPlacement(anchor: PlanPopupAnchor, viewportSize?: ViewportSize): FloatingActionPlacement {
  const viewport = viewportOf(viewportSize)
  const area = safeAreaOf(anchor, viewport)
  // A pane narrower than the button shrinks the reserved half-width too: a
  // fixed 80px would pin the centre off-centre and push the label over the edge.
  const half = Math.min(ACTION_HALF_WIDTH, Math.max(area.right - area.left, 0) / 2)
  const left = clamp(
    anchor.left,
    area.left + half,
    Math.max(area.right - half, area.left + half),
  )
  if (anchor.top - GAP - ACTION_HEIGHT >= area.top) {
    return { left, top: anchor.top - GAP, above: true }
  }
  return {
    left,
    top: Math.min(anchor.bottom + GAP, Math.max(area.bottom - ACTION_HEIGHT, area.top)),
    above: false,
  }
}
