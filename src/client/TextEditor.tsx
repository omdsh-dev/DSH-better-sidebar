/**
 * The code/markdown file viewer: a CodeMirror 6 editor with line wrapping,
 * syntax highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S
 * save, and a preview/edit toggle for markdown files. Registered as the
 * `code` (catch-all) and `markdown` built-in viewers; the editor tab host
 * fetches the content through the fsRead strategy and passes it in props,
 * so this component never fetches or dispatches — it only edits.
 *
 * The toolbar (mode toggle / dirty dot / save / status) renders as its own
 * row below the host's title bar, VSCode-style — unless the host passes
 * `toolbar: 'host'` (the merged editor-explorer mode), in which case this
 * component skips the row and reports state + registers commands through
 * the FileViewerProps toolbar callbacks so the host's path-input header
 * renders the controls instead.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import type { RangeSet } from '@codemirror/state'
import { Decoration, EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, htmlUrl } from './api.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { splitMermaidBlocks, type MermaidMarkdownProps } from './mermaid-blocks.ts'
import { t } from './locales.ts'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/** The floating selection actions: payload + viewport anchor + the selected
 *  text and (when locatable) its CodeMirror span. `text` alone enables the AI
 *  buttons; `from`/`to` enable the precise splice (always set in the editors,
 *  set in the preview only when the selection uniquely matches the source). */
interface SelectionPopup {
  insert: string
  left: number
  top: number
  /** Selected text (present for both the preview and the editors). */
  text?: string
  /** CodeMirror range to rewrite (present for the editors; best-effort in preview). */
  from?: number
  to?: number
}

/** The AI-writing flow state: idle → loading (cancellable) → done (undo/confirm) → idle. */
type AiState =
  | { kind: 'idle' }
  | { kind: 'loading'; instruction: string; isContinue: boolean; from: number; to: number; original: string; left: number; top: number }
  | { kind: 'done'; instruction: string; isContinue: boolean; from: number; to: number; original: string; insertedFrom: number; insertedTo: number; result: string; left: number; top: number }
  | { kind: 'failed'; message: string; left: number; top: number }

/** Highlight mark for freshly inserted AI text (cleared on confirm/revoke). */
const aiHighlightMark = Decoration.mark({ class: css.aiHighlight })

/** StateEffect carrying the highlight range (null clears it). */
const setAiHighlight = StateEffect.define<{ from: number; to: number } | null>()

/** Decoration state field mapping the highlight range onto the document. */
const aiHighlightField = StateField.define<RangeSet<Decoration>>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setAiHighlight)) {
        deco = effect.value === null
          ? Decoration.none
          : Decoration.set([aiHighlightMark.range(effect.value.from, effect.value.to)])
      }
    }
    return deco
  },
  provide: (field) => CodeMirrorView.decorations.from(field),
})

/**
 * The chunk-resident markdown preview renderer (mermaid lazy chunk): one
 * MarkdownText pass over the whole source, with rendered mermaid fences
 * swapped for diagrams. Module-level `pick` keeps the load effect stable.
 */
const LazyMermaidMarkdown = lazyChunkComponent<MermaidMarkdownProps>(
  'mermaid',
  (mod) => mod.MermaidMarkdown as ComponentType<MermaidMarkdownProps> | undefined,
)

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
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The floating "add to conversation" popup (viewport-anchored; null = hidden). */
  const [popup, setPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror of the popup state for click-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup | null>(null)
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement>(null)
  /** The AI-writing flow state (idle when no generation is in flight). */
  const [ai, setAi] = useState<AiState>({ kind: 'idle' })
  /** Live mirror of the AI state for read-time checks inside CodeMirror callbacks. */
  const aiRef = useRef<AiState>({ kind: 'idle' })
  /** Abort controller for the in-flight generation (the stop button). */
  const aiAbortRef = useRef<AbortController | null>(null)
  /** The instruction typed in the selection popup's input (mirrored for click-time reads). */
  const [aiInstruction, setAiInstruction] = useState('')
  const aiInstructionRef = useRef('')
  /** True while the popup's instruction input holds focus — keeps the popup
   *  alive when the CodeMirror view loses focus to that input. */
  const popupInputFocusedRef = useRef(false)

  const hidePopup = (): void => {
    popupRef.current = null
    setPopup(null)
  }

  /** Anchor the popup above the selection center; clamp inside the viewport.
   *  `span` carries the selected text plus (when precisely locatable) the
   *  CodeMirror range the AI buttons rewrite — always present in the editors,
   *  best-effort in the markdown preview (a uniquely matched selection). */
  const showPopup = (insert: string, left: number, top: number, span?: { from?: number; to?: number; text: string }): void => {
    // A fresh selection starts a fresh instruction — drop the previous one so
    // the input shows its placeholder again instead of the last typed value.
    aiInstructionRef.current = ''
    setAiInstruction('')
    const next: SelectionPopup = {
      insert,
      left: Math.min(Math.max(left, 80), window.innerWidth - 80),
      top,
      ...(span !== undefined
        ? { text: span.text, ...(span.from !== undefined && span.to !== undefined ? { from: span.from, to: span.to } : {}) }
        : {}),
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

  /** Start one AI writing operation from the instruction input: stream the
   *  result, splice it into the document (replace, or append when the
   *  instruction asks to continue), highlight the new text, and open the
   *  undo/confirm popup. */
  const startAi = (): void => {
    const instruction = aiInstructionRef.current.trim()
    if (instruction === '') return
    const current = popupRef.current
    if (current === null || current.text === undefined) return
    const { from, to, text, left, top } = current
    // The AI popup appears in the markdown preview too; there the selection
    // is a DOM range, so a rewrite must happen in the (already mounted but
    // hidden) CodeMirror. Flip to edit mode so the splice + highlight are
    // visible. When the preview selection could not be located uniquely,
    // there is no safe splice — switch to edit mode and ask for a manual
    // selection instead.
    if (from === undefined || to === undefined) {
      setMode('edit')
      hidePopup()
      setAi({ kind: 'failed', message: t('aiLocateFailed'), left, top })
      return
    }
    setMode('edit')
    // A "continue" request appends after the selection; anything else replaces.
    const isContinue = /续写|接着写|继续写|continue/i.test(instruction)
    const controller = new AbortController()
    aiAbortRef.current = controller
    setAi({ kind: 'loading', instruction, isContinue, from, to, original: text, left, top })
    api.aiProcess(scope, text, instruction, controller.signal).then(({ result }) => {
      const view = viewRef.current
      if (view === null) {
        setAi({ kind: 'idle' })
        return
      }
      let insertedFrom: number
      let insertedTo: number
      if (isContinue) {
        // Append after the selection (a new line when it doesn't end with one).
        const sep = text.endsWith('\n') ? '' : '\n'
        view.dispatch({
          changes: { from: to, insert: sep + result },
          effects: setAiHighlight.of({ from: to + sep.length, to: to + sep.length + result.length }),
        })
        insertedFrom = to
        insertedTo = to + sep.length + result.length
      } else {
        // Replace the selection with the generated text.
        view.dispatch({
          changes: { from, to, insert: result },
          effects: setAiHighlight.of({ from, to: from + result.length }),
        })
        insertedFrom = from
        insertedTo = from + result.length
      }
      hidePopup()
      setAi({ kind: 'done', instruction, isContinue, from, to, original: text, insertedFrom, insertedTo, result, left, top })
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setAi({ kind: 'idle' })
        return
      }
      setAi({ kind: 'failed', message: error instanceof Error ? error.message : t('aiFailed'), left, top })
    })
  }

  /** The loading popup's stop button: abort the in-flight generation. */
  const stopAi = (): void => {
    aiAbortRef.current?.abort()
    aiAbortRef.current = null
    setAi({ kind: 'idle' })
  }

  /** Accept the highlighted text: clear the highlight and close the popup. */
  const confirmAi = (): void => {
    viewRef.current?.dispatch({ effects: setAiHighlight.of(null) })
    setAi({ kind: 'idle' })
  }

  /** Revoke the generated text: restore the original span and clear the highlight. */
  const revokeAi = (): void => {
    if (ai.kind !== 'done') return
    const view = viewRef.current
    if (view !== null) {
      const insert = ai.isContinue ? '' : ai.original
      view.dispatch({
        changes: { from: ai.insertedFrom, to: ai.insertedTo, insert },
        effects: setAiHighlight.of(null),
      })
    }
    setAi({ kind: 'idle' })
  }

  useEffect(() => { aiRef.current = ai }, [ai])

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // A new file (tab switch) starts clean: fresh preview mode, no draft.
  useEffect(() => {
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    hidePopup()
    aiAbortRef.current?.abort()
    aiAbortRef.current = null
    setAi({ kind: 'idle' })
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

    // Anchor the popup above the editor's current main selection (line-exact
    // via the document); an empty/whitespace selection hides it instead.
    const popupFromSelection = (view: CodeMirrorView): void => {
      // A generation in flight owns the flow; don't re-anchor a selection
      // popup under the AI popups (the splice dispatches selection changes).
      if (aiRef.current.kind !== 'idle') {
        hidePopup()
        return
      }
      const sel = view.state.selection.main
      if (sel.empty) {
        hidePopup()
        return
      }
      const text = view.state.sliceDoc(sel.from, sel.to)
      if (text.trim() === '') {
        hidePopup()
        return
      }
      // Page coordinates (the document root may scroll); the popup is
      // position:fixed, so convert to viewport coordinates.
      const rect = view.coordsAtPos(sel.head)
      if (rect === null) {
        hidePopup()
        return
      }
      const doc = view.state.doc
      showPopup(
        buildSelectionInsert(path, scope.cwd, {
          start: doc.lineAt(sel.from).number,
          end: doc.lineAt(sel.to).number,
        }, text),
        rect.left - window.scrollX + (rect.right - rect.left) / 2,
        rect.top - window.scrollY,
        { from: sel.from, to: sel.to, text },
      )
    }

    const state = EditorState.create({
      doc: content,
      extensions: [
        CodeMirrorView.lineWrapping,
        lineNumbers(),
        history(),
        EditorState.tabSize.of(2),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(dark),
        aiHighlightField,
        ...(language !== null ? [language] : []),
        CodeMirrorView.updateListener.of((update) => {
          if (update.docChanged) {
            setDraft(update.state.doc.toString())
            setDirty(true)
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { save(); return true },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Selection popup (the code, markdown, and html editors): a non-empty
        // selection anchors the floating "add to conversation" button above
        // its head. Scrolling (geometry/viewport change) or losing focus
        // hides it; typing collapses the selection and hides it too.
        // Keyboard selections (Shift+arrows) pop immediately; pointer drags
        // pop on mouseup (the DOM handler below), so the popup appears only
        // after the drag is released — matching the markdown preview.
        ...(viewerId === 'code' || viewerId === 'markdown' || viewerId === 'html' ? [
          CodeMirrorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged) {
              hidePopup()
              return
            }
            if (!update.view.hasFocus) {
              // Focus moved to the popup's instruction input — keep the popup
              // alive so the field stays mounted for typing.
              if (popupInputFocusedRef.current) return
              hidePopup()
              return
            }
            if (!(update.selectionSet || update.docChanged || update.focusChanged)) return
            // A mouse drag dispatches a selection update on every pointer
            // move; defer those to the mouseup handler so the popup waits
            // for the drag to end.
            const pointer = update.transactions.some((tr) =>
              (tr.annotation(Transaction.userEvent) ?? '').startsWith('select.pointer'))
            if (pointer) return
            popupFromSelection(update.view)
          }),
          CodeMirrorView.domEventHandlers({
            mouseup: (_event, view) => { popupFromSelection(view) },
          }),
        ] : []),
      ],
    })
    const view = new CodeMirrorView({ state, parent: host })
    viewRef.current = view
    return () => {
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
  /** The markdown source the preview renders (draft wins over saved content). */
  const mdText = draft ?? content ?? ''
  /** md/mermaid block split for the preview (mermaid fences lift out). Split
   *  only in preview mode: edit-mode keystrokes must not re-scan the source. */
  const mdBlocks = useMemo(
    () => (markdown && mode === 'preview' ? splitMermaidBlocks(mdText) : []),
    [markdown, mode, mdText],
  )
  const hasMermaid = useMemo(
    () => mdBlocks.some(block => block.kind === 'mermaid'),
    [mdBlocks],
  )
  const codeLabels = { copyLabel: t('copy'), copiedLabel: t('copied') }

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
    const source = mdText
    const lines = linesOfSelection(source, text)
    // Best-effort character span for the AI rewrite: strip the trailing
    // newline DOM block selections carry, then require an exactly-one match
    // (the same rule as linesOfSelection) so an ambiguous hit never rewrites
    // the wrong text. A miss keeps the AI buttons but they prompt a manual
    // selection in edit mode.
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
    const at = trimmed === '' ? -1 : source.indexOf(trimmed)
    const span = at !== -1 && source.indexOf(trimmed, at + 1) === -1
      ? { from: at, to: at + trimmed.length, text: trimmed }
      : { text: trimmed }
    showPopup(
      buildSelectionInsert(path, scope.cwd, lines ?? undefined, text),
      rect.left + rect.width / 2,
      rect.top,
      span,
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

  // Host-toolbar mode (the merged editor header renders the controls): skip
  // the own toolbar row, report the state after every relevant render (the
  // JSON key guards redundant calls), and register the commands on mount.
  const hostToolbar = props.toolbar === 'host'
  const lastToolbarRef = useRef('')
  useEffect(() => {
    if (!hostToolbar) return
    const state: EditorToolbarState = { modes: markdown || html, mode, dirty, editable, saveState }
    const key = JSON.stringify(state)
    if (lastToolbarRef.current === key) return
    lastToolbarRef.current = key
    props.onToolbarState?.(state)
  })
  useEffect(() => {
    if (!hostToolbar) return
    // `save` reads live refs only, and `setMode` is the stable state setter —
    // registering this render's closures is safe for the mount's lifetime.
    props.onToolbarControls?.({ setMode, save })
    return () => { props.onToolbarControls?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToolbar])

  return (
    <>
      {!hostToolbar && (
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
        {saveLabel !== '' && <span className={clsx(css.editorStatus, saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>}
      </div>
      )}
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
              the active locale on live switches. Mermaid fences hand the
              whole document to the mermaid lazy chunk (single markdown
              parse; cross-fence references/footnotes stay intact); files
              without one render exactly as before. */}
          {hasMermaid
            ? <LazyMermaidMarkdown text={mdText} codeLabels={codeLabels} />
            : <MarkdownText text={mdText} codeLabels={codeLabels} />}
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
      {ai.kind === 'idle' && popup !== null && createPortal(
        <div
          className={css.selectionPopupGroup}
          style={{ left: popup.left, top: popup.top }}
          // Keep the selection (and CodeMirror focus) alive until a click
          // commits — without this the popup unmounts before the click lands.
          onMouseDown={(event) => { event.preventDefault() }}
        >
          {popup.text !== undefined && (
            <>
              <input
                type="text"
                className={css.selectionPopupInput}
                placeholder={t('aiInstructionPlaceholder')}
                value={aiInstruction}
                onChange={(event) => {
                  aiInstructionRef.current = event.target.value
                  setAiInstruction(event.target.value)
                }}
                onKeyDown={(event) => { if (event.key === 'Enter') startAi() }}
                // Let the field take focus: the group's mousedown preventDefault
                // (which keeps the CodeMirror selection alive for button clicks)
                // would otherwise swallow the focus and make the input read-only.
                // Mark the focus in mousedown (it runs before the view's blur
                // dispatch) so the popup survives the view losing focus to this
                // field, and clear it on blur so a real focus-away hides it.
                onMouseDown={(event) => {
                  event.stopPropagation()
                  popupInputFocusedRef.current = true
                }}
                onBlur={() => { popupInputFocusedRef.current = false }}
              />
              <button type="button" className={css.selectionPopupBtn} onClick={startAi}>
                {t('aiEdit')}
              </button>
              <span className={css.selectionPopupDivider} aria-hidden="true" />
            </>
          )}
          <button type="button" className={css.selectionPopupBtn} onClick={commitPopup}>
            {t('addToConversation')}
          </button>
        </div>,
        document.body,
      )}
      {ai.kind !== 'idle' && createPortal(
        <div
          className={css.aiPopup}
          style={{ left: ai.left, top: ai.top }}
          onMouseDown={(event) => { event.preventDefault() }}
        >
          {ai.kind === 'loading' && (
            <>
              <span className={css.aiSpinner} aria-hidden="true" />
              <span>{t('aiGenerating')}</span>
              <button type="button" className={css.aiBtn} onClick={stopAi}>{t('aiStop')}</button>
            </>
          )}
          {ai.kind === 'done' && (
            <>
              <button type="button" className={css.aiBtn} onClick={revokeAi}>{t('aiRevoke')}</button>
              <button type="button" className={css.aiBtn} onClick={confirmAi}>{t('aiConfirm')}</button>
            </>
          )}
          {ai.kind === 'failed' && (
            <>
              <span className={css.aiError}>{ai.message}</span>
              <button type="button" className={css.aiBtn} onClick={() => { setAi({ kind: 'idle' }) }}>{t('close')}</button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
