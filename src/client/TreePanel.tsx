/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke)
 * over either the shared controlled FileTree (empty query) or the flat
 * result list (relative paths; click opens through the caller's mode-aware
 * open). Owns its refresh tick: the icon next to the search input clears
 * the tree cache. EditorHost docks it as the tab's right panel (wrapped in
 * a drag-resize handle) and provides the file context-menu open escapes.
 *
 * Imports from a directory context menu and uploads from tree drag-drop all
 * funnel through here: one session at a time, shown in a full-window
 * progress overlay with cancel, followed by a tree refresh and a one-line
 * hint under the search row (success fades, failures and cancels stay).
 * OS file drags are shielded at the panel host (see Sidebar.tsx), so a
 * drop over the file window uploads here and never reaches DSH's chat
 * intake.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { FileTree, type FileTreeCreateKind, type FileTreeDeleteTarget } from './FileTree.tsx'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { relativeTo } from './paths.ts'
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
  revealed: string[]
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
  /** Called after a confirmed deletion so open editor tabs can reset. */
  onPathDeleted?: (target: FileTreeDeleteTarget) => void
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** File-tree scroll position owned by the editor tab. */
  initialScrollTop: number
  /** Reports file-tree navigation movement to the editor tab. */
  onScrollTopChange: (scrollTop: number) => void
}) {
  const { sessionId, cwd, expanded, revealed, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin, onReferenceFile, onPathDeleted, full, initialScrollTop, onScrollTopChange } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /** One-line file-operation status under the search row ('' hides it). */
  const [operationStatus, setOperationStatus] = useState('')
  /** Whether the status line is a failure/cancel (error color, stays visible). */
  const [operationFailed, setOperationFailed] = useState(false)
  /** The in-flight upload session (null → no overlay, buttons enabled). */
  const [upload, setUpload] = useState<UploadSession | null>(null)
  /** True between the cancel click and the session settling (button disabled). */
  const [cancelling, setCancelling] = useState(false)
  /** Explorer entry awaiting permanent-delete confirmation. */
  const [deleteTarget, setDeleteTarget] = useState<FileTreeDeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /** True while the inline tree name editor is creating its entry. */
  const [createBusy, setCreateBusy] = useState(false)
  /** Set by cancelUpload; the settle path shows 'upload cancelled' instead of
   *  summarizing the partial results. */
  const cancelledRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  /** Folder selected by the context menu before the OS picker opens. */
  const pendingImportDir = useRef<string | undefined>(undefined)

  /** Start one upload session into `dir` (absolute, inside the workspace). */
  const startUpload = (dir: string, items: UploadItem[]): void => {
    if (items.length === 0 || cwd === undefined || upload !== null || deleteBusy || createBusy) return
    cancelledRef.current = false
    const controller = new AbortController()
    setOperationFailed(false)
    setOperationStatus(uploadHintText(0, items.length, '', dir, t))
    setUpload({ dir, done: 0, total: items.length, current: '', controller })
    void uploadToDir({ sessionId, cwd }, dir, items, (done, total, current) => {
      if (current !== '') setOperationStatus(uploadHintText(done, total, current, dir, t))
      setUpload(session => session === null ? session : { ...session, done, total, current })
    }, controller.signal).then((results) => {
      setUpload(null)
      setCancelling(false)
      // Reload the tree whatever the outcome: files may have landed before a
      // cancel, and failures leave whatever did succeed visible.
      setRefreshTick(tick => tick + 1)
      if (cancelledRef.current) {
        setOperationStatus(t('uploadCancelled'))
        setOperationFailed(true)
        return
      }
      const status = summarizeResults(results, t)
      setOperationStatus(status)
      setOperationFailed(results.some(result => !result.ok))
      // Success messages are transient; failures stay until the next action.
      if (results.every(result => result.ok)) {
        window.setTimeout(() => {
          setOperationStatus(current => current === status ? '' : current)
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

  /** Create one empty direct child, refresh the tree, and report success. */
  const createEntry = async (dir: string, name: string, kind: FileTreeCreateKind): Promise<{ path: string }> => {
    if (cwd === undefined || createBusy || upload !== null || deleteBusy) {
      throw new Error(t('operationBusy'))
    }
    setCreateBusy(true)
    setOperationFailed(false)
    setOperationStatus(t('creating'))
    try {
      const created = await api.fsCreate({ sessionId, cwd }, dir, name, kind)
      setRefreshTick(tick => tick + 1)
      const status = t('createDone', { path: relativeTo(cwd, created.path) })
      setOperationStatus(status)
      window.setTimeout(() => {
        setOperationStatus(current => current === status ? '' : current)
      }, UPLOAD_HINT_MS)
      return created
    } catch (reason) {
      setOperationStatus('')
      throw reason
    } finally {
      setCreateBusy(false)
    }
  }

  /** Permanently delete the confirmed entry, then refresh the tree. */
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget
    if (target === null || deleteBusy || upload !== null) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await api.fsDelete({ sessionId, cwd }, target.path)
      setDeleteTarget(null)
      setRefreshTick(tick => tick + 1)
      setOperationFailed(false)
      const label = relativeTo(cwd ?? '', target.path)
      const status = t('deleteDone', { path: label })
      setOperationStatus(status)
      window.setTimeout(() => {
        setOperationStatus(current => current === status ? '' : current)
      }, UPLOAD_HINT_MS)
      onPathDeleted?.(target)
    } catch (reason) {
      setDeleteError(t('deleteFailed', {
        error: reason instanceof Error ? reason.message : String(reason),
      }))
    } finally {
      setDeleteBusy(false)
    }
  }

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

  const busy = upload !== null || deleteBusy || createBusy

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
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          const dir = pendingImportDir.current ?? cwd
          pendingImportDir.current = undefined
          if (dir !== undefined) startUpload(dir, uploadItemsFromFiles(event.target.files ?? []))
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
          const dir = pendingImportDir.current ?? cwd
          pendingImportDir.current = undefined
          if (dir !== undefined) startUpload(dir, uploadItemsFromFiles(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      {operationStatus !== '' && (
        <div className={clsx(css.editorSearchHint, operationFailed && css.editorError)} title={operationStatus}>{operationStatus}</div>
      )}
      {needle === '' ? (
        <FileTree
          sessionId={sessionId}
          cwd={cwd}
          expanded={expanded}
          revealed={revealed}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onOpenFileNewTab={onOpenFileNewTab}
          onOpenFileSide={onOpenFileSide}
          onDeleteEntry={(target) => {
            setDeleteError(null)
            setDeleteTarget(target)
          }}
          openWithTargets={openWithTargets}
          openWithPinned={openWithPinned}
          openWithSsh={openWithSsh}
          onOpenWith={onOpenWith}
          onToggleOpenWithPin={onToggleOpenWithPin}
          onReferenceFile={onReferenceFile}
          onCreateEntry={createEntry}
          onImportFiles={(dir) => {
            if (busy) return
            pendingImportDir.current = dir
            fileInputRef.current?.click()
          }}
          onImportFolder={(dir) => {
            if (busy) return
            pendingImportDir.current = dir
            folderInputRef.current?.click()
          }}
          refreshTick={refreshTick}
          onUploadRequest={startUpload}
          busy={busy}
          initialScrollTop={initialScrollTop}
          onScrollTopChange={onScrollTopChange}
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
      <Modal
        open={deleteTarget !== null}
        onClose={() => { if (!deleteBusy) setDeleteTarget(null) }}
        title={deleteTarget?.kind === 'directory'
          ? t('deleteFolderTitle')
          : deleteTarget?.kind === 'symlink' ? t('deleteSymlinkTitle') : t('deleteFileTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" disabled={deleteBusy} onClick={() => { setDeleteTarget(null) }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={deleteBusy} onClick={() => { void confirmDelete() }}>
              {deleteBusy
                ? t('deleting')
                : deleteTarget?.kind === 'directory'
                  ? t('deleteFolder')
                  : deleteTarget?.kind === 'symlink' ? t('deleteSymlink') : t('deleteFile')}
            </Button>
          </>
        )}
      >
        <p className={css.editorDeleteDesc}>
          {deleteTarget?.kind === 'directory'
            ? t('deleteFolderDesc', { path: relativeTo(cwd ?? '', deleteTarget.path) })
            : deleteTarget?.kind === 'symlink'
              ? t('deleteSymlinkDesc', { path: relativeTo(cwd ?? '', deleteTarget.path) })
              : t('deleteFileDesc', { path: relativeTo(cwd ?? '', deleteTarget?.path ?? '') })}
        </p>
        {deleteError !== null && <p className={clsx(css.editorDeleteDesc, css.editorDeleteError)}>{deleteError}</p>}
      </Modal>
    </div>
  )
}
