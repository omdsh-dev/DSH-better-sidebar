/**
 * The file explorer: a lazy VSCode-style tree rooted at the session's
 * working directory. Levels load on expansion (one API call per directory),
 * directories sort first, hidden entries render dimmed, and the expansion
 * set lives in the per-session state. Clicking a file opens an editor tab.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu to copy the relative or absolute path (with a brief
 * "copied" label replacing the button after a successful write); file rows
 * also offer a download action (the host serves raw bytes, binary-safe).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline16, Menu, writeClipboard,
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

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** Reconnect backoff for the passive fs-events socket. */
const FS_RETRY_BASE_MS = 1000
const FS_RETRY_MAX_MS = 30_000
const FS_RETRY_STABLE_MS = 10_000

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
  const expandedKey = expanded.join('\0')
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  /** Latest request generation per directory; stale responses never win. */
  const requestVersionRef = useRef(new Map<string, number>())
  /** Directories visible during the previous render (collapsed levels can go stale). */
  const visibleDirsRef = useRef<{ cwd: string | undefined; expanded: Set<string> }>({
    cwd: undefined,
    expanded: new Set(),
  })
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string, force = false) => {
    const previous = dataRef.current[dir]
    if (!force && previous !== undefined) return
    const version = (requestVersionRef.current.get(dir) ?? 0) + 1
    requestVersionRef.current.set(dir, version)
    // Initial loads show the loading row. Refreshes keep the previous listing
    // mounted and swap the new entries in atomically, avoiding tree flicker.
    if (previous === undefined) storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      if (requestVersionRef.current.get(dir) !== version) return
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      if (requestVersionRef.current.get(dir) !== version) return
      // A passive refresh failure must not replace a usable tree with an error.
      if (previous?.entries !== undefined) return
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  useEffect(() => {
    const root = cwd
    if (root === undefined) return
    const previous = visibleDirsRef.current.cwd === root
      ? visibleDirsRef.current.expanded
      : new Set<string>()
    loadDir(root)
    // A directory can change while collapsed because it is intentionally not
    // watched then. Re-expansion therefore performs one background revalidate.
    for (const dir of expanded) loadDir(dir, !previous.has(dir))
    visibleDirsRef.current = { cwd: root, expanded: new Set(expanded) }
  }, [cwd, expandedKey, loadDir])

  /** Revalidate the visible tree without clearing any rendered rows. */
  const refreshVisible = useCallback(() => {
    if (cwd === undefined) return
    loadDir(cwd, true)
    for (const dir of expanded) loadDir(dir, true)
  }, [cwd, expandedKey, loadDir])

  /**
   * Passive file-tree refresh: subscribe to host fs.watch events for the
   * visible/expanded directories. The host pushes `{type:'change', path}`
   * when a watched directory's contents change; we revalidate that level in
   * the background and atomically swap the result. No polling or blank state.
   */
  useEffect(() => {
    if (cwd === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let stable: number | undefined
    let closed = false
    let failures = 0
    let openedOnce = false
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/fs-events', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId, cwd }).toString()
      socket = new WebSocket(url.toString())
      socket.onopen = () => {
        window.clearTimeout(stable)
        stable = window.setTimeout(() => { failures = 0 }, FS_RETRY_STABLE_MS)
        const dirs = [cwd, ...expanded]
        for (const dir of dirs) {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'watch', path: dir }))
          }
        }
        // Changes can happen during a broken connection. A reconnect closes
        // that blind spot with one no-flicker revalidation of visible levels.
        if (openedOnce) refreshVisible()
        openedOnce = true
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const msg = JSON.parse(event.data) as { type?: unknown; path?: unknown }
          if (msg?.type !== 'change' || typeof msg.path !== 'string') return
          const changed = msg.path
          if (dataRef.current[changed] === undefined && cwd !== changed && !expanded.includes(changed)) return
          loadDir(changed, true)
        } catch {
          // Malformed push: ignore (the next real change will refresh).
        }
      }
      socket.onclose = () => {
        if (closed) return
        window.clearTimeout(stable)
        failures += 1
        const delay = Math.min(FS_RETRY_BASE_MS * (2 ** Math.min(failures - 1, 5)), FS_RETRY_MAX_MS)
        retry = window.setTimeout(connect, delay)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      window.clearTimeout(stable)
      socket?.close()
    }
  }, [sessionId, cwd, expandedKey, loadDir, refreshVisible])

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
        <span className={css.explorerRoot} title={root}>{root === undefined ? t('noSession') : baseName(root)}</span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refreshVisible}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
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
