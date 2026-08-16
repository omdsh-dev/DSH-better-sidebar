/**
 * The file explorer: a lazy VSCode-style tree rooted at the session's
 * working directory. Levels load on expansion (one API call per directory),
 * directories sort first, hidden entries render dimmed, and the expansion
 * set lives in the per-session state. Clicking a file opens an editor tab.
 *
 * Basic file management (VSCode-explorer parity):
 * - Folder rows hover a "new file" / "new folder" pair of buttons; the root
 *   row offers the same. Committing the inline name input creates the entry
 *   under that directory (host routes `fs.mkdir` / `fs.create`).
 * - The context menu adds 新建文件 / 新建文件夹 (directories and root),
 *   重命名 (inline input on the row), and 删除 (two-step: the row flips to
 *   confirm/cancel; the host `fs.remove` is recursive and permanent).
 * - Every row is draggable; directory rows (plus the root row and the empty
 *   explorer body area) are drop targets that move the dragged entry into
 *   them (`fs.move`). Dropping into a file's own subtree is refused, and
 *   affected levels refetch after every mutation.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu to copy the relative or absolute path (with a brief
 * "copied" label replacing the button after a successful write); file rows
 * also offer a download action (the host serves raw bytes, binary-safe).
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCheckOutline16, IconCloseOutline16, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16,
  IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16, IconProjectAddOutline16,
  IconRefreshOutline16, IconTrashOutline16, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
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

/** Parent directory of an absolute path ('' never occurs for rows). */
function dirnameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at <= 0 ? trimmed : trimmed.slice(0, at)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** The inline row editor kinds (new file / new folder under a parent). */
type CreateKind = 'file' | 'dir'

export function ExplorerView(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
}) {
  const { sessionId, cwd, expanded, onToggle, onOpenFile, onReferenceFile } = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [refreshTick, setRefreshTick] = useState(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  /** Inline creation row: { parent, kind } or null (new file / folder input under a directory). */
  const [creating, setCreating] = useState<{ parent: string; kind: CreateKind } | null>(null)
  /** The inline creation input's current value. */
  const [createName, setCreateName] = useState('')
  /** Inline rename: { path, name } or null. */
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  /** The row waiting for a delete confirmation (two-step delete). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** The row path currently being dragged. */
  const [dragging, setDragging] = useState<string | null>(null)
  /** The drag source path mirror (readable in dragOver/drop without a render round-trip). */
  const draggingRef = useRef<string | null>(null)
  /** The directory row currently highlighted as a drop target. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** A transient mutation failure shown under the explorer header. */
  const [mutationError, setMutationError] = useState<string | null>(null)

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

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh button wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  /** The session scope for API calls. */
  const scope = { sessionId, cwd }

  /** Refetch one level unconditionally (mutations invalidate the cache). */
  const reloadDir = useCallback((dir: string) => {
    storeLevel(dir, {})
    api.fsTree(scope, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  /** Drop the cached subtree under `path`, close its expanded entries, and reset inline editors pointing into it. */
  const purgeTree = (path: string): void => {
    const prefix = `${path}/`
    const next: Record<string, LevelData> = {}
    for (const key of Object.keys(dataRef.current)) {
      if (key === path || key.startsWith(prefix)) continue
      const level = dataRef.current[key]
      if (level === undefined) continue
      next[key] = level
    }
    dataRef.current = next
    setData(next)
    for (const open of expanded) {
      if (open === path || open.startsWith(prefix)) onToggle(open)
    }
    if (creating?.parent === path || renaming?.path === path || pendingDelete === path) {
      setCreating(null)
      setCreateName('')
      setRenaming(null)
      setPendingDelete(null)
    }
  }

  /** Surface a mutation failure in the explorer (auto-clears). */
  const fail = (message: string): void => {
    setMutationError(message)
    window.setTimeout(() => setMutationError(null), 4000)
  }

  /** Whether `src` may be moved into `targetDir` (not itself, not a descendant). */
  const canMoveTo = (src: string, targetDir: string): boolean => {
    if (!src || src === targetDir) return false
    if (targetDir === `${src}/` || targetDir.startsWith(`${src}/`)) return false
    return true
  }

  /** Move `src` into `targetDir` and refresh both affected levels. */
  const doMove = async (src: string, targetDir: string): Promise<void> => {
    try {
      await api.fsMove(scope, src, targetDir)
      reloadDir(dirnameOf(src))
      reloadDir(targetDir)
      purgeTree(src)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  /** Begin an inline new-file / new-folder input under `parent`. */
  const startCreate = (parent: string, kind: CreateKind): void => {
    if (parent !== cwd && !expanded.includes(parent)) onToggle(parent)
    setPendingDelete(null)
    setRenaming(null)
    setCreating({ parent, kind })
    setCreateName('')
  }

  /** Commit the inline creation (Enter / check button). */
  const commitCreate = async (): Promise<void> => {
    const target = creating
    if (target === null) return
    const name = createName.trim()
    if (name === '') return
    try {
      if (target.kind === 'dir') await api.fsMkdir(scope, target.parent, name)
      else await api.fsCreate(scope, target.parent, name)
      setCreating(null)
      setCreateName('')
      reloadDir(target.parent)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  /** Begin an inline rename of `path`. */
  const startRename = (path: string, name: string): void => {
    setPendingDelete(null)
    setCreating(null)
    setRenaming({ path, name })
  }

  /** Commit the inline rename (Enter / check button). */
  const commitRename = async (): Promise<void> => {
    const target = renaming
    if (target === null) return
    const name = target.name.trim()
    if (name === '') return
    try {
      await api.fsRename(scope, target.path, name)
      setRenaming(null)
      reloadDir(dirnameOf(target.path))
      purgeTree(target.path)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  /** Arm the two-step delete for `path` (row shows confirm/cancel). */
  const requestDelete = (path: string): void => {
    setRowMenu(null)
    setCreating(null)
    setRenaming(null)
    setPendingDelete(path)
  }

  /** Execute the armed delete (recursive; the host refuses the cwd itself). */
  const commitDelete = async (): Promise<void> => {
    const path = pendingDelete
    if (path === null) return
    try {
      await api.fsRemove(scope, path)
      setPendingDelete(null)
      reloadDir(dirnameOf(path))
      purgeTree(path)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

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

  /** Drag-source props for any row (state + ref so drop works without a re-render). */
  const dragProps = (path: string): {
    draggable: boolean
    onDragStart: (event: DragEvent<HTMLDivElement>) => void
    onDragEnd: () => void
  } => ({
    draggable: true,
    onDragStart: (event) => {
      event.stopPropagation()
      event.dataTransfer.setData('text/plain', path)
      event.dataTransfer.effectAllowed = 'move'
      draggingRef.current = path
      setDragging(path)
    },
    onDragEnd: () => {
      draggingRef.current = null
      setDragging(null)
      setDropTarget(null)
    },
  })

  /** Drop-target props for a directory row (or the root / empty area). */
  const dropProps = (dirPath: string): {
    onDragOver: (event: DragEvent<HTMLDivElement>) => void
    onDragLeave: () => void
    onDrop: (event: DragEvent<HTMLDivElement>) => void
  } => ({
    onDragOver: (event) => {
      const src = draggingRef.current ?? event.dataTransfer.getData('text/plain')
      if (src !== '' && canMoveTo(src, dirPath)) {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        if (dropTarget !== dirPath) setDropTarget(dirPath)
      }
    },
    onDragLeave: () => {
      if (dropTarget === dirPath) setDropTarget(null)
    },
    onDrop: (event) => {
      event.preventDefault()
      event.stopPropagation()
      const src = draggingRef.current ?? event.dataTransfer.getData('text/plain')
      draggingRef.current = null
      setDragging(null)
      setDropTarget(null)
      if (src !== '' && canMoveTo(src, dirPath)) void doMove(src, dirPath)
    },
  })

  /** The row's trailing actions: delete confirm, create buttons (dirs), the @-reference button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (pendingDelete === entry.path) {
      return (
        <>
          <button
            type="button"
            className={css.explorerRef}
            aria-label="确认删除"
            title="确认删除（不可恢复）"
            onClick={(event) => { event.stopPropagation(); void commitDelete() }}
          >
            <IconCheckOutline16 size={14} />
          </button>
          <button
            type="button"
            className={css.explorerRef}
            aria-label="取消"
            title="取消删除"
            onClick={(event) => { event.stopPropagation(); setPendingDelete(null) }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </>
      )
    }
    const actions: ReactNode[] = []
    if (entry.isDir) {
      actions.push(
        <button
          key="new-folder"
          type="button"
          className={css.explorerRef}
          aria-label="新建文件夹"
          title="新建文件夹"
          onClick={(event) => { event.stopPropagation(); startCreate(entry.path, 'dir') }}
        >
          <IconProjectAddOutline16 size={14} />
        </button>,
        <button
          key="new-file"
          type="button"
          className={css.explorerRef}
          aria-label="新建文件"
          title="新建文件"
          onClick={(event) => { event.stopPropagation(); startCreate(entry.path, 'file') }}
        >
          <IconPlusOutline16 size={14} />
        </button>,
      )
    }
    if (copiedPath === entry.path) {
      actions.push(<span key="copied" className={css.explorerCopied}>{t('copied')}</span>)
    } else {
      actions.push(
        <button
          key="reference"
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
        </button>,
      )
    }
    return actions
  }

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setPendingDelete(null)
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

  /** The inline input style shared by create/rename rows. */
  const inputStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: '1px solid rgba(127,127,127,.5)',
    borderRadius: 3,
    color: 'inherit',
    padding: '1px 4px',
    fontSize: 12,
  }

  /** The rename input replacing a row's name while `renaming` points at it. */
  const renameInput = (path: string): ReactNode => {
    if (renaming === null || renaming.path !== path) return null
    return (
      <input
        autoFocus
        className={css.explorerName}
        style={inputStyle}
        value={renaming.name}
        onClick={(event) => { event.stopPropagation() }}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { setRenaming({ path, name: event.target.value }) }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          event.stopPropagation()
          if (event.key === 'Enter') void commitRename()
          if (event.key === 'Escape') setRenaming(null)
        }}
      />
    )
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
    return (
      <>
        {creating?.parent === dir ? (
          <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>
            {creating.kind === 'dir'
              ? <IconFolderClose16 size={14} />
              : <IconPlusOutline16 size={14} />}
            <input
              autoFocus
              style={inputStyle}
              placeholder={creating.kind === 'dir' ? '文件夹名称' : '文件名称'}
              value={createName}
              onChange={(event) => { setCreateName(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitCreate()
                if (event.key === 'Escape') { setCreating(null); setCreateName('') }
              }}
            />
            <button
              type="button"
              className={css.explorerRef}
              aria-label="确定"
              title="确定"
              onClick={(event) => { event.stopPropagation(); void commitCreate() }}
            >
              <IconCheckOutline16 size={14} />
            </button>
            <button
              type="button"
              className={css.explorerRef}
              aria-label="取消"
              title="取消"
              onClick={(event) => { event.stopPropagation(); setCreating(null); setCreateName('') }}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
        ) : null}
        {(level.entries ?? []).map(entry => {
          if (entry.isDir) {
            const isOpen = expanded.includes(entry.path)
            return (
              <div key={entry.path}>
                <div
                  role="button"
                  tabIndex={0}
                  className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
                  style={{
                    paddingLeft: depth * 22 + 6,
                    ...(dropTarget === entry.path ? { outline: '1px solid rgba(0,122,204,.9)', outlineOffset: -1, background: 'rgba(0,122,204,.12)' } : {}),
                  }}
                  onClick={() => { onToggle(entry.path) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onToggle(entry.path)
                    }
                  }}
                  onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
                  {...dragProps(entry.path)}
                  {...dropProps(entry.path)}
                >
                  {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
                  {renameInput(entry.path) ?? <span className={css.explorerName}>{entry.name}</span>}
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
              {...dragProps(entry.path)}
            >
              <IconCodeOutline16 size={14} />
              {renameInput(entry.path) ?? <span className={css.explorerName}>{entry.name}</span>}
              {rowActions(entry)}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div className={css.explorer}>
      <div className={css.explorerHeader}>
        <span className={css.explorerRoot} title={root}>{root === undefined ? t('noSession') : baseName(root)}</span>
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
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
      {mutationError !== null
        ? <div className={css.explorerError} style={{ padding: '2px 8px', fontSize: 12 }}>{mutationError}</div>
        : null}
      <div className={css.explorerBody} {...(cwd !== undefined ? dropProps(cwd) : {})}>
        {root === undefined ? (
          <div className={css.explorerEmpty}>{t('noSession')}</div>
        ) : (
          <>
            <div
              className={css.explorerRow}
              style={{ paddingLeft: 6 }}
              onContextMenu={(event) => { openRowMenu(event, root, true) }}
              {...dropProps(root)}
            >
              <IconFolderOpen16 size={14} />
              <span className={css.explorerName}>{baseName(root)}</span>
              <button
                type="button"
                className={css.explorerRef}
                aria-label="新建文件"
                title="新建文件"
                onClick={(event) => { event.stopPropagation(); startCreate(root, 'file') }}
              >
                <IconPlusOutline16 size={14} />
              </button>
              <button
                type="button"
                className={css.explorerRef}
                aria-label="新建文件夹"
                title="新建文件夹"
                onClick={(event) => { event.stopPropagation(); startCreate(root, 'dir') }}
              >
                <IconProjectAddOutline16 size={14} />
              </button>
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
          ...(rowMenu?.isDir === true
            ? [
              { id: 'new-file', label: '新建文件', icon: <IconPlusOutline16 size={14} /> },
              { id: 'new-folder', label: '新建文件夹', icon: <IconProjectAddOutline16 size={14} /> },
            ]
            : []),
          ...(rowMenu?.path !== cwd
            ? [
              { id: 'rename', label: '重命名', icon: <IconEditOutline16 size={14} /> },
              { id: 'delete', label: '删除', icon: <IconTrashOutline16 size={14} /> },
            ]
            : []),
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
          if (id === 'new-file') { startCreate(target.path, 'file'); return }
          if (id === 'new-folder') { startCreate(target.path, 'dir'); return }
          if (id === 'rename') { startRename(target.path, baseName(target.path)); return }
          if (id === 'delete') { requestDelete(target.path); return }
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
