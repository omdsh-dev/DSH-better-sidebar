/**
 * The Tasks page's motion host: `@formkit/auto-animate` (FLIP) attached through
 * ONE guarded hook, so every animated container in the page behaves the same and
 * the test / non-WAAPI environments stay inert.
 *
 * Where it is used — and where it deliberately is NOT:
 *
 * - the tree view and the jobs drawer are normal FLOW containers, so a row the
 *   reader folds away fades out in place while its siblings slide up: exactly
 *   what FLIP is for;
 * - the graph CANVAS is excluded. Its card layer carries the fit's
 *   `transform: scale(k)`, and the library pins a leaving card with absolute
 *   `left/top` derived from `getBoundingClientRect()` (a box the scaled layer
 *   cannot express) and translates movers in unscaled units (k× the true
 *   distance). Measured live, that read as "折叠展开的动效都特别怪"; the canvas
 *   uses the CSS entrance on `.node` instead, and leaving cards are removed
 *   instantly — the edges they hang from are not animated, so nothing
 *   disagrees with them.
 *
 * The library needs `Element.prototype.animate` (Web Animations API — the
 * plugin already requires modern Chromium for the native sidebar) and a real
 * layout pass, so the hook attaches to nothing when either is missing: jsdom
 * renders the same DOM without motion, and no test has to stub an animation
 * engine.
 *
 * The library respects `prefers-reduced-motion` on its own (its
 * `disrespectUserMotionPreference` option defaults to false), which is the same
 * contract the bar's sweep keeps in CSS.
 */
import autoAnimate from '@formkit/auto-animate'
import { useEffect, type RefObject } from 'react'

/** Whether this environment can run FLIP animations at all. */
function canAnimate(): boolean {
  return typeof Element !== 'undefined'
    && typeof Element.prototype.animate === 'function'
    && typeof document !== 'undefined'
}

/**
 * Animate one container's children.
 *
 * @param ref - the container whose DIRECT children are animated. Layout changes
 *   below the direct children (a card's own rows) are not animated — that is the
 *   library's own scope rule, and the page keeps one host per list it wants
 *   animated.
 */
export function useAutoAnimateRef<T extends HTMLElement>(ref: RefObject<T | null>): void {
  useEffect(() => {
    const element = ref.current
    if (element === null || !canAnimate()) return
    const controller = autoAnimate(element)
    return () => { controller.destroy?.() }
  }, [ref])
}
