/**
 * The single source for the syntax color families the app's code surfaces
 * use: one-dark for the dark scheme, one-light for the light scheme. Two
 * lazy-chunk consumers assemble their theme objects from these constants —
 * the terminal's curated ANSI 16 (TerminalView.tsx) and CodeMirror's
 * highlight rules (cm-themes.ts) — so a family color is defined exactly
 * once and the two views can never drift apart.
 *
 * The palette holds only the syntax hues; surface colors (background,
 * foreground, caret, gutter) are theme-token driven and selection tints /
 * token-fallback colors stay with their consumers (they are not part of
 * the designed syntax families).
 *
 * Chunk boundary: this module is inlined into BOTH lazy chunks that import
 * it (terminal and editor) — the constants are plain strings, the per-chunk
 * copy is a few hundred bytes, and no cross-chunk import is introduced. The
 * core bundle does not (and must not) import this module.
 */

/** one-dark family (dark scheme) syntax hues. */
export const ONE_DARK = {
  /** Editor-background tone; ANSI black. */
  black: '#282c34',
  /** Default foreground gray; ANSI white. */
  gray: '#abb2bf',
  /** Comment gray; ANSI bright black. */
  faintGray: '#5c6370',
  /** Pure white; ANSI bright white and the invalid-token color. */
  white: '#ffffff',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  /** Numbers, bools, atoms, attribute names. */
  orange: '#d19a66',
} as const

/** one-light family (light scheme) syntax hues. */
export const ONE_LIGHT = {
  /** Foreground dark; ANSI black and the operator color. */
  black: '#383a42',
  /** Comment gray; ANSI white. */
  gray: '#a0a1a7',
  /** ANSI bright black. */
  faintGray: '#4f525e',
  /** Pure white; the invalid-token color (stays white in light for contrast). */
  white: '#ffffff',
  /** Off-white; ANSI bright white. */
  offWhite: '#fafafa',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#0184bc',
  magenta: '#a626a4',
  cyan: '#0997b3',
  /** Numbers and attribute names. */
  orange: '#986801',
  /** Markdown links — the light family's dedicated link blue (dark rides blue). */
  link: '#4078f2',
} as const
