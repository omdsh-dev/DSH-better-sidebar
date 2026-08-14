/**
 * The file explorer: a lazy VSCode-style tree rooted at the session's
 * working directory. Levels load on expansion (one API call per directory),
 * directories sort first, hidden entries render dimmed, and the expansion
 * set lives in the per-session state. Clicking a file opens an editor tab.
 *
 * The header root label is editable: clicking it opens a path input
 * pre-filled with the root; submitting a directory roots the tree at it,
 * submitting a file roots at its parent directory (the host resolves both
 * through fs.resolve, relative inputs join the current root). The override
 * lives in the per-session state, so each conversation keeps its own root.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu to copy the relative or absolute path (with a brief
 * "copied" label replacing the button after a successful write); file rows
 * also offer a download action (the host serves raw bytes, binary-safe).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline16, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
import { setExplorerRoot, type SidebarStore } from './state.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Root label: the last path segment (mirror of the host rootLabel). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

export function ExplorerView(props: {
  sessionId: string
  cwd: string | undefined
  store: SidebarStore
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
}) {
  const { sessionId, cwd, store, expanded, onToggle, onOpenFile, onReferenceFile } = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [refreshTick, setRefreshTick] = useState(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)

  // The explorer root: the per-session override wins, else the session cwd.
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const root = snapshot.state?.explorerRoot ?? cwd

  // Root editing state: the header label turns into an input pre-filled with
  // the full root path (Enter resolves, Escape/blur cancels).
  const [editingRoot, setEditingRoot] = useState(false)
  const [rootDraft, setRootDraft] = useState('')
  const [resolvingRoot, setResolvingRoot] = useState(false)
  /** The last resolve failure (kept visible until the next edit/submit). */
  const [rootError, setRootError] = useState<string | null>(null)

  const applyRoot = useCallback((path: string): void => {
    store.reduce(state => setExplorerRoot(state, path))
  }, [store])

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

  // The root of the previous load: switching roots (the override or the
  // session cwd) wipes the level cache, so re-entering a directory refetches
  // fresh rows instead of replaying stale ones.
  const lastRootRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only a root switch or the refresh button wipes it.
    if (root === undefined) return
    if (lastRootRef.current !== root) {
      lastRootRef.current = root
      dataRef.current = {}
      setData({})
    }
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [root, expanded, refreshTick, loadDir])

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

  /** Enter edit mode: the input opens pre-filled with the full root path. */
  const beginRootEdit = (): void => {
    if (root === undefined) return
    setRootDraft(root)
    setRootError(null)
    setEditingRoot(true)
  }

  /** Leave edit mode without changing the root (Escape / blur). */
  const cancelRootEdit = (): void => {
    setEditingRoot(false)
    setResolvingRoot(false)
  }

  /** Resolve the draft against the host: a directory roots at itself, a file
   *  at its parent directory. On success the override replaces the root; on
   *  failure the input stays open with the error shown below the header. */
  const submitRoot = (): void => {
    if (root === undefined || resolvingRoot) return
    const text = rootDraft.trim()
    if (text === '') {
      cancelRootEdit()
      return
    }
    setResolvingRoot(true)
    api.fsResolve({ sessionId, cwd }, text, root).then((result) => {
      setResolvingRoot(false)
      setEditingRoot(false)
      setRootError(null)
      // A same-root submit never collapses the tree (the reducer no-ops).
      if (result.root !== root) applyRoot(result.root)
    }).catch((error: unknown) => {
      setResolvingRoot(false)
      setRootError(error instanceof Error ? error.message : String(error))
    })
  }

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

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
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
          className={clsx(css.explorerRow, entry.hidden && css.explorerHidden)}
          style={{ paddingLeft: depth * 22 + 6 }}
          title={entry.path}
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
          {rowActions(entry)}
        </div>
      )
    })
  }

  return (
    <div className={css.explorer}>
      <div className={css.explorerHeader}>
        {root === undefined ? (
          <span className={css.explorerRoot}>{t('noSession')}</span>
        ) : editingRoot ? (
          /* Readonly while a resolve is in flight: disabling a focused input
             fires blur (the HTML focus-fixup rule), which would cancel the
             edit in a real browser before the error can keep it open. */
          <input
            className={css.explorerRootInput}
            value={rootDraft}
            readOnly={resolvingRoot}
            aria-busy={resolvingRoot || undefined}
            aria-label={t('explorerRootEditLabel')}
            autoFocus
            onFocus={(event) => { event.currentTarget.select() }}
            onChange={(event) => { setRootDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitRoot()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRootEdit()
              }
            }}
            onBlur={() => { if (!resolvingRoot) cancelRootEdit() }}
          />
        ) : (
          <button
            type="button"
            className={css.explorerRootButton}
            title={`${root}\n${t('explorerRootEditHint')}`}
            aria-label={t('explorerRootEditLabel')}
            onClick={beginRootEdit}
          >
            {baseName(root)}
          </button>
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => {
            dataRef.current = {}
            setData({})
            setRefreshTick(tick => tick + 1)
          }}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      {rootError !== null && (
        <div className={css.explorerRootError} role="alert">{rootError}</div>
      )}
      <div className={css.explorerBody}>
        {root === undefined ? (
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
      </div>
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the explorer's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> }]
            : []),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
    </div>
  )
}
