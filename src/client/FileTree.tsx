/**
 * The controlled file tree behind the files window's tree panel (TreePanel
 * wraps it with the search box): a lazy VSCode-style tree rooted at the
 * session's working directory. Levels load on expansion (one API call per
 * directory), directories sort first, hidden entries render dimmed. The
 * expansion set lives in the per-session state (owned by the caller); the
 * caller also owns the refresh affordance — a `refreshTick` bump wipes the
 * level cache so the visible set reloads.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu. Beyond the caller's open escapes (new tab / to the
 * side), download and copy path, the menu drives the explorer file
 * operations — new folder / new file (inline toolbar rows), rename (inline
 * toolbar row), delete (a confirmation modal that moves the entry to the
 * system Trash), reveal in the file manager, and a scoped recursive search
 * (by file name and file content). Create/rename/delete keep the level
 * cache, the expanded set (via `store`) and open editor tabs (via `ctx`)
 * in sync afterwards.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconEditOutline16,
  IconFolderClose16, IconFolderOpen16, IconFolderOpenOutline16, IconLinkOutline16,
  IconPlusOutline16, IconProjectAddOutline16, IconSearchOutline16, IconTrashOutline16,
  Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, downloadUrl, type FsEntry, type SearchResult } from './api.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import { allLeaves, type SidebarStore } from './state.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** The parent directory of a path ('' only for a filesystem root). */
function parentPathOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at <= 0 ? trimmed : trimmed.slice(0, at)
}

/** Join a name onto a directory path, keeping the dir's own separator style. */
function joinEntryPath(dir: string, name: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + (dir.includes('\\') ? '\\' : '/') + name
}

/** Whether `target` equals `base` or lies under it (separator-normalized). */
function pathUnder(base: string, target: string): boolean {
  const b = base.replace(/\\/g, '/').replace(/\/+$/, '')
  const tgt = target.replace(/\\/g, '/').replace(/\/+$/, '')
  return tgt === b || tgt.startsWith(`${b}/`)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** The inline create toolbar row state. */
interface CreateState { mode: 'dir' | 'file'; target: string; name: string; busy: boolean; error: string | null }
/** The inline rename toolbar row state. */
interface RenameState { path: string; isDir: boolean; name: string; busy: boolean; error: string | null }
/** The delete confirmation state. */
interface DeleteState { path: string; isDir: boolean; busy: boolean; error: string | null }
/** One recursive-search lifecycle state. */
type SearchState =
  | { status: 'searching' }
  | { status: 'ready'; results: SearchResult[]; truncated: boolean }
  | { status: 'error'; error: string }

/** Error text of an unknown thrown value. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function FileTree(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** The sidebar service context (editor-tab sync on rename/delete). */
  ctx: Context
  /** The sidebar state store (expanded-set sync on rename/delete). */
  store: SidebarStore
}) {
  const {
    sessionId, cwd, expanded, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide,
    onReferenceFile, refreshTick, ctx, store,
  } = props
  const scope = { sessionId, cwd }
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (dir? / blank?) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; blank: boolean; x: number; y: number } | null>(null)
  /** Inline create row (null = hidden). */
  const [create, setCreate] = useState<CreateState | null>(null)
  /** Inline rename row (null = hidden). */
  const [rename, setRename] = useState<RenameState | null>(null)
  /** Delete confirmation (null = hidden). */
  const [confirmDelete, setConfirmDelete] = useState<DeleteState | null>(null)
  /** Scoped recursive search mode. */
  const [searchMode, setSearchMode] = useState(false)
  const [searchRoot, setSearchRoot] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchState, setSearchState] = useState<SearchState | null>(null)
  /** Transient notice (delete/rename outcomes). */
  const [notice, setNotice] = useState<string | null>(null)
  const searchTimer = useRef<number | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const mounted = useRef(true)

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  // The caller's refresh tick wipes the cache (declared BEFORE the load
  // effect so the reload below sees the empty cache).
  const lastTick = useRef(refreshTick)
  useEffect(() => {
    if (lastTick.current === refreshTick) return
    lastTick.current = refreshTick
    dataRef.current = {}
    setData({})
  }, [refreshTick])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh tick wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  /** Drop a path (and its whole cached subtree) from the level cache. */
  const dropSubtree = useCallback((path: string): void => {
    const next: Record<string, LevelData> = {}
    for (const [key, level] of Object.entries(dataRef.current)) {
      if (key !== path && !pathUnder(path, key)) next[key] = level
    }
    dataRef.current = next
    setData(next)
  }, [])

  /** Drop a path's cache and refetch it (post-create/rename/delete refresh). */
  const reloadDir = useCallback((dir: string): void => {
    dropSubtree(dir)
    loadDir(dir)
  }, [dropSubtree, loadDir])

  /** Ensure a directory is in the expanded set (parent reveal after ops). */
  const expandDir = useCallback((dir: string): void => {
    store.reduce((state) => state.expanded.includes(dir)
      ? state
      : { ...state, expanded: [...state.expanded, dir] })
  }, [store])

  // Reset the transient UI on a session/cwd switch.
  useEffect(() => {
    setRowMenu(null)
    setCreate(null)
    setRename(null)
    setConfirmDelete(null)
    setSearchMode(false)
    setSearchRoot(null)
    setSearchQuery('')
    setSearchState(null)
    setNotice(null)
  }, [sessionId, cwd])

  useEffect(() => () => {
    mounted.current = false
    if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
  }, [])

  const showNotice = useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null
      setNotice(null)
    }, 4000)
  }, [])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** The row's trailing actions: the @-reference button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (copiedPath === entry.path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return (
      <button
        type="button"
        className={css.explorerRef}
        aria-label={t('referenceFile')}
        title={t('referenceFile')}
        onClick={(event) => {
          event.stopPropagation()
          onReferenceFile(entry.path)
        }}
      >
        {t('referenceFile')}
      </button>
    )
  }

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean, blank = false): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, isDir, blank, x: event.clientX, y: event.clientY })
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  // ── Editor-tab sync (rename / delete follow open tabs) ──────────────────

  /** Rewrite every open editor tab whose path lives under `oldPath`. */
  const syncEditorTabs = (oldPath: string, rewrite: (path: string) => string | null): void => {
    const snapshot = ctx.betterSidebar?.getSnapshot()
    const state = snapshot?.state
    if (state === undefined) return
    const tabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(leaf => leaf.tabs)
    for (const tab of tabs) {
      if (tab.type !== 'editor' || tab.path === undefined) continue
      const next = pathUnder(oldPath, tab.path) ? rewrite(tab.path) : null
      if (next === null) continue
      ctx.betterSidebar?.updateTab(tab.id, { path: next, title: baseName(next) })
    }
  }

  const closeEditorTabsUnder = (path: string): void => {
    const snapshot = ctx.betterSidebar?.getSnapshot()
    const state = snapshot?.state
    if (state === undefined) return
    const tabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(leaf => leaf.tabs)
    for (const tab of tabs) {
      if (tab.type !== 'editor' || tab.path === undefined) continue
      if (pathUnder(path, tab.path)) ctx.betterSidebar?.closeTab(tab.id)
    }
  }

  // ── Context-menu actions ───────────────────────────────────────────────

  const actCreate = (mode: 'dir' | 'file', target: string): void => {
    setRename(null)
    setCreate({ mode, target, name: '', busy: false, error: null })
  }

  const actRename = (path: string, isDir: boolean): void => {
    setCreate(null)
    setRename({ path, isDir, name: baseName(path), busy: false, error: null })
  }

  const actSearch = (root: string | null): void => {
    setCreate(null)
    setRename(null)
    setSearchMode(true)
    setSearchRoot(root)
    setSearchQuery('')
    setSearchState(null)
  }

  const actDelete = (path: string, isDir: boolean): void => {
    setConfirmDelete({ path, isDir, busy: false, error: null })
  }

  const actReveal = (path: string): void => {
    api.fsReveal(scope, path).catch((error: unknown) => {
      showNotice(`${t('revealFailed')}: ${errMsg(error)}`)
    })
  }

  // ── Create / rename / delete ───────────────────────────────────────────

  const validateName = (name: string): string | null => {
    if (name === '') return t('nameRequired')
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return t('invalidEntryName')
    return null
  }

  const confirmCreate = (): void => {
    const current = create
    if (current === null || current.busy) return
    const name = current.name.trim()
    const invalid = validateName(name)
    if (invalid !== null) {
      setCreate({ ...current, error: invalid })
      return
    }
    const targetDir = current.target || cwd
    if (!targetDir) return
    const targetPath = joinEntryPath(targetDir, name)
    setCreate({ ...current, busy: true, error: null })
    const promise = current.mode === 'dir'
      ? api.fsMkdir(scope, targetPath)
      : api.fsWrite(scope, targetPath, '')
    promise.then(() => {
      setCreate(null)
      reloadDir(targetDir)
      expandDir(targetDir)
      if (current.mode === 'file') onOpenFile(targetPath)
    }).catch((error: unknown) => {
      setCreate(currentState => currentState === null
        ? currentState
        : { ...currentState, busy: false, error: `${t('createFailed')}: ${errMsg(error)}` })
    })
  }

  const confirmRename = (): void => {
    const current = rename
    if (current === null || current.busy) return
    const name = current.name.trim()
    const invalid = validateName(name)
    if (invalid !== null) {
      setRename({ ...current, error: invalid })
      return
    }
    if (name === baseName(current.path)) {
      setRename(null)
      return
    }
    setRename({ ...current, busy: true, error: null })
    api.fsRename(scope, current.path, name).then(({ dest }) => {
      const oldPath = current.path
      setRename(null)
      dropSubtree(oldPath)
      const parent = parentPathOf(oldPath)
      reloadDir(parent)
      expandDir(parent)
      // The expanded set follows the rename (the dir and every open subtree).
      store.reduce((state) => ({
        ...state,
        expanded: state.expanded.map(path => {
          if (path === oldPath) return dest
          if (pathUnder(oldPath, path)) return dest + path.slice(oldPath.length)
          return path
        }),
      }))
      // Open editor tabs follow too (the file itself or files under a dir).
      syncEditorTabs(oldPath, (path) => path === oldPath
        ? dest
        : dest + path.slice(oldPath.length))
      showNotice(t('renamedNotice', { name }))
    }).catch((error: unknown) => {
      setRename(currentState => currentState === null
        ? currentState
        : { ...currentState, busy: false, error: `${t('renameFailed')}: ${errMsg(error)}` })
    })
  }

  const confirmDeleteNow = (): void => {
    const current = confirmDelete
    if (current === null || current.busy) return
    setConfirmDelete({ ...current, busy: true, error: null })
    api.fsRemove(scope, current.path).then((value) => {
      const path = current.path
      setConfirmDelete(null)
      dropSubtree(path)
      const parent = parentPathOf(path)
      reloadDir(parent)
      expandDir(parent)
      store.reduce((state) => ({
        ...state,
        expanded: state.expanded.filter(expandedPath => !pathUnder(path, expandedPath)),
      }))
      closeEditorTabsUnder(path)
      showNotice(value.trashed
        ? t('trashedNotice', { name: baseName(path) })
        : t('permanentDeleteNotice', { name: baseName(path) }))
    }).catch((error: unknown) => {
      setConfirmDelete(currentState => currentState === null
        ? currentState
        : { ...currentState, busy: false, error: `${t('deleteFailed')}: ${errMsg(error)}` })
    })
  }

  // ── Scoped recursive search (debounced) ────────────────────────────────

  useEffect(() => {
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    if (!searchMode) {
      setSearchState(null)
      return
    }
    const query = searchQuery.trim()
    const root = searchRoot ?? cwd
    if (query === '') {
      setSearchState(null)
      return
    }
    if (root === undefined) {
      setSearchState({ status: 'error', error: t('noSession') })
      return
    }
    setSearchState({ status: 'searching' })
    const controller = new AbortController()
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null
      api.fsSearchDir(scope, root, query, controller.signal).then((outcome) => {
        if (!mounted.current) return
        setSearchState({ status: 'ready', results: outcome.results, truncated: outcome.truncated })
      }).catch((error: unknown) => {
        if (!mounted.current) return
        if (controller.signal.aborted) return
        setSearchState({ status: 'error', error: errMsg(error) })
      })
    }, 300)
    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMode, searchQuery, searchRoot, cwd, sessionId])

  // ── Context menu ───────────────────────────────────────────────────────

  const onMenuSelect = (id: string): void => {
    const target = rowMenu
    if (target === null) return
    setRowMenu(null)
    switch (id) {
      case 'open-new-tab': onOpenFileNewTab?.(target.path); break
      case 'open-side': onOpenFileSide?.(target.path); break
      case 'download': downloadFile(target.path); break
      case 'relative': copyPath(relativeTo(cwd ?? '', target.path), target.path); break
      case 'absolute': copyPath(target.path, target.path); break
      case 'toggle': onToggle(target.path); break
      case 'rename': actRename(target.path, target.isDir); break
      case 'new-dir': actCreate('dir', target.isDir ? target.path : cwd ?? ''); break
      case 'new-file': actCreate('file', target.isDir ? target.path : cwd ?? ''); break
      case 'search': actSearch(target.isDir ? target.path : null); break
      case 'delete': actDelete(target.path, target.isDir); break
      case 'reveal': actReveal(target.path); break
    }
  }

  const menuItems = buildMenuItems(rowMenu, expanded, cwd, {
    hasOpenNewTab: onOpenFileNewTab !== undefined,
    hasOpenSide: onOpenFileSide !== undefined,
  })

  const root = cwd

  // ── Inline toolbar rows (create / rename) ──────────────────────────────

  const renderToolbarRow = (
    label: string,
    placeholder: string,
    value: string,
    busy: boolean,
    error: string | null,
    onChange: (value: string) => void,
    onConfirm: () => void,
    onCancel: () => void,
    confirmLabel: string,
    busyLabel: string,
  ): ReactNode => (
    <div
      className={css.explorerToolbar}
      onClick={(event) => { event.stopPropagation() }}
      onContextMenu={(event) => { event.stopPropagation() }}
    >
      <span className={css.explorerToolbarTarget} title={label}>{label}</span>
      <input
        className={css.explorerInlineInput}
        type="text"
        autoFocus
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => { onChange(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onConfirm()
          else if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }}
      />
      <button type="button" className={css.explorerToolbarBtn} disabled={busy} onClick={onConfirm}>
        {busy ? busyLabel : confirmLabel}
      </button>
      <button type="button" className={css.explorerToolbarBtn} disabled={busy} onClick={onCancel}>
        {t('cancel')}
      </button>
      {error !== null && <span className={css.explorerToolbarError} title={error}>{error}</span>}
    </div>
  )

  const renderRenameRow = (): ReactNode => {
    if (rename === null) return null
    return renderToolbarRow(
      rename.isDir ? t('renameDirLabel') : t('renameFileLabel'),
      baseName(rename.path),
      rename.name,
      rename.busy,
      rename.error,
      (value) => { setRename({ ...rename, name: value, error: null }) },
      confirmRename,
      () => { setRename(null) },
      t('confirmAction'),
      t('renamingEntry'),
    )
  }

  const renderCreateRow = (): ReactNode => {
    if (create === null) return null
    const targetLabel = create.target === root ? baseName(root ?? '') : baseName(create.target)
    return renderToolbarRow(
      t('createIn', { dir: targetLabel }),
      create.mode === 'dir' ? t('newDirPlaceholder') : t('newFilePlaceholder'),
      create.name,
      create.busy,
      create.error,
      (value) => { setCreate({ ...create, name: value, error: null }) },
      confirmCreate,
      () => { setCreate(null) },
      t('confirmAction'),
      t('creatingEntry'),
    )
  }

  // ── Scoped search view (replaces the tree while active) ─────────────────

  const renderSearch = (): ReactNode => {
    const rootLabel = searchRoot ?? root
    const scoped = rootLabel !== root && rootLabel !== undefined
    return (
      <>
        <div
          className={css.explorerSearchBar}
          onClick={(event) => { event.stopPropagation() }}
          onContextMenu={(event) => { event.stopPropagation() }}
        >
          <span className={css.explorerSearchIcon}><IconSearchOutline16 size={14} /></span>
          {scoped && rootLabel !== undefined && (
            <span className={css.explorerToolbarTarget} title={rootLabel}>
              {t('searchScoped', { dir: baseName(rootLabel) })}
            </span>
          )}
          <input
            className={css.explorerSearchInput}
            type="text"
            autoFocus
            value={searchQuery}
            spellCheck={false}
            placeholder={t('searchPlaceholder')}
            onChange={(event) => { setSearchQuery(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setSearchMode(false)
                setSearchQuery('')
              }
            }}
          />
          <button
            type="button"
            className={css.explorerSearchClose}
            title={t('closeSearch')}
            onClick={() => { setSearchMode(false); setSearchQuery('') }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        {searchQuery.trim() === '' ? (
          <div className={css.explorerSearchNote}>{t('searchNoQuery')}</div>
        ) : searchState === null || searchState.status === 'searching' ? (
          <div className={css.explorerSearchNote}>{t('searching')}</div>
        ) : searchState.status === 'error' ? (
          <div className={css.explorerSearchNote}>
            {t('searchFailed')}: {searchState.error}
          </div>
        ) : searchState.results.length === 0 ? (
          <div className={css.explorerSearchNote}>{t('searchEmpty')}</div>
        ) : (
          <>
            {searchState.results.map(result => (
              <div
                key={result.path}
                role="button"
                tabIndex={0}
                className={css.explorerSearchRow}
                title={result.path}
                onClick={(event) => {
                  event.stopPropagation()
                  setSearchMode(false)
                  setSearchQuery('')
                  if (result.type === 'file') onOpenFile(result.path)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSearchMode(false)
                    setSearchQuery('')
                    if (result.type === 'file') onOpenFile(result.path)
                  }
                }}
                onContextMenu={(event) => { openRowMenu(event, result.path, result.type === 'directory') }}
              >
                <div className={css.explorerSearchRowMain}>
                  {result.type === 'directory'
                    ? <IconFolderClose16 size={14} />
                    : <IconCodeOutline16 size={14} />}
                  <span className={css.explorerSearchName}>{result.name}</span>
                  {result.rel !== '' && <span className={css.explorerSearchRel}>{result.rel}</span>}
                </div>
                {result.matchLine !== null && <div className={css.explorerMatch}>{result.matchLine}</div>}
              </div>
            ))}
            {searchState.truncated && (
              <div className={css.explorerSearchNote}>{t('searchTruncated', { count: searchState.results.length })}</div>
            )}
          </>
        )}
      </>
    )
  }

  // ── Tree levels ────────────────────────────────────────────────────────

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level === undefined) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {level.error}
        </div>
      )
    }
    const entries = level.entries ?? []
    if (entries.length === 0) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {dir === root ? t('directoryEmptyHint') : t('emptyDirectory')}
        </div>
      )
    }
    return entries.map(entry => {
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
              className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: depth * 22 + 6 }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
            >
              {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
              <span className={css.explorerName}>{entry.name}</span>
              {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
              {rowActions(entry)}
            </div>
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          role="button"
          tabIndex={0}
          className={clsx(css.explorerRow, entry.hidden && css.explorerHidden, entry.broken && css.explorerBroken)}
          style={{ paddingLeft: depth * 22 + 6 }}
          title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
          onClick={() => { onOpenFile(entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenFile(entry.path)
            }
          }}
          onContextMenu={(event) => { openRowMenu(event, entry.path, false) }}
        >
          <IconCodeOutline16 size={14} />
          <span className={css.explorerName}>{entry.name}</span>
          {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
          {rowActions(entry)}
        </div>
      )
    })
  }

  return (
    <div
      className={css.explorerBody}
      onContextMenu={root === undefined ? undefined : (event) => { openRowMenu(event, root, true, true) }}
    >
      {notice !== null && <div className={css.explorerNotice}>{notice}</div>}
      {rename !== null && renderRenameRow()}
      {create !== null && renderCreateRow()}
      {searchMode ? (
        renderSearch()
      ) : root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          <div
            className={css.explorerRow}
            style={{ paddingLeft: 6 }}
            onContextMenu={(event) => { openRowMenu(event, root, true) }}
          >
            <IconFolderOpen16 size={14} />
            <span className={css.explorerName}>{baseName(root)}</span>
            {copiedPath === root
              ? <span className={css.explorerCopied}>{t('copied')}</span>
              : (
                <button
                  type="button"
                  className={css.explorerRef}
                  aria-label={t('referenceFile')}
                  title={t('referenceFile')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onReferenceFile(root)
                  }}
                >
                  {t('referenceFile')}
                </button>
              )}
          </div>
          {data[root] !== undefined && renderLevel(root, 1)}
        </>
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={menuItems}
        onSelect={onMenuSelect}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
      {/* Destructive delete lands here first: the confirmation modal. */}
      <Modal
        open={confirmDelete !== null}
        onClose={() => { if (confirmDelete !== null && !confirmDelete.busy) setConfirmDelete(null) }}
        title={confirmDelete !== null ? (confirmDelete.isDir ? t('deleteDirectory') : t('deleteFile')) : ''}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" disabled={confirmDelete?.busy} onClick={() => { setConfirmDelete(null) }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={confirmDelete?.busy} onClick={confirmDeleteNow}>
              {confirmDelete?.busy ? t('deletingEntry') : t('deleteEntry')}
            </Button>
          </>
        )}
      >
        <p className={css.gitConfirmDesc}>
          {t('deleteConfirmTitle', { name: confirmDelete !== null ? baseName(confirmDelete.path) : '' })}
        </p>
        <p className={css.gitConfirmDesc}>{t('deleteConfirmDesc')}</p>
        {confirmDelete !== null && <p className={css.explorerConfirmPath}>{confirmDelete.path}</p>}
        {confirmDelete !== null && confirmDelete.error !== null && (
          <p className={css.explorerToolbarError}>{confirmDelete.error}</p>
        )}
      </Modal>
    </div>
  )
}

/** The context-menu entries for the current row-menu state. */
function buildMenuItems(
  rowMenu: { path: string; isDir: boolean; blank: boolean } | null,
  expanded: string[],
  cwd: string | undefined,
  opts: { hasOpenNewTab: boolean; hasOpenSide: boolean },
): MenuEntry[] {
  if (rowMenu === null) return []
  const { path, isDir, blank } = rowMenu
  const rootRow = !blank && cwd !== undefined && path === cwd
  const icon = (node: ReactNode): ReactNode => node
  // Blank area / root row: create + scoped search (+ reveal on the root row).
  if (blank || rootRow) {
    const items: MenuEntry[] = [
      { id: 'new-dir', label: t('newDirectory'), icon: icon(<IconProjectAddOutline16 size={14} />) },
      { id: 'new-file', label: t('newFileEntry'), icon: icon(<IconPlusOutline16 size={14} />) },
      { id: 'search', label: t('searchInDirectory'), icon: icon(<IconSearchOutline16 size={14} />) },
    ]
    if (rootRow) {
      items.push({ type: 'separator', id: 'sep1' })
      items.push({ id: 'reveal', label: t('revealInFinder'), icon: icon(<IconFolderOpenOutline16 size={14} />) })
    }
    return items
  }
  // Directory row.
  if (isDir) {
    const isOpen = expanded.includes(path)
    return [
      {
        id: 'toggle',
        label: t(isOpen ? 'collapseDirectory' : 'expandDirectory'),
        icon: icon(isOpen ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />),
      },
      { id: 'rename', label: t('renameEntry'), icon: icon(<IconEditOutline16 size={14} />) },
      { id: 'new-dir', label: t('newDirectory'), icon: icon(<IconProjectAddOutline16 size={14} />) },
      { id: 'new-file', label: t('newFileEntry'), icon: icon(<IconPlusOutline16 size={14} />) },
      { id: 'search', label: t('searchInDirectory'), icon: icon(<IconSearchOutline16 size={14} />) },
      { type: 'separator', id: 'sep1' },
      { id: 'delete', label: t('deleteDirectory'), icon: icon(<IconTrashOutline16 size={14} />), danger: true },
      { id: 'reveal', label: t('revealInFinder'), icon: icon(<IconFolderOpenOutline16 size={14} />) },
    ]
  }
  // File row.
  const items: MenuEntry[] = []
  if (opts.hasOpenNewTab) items.push({ id: 'open-new-tab', label: t('openFileNewTab'), icon: icon(<IconCodeOutline16 size={14} />) })
  if (opts.hasOpenSide) items.push({ id: 'open-side', label: t('openFileSide'), icon: icon(<IconFolderOpen16 size={14} />) })
  if (items.length > 0) items.push({ type: 'separator', id: 'sep0' })
  items.push({ id: 'rename', label: t('renameEntry'), icon: icon(<IconEditOutline16 size={14} />) })
  items.push({ id: 'reveal', label: t('revealInFinder'), icon: icon(<IconFolderOpenOutline16 size={14} />) })
  items.push({ type: 'separator', id: 'sep1' })
  items.push({ id: 'delete', label: t('deleteEntry'), icon: icon(<IconTrashOutline16 size={14} />), danger: true })
  items.push({ type: 'separator', id: 'sep2' })
  items.push({ id: 'download', label: t('download'), icon: icon(<IconDownloadOutline16 size={14} />) })
  items.push({ id: 'relative', label: t('copyRelative'), icon: icon(<IconCopyOutline16 size={14} />) })
  items.push({ id: 'absolute', label: t('copyAbsolute'), icon: icon(<IconCopyOutline16 size={14} />) })
  return items
}
