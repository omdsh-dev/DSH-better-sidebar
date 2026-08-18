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
 * opens a context menu — the VSCode explorer basics:
 *   - directory rows: New file / New folder / Paste (when copied) / Reveal /
 *     Copy paths; the root row adds the same minus copy/rename/delete.
 *   - file + sub-directory rows: Copy / Rename / Delete (destructive) /
 *     Reveal / Download (files) / Copy paths.
 *
 * Drag & drop: file and folder rows are draggable; dropping onto a folder
 * moves the item INTO it, dropping onto a file moves it into that file's
 * parent, and dropping onto the tree's empty space (or the root row) moves
 * it to the session cwd. A folder cannot be dropped into its own subtree,
 * and the destination never overwrites an existing entry.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconEditOutline16, IconFolderClose16,
  IconFolderOpen16, IconFolderOpenOutline16, IconLinkOutline16, IconPlusOutline16, IconRightUpOutline16,
  IconTrashOutline16, Input, Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
import { parentOf, relativeTo } from './paths.ts'
import { resolveSidebarPath } from './produced-files.ts'
import type { ExpandedMutation } from './state.ts'
import { t } from './locales.ts'
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

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** The pending "new file / new folder" dialog. */
interface CreateState {
  /** The directory the new entry is created into. */
  dir: string
  kind: 'file' | 'folder'
  name: string
  error: string | null
  busy: boolean
}

/** The pending "rename" dialog. */
interface RenameState {
  path: string
  isDir: boolean
  name: string
  error: string | null
  busy: boolean
}

/** The pending "delete" confirmation. */
interface DeleteState {
  path: string
  isDir: boolean
  error: string | null
  busy: boolean
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
  /** Rewrite the explorer expansion set after a directory rename/delete. The
   *  shell owns the store; absent (standalone/test compositions) the mutation
   *  is a no-op and the tree simply refreshes. */
  onMutateExpanded?: (mutation: ExpandedMutation) => void
}) {
  const {
    sessionId, cwd, expanded, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile, refreshTick,
    onMutateExpanded,
  } = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  /** The pending create dialog (null = closed). */
  const [createState, setCreateState] = useState<CreateState | null>(null)
  /** The pending rename dialog (null = closed). */
  const [renameState, setRenameState] = useState<RenameState | null>(null)
  /** The pending delete confirmation (null = closed). */
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null)
  /** The internal "copy" clipboard (path of the copied file/folder). */
  const [clipboard, setClipboard] = useState<string | null>(null)
  /** The folder currently highlighted as a drag-and-drop move target. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** The item being dragged (path + whether it is a directory). */
  const dragRef = useRef<{ path: string; isDir: boolean } | null>(null)

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string, force = false) => {
    if (!force && dataRef.current[dir] !== undefined) return
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

  /** Reveal a path in the OS file manager (Finder / File Explorer / xdg-open). */
  const revealFile = (path: string): void => {
    void api.fsReveal({ sessionId, cwd }, path).catch((error: unknown) => {
      // Fire-and-forget: a failed reveal (headless host, missing launcher)
      // must never disturb the tree — the menu simply closes.
      console.warn('[dsh-better-sidebar] reveal failed:', error)
    })
  }

  // ── Create (file / folder) ──────────────────────────────────────────────
  const beginCreate = (dir: string, kind: 'file' | 'folder'): void => {
    setCreateState({ dir, kind, name: '', error: null, busy: false })
  }

  const closeCreate = (): void => {
    setCreateState(null)
  }

  /** Create the entered file/folder inside the dialog's directory, then show it. */
  const commitCreate = (): void => {
    const target = createState
    if (target === null) return
    const name = target.name.trim()
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      setCreateState({ ...target, error: t('newNameInvalid') })
      return
    }
    setCreateState({ ...target, busy: true, error: null })
    const abs = resolveSidebarPath(target.dir, name)
    const reveal = (): void => {
      closeCreate()
      // Show the new entry: expand its directory (if not already) and force a
      // reload of that level so the fresh row appears without a full refresh.
      if (!expanded.includes(target.dir)) onToggle(target.dir)
      loadDir(target.dir, true)
    }
    const fail = (error: unknown): void => {
      setCreateState(current => current === null ? null : {
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (target.kind === 'file') {
      void api.fsCreate({ sessionId, cwd }, abs).then(reveal).catch(fail)
    } else {
      void api.fsMkdir({ sessionId, cwd }, abs).then(reveal).catch(fail)
    }
  }

  // ── Rename ──────────────────────────────────────────────────────────────
  const beginRename = (path: string, isDir: boolean): void => {
    setRenameState({ path, isDir, name: baseName(path), error: null, busy: false })
  }

  const closeRename = (): void => {
    setRenameState(null)
  }

  const commitRename = (): void => {
    const target = renameState
    if (target === null) return
    const name = target.name.trim()
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      setRenameState({ ...target, error: t('newNameInvalid') })
      return
    }
    if (name === baseName(target.path)) {
      closeRename()
      return
    }
    setRenameState({ ...target, busy: true, error: null })
    const dst = resolveSidebarPath(parentOf(target.path), name)
    void api.fsMove({ sessionId, cwd }, target.path, dst).then(() => {
      closeRename()
      const parent = parentOf(target.path)
      loadDir(parent, true)
      if (target.isDir) onMutateExpanded?.({ type: 'rename', oldPath: target.path, newPath: dst })
    }).catch((error: unknown) => {
      setRenameState(current => current === null ? null : {
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  const beginDelete = (path: string, isDir: boolean): void => {
    setDeleteState({ path, isDir, error: null, busy: false })
  }

  const closeDelete = (): void => {
    setDeleteState(null)
  }

  const confirmDelete = (): void => {
    const target = deleteState
    if (target === null) return
    setDeleteState({ ...target, busy: true, error: null })
    void api.fsDelete({ sessionId, cwd }, target.path).then(() => {
      closeDelete()
      const parent = parentOf(target.path)
      loadDir(parent, true)
      if (target.isDir) onMutateExpanded?.({ type: 'prune', path: target.path })
    }).catch((error: unknown) => {
      setDeleteState(current => current === null ? null : {
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  // ── Copy / paste (internal clipboard) ───────────────────────────────────
  const copyEntry = (path: string): void => {
    setClipboard(path)
  }

  /** A conflict-free name: append the localized "copy" suffix (numbered on
   *  repeat) before the extension, matching VSCode. */
  const suffixedName = (base: string, n: number): string => {
    const suffix = n === 1 ? t('copySuffix') : `${t('copySuffix')} ${n}`
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return `${base}${suffix}`
    return `${base.slice(0, dot)}${suffix}${base.slice(dot)}`
  }

  /** The first name under `base` that is not already taken by `entries`. */
  const uniqueName = (entries: FsEntry[] | undefined, base: string): string => {
    const taken = new Set((entries ?? []).map(entry => entry.name.toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    let n = 1
    while (taken.has(suffixedName(base, n).toLowerCase())) n += 1
    return suffixedName(base, n)
  }

  const pasteInto = (dir: string): void => {
    const src = clipboard
    if (src === null) return
    const base = baseName(src)
    const copyTo = (entries: FsEntry[] | undefined): void => {
      const dst = resolveSidebarPath(dir, uniqueName(entries, base))
      void api.fsCopy({ sessionId, cwd }, src, dst).then(() => {
        if (!expanded.includes(dir)) onToggle(dir)
        loadDir(dir, true)
      }).catch((error: unknown) => {
        console.warn('[dsh-better-sidebar] paste failed:', error)
      })
    }
    // The target folder's children may not be loaded (a collapsed folder is a
    // perfectly valid paste target); fetch a fresh listing so the copy never
    // collides, falling back to a bare attempt if the listing fails.
    const cached = dataRef.current[dir]?.entries
    if (cached !== undefined) {
      copyTo(cached)
      return
    }
    void api.fsTree({ sessionId, cwd }, dir).then(listing => copyTo(listing.entries)).catch(() => copyTo(undefined))
  }

  // ── Drag & drop ─────────────────────────────────────────────────────────
  const onDragStart = (event: DragEvent, path: string, isDir: boolean): void => {
    dragRef.current = { path, isDir }
    event.dataTransfer.effectAllowed = 'move'
    // Firefox requires some data before it will start a drag.
    event.dataTransfer.setData('text/plain', path)
  }

  const clearDrag = (): void => {
    dragRef.current = null
    setDropTarget(null)
  }

  /** Whether `dstDir` can receive the currently-dragged item. */
  const canDropTo = (item: { path: string; isDir: boolean }, dstDir: string): boolean => {
    // A directory cannot be dropped into itself or its own subtree.
    if (item.isDir && relativeTo(item.path, dstDir) !== dstDir) return false
    return true
  }

  /** Move the dragged item into `dstDir`, then refresh the affected levels. */
  const moveTo = (dstDir: string): void => {
    const item = dragRef.current
    clearDrag()
    if (item === null) return
    if (!canDropTo(item, dstDir)) return
    const dst = resolveSidebarPath(dstDir, baseName(item.path))
    if (dst === item.path) return
    const srcParent = parentOf(item.path)
    void api.fsMove({ sessionId, cwd }, item.path, dst).then(() => {
      // Show the result: the destination folder gains the row, the source
      // folder loses it. A moved directory keeps its subtree (its expansion
      // entries are rewritten by the shell via onMutateExpanded).
      if (!expanded.includes(dstDir)) onToggle(dstDir)
      loadDir(dstDir, true)
      if (srcParent !== dstDir) loadDir(srcParent, true)
      if (item.isDir) onMutateExpanded?.({ type: 'rename', oldPath: item.path, newPath: dst })
    }).catch((error: unknown) => {
      console.warn('[dsh-better-sidebar] move failed:', error)
    })
  }

  /** A folder row (or file row, via its parent) being hovered as a target. */
  const onDragOverTarget = (event: DragEvent, dstDir: string): void => {
    const item = dragRef.current
    if (item === null || !canDropTo(item, dstDir)) {
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'none'
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(dstDir)
  }

  const onDropTarget = (event: DragEvent, dstDir: string): void => {
    event.preventDefault()
    event.stopPropagation()
    moveTo(dstDir)
  }

  // The tree body's empty space (or gaps between rows): move into the root.
  const onDragOverBody = (event: DragEvent): void => {
    event.preventDefault()
    setDropTarget(cwd ?? null)
  }

  const onDropBody = (event: DragEvent): void => {
    event.preventDefault()
    if (cwd !== undefined) moveTo(cwd)
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
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
              draggable
              className={clsx(
                css.explorerRow,
                css.explorerDir,
                entry.hidden && css.explorerHidden,
                dropTarget === entry.path && css.explorerDropTarget,
              )}
              style={{ paddingLeft: depth * 22 + 6 }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
              onDragStart={(event) => { onDragStart(event, entry.path, true) }}
              onDragEnd={clearDrag}
              onDragOver={(event) => { onDragOverTarget(event, entry.path) }}
              onDrop={(event) => { onDropTarget(event, entry.path) }}
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
          draggable
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
          onDragStart={(event) => { onDragStart(event, entry.path, false) }}
          onDragEnd={clearDrag}
          onDragOver={(event) => { onDragOverTarget(event, parentOf(entry.path)) }}
          onDrop={(event) => { onDropTarget(event, parentOf(entry.path)) }}
        >
          <IconCodeOutline16 size={14} />
          <span className={css.explorerName}>{entry.name}</span>
          {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
          {rowActions(entry)}
        </div>
      )
    })
  }

  /** Whether the open context menu is on the workspace root row. */
  const menuIsRoot = rowMenu !== null && rowMenu.isDir && rowMenu.path === cwd

  return (
    <div className={css.explorerBody} onDragOver={onDragOverBody} onDrop={onDropBody}>
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          <div
            className={clsx(css.explorerRow, dropTarget === root && css.explorerDropTarget)}
            style={{ paddingLeft: 6 }}
            onContextMenu={(event) => { openRowMenu(event, root, true) }}
            onDragOver={(event) => { onDragOverTarget(event, root) }}
            onDrop={(event) => { onDropTarget(event, root) }}
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
        items={[
          // Directories create files/folders inside; the root row is a directory too.
          ...(rowMenu?.isDir === true
            ? [
              { id: 'new-file', label: t('newFile'), icon: <IconPlusOutline16 size={14} /> },
              { id: 'new-folder', label: t('newFolder'), icon: <IconFolderOpenOutline16 size={14} /> },
            ]
            : []),
          // The open escapes head the FILE menu (dirs only get copy).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <IconFolderOpen16 size={14} /> }]
            : []),
          // Copy / rename / delete apply to files and sub-directories (never root).
          ...(rowMenu !== null && !menuIsRoot
            ? [{ id: 'copy-entry', label: t('copy'), icon: <IconCopyOutline16 size={14} /> }]
            : []),
          ...(rowMenu !== null && !menuIsRoot
            ? [{ id: 'rename', label: t('rename'), icon: <IconEditOutline16 size={14} /> }]
            : []),
          ...(rowMenu !== null && !menuIsRoot
            ? [{ id: 'delete', label: t('delete'), icon: <IconTrashOutline16 size={14} />, danger: true }]
            : []),
          // Paste into a directory (root included) when something is copied.
          ...(rowMenu?.isDir === true && clipboard !== null
            ? [{ id: 'paste', label: t('paste') }]
            : []),
          // Reveal applies to files AND directories.
          { id: 'reveal', label: t('revealInFileManager'), icon: <IconRightUpOutline16 size={14} /> },
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
          if (id === 'new-file') {
            beginCreate(target.path, 'file')
            return
          }
          if (id === 'new-folder') {
            beginCreate(target.path, 'folder')
            return
          }
          if (id === 'open-new-tab') {
            onOpenFileNewTab?.(target.path)
            return
          }
          if (id === 'open-side') {
            onOpenFileSide?.(target.path)
            return
          }
          if (id === 'copy-entry') {
            copyEntry(target.path)
            return
          }
          if (id === 'rename') {
            beginRename(target.path, target.isDir)
            return
          }
          if (id === 'delete') {
            beginDelete(target.path, target.isDir)
            return
          }
          if (id === 'paste') {
            pasteInto(target.path)
            return
          }
          if (id === 'reveal') {
            revealFile(target.path)
            return
          }
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
      {/*
        The "new file / new folder" dialog: created into the directory the
        row menu was opened on. The target directory rides the modal
        description so the user always sees where the entry will land.
      */}
      <Modal
        open={createState !== null}
        onClose={() => { if (createState === null || !createState.busy) closeCreate() }}
        title={createState?.kind === 'folder' ? t('newFolder') : t('newFile')}
        closeLabel={t('cancel')}
        description={createState?.dir ?? ''}
        footer={(
          <>
            <Button variant="outline" disabled={createState?.busy} onClick={closeCreate}>{t('cancel')}</Button>
            <Button variant="primary" disabled={createState?.busy} onClick={commitCreate}>{t('create')}</Button>
          </>
        )}
      >
        <Input
          autoFocus
          value={createState?.name ?? ''}
          placeholder={createState?.kind === 'folder' ? t('newFolderNamePlaceholder') : t('newFileNamePlaceholder')}
          disabled={createState?.busy}
          onChange={(event) => {
            if (createState === null) return
            setCreateState({ ...createState, name: event.target.value, error: null })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitCreate()
            } else if (event.key === 'Escape') {
              if (createState === null || !createState.busy) closeCreate()
            }
          }}
        />
        {createState?.error != null && <div className={css.editorError}>{createState.error}</div>}
      </Modal>
      {/* The rename dialog. */}
      <Modal
        open={renameState !== null}
        onClose={() => { if (renameState === null || !renameState.busy) closeRename() }}
        title={t('rename')}
        closeLabel={t('cancel')}
        description={renameState?.path ?? ''}
        footer={(
          <>
            <Button variant="outline" disabled={renameState?.busy} onClick={closeRename}>{t('cancel')}</Button>
            <Button variant="primary" disabled={renameState?.busy} onClick={commitRename}>{t('rename')}</Button>
          </>
        )}
      >
        <Input
          autoFocus
          value={renameState?.name ?? ''}
          placeholder={t('renamePlaceholder')}
          disabled={renameState?.busy}
          onChange={(event) => {
            if (renameState === null) return
            setRenameState({ ...renameState, name: event.target.value, error: null })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              if (renameState === null || !renameState.busy) closeRename()
            }
          }}
        />
        {renameState?.error != null && <div className={css.editorError}>{renameState.error}</div>}
      </Modal>
      {/* The delete confirmation (destructive; the entry's name rides the description). */}
      <Modal
        open={deleteState !== null}
        onClose={() => { if (deleteState === null || !deleteState.busy) closeDelete() }}
        title={t('delete')}
        closeLabel={t('cancel')}
        description={deleteState !== null ? t('deleteDesc', { path: baseName(deleteState.path) }) : ''}
        footer={(
          <>
            <Button variant="outline" disabled={deleteState?.busy} onClick={closeDelete}>{t('cancel')}</Button>
            <Button variant="primary" disabled={deleteState?.busy} onClick={confirmDelete}>{t('delete')}</Button>
          </>
        )}
      >
        {deleteState?.error != null && <div className={css.editorError}>{deleteState.error}</div>}
      </Modal>
    </div>
  )
}
