/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke)
 * over either the shared controlled FileTree (empty query) or the flat
 * result list (relative paths; click opens through the caller's mode-aware
 * open). Owns its refresh tick: the icon next to the search input invalidates
 * the tree cache. EditorHost docks it as the tab's right panel (wrapped in
 * a drag-resize handle) and provides the file context-menu open escapes.
 *
 * Uploads (header pickers, the tree's drag-drop and "upload here" menu)
 * all funnel through here: one session at a time, shown in a full-window
 * progress overlay with cancel, followed by a tree refresh and a one-line
 * hint under the search row (success fades, failures and cancels stay).
 * OS file drags are shielded at the panel host (see Sidebar.tsx), so a
 * drop over the file window uploads here and never reaches DSH's chat
 * intake.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import { IconFolderOpen16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { FileTree } from './FileTree.tsx'
import { IconUploadOutline16 } from './icons.tsx'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
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

export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** File context-menu "open in a new tab" (passed through to FileTree). */
  onOpenFileNewTab?: (path: string) => void
  /** File context-menu "open to the side" (passed through to FileTree). */
  onOpenFileSide?: (path: string) => void
  /** The "open with" menu surface (passed through to FileTree; absent →
   *  the whole section is hidden). */
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
  onOpenWith?: (targetId: string, path: string) => void
  onToggleOpenWithPin?: (targetId: string) => void
  onReferenceFile: (path: string) => void
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** Whether the host workspace watcher should push refresh signals here
   *  (the "auto-refresh file tree" setting lives with the editor settings). */
  autoRefresh?: boolean
  /** False while this tab is not the active/visible one — no watcher should
   *  be held open for a hidden editor tab. */
  visible?: boolean
}) {
  const { sessionId, cwd, expanded, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin, onReferenceFile, full, autoRefresh, visible } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
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

  // The host workspace watcher pushes a lightweight `change` signal whenever
  // the session's working directory changes on disk. Only enabled by the
  // user-facing `autoRefreshFiles` setting; the socket reconnects on drops
  // and follows cwd changes (the host resolves the authoritative cwd). The
  // watcher is intentionally lazy: it starts only once the tree actually has
  // a working directory to render, so a slow session-cwd lookup never makes
  // the host scan a workspace just to paint the sidebar shell.
  useEffect(() => {
    if (autoRefresh !== true) return
    if (visible === false) return
    if (cwd === undefined || cwd === '') return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/fs-events', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const params = new URLSearchParams({ sessionId })
      if (cwd !== undefined && cwd !== '') params.set('cwd', cwd)
      url.search = params.toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const message = JSON.parse(event.data) as { type?: string }
          if (message.type === 'change') setRefreshTick(tick => tick + 1)
        } catch {
          // Malformed push: ignore (the next push will refresh).
        }
      }
      socket.onclose = () => {
        if (closed) return
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [autoRefresh, visible, sessionId, cwd])

  const needle = query.trim()
  useEffect(() => {
    if (needle === '') {
      setResults(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      api.fsSearch({ sessionId, cwd }, needle, controller.signal).then((found) => {
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
  }, [sessionId, cwd, needle])

  const busy = upload !== null

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}>
      <div className={css.editorTreeSearch}>
        <input
          className={css.editorSearchInput}
          value={query}
          placeholder={t('editorSearchPlaceholder')}
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { setRefreshTick(tick => tick + 1) }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('uploadFiles')}
          title={t('uploadFiles')}
          disabled={busy}
          onClick={() => { fileInputRef.current?.click() }}
        >
          <IconUploadOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('uploadFolder')}
          title={t('uploadFolder')}
          disabled={busy}
          onClick={() => { folderInputRef.current?.click() }}
        >
          <IconFolderOpen16 size={14} />
        </button>
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
        <div className={clsx(css.editorSearchHint, uploadFailed && css.editorError)} title={uploadStatus}>{uploadStatus}</div>
      )}
      {needle === '' ? (
        <FileTree
          sessionId={sessionId}
          cwd={cwd}
          expanded={expanded}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onOpenFileNewTab={onOpenFileNewTab}
          onOpenFileSide={onOpenFileSide}
          openWithTargets={openWithTargets}
          openWithPinned={openWithPinned}
          openWithSsh={openWithSsh}
          onOpenWith={onOpenWith}
          onToggleOpenWithPin={onToggleOpenWithPin}
          onReferenceFile={onReferenceFile}
          refreshTick={refreshTick}
          onUploadRequest={startUpload}
          busy={busy}
        />
      ) : (
        <div className={css.explorerBody}>
          {error !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{error}</div>}
          {error === null && results === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
          {error === null && results !== null && results.matches.length === 0 && (
            <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
          )}
          {error === null && results !== null && results.matches.map(rel => (
            <button
              key={rel}
              type="button"
              className={css.editorSearchResult}
              title={rel}
              onClick={() => { onOpenFile(resolveSidebarPath(cwd, rel)) }}
            >
              {rel}
            </button>
          ))}
          {error === null && results?.truncated === true && (
            <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
          )}
        </div>
      )}
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
