/**
 * The `.cluepack` share window (S9).
 *
 * One S6 collection window hosts both directions:
 * - export: pick packs, choose snapshot vs reference mode, preview the exact
 *   payload (including the portable addresses the inspection step resolves),
 *   watch progress, cancel, and download the archive;
 * - import: choose a file, preview what it carries (missing sources, unresolved
 *   rows, snapshots), then commit and report complete / partial / cancelled —
 *   an explicit acceptance is required for a partial import.
 *
 * The window never touches the source layer itself; all work goes through the
 * share client helpers (JSON methods for previews/progress, raw routes for the
 * bytes). Closing the window aborts an in-flight operation: no timer or fetch
 * outlives it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCloseOutlineRegular, IconDownloadOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'
import type { CluePack } from '../../../clues/types.ts'
import {
  ShareClientError,
  downloadShareArchive,
  exportShareArchive,
  importShareArchive,
  inspectShareExport,
  previewShareExport,
  previewShareImport,
  type CluepackMode,
  type ShareExportInspection,
  type ShareExportPreview,
  type ShareImportPreview,
  type ShareImportResult,
  type ShareProgress,
} from '../share-client.ts'
import { t } from '../../locales.ts'
import css from './share.module.css'

/** The share window id (one instance per plugin; opening again focuses it). */
export const CLUE_SHARE_WINDOW_ID = 'clue-share'

/** Options of {@link openShareWindow}. */
export interface OpenShareWindowOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly workspaceId: string
  readonly face: BetterSidebarCluesClientFace
  /** Preselect these packs (the pack window's share action). */
  readonly packIds?: readonly string[]
}

/** Open (or focus) the share window. */
export function openShareWindow(options: OpenShareWindowOptions): WindowHandle {
  return options.windows.open({
    id: CLUE_SHARE_WINDOW_ID,
    title: t('clueShareTitle'),
    size: 'collection',
    content: <SharePage {...options} />,
  })
}

/** One user-visible failure line. */
function errorLine(error: unknown): string {
  if (error instanceof ShareClientError) return `${t('clueShareFailed')} (${error.code})`
  if ((error as { name?: string } | undefined)?.name === 'AbortError') return t('clueShareCancelled')
  return t('clueShareFailed')
}

/** Progress line of one operation. */
function progressLine(progress: ShareProgress): string {
  return t('clueShareProgress', {
    phase: progress.phase,
    done: progress.completed,
    total: progress.total,
  })
}

/** The share surface. */
export function SharePage(props: OpenShareWindowOptions): ReactNode {
  const { workspaceId, face } = props
  const [direction, setDirection] = useState<'export' | 'import'>('export')
  const [packs, setPacks] = useState<readonly CluePack[]>([])
  const [selectedPacks, setSelectedPacks] = useState<ReadonlySet<string>>(
    () => new Set(props.packIds ?? []),
  )
  const [mode, setMode] = useState<CluepackMode>('snapshot')
  const [preview, setPreview] = useState<ShareExportPreview | null>(null)
  const [inspection, setInspection] = useState<ShareExportInspection | null>(null)
  const [progress, setProgress] = useState<ShareProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const [fileName, setFileName] = useState<string | null>(null)
  const [importBytes, setImportBytes] = useState<Uint8Array | null>(null)
  const [importPreview, setImportPreview] = useState<ShareImportPreview | null>(null)
  const [importResult, setImportResult] = useState<ShareImportResult | null>(null)
  const abortRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    let active = true
    void face.api.packsList(workspaceId).then((result) => {
      if (active) setPacks(result.packs)
    }).catch(() => { /* the picker stays empty; the UI still explains what to do */ })
    return () => {
      active = false
      abortRef.current?.abort()
    }
  }, [face, workspaceId])

  const cancel = useCallback((): void => {
    abortRef.current?.abort()
    abortRef.current = undefined
    setBusy(false)
  }, [])

  const togglePack = (packId: string): void => {
    setSelectedPacks((current) => {
      const next = new Set(current)
      if (next.has(packId)) next.delete(packId)
      else next.add(packId)
      return next
    })
    setPreview(null)
    setInspection(null)
  }

  const packIds = useMemo(() => [...selectedPacks], [selectedPacks])

  const runPreview = useCallback(async (): Promise<void> => {
    if (packIds.length === 0) {
      setFailure(t('clueSharePreviewEmpty'))
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setFailure(null)
    setMessage(null)
    try {
      const next = await previewShareExport({ workspaceId, mode, packIds, signal: controller.signal })
      if (controller.signal.aborted) return
      setPreview(next)
      setInspection(null)
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorLine(error))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [packIds, workspaceId, mode])

  const runInspect = useCallback(async (): Promise<void> => {
    if (packIds.length === 0) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setFailure(null)
    try {
      const next = await inspectShareExport({ workspaceId, mode, packIds, signal: controller.signal })
      if (controller.signal.aborted) return
      setInspection(next)
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorLine(error))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [packIds, workspaceId, mode])

  const runExport = useCallback(async (): Promise<void> => {
    if (packIds.length === 0) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setFailure(null)
    setMessage(null)
    setProgress(null)
    try {
      const result = await exportShareArchive({
        workspaceId,
        mode,
        packIds,
        signal: controller.signal,
        onProgress: (value) => { setProgress(value) },
      })
      if (controller.signal.aborted) return
      downloadShareArchive(result)
      setMessage(result.complete
        ? t('clueShareDone')
        : `${t('clueShareDone')} · ${t('clueSharePartial', { n: result.issues })}`)
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorLine(error))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
      setProgress(null)
    }
  }, [packIds, workspaceId, mode])

  const chooseFile = useCallback(async (file: File): Promise<void> => {
    setImportBytes(null)
    setImportPreview(null)
    setImportResult(null)
    setFailure(null)
    setMessage(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      setFileName(file.name)
      setImportBytes(bytes)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setBusy(true)
      const next = await previewShareImport({ workspaceId, bytes, signal: controller.signal })
      if (controller.signal.aborted) return
      setImportPreview(next)
    } catch (error) {
      if ((error as { name?: string } | undefined)?.name === 'AbortError') return
      setFailure(error instanceof ShareClientError ? errorLine(error) : t('clueShareInvalidFile'))
    } finally {
      setBusy(false)
    }
  }, [workspaceId])

  const runImport = useCallback(async (): Promise<void> => {
    if (importBytes === null) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setFailure(null)
    setMessage(null)
    try {
      const result = await importShareArchive({
        workspaceId,
        bytes: importBytes,
        signal: controller.signal,
        onProgress: (value) => { setProgress(value) },
      })
      if (controller.signal.aborted) return
      setImportResult(result)
      setMessage(result.requiresAcceptance
        ? t('clueSharePartial', { n: result.reasons.length })
        : result.cancelled ? t('clueShareCancelled') : t('clueShareDone'))
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorLine(error))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
      setProgress(null)
    }
  }, [importBytes, workspaceId])

  return (
    <div className={css.root} data-clue-share-window>
      <div className={css.tabs} role="tablist" aria-label={t('clueShareTitle')}>
        <button
          type="button"
          role="tab"
          aria-selected={direction === 'export'}
          className={css.tab}
          data-active={direction === 'export' ? 'true' : 'false'}
          onClick={() => { setDirection('export') }}
        >
          {t('clueShareExport')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={direction === 'import'}
          className={css.tab}
          data-active={direction === 'import' ? 'true' : 'false'}
          onClick={() => { setDirection('import') }}
        >
          {t('clueShareImport')}
        </button>
      </div>

      {direction === 'export' ? (
        <div className={css.body}>
          <p className={css.hint}>{t('clueShareExportHint')}</p>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('clueShareMode')}</span>
            <select
              className={css.select}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as CluepackMode)
                setPreview(null)
                setInspection(null)
              }}
            >
              <option value="snapshot">{t('clueShareModeSnapshot')}</option>
              <option value="references">{t('clueShareModeReference')}</option>
            </select>
          </label>

          <div className={css.field}>
            <span className={css.fieldLabel}>{t('clueSharePacks')}</span>
            {packs.length === 0
              ? <span className={css.hint}>{t('clueBrowserNoPacks')}</span>
              : (
                <ul className={css.packPicker}>
                  {packs.map(pack => (
                    <li key={pack.id}>
                      <label className={css.packRow}>
                        <input
                          type="checkbox"
                          checked={selectedPacks.has(pack.id)}
                          onChange={() => { togglePack(pack.id) }}
                        />
                        <span className={css.packName}>{pack.name}</span>
                        <span className={css.packCount}>{t('cluePacksMembers', { n: pack.members.length })}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
          </div>

          <div className={css.actions}>
            <button type="button" className={css.action} disabled={busy} onClick={() => { void runPreview() }}>
              {t('clueSharePreview')}
            </button>
            <button type="button" className={css.action} disabled={busy || preview === null} onClick={() => { void runInspect() }}>
              {t('clueShareInspect')}
            </button>
            <button type="button" className={css.primary} disabled={busy || preview === null} onClick={() => { void runExport() }}>
              <IconDownloadOutlineRegular size={14} />
              {t('clueShareExportAction')}
            </button>
            {busy && (
              <button type="button" className={css.action} onClick={cancel}>
                <IconCloseOutlineRegular size={14} />
                {t('cancel')}
              </button>
            )}
          </div>

          {progress !== null && <div className={css.progress} role="status">{progressLine(progress)}</div>}

          {preview !== null && (
            <section className={css.summary} aria-label={t('clueSharePreview')}>
              <div className={css.summaryRow}>
                <span>{t('clueSharePackCount', { n: preview.totals.packs })}</span>
                <span>{t('clueShareItems', { n: preview.totals.clues })}</span>
                <span>{t('clueShareSources', { n: preview.totals.sources })}</span>
              </div>
              {preview.warnings.length > 0 && (
                <ul className={css.warningList}>
                  {preview.warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              {inspection !== null && (
                <ul className={css.itemList}>
                  {inspection.items.map(item => (
                    <li key={item.clueId} className={css.itemRow}>
                      <span className={css.itemTitle}>{item.title}</span>
                      <span className={css.itemMeta}>
                        {item.portable.portable
                          ? `${item.sourceId} · ${t('clueSharePortable')}`
                          : `${item.sourceId} · ${item.portable.reason ?? t('clueShareNotPortable')}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      ) : (
        <div className={css.body}>
          <p className={css.hint}>{t('clueShareImportHint')}</p>
          <label className={css.fileRow}>
            <span className={css.fieldLabel}>{t('clueShareChooseFile')}</span>
            <input
              type="file"
              accept=".cluepack,application/zip"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file !== undefined) void chooseFile(file)
              }}
            />
            <span className={css.hint}>{fileName ?? t('clueShareNoFile')}</span>
          </label>

          {importPreview !== null && (
            <section className={css.summary} aria-label={t('clueSharePreview')}>
              <div className={css.summaryRow}>
                <span>{t('clueSharePackCount', { n: importPreview.packs.length })}</span>
                <span>{t('clueShareItems', { n: importPreview.items.length })}</span>
                <span>{t('clueShareSnapshots', { n: importPreview.snapshotCount })}</span>
                <span>{t('clueShareUnresolved', { n: importPreview.unresolvedCount })}</span>
              </div>
              {importPreview.missingSources.length > 0 && (
                <div className={css.warningLine}>
                  {t('clueShareMissingSources', { sources: importPreview.missingSources.join(', ') })}
                </div>
              )}
              {importPreview.warnings.length > 0 && (
                <ul className={css.warningList}>
                  {importPreview.warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              <ul className={css.itemList}>
                {importPreview.items.map(item => (
                  <li key={item.key} className={css.itemRow} data-unresolved={item.willBeUnresolved ? 'true' : 'false'}>
                    <span className={css.itemTitle}>{item.title}</span>
                    <span className={css.itemMeta}>
                      {item.sourceId}
                      {item.snapshot ? ` · ${t('clueShareSnapshotRow')}` : ''}
                      {item.willBeUnresolved ? ` · ${item.unresolvedReason ?? t('clueShareNotPortable')}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className={css.actions}>
            <button type="button" className={css.primary} disabled={busy || importBytes === null} onClick={() => { void runImport() }}>
              {t('clueShareImportAction')}
            </button>
            {busy && (
              <button type="button" className={css.action} onClick={cancel}>
                <IconCloseOutlineRegular size={14} />
                {t('cancel')}
              </button>
            )}
          </div>

          {progress !== null && <div className={css.progress} role="status">{progressLine(progress)}</div>}

          {importResult !== null && (
            <section className={css.summary} aria-label={t('clueShareDone')}>
              <div className={css.summaryRow}>
                <span>{t('clueShareItems', { n: importResult.clues.length })}</span>
                <span>{t('clueSharePackCount', { n: importResult.packs.length })}</span>
                <span>{t('clueShareSnapshots', { n: importResult.snapshots.length })}</span>
              </div>
              {importResult.partial && (
                <div className={css.warningLine}>
                  {t('clueSharePartial', { n: importResult.reasons.length })}
                </div>
              )}
              {importResult.requiresAcceptance && (
                <div className={css.actions}>
                  <button type="button" className={css.action} onClick={() => { setImportResult(null); setMessage(t('clueShareAcceptPartial')) }}>
                    {t('clueShareAcceptPartial')}
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {message !== null && <div className={css.done} role="status">{message}</div>}
      {failure !== null && <div className={css.error} role="alert">{failure}</div>}
      <div className={css.foot}>
        <button type="button" className={css.action} onClick={() => { cancel(); setFailure(null); setMessage(null) }}>
          <IconRefreshOutlineRegular size={14} />
          {t('clueShareReset')}
        </button>
      </div>
    </div>
  )
}
