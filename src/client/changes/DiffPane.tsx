/**
 * The changes tab's shared bottom preview pane: one selected target — a git
 * worktree change, a commit patch, or a session file op — rendered through
 * the unified diff stack (the same one the diff tab uses). Git targets load
 * through the shared {@link useGitDiffTarget} hook (refreshable, with the
 * untracked full-addition fallback); op targets are pure snapshots. The pane
 * is resizable by drag (clamped; the height commits to the tab's persisted
 * meta on release) and by keyboard; git targets can expand into a dedicated
 * diff tab via the shell.
 *
 * The pane's views are TABS, one per question: `content` answers "what is in
 * the file" (every read op, and the rendered view for md/html/pdf ops — the
 * plugin's renderers no longer hide behind a toggle inside the diff view),
 * `diff` answers "what changed" (git targets, write/edit ops), and extra
 * views the caller hosts (the graph commit's `details` card) sit ahead of
 * both. A read op has no `diff` tab — nothing changed. With one or zero tabs
 * the pane is byte-for-byte the strip-less preview of before.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { IconCloseOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular, MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import type { SessionScope } from '../api.ts'
import { api, htmlUrl } from '../api.ts'
import { hostTransportBase } from '../desktop-env.ts'
import { t } from '../locales.ts'
import { baseName } from '../paths.ts'
import { resolveSidebarPath } from '../paths.ts'
import { HTML_IFRAME_SANDBOX } from '../html-preview.ts'
import type { SidebarDiffRef, SidebarTab } from '../state.ts'
import { DiffRows, ReadRows } from '../diff/DiffRows.tsx'
import { PdfView } from '../PdfView.tsx'
import { BinaryDownload } from '../binary-download.tsx'
import { DiffFiles } from '../diff/DiffFiles.tsx'
import { langOfPath } from '../diff/highlight.ts'
import { buildDiffSegments, diffLines, diffStats, parseUnifiedDiff, unifiedSegments, type DiffRow } from '../diff/rows.ts'
import { useGitDiffTarget } from '../diff/use-git-diff.ts'
import { parseReadContent, parseReadLines, type FileOp } from './ops.ts'
import { redactText } from '../redact.ts'
import { rewriteLocalImageUrls } from '../markdown-images.ts'
import { markdownTextProps } from '../markdown-labels.tsx'
import { useMarkdownSurface } from '../use-markdown-surface.ts'
import { splitMermaidBlocks } from '../mermaid-blocks.ts'
import { LazyMermaidMarkdown } from '../mermaid-lazy.tsx'
import { createFrameBatcher } from '../frame-batcher.ts'
import { Chip, IconButton, Notice, StatusBadge } from '../ui/index.ts'
import css from './changes.module.css'
import diffCss from '../diff/diff.module.css'

/** Drag handle height clamp (px) and keyboard-resize step. */
const HEIGHT_MIN = 140
const HEIGHT_STEP = 24

/**
 * Clamp one pane height to the pane's own bounds: never below the content
 * minimum, never above 70% of the window. Both the drag handler and the
 * RESTORE path (a height persisted under a taller window) run through this,
 * so a saved value can never open the pane taller than the viewport allows.
 */
export function clampPaneHeight(value: number): number {
  return Math.min(Math.max(value, HEIGHT_MIN), Math.round(window.innerHeight * 0.7))
}

/** The redaction preference, persisted under the repo's sidebar storage
 *  prefix (see state.ts's `dsh-sidebar:v1`). */
const REDACTION_KEY = 'dsh-sidebar:v1:redaction'

/** What the pane is showing right now. */
export type ChangesPreview =
  | { kind: 'git'; ref: SidebarDiffRef }
  | { kind: 'op'; path: string; op: FileOp; prior?: string }

/** Diff material for one op snapshot: an edit reconstructs the full file
 *  from the window's known prior content when possible (hunk-style context);
 *  a write with unknown prior content renders all-added. */
function diffOf(op: FileOp, prior: string | undefined): readonly DiffRow[] {
  if (op.kind === 'read') return []
  if (op.kind === 'edit' && op.edit !== undefined) {
    const { oldString, newString } = op.edit
    if (prior !== undefined && prior.includes(oldString)) {
      const newFile = prior.replace(oldString, newString)
      return diffLines(prior, newFile)
    }
    return diffLines(oldString, newString)
  }
  if (op.kind === 'write') {
    const content = op.content ?? ''
    const old = prior !== undefined && prior !== content ? prior : undefined
    return diffLines(old ?? '', content)
  }
  return []
}

/** The render view of one html op target: the route-src iframe. Extracted
 *  (and exported) so the always-sandboxed contract is pinned directly by the
 *  sandbox spec — this surface has NO no-sandbox escape hatch. */
export function HtmlRenderPreview(props: { src: string; title: string }) {
  return (
    <div className={css.htmlPane}>
      <iframe
        className={css.htmlFrame}
        title={props.title}
        src={props.src}
        sandbox={HTML_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        allow=""
      />
    </div>
  )
}

/** One header pill toggle — the redaction / reading / render toggles share the
 *  shape: the global {@link Chip} (its active state is the "on" picture). */
function PaneToggle(props: { on: boolean; label: string; title?: string; onClick: () => void }) {
  return <Chip active={props.on} title={props.title} onClick={props.onClick}>{props.label}</Chip>
}

/** One tab of the pane's optional strip. */
export interface PaneTab {
  readonly id: string
  readonly label: string
}

/**
 * A compact tab strip — a real tablist with roving focus: the active tab is
 * the only tab stop, and Left/Right/Home/End move focus AND selection (the
 * standard automatic-activation model). Born as the bottom pane's strip
 * (details / diff); the changes tab's header reuses it for the lens switcher
 * so the page's two switchers read as one component. Rendered only when the
 * caller hosts more than one view, so a diff-only preview never grows a strip.
 */
export function PaneTabStrip(props: { tabs: readonly PaneTab[]; active: string; onSelect(id: string): void; className?: string; label?: string }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const move = (to: number): void => {
    const count = props.tabs.length
    if (count === 0) return
    const index = ((to % count) + count) % count
    props.onSelect(props.tabs[index]!.id)
    buttons.current[index]?.focus()
  }
  return (
    <div className={props.className === undefined ? css.paneTabs : `${css.paneTabs} ${props.className}`}
      role="tablist" aria-label={props.label}>
      {props.tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => { buttons.current[index] = node }}
          type="button"
          role="tab"
          className={css.paneTab}
          data-active={tab.id === props.active ? 'true' : undefined}
          aria-selected={tab.id === props.active}
          tabIndex={tab.id === props.active ? 0 : -1}
          onClick={() => { props.onSelect(tab.id) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') { event.preventDefault(); move(index + 1) }
            else if (event.key === 'ArrowLeft') { event.preventDefault(); move(index - 1) }
            else if (event.key === 'Home') { event.preventDefault(); move(0) }
            else if (event.key === 'End') { event.preventDefault(); move(props.tabs.length - 1) }
          }}
        >{tab.label}</button>
      ))}
    </div>
  )
}

/** The reading-mode body of one markdown op target: the shared MarkdownText
 *  pass (local image destinations already rewritten to the media route by
 *  the caller). Mermaid fences render through the same chunk-resident
 *  renderer the editor preview uses (one MarkdownText pass with the fences
 *  lifted out); the plain path stays byte-for-byte for documents without
 *  any.
 *
 *  The body is also a markdown SURFACE: heading slugs, anchor jumps and `.md`
 *  link claiming, with relative targets resolved against the previewed file's
 *  own directory (see use-markdown-surface). */
function MdReadingView(props: { text: string; ctx: Context; scope: SessionScope; path: string }) {
  const codeLabels = {
    copyLabel: t('copy'),
    copiedLabel: t('copied'),
    codeLabel: t('codeBlockTitle'),
    wrapLabel: t('codeBlockWrap'),
    unwrapLabel: t('codeBlockUnwrap'),
  }
  const surface = useMarkdownSurface({
    ctx: props.ctx,
    sessionId: props.scope.sessionId,
    cwd: props.scope.cwd,
    path: props.path,
  })
  // The caller already rewrote local IMAGE destinations; this pass is the link
  // half (and is idempotent, so the two can be composed in either order).
  const text = surface.rewrite(props.text)
  const hasMermaid = splitMermaidBlocks(text).some((block) => block.kind === 'mermaid')
  return (
    <div className={css.paneBody} ref={surface.surfaceRef}>
      <div className={css.mdBody}>
        <MarkdownDelegateProvider openFile={surface.openFile}>
          {hasMermaid
            ? <LazyMermaidMarkdown text={text} codeLabels={codeLabels} />
            : <MarkdownText {...markdownTextProps(text, codeLabels)} />}
        </MarkdownDelegateProvider>
      </div>
    </div>
  )
}

/** The diff tab a git preview expands into (the shell owns placement). */
export function diffTabOf(ref: SidebarDiffRef): SidebarTab {
  if (ref.kind === 'worktree') {
    return {
      id: `diff:w:${encodeURIComponent(ref.worktree ?? '')}:${ref.staged ? 's' : 'u'}:${ref.path}`,
      type: 'diff',
      title: baseName(ref.path),
      diff: ref,
    }
  }
  return {
    id: `diff:c:${encodeURIComponent(ref.worktree ?? '')}:${ref.hashFull}`,
    type: 'diff',
    title: `${ref.hash} ${ref.subject}`,
    diff: ref,
  }
}

export interface DiffPaneProps {
  target: ChangesPreview
  ctx: Context
  scope: SessionScope
  /** The persisted pane height (px); drag commits a new one upwards. */
  height: number
  onHeightCommit: (height: number) => void
  onClose: () => void
  /** Expand the current git target into a dedicated diff tab. */
  onExpand: () => void
  /** The pane's views. The host may PIN the set (the changes tab pins
   *  details/content/diff so the panel is identical in every lens; a pinned
   *  id with nothing to show renders its empty state instead of vanishing).
   *  Omitted, the set is composed from what this target actually offers. */
  tabs?: readonly PaneTab[]
  /** Bodies for ids the pane does not build itself (the caller's views). */
  bodies?: Readonly<Record<string, ReactNode>>
  /** The active tab id; an id not listed lands on the built-in home. */
  activeTab?: string
  onSelectTab?(id: string): void
}

/** One tab's "nothing here" body — a page-level empty notice. */
function PaneEmpty({ text }: { text: string }) {
  return <div className={css.paneBody}><Notice kind="empty" tone="page">{text}</Notice></div>
}

export function DiffPane({ target, ctx, scope, height, onHeightCommit, onClose, onExpand, tabs, bodies, activeTab, onSelectTab }: DiffPaneProps) {
  // ── Git target loading (the shared loader: staged-side fallback, the
  //    untracked full-addition fallback, refresh by tick, fold cache). ─────
  const gitRef = target.kind === 'git' ? target.ref : null
  /** The git target when it is a WORKTREE file (the only git target with a
   *  content view, and the only one carrying a `path`). */
  const gitWorktree = gitRef !== null && gitRef.kind === 'worktree' ? gitRef : null
  const { loading, error, diffText, untracked, refresh, resolveFold } = useGitDiffTarget(gitRef, scope)

  // ── The pane's views, resolved BEFORE anything loads: which tabs exist and
  //    which one is on screen. Computed from raw target facts (`kind` and
  //    `isError` do not change under redaction), so the loaders below can
  //    defer their work for views that are not on screen. ──────────────────
  /** The path the content view is about: a worktree file's, or an op's. */
  const targetPath = gitWorktree !== null ? gitWorktree.path : target.kind === 'op' ? target.path : ''
  /** A target whose content view may RENDER: a non-error op, or a worktree
   *  file (the plugin's renderers are the reason the content tab exists). */
  const renderable = (target.kind === 'op' && !target.op.isError) || gitWorktree !== null
  const mdOp = renderable && /\.(md|markdown|mdx)$/i.test(targetPath)
  const htmlOp = renderable && /\.(html?)$/i.test(targetPath)
  const pdfOp = renderable && /\.pdf$/i.test(targetPath)
  /** Source vs rendered inside the CONTENT tab. Markdown starts rendered (the
   *  sanitized MarkdownText is the point of the tab); html starts on SOURCE —
   *  selecting a row must never auto-load an iframe without an explicit click
   *  (the sandbox spec pins this). */
  const [contentRaw, setContentRaw] = useState(htmlOp)
  const opKind = target.kind === 'op' ? target.op.kind : null
  const opError = target.kind === 'op' && target.op.isError
  /** What this target can offer: every read op has a content view, md/html/pdf
   *  ops have one whatever they did, and a git WORKTREE file has one too (the
   *  file itself, next to its patch). */
  const hasContentTab = target.kind === 'git'
    ? target.ref.kind === 'worktree'
    : opKind !== null && !opError && (opKind === 'read' || mdOp || htmlOp || pdfOp)
  const hasDiffTab = target.kind === 'git' || (opKind !== null && (opKind !== 'read' || opError))
  /** The host may PIN the tab set (the changes tab pins details/content/diff
   *  so the panel is identical in every lens); otherwise the set is composed
   *  from what this target offers. An unlisted / absent active id lands on the
   *  built-in home (`diff`, else `content`, else the first pinned view). */
  const allTabs: PaneTab[] = tabs !== undefined
    ? [...tabs]
    : [
      ...(hasContentTab ? [{ id: 'content', label: t('changesContentTab') }] : []),
      ...(hasDiffTab ? [{ id: 'diff', label: t('changesDiffTab') }] : []),
    ]
  const hasStrip = allTabs.length > 1
  const active = activeTab !== undefined && allTabs.some(tab => tab.id === activeTab)
    ? activeTab
    : hasDiffTab ? 'diff' : hasContentTab ? 'content' : allTabs[0]?.id ?? 'diff'
  const activeExtra = active !== 'diff' && active !== 'content'

  // ── The `content` tab of a GIT target: the worktree file itself (the diff
  //    tab answers "what changed"; this one answers "what is in it"). Loaded
  //    lazily — only while the content view is actually on screen — through
  //    the same `fs.read` the editor uses, with the same path resolution the
  //    diff loader applies to a worktree file. ──────────────────────────────
  const [gitContent, setGitContent] = useState<
    { status: 'idle' | 'loading' | 'binary' | 'large' } | { status: 'text'; text: string } | { status: 'error'; error: string }
  >({ status: 'idle' })
  useEffect(() => {
    if (gitWorktree === null) { setGitContent({ status: 'idle' }); return }
    // Deferred until the content view is the one on screen: opening a file to
    // read its DIFF must not pull the whole document.
    if (active !== 'content') return
    const controller = new AbortController()
    setGitContent({ status: 'loading' })
    api.fsRead(scope, resolveSidebarPath(gitWorktree.repoRoot ?? gitWorktree.worktree ?? scope.cwd, gitWorktree.path), controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.kind === 'text') setGitContent({ status: 'text', text: result.content })
        else if (result.kind === 'binary') setGitContent({ status: 'binary' })
        else setGitContent({ status: 'large' })
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setGitContent({ status: 'error', error: reason instanceof Error ? reason.message : String(reason) })
      })
    return () => { controller.abort() }
  }, [gitWorktree, scope, active])

  // ── Op target material (pure snapshots; the prior content came with the
  //    target so a running op shows what is already known). ────────────────
  const opRaw = target.kind === 'op' ? target.op : null
  const priorRaw = target.kind === 'op' ? target.prior : undefined
  // Secret redaction: on by default, toggle persists per browser (localStorage).
  // Every op payload consumer below (diff rows, read rows, markdown source,
  // error text) renders from the REDACTED shape, so masked payloads are the
  // only thing that can reach the DOM while the toggle is on. Display-only:
  // session events and the fs layer keep their original bytes.
  const [redactionOn, setRedactionOn] = useState((): boolean => {
    try { return localStorage.getItem(REDACTION_KEY) !== '0' } catch { return true }
  })
  const toggleRedaction = (): void => {
    setRedactionOn((prev) => {
      const next = !prev
      try { localStorage.setItem(REDACTION_KEY, next ? '1' : '0') } catch { /* storage unavailable */ }
      return next
    })
  }
  const { op, prior, redactionHit } = useMemo(() => {
    if (opRaw === null || !redactionOn) return { op: opRaw, prior: priorRaw, redactionHit: false }
    const path = target.kind === 'op' ? target.path : ''
    // One redactText pass per field: the outcome carries both the masked
    // text and whether anything was hit.
    const mask = (text: string | undefined): { masked: string | undefined; hit: boolean } => {
      if (text === undefined) return { masked: undefined, hit: false }
      const outcome = redactText(path, text)
      return { masked: outcome.text, hit: outcome.hit }
    }
    const read = mask(opRaw.read)
    const content = mask(opRaw.content)
    const editOld = mask(opRaw.edit?.oldString)
    const editNew = mask(opRaw.edit?.newString)
    const errorText = mask(opRaw.errorText)
    const priorMasked = mask(priorRaw)
    const hit = read.hit || content.hit || editOld.hit || editNew.hit || errorText.hit || priorMasked.hit
    if (!hit) return { op: opRaw, prior: priorRaw, redactionHit: false }
    const redacted: FileOp = {
      ...opRaw,
      ...(read.masked !== undefined ? { read: read.masked } : {}),
      ...(content.masked !== undefined ? { content: content.masked } : {}),
      ...(opRaw.edit !== undefined
        ? { edit: { oldString: editOld.masked ?? opRaw.edit.oldString, newString: editNew.masked ?? opRaw.edit.newString } }
        : {}),
      ...(errorText.masked !== undefined ? { errorText: errorText.masked } : {}),
    }
    return { op: redacted, prior: priorMasked.masked, redactionHit: true }
  }, [opRaw, priorRaw, target, redactionOn])
  const opLang = useMemo(() => (target.kind === 'op' ? langOfPath(target.path) : undefined), [target])
  const opRows = useMemo(() => (op === null ? [] : diffOf(op, prior)), [op, prior])
  const opSegments = useMemo(() => buildDiffSegments(opRows), [opRows])
  const opStats = useMemo(() => diffStats(opSegments), [opSegments])
  const opReadLines = useMemo(
    () => (op?.kind === 'read' && op.read !== undefined ? parseReadLines(op.read) : []),
    [op],
  )

  // ── Content tab material: the file's full text, its source lines and the
  //    rendered variants (the tab set itself was resolved at the top). ──────
  /** The textual source behind the content view — the op's snapshot for op
   *  targets, the file on disk for a git worktree file. */
  const contentSrc = useMemo(() => {
    if (gitWorktree !== null) return gitContent.status === 'text' ? gitContent.text : ''
    if (target.kind !== 'op' || op === null) return ''
    if (op.kind === 'read') return parseReadContent(op.read ?? '')
    if (op.kind === 'write') return op.content ?? ''
    if (op.kind === 'edit' && op.edit !== undefined) {
      if (prior !== undefined && prior.includes(op.edit.oldString)) {
        return prior.replace(op.edit.oldString, op.edit.newString)
      }
      return op.edit.newString
    }
    return ''
  }, [gitWorktree, target.kind, op, prior, gitContent])
  /** The display path (for the language highlighter) and the resolved path the
   *  media/html routes need — a child-repo path is relative to its repo root,
   *  exactly as the diff loader resolves it. */
  const contentPath = targetPath
  const contentAbs = useMemo(
    () => (gitWorktree !== null
      ? resolveSidebarPath(gitWorktree.repoRoot ?? gitWorktree.worktree ?? scope.cwd, gitWorktree.path)
      : resolveSidebarPath(scope.cwd, contentPath)),
    [gitWorktree, scope, contentPath],
  )
  /** Source lines: a read keeps its ORIGINAL numbering (`opReadLines`), a
   *  whole-file source is renumbered from 1. */
  const contentLines = useMemo(
    () => (contentSrc === '' ? [] : contentSrc.split('\n').map((text, index) => ({ line: index + 1, text }))),
    [contentSrc],
  )
  const contentText = useMemo(
    () => (mdOp && !contentRaw && contentSrc !== ''
      ? rewriteLocalImageUrls(contentSrc, scope, contentPath, hostTransportBase())
      : ''),
    [mdOp, contentRaw, contentSrc, scope, contentPath],
  )
  const htmlRenderSrc = useMemo(
    () => (htmlOp && contentAbs !== '' ? htmlUrl(scope, contentAbs) : ''),
    [htmlOp, scope, contentAbs],
  )

  // Header stats for git targets come off the parsed patch text.
  const gitStats = useMemo(() => {
    if (target.kind !== 'git' || diffText === null || diffText === '') return null
    let added = 0
    let deleted = 0
    for (const file of parseUnifiedDiff(diffText).files) {
      const stats = diffStats(unifiedSegments(file))
      added += stats.added
      deleted += stats.deleted
    }
    return { added, deleted }
  }, [target, diffText])

  // ── Resize: drag the top handle; commit on release (persisted by the
  //    shell). Arrow keys resize by a step for keyboard users. ────────────
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const paneHeight = dragHeight ?? height
  const clamp = clampPaneHeight
  const dragOrigin = useRef<{ y: number; h: number } | null>(null)
  // Pointer streams fire several times per frame; one setState per event
  // re-rendered the whole pane at event cadence (see frame-batcher).
  const dragBatcher = useRef(createFrameBatcher()).current
  useEffect(() => () => dragBatcher.dispose(), [dragBatcher])
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragOrigin.current = { y: event.clientY, h: paneHeight }
    const onMove = (ev: PointerEvent): void => {
      if (dragOrigin.current === null) return
      const next = clamp(dragOrigin.current.h + (dragOrigin.current.y - ev.clientY))
      dragBatcher.schedule(() => { setDragHeight(next) })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragOrigin.current = null
      dragBatcher.flushNow()
      setDragHeight(current => {
        if (current !== null) onHeightCommit(current)
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const title = target.kind === 'op'
    ? target.path
    : target.ref.kind === 'worktree' ? target.ref.path : `${target.ref.hash} ${target.ref.subject}`
  const stats = gitStats ?? (target.kind === 'op' && op !== null && op.kind !== 'read' && !op.isError ? opStats : null)

  const handle = (
    <div
      className={css.dragHandle}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('changesResizePreview')}
      tabIndex={0}
      onPointerDown={onHandleDown}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); onHeightCommit(clamp(paneHeight + HEIGHT_STEP)) }
        if (event.key === 'ArrowDown') { event.preventDefault(); onHeightCommit(clamp(paneHeight - HEIGHT_STEP)) }
      }}
    />
  )
  const strip = hasStrip ? <PaneTabStrip tabs={allTabs} active={active} onSelect={onSelectTab ?? (() => {})} /> : null

  // A caller-hosted view (the graph commit's card) takes over the head AND
  // the body: same frame, same handle, same height behaviour — only the
  // content inside the frame changes. Nothing available → its empty state.
  if (activeExtra) {
    return (
      <div className={css.diffPane} style={{ height: paneHeight }}>
        {handle}
        {strip}
        <div className={css.altBody}>{bodies?.[active] ?? <PaneEmpty text={t('changesNoContent')} />}</div>
      </div>
    )
  }

  /** Which rendering the content view uses. Resolved up front so this stays a
   *  single switch (an aliased-condition narrowing would turn `target` into
   *  `never` in the remaining branch). */
  const contentView: 'pdf' | 'html' | 'md' | 'source' =
    pdfOp && contentAbs !== '' ? 'pdf'
      : htmlOp && !contentRaw && htmlRenderSrc !== '' ? 'html'
        : mdOp && !contentRaw && contentText !== '' ? 'md'
          : 'source'
  /** The `content` tab's body: the plugin's rendered view for md/html/pdf
   *  (with the source toggle for md/html), line-numbered source otherwise, and
   *  the worktree file itself for a git target — the diff tab keeps the patch. */
  const contentBody = (
    contentView === 'pdf'
      ? (
        <div className={css.htmlPane}>
          <PdfView scope={scope} path={contentAbs} title={title} />
        </div>
      )
      : contentView === 'html'
        ? <HtmlRenderPreview src={htmlRenderSrc} title={title} />
        : contentView === 'md'
          ? <MdReadingView text={contentText} ctx={ctx} scope={scope} path={contentPath} />
          : gitWorktree !== null
            ? (gitContent.status === 'loading' || gitContent.status === 'idle'
              ? <div className={css.paneBody}><Notice kind="loading" tone="page">{t('loading')}</Notice></div>
              : gitContent.status === 'error'
                ? <div className={css.paneBody}><Notice kind="error">{t('diffLoadError')}: {gitContent.error}</Notice></div>
                : gitContent.status === 'binary' || gitContent.status === 'large'
                  ? <div className={css.paneBody}><BinaryDownload scope={scope} path={contentAbs} /></div>
                  : (
                    <div className={css.paneBody}>
                      <ReadRows lines={contentLines} lang={langOfPath(gitWorktree.path)} />
                    </div>
                  ))
            : (
              <div className={css.paneBody}>
                <ReadRows lines={opKind === 'read' ? opReadLines : contentLines} lang={opLang} />
              </div>
            )
  )

  return (
    <div className={css.diffPane} style={{ height: paneHeight }}>
      {handle}
      {strip}
      <div className={css.diffHead}>
        {target.kind === 'op' && (
          <StatusBadge tone={target.op.kind}>
            {t(target.op.kind === 'read' ? 'changesRead' : target.op.kind === 'write' ? 'changesWrite' : 'changesEdit')}
          </StatusBadge>
        )}
        {target.kind === 'git' && target.ref.kind === 'worktree' && (
          <StatusBadge tone="neutral">{target.ref.staged ? t('staged') : t('unstaged')}</StatusBadge>
        )}
        {target.kind === 'git' && target.ref.kind === 'commit' && (
          <StatusBadge tone="neutral">{target.ref.hash}</StatusBadge>
        )}
        <span className={css.diffPath} title={title}>{title}</span>
        {active === 'diff' && stats !== null && (stats.added > 0 || stats.deleted > 0) && (
          <span className={css.diffStats}>
            {stats.added > 0 && <span className={diffCss.statAdd}>+{String(stats.added)}</span>}
            {stats.deleted > 0 && <span className={diffCss.statDel}>−{String(stats.deleted)}</span>}
          </span>
        )}
        {target.kind === 'git' && (
          <>
            <IconButton
              size="sm"
              icon={<IconRefreshOutlineRegular size={14} />}
              label={t('refresh')}
              disabled={loading}
              onClick={refresh}
            />
            <IconButton
              size="sm"
              icon={<IconRightUpOutlineRegular size={14} />}
              label={t('changesOpenDiffTab')}
              onClick={onExpand}
            />
          </>
        )}
        {redactionHit && (
          <span className={css.redactBanner} role="status">{t('changesRedactBanner')}</span>
        )}
        {target.kind === 'op' && (
          <PaneToggle
            on={redactionOn}
            label={redactionOn ? t('changesRedactOnLabel') : t('changesRedactOffLabel')}
            title={redactionOn ? t('changesRedactOff') : t('changesRedactOn')}
            onClick={toggleRedaction}
          />
        )}
        {/* The rendered/source toggle belongs to the CONTENT tab alone. */}
        {active === 'content' && mdOp && (
          <PaneToggle
            on={!contentRaw}
            label={t(contentRaw ? 'changesMdReading' : 'changesMdRaw')}
            onClick={() => { setContentRaw(value => !value) }}
          />
        )}
        {active === 'content' && htmlOp && (
          <PaneToggle
            on={!contentRaw}
            label={t(contentRaw ? 'changesHtmlRender' : 'changesHtmlRaw')}
            onClick={() => { setContentRaw(value => !value) }}
          />
        )}
        <IconButton
          size="sm"
          icon={<IconCloseOutlineRegular size={14} />}
          label={t('changesClosePreview')}
          onClick={onClose}
        />
      </div>
      {active === 'content'
        ? (hasContentTab ? contentBody : <PaneEmpty text={t('changesNoContent')} />)
        : active === 'diff'
        ? (opError
          ? (
            <div className={css.paneBody}>
              <Notice kind="error" className={css.readError}>
                {op?.errorText ?? t('changesError')}
              </Notice>
            </div>
          )
          : opKind === 'read'
            // A read changed nothing: the diff view says so plainly instead of
            // rendering an empty patch.
            ? <PaneEmpty text={t('changesReadNoDiff')} />
            : target.kind === 'op'
              ? (
                <div className={css.paneBody}>
                  {op !== null && op.kind === 'write'
                    && prior === undefined
                    && <Notice kind="hint" tone="inline">{t('changesPriorUnknown')}</Notice>}
                  <DiffRows key={target.op.callId} segments={opSegments} lang={opLang} />
                </div>
              )
              : loading
                ? <div className={css.paneBody}><Notice kind="loading" tone="page">{t('loading')}</Notice></div>
                : error !== null
                  ? (
                    <div className={css.paneBody}>
                      <Notice kind="error">{t('diffLoadError')}: {error}</Notice>
                    </div>
                  )
                  : (
                    <div className={css.paneBody}>
                      {/* The untracked fallback has NO diff text (git diff never
                          lists the file): its content is the whole render. */}
                      {((diffText !== null && diffText !== '') || untracked !== undefined) && (
                        <DiffFiles
                          diff={diffText ?? ''}
                          resolveFold={resolveFold}
                          untrackedPath={untracked !== undefined && target.ref.kind === 'worktree' ? target.ref.path : undefined}
                          untrackedContent={untracked}
                        />
                      )}
                      {diffText === '' && untracked === undefined && (
                        <Notice kind="empty" tone="page">{t('diffEmpty')}</Notice>
                      )}
                    </div>
                  ))
        : (bodies?.[active] ?? <PaneEmpty text={t('changesNoContent')} />)}
    </div>
  )
}
