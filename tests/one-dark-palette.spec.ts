/**
 * Byte-level guard for the shared syntax color families
 * (src/client/one-dark-palette.ts). The terminal's ANSI 16
 * (TerminalView.tsx) and CodeMirror's highlight rules (cm-themes.ts) both
 * assemble from these constants, so an accidental value edit here silently
 * re-themes every code surface in both views. The expected hexes are the
 * exact pre-single-sourcing literals from the two consumers — changing one
 * must be a deliberate, reviewable act.
 */
import { describe, expect, it } from 'vitest'
import { ONE_DARK, ONE_LIGHT } from '../src/client/one-dark-palette.ts'

describe('one-dark-palette', () => {
  it('pins the one-dark family (dark scheme) hues', () => {
    expect(ONE_DARK).toEqual({
      black: '#282c34',
      gray: '#abb2bf',
      faintGray: '#5c6370',
      white: '#ffffff',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      orange: '#d19a66',
    })
  })

  it('pins the one-light family (light scheme) hues', () => {
    expect(ONE_LIGHT).toEqual({
      black: '#383a42',
      gray: '#a0a1a7',
      faintGray: '#4f525e',
      white: '#ffffff',
      offWhite: '#fafafa',
      red: '#e45649',
      green: '#50a14f',
      yellow: '#c18401',
      blue: '#0184bc',
      magenta: '#a626a4',
      cyan: '#0997b3',
      orange: '#986801',
      link: '#4078f2',
    })
  })
})
