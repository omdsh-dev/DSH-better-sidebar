/**
 * The code/markdown file viewer: a CodeMirror 6 editor with line wrapping,
 * syntax highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S
 * save, and preview/source/writing modes for markdown files. Registered as the
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { IconCheckOutlineRegular, IconSearchOutlineRegular, MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps } from './markdown-labels.tsx'
import {
  applyGitLineKinds,
  CmGitGutterCompartment,
  useEditorGitGutter,
  type GitGutterHost,
} from './editor-git-gutter.ts'
import { api, htmlUrl, SidebarApiError } from './api.ts'
import { hostTransportBase } from './desktop-env.ts'
import { markdownPreviewSource } from './markdown-frontmatter.ts'
import { rewriteLocalImageUrls } from './markdown-images.ts'
import { rewriteLocalMarkdownLinks } from './markdown-navigation.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { cmSearchExtensions, CmSearchPhrases } from './cm-search.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { useSelectionPopup } from './selection-popup.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { analyzeMarkdownHtml } from './markdown-html.ts'
import { LazyMermaidMarkdown, MarkdownDocument, type MarkdownHtmlMedia } from './MarkdownHtml.tsx'
import { useMarkdownSurface } from './use-markdown-surface.ts'
import { MdToc } from './md-toc.tsx'
import { splitMermaidBlocks } from './mermaid-blocks.ts'
import { localeSignature, t } from './locales.ts'
import { HTML_IFRAME_SANDBOX } from './html-preview.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { supportsVisualMarkdown } from './markdown-visual.ts'
import type { WritingEditorProps } from './WritingEditor.tsx'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import type { ComponentType } from 'react'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit' | 'writing'
const sessionModes = new Map<string, ViewMode>()
const LazyWritingEditor = lazyChunkComponent<WritingEditorProps>('writing', mod => mod.WritingEditor as ComponentType<WritingEditorProps> | undefined)

/** Per-file preview scroll memory. Module-level so it survives viewer
 *  remounts: the save-then-switch-to-preview reload (EditorHost #215 case B)
 *  rebuilds the whole TextEditor instance, and without this the preview
 *  would remount at the top. Keyed by session + path; a fresh entry reads 0
 *  (new file opens at the top), re-opens/toggles restore the last position. */
const previewScrollMemory = new Map<string, number>()
const previewScrollKey = (scope: { sessionId: string }, path: string): string => `${scope.sessionId}::${path}`

/** Whether two spellings are the SAME document — byte-equal, or equal once
 *  line endings are normalized CRLF/CR → LF. Line endings are not content:
 *  CodeMirror keeps every document with `\n` endings whatever the file used,
 *  so the live document of a freshly opened CRLF file differs from the bytes
 *  it was loaded from by line endings alone. */
function sameDocument(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')
}

export function TextEditor(props: FileViewerProps) {
  const { ctx, scope, path, viewerId, content, truncated } = props
  const markdown = viewerId === 'markdown'
  const [mode, setMode] = useState<ViewMode>(() => markdown ? sessionModes.get(scope.sessionId) ?? 'preview' : 'preview')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const chooseMode = useCallback((next: ViewMode): void => {
    if (next === 'writing') {
      const live = viewRef.current?.state.doc.toString()
      if (live !== undefined) setDraft(live)
    }
    setMode(next)
    if (markdown) sessionModes.set(scope.sessionId, next)
  }, [markdown, scope.sessionId])
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  /** The save was refused because the file changed on disk (fs-conflict). */
  const [conflict, setConflict] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)
  /** The mtime the draft is based on (`null` = the file did not exist yet).
   *  Seeded from the load, refreshed by every successful save, and reset by
   *  the file-switch effect. */
  const mtimeRef = useRef<number | null>(props.mtimeMs ?? null)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The search-phrases compartment of the current view (reconfigured on a
   *  language switch — the panel copy is baked into the EditorState). */
  const searchPhrasesRef = useRef<CmSearchPhrases | null>(null)
  /** The uncommitted-change gutter compartment (issue #212; reconfigured on a
   *  setting flip instead of rebuilding the view). */
  const gitCompRef = useRef<CmGitGutterCompartment | null>(null)
  /** The effective UI language (DSH locale id + better-locale override id).
   *  Read during render and subscribed below: the tab-cell memo only
   *  compares the DSH locale revision, so a better-locale override switch
   *  would otherwise never reach this component. */
  const [localeSig, setLocaleSig] = useState(() => localeSignature())
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement | null>(null)
  /** Heading slugs, anchor jumps and `.md` link claiming for the preview (the
   *  delegate provider wrapped around the markdown is its claim boundary — see
   *  use-markdown-surface). */
  const { surfaceRef: markdownSurfaceRef, openFile: openSurfaceFile } = useMarkdownSurface({
    ctx,
    sessionId: scope.sessionId,
    cwd: scope.cwd,
    path,
  })
  /** One ref callback for the preview container: the selection/scroll code
   *  above keeps its object ref, the surface installer gets the same element.
   *  A stable identity matters — a fresh callback on every render would make
   *  React re-attach (and re-scan) on every render. */
  const previewRef = useCallback((element: HTMLDivElement | null) => {
    mdRef.current = element
    markdownSurfaceRef(element)
  }, [markdownSurfaceRef])
  const html = viewerId === 'html'
  /** The uncommitted-change gutter (issue #212): the `code` viewer only,
   *  gated by ONE boolean setting (on by default). Nothing else — no
   *  end-of-line author widget, no badges, no animation. Read reactively
   *  (same seam as the host's editorExplorer read) so flipping the switch
   *  reconfigures the live view in place instead of waiting for a reopen. */
  const gitGutterPref = useSyncExternalStore(
    useCallback((callback: () => void) => props.store.subscribe(callback), [props.store]),
    useCallback(() => props.store.getSnapshot().prefs.editorGitGutter !== false, [props.store]),
    // Server snapshot: this component is rendered to a string by the markdown
    // preview specs. The value only feeds effects (the extensions are built
    // client-side), so the store answers on both sides alike.
    useCallback(() => props.store.getSnapshot().prefs.editorGitGutter !== false, [props.store]),
  )
  const gitGutterEnabled = viewerId === 'code' && gitGutterPref
  /** Bumped by every save: the uncommitted diff moved while the file's git
   *  status entry (which only tracks its XY code) did not. */
  const [gitRevision, setGitRevision] = useState(0)
  /** The view-side identity of the gutter's git source (stable across the
   *  scope object's per-render identity churn). */
  const gitHost = useMemo<GitGutterHost>(
    () => ({ scope: { sessionId: scope.sessionId, cwd: scope.cwd, repoRoot: scope.repoRoot }, path }),
    [scope.sessionId, scope.cwd, scope.repoRoot, path],
  )
  const gitKinds = useEditorGitGutter({ enabled: gitGutterEnabled, scope, path, content, revision: gitRevision })
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

  // Keep `localeSig` fresh from BOTH language sources: the DSH locale service
  // and (when @huanlin/dsh-plugin-better-locale is installed) the override
  // store. The sidebar root re-renders the tree on a DSH locale switch, but
  // an override switch is not part of the tab-cell memo key, so this
  // component subscribes directly instead of relying on a parent render.
  useEffect(() => {
    const sync = (): void => { setLocaleSig(localeSignature()) }
    sync()
    const locale = ctx.locale as { subscribe?: (cb: () => void) => () => void } | undefined
    type BetterLocaleStore = { subscribe?(listener: () => void): () => void }
    const betterLocale = typeof ctx.get === 'function'
      ? (ctx as unknown as { get(name: 'betterLocale'): BetterLocaleStore | undefined }).get('betterLocale')
      : undefined
    const offLocale = locale?.subscribe?.(sync)
    const offOverride = betterLocale?.subscribe?.(sync)
    return () => {
      offLocale?.()
      offOverride?.()
    }
  }, [ctx])

  // 切换文件时清除草稿，并恢复当前会话选定的编辑模式。
  useEffect(() => {
    const remembered = markdown ? sessionModes.get(scope.sessionId) ?? 'preview' : 'preview'
    setMode(remembered === 'writing' && !supportsVisualMarkdown(content ?? '') ? 'preview' : remembered)
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    setConflict(false)
    // The freshly loaded bytes are the new save baseline.
    mtimeRef.current = props.mtimeMs ?? null
    selectionPopup.hide()
    // hide() reads a live ref; the reset must fire only on a content (file)
    // swap, and the hook object's identity churns on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  // A different file switches the remembered preview scroll position to that
  // file's own entry (first open: none, so the preview starts at the top).
  useEffect(() => {
    previewScrollRef.current = previewScrollMemory.get(previewScrollKey(scope, path)) ?? 0
  }, [scope, path])

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
    const searchPhrases = new CmSearchPhrases()
    searchPhrasesRef.current = searchPhrases
    const gitComp = new CmGitGutterCompartment()
    gitCompRef.current = gitComp
    const state = EditorState.create({
      doc: content,
      extensions: [
        CodeMirrorView.lineWrapping,
        // The change bar sits BEFORE the line numbers (VS Code's own order):
        // a thin colored bar at the far left, the number tinted beside it.
        // The compartment carries all of it (hover blame included), so the
        // setting can flip it in place below.
        gitComp.of(gitGutterEnabled ? gitHost : null),
        lineNumbers(),
        history(),
        EditorState.tabSize.of(2),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(dark),
        // Find-in-file (Cmd/Ctrl+F): the top-pinned search panel plus the
        // upstream search keymap, registered BEFORE the editor's own keymap
        // below so the search bindings (Escape in particular — the editor
        // keymap's `simplifySelection` shares that key) win while the panel
        // is open, and the save key stays in the editor keymap unchanged.
        ...cmSearchExtensions(),
        searchPhrases.of(),
        // A truncated read only carries the first readLimit bytes; edits made
        // on partial content must never be saved over the full file (issue
        // #732), so the document is rendered read-only until a full read
        // replaces it.
        ...(truncated === true ? [EditorState.readOnly.of(true)] : []),
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
      searchPhrasesRef.current = null
      gitCompRef.current = null
    }
    // The keymap's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the reconfigure
    // effect below (recreating the view here would drop the draft).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path, truncated])

  // Native sidebar tabs stay mounted while another tab is active. If a file
  // is opened while that host is hidden, CodeMirror can measure its viewport at
  // zero and retain an empty virtualized viewport after the tab is revealed.
  // Re-measure both on mount and whenever the host's box changes so returning
  // to a parked editor always repaints its document without remounting it.
  useEffect(() => {
    const host = hostRef.current
    const view = viewRef.current
    if (host === null || view === null) return
    const measure = (): void => {
      if (host.isConnected && host.offsetWidth > 0 && host.offsetHeight > 0) view.requestMeasure()
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [content, path])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  // Language switch: re-resolve the search panel copy in place. CodeMirror
  // reads the `phrases` facet when it builds the panel, so the compartment
  // must be reconfigured for the new language (the document, history,
  // scroll, and keymaps survive — same in-place pattern as the theme flip).
  useEffect(() => {
    const view = viewRef.current
    const searchPhrases = searchPhrasesRef.current
    if (view === null || searchPhrases === null) return
    view.dispatch({ effects: searchPhrases.reconfigure() })
  }, [localeSig])

  // The uncommitted-change gutter follows the setting in place: the
  // compartment swap installs (or removes) the decoration extensions and the
  // hover blame without rebuilding the view — the document, history and
  // scroll survive, exactly like the theme and search flips above.
  useEffect(() => {
    const view = viewRef.current
    const gitComp = gitCompRef.current
    if (view === null || gitComp === null) return
    view.dispatch({ effects: gitComp.reconfigure(gitGutterEnabled ? gitHost : null) })
  }, [gitGutterEnabled, gitHost])

  // Push the line map into the live view. `content` / `truncated` re-run this
  // after the view was rebuilt for a new file, and `gitGutterEnabled` after a
  // re-install (a reconfigured state field starts empty).
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    applyGitLineKinds(view, gitKinds)
  }, [gitKinds, gitGutterEnabled, content, path, truncated])

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
    // The reveal reads the live document/view refs; only the flip into
    // preview triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Snapshot the live document into the draft whenever the preview needs
  // it: entering preview (the markdown preview renders `draft ?? content`)
  // and a content swap (the view was just re-created above, so the read is
  // the new document — matching the reset-to-null of a clean tab). The
  // updateListener used to re-stringify the WHOLE document on every
  // keystroke (O(docLength) per key) for a draft only preview reads.
  //
  // Only an EDIT becomes a draft. Publishing the live document when it is the
  // loaded content under another line-ending spelling (CodeMirror normalizes
  // CRLF → LF, so that is every CRLF file) would hand the preview a second
  // spelling of the same document one render after the mount: the renderer
  // rebuilds the markdown elements it owns, and every DOM-side pass result
  // written onto them — heading ids, collapsed anchors — is discarded with
  // them until the surface's MutationObserver re-runs (a microtask later,
  // i.e. after a synchronous caller has already looked).
  useEffect(() => {
    const view = viewRef.current
    if (view === null) { setDraft(null); return }
    const live = view.state.doc.toString()
    setDraft(content !== undefined && sameDocument(live, content) ? null : live)
  }, [mode, content])

  const save = (): void => {
    const view = viewRef.current
    if (view === null || savingRef.current) return
    // Defense in depth for issue #732: a truncated read only holds the first
    // readLimit bytes, and fs.write replaces the whole file — saving partial
    // content would destroy the tail. The readOnly extension already blocks
    // edits; this guards the keymap path against future trigger points.
    if (truncated === true) return
    savingRef.current = true
    setSaveState('saving')
    // Optimistic concurrency: the draft was based on the bytes read at
    // `mtimeMs`; a file that changed on disk since is REFUSED (fs-conflict)
    // instead of clobbering whatever wrote it (the model, another tab, an
    // external editor). `null` = the file did not exist when loaded.
    api.fsWrite(scope, path, view.state.doc.toString(), mtimeRef.current ?? null).then((result) => {
      savingRef.current = false
      // Adopt the fresh baseline the host reports (absent on a stat failure —
      // keep the old one, the next save just re-checks).
      if (typeof result.mtimeMs === 'number') mtimeRef.current = result.mtimeMs
      setDraft(modeRef.current === 'writing' ? view.state.doc.toString() : null)
      setDirty(false)
      setConflict(false)
      setSaveState('saved')
      // The saved bytes are a new revision of the uncommitted diff: re-read
      // the change set (the file's XY status code usually stays the same, so
      // the status store alone would never wake the gutter up again).
      setGitRevision(value => value + 1)
    }).catch((error: unknown) => {
      savingRef.current = false
      if (error instanceof SidebarApiError && error.code === 'fs-conflict') {
        setConflict(true)
        setSaveState('idle')
        return
      }
      setSaveState('failed')
    })
  }

  /** The markdown source the preview renders (draft wins over saved content). */
  const mdText = draft ?? content ?? ''
  const writingAvailable = useMemo(() => markdown && truncated !== true && supportsVisualMarkdown(mdText), [markdown, truncated, mdText])
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
   *  media URLs (see {@link rewriteLocalImageUrls}) and the local link
   *  destinations prepared for the host delegate (see
   *  {@link rewriteLocalMarkdownLinks}; the split renderer runs the same two
   *  passes per markdown run, and both are idempotent). */
  const previewText = markdown
    ? rewriteLocalMarkdownLinks(
      rewriteLocalImageUrls(previewMdText, scope, path, hostTransportBase()),
      path,
      scope.cwd,
    )
    : previewMdText
  /** md/mermaid block split for the preview (mermaid fences lift out). Split
   *  only in preview mode: edit-mode keystrokes must not re-scan the source. */
  const mdBlocks = useMemo(
    () => (markdown && mode === 'preview' ? splitMermaidBlocks(previewMdText) : []),
    [markdown, mode, previewMdText],
  )
  /** Raw-HTML analysis (block runs lifted out + inline gate). Non-null for
   *  every markdown preview, so the render below always takes the split
   *  renderer — its markdown runs rewrite local image destinations internally
   *  (see MarkdownHtml.tsx). The legacy single-pass branches (fed the
   *  pre-rewritten `previewText`) are dead in the current wiring. */
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
    () => ({ scope, path, baseUrl: hostTransportBase() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.sessionId, scope.cwd, path],
  )
  const codeLabels = {
    copyLabel: t('copy'),
    copiedLabel: t('copied'),
    codeLabel: t('codeBlockTitle'),
    wrapLabel: t('codeBlockWrap'),
    unwrapLabel: t('codeBlockUnwrap'),
  }

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
    const state: EditorToolbarState = { modes: markdown || html, mode, writingAvailable: markdown ? writingAvailable : undefined, dirty, editable, truncated: truncated === true, saveState }
    const key = JSON.stringify(state)
    if (lastToolbarRef.current === key) return
    lastToolbarRef.current = key
    props.onToolbarState?.(state)
  })
  useEffect(() => {
    if (!hostToolbar) return
    // `save` reads live refs only, and `setMode` is the stable state setter —
    // registering this render's closures is safe for the mount's lifetime.
    props.onToolbarControls?.({ setMode: chooseMode, save })
    return () => { props.onToolbarControls?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToolbar, chooseMode])

  return (
    <>
      {!hostToolbar && (
      <div className={css.editorHeader}>
        {(markdown || html) && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'preview' && css.editorModeActive)}
              onClick={() => { chooseMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'edit' && css.editorModeActive)}
              onClick={() => { chooseMode('edit') }}
            >
              {t('sourceMode')}
            </button>
            {markdown && <button type="button" className={clsx(css.editorModeButton, mode === 'writing' && css.editorModeActive)} disabled={!writingAvailable} title={!writingAvailable ? t('writingUnsupported') : undefined} onClick={() => { chooseMode('writing') }}>{t('writing')}</button>}
          </div>
        )}
        {dirty && <span className={css.dirtyDot} title={t('unsaved')} />}
        {editable && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('searchFind')}
            title={`${t('searchFind')} (Ctrl/Cmd+F)`}
            onClick={() => {
              // The panel lives in the CodeMirror surface: in preview mode the
              // editor is hidden, so switch to edit first (the search panel is
              // not part of the preview).
              if (mode !== 'edit' && (markdown || html)) chooseMode('edit')
              const view = viewRef.current
              if (view === null) return
              view.focus()
              openSearchPanel(view)
            }}
          >
            <IconSearchOutlineRegular size={16} />
          </button>
        )}
        {editable && truncated !== true && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={save}
          >
            <IconCheckOutlineRegular />
          </button>
        )}
        {saveLabel !== '' && <span className={clsx(css.editorStatus, saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>}
      </div>
      )}
      {editable && (
        <>
          {truncated === true && <div className={css.editorBanner}>{t('truncation')}</div>}
          {conflict && (
            <div className={css.editorBanner}>
              {t('saveConflict')}
              <button
                type="button"
                className={css.editorBannerAction}
                onClick={() => { props.onReload?.() }}
              >
                {t('saveConflictReload')}
              </button>
            </div>
          )}
          <div
            className={clsx(css.editorCm, (markdown || html) && mode !== 'edit' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {markdown && mode === 'preview' && (
        <div
          className={css.editorMd}
          ref={previewRef}
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
          {/* The host delegate makes the preview's local markdown links
              clickable at all (without it the renderer degrades them to plain
              text) and routes them through this surface's own open path. */}
          <MarkdownDelegateProvider openFile={openSurfaceFile}>
            {htmlInfo !== null
              ? <MarkdownDocument info={htmlInfo} media={htmlMedia} codeLabels={codeLabels} />
              : hasMermaid
                ? <LazyMermaidMarkdown text={previewText} codeLabels={codeLabels} />
                : <MarkdownText {...markdownTextProps(previewText, codeLabels)} />}
          </MarkdownDelegateProvider>
        </div>
      )}
      {markdown && mode === 'writing' && writingAvailable && <LazyWritingEditor value={mdText} onChange={(value) => {
        const view = viewRef.current
        if (view === null) return
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
        setDraft(value)
      }} onSave={save} />}
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
