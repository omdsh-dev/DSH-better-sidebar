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
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView as CodeMirrorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
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
import { readJumpMeta, type LineRange } from './path-line.ts'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/** The floating "add to conversation" action: payload + viewport anchor. */
interface SelectionPopup {
  insert: string
  left: number
  top: number
}

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

/** Effect carrying the next line-jump decoration set (none = clear). */
const setJumpHighlight = StateEffect.define<DecorationSet>()

/** The line-jump highlight: a line decoration set driven by
 *  {@link setJumpHighlight}, mapped across document changes so a jump's
 *  highlight survives edits. It persists until the user CLICKS inside the
 *  editor (see the mousedown handler below) or a new jump / plain reopen
 *  replaces it — scrolling never clears it. */
const jumpHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setJumpHighlight)) deco = effect.value
    }
    return deco
  },
  provide: (field) => CodeMirrorView.decorations.from(field),
})

export function TextEditor(props: FileViewerProps) {
  const { ctx, scope, path, viewerId, content, truncated, jumpLine } = props
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
  /** The line jump still to apply (the view may not exist / be visible yet). */
  const pendingJumpRef = useRef<{ line: LineRange; path: string } | null>(null)
  /** Whether the pending jump was already applied (scroll + highlight done). */
  const appliedJumpRef = useRef(false)
  /** A rAF retry while the view is hidden (collapsed panel / inactive split). */
  const jumpRetryRef = useRef<number | null>(null)
  /** The current path, read fresh by deferred jump retries (never stale). */
  const pathRef = useRef(path)
  pathRef.current = path

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

  /** Cancel a pending rAF jump retry (idempotent). */
  const cancelJumpRetry = (): void => {
    if (jumpRetryRef.current !== null) {
      cancelAnimationFrame(jumpRetryRef.current)
      jumpRetryRef.current = null
    }
  }

  /** Clear the pending jump state and any highlight (idempotent). */
  const clearJump = (): void => {
    pendingJumpRef.current = null
    appliedJumpRef.current = false
    cancelJumpRetry()
    viewRef.current?.dispatch({ effects: setJumpHighlight.of(Decoration.none) })
  }

  /**
   * Apply the pending line jump to the CodeMirror view: select the range,
   * scroll it into view (vertically centered) and highlight it. The
   * highlight stays until the user clicks inside the editor — scrolling
   * never clears it. The markdown/html preview hides the CM view — reveal
   * the edit surface first (the [mode] effect re-runs this once the mode
   * flips). A hidden (zero-size) view defers to the next frame; a missing
   * view waits for the view-creation effect to call back. Applies at most
   * once per jump, and only when the pending jump belongs to the CURRENT
   * file.
   */
  const applyJump = (): void => {
    const view = viewRef.current
    const pending = pendingJumpRef.current
    if (view === null || pending === null || appliedJumpRef.current) return
    if (pending.path !== pathRef.current) return
    const jump = pending.line
    const markdown = viewerId === 'markdown'
    const html = viewerId === 'html'
    if ((markdown || html) && mode === 'preview') {
      setMode('edit')
      return
    }
    const host = hostRef.current
    if (host !== null && (host.clientWidth === 0 || host.clientHeight === 0)) {
      cancelJumpRetry()
      jumpRetryRef.current = requestAnimationFrame(() => {
        jumpRetryRef.current = null
        applyJump()
      })
      return
    }
    const doc = view.state.doc
    if (doc.lines === 0) {
      appliedJumpRef.current = true
      return
    }
    const startLine = Math.min(Math.max(jump.start, 1), doc.lines)
    const endLine = Math.min(Math.max(jump.end, startLine), doc.lines)
    const from = doc.line(startLine).from
    const to = doc.line(endLine).to
    const decorations = Decoration.set(
      Array.from({ length: endLine - startLine + 1 }, (_, i) =>
        Decoration.line({ class: css.jumpLine }).range(doc.line(startLine + i).from)),
    )
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: [
        setJumpHighlight.of(decorations),
        CodeMirrorView.scrollIntoView(from, { y: 'center' }),
      ],
    })
    appliedJumpRef.current = true
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
        jumpHighlightField,
        // A click inside the editor dismisses the line-jump highlight (the
        // user asked for click-based dismissal — scrolling keeps it). The
        // handler receives the view, so no refs are captured.
        CodeMirrorView.domEventHandlers({
          mousedown: (_event, view) => {
            view.dispatch({ effects: setJumpHighlight.of(Decoration.none) })
          },
        }),
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
    // A line jump requested while the content was still loading applies
    // once the view exists (and again on visibility changes via [mode]).
    applyJump()
    return () => {
      cancelJumpRetry()
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
  // flip also invalidates any anchored selection popup — and re-runs a
  // pending line jump (the markdown/html preview deferral re-applies once
  // the mode flips to edit).
  useEffect(() => {
    hidePopup()
    if (mode === 'edit') viewRef.current?.requestMeasure()
    applyJump()
  }, [mode])

  // The line jump (from a chat path:line click or the tab's meta): stash it
  // and apply once the view exists; a null jump (plain reopen) clears any
  // pending jump and highlight. `jumpLine` is MEMOIZED by the editor host on
  // `tab.meta` (EditorHost), so this effect only re-runs when the jump
  // target actually changes — a re-click of the same mention pushes a fresh
  // meta and re-jumps; unrelated re-renders never re-apply (the original
  // "selecting code re-jumps" bug).
  useEffect(() => {
    if (jumpLine === undefined || jumpLine === null) {
      clearJump()
      return
    }
    pendingJumpRef.current = { line: { start: jumpLine.start, end: jumpLine.end }, path }
    appliedJumpRef.current = false
    applyJump()
    // applyJump reads refs for the rest; path is part of the pending record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpLine])

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
    const lines = linesOfSelection(mdText, text)
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
