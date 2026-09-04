/**
 * CodeMirror 6 theme pieces for the sidebar editor. The editor surface
 * (background, caret, gutter) rides the DSH theme tokens so it blends with
 * the panel in both schemes; only the syntax token colors need concrete
 * values, and those come from the same designed syntax families the app's
 * code surfaces use — one-dark for dark, one-light for light
 * (one-dark-palette.ts, shared with the terminal's ANSI palette). The
 * scheme flip reconfigures these via a compartment (see TextEditor), so
 * the document, undo history and scroll survive re-theming.
 */
import { Compartment } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags, type Tag } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'
import { ONE_DARK, ONE_LIGHT } from './one-dark-palette.ts'

/** Token-driven surface shared by both schemes (pure CSS values). */
export const cmSurfaceTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code)',
  },
  '.cm-content': {
    caretColor: 'var(--dsw-alias-label-primary)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    border: 'none',
  },
})

/** Scheme-specific surface tints (selection, active line). */
function cmSurfaceTint(dark: boolean): ReturnType<typeof EditorView.theme> {
  return EditorView.theme({
    '.cm-selectionBackground, .cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
      backgroundColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    },
  })
}

/** One syntax rule: a tag (or tag set) mapped to a concrete color/style. */
interface HighlightRule {
  tag: Tag | readonly Tag[]
  color?: string
  fontStyle?: string
}

/** one-dark syntax rules (mirrors @codemirror/theme-one-dark; hues from one-dark-palette.ts). */
const HIGHLIGHTS_DARK: HighlightRule[] = [
  { tag: tags.comment, color: ONE_DARK.faintGray, fontStyle: 'italic' },
  { tag: tags.keyword, color: ONE_DARK.magenta },
  { tag: tags.string, color: ONE_DARK.green },
  { tag: tags.number, color: ONE_DARK.orange },
  { tag: tags.bool, color: ONE_DARK.orange },
  { tag: tags.atom, color: ONE_DARK.orange },
  { tag: tags.typeName, color: ONE_DARK.yellow },
  { tag: tags.className, color: ONE_DARK.yellow },
  { tag: tags.propertyName, color: ONE_DARK.red },
  { tag: tags.function(tags.variableName), color: ONE_DARK.blue },
  { tag: tags.variableName, color: ONE_DARK.red },
  { tag: tags.operator, color: ONE_DARK.cyan },
  { tag: tags.tagName, color: ONE_DARK.red },
  { tag: tags.attributeName, color: ONE_DARK.orange },
  { tag: tags.heading, color: ONE_DARK.red, fontStyle: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontStyle: 'bold' },
  { tag: tags.link, color: ONE_DARK.blue, fontStyle: 'underline' },
  { tag: tags.meta, color: ONE_DARK.yellow },
  { tag: tags.invalid, color: ONE_DARK.white, fontStyle: 'bold' },
]

/** one-light syntax rules (the light counterpart; hues from one-dark-palette.ts). */
const HIGHLIGHTS_LIGHT: HighlightRule[] = [
  { tag: tags.comment, color: ONE_LIGHT.gray, fontStyle: 'italic' },
  { tag: tags.keyword, color: ONE_LIGHT.magenta },
  { tag: tags.string, color: ONE_LIGHT.green },
  { tag: tags.number, color: ONE_LIGHT.orange },
  { tag: tags.bool, color: ONE_LIGHT.blue },
  { tag: tags.atom, color: ONE_LIGHT.blue },
  { tag: tags.typeName, color: ONE_LIGHT.yellow },
  { tag: tags.className, color: ONE_LIGHT.yellow },
  { tag: tags.propertyName, color: ONE_LIGHT.red },
  { tag: tags.function(tags.variableName), color: ONE_LIGHT.yellow },
  { tag: tags.variableName, color: ONE_LIGHT.red },
  { tag: tags.operator, color: ONE_LIGHT.black },
  { tag: tags.tagName, color: ONE_LIGHT.red },
  { tag: tags.attributeName, color: ONE_LIGHT.orange },
  { tag: tags.heading, color: ONE_LIGHT.red, fontStyle: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontStyle: 'bold' },
  { tag: tags.link, color: ONE_LIGHT.link, fontStyle: 'underline' },
  { tag: tags.meta, color: ONE_LIGHT.yellow },
  { tag: tags.invalid, color: ONE_LIGHT.white, fontStyle: 'bold' },
]

/** The scheme-dependent extension pair (surface tint + syntax highlight). */
function cmThemeExtensions(dark: boolean): Array<ReturnType<typeof EditorView.theme>> {
  return [
    cmSurfaceTint(dark),
    syntaxHighlighting(HighlightStyle.define(dark ? HIGHLIGHTS_DARK : HIGHLIGHTS_LIGHT)),
  ]
}

/**
 * A Compartment holding the two scheme-dependent extensions. Created once
 * per editor view; a scheme flip dispatches `reconfigure(dark)` on it, so
 * the document, undo history, scroll and keymaps survive re-theming.
 */
export class CmThemeCompartment {
  private readonly compartment = new Compartment()

  /** `of(...)` payload for EditorState.create. */
  of(dark: boolean): ReturnType<Compartment['of']> {
    return this.compartment.of(cmThemeExtensions(dark))
  }

  /** Reconfigure for a new scheme. */
  reconfigure(dark: boolean): ReturnType<Compartment['reconfigure']> {
    return this.compartment.reconfigure(cmThemeExtensions(dark))
  }
}
