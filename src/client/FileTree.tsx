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
 * opens a context menu: file rows offer the caller's open escapes
 * (new tab / to the side, only when the callbacks exist) and a download
 * action (the host serves raw bytes, binary-safe); every row can copy the
 * relative or absolute path (with a brief "copied" label replacing the
 * button after a successful write).
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconFolderClose16, IconFolderOpen16,
  IconLinkOutline16, IconPlusOutline16, IconTrashOutline16, Input, Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
import {
  deleteEditorBuffersUnder, editorBufferKey, listEditorBuffersUnder, moveEditorBuffers, subscribeEditorBuffers,
} from './editor-buffers.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

type EntryDialog =
  | { kind: 'create-file' | 'create-folder'; dir: string; value: string; error?: string }
  | { kind: 'rename' | 'move'; path: string; isDir: boolean; value: string; error?: string }
  | { kind: 'delete'; path: string; isDir: boolean; dirtyCount: number; error?: string }

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (at <= 0) return trimmed.slice(0, Math.max(at, 1))
  if (at === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3)
  return trimmed.slice(0, at)
}

export function joinClientPath(dir: string, name: string): string {
  const separator = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${separator}${name.replace(/^[\\/]+/, '')}`
}

function resolveMoveTarget(cwd: string, value: string): string {
  const trimmed = value.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\')) return trimmed
  return joinClientPath(cwd, trimmed)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

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
  /** Ask TreePanel's hidden picker to upload into a directory. */
  onUploadRequest?: (dir: string, kind: 'files' | 'folder') => void
  /** Upload a native drop into a directory. */
  onDropFiles?: (dir: string, data: DataTransfer) => void
  /** Refresh and reconcile open editor tabs after a mutation. */
  onMutated?: () => void
  onPathMoved?: (from: string, to: string, isDir: boolean) => void
  onPathDeleted?: (path: string, isDir: boolean) => void
}) {
  const {
    sessionId, cwd, expanded, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide,
    onReferenceFile, refreshTick, onUploadRequest, onDropFiles, onMutated, onPathMoved, onPathDeleted,
  } = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<EntryDialog | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragEntry, setDragEntry] = useState<{ path: string; isDir: boolean } | null>(null)
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set())

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

  useEffect(() => {
    let active = true
    let revision = 0
    let timer: number | undefined
    const refreshDirty = (): void => {
      const current = ++revision
      if (cwd === undefined) {
        setDirtyKeys(new Set())
        return
      }
      void listEditorBuffersUnder(sessionId, cwd).then((records) => {
        if (!active || current !== revision) return
        setDirtyKeys(new Set(records.map(record => record.key)))
      })
    }
    const scheduleRefresh = (): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(refreshDirty, 60)
    }
    const unsubscribe = subscribeEditorBuffers(scheduleRefresh)
    refreshDirty()
    return () => {
      active = false
      revision++
      unsubscribe()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sessionId, cwd])

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

  const scope = { sessionId, cwd }

  const operationFailed = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    if (dialog === null) setOperationError(message)
    else setDialog(current => current === null ? null : { ...current, error: message })
  }

  const movePath = async (from: string, to: string, isDir: boolean): Promise<void> => {
    setOperationError(null)
    setBusy(true)
    try {
      await api.fsMove(scope, from, to)
      await moveEditorBuffers(sessionId, from, to)
      onPathMoved?.(from, to, isDir)
      onMutated?.()
      setDialog(null)
    } catch (error) {
      operationFailed(error)
    } finally {
      setBusy(false)
    }
  }

  const submitDialog = async (): Promise<void> => {
    const current = dialog
    if (current === null || cwd === undefined || busy) return
    setBusy(true)
    try {
      if (current.kind === 'create-file' || current.kind === 'create-folder') {
        const value = current.value.trim()
        if (value === '') throw new Error(t('entryNamePlaceholder'))
        const target = joinClientPath(current.dir, value)
        if (current.kind === 'create-file') {
          await api.fsCreateFile(scope, target)
          onOpenFile(target)
        } else {
          await api.fsCreateDirectory(scope, target)
        }
        onMutated?.()
        setDialog(null)
        return
      }
      if (current.kind === 'rename' || current.kind === 'move') {
        const value = current.value.trim()
        if (value === '') throw new Error(current.kind === 'rename' ? t('entryNamePlaceholder') : t('moveDestinationPlaceholder'))
        const target = current.kind === 'rename'
          ? joinClientPath(parentPath(current.path), value)
          : resolveMoveTarget(cwd, value)
        setBusy(false)
        await movePath(current.path, target, current.isDir)
        return
      }
      if (current.kind === 'delete') {
        await api.fsDelete(scope, current.path)
        await deleteEditorBuffersUnder(sessionId, current.path)
        onPathDeleted?.(current.path, current.isDir)
        onMutated?.()
        setDialog(null)
      }
    } catch (error) {
      operationFailed(error)
    } finally {
      setBusy(false)
    }
  }

  const beginDelete = (path: string, isDir: boolean): void => {
    setDialog({ kind: 'delete', path, isDir, dirtyCount: 0 })
    void listEditorBuffersUnder(sessionId, path).then((records) => {
      setDialog(current => current?.kind === 'delete' && current.path === path
        ? { ...current, dirtyCount: records.length }
        : current)
    })
  }

  const beginDrag = (event: DragEvent, path: string, isDir: boolean): void => {
    const entry = { path, isDir }
    setDragEntry(entry)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-dsh-entry', JSON.stringify(entry))
    event.dataTransfer.setData('text/plain', path)
  }

  const handleDrop = (event: DragEvent, dir: string): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer.files.length > 0 || Array.from(event.dataTransfer.items).some(item => item.kind === 'file')) {
      onDropFiles?.(dir, event.dataTransfer)
      return
    }
    let dragged = dragEntry
    const encoded = event.dataTransfer.getData('application/x-dsh-entry')
    if (encoded !== '') {
      try {
        const parsed = JSON.parse(encoded) as { path?: unknown; isDir?: unknown }
        if (typeof parsed.path === 'string' && typeof parsed.isDir === 'boolean') dragged = { path: parsed.path, isDir: parsed.isDir }
      } catch {
        // Ignore malformed external drag data; the in-memory drag state remains.
      }
    }
    if (dragged === null) return
    const target = joinClientPath(dir, baseName(dragged.path))
    if (target === dragged.path) return
    void movePath(dragged.path, target, dragged.isDir)
    setDragEntry(null)
  }

  const root = cwd

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
      const dirty = !entry.isDir && dirtyKeys.has(editorBufferKey(sessionId, entry.path))
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
              className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: depth * 22 + 6 }}
              title={entry.path}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
              draggable
              onDragStart={(event) => { beginDrag(event, entry.path, true) }}
              onDragEnd={() => { setDragEntry(null) }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.files.length > 0 ? 'copy' : 'move' }}
              onDrop={(event) => { handleDrop(event, entry.path) }}
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
          draggable
          onDragStart={(event) => { beginDrag(event, entry.path, false) }}
          onDragEnd={() => { setDragEntry(null) }}
        >
          <IconCodeOutline16 size={14} />
          <span className={css.explorerName}>{entry.name}</span>
          {dirty && <span className={css.dirtyDot} data-editor-dirty title={t('unsaved')} aria-label={t('unsaved')} />}
          {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
          {rowActions(entry)}
        </div>
      )
    })
  }

  return (
    <div className={css.explorerBody}>
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          <div
            className={css.explorerRow}
            style={{ paddingLeft: 6 }}
            onContextMenu={(event) => { openRowMenu(event, root, true) }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.files.length > 0 ? 'copy' : 'move' }}
            onDrop={(event) => { handleDrop(event, root) }}
          >
            <IconFolderOpen16 size={14} />
            <span className={css.explorerName}>{baseName(root)}</span>
            <span className={css.explorerQuickActions}>
              <button
                type="button"
                aria-label={t('newFile')}
                title={t('newFile')}
                onClick={(event) => { event.stopPropagation(); setDialog({ kind: 'create-file', dir: root, value: '' }) }}
              >
                <IconPlusOutline16 size={13} />
              </button>
              <button
                type="button"
                aria-label={t('newFolder')}
                title={t('newFolder')}
                onClick={(event) => { event.stopPropagation(); setDialog({ kind: 'create-folder', dir: root, value: '' }) }}
              >
                <IconFolderClose16 size={13} />
              </button>
            </span>
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
      {operationError !== null && (
        <div className={clsx(css.explorerRow, css.explorerError)}>
          {t('fileOperationFailed')}: {operationError}
        </div>
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // The open escapes head the FILE menu (dirs only get copy).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <IconFolderOpen16 size={14} /> }]
            : []),
          // Directory creation/upload actions apply to the right-clicked folder.
          ...(rowMenu?.isDir === true ? [
            { id: 'create-file', label: t('newFile'), icon: <IconPlusOutline16 size={14} /> },
            { id: 'create-folder', label: t('newFolder'), icon: <IconFolderClose16 size={14} /> },
            { id: 'upload-files', label: t('uploadFiles'), icon: <IconDownloadOutline16 size={14} /> },
            { id: 'upload-folder', label: t('uploadFolder'), icon: <IconFolderOpen16 size={14} /> },
          ] : []),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> }]
            : []),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
          ...(rowMenu !== null && rowMenu.path !== root ? [
            { id: 'rename', label: t('renameEntry'), icon: <IconCodeOutline16 size={14} /> },
            { id: 'move', label: t('moveEntry'), icon: <IconFolderOpen16 size={14} /> },
            { id: 'delete', label: t('deleteEntry'), icon: <IconTrashOutline16 size={14} />, danger: true },
          ] : []),
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'open-new-tab') {
            onOpenFileNewTab?.(target.path)
            return
          }
          if (id === 'open-side') {
            onOpenFileSide?.(target.path)
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'create-file' || id === 'create-folder') {
            setDialog({ kind: id, dir: target.path, value: '' })
            return
          }
          if (id === 'upload-files' || id === 'upload-folder') {
            onUploadRequest?.(target.path, id === 'upload-files' ? 'files' : 'folder')
            return
          }
          if (id === 'rename') {
            setDialog({ kind: 'rename', path: target.path, isDir: target.isDir, value: baseName(target.path) })
            return
          }
          if (id === 'move') {
            setDialog({ kind: 'move', path: target.path, isDir: target.isDir, value: relativeTo(cwd ?? '', target.path) })
            return
          }
          if (id === 'delete') {
            beginDelete(target.path, target.isDir)
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
      <Modal
        open={dialog !== null}
        onClose={() => { if (!busy) setDialog(null) }}
        title={dialog?.kind === 'create-file' ? t('newFile')
          : dialog?.kind === 'create-folder' ? t('newFolder')
            : dialog?.kind === 'rename' ? t('renameEntry')
              : dialog?.kind === 'move' ? t('moveEntry') : t('deleteEntryTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => { setDialog(null) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => { void submitDialog() }}>
              {dialog?.kind === 'delete' ? t('deleteEntry') : dialog?.kind === 'rename' || dialog?.kind === 'move' ? t('save') : t('create')}
            </Button>
          </>
        )}
      >
        {dialog !== null && dialog.kind !== 'delete' && (
          <Input
            autoFocus
            value={dialog.value}
            disabled={busy}
            placeholder={dialog.kind === 'move' ? t('moveDestinationPlaceholder') : t('entryNamePlaceholder')}
            onChange={(event) => { setDialog({ ...dialog, value: event.target.value, error: undefined }) }}
            onKeyDown={(event) => { if (event.key === 'Enter') void submitDialog() }}
          />
        )}
        {dialog?.kind === 'delete' && (
          <div className={css.fileDialogText}>
            <p>{t('deleteEntryDesc', { path: dialog.path })}</p>
            {dialog.dirtyCount > 0 && <p>{t('deleteEntryDirtyDesc', { count: dialog.dirtyCount })}</p>}
          </div>
        )}
        {dialog?.error !== undefined && <div className={css.editorError}>{t('fileOperationFailed')}: {dialog.error}</div>}
      </Modal>
    </div>
  )
}
