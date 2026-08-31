/**
 * CodeMirror 6 theme pieces for the sidebar editor. The editor surface
 * (background, caret, gutter) rides the DSH theme tokens so it blends with
 * the panel in both schemes; only the syntax token colors need concrete
 * values, and those come from the same designed palettes the app's code
 * surfaces use — the one-dark family for dark, the one-light family for
 * light. The scheme flip reconfigures these via a compartment (see
 * TextEditor), so the document, undo history and scroll survive re-theming.
 */
import { Compartment } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags, type Tag } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'

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
  // The find panel (@codemirror/search). Its stock chrome is a grey browser
  // default that reads as broken against the DSH surfaces, so every part of
  // it is re-tokenized here. Same visual language as the preview's find bar
  // (md-find.tsx), so Cmd+F looks like one feature in both modes.
  '.cm-panels': {
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    border: 'none',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-panel.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
    padding: '5px 6px',
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
    font: 'var(--dsw-font-xs-13)',
  },
  '.cm-panel.cm-search input': {
    padding: '3px 6px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    outline: 'none',
  },
  '.cm-panel.cm-search input[type=checkbox]': {
    padding: '0',
    border: 'none',
    verticalAlign: 'middle',
  },
  '.cm-panel.cm-search label': {
    color: 'var(--dsw-alias-label-secondary)',
    font: 'var(--dsw-font-xxs-12)',
  },
  '.cm-panel.cm-search button': {
    padding: '3px 8px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    backgroundColor: 'transparent',
    backgroundImage: 'none',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'var(--dsw-font-xxs-12)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search button:hover': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
  },
  // The close affordance is an unlabelled glyph; give it a hit box.
  '.cm-panel.cm-search button[name=close]': {
    padding: '0 6px',
    border: 'none',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '16px',
    lineHeight: '1',
  },
  // Compact mode (the default, see FIND_COMPACT_CLASS in TextEditor.tsx).
  // The stock panel carries ten controls, which wrap into five rows inside a
  // 280px sidebar. Searching is the common case by a wide margin, so the
  // default keeps one row — field, next, back, close — and Mod-Alt-f opens
  // the full panel with replace and the toggles.
  '&.dsh-find-compact .cm-panel.cm-search label': { display: 'none' },
  '&.dsh-find-compact .cm-panel.cm-search br': { display: 'none' },
  '&.dsh-find-compact .cm-panel.cm-search button[name=select]': { display: 'none' },
  '&.dsh-find-compact .cm-panel.cm-search input[name=replace]': { display: 'none' },
  '&.dsh-find-compact .cm-panel.cm-search button[name=replace]': { display: 'none' },
  '&.dsh-find-compact .cm-panel.cm-search button[name=replaceAll]': { display: 'none' },
  // The field takes the row; the three controls sit flush at its right.
  '&.dsh-find-compact .cm-panel.cm-search': { flexWrap: 'nowrap' },
  '&.dsh-find-compact .cm-panel.cm-search input[name=search]': { flex: '1 1 auto', minWidth: '0' },
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
    // Find matches. The selected one is the stronger tint, mirroring the
    // preview find bar's current-vs-other match pair.
    '.cm-searchMatch': {
      backgroundColor: dark ? 'rgba(96,165,250,0.28)' : 'rgba(59,130,246,0.24)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: dark ? 'rgba(96,165,250,0.62)' : 'rgba(59,130,246,0.52)',
    },
  })
}

/** One syntax rule: a tag (or tag set) mapped to a concrete color/style. */
interface HighlightRule {
  tag: Tag | readonly Tag[]
  color?: string
  fontStyle?: string
}

/** one-dark syntax palette (mirrors @codemirror/theme-one-dark). */
const HIGHLIGHTS_DARK: HighlightRule[] = [
  { tag: tags.comment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#c678dd' },
  { tag: tags.string, color: '#98c379' },
  { tag: tags.number, color: '#d19a66' },
  { tag: tags.bool, color: '#d19a66' },
  { tag: tags.atom, color: '#d19a66' },
  { tag: tags.typeName, color: '#e5c07b' },
  { tag: tags.className, color: '#e5c07b' },
  { tag: tags.propertyName, color: '#e06c75' },
  { tag: tags.function(tags.variableName), color: '#61afef' },
  { tag: tags.variableName, color: '#e06c75' },
  { tag: tags.operator, color: '#56b6c2' },
  { tag: tags.tagName, color: '#e06c75' },
  { tag: tags.attributeName, color: '#d19a66' },
  { tag: tags.heading, color: '#e06c75', fontStyle: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontStyle: 'bold' },
  { tag: tags.link, color: '#61afef', fontStyle: 'underline' },
  { tag: tags.meta, color: '#e5c07b' },
  { tag: tags.invalid, color: '#ffffff', fontStyle: 'bold' },
]

/** one-light syntax palette (the light counterpart of one-dark). */
const HIGHLIGHTS_LIGHT: HighlightRule[] = [
  { tag: tags.comment, color: '#a0a1a7', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#a626a4' },
  { tag: tags.string, color: '#50a14f' },
  { tag: tags.number, color: '#986801' },
  { tag: tags.bool, color: '#0184bc' },
  { tag: tags.atom, color: '#0184bc' },
  { tag: tags.typeName, color: '#c18401' },
  { tag: tags.className, color: '#c18401' },
  { tag: tags.propertyName, color: '#e45649' },
  { tag: tags.function(tags.variableName), color: '#c18401' },
  { tag: tags.variableName, color: '#e45649' },
  { tag: tags.operator, color: '#383a42' },
  { tag: tags.tagName, color: '#e45649' },
  { tag: tags.attributeName, color: '#986801' },
  { tag: tags.heading, color: '#e45649', fontStyle: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontStyle: 'bold' },
  { tag: tags.link, color: '#4078f2', fontStyle: 'underline' },
  { tag: tags.meta, color: '#c18401' },
  { tag: tags.invalid, color: '#ffffff', fontStyle: 'bold' },
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
