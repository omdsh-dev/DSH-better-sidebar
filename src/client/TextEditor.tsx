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
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
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

// ── Mermaid 渲染支持 ──────────────────────────────────────────────────────
// 从 CDN 懒加载 mermaid 库，并将 markdown 预览中的 ```mermaid 代码块
// 渲染为 SVG 图片。mermaid 库较大（~1MB），仅在首次遇到 mermaid 块时加载。
let mermaidLoadPromise: Promise<unknown> | null = null
let mermaidStyleInjected = false

/**
 * 注入 CSS：
 * 1. 修复 mermaid 文本被遮挡的问题（DSH GUI 全局 line-height 约 1.75 级联到
 *    foreignObject，导致文本行高大于 mermaid 计算的 foreignObject 高度）。
 * 2. mermaid 预览图可点击放大的样式。
 * 3. 放大弹窗的样式。
 */
function injectMermaidStyle(): void {
  if (mermaidStyleInjected) return
  mermaidStyleInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.md-code-block svg foreignObject { overflow: visible; }',
    '.md-code-block svg .nodeLabel,',
    '.md-code-block svg foreignObject div {',
    '  line-height: 1.4 !important;',
    '  font-size: 14px !important;',
    '}',
    '.md-code-block svg .edgeLabel .label {',
    '  line-height: 1.4 !important;',
    '}',
    // mermaid 预览图可点击，提示用户可放大
    '.md-code-block svg { cursor: zoom-in; transition: opacity 0.2s; }',
    '.md-code-block svg:hover { opacity: 0.85; }',
    // mermaid 放大弹窗
    '.bs-mermaid-modal {',
    '  position: fixed; inset: 0; z-index: 99999;',
    '  background: rgba(0, 0, 0, 0.75);',
    '  display: flex; flex-direction: column;',
    '  align-items: center; justify-content: center;',
    '}',
    '.bs-mermaid-modal-toolbar {',
    '  position: absolute; top: 16px; right: 16px;',
    '  display: flex; gap: 8px; z-index: 10;',
    '}',
    '.bs-mermaid-modal-toolbar button {',
    '  width: 36px; height: 36px; border-radius: 8px;',
    '  border: 1px solid rgba(255,255,255,0.3);',
    '  background: rgba(255,255,255,0.15);',
    '  color: #fff; font-size: 18px; cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  backdrop-filter: blur(4px);',
    '}',
    '.bs-mermaid-modal-toolbar button:hover {',
    '  background: rgba(255,255,255,0.3);',
    '}',
    '.bs-mermaid-modal-stage {',
    '  width: 90vw; height: 80vh;',
    '  overflow: hidden; position: relative;',
    '  display: flex; align-items: center; justify-content: center;',
    '}',
    '.bs-mermaid-modal-stage svg {',
    '  max-width: none; max-height: none;',
    '  cursor: grab; transform-origin: center center;',
    '  user-select: none; -webkit-user-drag: none;',
    '  background: rgb(249, 250, 251);',
    '  padding: 16px; border-radius: 12px;',
    '}',
    '.bs-mermaid-modal-stage svg:active { cursor: grabbing; }',
    '.bs-mermaid-modal-hint {',
    '  position: absolute; bottom: 16px; left: 50%;',
    '  transform: translateX(-50%);',
    '  color: rgba(255,255,255,0.7); font-size: 12px;',
    '  pointer-events: none;',
    '}',
  ].join('\n')
  document.head.appendChild(style)
}

function loadMermaid(): Promise<unknown> {
  if (mermaidLoadPromise) return mermaidLoadPromise
  if ((globalThis as { mermaid?: unknown }).mermaid) {
    injectMermaidStyle()
    return Promise.resolve((globalThis as { mermaid: unknown }).mermaid)
  }
  mermaidLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js'
    script.async = true
    script.onload = () => {
      injectMermaidStyle()
      resolve((globalThis as { mermaid: unknown }).mermaid)
    }
    script.onerror = () => {
      mermaidLoadPromise = null
      reject(new Error('failed to load mermaid'))
    }
    document.head.appendChild(script)
  })
  return mermaidLoadPromise
}

/**
 * 打开 mermaid 放大弹窗，支持滚轮缩放、拖拽平移、按钮缩放/重置、Esc 关闭。
 */
function openMermaidModal(svgElement: SVGSVGElement): void {
  // 克隆 SVG，避免修改原预览图
  const svg = svgElement.cloneNode(true) as SVGSVGElement
  svg.removeAttribute('style')
  svg.removeAttribute('width')
  svg.removeAttribute('height')

  const overlay = document.createElement('div')
  overlay.className = 'bs-mermaid-modal'

  const toolbar = document.createElement('div')
  toolbar.className = 'bs-mermaid-modal-toolbar'

  const zoomInBtn = document.createElement('button')
  zoomInBtn.textContent = '+'
  zoomInBtn.title = '放大'
  const zoomOutBtn = document.createElement('button')
  zoomOutBtn.textContent = '−'
  zoomOutBtn.title = '缩小'
  const resetBtn = document.createElement('button')
  resetBtn.textContent = '⟳'
  resetBtn.title = '重置'
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '✕'
  closeBtn.title = '关闭'

  toolbar.append(zoomOutBtn, zoomInBtn, resetBtn, closeBtn)

  const stage = document.createElement('div')
  stage.className = 'bs-mermaid-modal-stage'
  stage.appendChild(svg)

  const hint = document.createElement('div')
  hint.className = 'bs-mermaid-modal-hint'
  hint.textContent = '滚轮缩放 · 拖拽平移 · Esc 关闭'

  overlay.append(toolbar, stage, hint)
  document.body.appendChild(overlay)

  // 缩放与平移状态
  let scale = 1
  let tx = 0
  let ty = 0
  const MIN_SCALE = 0.2
  const MAX_SCALE = 8

  function applyTransform(): void {
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  function zoom(delta: number, centerX?: number, centerY?: number): void {
    const rect = stage.getBoundingClientRect()
    const cx = centerX ?? rect.width / 2
    const cy = centerY ?? rect.height / 2
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * delta))
    // svg 通过 flex 居中于 stage，其中心位于 (rect.width/2, rect.height/2)。
    // 缩放时以鼠标位置为不动点，推导平移量：
    //   鼠标点在 svg 局部坐标中为 ((cx - sx - tx)/scale, (cy - sy - ty)/scale)
    //   缩放后该点在 stage 中位置不变，解出新的 tx/ty。
    const sx = rect.width / 2
    const sy = rect.height / 2
    const ratio = newScale / scale
    tx = cx - sx - (cx - sx - tx) * ratio
    ty = cy - sy - (cy - sy - ty) * ratio
    scale = newScale
    applyTransform()
  }

  zoomInBtn.onclick = () => zoom(1.2)
  zoomOutBtn.onclick = () => zoom(1 / 1.2)
  resetBtn.onclick = () => { scale = 1; tx = 0; ty = 0; applyTransform() }

  function close(): void {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  closeBtn.onclick = close
  overlay.onclick = (e) => { if (e.target === overlay) close() }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close()
    else if (e.key === '+' || e.key === '=') zoom(1.2)
    else if (e.key === '-') zoom(1 / 1.2)
    else if (e.key === '0') { scale = 1; tx = 0; ty = 0; applyTransform() }
  }
  document.addEventListener('keydown', onKey)

  // 滚轮缩放
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = stage.getBoundingClientRect()
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top)
  }, { passive: false })

  // 拖拽平移
  let dragging = false
  let startX = 0
  let startY = 0
  svg.addEventListener('mousedown', (e) => {
    dragging = true
    startX = e.clientX - tx
    startY = e.clientY - ty
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    tx = e.clientX - startX
    ty = e.clientY - startY
    applyTransform()
  })
  window.addEventListener('mouseup', () => { dragging = false })
}

/** 渲染容器内所有 mermaid 代码块为 SVG。 */
async function renderMermaidInContainer(container: HTMLElement | null, dark: boolean): Promise<void> {
  if (container === null) return
  const blocks = container.querySelectorAll('.md-code-block')
  if (blocks.length === 0) return
  let mermaid: { initialize: (opts: Record<string, unknown>) => void; render: (id: string, code: string) => Promise<{ svg: string }> }
  try {
    mermaid = (await loadMermaid()) as typeof mermaid
  } catch {
    return // 加载失败，保留原始代码块
  }
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: dark ? 'dark' : 'default' })
  for (const block of Array.from(blocks)) {
    // CSS modules 会对类名进行 hash（如 _infostring_178r4_42），
    // 因此用 [class*="infostring"] 匹配包含 infostring 的类名。
    const infostring = block.querySelector('[class*="infostring"]')
    if (infostring === null || infostring.textContent?.trim() !== 'mermaid') continue
    if ((block as HTMLElement).dataset.mermaidRendered === 'true') continue
    const codeEl = block.querySelector('pre code, pre')
    if (codeEl === null) continue
    const code = codeEl.textContent ?? ''
    try {
      const id = `bs-mermaid-${Math.random().toString(36).slice(2, 10)}`
      const { svg } = await mermaid.render(id, code)
      block.innerHTML = svg
      ;(block as HTMLElement).dataset.mermaidRendered = 'true'
      // 点击 SVG 打开放大弹窗
      const svgEl = block.querySelector('svg')
      if (svgEl !== null) {
        svgEl.addEventListener('click', () => openMermaidModal(svgEl as SVGSVGElement))
      }
    } catch (err) {
      console.error('[better-sidebar] mermaid render failed:', err)
    }
  }
}

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
        // Selection popup (the catch-all code viewer only): a non-empty
        // selection anchors the floating "add to conversation" button above
        // its head. Scrolling (geometry/viewport change) or losing focus
        // hides it; typing collapses the selection and hides it too.
        ...(viewerId === 'code' ? [
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

  // Mermaid 渲染：在 markdown 预览模式下，将 ```mermaid 代码块渲染为 SVG 图片。
  // 依赖 content/draft 以在内容变化时重新渲染；依赖 mode 以在切换到预览时触发。
  useEffect(() => {
    if (mode !== 'preview' || viewerId !== 'markdown') return
    const container = mdRef.current
    if (container === null) return
    void renderMermaidInContainer(container, dark)
  }, [mode, viewerId, content, draft, dark])

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
