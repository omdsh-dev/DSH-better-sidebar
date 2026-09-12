/**
 * Size written to `--dsh-sidebar-height`. The conversation column (output +
 * composer) must keep at least {@link CONVERSATION_MIN} of the viewport after
 * the bottom workbench claims height; a closed workbench pushes 0. The right
 * column belongs to DSH's native Sidebar, so this shell pushes no width.
 */
import { CONVERSATION_MIN } from './state.ts'

export interface BottomPushInput {
  /** Whether the bottom workbench is expanded. */
  open: boolean
  /** Committed (or mid-drag) bottom height in px. */
  height: number
  /** Viewport height the cap is measured against (visual viewport when known). */
  viewportHeight: number
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Compute the live layout-push height for the bottom workbench. */
export function bottomPushHeight(input: BottomPushInput): number {
  if (!input.open) return 0
  const viewportHeight = finiteNonNegative(input.viewportHeight)
  const maxHeight = Math.max(0, viewportHeight - Math.min(CONVERSATION_MIN, viewportHeight))
  return Math.min(finiteNonNegative(input.height), maxHeight)
}
