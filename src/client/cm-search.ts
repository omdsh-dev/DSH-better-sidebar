/**
 * Find-in-file for the sidebar editor: CodeMirror's own search extension,
 * wired into every TextEditor view (code and markdown alike, edit and
 * preview mode — the extension lives in the shared base extension list, not
 * in an editable-only branch).
 *
 * Four pieces:
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
 * - the CONTENT-SEARCH highlight ({@link setContentSearchSeed} +
 *    {@link contentSearchHighlighter}): a state field carries the query a
 *    result row was found with, and a view plugin paints every match even
 *    while the find panel is CLOSED — CodeMirror's own `.cm-searchMatch` only
 *    exists with the panel open. Opening the panel yields to its ink.
 *
 * The panel chrome is re-themed with the app's design tokens
 * ({@link cmSearchTheme}): CodeMirror's stock panel paints its own light
 * palette (`&light` selectors resolve as light because the editor theme does
 * not declare `dark`), which would sit as a gray/white box inside a
 * dark-mode sidebar. Only the token-driven chrome is overridden — the match
 * highlight overlays stay CodeMirror's translucent defaults, which read on
 * both schemes; the content-search ink uses the theme's warn tokens.
 */
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { SearchQuery, search, searchKeymap, searchPanelOpen } from '@codemirror/search'
import type { EditorSearchSeed } from './line-target.ts'
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
  // The match ink. CodeMirror paints `.cm-searchMatch` only while the find
  // panel is open — and a content-search landing opens that panel precisely to
  // show WHERE the hit sits — so these two rules are what make the matched
  // text readable instead of the library's hardcoded translucent yellow. The
  // selected match (the one the panel's next/prev moved to) takes the business
  // accent.
  '.cm-searchMatch': {
    backgroundColor: 'var(--dsw-alias-state-warn-tertiary)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--dsw-alias-state-business-tertiary)',
    outline: '1px solid var(--dsw-alias-state-business-primary)',
  },
  // The content-search landing's PANEL-INDEPENDENT ink: present the moment the
  // file opens, no find panel involved.
  '.cm-contentSearchHit': {
    backgroundColor: 'var(--dsw-alias-state-warn-tertiary)',
    borderRadius: '2px',
    boxShadow: 'inset 0 -1px 0 var(--dsw-alias-state-warn-primary)',
  },
})

/**
 * The persistent match highlight a CONTENT-SEARCH landing paints.
 *
 * CodeMirror's own `.cm-searchMatch` exists only while the find panel is open,
 * and a result click should show WHERE the keyword is without opening (and
 * stealing focus for) that panel. This pair is the panel-independent ink: a
 * state field carries the query/switches, and the view plugin decorates every
 * match in the visible ranges. Opening Ctrl/Cmd+F later still works and is
 * pre-filled from the same query.
 */
export const setContentSearchSeed = StateEffect.define<EditorSearchSeed | null>()

export const contentSearchSeedField = StateField.define<EditorSearchSeed | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setContentSearchSeed)) value = effect.value
    }
    // An edit moves the text under these marks: drop them rather than paint
    // the wrong words. A later navigation re-seeds.
    if (tr.docChanged) return null
    return value
  },
})

const contentSearchHitMark = Decoration.mark({ class: 'cm-contentSearchHit' })

/** The query for one seed, or null when it cannot match (invalid regex). */
function queryOfSeed(seed: EditorSearchSeed): SearchQuery | null {
  try {
    const query = new SearchQuery({
      search: seed.query,
      caseSensitive: seed.caseSensitive === true,
      wholeWord: seed.wholeWord === true,
      regexp: seed.regex === true,
      literal: seed.regex !== true,
    })
    return query.valid ? query : null
  } catch {
    return null
  }
}

/** Paints the current seed's matches across the visible ranges. */
const contentSearchHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none
  /** Whether the find panel was open at the last build (see {@link build}). */
  panelOpen = false
  constructor(view: EditorView) {
    this.panelOpen = searchPanelOpen(view.state)
    this.decorations = this.build(view)
  }
  update(update: ViewUpdate) {
    const panelOpen = searchPanelOpen(update.state)
    if (panelOpen !== this.panelOpen) {
      // The find panel paints the matches itself (and with its own
      // next/previous state); our ink yields to it instead of stacking two
      // translucent backgrounds.
      this.panelOpen = panelOpen
      this.decorations = this.build(update.view)
      return
    }
    if (update.docChanged || update.viewportChanged || update.selectionSet
      || update.startState.field(contentSearchSeedField, false) !== update.state.field(contentSearchSeedField, false)) {
      this.decorations = this.build(update.view)
    }
  }
  build(view: EditorView): DecorationSet {
    // The open find panel's `.cm-searchMatch` is the ink then; paint ours only
    // while the panel is closed.
    if (searchPanelOpen(view.state)) return Decoration.none
    const seed = view.state.field(contentSearchSeedField, false)
    if (seed === null || seed === undefined) return Decoration.none
    const query = queryOfSeed(seed)
    if (query === null) return Decoration.none
    const builder = new RangeSetBuilder<Decoration>()
    for (const { from, to } of view.visibleRanges) {
      const cursor = query.getCursor(view.state, from, to)
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        if (next.value.to > next.value.from) builder.add(next.value.from, next.value.to, contentSearchHitMark)
      }
    }
    return builder.finish()
  }
}, { decorations: value => value.decorations })

/**
 * The scheme-independent part of the find-in-file wiring: the top-pinned
 * panel, its theme, and the upstream search keymap. The localized phrases
 * are added separately through {@link CmSearchPhrases} (they are the only
 * piece a language switch reconfigures).
 */
export function cmSearchExtensions(): Extension[] {
  return [
    search({ top: true }),
    contentSearchSeedField,
    contentSearchHighlighter,
    cmSearchTheme,
    keymap.of(searchKeymap),
  ]
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
