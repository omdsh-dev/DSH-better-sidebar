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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps } from './markdown-labels.tsx'
import { api, htmlUrl } from './api.ts'
import { markdownPreviewSource } from './markdown-frontmatter.ts'
import { rewriteLocalImageUrls } from './markdown-images.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { useSelectionPopup } from './selection-popup.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { analyzeMarkdownHtml } from './markdown-html.ts'
import { LazyMermaidMarkdown, MarkdownDocument, type MarkdownHtmlMedia } from './MarkdownHtml.tsx'
import { MdToc } from './md-toc.tsx'
import { splitMermaidBlocks } from './mermaid-blocks.ts'
import { t } from './locales.ts'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/**
 * The sandbox tokens of the HTML preview iframe. NO allow-same-origin (the
 * preview must stay in an opaque origin — with the route's own origin it
 * could read session data) and NO allow-top-navigation (a previewed page
 * must not hijack the GUI). The user can disable the sandbox per-feature
 * in the side card settings (warned); the toggle below reflects it.
 */
export const HTML_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-downloads allow-modals'

/** Per-file preview scroll memory. Module-level so it survives viewer
 *  remounts: the save-then-switch-to-preview reload (EditorHost #215 case B)
 *  rebuilds the whole TextEditor instance, and without this the preview
 *  would remount at the top. Keyed by session + path; a fresh entry reads 0
 *  (new file opens at the top), re-opens/toggles restore the last position. */
const previewScrollMemory = new Map<string, number>()
const previewScrollKey = (scope: { sessionId: string }, path: string): string => `${scope.sessionId}::${path}`

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
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement>(null)
  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'
  /** Preview scroll position across the preview<->edit toggle. The preview
   *  container re-mounts on every mode switch and its scrollTop lives on that
   *  element, so capture it on scroll and restore after each remount. Seeded
   *  from the module-level per-file memory so a full viewer rebuild
   *  (save-then-switch-to-preview reload) also keeps the position. */
  const previewScrollRef = useRef(previewScrollMemory.get(previewScrollKey(scope, path)) ?? 0)
  /** True while a programmatic restore is in flight; raw scroll events caused
   *  by the restore (or by the browser clamping a collapsed reload container
   *  to 0) must not overwrite the remembered position. */
  const restoringRef = useRef(false)
  /** Preview-side handoff data for the preview -> edit switch: the text at the
   *  top of the preview viewport (best-effort) plus the scroll ratio. Captured
   *  throttled on preview scroll; consumed when entering edit mode so the
   *  editor opens where the reader was instead of at the file top. */
  const previewSyncRef = useRef<{ text: string | null; ratio: number }>({ text: null, ratio: 0 })
  const anchorThrottleRef = useRef(false)

  /**
   * The floating "add to conversation" popup (viewport-anchored; null =
   * hidden). The hook owns show/hide/commit plus the global dismissal
   * listeners (outside mousedown, Escape, hidden tab/window, surface
   * leaving the viewport) — see selection-popup.ts.
   */
  const selectionPopup = useSelectionPopup({
    onCommit: (insert) => { appendToDraft(ctx, scope.sessionId, insert) },
    // The surface that must stay on screen: the markdown preview container
    // in preview mode, the CodeMirror host otherwise.
    getSurface: () => (markdown && mode === 'preview' ? mdRef.current : hostRef.current),
  })

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // A new file (tab switch) starts clean: fresh preview mode, no draft.
  useEffect(() => {
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    selectionPopup.hide()
  }, [content])

  // A different file switches the remembered preview scroll position to that
  // file's own entry (first open: none, so the preview starts at the top).
  useEffect(() => {
    previewScrollRef.current = previewScrollMemory.get(previewScrollKey(scope, path)) ?? 0
  }, [path])

  // Create the CodeMirror editor once the content is loaded. The view owns
  // the document; React only tracks dirty state through the update listener
  // (the draft — the preview's text — is snapshotted from the live view on
  // entering preview, not re-stringified per keystroke). For markdown the
  // view stays mounted while previewing (hidden), so unsaved edits survive
  // the preview/edit toggle. The theme + syntax colors live in a compartment
  // so a scheme flip reconfigures only that part — the document, undo
  // history and scroll position survive.
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
        ...(language !== null ? [language] : []),
        CodeMirrorView.updateListener.of((update) => {
          if (update.docChanged) {
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
              selectionPopup.hide()
              return
            }
            if (!update.view.hasFocus) {
              selectionPopup.hide()
              return
            }
            if (!(update.selectionSet || update.docChanged || update.focusChanged)) return
            const sel = update.state.selection.main
            if (sel.empty) {
              selectionPopup.hide()
              return
            }
            const text = update.state.sliceDoc(sel.from, sel.to)
            if (text.trim() === '') {
              selectionPopup.hide()
              return
            }
            // Page coordinates (the document root may scroll); the popup is
            // position:fixed, so convert to viewport coordinates.
            const rect = update.view.coordsAtPos(sel.head)
            if (rect === null) {
              selectionPopup.hide()
              return
            }
            const doc = update.state.doc
            selectionPopup.show(
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
  // flip also invalidates any anchored selection popup. When entering edit
  // from a scrolled preview, the editor opens where the reader was: the line
  // mapped from the text anchored at the preview viewport top (or, failing a
  // unique text match, the proportional scroll position).
  useEffect(() => {
    selectionPopup.hide()
    if (mode !== 'edit') return
    const view = viewRef.current
    if (view === null) return
    const sync = previewSyncRef.current
    if (!markdown) return
    const doc = view.state.doc
    let target: number | undefined
    if (sync.text !== null) {
      const lines = linesOfSelection(mdText, sync.text)
      if (lines !== null) target = doc.line(Math.min(lines.start, doc.lines)).from
    }
    // ratio === 1 means the reader was at the very bottom (e.g. the last
    // block's text is a repeated filler line that linesOfSelection rejects
    // as ambiguous) — it must still land the editor at the bottom.
    if (target === undefined && sync.ratio > 0 && sync.ratio <= 1) {
      target = Math.max(1, Math.min(doc.length - 1, Math.round(doc.length * sync.ratio)))
    }
    if (target === undefined) return
    // Position the editor by writing its OWN scroller directly (after a fresh
    // measure) instead of CodeMirror's scrollIntoView: that path walks every
    // scrollable ancestor — and even the window when the browser is zoomed
    // (visualViewport < innerHeight) — to reveal the target, which dragged
    // the whole sidebar up when the reader was at the very end of the
    // document. A plain scrollTop write on the editor scroller can never
    // touch anything outside the editor.
    view.requestMeasure()
    view.dispatch({ selection: { anchor: target } })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const block = view.lineBlockAt(target)
        view.scrollDOM.scrollTop = Math.max(0, block.top - 8)
        // Force CodeMirror to re-measure and re-render its virtualized
        // viewport at the NEW scroll position (its scroll-observer is async
        // and can lag a direct write).
        view.requestMeasure()
      })
    })
  }, [mode])

  // Snapshot the live document into the draft whenever the preview needs
  // it: entering preview (the markdown preview renders `draft ?? content`)
  // and a content swap (the view was just re-created above, so the read is
  // the new document — matching the reset-to-null of a clean tab). The
  // updateListener used to re-stringify the WHOLE document on every
  // keystroke (O(docLength) per key) for a draft only preview reads.
  useEffect(() => {
    const view = viewRef.current
    setDraft(view === null ? null : view.state.doc.toString())
  }, [mode, content])

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

  /** The markdown source the preview renders (draft wins over saved content). */
  const mdText = draft ?? content ?? ''
  /** Preview-only source with a closed leading YAML frontmatter block hidden.
   *  The raw `mdText` stays untouched for editing, saving, and selection line
   *  lookup. All preview renderers share this source so plain Markdown,
   *  Mermaid, and documents containing raw HTML behave consistently. */
  const previewMdText = markdown ? markdownPreviewSource(mdText) : mdText

  // Re-apply the remembered preview scroll position whenever the preview
  // container mounts or its content changes (mode flip back to preview, or a
  // same-file reload — e.g. the save-then-switch-to-preview reload — which
  // temporarily collapses the container and clamps scrollTop to 0). Restored
  // in a before-paint layout effect so the user never sees the top flash.
  useLayoutEffect(() => {
    if (mode !== 'preview') return
    const el = mdRef.current
    if (el === null || previewScrollRef.current <= 0) return
    if (el.scrollHeight <= el.clientHeight) return
    if (el.scrollTop === previewScrollRef.current) return
    restoringRef.current = true
    el.scrollTop = previewScrollRef.current
    requestAnimationFrame(() => { restoringRef.current = false })
  }, [mode, previewMdText])

  /** The preview source with local image destinations rewritten to absolute
   *  media URLs (see {@link rewriteLocalImageUrls}). */
  const previewText = markdown
    ? rewriteLocalImageUrls(previewMdText, scope, path, window.location.origin)
    : previewMdText
  /** md/mermaid block split for the preview (mermaid fences lift out). Split
   *  only in preview mode: edit-mode keystrokes must not re-scan the source. */
  const mdBlocks = useMemo(
    () => (markdown && mode === 'preview' ? splitMermaidBlocks(previewMdText) : []),
    [markdown, mode, previewMdText],
  )
  /** Raw-HTML analysis (block runs lifted out + inline gate). Non-null only
   *  for documents that actually contain HTML — plain markdown keeps the
   *  legacy single-pass render path below, byte-for-byte. */
  const htmlInfo = useMemo(
    () => (markdown && mode === 'preview' ? analyzeMarkdownHtml(previewMdText) : null),
    [markdown, mode, previewMdText],
  )
  const hasMermaid = useMemo(
    () => htmlInfo !== null
      ? htmlInfo.segments.some((segment) => segment.kind === 'markdown'
        && splitMermaidBlocks(segment.text).some((block) => block.kind === 'mermaid'))
      : mdBlocks.some((block) => block.kind === 'mermaid'),
    [htmlInfo, mdBlocks],
  )
  /** The media context for the split renderer (local-src rewriting inside
   *  sanitized HTML). Memoized on primitives: MarkdownDocument sanitizes per
   *  `media` identity, so a fresh object per render would re-sanitize every
   *  keystroke. */
  const htmlMedia = useMemo<MarkdownHtmlMedia>(
    () => ({ scope, path, origin: window.location.origin }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.sessionId, scope.cwd, path],
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
      selectionPopup.hide()
      return
    }
    const host = mdRef.current
    if (host === null || !host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) {
      selectionPopup.hide()
      return
    }
    const text = sel.toString()
    if (text.trim() === '') {
      selectionPopup.hide()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const lines = linesOfSelection(mdText, text)
    selectionPopup.show(
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
          onScroll={(event) => {
            const el = event.currentTarget
            if (!restoringRef.current && el.scrollHeight > el.clientHeight) {
              previewScrollRef.current = el.scrollTop
              previewScrollMemory.set(previewScrollKey(scope, path), el.scrollTop)
            }
            if (!anchorThrottleRef.current) {
              anchorThrottleRef.current = true
              setTimeout(() => { anchorThrottleRef.current = false }, 120)
              const ratio = el.scrollHeight > el.clientHeight
                ? el.scrollTop / (el.scrollHeight - el.clientHeight)
                : 0
              // The first block below the viewport's top edge, chosen with
              // layout coordinates (caretRangeFromPoint needs an in-viewport
              // point and returns null when the panel is partially off-screen).
              // Its text is the anchor the editor syncs to on preview -> edit.
              let text: string | null = null
              const base = el.getBoundingClientRect()
              const blocks = el.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li')
              for (const block of blocks) {
                if (block.getBoundingClientRect().top - base.top + el.scrollTop >= el.scrollTop - 2) {
                  const t = (block.textContent ?? '').replace(/[ \t\r\n]+/g, ' ').trim()
                  if (t.length >= 8) text = t
                  break
                }
              }
              previewSyncRef.current = { text, ratio }
            }
            selectionPopup.hide()
          }}
        >
          {/* The fence copy-button labels must come from this plugin's own
              dictionary: the DSH MarkdownText/CodeBlock are cordis-free and
              fall back to hardcoded Chinese otherwise (same pattern as the
              chat's AssistantMarkdown). Render-time t() keeps them following
              the active locale on live switches. Plain markdown (no HTML)
              renders exactly as before — one MarkdownText pass for the whole
              document, or the mermaid lazy chunk (single markdown parse;
              cross-fence references/footnotes stay intact) when a mermaid
              fence exists. Documents containing HTML (block runs or inline
              tags) render through the split document renderer: markdown runs
              keep the MarkdownText/mermaid path while raw-HTML runs render
              as sanitized DOM (see markdown-html.tsx). */}
          {/* The outline button rides on top of the preview scroll container
              (sticky, zero-height — first child so it pins from the very
              top) once the document has enough headings. */}
          <MdToc />
          {htmlInfo !== null
            ? <MarkdownDocument info={htmlInfo} media={htmlMedia} codeLabels={codeLabels} />
            : hasMermaid
              ? <LazyMermaidMarkdown text={previewText} codeLabels={codeLabels} />
              : <MarkdownText {...markdownTextProps(previewText, codeLabels)} />}
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
      {selectionPopup.popup !== null && createPortal(
        <button
          type="button"
          ref={selectionPopup.buttonRef}
          className={css.selectionPopup}
          style={{ left: selectionPopup.popup.left, top: selectionPopup.popup.top }}
          // Keep the selection (and CodeMirror focus) alive until the click
          // commits — without this the popup unmounts before click lands.
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={selectionPopup.commit}
        >
          {t('addToConversation')}
        </button>,
        document.body,
      )}
    </>
  )
}
