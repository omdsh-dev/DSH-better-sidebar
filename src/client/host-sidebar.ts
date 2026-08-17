/**
 * Auto-keep the host's LEFT sidebar expanded (v0.13).
 *
 * The plugin's right panel squeezes the app shell via
 * `#root { margin-right: var(--dsh-sidebar-width) }` (layout.css), so the
 * host's AppFrame gets narrower by exactly the panel width. The host
 * (ui-layout) decides its own "narrow viewport" from the FRAME's rendered
 * box — not the window — and below its `SIDEBAR_AUTO_COLLAPSE` breakpoint
 * it auto-collapses its left sidebar to the 56px rail. Net effect: opening
 * the right panel can silently collapse the host's left sidebar whenever
 * `window width − panel width < 1024` (with the default 30% panel, any
 * window under ≈1463px).
 *
 * This keeper re-expands the host sidebar in exactly that situation — and
 * ONLY in that situation — through `ctx.layout.toggleSidebar()`: once the
 * host is in narrow mode, its toggle flips the `narrowExpanded` override
 * (re-expand over the squeezed center) instead of closing the sidebar.
 *
 * It is a crossing-triggered state machine, deliberately NOT a constant
 * re-expander:
 *
 *  - ARM only on a real ≥1024 → <1024 frame-width crossing while OUR push
 *    is live and the window itself is not below the host breakpoint. A
 *    user ⌘B collapse never changes the frame width, so it never arms.
 *  - CONSUME only on the frame's `data-sidebar-collapsed` attribute
 *    APPEARING (mutation, not state): a collapse that predates the
 *    crossing (the user collapsed the sidebar before opening the panel)
 *    fires no mutation, so it is never fought.
 *  - The arm clears itself when the frame recovers (≥1024), when the push
 *    goes away (panel closed), or when any collapse-state change settles
 *    it — no stale re-expands, no feedback loops.
 */
/** Mirror of ui-layout's SIDEBAR_AUTO_COLLAPSE (deepsuite LG breakpoint). */
export const HOST_SIDEBAR_AUTO_COLLAPSE = 1024

/** The keeper's inputs, resolved at event time (never cached). */
export interface HostSidebarKeeperOptions {
  /** Whether the right panel's layout push is currently live. */
  isPushLive(): boolean
  /** The window width (the "genuinely narrow" gate). */
  windowWidth(): number
}

/** The keeper machine: feed it frame observations + collapse-state changes. */
export interface HostSidebarKeeper {
  /**
   * One frame-width observation (feed from a ResizeObserver on the
   * AppFrame; rAF-throttled upstream). Arms the re-expand on a real
   * ≥1024 → <1024 crossing caused by our push.
   */
  onFrameResize(width: number): void
  /**
   * One change of the frame's `data-sidebar-collapsed` attribute. Returns
   * true exactly once per armed crossing, when the collapse APPEARED —
   * the caller should re-expand the host sidebar (ctx.layout.toggleSidebar).
   */
  onCollapsedAttrChanged(collapsed: boolean): boolean
}

/** Create one keeper instance (per Sidebar mount; no module-level state). */
export function createHostSidebarKeeper(options: HostSidebarKeeperOptions): HostSidebarKeeper {
  const { isPushLive, windowWidth } = options
  let armed = false
  let prevWidth: number | undefined
  return {
    onFrameResize(width: number): void {
      const prev = prevWidth
      prevWidth = width
      // Recovery (frame back above the breakpoint) or a dead push clears
      // the arm: the host will restore (or keep) the sidebar by itself.
      if (width >= HOST_SIDEBAR_AUTO_COLLAPSE || !isPushLive()) {
        armed = false
        return
      }
      // A real crossing while our push is live on a window that is not
      // itself below the breakpoint: OUR squeeze caused the collapse.
      if (
        prev !== undefined
        && prev >= HOST_SIDEBAR_AUTO_COLLAPSE
        && windowWidth() >= HOST_SIDEBAR_AUTO_COLLAPSE
      ) {
        armed = true
      }
    },
    onCollapsedAttrChanged(collapsed: boolean): boolean {
      if (!armed) return false
      armed = false
      // Consume only the APPEARANCE; a disappearance means the host
      // restored itself (nothing to do).
      return collapsed
    },
  }
}
