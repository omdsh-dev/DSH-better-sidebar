/**
 * "Static panels cast no shadow" — the elevation half of the task page's
 * design language.
 *
 * The pre-migration page gave every card, node and row its own tinted,
 * shadowed box, which is what made a graph with many nodes look garish; the
 * rework replaced elevation with 1px hairlines and the surface ladder
 * (background / card / popover). Shadows survive only on layers that really
 * float above the page and are positioned by their own anchor: the
 * `AnchoredPopover` shell (the task window / node popover chassis), and the
 * vendored `popover` / `dropdown-menu` / `tooltip` primitives, which render
 * into a portal.
 *
 * The guard is deliberately source-level: a `shadow-*` utility dropped into a
 * static panel is exactly the regression, and the class name is the only place
 * it is visible (Tailwind generates the CSS at build time).
 */
// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const VENDORED_UI_DIR = 'src/client/ui'

/** Panels that are laid out IN the page: they may never paint a shadow. */
const STATIC_PANEL_FILES = [
  'src/client/SubagentView.tsx',
  'src/client/SubagentView.module.css',
  'src/client/TasksGraph.tsx',
  'src/client/TasksTree.tsx',
  'src/client/TaskWindow.tsx',
  'src/client/TeamBoard.tsx',
  'src/client/JobsDrawer.tsx',
  'src/client/TasksPopovers.tsx',
  'src/client/tasks-shared.tsx',
  'src/client/tasks-canvas.module.css',
]

/** The only files allowed to paint an elevation shadow (floating layers). */
const FLOATING_FILES = [
  'src/client/AnchoredPopover.tsx',
  `${VENDORED_UI_DIR}/popover.tsx`,
  `${VENDORED_UI_DIR}/dropdown-menu.tsx`,
  `${VENDORED_UI_DIR}/tooltip.tsx`,
]

/**
 * Tailwind's elevation utilities (`shadow`, `shadow-md`, `shadow-[…]`,
 * `shadow-inner`, …) — but NOT `box-shadow`, which is how the components spell
 * the focus-ring transition (`transition-[color,box-shadow]`) and the ring
 * plumbing (`--tw-shadow`).
 */
const SHADOW_UTILITY = /(?<![-\w])shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|none)|\[|\()/

/** A literal `box-shadow` declaration is the same defect in stylesheet form. */
const BOX_SHADOW_DECLARATION = /(?:^|;)\s*box-shadow\s*:/

/** Comments are prose about shadows ("no shadow — a node never floats"). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const read = (file: string) => stripComments(readFileSync(resolve(ROOT, file), 'utf8'))

describe('task page: static panels cast no shadow', () => {
  it.each(STATIC_PANEL_FILES)('%s carries no shadow utility', (file) => {
    expect(read(file), file).not.toMatch(SHADOW_UTILITY)
  })

  it('no migrated stylesheet declares box-shadow', () => {
    for (const file of [...STATIC_PANEL_FILES, ...FLOATING_FILES].filter(name => name.endsWith('.css'))) {
      expect(read(file), file).not.toMatch(BOX_SHADOW_DECLARATION)
    }
  })

  it('keeps the shadow in the floating allowlist only', () => {
    const uiFiles = readdirSync(resolve(ROOT, VENDORED_UI_DIR))
      .filter(name => /\.(?:tsx|ts|css)$/.test(name))
      .map(name => `${VENDORED_UI_DIR}/${name}`)
    const surface = [...STATIC_PANEL_FILES, ...FLOATING_FILES, ...uiFiles]
    for (const file of new Set(surface)) {
      if (FLOATING_FILES.includes(file)) continue
      expect(read(file), file).not.toMatch(SHADOW_UTILITY)
    }
  })

  it('is not a dead allowlist: the popover shell really floats', () => {
    // AnchoredPopover is the migration's own floating surface; if it stops
    // carrying the shadow, this allowlist is hiding a regression elsewhere.
    expect(read('src/client/AnchoredPopover.tsx')).toMatch(SHADOW_UTILITY)
  })
})
