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
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, htmlUrl, SidebarApiError } from './api.ts'
import {
  deleteEditorBuffer,
  getEditorBuffer,
  saveEditorBuffer,
  type EditorViewMode,
} from './editor-buffers.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { splitMermaidBlocks, type MermaidMarkdownProps } from './mermaid-blocks.ts'
import type { VisualMarkdownEditorProps } from './VisualMarkdownEditor.tsx'
import { t } from './locales.ts'
import type { EditorMode, EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output, source editing, or visual GFM editing). */
type ViewMode = EditorViewMode

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

/** Milkdown stays out of the CodeMirror chunk until visual mode is opened. */
const LazyVisualMarkdownEditor = lazyChunkComponent<VisualMarkdownEditorProps>(
  'markdown-editor',
  (mod) => mod.VisualMarkdownEditor as ComponentType<VisualMarkdownEditorProps> | undefined,
)

/** The rendered-preview body, exported so its locale wiring stays unit-testable. */
export function MarkdownPreviewContent(props: { text: string; hasMermaid: boolean }) {
  const codeLabels = { copyLabel: t('copy'), copiedLabel: t('copied') }
  return props.hasMermaid
    ? <LazyMermaidMarkdown text={props.text} codeLabels={codeLabels} />
    : <MarkdownText text={props.text} codeLabels={codeLabels} />
}

function defaultViewMode(viewerId: string): ViewMode {
  return viewerId === 'markdown' ? 'visual' : 'preview'
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
  const { ctx, scope, path, viewerId, content, truncated, version } = props
  const [mode, setMode] = useState<ViewMode>(() => defaultViewMode(viewerId))
  /** Text chosen after the IndexedDB draft lookup; undefined while restoring. */
  const [hydratedText, setHydratedText] = useState<string | undefined>(undefined)
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const baseVersionRef = useRef<string | null>(version ?? null)
  const savedTextRef = useRef(content ?? '')
  const staleDraftRef = useRef(false)
  const modeRef = useRef<ViewMode>(defaultViewMode(viewerId))
  const [visualSeed, setVisualSeed] = useState(() => viewerId === 'markdown' ? content ?? '' : '')
  const [conflict, setConflict] = useState<'restored' | 'save' | null>(null)
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

  const setDirtyValue = (value: boolean): void => {
    dirtyRef.current = value
    setDirty(value)
  }

  const persistDraft = (text: string, nextMode: ViewMode = modeRef.current): void => {
    if (!dirtyRef.current) return
    void saveEditorBuffer({
      sessionId: scope.sessionId,
      path,
      text,
      baseVersion: baseVersionRef.current,
      mode: nextMode,
    })
  }

  /** Restore a dirty draft before CodeMirror is constructed. */
  useEffect(() => {
    let cancelled = false
    const defaultMode = defaultViewMode(viewerId)
    setHydratedText(undefined)
    setMode(defaultMode)
    modeRef.current = defaultMode
    setVisualSeed(defaultMode === 'visual' ? content ?? '' : '')
    setDraft(null)
    draftRef.current = null
    setDirtyValue(false)
    setConflict(null)
    staleDraftRef.current = false
    baseVersionRef.current = version ?? null
    savedTextRef.current = content ?? ''
    setSaveState('idle')
    hidePopup()
    if (content === undefined) return () => { cancelled = true }
    void getEditorBuffer(scope.sessionId, path).then((record) => {
      if (cancelled) return
      if (record === undefined) {
        setHydratedText(content)
        return
      }
      const restoredMode: ViewMode = viewerId === 'markdown' ? record.mode : record.mode === 'visual' ? 'edit' : record.mode
      const stale = record.baseVersion !== (version ?? null)
      baseVersionRef.current = record.baseVersion
      staleDraftRef.current = stale
      modeRef.current = restoredMode
      setMode(restoredMode)
      if (restoredMode === 'visual') setVisualSeed(record.text)
      draftRef.current = record.text
      setDraft(record.text)
      setDirtyValue(true)
      setConflict(stale ? 'restored' : null)
      setHydratedText(record.text)
    }).catch(() => {
      if (!cancelled) setHydratedText(content)
    })
    return () => { cancelled = true }
  }, [content, path, scope.sessionId, version, viewerId])

  // Create the CodeMirror editor once the content is loaded. The view owns
  // the document; React only tracks dirty/draft state through the update
  // listener. For markdown the view stays mounted while previewing (hidden),
  // so unsaved edits survive the preview/edit toggle. The theme + syntax
  // colors live in a compartment so a scheme flip reconfigures only that
  // part — the document, undo history and scroll position survive.
  useEffect(() => {
    if (hydratedText === undefined) return
    const host = hostRef.current
    if (host === null) return
    const language = languageForPath(path)
    const themeComp = new CmThemeCompartment()
    themeCompRef.current = themeComp
    const state = EditorState.create({
      doc: hydratedText,
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
          if (!update.docChanged) return
          const text = update.state.doc.toString()
          const clean = !staleDraftRef.current && text === savedTextRef.current
          draftRef.current = clean ? null : text
          setDraft(clean ? null : text)
          setDirtyValue(!clean)
          setSaveState('idle')
          if (clean) {
            void deleteEditorBuffer(scope.sessionId, path)
          } else {
            persistDraft(text)
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
    return () => {
      if (dirtyRef.current) persistDraft(view.state.doc.toString())
      view.destroy()
      viewRef.current = null
      themeCompRef.current = null
    }
    // The keymap's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the reconfigure
    // effect below (recreating the view here would drop the draft).
  }, [hydratedText, path])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  const switchMode = (next: ViewMode): void => {
    if (next === 'visual') {
      setVisualSeed(viewRef.current?.state.doc.toString() ?? draftRef.current ?? hydratedText ?? content ?? '')
    }
    modeRef.current = next
    setMode(next)
    if (dirtyRef.current && draftRef.current !== null) persistDraft(draftRef.current, next)
  }

  // The editor may have been display:none while previewing; re-measure when
  // it becomes visible again (CodeMirror sizes itself on reveal). A mode
  // flip also invalidates any anchored selection popup.
  useEffect(() => {
    hidePopup()
    if (mode === 'edit') viewRef.current?.requestMeasure()
  }, [mode])

  const writeCurrent = (force: boolean): void => {
    const view = viewRef.current
    if (view === null || savingRef.current || truncated === true) return
    const text = view.state.doc.toString()
    savingRef.current = true
    setSaveState('saving')
    api.fsWrite(scope, path, text, force
      ? { force: true }
      : { expectedVersion: baseVersionRef.current }).then((result) => {
      savingRef.current = false
      baseVersionRef.current = result.version
      savedTextRef.current = text
      staleDraftRef.current = false
      draftRef.current = null
      setDraft(null)
      setDirtyValue(false)
      setConflict(null)
      setSaveState('saved')
      void deleteEditorBuffer(scope.sessionId, path)
    }).catch((error: unknown) => {
      savingRef.current = false
      if (error instanceof SidebarApiError && error.code === 'fs-conflict') {
        setConflict('save')
      }
      setSaveState('failed')
    })
  }

  const save = (): void => { writeCurrent(false) }

  const reloadFromDisk = (): void => {
    if (savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    api.fsRead(scope, path).then((result) => {
      if (result.kind !== 'text') throw new Error('file is no longer text')
      baseVersionRef.current = result.version
      savedTextRef.current = result.content
      staleDraftRef.current = false
      const view = viewRef.current
      if (view !== null) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.content } })
      }
      draftRef.current = null
      setDraft(null)
      setDirtyValue(false)
      setConflict(null)
      setSaveState('idle')
      void deleteEditorBuffer(scope.sessionId, path)
    }).catch(() => {
      setSaveState('failed')
    }).finally(() => {
      savingRef.current = false
    })
  }

  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'
  const handleVisualChange = (text: string): void => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === text) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }
  /** The markdown source the preview renders (draft wins over saved content). */
  const mdText = draft ?? savedTextRef.current
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
  const loaded = hydratedText !== undefined
  const editable = loaded && truncated !== true
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
  const availableModes: readonly EditorMode[] = markdown ? ['preview', 'visual', 'edit'] : html ? ['preview', 'edit'] : []
  const lastToolbarRef = useRef('')
  useEffect(() => {
    if (!hostToolbar) return
    const state: EditorToolbarState = { modes: availableModes, mode, dirty, editable, saveState }
    const key = JSON.stringify(state)
    if (lastToolbarRef.current === key) return
    lastToolbarRef.current = key
    props.onToolbarState?.(state)
  })
  useEffect(() => {
    if (!hostToolbar) return
    // `save` reads live refs only, and `setMode` is the stable state setter —
    // registering this render's closures is safe for the mount's lifetime.
    props.onToolbarControls?.({ setMode: switchMode, save })
    return () => { props.onToolbarControls?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToolbar])

  return (
    <>
      {!hostToolbar && (
      <div className={css.editorHeader}>
        {availableModes.length > 0 && (
          <div className={css.editorModeToggle}>
            {availableModes.map(candidate => (
              <button
                key={candidate}
                type="button"
                className={clsx(css.editorModeButton, mode === candidate && css.editorModeActive)}
                onClick={() => { switchMode(candidate) }}
              >
                {candidate === 'preview' ? t('preview') : candidate === 'visual' ? t('visualEdit') : t('sourceEdit')}
              </button>
            ))}
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
      {conflict !== null && (
        <div className={clsx(css.editorBanner, css.editorConflictBanner)}>
          <span>{conflict === 'restored' ? t('draftConflictRestored') : t('saveConflict')}</span>
          <div className={css.editorBannerActions}>
            <button type="button" onClick={reloadFromDisk}>{t('reloadDisk')}</button>
            <button type="button" onClick={() => { writeCurrent(true) }}>{t('overwriteDisk')}</button>
          </div>
        </div>
      )}
      {loaded && (
        <>
          {truncated === true && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, ((markdown && mode !== 'edit') || (html && mode === 'preview')) && css.editorCmHidden)}
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
          <MarkdownPreviewContent text={mdText} hasMermaid={hasMermaid} />
        </div>
      )}
      {markdown && mode === 'visual' && (
        <LazyVisualMarkdownEditor
          initialMarkdown={visualSeed}
          onChange={handleVisualChange}
          loadingLabel={t('loading')}
          errorLabel={t('visualEditorFailed')}
        />
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
