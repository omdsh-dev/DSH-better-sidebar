/**
 * The files window's tree surface: a global search box on top over the shared
 * controlled FileTree. Two search modalities share the one box:
 *
 * - **name** (the default, the pre-existing behavior): a 300ms-debounced
 *   global file-NAME search — the host's `fs.search` walk/engines, results as
 *   one flat list;
 * - **content** (the VS Code Search view analogue): a 350ms-debounced
 *   project-wide TEXT search (`fs.grep`) with the case / whole-word / regex
 *   toggles, a replace field (`fs.grepReplace`, Replace All), and the
 *   files-to-include / files-to-exclude glob inputs. Results group by file and
 *   each row carries its line number plus highlighted match ranges.
 *
 * The results panel and the tree are BOTH mounted: a query only parks one of
 * them (`hidden`), so clearing the search is free — the tree keeps its level
 * cache and the live directory watcher (the old conditional render dropped
 * both and refetched the whole visible set on every query change).
 *
 * Search result rows carry the same git ink as the tree (`useGitStatus` is one
 * shared store): a modified file's name takes its tone and a letter badge, so
 * the result list is color-differentiated from clean files exactly like the
 * explorer.
 *
 * Owns its refresh tick: the icon next to the search input clears the tree
 * cache (and re-runs a live content search), and the sort menu beside it owns
 * the tree's row order (passed down; the default is the host's own order).
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
import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconChevronsUpDownOutlineRegular,
  IconEditOutlineRegular, IconFlatListOutlineRegular, IconFolderOpenRegular, IconRefreshOutlineRegular,
  IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type GrepLine, type GrepResult } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { ancestorDirs } from './state.ts'
import { badgeToneOf, FileTree, gitToneLabel } from './FileTree.tsx'
import { DEFAULT_FILE_TREE_SORT, type FileTreeSort } from './file-tree-sort.ts'
import { IconUploadOutline16 } from './icons.tsx'
import type { OpenInApp } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { isWithinWorkspace, resolveSidebarPath } from './paths.ts'
import { ConfirmDialog, IconButton, invalidateGitStatus, StatusBadge, useGitStatus, type GitFileStatus } from './ui/index.ts'
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

/** Which search the box runs. */
type SearchMode = 'name' | 'content'

/** Split a comma/newline separated pattern field into trimmed patterns. */
function splitPatterns(raw: string): string[] {
  return raw.split(/[,\n]/).map(part => part.trim()).filter(part => part !== '')
}

/** Join a pattern list into one effect dependency (never a churned array). */
function patternsKey(patterns: readonly string[]): string {
  return patterns.join('\0')
}

/**
 * Render one matching line with its match ranges wrapped in `<mark>`: the
 * host reports exact UTF-16 offsets, so the preview highlights what actually
 * matched (a regex result too) rather than re-searching the text client-side.
 */
function snippetNodes(match: GrepLine): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  match.ranges.forEach((range, index) => {
    if (range.start > cursor) nodes.push(match.text.slice(cursor, range.start))
    nodes.push(<mark key={index} className={css.editorSearchMark}>{match.text.slice(range.start, range.end)}</mark>)
    cursor = range.end
  })
  if (cursor < match.text.length) nodes.push(match.text.slice(cursor))
  return nodes
}

export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  revealed: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Open a content-search hit at its 1-based line. Absent → `onOpenFile`
   *  (the row still opens the file, it just cannot land on the line). */
  onOpenFileAtLine?: (path: string, line: number) => void
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
   *  search request so both surfaces agree). A content search MERGES them with
   *  its own files-to-exclude field. */
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
    sessionId, cwd, expanded, revealed, onToggle, onOpenFile, onOpenFileAtLine,
    onOpenFileNewTab, onOpenFileSide,
    openInApp, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin,
    openWithShowPluginTargets, exclude,
    onReferenceFile, onPathRenamed, onPathDeleted, visible, full, service,
  } = props
  const [mode, setMode] = useState<SearchMode>('name')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; dirs: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /** Bumped after a replace so the live content search re-runs against disk. */
  const [grepReload, setGrepReload] = useState(0)
  /**
   * The explorer's row order (the header's sort control). Starts at the
   * default — name order, folders first — which is the order the host already
   * returns, so the tree looks exactly as it did before the control existed.
   */
  const [sort, setSort] = useState<FileTreeSort>(DEFAULT_FILE_TREE_SORT)
  const [sortOpen, setSortOpen] = useState(false)

  // ── Content-search options and results ─────────────────────────────────
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [showReplace, setShowReplace] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [includeText, setIncludeText] = useState('')
  const [excludeText, setExcludeText] = useState('')
  const [grep, setGrep] = useState<GrepResult | null>(null)
  const [grepError, setGrepError] = useState<string | null>(null)
  /** Files whose group the reader collapsed (path set; empty = all expanded). */
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(() => new Set())
  const [replaceAsk, setReplaceAsk] = useState(false)
  const [replaceBusy, setReplaceBusy] = useState(false)
  const [replaceNote, setReplaceNote] = useState('')
  const [replaceFailed, setReplaceFailed] = useState(false)

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
  const contentMode = mode === 'content'
  const includePatterns = useMemo(() => splitPatterns(includeText), [includeText])
  const excludePatterns = useMemo(() => splitPatterns(excludeText), [excludeText])
  // The search effect below must re-run on a CHANGED list, never on a churned
  // array identity: the prefs store hands out one stable reference per
  // document, but keying on the value is what makes that a guarantee rather
  // than an assumption (a re-run resets the debounce, so a per-render identity
  // would keep the search from ever settling).
  const excludeKey = patternsKey(exclude ?? [])
  const includeKey = patternsKey(includePatterns)
  // The explorer pref and the user's files-to-exclude field are ONE list
  // host-side (same grammar), so the raw array is only an intermediate — the
  // key is the value the effect depends on, never the array identity.
  const grepExcludeKey = patternsKey([...(exclude ?? []), ...excludePatterns])

  // Name search: unchanged semantics, parked while the box is in content mode
  // (the content effect owns the query then).
  useEffect(() => {
    if (contentMode) return
    if (needle === '') {
      setResults(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    const patterns = excludeKey === '' ? undefined : excludeKey.split('\0')
    const timer = window.setTimeout(() => {
      api.fsSearch({ sessionId, cwd }, needle, patterns, controller.signal).then((found) => {
        setResults(found)
        setError(null)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setResults(null)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [contentMode, sessionId, cwd, needle, excludeKey])

  // Content search: same debounce discipline, a slightly longer wait (the
  // host may read thousands of files), and an AbortController per keystroke —
  // the host stops reading the moment the request is abandoned.
  useEffect(() => {
    if (!contentMode) return
    if (needle === '') {
      setGrep(null)
      setGrepError(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      api.fsGrep({ sessionId, cwd }, needle, {
        ...(includeKey === '' ? {} : { include: includeKey.split('\0') }),
        ...(grepExcludeKey === '' ? {} : { exclude: grepExcludeKey.split('\0') }),
        caseSensitive: matchCase,
        wholeWord,
        regex,
      }, controller.signal).then((found) => {
        setGrep(found)
        setGrepError(null)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setGrep(null)
        setGrepError(failure instanceof Error ? failure.message : String(failure))
      })
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [contentMode, sessionId, cwd, needle, includeKey, grepExcludeKey, matchCase, wholeWord, regex, grepReload])

  /**
   * Run Replace All over the files the CURRENT result list shows. Each file
   * carries the mtime its row was rendered from, so a file that changed on
   * disk since is skipped host-side instead of rewritten from a stale read.
   */
  const runReplace = (): void => {
    if (grep === null || grep.files.length === 0 || replaceBusy) return
    setReplaceBusy(true)
    setReplaceNote('')
    api.fsGrepReplace(
      { sessionId, cwd },
      needle,
      replacement,
      { regex, caseSensitive: matchCase, wholeWord },
      grep.files.map(file => ({ path: file.path, mtimeMs: file.mtimeMs })),
    ).then((result) => {
      setReplaceBusy(false)
      setReplaceFailed(false)
      const notes = [t('editorSearchReplaced', { matches: result.replaced, files: result.files.length })]
      if (result.skipped.length > 0) notes.push(t('editorSearchReplaceSkipped', { files: result.skipped.length }))
      setReplaceNote(notes.join(' · '))
      // The written files are new truth: re-run the search and let the shared
      // git store re-read the ink every row is painted from.
      setGrepReload(tick => tick + 1)
      invalidateGitStatus(sessionId)
      window.dispatchEvent(new CustomEvent('dsh-sidebar:refresh-files'))
    }).catch((failure: unknown) => {
      setReplaceBusy(false)
      setReplaceFailed(true)
      setReplaceNote(t('editorSearchReplaceFailed', {
        message: failure instanceof Error ? failure.message : String(failure),
      }))
    })
  }

  // The shared git status store: the tree (FileTree) and these result rows
  // read ONE snapshot, so a modified file's ink never disagrees between them.
  const gitStatus = useGitStatus({ sessionId, cwd }, { visible: visible !== false })
  /** The git state of one result path (cwd-relative or absolute), or undefined. */
  const statusOf = (rel: string): GitFileStatus | undefined => {
    if (cwd === undefined) return undefined
    return gitStatus.statusOf(resolveSidebarPath(cwd, rel))
  }

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
  const openSearchDir = (rel: string): void => {
    const target = resolveSidebarPath(cwd, rel)
    if (cwd !== undefined && isWithinWorkspace(cwd, target)) {
      for (const path of [...ancestorDirs(cwd, [target]), target]) {
        if (!expanded.includes(path)) onToggle(path)
      }
    }
    setQuery('')
  }

  /** Open a content hit at its line (falling back to the plain open). */
  const openContentHit = (rel: string, line: number): void => {
    const target = resolveSidebarPath(cwd, rel)
    if (onOpenFileAtLine !== undefined) onOpenFileAtLine(target, line)
    else onOpenFile(target)
  }

  /** Toggle one result file's group without touching the others. */
  const toggleResultFile = (path: string): void => {
    setCollapsedFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const refreshAll = (): void => {
    setRefreshTick(tick => tick + 1)
    if (contentMode) setGrepReload(tick => tick + 1)
  }

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}>
      <div className={css.editorTreeSearch}>
        {/* The mode switch: name (flat list glyph) vs content (magnifier). The
            labels are aria/tooltip only — the placeholder says which search
            the box runs right now. */}
        <div className={css.editorSearchModes} role="group" aria-label={t('editorSearchModeName')}>
          <button
            type="button"
            className={clsx(css.editorSearchModeButton, !contentMode && css.editorSearchModeActive)}
            aria-pressed={!contentMode}
            aria-label={t('editorSearchModeName')}
            title={t('editorSearchModeName')}
            onClick={() => { setMode('name') }}
          >
            <IconFlatListOutlineRegular size={14} />
          </button>
          <button
            type="button"
            className={clsx(css.editorSearchModeButton, contentMode && css.editorSearchModeActive)}
            aria-pressed={contentMode}
            aria-label={t('editorSearchModeContent')}
            title={t('editorSearchModeContent')}
            onClick={() => { setMode('content') }}
          >
            <IconSearchOutlineRegular size={14} />
          </button>
        </div>
        <input
          className={css.editorSearchInput}
          value={query}
          placeholder={contentMode ? t('editorSearchContentPlaceholder') : t('editorSearchPlaceholder')}
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      {/* The tool row: content-only search switches on the left, the tree's
          own controls on the right. Kept on its own line so a narrow dock
          never squeezes the query input out. */}
      <div className={css.editorSearchTools}>
        {contentMode && (
          <>
            <IconButton
              size="sm"
              label={t('searchMatchCase')}
              active={matchCase}
              icon={<span className={css.editorSearchGlyph}>Aa</span>}
              onClick={() => { setMatchCase(value => !value) }}
            />
            <IconButton
              size="sm"
              label={t('searchWholeWord')}
              active={wholeWord}
              icon={<span className={css.editorSearchGlyph}>ab</span>}
              onClick={() => { setWholeWord(value => !value) }}
            />
            <IconButton
              size="sm"
              label={t('searchRegexp')}
              active={regex}
              icon={<span className={css.editorSearchGlyph}>.*</span>}
              onClick={() => { setRegex(value => !value) }}
            />
            <IconButton
              size="sm"
              label={t('searchReplace')}
              active={showReplace}
              icon={<IconEditOutlineRegular size={14} />}
              onClick={() => { setShowReplace(value => !value) }}
            />
            <IconButton
              size="sm"
              label={t('editorSearchFilters')}
              active={showFilters}
              icon={<IconSlidersTwoOutlineRegular size={14} />}
              onClick={() => { setShowFilters(value => !value) }}
            />
          </>
        )}
        <span className={css.editorSearchToolsGap} />
        <IconButton
          size="sm"
          label={t('refresh')}
          icon={<IconRefreshOutlineRegular size={14} />}
          onClick={refreshAll}
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
              size="sm"
              label={t('sort')}
              icon={<IconChevronsUpDownOutlineRegular size={14} />}
              onClick={() => { setSortOpen(open => !open) }}
            />
          )}
        />
        <IconButton
          size="sm"
          label={t('uploadFiles')}
          icon={<IconUploadOutline16 size={14} />}
          disabled={busy}
          onClick={() => { fileInputRef.current?.click() }}
        />
        <IconButton
          size="sm"
          label={t('uploadFolder')}
          icon={<IconFolderOpenRegular size={14} />}
          disabled={busy}
          onClick={() => { folderInputRef.current?.click() }}
        />
      </div>
      {/* The two hidden pickers behind the toolbar's upload buttons. */}
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
      {/* Replace field: a second input under the tool row (VS Code's Search
          view shape) plus the Replace All action, which confirms first. */}
      {contentMode && showReplace && (
        <div className={css.editorSearchFieldRow}>
          <input
            className={css.editorSearchInput}
            value={replacement}
            placeholder={t('editorSearchReplacePlaceholder')}
            spellCheck={false}
            onChange={(event) => { setReplacement(event.target.value) }}
          />
          <button
            type="button"
            className={css.editorSearchReplaceAll}
            disabled={grep === null || grep.files.length === 0 || replaceBusy || needle === ''}
            onClick={() => { setReplaceAsk(true) }}
          >
            {t('searchReplaceAll')}
          </button>
        </div>
      )}
      {/* files-to-include / files-to-exclude: the same glob grammar as the
          explorer's exclude pref; comma separated, host-compiled. */}
      {contentMode && showFilters && (
        <>
          <div className={css.editorSearchFieldRow}>
            <input
              className={css.editorSearchInput}
              value={includeText}
              placeholder={t('editorSearchIncludePlaceholder')}
              spellCheck={false}
              onChange={(event) => { setIncludeText(event.target.value) }}
            />
          </div>
          <div className={css.editorSearchFieldRow}>
            <input
              className={css.editorSearchInput}
              value={excludeText}
              placeholder={t('editorSearchExcludePlaceholder')}
              spellCheck={false}
              onChange={(event) => { setExcludeText(event.target.value) }}
            />
          </div>
        </>
      )}
      {replaceNote !== '' && (
        <div className={clsx(css.editorSearchHint, replaceFailed && css.editorError)} title={replaceNote}>{replaceNote}</div>
      )}
      {uploadStatus !== '' && (
        <div className={clsx(css.editorSearchHint, uploadFailed && css.editorError)} title={uploadStatus}>{uploadStatus}</div>
      )}
      {/* Search results: parked (not unmounted) while the query is empty. Its
          contents render only for a live query — a parked panel must not put
          state text (the loading line) into the panel's DOM. */}
      <div
        className={clsx(css.explorerBody, !searching && css.explorerHiddenPane)}
        hidden={!searching}
      >
        {searching && !contentMode && (
          <>
            {error !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{error}</div>}
            {error === null && results === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
            {error === null && results !== null && results.matches.length === 0 && (
              <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
            )}
            {error === null && results !== null && results.matches.map((rel) => {
              const isDirHit = dirHits.has(rel)
              const status = isDirHit ? undefined : statusOf(rel)
              const changedDir = isDirHit && cwd !== undefined
                ? gitStatus.dirHasChanges(resolveSidebarPath(cwd, rel))
                : false
              return (
                <button
                  key={rel}
                  type="button"
                  className={clsx(css.editorSearchResult, isDirHit && css.editorSearchResultDir)}
                  title={rel}
                  data-dsh-search-dir={isDirHit ? 'true' : undefined}
                  onClick={() => {
                    if (isDirHit) openSearchDir(rel)
                    else onOpenFile(resolveSidebarPath(cwd, rel))
                  }}
                >
                  {isDirHit && <IconFolderOpenRegular size={14} />}
                  <span
                    className={clsx(
                      css.editorSearchResultLabel,
                      status !== undefined && css.explorerGitName,
                      changedDir && css.explorerDirChanged,
                    )}
                    data-git-tone={status?.tone}
                  >{rel}</span>
                  {status !== undefined && (
                    <StatusBadge tone={badgeToneOf(status.tone)} title={gitToneLabel(status.tone)}>{status.letter}</StatusBadge>
                  )}
                </button>
              )
            })}
            {error === null && results?.truncated === true && (
              <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
            )}
          </>
        )}
        {searching && contentMode && (
          <>
            {grepError !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{grepError}</div>}
            {grepError === null && grep === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
            {grepError === null && grep !== null && grep.files.length === 0 && (
              <div className={css.editorSearchHint}>{t('editorSearchContentNoResults')}</div>
            )}
            {grepError === null && grep !== null && grep.files.length > 0 && (
              <div className={css.editorSearchHint} data-dsh-grep-summary="true">
                {t(grep.truncated ? 'editorSearchSummaryTruncated' : 'editorSearchSummary', {
                  files: grep.files.length,
                  matches: grep.matchesTotal,
                })}
              </div>
            )}
            {grepError === null && grep !== null && grep.files.map((file) => {
              const open = !collapsedFiles.has(file.path)
              const status: GitFileStatus | undefined = statusOf(file.path)
              return (
                <div className={css.grepFileGroup} key={file.path} data-dsh-grep-file={file.path}>
                  <button
                    type="button"
                    className={css.grepFileRow}
                    title={file.path}
                    aria-expanded={open}
                    aria-label={open ? t('jsonCollapseNode') : t('jsonExpandNode')}
                    data-git-tone={status?.tone}
                    onClick={() => { toggleResultFile(file.path) }}
                  >
                    {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
                    <span
                      className={clsx(css.grepFileName, status !== undefined && css.explorerGitName)}
                      data-git-tone={status?.tone}
                    >{file.path}</span>
                    <span className={css.grepFileCount}>{file.matches.length}</span>
                    {status !== undefined && (
                      <StatusBadge tone={badgeToneOf(status.tone)} title={gitToneLabel(status.tone)}>{status.letter}</StatusBadge>
                    )}
                  </button>
                  {open && file.matches.map((match) => (
                    <button
                      key={`${file.path}:${match.line}`}
                      type="button"
                      className={css.grepMatchRow}
                      title={`${file.path}:${match.line}`}
                      data-dsh-grep-line={match.line}
                      onClick={() => { openContentHit(file.path, match.line) }}
                    >
                      <span className={css.grepLineNo}>{match.line}</span>
                      <span className={css.grepSnippet}>{snippetNodes(match)}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </>
        )}
      </div>
      {/* The tree stays MOUNTED while searching: its level cache and the
          directory watcher survive a query, so clearing the box is free. */}
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
        refreshTick={refreshTick}
        onUploadRequest={startUpload}
        busy={busy}
        hidden={searching}
        visible={visible !== false}
        sort={sort}
        service={service}
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
      {/* Destructive and not undoable by the plugin: confirm once with the
          counts the reader is looking at. */}
      <ConfirmDialog
        open={replaceAsk}
        title={t('editorSearchReplaceConfirmTitle')}
        description={t('editorSearchReplaceConfirmDesc', {
          files: grep?.files.length ?? 0,
          matches: grep?.matchesTotal ?? 0,
        })}
        confirmLabel={t('searchReplaceAll')}
        cancelLabel={t('cancel')}
        danger
        busy={replaceBusy}
        onConfirm={() => {
          setReplaceAsk(false)
          runReplace()
        }}
        onClose={() => { setReplaceAsk(false) }}
      />
    </div>
  )
}