/**
 * The Tasks page's motion contract, pinned where a refactor would break it
 * silently:
 *
 * - the CANVAS must not run a FLIP library. Its card layer carries the fit's
 *   `transform: scale(k)`, and `@formkit/auto-animate` pins a leaving card with
 *   absolute `left/top` from `getBoundingClientRect()` (a box a scaled layer
 *   cannot express — the card jumps) and translates movers in unscaled units
 *   (k× the true distance). Attached there, it was reported as "折叠展开的动效
 *   都特别怪"; the canvas uses the CSS entrance on `.node` instead.
 * - the FLOW surfaces (tree rows, jobs rows) are where FLIP belongs, and they
 *   keep it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** One source file of the client half. */
function source(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8')
}

/**
 * A source file with its comments removed. The NEGATIVE assertions below are
 * about what the code does, and these files deliberately DOCUMENT the library
 * they avoid ("measures `getBoundingClientRect()`…"), so matching raw text
 * would fail on the very explanation we want to keep.
 */
function code(relative: string): string {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('Tasks page motion', () => {
  it('keeps the FLIP library off the scaled canvas, and on the flow surfaces', () => {
    expect(code('src/client/TasksGraph.tsx')).not.toContain('use-auto-animate')
    expect(source('src/client/TasksTree.tsx')).toContain('useAutoAnimateRef')
    expect(source('src/client/JobsDrawer.tsx')).toContain('useAutoAnimateRef')
  })

  it('gives canvas cards a mount-only CSS entrance that respects reduced motion', () => {
    const styles = source('src/client/tasks-graph.module.css')
    const node = /\.node \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (node === undefined) throw new Error('the .node rule must exist')
    expect(node).toContain('animation: dsh-card-in')
    const frames = /@keyframes dsh-card-in \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (frames === undefined) throw new Error('the card entrance keyframes must exist')
    expect(frames).toContain('opacity: 0')
    // Every reduced-motion block in the sheet is a candidate — the sweep has
    // its own — and the card entrance must be switched off in one of them.
    const reduced = [...styles.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
      .map(match => match[1])
      .join('\n')
    expect(reduced).toContain('.node')
  })

  it('animates the canvas in LAYOUT coordinates, never with screen-space transforms', () => {
    // The canvas's own tween: `left`/`top` are canvas units, so the fit's scale
    // applies to the tween exactly as it applies to the final positions — and
    // the connectors (pure functions of the boxes) travel with the cards.
    expect(source('src/client/TasksGraph.tsx')).toContain('useTweenedLayout')
    const tween = code('src/client/tasks-layout-tween.ts')
    expect(tween).toContain('requestAnimationFrame')
    // No rect measuring in the CODE: that is exactly what makes a scaled layer
    // unrepresentable for a FLIP library.
    expect(tween).not.toContain('getBoundingClientRect')
    // The card entrance is staggered, so a revealed group cascades.
    expect(source('src/client/TasksGraph.tsx')).toContain('animationDelay')
  })

  it('keeps the frame auto-fitted across a fold, by GLIDING rather than jumping', () => {
    const graph = code('src/client/TasksGraph.tsx')
    // Folding must not claim the view: while the reader has not taken over, a
    // layout change glides the frame to the new fit, so an expanded group stays
    // centred and inside the panel without yanking the view.
    expect(graph).not.toContain('markTouched')
    // The untouched-view path GLIDES to the new framing; a fresh session snaps
    // (the content changes wholesale), and the reader's own gestures cancel a
    // glide in flight.
    expect(graph).toContain('if (!touchedRef.current) fitRef.current(true)')
    expect(graph).toContain('fitRef.current(false)')
    expect(graph).toContain('stopGlide()')
  })

  it('gives every NESTED tree level its own FLIP host', () => {
    // The library watches a container's direct children only: one host on the
    // scroll container would animate the top level and let every nested fold
    // blink. TreeLevel exists to own one per level.
    const tree = code('src/client/TasksTree.tsx')
    expect(tree).toContain('function TreeLevel')
    expect(tree).toContain('useAutoAnimateRef')
    expect(tree).toContain('<TreeLevel')
  })

  it('parks the motion host behind a WAAPI guard so tests and old hosts stay inert', () => {
    const hook = source('src/client/use-auto-animate.ts')
    expect(hook).toContain("typeof Element.prototype.animate === 'function'")
  })
})
