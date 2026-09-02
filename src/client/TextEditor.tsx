/**
 * The text-file viewer: code and HTML source use CodeMirror 6, while Markdown
 * uses a markdown-native visual editor that serializes edits back to source.
 * Both paths share the dirty/save/comment-selection contract. Registered as
 * the `code` (catch-all), `html`, and `markdown` built-in viewers; the editor
 * tab host fetches content through the fsRead strategy and passes it in props.
 *
 * The toolbar (HTML mode toggle / dirty dot / save / status) renders as its
 * own row below the host's title bar, VSCode-style — unless the host passes
 * `toolbar: 'host'` (the merged editor-explorer mode), in which case this
 * component skips the row and reports state + registers commands through
 * the FileViewerProps toolbar callbacks so the host's path-input header
 * renders the controls instead.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { IconCheckOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, htmlUrl } from './api.ts'
import { resolveLocalMediaDest } from './markdown-images.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { fileCommentStore } from './file-comments.ts'
import { headerOf, linesOfSelection, type SelectionLines } from './selection-payload.ts'
import { MarkdownVisualEditor, type MarkdownVisualEditorHandle } from './MarkdownVisualEditor.tsx'
import { TextDiffView } from './TextDiffView.tsx'
import { t } from './locales.ts'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** HTML preview vs source editing. Markdown is always a visual edit surface. */
type ViewMode = 'preview' | 'edit'
type FileSurfaceMode = 'file' | 'diff'

type DiffBaseline =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'error'; message: string }

/** The floating review-comment editor: selection context + viewport anchor. */
interface SelectionPopup {
  selectedText: string
  lines?: SelectionLines
  body: string
  left: number
  top: number
  below: boolean
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
  const { scope, path, viewerId, content, truncated } = props
  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'
  const [mode, setMode] = useState<ViewMode>('preview')
  const [fileMode, setFileMode] = useState<FileSurfaceMode>('file')
  const [diffBaseline, setDiffBaseline] = useState<DiffBaseline>({ status: 'idle' })
  /** The editor's current text (null until the first visual/source edit). */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [markdownError, setMarkdownError] = useState('')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const markdownRef = useRef<MarkdownVisualEditorHandle | null>(null)
  /** Saved baseline used to clear dirty when a visual edit returns to disk. */
  const savedMarkdownRef = useRef(content ?? '')
  const savingRef = useRef(false)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The floating review-comment popup (viewport-anchored; null = hidden). */
  const [popup, setPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror of the popup state for click-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup | null>(null)
  const popupHostRef = useRef<HTMLFormElement>(null)
  /** The visual markdown container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement>(null)

  const hidePopup = (): void => {
    popupRef.current = null
    setPopup(null)
  }

  /** Anchor the popup above the selection center; clamp inside the viewport. */
  const showPopup = (selectedText: string, lines: SelectionLines | undefined, left: number, top: number): void => {
    const popupWidth = Math.min(300, Math.max(0, window.innerWidth - 16))
    const halfWidth = popupWidth / 2
    const minLeft = 8 + halfWidth
    const maxLeft = window.innerWidth - 8 - halfWidth
    const next: SelectionPopup = {
      selectedText,
      lines,
      body: '',
      left: maxLeft < minLeft ? window.innerWidth / 2 : Math.min(Math.max(left, minLeft), maxLeft),
      top: top < 190 ? top + 24 : top,
      below: top < 190,
    }
    popupRef.current = next
    setPopup(next)
  }

  /** Save one pending review row; EditorHost observes the store and opens it. */
  const commitPopup = (): void => {
    const current = popupRef.current
    if (current === null || current.body.trim() === '') return
    fileCommentStore.add(scope.sessionId, {
      path,
      lines: current.lines,
      selectedText: current.selectedText,
      body: current.body,
    })
    hidePopup()
  }

  const updatePopupBody = (body: string): void => {
    const current = popupRef.current
    if (current === null) return
    const next = { ...current, body }
    popupRef.current = next
    setPopup(next)
  }

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // A new file (tab switch/manual refresh) starts clean. Markdown updates its
  // existing Lexical instance through the imperative API; the component's
  // markdown prop is intentionally mount-only.
  useEffect(() => {
    setMode('preview')
    setFileMode('file')
    setDiffBaseline({ status: 'idle' })
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    setMarkdownError('')
    savedMarkdownRef.current = content ?? ''
    if (markdown && content !== undefined) {
      markdownRef.current?.setMarkdown(content)
    }
    hidePopup()
  }, [content, markdown])

  // The comparison baseline is the blob at HEAD. It is loaded on each entry
  // into diff mode so a commit made while the file view is open is reflected
  // without remounting the editor. A null blob is a new/untracked file and
  // compares against an empty original document.
  useEffect(() => {
    if (fileMode !== 'diff' || content === undefined) return
    const controller = new AbortController()
    setDiffBaseline({ status: 'loading' })
    api.gitShow(scope, 'HEAD', path, controller.signal).then((result) => {
      setDiffBaseline({ status: 'ready', content: result.content ?? '' })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setDiffBaseline({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { controller.abort() }
  }, [fileMode, content, scope.sessionId, scope.cwd, scope.repoRoot, path])

  // Create CodeMirror once for code/HTML source. Markdown has its own rich
  // document model and never mounts this source editor. The theme + syntax
  // colors live in a compartment so a scheme flip reconfigures only that
  // part — the document, undo history and scroll position survive.
  useEffect(() => {
    if (content === undefined || markdown) return
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
        // selection anchors the review-comment editor above its head.
        // Scrolling (geometry/viewport change) or leaving both the editor and
        // popup hides it; typing collapses the selection and hides it too.
        ...(viewerId === 'code' || viewerId === 'markdown' ? [
          CodeMirrorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged) {
              hidePopup()
              return
            }
            if (!update.view.hasFocus && !popupHostRef.current?.contains(document.activeElement)) {
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
              text,
              {
                start: doc.lineAt(sel.from).number,
                end: doc.lineAt(sel.to).number,
              },
              rect.left - window.scrollX + (rect.right - rect.left) / 2,
              rect.top - window.scrollY,
            )
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
  }, [content, path, markdown])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  // HTML source may have been display:none while previewing; re-measure when
  // it becomes visible again. A mode flip also invalidates any selection.
  useEffect(() => {
    hidePopup()
    if (mode === 'edit') viewRef.current?.requestMeasure()
  }, [mode])

  // CodeMirror remains mounted (hidden) while the comparison is visible so
  // its draft, undo history, selection and scroll position survive. Ask it
  // to measure once it becomes visible again.
  useEffect(() => {
    hidePopup()
    if (fileMode === 'file') viewRef.current?.requestMeasure()
  }, [fileMode])

  const save = (): void => {
    const text = markdown
      ? markdownRef.current?.getMarkdown() ?? draft ?? content
      : viewRef.current?.state.doc.toString()
    if (text === undefined || savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    api.fsWrite(scope, path, text).then(() => {
      savingRef.current = false
      if (markdown) {
        savedMarkdownRef.current = text
        setDraft(text)
      } else {
        setDraft(null)
      }
      setDirty(false)
      setSaveState('saved')
    }).catch(() => {
      savingRef.current = false
      setSaveState('failed')
    })
  }

  /** Current markdown source for saving and selection-to-line lookup. */
  const mdText = draft ?? content ?? ''
  const currentText = markdown
    ? mdText
    : draft ?? viewRef.current?.state.doc.toString() ?? content ?? ''
  const imagePreviewHandler = useMemo(
    () => async (source: string) => resolveLocalMediaDest(source, scope, path, window.location.origin),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.sessionId, scope.cwd, path],
  )

  const handleMarkdownChange = (next: string, initialMarkdownNormalize: boolean): void => {
    setDraft(next)
    if (initialMarkdownNormalize) {
      // The rich editor may normalize equivalent source during its initial
      // import. Treat that serialized form as the clean visual baseline so
      // editing and then reverting does not create a false dirty state.
      savedMarkdownRef.current = next
      return
    }
    setMarkdownError('')
    setDirty(next !== savedMarkdownRef.current)
    setSaveState('idle')
  }

  /**
   * Selection popup for the visual markdown editor: a mouse-up inside the
   * container anchors the floating "add to conversation" button above the
   * selection. Line numbers come from a best-effort reverse-search of the
   * selected text in the source ({@link linesOfSelection} — an ambiguous or
   * missing hit omits them). The button's own mousedown preventDefaults so
   * the selection survives until the click commits.
   */
  const handleMarkdownMouseUp = (): void => {
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
      text,
      lines ?? undefined,
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
    const state: EditorToolbarState = {
      fileModes: editable,
      fileMode,
      modes: html,
      mode: markdown ? 'edit' : mode,
      dirty,
      editable,
      saveState,
    }
    const key = JSON.stringify(state)
    if (lastToolbarRef.current === key) return
    lastToolbarRef.current = key
    props.onToolbarState?.(state)
  })
  useEffect(() => {
    if (!hostToolbar) return
    // `save` reads live refs only, and `setMode` is the stable state setter —
    // registering this render's closures is safe for the mount's lifetime.
    props.onToolbarControls?.({ setFileMode, setMode, save })
    return () => { props.onToolbarControls?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToolbar])

  return (
    <>
      {!hostToolbar && (
      <div className={css.editorHeader}>
        {editable && (
          <div className={css.editorModeToggle} aria-label={t('editorFileMode')}>
            <button
              type="button"
              className={clsx(css.editorModeButton, fileMode === 'file' && css.editorModeActive)}
              aria-pressed={fileMode === 'file'}
              onClick={() => { setFileMode('file') }}
            >
              {t('editorFile')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, fileMode === 'diff' && css.editorModeActive)}
              aria-pressed={fileMode === 'diff'}
              onClick={() => { setFileMode('diff') }}
            >
              {t('editorDiff')}
            </button>
          </div>
        )}
        {html && fileMode === 'file' && (
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
        {editable && fileMode === 'file' && (
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
      <div className={clsx(css.editorFileSurface, fileMode === 'diff' && css.editorFileSurfaceHidden)}>
      {editable && !markdown && (
        <>
          {truncated === true && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, html && mode === 'preview' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {markdown && editable && (
        <div
          className={css.editorMarkdownVisual}
          ref={mdRef}
          onMouseUp={handleMarkdownMouseUp}
          onScrollCapture={hidePopup}
          onKeyDownCapture={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              save()
            }
          }}
        >
          {truncated === true && <div className={css.editorBanner}>{t('truncation')}</div>}
          {markdownError !== '' && <div className={clsx(css.editorBanner, css.editorStatusError)}>{markdownError}</div>}
          <MarkdownVisualEditor
            ref={markdownRef}
            markdown={content ?? ''}
            imagePreviewHandler={imagePreviewHandler}
            onChange={handleMarkdownChange}
            onError={setMarkdownError}
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
      </div>
      {fileMode === 'diff' && diffBaseline.status === 'loading' && (
        <div className={css.editorPlaceholder}>{t('loading')}</div>
      )}
      {fileMode === 'diff' && diffBaseline.status === 'error' && (
        <div className={css.editorError}>{t('editorDiffLoadError', { error: diffBaseline.message })}</div>
      )}
      {fileMode === 'diff' && diffBaseline.status === 'ready' && (
        <TextDiffView original={diffBaseline.content} current={currentText} path={path} dark={dark} />
      )}
      {fileMode === 'file' && popup !== null && createPortal(
        <form
          ref={popupHostRef}
          className={clsx(css.selectionPopup, popup.below && css.selectionPopupBelow)}
          style={{ left: popup.left, top: popup.top }}
          onSubmit={(event) => { event.preventDefault(); commitPopup() }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hidePopup()
          }}
        >
          <div className={css.selectionPopupLocation}>{headerOf(path, scope.cwd, popup.lines)}</div>
          <textarea
            autoFocus
            value={popup.body}
            placeholder={t('fileCommentsPlaceholder')}
            aria-label={t('fileCommentsPlaceholder')}
            onChange={(event) => { updatePopupBody(event.currentTarget.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                hidePopup()
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                commitPopup()
              }
            }}
          />
          <div className={css.selectionPopupActions}>
            <button type="button" onClick={hidePopup}>{t('cancel')}</button>
            <button type="submit" disabled={popup.body.trim() === ''}>{t('save')}</button>
          </div>
        </form>,
        document.body,
      )}
    </>
  )
}
