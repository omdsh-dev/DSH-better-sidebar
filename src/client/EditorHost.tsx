/**
 * The editor tab host: the single FILES WINDOW. It resolves a file's
 * previewer through the sidebar registry (`matchFileViewer`), fetches bytes
 * per the matched viewer's fetch strategy, and renders its component — or
 * the shared download pane when nothing can render the file. A tab without
 * a path (the seeded "Files" home) renders an empty-state hint instead of
 * the viewer loading flow; that path-less window IS the file explorer.
 *
 * The chrome depends on the `editorExplorer` mode (read reactively so
 * toggling it re-renders without a reload):
 * - merged (in-place): tree click / path-input Enter switch the CURRENT
 *   tab in place (updateTab rewrites path/title; the tab keeps its id and
 *   meta, so treeOpen/treeWidth survive the switch);
 * - split: they open through `openSidebarFile` (a per-path dedupe tab),
 *   and a PATH-LESS window is the standalone explorer — it renders ONLY
 *   the tree panel (search + FileTree, full-window), no editor chrome.
 *   Editor tabs (with a path) keep the full chrome in both modes.
 * The tree's context menu offers the explicit escapes in both modes: open
 * in a new tab (per-path dedupe) or to the side (a fresh tab in a fresh
 * rightward split of the current pane).
 *
 * The strategy dispatch is pure (planFirstMatch / planFsReadOutcome in
 * editor-load.ts); this component only wires it to the host APIs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createElement } from 'react'
import clsx from 'clsx'
import { IconCheckOutlineRegular, IconFolderOpenRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, mediaUrl, type SessionScope } from './api.ts'
import { BinaryDownload } from './binary-download.tsx'
import { planFirstMatch, planFsReadOutcome, type EditorLoadAction } from './editor-load.ts'
import { clearEditorDirty, setEditorDirty } from './editor-dirty.ts'
import { baseName } from './FileTree.tsx'
import { createFrameBatcher } from './frame-batcher.ts'
import { openClaimedNativeFile, openSidebarFile } from './sidebar-file.ts'
import { openWithSshActive, openWithUrl, parseOpenWithConfig, resolveOpenWithTargets } from './open-with.ts'
import { fileOpKey, useFileOpStream } from './ops-stream.ts'
import { updatePluginSettings } from './plugin-settings.ts'
import { createOpenInApp } from './open-in-app.ts'
import { TreePanel } from './TreePanel.tsx'
import { t } from './locales.ts'
import { relativeTo } from './paths.ts'
import { resolveSidebarPath } from './paths.ts'
import { clearRetargetedPath, closePathTabs, consumeRetargetedPath, pathTabKey, retargetPathTabs } from './tree-mutations.ts'
import type { EditorToolbarControls, EditorToolbarState, FileViewerDescriptor } from './service.ts'
import { firstLeaf, insertLeafAt, leafWithTab, mintTabId, type SidebarStore, type SidebarTab } from './state.ts'
import css from './sidebar.module.css'

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mtimeMs?: number; mediaUrl?: string; customData?: unknown }
  | { status: 'binary' }

/** The docked tree panel's width bounds (drag-resize clamps into them). */
const TREE_WIDTH_DEFAULT = 240
const TREE_WIDTH_MIN = 160
const TREE_WIDTH_MAX = 480

/** Stable empty blob for the editor pluginSettings read (a fresh `?? {}`
 *  would change identity every snapshot and loop useSyncExternalStore). */
const EMPTY_PLUGIN_BLOB: Record<string, unknown> = {}

/** The tab's persisted meta object (a malformed meta reads as empty). */
function metaOf(tab: SidebarTab): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** Read the persisted tree-panel flag of one editor tab: an explicit
 *  boolean meta wins; otherwise path-less tabs (the seeded home) default
 *  open and file tabs default closed. */
function treeOpenOf(tab: SidebarTab): boolean {
  const treeOpen = metaOf(tab).treeOpen
  return typeof treeOpen === 'boolean' ? treeOpen : (tab.path === undefined || tab.path === '')
}

/** Read the persisted tree-panel width (clamped; default 240). */
function treeWidthOf(tab: SidebarTab): number {
  const width = metaOf(tab).treeWidth
  return typeof width === 'number' && Number.isFinite(width)
    ? Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(width)))
    : TREE_WIDTH_DEFAULT
}

/**
 * Merge a patch into the tab's persisted meta (rides the layout).
 *
 * `sessionId` is the seat session: native ids restart per session and every
 * visited tab's body stays mounted (0.1.7 `keepMounted`), so the tab this call
 * means must be named, not inferred from whichever seat is on screen.
 */
function patchMeta(ctx: Context, tab: SidebarTab, sessionId: string, patch: Record<string, unknown>): void {
  ctx.get('betterSidebar')?.updateTab(tab.id, { meta: { ...metaOf(tab), ...patch } }, sessionId)
}

/** Clamp one dock width into the contract range. */
function clampTreeWidth(value: number): number {
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(value)))
}

/** Whether one external-open call was accepted: a rejected launch is logged
 *  for diagnosis and answered `false`, so the caller can surface it. */
function accepted(pending: Promise<unknown>): Promise<boolean> {
  return pending.then(
    () => true,
    (error: unknown) => {
      console.error('open external failed', error)
      return false
    },
  )
}

export function EditorHost(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  /** Whether this tab is the active one with its panel open: a parked tab
   *  must not keep polling (the workbench keeps every tab body mounted). */
  visible?: boolean
  expanded: string[]
  revealed: string[]
  onToggleDir: (path: string) => void
  onReferenceFile: (path: string, isDir: boolean) => void
}) {
  const { ctx, store, scope, tab, expanded, revealed, onToggleDir, onReferenceFile } = props
  const visible = props.visible !== false
  const path = tab.path ?? ''
  const title = tab.title
  // A folder window: the model's `sidebar_open` (or any caller) opens a
  // directory as an editor tab carrying `meta.dir: true` with the directory
  // as its path. It renders the file tree rooted at that folder instead of
  // the viewer loading flow (a directory is not a file).
  const isDir = metaOf(tab).dir === true
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  // Manual refresh (issue #167): bumping the sequence re-runs the load effect
  // with the same path/scope — the only reload entry besides open/close.
  const [reloadSeq, setReloadSeq] = useState(0)

  // Manual refresh (issue #167 + PR #228): a dirty draft is dropped by the
  // reload (the editor instance remounts), so confirm before discarding it.
  const refreshFile = (): void => {
    if (toolbar?.dirty === true) {
      const confirmed = typeof window.confirm === 'function'
        ? window.confirm(t('refreshUnsavedConfirm'))
        : false
      if (!confirmed) return
    }
    setReloadSeq(sequence => sequence + 1)
  }

  // Reactive prefs read: flipping editorExplorer re-renders this tab with no
  // reload. The snapshot is the bare boolean so unrelated store churn never
  // re-renders the editor.
  const inPlace = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().prefs.editorExplorer, [store]),
  )
  // The exclude-pattern list (VS Code files.exclude style): the HOST filters
  // the listing with it, so a changed list reloads the tree (FileTree wipes
  // its level cache when the list's VALUE changes). The snapshot array
  // identity is stable until prefs are rewritten, so useSyncExternalStore
  // stays quiet.
  const exclude = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().prefs.explorerExclude, [store]),
  )
  // The DSH-native "open with" capability (host open-in-app): one adapter per
  // window, shared by every row menu below. The plugin no longer owns a
  // target list, a URL vocabulary or a spawn route — the host reports which
  // applications are actually installed for THIS path.
  const openInApp = useMemo(() => createOpenInApp(ctx), [ctx])
  // The plugin's own service (native-tab opens, "open to the side"): absent in
  // stripped-down hosts, where every flow degrades to the bottom workbench.
  const service = ctx.get('betterSidebar')
  // The file tree's "open with" configuration (pluginSettings['editor']): a
  // blob subscription, so a pin click or a settings-page edit re-renders the
  // menu immediately. The parsed config also drives which targets are shown
  // (SSH mode hides the host-local ones).
  const editorBlob = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().prefs.pluginSettings['editor'] ?? EMPTY_PLUGIN_BLOB, [store]),
  )
  const openWithConfig = useMemo(() => parseOpenWithConfig(editorBlob.openWith), [editorBlob])
  const openWithTargets = useMemo(() => resolveOpenWithTargets(openWithConfig), [openWithConfig])
  // The declarative "always show the plugin's own targets" switch (the editor
  // card's pluginToggles row): a plain boolean on the SAME blob, so both the
  // settings page and the tree's menu see one value. Absent/false keeps the
  // host-first behavior (the tree decides what to hide).
  const openWithShowPluginTargets = editorBlob.openWithPluginTargets === true
  // A path-less tab shows the empty-state hint in merged mode — and in split
  // mode it is the standalone explorer (tree-only, see the render below). A
  // folder tab is a folder window in BOTH modes: the tree rooted at the
  // folder, no editor chrome.
  const showEmpty = path === ''
  const treeOnly = showEmpty && !inPlace
  const folderRoot = isDir ? path : undefined

  /**
   * Open a file from THIS window (tree click / search row / path input):
   * merged mode switches this tab in place (stable id, meta survives);
   * split mode opens a per-path dedupe tab through openSidebarFile.
   *
   * A file another native tab type claims (a `.drawio` canvas, say) diverts
   * to THAT type's tab in BOTH modes (#695) — an in-place switch would
   * swallow it into this plugin's editor, and the claiming type could never
   * render from the tree. Both helpers fall back verbatim for every other
   * file, so the editor keeps exactly its previous behavior.
   */
  const openFile = (absolute: string): void => {
    if (inPlace) {
      if (!openClaimedNativeFile(ctx, scope.sessionId, scope.cwd, absolute)) {
        ctx.get('betterSidebar')?.updateTab(tab.id, { path: absolute, title: baseName(absolute) }, scope.sessionId)
      }
    } else {
      openSidebarFile(ctx, scope.sessionId, absolute)
    }
  }

  /** The context menu's explicit "new tab" escape (per-path dedupe). */
  const openFileNewTab = (absolute: string): void => {
    openSidebarFile(ctx, scope.sessionId, absolute)
  }

  /**
   * The context menu's "open to the side": a fresh editor tab (uid id — the
   * `'editor:' + path` convention would clash with the id safety net on a
   * second side-open of the same file) in a rightward split of THIS pane.
   *
   * Native right-Sidebar tabs do NOT live in `bottomSplits`, so the bottom
   * branch would fall through to `firstLeaf` — a pane the user has not
   * expanded, i.e. "nothing happened". Those tabs instead ask the host for a
   * second pane through the service (`target: 'side'` → the host's
   * `preferNewPane`), which is the same gesture in the surface the user is
   * actually looking at.
   */
  const openFileSide = (absolute: string): void => {
    // `store.tabOpen` answers from THIS session's own state map — the bottom
    // workbench's splits. A natively-hosted tab (right Sidebar) is absent
    // from them even while it is on screen.
    if (service !== undefined && !store.tabOpen(scope.sessionId, tab.id)) {
      // The seed names the editor type, but the native branch of openTab
      // turns an editor PATH seed into a resource address and lets the HOST's
      // tab registry decide the claiming type (#695) — a third-party type
      // with a more specific pattern receives this side gesture too.
      service.openTab({ type: 'editor', path: absolute, target: 'side' }, scope)
      return
    }
    store.reduce((state) => {
      const pane = leafWithTab(state.bottomSplits, tab.id) ?? firstLeaf(state.bottomSplits)
      const fresh: SidebarTab = {
        id: mintTabId(),
        type: 'editor',
        title: baseName(absolute),
        path: absolute,
        meta: { treeOpen: false },
      }
      const { node, leafId } = insertLeafAt(state.bottomSplits, pane.id, 'row', fresh, false)
      return { ...state, bottomSplits: node, activePane: leafId }
    })
  }

  /** The context menu's "open with" action: reveal the path in the OS file
   *  manager, or hand the target's URL to its opener — local `file` URLs go
   *  to the host's external opener, while the SSH-remote form for
   *  VSCode-family editors launches on the browser/client machine (see
   *  api.openExternal).
   *
   *  Answers whether the hand-off was accepted. The host route now reports a
   *  real failure when EVERY opener candidate fails (see
   *  `src/open-external.ts`) instead of the old silent `{ started: true }`, so
   *  a refusal is returned to the tree, which renders it — the log stays for
   *  diagnosis. A missing handler on the other machine is still the OS's or
   *  browser's own dialog. */
  const openWith = (targetId: string, absolute: string): Promise<boolean> => {
    const target = openWithTargets.find(item => item.id === targetId)
    if (target === undefined) return Promise.resolve(false)
    if (target.kind === 'reveal') {
      return accepted(api.openExternal({ action: 'reveal', path: absolute }))
    }
    const url = openWithUrl(target, absolute, openWithConfig)
    if (url === undefined) return Promise.resolve(false)
    return accepted(api.openExternal({ action: 'url', url }))
  }

  /** Toggle one target's pinned state. The write is serialized (see
   *  plugin-settings.ts) and the menu re-renders when the store prefs land. */
  const toggleOpenWithPin = (targetId: string): void => {
    updatePluginSettings(store, 'editor', (blob) => {
      const config = parseOpenWithConfig(blob.openWith)
      const pinned = config.pinned.includes(targetId)
        ? config.pinned.filter(id => id !== targetId)
        : [...config.pinned, targetId]
      return { ...blob, openWith: { ...config, pinned } }
    })
  }

  // Tree mutations reconcile the OPEN tabs (both split trees, the bottom
  // panel, free windows): a rename retargets its tab to the new path; a
  // delete closes tabs at or under the removed path. See tree-mutations.ts.
  const onPathRenamed = (oldPath: string, newPath: string): void => {
    retargetPathTabs(ctx, store, oldPath, newPath)
  }
  const onPathDeleted = (path: string): void => {
    closePathTabs(ctx, store, path, t('closeUnsavedConfirm'))
  }

  // The viewer's toolbar, hoisted into THIS header: the text editor reports
  // its state and registers its commands (both null/absent for viewers
  // without a toolbar — image, pdf, binary download).
  const [toolbar, setToolbar] = useState<EditorToolbarState | null>(null)
  const controlsRef = useRef<EditorToolbarControls | null>(null)
  const onToolbarState = useCallback((next: EditorToolbarState) => {
    setToolbar(prev => prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }, [])
  const onToolbarControls = useCallback((controls: EditorToolbarControls | null) => {
    controlsRef.current = controls
  }, [])

  // Publish this tab's unsaved-draft state to the close/unload guards: the
  // toolbar report already carries `dirty`, so no extra plumbing is needed.
  // A path-less window (the files home) and folder windows never register.
  // The cleanup clears on unmount (tab closed, session switched, in-place
  // path switch remounts the viewer) so a guard can never outlive its draft.
  useEffect(() => {
    if (path === '' || isDir) return
    setEditorDirty(tab.id, toolbar?.dirty === true, scope.sessionId, path)
    return () => { clearEditorDirty(tab.id) }
  }, [tab.id, toolbar?.dirty, scope.sessionId, path, isDir])

  // The docked panel's drag-resize: pointer capture on the handle itself
  // (no window listeners — the captured pointer keeps tracking even off the
  // handle). Local width while dragging, persisted into meta.treeWidth on
  // release. The panel docks right, so dragging LEFT widens it.
  // Moves are BATCHED per frame (createFrameBatcher): applying every
  // pointermove is a setState that re-renders this host AND the editor
  // viewer below it (CodeMirror re-lays out on the width change) at event
  // cadence — the visible drag lag on slower CPUs (#315). The batch applies
  // the latest width once per frame; release flushes it and commits.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const pendingWidthRef = useRef(0)
  const dragBatcher = useRef(createFrameBatcher()).current
  useEffect(() => () => dragBatcher.dispose(), [dragBatcher])
  const treeWidth = dragWidth ?? treeWidthOf(tab)

  const onResizeStart = (event: React.PointerEvent): void => {
    event.preventDefault()
    // jsdom lacks setPointerCapture — the tests dispatch plain MouseEvents.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { startX: event.clientX, startWidth: treeWidth }
  }
  const onResizeMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    pendingWidthRef.current = clampTreeWidth(drag.startWidth + (drag.startX - event.clientX))
    dragBatcher.schedule(() => setDragWidth(pendingWidthRef.current))
  }
  const onResizeEnd = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    // Flush the last pending frame (a release can land with the final move
    // still queued; without the flush a stray frame would re-apply the
    // drag width AFTER the null below). Both setStates batch into this same
    // event, so the committed treeWidth wins visually.
    dragBatcher.flushNow()
    dragRef.current = null
    setDragWidth(null)
    const finalWidth = clampTreeWidth(drag.startWidth + (drag.startX - event.clientX))
    if (finalWidth !== treeWidthOf(tab)) patchMeta(ctx, tab, scope.sessionId, { treeWidth: finalWidth })
  }

  /** The rename-marker key for this tab (see `pathTabKey`): the session this
   *  editor reads and writes in, plus the tab id. */
  const retargetKey = pathTabKey(scope.sessionId, tab.id)
  /** The path this editor last loaded (or was mounted on) — the rename retarget
   *  announces itself as a move away from it. */
  const loadedPathRef = useRef(path)
  // A mounted editor is the only thing that can claim a retarget: once it is
  // gone the announcement can never be applied, so it must not sit in the map
  // for the rest of the page's life. A remount loads the record's current path
  // either way, which is exactly what the marker would have preserved.
  useEffect(() => () => { clearRetargetedPath(retargetKey) }, [retargetKey])
  useEffect(() => {
    // A rename moved the file, not its bytes: the tab follows the new name
    // (tree-mutations' retargetPathTabs) while the loaded document — and an
    // unsaved draft, which lives only in the editor instance — stays put.
    // Reloading here would swap the content for the very same bytes and drop
    // the draft with it, so the retarget is consumed instead; the next save
    // simply lands on the new name. A path that moved WITHOUT that marker is a
    // real switch to another file, which must load as usual.
    //
    // This runs BEFORE the toolbar reset below: nothing reloads, so the viewer
    // keeps reporting the state it already has — clearing it here dropped the
    // dirty mark (and with it the close guard) of a draft that was still
    // unsaved.
    const previousPath = loadedPathRef.current
    const movedPath = previousPath !== path
    loadedPathRef.current = path
    if (movedPath && consumeRetargetedPath(retargetKey, previousPath, path)) return
    if (!movedPath) clearRetargetedPath(retargetKey)
    // A (re)load or a path-less tab clears any hoisted toolbar state — the
    // fresh viewer re-registers its own.
    setToolbar(null)
    // The seeded home tab (no path) never loads a viewer — the empty-state
    // hint renders until the user picks a file. A folder tab never loads a
    // viewer either — its tree is rooted at the folder.
    if (showEmpty || isDir) return
    let cancelled = false
    // Aborts the matched viewer's `load` when the editor tears down (tab
    // closed, path changed, session switched) or re-matches the viewer.
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    const mediaUrlOf = (): string => mediaUrl(scope, path)
    const apply = (action: EditorLoadAction): void => {
      if (cancelled) return
      switch (action.kind) {
        case 'binary':
          setLoad({ status: 'binary' })
          return
        case 'render':
          setLoad({
            status: 'ready',
            viewer: action.viewer,
            content: action.content,
            truncated: action.truncated,
            mediaUrl: action.mediaUrl,
            customData: action.customData,
          })
          return
        case 'customLoad':
          void action.viewer.load?.(path, scope, controller.signal).then((data) => {
            if (cancelled) return
            setLoad({ status: 'ready', viewer: action.viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
        case 'fetchFsRead':
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            // Binary reads carry the head bytes for the detect re-match.
            const outcome = planFsReadOutcome(action.viewer, {
              binary: result.kind === 'binary',
              content: result.kind === 'text' ? result.content : '',
              truncated: result.truncated,
              head: result.kind === 'binary' ? result.head : undefined,
            }, (head) => ctx.get('betterSidebar')?.matchFileViewer(path, head), mediaUrlOf)
            // Carry the read's mtime into the rendered viewer: the text
            // editor uses it as the save baseline (fs-conflict on drift).
            if (outcome.kind === 'render') setLoad({ ...outcome, status: 'ready', mtimeMs: result.mtimeMs })
            else apply(outcome)
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
      }
    }
    apply(planFirstMatch(ctx.get('betterSidebar')?.matchFileViewer(path), mediaUrlOf))
    return () => { cancelled = true; controller.abort() }
    // The deps are deliberately granular: the scope object's identity churns,
    // only its sessionId / cwd fields gate the (re)fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd, path, ctx, showEmpty, isDir, reloadSeq])

  // Save-then-refresh in preview mode (issue #167 part C): the edge into
  // 'saved' (never a lingering 'saved' state) triggers exactly one reload, so
  // a preview-mode Ctrl+S shows the fresh content immediately. Edit mode is
  // left alone — reloading would remount the editor and drop the caret.
  const prevSaveState = useRef<EditorToolbarState['saveState'] | undefined>(undefined)
  useEffect(() => {
    const current = toolbar?.saveState
    if (prevSaveState.current !== 'saved' && current === 'saved' && toolbar?.mode === 'preview') {
      setReloadSeq(sequence => sequence + 1)
    }
    prevSaveState.current = current
  }, [toolbar?.saveState, toolbar?.mode])

  // Model-write auto-refresh (issue #855): a `write` / `edit` tool call of THIS
  // session that settled without an error and named THIS file reloads the
  // preview — silently, through the very same load path the header's refresh
  // button uses (so that manual entry keeps working untouched).
  //
  // The signal is the plugin's own `changes.ops` delta stream, consumed by ONE
  // shared poller per session (see ops-stream.ts): this tab joins it only while
  // it is on screen with a real file, so a parked tab costs no requests, and a
  // tab of another session never sees these touches at all.
  const ops = useFileOpStream(scope, visible && !showEmpty && !isDir)
  /** The stream revision this tab's current path is known fresh at. */
  const opBaseline = useRef<{ key: string; revision: number } | null>(null)
  useEffect(() => {
    const key = `${scope.sessionId}\u0000${path}`
    const seen = opBaseline.current
    if (seen === null || seen.key !== key) {
      // A (re)targeted tab has just loaded the file: only a touch published
      // AFTER this moment may reload it. Without this, every already-settled
      // write of the session would fire on open.
      opBaseline.current = { key, revision: ops.revision }
      return
    }
    const touch = ops.touched.get(fileOpKey(scope.cwd, path))
    if (touch === undefined || touch.revision <= seen.revision) return
    // Consume the touch whatever we decide: the file on disk moved past this
    // tab, and neither branch may fire twice for the same revision.
    opBaseline.current = { key, revision: ops.revision }
    // Dirty priority (#228, #855): a draft lives only in the editor instance,
    // and reloading remounts it — the user's unsaved input must never be
    // overwritten by what the model wrote. An open edit session is skipped for
    // the same reason (it would drop the caret); the pre-existing
    // edit→preview edge reloads on the way back, and the header's refresh
    // button stays the explicit escape hatch in both cases.
    if (toolbar?.dirty === true || toolbar?.mode === 'edit') return
    setReloadSeq(sequence => sequence + 1)
    // Granular deps: the scope object's identity churns, so only its
    // sessionId / cwd fields gate this decision.
  }, [ops, path, scope.sessionId, scope.cwd, toolbar?.dirty, toolbar?.mode])

  const treeOpen = treeOpenOf(tab)
  /** Persist the panel flag on the tab (survives reloads with the layout). */
  const toggleTree = (): void => { patchMeta(ctx, tab, scope.sessionId, { treeOpen: !treeOpen }) }
  const saveLabel = toolbar === null ? ''
    : toolbar.saveState === 'saving' ? t('loading')
      : toolbar.saveState === 'saved' ? t('saved')
        : toolbar.saveState === 'failed' ? t('saveFailed') : ''

  // Split mode: the path-less window IS the standalone explorer — the tree
  // panel fills the whole tab (search + FileTree, full form), no editor
  // chrome. File opens land in new per-path tabs through openFile above.
  // A folder window (meta.dir, any mode) renders the SAME surface rooted
  // at the folder instead of the session cwd.
  if (treeOnly || folderRoot !== undefined) {
    return (
      <div className={css.editor}>
        <TreePanel
          full
          visible={visible}
          sessionId={scope.sessionId}
          cwd={folderRoot ?? scope.cwd}
          expanded={expanded}
          revealed={revealed}
          onToggle={onToggleDir}
          onOpenFile={openFile}
          onOpenFileNewTab={openFileNewTab}
          onOpenFileSide={openFileSide}
          openInApp={openInApp}
          openWithShowPluginTargets={openWithShowPluginTargets}
          openWithTargets={openWithTargets}
          openWithPinned={openWithConfig.pinned}
          openWithSsh={openWithSshActive(openWithConfig)}
          onOpenWith={openWith}
          onToggleOpenWithPin={toggleOpenWithPin}
          onReferenceFile={onReferenceFile}
          onPathRenamed={onPathRenamed}
          onPathDeleted={onPathDeleted}
          exclude={exclude}
          service={ctx.get('betterSidebar')}
        />
      </div>
    )
  }

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <EditorPathInput key={path} path={path} cwd={scope.cwd} onOpen={openFile} />
        {toolbar?.modes === true && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'preview' && css.editorModeActive)}
              onClick={() => {
                // Issue #167 part B: returning from edit to preview reloads so
                // the preview renders the just-saved content. A dirty draft
                // (or a failed save) suppresses the reload — the draft only
                // lives in the editor instance and a remount would drop it.
                if (toolbar.mode === 'edit' && toolbar.dirty !== true && toolbar.saveState !== 'failed') {
                  setReloadSeq(sequence => sequence + 1)
                }
                controlsRef.current?.setMode('preview')
              }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'edit' && css.editorModeActive)}
              onClick={() => { controlsRef.current?.setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {toolbar?.dirty === true && <span className={css.dirtyDot} title={t('unsaved')} />}
        {toolbar?.editable === true && toolbar?.truncated !== true && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={() => { controlsRef.current?.save() }}
          >
            <IconCheckOutlineRegular size={14} />
          </button>
        )}
        {saveLabel !== '' && (
          <span className={clsx(css.editorStatus, toolbar?.saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>
        )}
        {toolbar !== null && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={refreshFile}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
        )}
        <button
          type="button"
          className={clsx(css.iconButton, treeOpen && css.editorTreeToggleActive)}
          aria-label={t('editorTreeToggle')}
          title={t('editorTreeToggle')}
          aria-pressed={treeOpen}
          onClick={toggleTree}
        >
          <IconFolderOpenRegular size={14} />
        </button>
      </div>
      <div className={css.editorBody}>
        <div className={css.editorMain}>
          {showEmpty && <div className={css.editorPlaceholder}>{t('editorEmptyHint')}</div>}
          {!showEmpty && load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
          {!showEmpty && load.status === 'error' && <div className={css.editorError}>{load.message}</div>}
          {!showEmpty && load.status === 'binary' && <BinaryDownload scope={scope} path={path} />}
          {!showEmpty && load.status === 'ready' && createElement(load.viewer.component, {
            ctx, store, scope, path, title,
            viewerId: load.viewer.id,
            // The reference's landing line, if the address carried one (#826).
            // Only the text viewer acts on it; a markdown/html/image viewer
            // gets the field and ignores it.
            line: tab.line,
            content: load.content,
            truncated: load.truncated,
            mtimeMs: load.mtimeMs,
            mediaUrl: load.mediaUrl,
            customData: load.customData,
            // The viewer's toolbar always hoists into this host's header.
            toolbar: 'host',
            onToolbarState,
            onToolbarControls,
            onReload: refreshFile,
          })}
        </div>
        {treeOpen && (
          <div className={css.editorTreeDock} style={{ width: treeWidth }}>
            <div
              className={css.editorTreeResize}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('editorTreeToggle')}
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
            />
            <TreePanel
              visible={visible}
              sessionId={scope.sessionId}
              cwd={scope.cwd}
              expanded={expanded}
              revealed={revealed}
              onToggle={onToggleDir}
              onOpenFile={openFile}
              onOpenFileNewTab={openFileNewTab}
              onOpenFileSide={openFileSide}
              openInApp={openInApp}
              openWithShowPluginTargets={openWithShowPluginTargets}
              openWithTargets={openWithTargets}
              openWithPinned={openWithConfig.pinned}
              openWithSsh={openWithSshActive(openWithConfig)}
              onOpenWith={openWith}
              onToggleOpenWithPin={toggleOpenWithPin}
              onReferenceFile={onReferenceFile}
              onPathRenamed={onPathRenamed}
              onPathDeleted={onPathDeleted}
              exclude={exclude}
              service={ctx.get('betterSidebar')}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The header's path input: shows the current file relative to the session
 * cwd (absolute when outside it). Enter resolves the typed path (relative
 * input joins onto the cwd — the same resolution `openSidebarFile` uses)
 * and opens it through the parent's mode-aware open (in-place switch or a
 * per-path dedupe tab); Escape/blur restores the current value. The parent
 * keys it by `path` so an in-place switch remounts and reseeds the draft.
 */
function EditorPathInput(props: { path: string; cwd: string | undefined; onOpen: (path: string) => void }) {
  const { path, cwd, onOpen } = props
  const display = path === '' ? '' : relativeTo(cwd ?? '', path)
  const [value, setValue] = useState(display)

  const commit = (): void => {
    const input = value.trim()
    if (input === '' || input === display) {
      setValue(display)
      return
    }
    onOpen(resolveSidebarPath(cwd, input))
    // Split mode: the open lands in a NEW/deduped editor tab — THIS tab's
    // path stays, so the input falls back to its own display value. (Merged
    // mode remounts this input on the new path; the reset is harmless.)
    setValue(display)
  }

  return (
    <input
      className={css.editorPathInput}
      value={value}
      placeholder={t('editorPathPlaceholder')}
      title={path}
      spellCheck={false}
      onChange={(event) => { setValue(event.target.value) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          setValue(display)
        }
      }}
      onBlur={() => { setValue(display) }}
    />
  )
}
