/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke)
 * over either the shared controlled FileTree (empty query) or the flat
 * result list (relative paths; click opens through the caller's mode-aware
 * open). Owns its refresh tick: the icon next to the search input clears
 * the tree cache. EditorHost docks it as the tab's right panel (wrapped in
 * a drag-resize handle) and provides the file context-menu open escapes.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconDownloadOutline16, IconFolderOpen16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { uploadItemsFromDrop, uploadItemsFromFiles, type UploadItem } from './drop-upload.ts'
import { FileTree } from './FileTree.tsx'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
import css from './sidebar.module.css'

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
  onReferenceFile: (path: string) => void
  onPathMoved?: (from: string, to: string, isDir: boolean) => void
  onPathDeleted?: (path: string, isDir: boolean) => void
  onMutated?: () => void
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
}) {
  const {
    sessionId, cwd, expanded, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide,
    onReferenceFile, onPathMoved, onPathDeleted, onMutated, full,
  } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [uploadTarget, setUploadTarget] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const refresh = (): void => {
    setRefreshTick(tick => tick + 1)
    onMutated?.()
  }

  const upload = async (dir: string, items: UploadItem[]): Promise<void> => {
    if (items.length === 0) return
    setUploadStatus(t('uploadingFiles', { count: items.length }))
    try {
      for (const item of items) await api.fsUpload({ sessionId, cwd }, dir, item.relativePath, item.file)
      setUploadStatus(null)
      refresh()
    } catch (failure) {
      setUploadStatus(`${t('fileOperationFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }

  const requestUpload = (dir: string, kind: 'files' | 'folder'): void => {
    setUploadTarget(dir)
    const input = kind === 'files' ? fileInputRef.current : folderInputRef.current
    if (input !== null) {
      input.value = ''
      input.click()
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
          aria-label={t('uploadFiles')}
          title={t('uploadFiles')}
          disabled={cwd === undefined}
          onClick={() => { if (cwd !== undefined) requestUpload(cwd, 'files') }}
        >
          <IconDownloadOutline16 size={14} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('uploadFolder')}
          title={t('uploadFolder')}
          disabled={cwd === undefined}
          onClick={() => { if (cwd !== undefined) requestUpload(cwd, 'folder') }}
        >
          <IconFolderOpen16 size={14} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refresh}
        >
          <IconRefreshOutline16 size={14} />
        </button>
        <input
          ref={fileInputRef}
          className={css.fileInputHidden}
          type="file"
          multiple
          onChange={(event) => {
            const dir = uploadTarget ?? cwd
            if (dir !== undefined && dir !== null) void upload(dir, uploadItemsFromFiles(event.currentTarget.files ?? []))
          }}
        />
        <input
          ref={folderInputRef}
          className={css.fileInputHidden}
          type="file"
          multiple
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(event) => {
            const dir = uploadTarget ?? cwd
            if (dir !== undefined && dir !== null) void upload(dir, uploadItemsFromFiles(event.currentTarget.files ?? []))
          }}
        />
      </div>
      {uploadStatus !== null && <div className={clsx(css.editorSearchHint, uploadStatus.startsWith(t('fileOperationFailed')) && css.editorError)}>{uploadStatus}</div>}
      {needle === '' ? (
        <FileTree
          sessionId={sessionId}
          cwd={cwd}
          expanded={expanded}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onOpenFileNewTab={onOpenFileNewTab}
          onOpenFileSide={onOpenFileSide}
          onReferenceFile={onReferenceFile}
          refreshTick={refreshTick}
          onUploadRequest={requestUpload}
          onDropFiles={(dir, data) => { void uploadItemsFromDrop(data).then(items => upload(dir, items)) }}
          onMutated={refresh}
          onPathMoved={onPathMoved}
          onPathDeleted={onPathDeleted}
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
    </div>
  )
}
