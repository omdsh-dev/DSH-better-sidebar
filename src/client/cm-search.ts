/**
 * Find-in-file for the sidebar editor: CodeMirror's own search extension,
 * wired into every TextEditor view (code and markdown alike, edit and
 * preview mode — the extension lives in the shared base extension list, not
 * in an editable-only branch).
 *
 * Three pieces:
 *  - `search({ top: true })` pins the panel to the TOP of the editor
 *    (CodeMirror's default is the bottom), so it reads like a browser/IDE
 *    find bar and never covers the caret's line.
 *  - `keymap.of(searchKeymap)` binds the upstream default keys: Mod-f opens
 *    the panel, Mod-g / Shift-Mod-g jump next/previous, Mod-Alt-g goes to a
 *    line, Escape closes. The editor's own keymap is registered AFTER this
 *    one, so upstream bindings never shadow it (the only shared key is
 *    Escape, and `closeSearchPanel` returns false when no panel is open —
 *    the editor's `simplifySelection` still runs then).
 *  - the panel's copy comes from the `phrases` facet, which CodeMirror reads
 *    at panel-build time. The facet is part of the EditorState, so a language
 *    switch must reconfigure it — {@link CmSearchPhrases} is that
 *    compartment (the document, history, and keymaps survive).
 *
 * The panel chrome is re-themed with the app's design tokens
 * ({@link cmSearchTheme}): CodeMirror's stock panel paints its own light
 * palette (`&light` selectors resolve as light because the editor theme does
 * not declare `dark`), which would sit as a gray/white box inside a
 * dark-mode sidebar. Only the token-driven chrome is overridden — the match
 * highlight overlays stay CodeMirror's translucent defaults, which read on
 * both schemes.
 */
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { search, searchKeymap } from '@codemirror/search'
import { t } from './locales.ts'

/**
 * CodeMirror's own phrase keys → this plugin's dictionary keys. The keys are
 * the exact literals @codemirror/search looks up (see its SearchPanel /
 * announceMatch / gotoLine panel); `$` inside a value is CodeMirror's
 * placeholder, replaced with the caller's argument when the phrase is
 * resolved (`EditorState.phrase`), so the dictionary entries keep it
 * verbatim.
 */
function searchPhrases(): Record<string, string> {
  return {
    'Find': t('searchFind'),
    'Replace': t('searchReplace'),
    'next': t('searchNext'),
    'previous': t('searchPrevious'),
    'all': t('searchAll'),
    'match case': t('searchMatchCase'),
    'by word': t('searchWholeWord'),
    'regexp': t('searchRegexp'),
    'replace': t('searchReplace'),
    'replace all': t('searchReplaceAll'),
    // The close button is only an aria-label (the visible glyph is `×`) —
    // the generic "close" key fits and needs no new dictionary entry.
    'close': t('close'),
    'current match': t('searchCurrentMatch'),
    'on line': t('searchOnLine'),
    'replaced $ matches': t('searchReplacedMatches'),
    'replaced match on line $': t('searchReplacedMatchOnLine'),
    'Go to line': t('searchGoToLine'),
    'go': t('searchGo'),
  }
}

/** The search panel chrome on design tokens (no hardcoded colors). */
export const cmSearchTheme = EditorView.theme({
  '.cm-panels.cm-panels-top': {
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-panel.cm-search': {
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
  },
  '.cm-panel.cm-search input.cm-textfield': {
    backgroundColor: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '3px',
  },
  '.cm-panel.cm-search input.cm-textfield:focus': {
    border: '1px solid var(--dsw-alias-brand-primary)',
    outline: 'none',
  },
  '.cm-panel.cm-search button.cm-button': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
    backgroundImage: 'none',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-panel.cm-search button.cm-button:hover': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover-accent)',
  },
  '.cm-panel.cm-search button.cm-button:active': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-active)',
    backgroundImage: 'none',
  },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': {
    color: 'var(--dsw-alias-label-primary)',
  },
  '.cm-panel.cm-search label': {
    color: 'var(--dsw-alias-label-secondary)',
  },
})

/**
 * The scheme-independent part of the find-in-file wiring: the top-pinned
 * panel, its theme, and the upstream search keymap. The localized phrases
 * are added separately through {@link CmSearchPhrases} (they are the only
 * piece a language switch reconfigures).
 */
export function cmSearchExtensions(): Extension[] {
  return [search({ top: true }), cmSearchTheme, keymap.of(searchKeymap)]
}

/**
 * A Compartment holding the localized `phrases` facet. Created once per
 * editor view; a language switch dispatches `reconfigure()` on it, which
 * rebuilds the panel copy on its next open without touching the document,
 * undo history, or keymaps.
 */
export class CmSearchPhrases {
  private readonly compartment = new Compartment()

  /** `of(...)` payload for EditorState.create. */
  of(): Extension {
    return this.compartment.of(EditorState.phrases.of(searchPhrases()))
  }

  /** Re-resolve the panel copy for the current language. */
  reconfigure(): StateEffect<unknown> {
    return this.compartment.reconfigure(EditorState.phrases.of(searchPhrases()))
  }
}
