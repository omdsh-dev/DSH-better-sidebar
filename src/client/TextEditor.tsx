/**
 * The code/markdown file viewer: a CodeMirror 6 editor with line wrapping,
 * syntax highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S
 * save, and a preview/edit toggle for markdown files. Registered as the
 * `code` (catch-all) and `markdown` built-in viewers; the editor tab host
 * fetches the content through the fsRead strategy and passes it in props,
 * so this component never fetches or dispatches — it only edits.
 *
 * The toolbar (mode toggle / dirty dot / save / status) renders as its own
 * row below the host's title bar, VSCode-style.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches, selectNextOccurrence } from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { bracketMatching, indentOnInput, indentUnit, foldGutter, foldKeymap } from '@codemirror/language'
import type { SidebarPrefs } from '../prefs-shared.ts'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, htmlUrl } from './api.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { t } from './locales.ts'
import type { FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/**
 * The editor extensions driven by the side card prefs (font, tab width, line
 * wrapping, line-number gutter). Lives in a compartment so settings changes
 * reconfigure the live editor; missing prefs fall back to the CodeMirror
 * defaults (13px, 4-space tabs, wrapping on, line numbers on).
 */
function buildPrefsExtensions(prefs: SidebarPrefs | undefined): Extension[] {
  if (prefs === undefined) {
    return [
      CodeMirrorView.theme({ '&': { fontSize: '13px' } }),
      CodeMirrorView.lineWrapping,
      lineNumbers(),
      EditorState.tabSize.of(4),
      indentUnit.of('    '),
    ]
  }
  return [
    prefs.editorFontFamily === ''
      ? CodeMirrorView.theme({ '&': { fontSize: `${prefs.editorFontSize}px` } })
      : CodeMirrorView.theme({ '&': { fontFamily: prefs.editorFontFamily, fontSize: `${prefs.editorFontSize}px` } }),
    ...(prefs.editorWordWrap ? [CodeMirrorView.lineWrapping] : []),
    ...(prefs.editorShowLineNumbers ? [lineNumbers()] : []),
    EditorState.tabSize.of(prefs.editorTabSize),
    indentUnit.of(' '.repeat(prefs.editorTabSize)),
  ]
}

/** The floating "add to conversation" action: payload + viewport anchor. */
interface SelectionPopup {
  insert: string
  left: number
  top: number
}

/**
 * The sandbox tokens of the HTML preview iframe. NO allow-same-origin (the
 * preview must stay in an opaque origin — with the route's own origin it
 * could read session data) and NO allow-top-navigation (a previewed page
 * must not hijack the GUI). The user can disable the sandbox per-feature
 * in the side card settings (warned); the toggle below reflects it.
 */
export const HTML_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-downloads allow-modals'

export function TextEditor(props: FileViewerProps) {
  const { ctx, scope, path, viewerId, content, truncated } = props
  const [mode, setMode] = useState<ViewMode>('preview')
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  /** Cursor position for the Ln/Col status (updated on selection/doc change). */
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The user-prefs compartment of the current view (reconfigured on settings change). */
  const prefsCompRef = useRef<Compartment | null>(null)
  /** Live auto-save mode (updated by the prefs effect; read by listeners). */
  const autoSaveModeRef = useRef<'off' | 'onBlur' | 'afterDelay'>('off')
  /** Pending afterDelay auto-save timer. */
  const autoSaveTimerRef = useRef<number | null>(null)
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The floating "add to conversation" popup (viewport-anchored; null = hidden). */
  const [popup, setPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror of the popup state for click-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup | null>(null)
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement>(null)

  const hidePopup = (): void => {
    popupRef.current = null
    setPopup(null)
  }

  /** Anchor the popup above the selection center; clamp inside the viewport. */
  const showPopup = (insert: string, left: number, top: number): void => {
    const next: SelectionPopup = {
      insert,
      left: Math.min(Math.max(left, 80), window.innerWidth - 80),
      top,
    }
    popupRef.current = next
    setPopup(next)
  }

  /** The popup button's click: insert the stored payload into the draft. */
  const commitPopup = (): void => {
    const current = popupRef.current
    if (current === null) return
    appendToDraft(ctx, scope.sessionId, current.insert)
    hidePopup()
  }

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // A new file (tab switch) starts clean: fresh preview mode, no draft.
  useEffect(() => {
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    hidePopup()
  }, [content])

  // Create the CodeMirror editor once the content is loaded. The view owns
  // the document; React only tracks dirty/draft state through the update
  // listener. For markdown the view stays mounted while previewing (hidden),
  // so unsaved edits survive the preview/edit toggle. The theme + syntax
  // colors live in a compartment so a scheme flip reconfigures only that
  // part — the document, undo history and scroll position survive.
  useEffect(() => {
    if (content === undefined) return
    const host = hostRef.current
    if (host === null) return
    const language = languageForPath(path)
    const themeComp = new CmThemeCompartment()
    themeCompRef.current = themeComp
    // A compartment holding the user-configurable editor prefs (font family /
    // size, tab width, line wrapping, line-number gutter), so settings changes
    // reconfigure the live view without recreating it (the document, undo
    // history and scroll position survive).
    const prefsComp = new Compartment()
    prefsCompRef.current = prefsComp
    const prefs = ctx.betterSidebar?.getSnapshot()?.prefs
    const prefsExtension = buildPrefsExtensions(prefs)
    const state = EditorState.create({
      doc: content,
      extensions: [
        prefsComp.of(prefsExtension),
        history(),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(dark),
        ...(language !== null ? [language] : []),
        // VSCode-like editing aids: bracket matching, auto-close brackets,
        // indent on Enter, active-line highlight, indentation guides, and
        // a subtle highlight of the current search matches.
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        highlightActiveLine(),
        // Code folding: a gutter with fold markers on collapsible blocks
        // (functions, braces, indented blocks); plain text has no fold
        // points, so the gutter shows nothing there (normal degradation).
        foldGutter(),
        CodeMirrorView.updateListener.of((update) => {
          // Ln/Col status: recompute whenever the selection or document moves.
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head
            const line = update.state.doc.lineAt(head)
            setCursorPos({ line: line.number, col: head - line.from + 1 })
          }
          if (update.docChanged) {
            setDraft(update.state.doc.toString())
            setDirty(true)
            // afterDelay auto-save: debounce 1s after the last edit.
            if (autoSaveModeRef.current === 'afterDelay') {
              if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current)
              autoSaveTimerRef.current = window.setTimeout(() => { save() }, 1000)
            }
          }
          // onBlur auto-save: save the dirty editor when it loses focus.
          if (update.focusChanged && !update.view.hasFocus && autoSaveModeRef.current === 'onBlur') {
            if (autoSaveTimerRef.current !== null) {
              window.clearTimeout(autoSaveTimerRef.current)
              autoSaveTimerRef.current = null
            }
            save()
          }
        }),
        // Find / replace (Mod-f opens the panel, Mod-h replace, Enter/Shift-Enter
        // step through matches) and Ctrl+G go-to-line via the default keymaps.
        search({ top: true }),
        highlightSelectionMatches(),
        autocompletion({ activateOnTyping: true, defaultKeymap: true }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { save(); return true },
          },
          // Go to line (Mod-g): prompt for a line number and jump.
          {
            key: 'Mod-g',
            preventDefault: true,
            run: () => {
              const view = viewRef.current
              if (view === null) return false
              const doc = view.state.doc
              const input = window.prompt(t('gotoLinePrompt'), '1')
              if (input === null) return true
              const line = Math.max(1, Math.min(Number.parseInt(input, 10) || 1, doc.lines))
              const pos = doc.line(line).from
              view.dispatch({
                selection: { anchor: pos },
                effects: CodeMirrorView.scrollIntoView(pos, { y: 'center' }),
              })
              view.focus()
              return true
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...closeBracketsKeymap,
          ...completionKeymap,
          // Tab indents (multi-line: whole selection); Shift-Tab dedents.
          indentWithTab,
          // Multi-cursor: Ctrl+D selects the next occurrence of the current
          // selection (repeat to extend; Ctrl+U from defaultKeymap retreats).
          {
            key: 'Mod-d',
            preventDefault: true,
            run: selectNextOccurrence,
          },
          // Code folding keymap: Ctrl+Shift+[ folds, Ctrl+Shift+] unfolds,
          // Ctrl+Alt+[ / ] fold/unfold all.
          ...foldKeymap,
        ]),
        // Selection popup (the code and markdown editors): a non-empty
        // selection anchors the floating "add to conversation" button above
        // its head. Scrolling (geometry/viewport change) or losing focus
        // hides it; typing collapses the selection and hides it too.
        ...(viewerId === 'code' || viewerId === 'markdown' ? [
          CodeMirrorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged) {
              hidePopup()
              return
            }
            if (!update.view.hasFocus) {
              hidePopup()
              return
            }
            if (!(update.selectionSet || update.docChanged || update.focusChanged)) return
            const sel = update.state.selection.main
            if (sel.empty) {
              hidePopup()
              return
            }
            const text = update.state.sliceDoc(sel.from, sel.to)
            if (text.trim() === '') {
              hidePopup()
              return
            }
            // Page coordinates (the document root may scroll); the popup is
            // position:fixed, so convert to viewport coordinates.
            const rect = update.view.coordsAtPos(sel.head)
            if (rect === null) {
              hidePopup()
              return
            }
            const doc = update.state.doc
            showPopup(
              buildSelectionInsert(path, scope.cwd, {
                start: doc.lineAt(sel.from).number,
                end: doc.lineAt(sel.to).number,
              }, text),
              rect.left - window.scrollX + (rect.right - rect.left) / 2,
              rect.top - window.scrollY,
            )
          }),
        ] : []),
      ],
    })
    const view = new CodeMirrorView({ state, parent: host })
    viewRef.current = view
    // Initialize the Ln/Col status from the initial cursor (position 0).
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    setCursorPos({ line: line.number, col: head - line.from + 1 })
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      view.destroy()
      viewRef.current = null
      themeCompRef.current = null
    }
    // The keymap's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the reconfigure
    // effect below (recreating the view here would drop the draft).
  }, [content, path])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  // Side card pref changes: reconfigure the prefs compartment in place so
  // font / tab width / wrapping / line numbers apply without losing the
  // document, undo history or scroll position. The store notifies on every
  // snapshot change (session switch, prefs writes); the reconfigure is cheap
  // and idempotent, so listening to all of them is fine.
  useEffect(() => {
    const view = viewRef.current
    const prefsComp = prefsCompRef.current
    if (view === null || prefsComp === null) return
    const applyPrefs = (): void => {
      const prefs = ctx.betterSidebar?.getSnapshot()?.prefs
      view.dispatch({ effects: prefsComp.reconfigure(buildPrefsExtensions(prefs)) })
      autoSaveModeRef.current = prefs?.editorAutoSave ?? 'off'
    }
    applyPrefs()
    return ctx.betterSidebar?.subscribeState(applyPrefs)
  }, [ctx])

  // The editor may have been display:none while previewing; re-measure when
  // it becomes visible again (CodeMirror sizes itself on reveal). A mode
  // flip also invalidates any anchored selection popup.
  useEffect(() => {
    hidePopup()
    if (mode === 'edit') viewRef.current?.requestMeasure()
  }, [mode])

  const save = (): void => {
    const view = viewRef.current
    if (view === null || savingRef.current) return
    // A save (manual or auto) supersedes any pending afterDelay write.
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    savingRef.current = true
    setSaveState('saving')
    api.fsWrite(scope, path, view.state.doc.toString()).then(() => {
      savingRef.current = false
      setDraft(null)
      setDirty(false)
      setSaveState('saved')
    }).catch(() => {
      savingRef.current = false
      setSaveState('failed')
    })
  }

  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'

  /**
   * Selection popup for the markdown preview: a mouse-up inside the preview
   * container anchors the floating "add to conversation" button above the
   * selection. Line numbers come from a best-effort reverse-search of the
   * selected text in the source ({@link linesOfSelection} — an ambiguous or
   * missing hit omits them). The button's own mousedown preventDefaults so
   * the selection survives until the click commits.
   */
  const handlePreviewMouseUp = (): void => {
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed || sel.anchorNode === null || sel.focusNode === null) {
      hidePopup()
      return
    }
    const host = mdRef.current
    if (host === null || !host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) {
      hidePopup()
      return
    }
    const text = sel.toString()
    if (text.trim() === '') {
      hidePopup()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const lines = linesOfSelection(draft ?? content ?? '', text)
    showPopup(
      buildSelectionInsert(path, scope.cwd, lines ?? undefined, text),
      rect.left + rect.width / 2,
      rect.top,
    )
  }
  const editable = content !== undefined
  const saveLabel = saveState === 'saving' ? t('loading') : saveState === 'saved' ? t('saved') : saveState === 'failed' ? t('saveFailed') : ''
  // Per-feature sandbox escape hatch: the global side card setting (warned)
  // plus a per-surface temporary unlock. The unlock state starts at the
  // "default unsafe" pref so a preview can open straight into the red
  // unsandboxed state (still restorable from the status row). With the
  // sandbox OFF the preview iframe drops its sandbox attribute entirely —
  // the previewed page then runs on the GUI's own origin with full session
  // access.
  const [localUnlock, setLocalUnlock] = useState(() => props.store?.getPrefs().htmlViewerDefaultUnsafe === true)
  const htmlNoSandbox = props.store?.getPrefs().htmlViewerNoSandbox === true || localUnlock

  return (
    <>
      <div className={css.editorHeader}>
        {(markdown || html) && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'preview' && css.editorModeActive)}
              onClick={() => { setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'edit' && css.editorModeActive)}
              onClick={() => { setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {dirty && <span className={css.dirtyDot} title={t('unsaved')} />}
        {editable && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={save}
          >
            <IconCheckOutline16 />
          </button>
        )}
        {/* Ln/Col status: shown while actually editing. Plain code files are
            always in edit mode (no preview toggle); markdown/html hide it
            while previewing. */}
        {cursorPos !== null && (mode === 'edit' || !(markdown || html)) && (
          <span className={css.editorStatus}>Ln {cursorPos.line}, Col {cursorPos.col}</span>
        )}
        {saveLabel !== '' && <span className={clsx(css.editorStatus, saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>}
      </div>
      {editable && (
        <>
          {truncated === true && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, (markdown || html) && mode === 'preview' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {markdown && mode === 'preview' && (
        <div
          className={css.editorMd}
          ref={mdRef}
          onMouseUp={handlePreviewMouseUp}
          onScroll={hidePopup}
        >
          {/* The fence copy-button labels must come from this plugin's own
              dictionary: the DSH MarkdownText/CodeBlock are cordis-free and
              fall back to hardcoded Chinese otherwise (same pattern as the
              chat's AssistantMarkdown). Render-time t() keeps them following
              the active locale on live switches. */}
          <MarkdownText
            text={draft ?? content ?? ''}
            codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }}
          />
        </div>
      )}
      {html && mode === 'preview' && (
        <>
          <SandboxStatusBar
            sandboxed={!htmlNoSandbox}
            local={localUnlock}
            dangerCopy={t('htmlNoSandboxWarning')}
            onUnlock={() => { setLocalUnlock(true) }}
            onRestore={() => { setLocalUnlock(false) }}
          />
          {/* Route-src (never srcdoc — a srcdoc frame inherits the parent
              origin when unsandboxed; the route URL keeps the frame
              cross-origin by construction). The preview shows the SAVED
              file; the draft is only visible in edit mode. */}
          <iframe
            className={css.editorHtml}
            src={htmlUrl(scope, path)}
            sandbox={htmlNoSandbox ? undefined : HTML_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            allow=""
            title={path}
          />
        </>
      )}
      {popup !== null && createPortal(
        <button
          type="button"
          className={css.selectionPopup}
          style={{ left: popup.left, top: popup.top }}
          // Keep the selection (and CodeMirror focus) alive until the click
          // commits — without this the popup unmounts before click lands.
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={commitPopup}
        >
          {t('addToConversation')}
        </button>,
        document.body,
      )}
    </>
  )
}
