/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke)
 * over the shared controlled FileTree. The results panel and the tree are
 * BOTH mounted: the query only parks one of them (`hidden`), so clearing the
 * search is free — the tree keeps its level cache and the live directory
 * watcher (the old conditional render dropped both and refetched the whole
 * visible set on every query change). Owns its refresh tick: the icon next to
 * the search input clears the tree cache, and the sort menu beside it owns the
 * tree's row order (passed down; the default is the host's own order).
 * EditorHost docks it as the tab's right panel (wrapped in a drag-resize
 * handle) and provides the file context-menu open escapes.
 *
 * Uploads (header pickers, the tree's drag-drop and "upload here" menu)
 * all funnel through here: one session at a time, shown in a full-window
 * progress overlay with cancel, followed by a tree refresh and a one-line
 * hint under the search row (success fades, failures and cancels stay).
 * OS file drags are shielded at the panel host (see Sidebar.tsx), so a
 * drop over the file window uploads here and never reaches DSH's chat
 * intake.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import { IconChevronsUpDownOutlineRegular, IconFolderOpenRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { ancestorDirs } from './state.ts'
import { FileTree } from './FileTree.tsx'
import { DEFAULT_FILE_TREE_SORT, type FileTreeSort } from './file-tree-sort.ts'
import { IconUploadOutline16 } from './icons.tsx'
import type { OpenInApp } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { isWithinWorkspace } from './paths.ts'
import { IconButton, LoadingIndicator, Menu, Notice, TextInput } from './ui/index.ts'
import { UploadOverlay } from './UploadOverlay.tsx'
import {
  summarizeResults, uploadHintText, uploadItemsFromFiles, uploadToDir,
  UPLOAD_HINT_MS, type UploadItem,
} from './upload.ts'
import css from './sidebar.module.css'

/** One in-flight upload session (the overlay's progress source). */
interface UploadSession {
  dir: string
  done: number
  total: number
  /** Relative path of the file being uploaded ('' when none is in flight). */
  current: string
  controller: AbortController
}

/** 提供工作区的文件树、文件名搜索与上传入口。 */
export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  revealed: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** File context-menu "open in a new tab" (passed through to FileTree). */
  onOpenFileNewTab?: (path: string) => void
  /** File context-menu "open to the side" (passed through to FileTree). */
  onOpenFileSide?: (path: string) => void
  /** The host's open-in-app handle (passed through to FileTree; absent →
   *  the HOST half of the "打开方式" section is hidden). */
  openInApp?: OpenInApp
  /** The plugin's own open-with targets (passed through to FileTree; coexists
   *  with `openInApp`; absent → no plugin half). */
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
  /** Open one plugin target (passed through to FileTree; `false`/rejection →
   *  the tree reports the failure in its strip). */
  onOpenWith?: (targetId: string, path: string) => void | boolean | Promise<void | boolean>
  onToggleOpenWithPin?: (targetId: string) => void
  /** Show the plugin's own open-with targets even when the host lists local
   *  applications for the path (the `openWithPluginTargets` setting; passed
   *  through to FileTree). */
  openWithShowPluginTargets?: boolean
  onReferenceFile: (path: string, isDir: boolean) => void
  /** The explorerExclude pref patterns: the host filters the tree listing AND
   *  the name search with them (passed through to FileTree, and carried on the
   *  search request so both surfaces agree). */
  exclude?: readonly string[]
  /** A tree rename landed (passed through to FileTree for tab retargeting). */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** A tree delete landed (passed through to FileTree for tab closing). */
  onPathDeleted?: (path: string, isDir: boolean) => void
  /** Whether the owning tab is on screen: a parked tab stops the tree's git
   *  polling (the shared status store pauses when nothing visible wants it). */
  visible?: boolean
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** The sidebar registry service (file-icon registrations; passed through to FileTree). */
  service?: BetterSidebarService
}) {
  const {
    sessionId, cwd, expanded, revealed, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide,
    openInApp, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin,
    openWithShowPluginTargets, exclude,
    onReferenceFile, onPathRenamed, onPathDeleted, visible, full, service,
  } = props
  const [query, setQuery] = useState('')
  const [searchResponse, setSearchResponse] = useState<{
    key: string
    results: Awaited<ReturnType<typeof api.fsSearch>> | null
    error: string | null
  } | null>(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const [refreshTick, setRefreshTick] = useState(0)
  /**
   * The explorer's row order (the header's sort control). Starts at the
   * default — name order, folders first — which is the order the host already
   * returns, so the tree looks exactly as it did before the control existed.
   */
  const [sort, setSort] = useState<FileTreeSort>(DEFAULT_FILE_TREE_SORT)
  const [sortOpen, setSortOpen] = useState(false)

  // The tree caches loaded directories per refresh tick, so content changed
  // outside DSH (another editor, a sync tool) stays stale until the manual
  // refresh click. Re-focusing the window bumps the tick automatically, and
  // integrations can force a refresh by dispatching a bubbling
  // `dsh-sidebar:refresh-files` event on `window`.
  //
  // A PARKED panel (the host keeps every visited tab body mounted) listens to
  // neither: a focus bump would force a full re-list of a tree nobody can see.
  // It catches up through the directory watcher's one batched refresh when it
  // becomes visible again (see FileTree's `visibleRef`).
  useEffect(() => {
    if (visible === false) return
    const bump = (): void => { setRefreshTick(tick => tick + 1) }
    window.addEventListener('focus', bump)
    window.addEventListener('dsh-sidebar:refresh-files', bump)
    return () => {
      window.removeEventListener('focus', bump)
      window.removeEventListener('dsh-sidebar:refresh-files', bump)
    }
  }, [visible])
  /** One-line upload status under the search row ('' hides the hint). */
  const [uploadStatus, setUploadStatus] = useState('')
  /** Whether the status line is a failure/cancel (error color, stays visible). */
  const [uploadFailed, setUploadFailed] = useState(false)
  /** The in-flight upload session (null → no overlay, buttons enabled). */
  const [upload, setUpload] = useState<UploadSession | null>(null)
  /** True between the cancel click and the session settling (button disabled). */
  const [cancelling, setCancelling] = useState(false)
  /** Set by cancelUpload; the settle path shows 'upload cancelled' instead of
   *  summarizing the partial results. */
  const cancelledRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  /** Start one upload session into `dir` (absolute, inside the workspace). */
  const startUpload = (dir: string, items: UploadItem[]): void => {
    if (items.length === 0 || cwd === undefined || upload !== null) return
    cancelledRef.current = false
    const controller = new AbortController()
    setUploadFailed(false)
    setUploadStatus(uploadHintText(0, items.length, '', dir, t))
    setUpload({ dir, done: 0, total: items.length, current: '', controller })
    void uploadToDir({ sessionId, cwd }, dir, items, (done, total, current) => {
      if (current !== '') setUploadStatus(uploadHintText(done, total, current, dir, t))
      setUpload(session => session === null ? session : { ...session, done, total, current })
    }, controller.signal).then((results) => {
      setUpload(null)
      setCancelling(false)
      // Reload the tree whatever the outcome: files may have landed before a
      // cancel, and failures leave whatever did succeed visible.
      setRefreshTick(tick => tick + 1)
      setSearchRevision(revision => revision + 1)
      if (cancelledRef.current) {
        setUploadStatus(t('uploadCancelled'))
        setUploadFailed(true)
        return
      }
      const status = summarizeResults(results, t)
      setUploadStatus(status)
      setUploadFailed(results.some(result => !result.ok))
      // Success messages are transient; failures stay until the next action.
      if (results.every(result => result.ok)) {
        window.setTimeout(() => {
          setUploadStatus(current => current === status ? '' : current)
        }, UPLOAD_HINT_MS)
      }
    })
  }

  /** Cancel the in-flight upload (aborts the request; the host drops its temp). */
  const cancelUpload = (): void => {
    if (upload === null || cancelling) return
    cancelledRef.current = true
    setCancelling(true)
    upload.controller.abort()
  }

  const folderInputProps = { webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>

  const needle = query.trim()
  const searching = needle !== ''
  // The search effect below must re-run on a CHANGED list, never on a churned
  // array identity: the prefs store hands out one stable reference per
  // document, but keying on the value is what makes that a guarantee rather
  // than an assumption (a re-run resets the 300ms debounce, so a per-render
  // identity would keep the search from ever settling).
  const excludeKey = (exclude ?? []).join('\0')
  // 搜索结果可以触发文件修改，切换目录或查询后不能继续操作上一轮结果。
  const searchKey = JSON.stringify([sessionId, cwd, needle, excludeKey, searchRevision])
  const results = searchResponse?.key === searchKey ? searchResponse.results : null
  const error = searchResponse?.key === searchKey ? searchResponse.error : null
  useEffect(() => {
    setSearchResponse(null)
    if (needle === '') return
    const controller = new AbortController()
    const patterns = excludeKey === '' ? undefined : excludeKey.split('\0')
    const timer = window.setTimeout(() => {
      api.fsSearch({ sessionId, cwd }, needle, patterns, controller.signal).then((found) => {
        if (controller.signal.aborted) return
        setSearchResponse({ key: searchKey, results: found, error: null })
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        const message = failure instanceof Error ? failure.message : String(failure)
        // An unreadable search root is now a real failure (the host used to
        // answer it as an empty, legitimate-looking result). Keep the
        // localized failure label in front of the host's concrete reason
        // instead of showing a bare English errno sentence.
        const code = (failure as { code?: unknown } | null)?.code
        setSearchResponse({ key: searchKey, results: null, error: code === 'fs-error' ? `${t('error')}: ${message}` : message })
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, cwd, needle, excludeKey, searchKey])

  const busy = upload !== null
  /** Directory hits (the host reports them separately): a click navigates the
   *  tree for those rows instead of opening them as files. */
  const dirHits = useMemo(() => new Set(results?.dirs), [results])

  /**
   * Jump to a DIRECTORY hit in the tree. Results include directories (they
   * show where matches live) and `fs.read` refuses one, so opening such a row
   * as a file surfaced a bare `"…" is a directory` error. Expand the folder
   * and its ancestors instead — `onToggle` FLIPS a row, so only collapsed
   * paths are touched — and clear the query so the tree, not the parked
   * results panel, is what the user sees next.
   */
  // A directory hit OUTSIDE the cwd (a pasted absolute path from the
  // direct-open branch) has no tree rows to expand: the tree is cwd-rooted,
  // and `ancestorDirs` would synthesize cwd-length prefixes of a foreign
  // path that toggle nothing and persist as junk `expanded` entries. Such a
  // row only clears the query.
  const openSearchDir = (target: string): void => {
    if (cwd !== undefined && isWithinWorkspace(cwd, target)) {
      for (const path of [...ancestorDirs(cwd, [target]), target]) {
        if (!expanded.includes(path)) onToggle(path)
      }
    }
    setQuery('')
  }

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)} data-sidebar-surface="files">
      <div className={css.editorTreeSearch}>
        <TextInput
          className={css.editorSearchInput}
          aria-label={t('editorSearchPlaceholder')}
          type="search"
          value={query}
          placeholder={t('editorSearchPlaceholder')}
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <div className={css.editorTreeActions}>
          <IconButton
            label={t('refresh')}
            icon={<IconRefreshOutlineRegular size={14} />}
            onClick={() => { setRefreshTick(tick => tick + 1) }}
          />
          {/* Row order: the two keys are one choice (check mark), the
              folders-first switch is independent — the same two-group menu the
              host's own menus use. Picking a row closes the menu like every
              other menu in the plugin. */}
          <Menu
            open={sortOpen}
            onClose={() => { setSortOpen(false) }}
            onSelect={(id) => {
              setSort((current) => {
                if (id === 'sort-name') return { ...current, key: 'name' }
                if (id === 'sort-type') return { ...current, key: 'type' }
                return { ...current, dirsFirst: !current.dirsFirst }
              })
              setSortOpen(false)
            }}
            items={[
              { id: 'sort-name', label: t('sortByName'), icon: <IconChevronsUpDownOutlineRegular size={14} /> },
              { id: 'sort-type', label: t('sortByType'), icon: <IconChevronsUpDownOutlineRegular size={14} /> },
              { type: 'separator', id: 'sort-sep' },
              { id: 'sort-folders-first', label: t('sortFoldersFirst') },
            ]}
            selectedIds={[
              sort.key === 'name' ? 'sort-name' : 'sort-type',
              ...(sort.dirsFirst ? ['sort-folders-first'] : []),
            ]}
            align="end"
            compact
            anchor={(
              <IconButton
                label={t('sort')}
                aria-haspopup="menu"
                aria-expanded={sortOpen}
                icon={<IconChevronsUpDownOutlineRegular size={14} />}
                onClick={() => { setSortOpen(open => !open) }}
              />
            )}
          />
          <IconButton
            label={t('uploadFiles')}
            icon={<IconUploadOutline16 size={14} />}
            disabled={busy}
            onClick={() => { fileInputRef.current?.click() }}
          />
          <IconButton
            label={t('uploadFolder')}
            icon={<IconFolderOpenRegular size={14} />}
            disabled={busy}
            onClick={() => { folderInputRef.current?.click() }}
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => {
            if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          {...folderInputProps}
          style={{ display: 'none' }}
          onChange={(event) => {
            if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      {uploadStatus !== '' && (
        <div className={clsx(css.editorSearchHint, uploadFailed && css.editorError)} title={uploadStatus} role={uploadFailed ? 'alert' : 'status'}>{uploadStatus}</div>
      )}
      {/* 搜索与文件树共享操作，查询期间保留文件树缓存与目录监听。 */}
      <FileTree
        sessionId={sessionId}
        cwd={cwd}
        expanded={expanded}
        revealed={revealed}
        onToggle={onToggle}
        onOpenFile={onOpenFile}
        onOpenFileNewTab={onOpenFileNewTab}
        onOpenFileSide={onOpenFileSide}
        openInApp={openInApp}
        openWithTargets={openWithTargets}
        openWithPinned={openWithPinned}
        openWithSsh={openWithSsh}
        onOpenWith={onOpenWith}
        onToggleOpenWithPin={onToggleOpenWithPin}
        openWithShowPluginTargets={openWithShowPluginTargets}
        exclude={exclude}
        onReferenceFile={onReferenceFile}
        onPathRenamed={onPathRenamed}
        onPathDeleted={onPathDeleted}
        onContentsChanged={() => { setSearchRevision(revision => revision + 1) }}
        refreshTick={refreshTick}
        onUploadRequest={startUpload}
        busy={busy}
        hidden={searching}
        searchKey={searching ? searchKey : undefined}
        searchRoot={results?.cwd}
        visible={visible !== false}
        sort={sort}
        service={service}
        renderSearchResults={({ openMenu, renameEditor, createEditor }) => (
          <>
            {error !== null && <Notice kind="error" role="alert">{error}</Notice>}
            {error === null && results === null && <LoadingIndicator label={t('loading')} />}
            {error === null && results !== null && results.matches.length === 0 && (
              <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
            )}
            {error === null && results !== null && results.matches.map((rel, index) => {
              const isDirHit = dirHits.has(rel)
              const path = results.paths[index]!
              return (
                <Fragment key={rel}>
                  {renameEditor(path) ?? (
                    <button
                      type="button"
                      className={clsx(css.editorSearchResult, isDirHit && css.editorSearchResultDir)}
                      title={rel}
                      data-dsh-search-dir={isDirHit ? 'true' : undefined}
                      onContextMenu={(event) => { openMenu(event, path, isDirHit) }}
                      onClick={() => {
                        if (isDirHit) openSearchDir(path)
                        else onOpenFile(path)
                      }}
                    >
                      {isDirHit && <IconFolderOpenRegular size={14} />}
                      <span className={css.editorSearchResultLabel}>{rel}</span>
                    </button>
                  )}
                  {isDirHit && createEditor(path)}
                </Fragment>
              )
            })}
            {error === null && results?.truncated === true && (
              <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
            )}
          </>
        )}
      />
      {upload !== null && (
        <UploadOverlay
          dir={upload.dir}
          done={upload.done}
          total={upload.total}
          current={upload.current}
          onCancel={cancelUpload}
          cancelling={cancelling}
        />
      )}
    </div>
  )
}
