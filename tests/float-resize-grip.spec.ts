/**
 * A floating tab must be resizable by pointer.
 *
 * The host renders the float's 20×20 resize grip (`data-dockkit-float-resize`)
 * as its LAST child but at `z-index: auto`. Tab content that stacks above it
 * takes the bottom-right corner away from the grip: on the real app a
 * floating Git tab could not be resized at all (its footer is
 * `position: sticky; z-index: 1`), while a floating file tab — whose bottom
 * edge carries no stacking bar — resized normally. The failure is silent:
 * the corner glyph never appears and the cursor never becomes `nwse-resize`.
 *
 * Two guards: the host hook is raised above that class of content (also
 * covering third-party tab bodies we do not own), and the Git footer no
 * longer stacks on its own, so the grip wins even on a host build without the
 * attribute hook.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Strip block comments so prose mentions are not read as declarations. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')

const shellCss = stripComments(readFileSync('src/client/sidebar.module.css', 'utf8'))
const changesCss = stripComments(readFileSync('src/client/changes/changes.module.css', 'utf8'))

describe('floating tab resize grip', () => {
  it('raises the host grip above content that stacks at z-index 1', () => {
    const rule = shellCss.match(/:global\(\[data-dockkit-float-resize\]\)\s*\{([^}]*)\}/)?.[1]
    expect(rule, 'the [data-dockkit-float-resize] global rule must exist').toBeDefined()
    const zIndex = Number(rule!.match(/z-index:\s*(\d+)/)?.[1])
    // The Git footer used to stack at 1; anything <= 1 leaves it covering the
    // grip again. Pin "above 1" rather than the exact literal so a future
    // host/content z-index bump can move the value without re-breaking this.
    expect(Number.isFinite(zIndex)).toBe(true)
    expect(zIndex).toBeGreaterThan(1)
  })

  it('keeps the Git footer from stacking over the grip', () => {
    const footer = changesCss.match(/\.gitFooter\s*\{([^}]*)\}/)?.[1]
    expect(footer, 'the .gitFooter rule must exist').toBeDefined()
    // Sticky stays: the footer must survive the host tab body scrolling.
    expect(footer).toMatch(/position:\s*sticky/)
    expect(footer).toMatch(/bottom:\s*0/)
    expect(footer).not.toMatch(/(?:^|[;\s])z-index\s*:/)
  })
})
