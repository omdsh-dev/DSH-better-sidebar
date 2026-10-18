/**
 * The read-only paged preview for a file above the editable threshold.
 *
 * Two row shapes share one accumulator ({@link useTextPager}):
 *
 * - `jsonl` — one row per record, collapsed to a one-line summary and
 *   expandable into the host's `JsonTree`. A page is line-aligned, so a page is
 *   exactly a run of whole records.
 * - everything else — one row per line, monospace, no wrapping (horizontal
 *   scroll), which is the log-viewer shape.
 *
 * Scrolling is APPEND-ONLY, like VS Code's output/log view: reaching the bottom
 * pulls the next window and keeps everything already read on screen. There is
 * also an explicit "load all" in the notice bar, for a reader who wants the
 * whole thing up front rather than scroll-hunting for it.
 *
 * The one thing VS Code does not need and this does: a ROW CAP. Its `TextModel`
 * and its view are virtualized, so it can append a gigabyte into the model and
 * still keep the DOM small; this renders real elements. {@link MAX_PREVIEW_ROWS}
 * is therefore where appending stops and the reader is pointed at the download —
 * a visible ceiling beats a frozen tab, and it sits far above any log a person
 * reads in a side panel.
 *
 * Nothing here fetches the document: the file is above the editor's limit
 * precisely because holding it whole is what we are avoiding.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react'
import clsx from 'clsx'
import { IconRefreshOutlineRegular, JsonTree, type JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import { downloadUrl } from './api.ts'
import { formatByteSize, MAX_EDITABLE_BYTES, MAX_EDITABLE_LABEL } from '../editor-limits.ts'
import { isJsonlPath, isTreeRecord, parseRecord, summarizeRecord } from './jsonl.ts'
import { splitLines, useTextPager } from './text-pages.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/**
 * How many rows the preview will append before it stops and points at the
 * download instead.
 *
 * This is a DOM budget, not a byte budget: the rows are real elements, and one
 * page of short JSONL lines is a few thousand of them. 50k keeps the worst case
 * (a JSONL log read end to end) at a couple of seconds of layout while still
 * covering any file a person reads in a side panel — the 6 MB reference log
 * lands around 35k records, comfortably inside it.
 */
export const MAX_PREVIEW_ROWS = 50_000

/** Distance from the bottom (px) at which the next page is pulled. */
const APPEND_THRESHOLD_PX = 320

/** Copy the host's `JsonTree` needs; this plugin owns the wording. */
function jsonLabels(): JsonTreeLabels {
  return {
    // The tree's primitive/compact copy actions are the same gesture as the
    // code block's copy, so they reuse that wording rather than inventing a
    // second vocabulary for the same button.
    copyValue: t('copy'),
    copyJson: t('copy'),
    copyPath: t('jsonCopyPath'),
    copyPrettyJson: t('jsonCopyPrettyJson'),
    copyCompactJson: t('jsonCopyCompactJson'),
    copied: t('copied'),
    copyFailed: t('jsonCopyFailed'),
    collapseNode: t('jsonCollapseNode'),
    expandNode: t('jsonExpandNode'),
    copyButtonTitle: (action) => t('jsonCopyButtonTitle', { action }),
  }
}

/**
 * The read-only preview of one over-limit file.
 *
 * @param props.scope - the session scope.
 * @param props.path - the file being previewed.
 * @param props.size - the file's size in bytes (from the read that refused it).
 * @param props.visible - whether the tab is on screen; a parked tab stops reading.
 * @param props.revision - bumped by the host's refresh to restart from page one.
 * @param props.maxRows - row ceiling (defaults to {@link MAX_PREVIEW_ROWS}).
 * @returns the preview.
 */
export function LargeFileView(props: {
  scope: SessionScope
  path: string
  size: number
  visible: boolean
  revision: number
  maxRows?: number
}): ReactNode {
  const { scope, path, size, visible, revision } = props
  const maxRows = props.maxRows ?? MAX_PREVIEW_ROWS
  // The row ceiling is the HOOK's argument, not something this component
  // enforces from its own rendered row count: while `loadAll` walks pages, a
  // render-fresh count lags by however many pages React has not flushed.
  const pager = useTextPager(scope, path, visible, revision, maxRows)
  const records = isJsonlPath(path)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** Absolute record/line numbers the reader expanded (survives appends). */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const labels = useMemo(() => jsonLabels(), [])

  /**
   * Whether this file is over the EDITABLE threshold — a different question
   * from "is this view paged".
   *
   * A small `.jsonl` opens straight into this record list as its PREVIEW, and
   * announcing "the file is too large, paged preview only" over a 2 KB file
   * would be a lie. The threshold decides, not the component.
   */
  const tooLarge = size > MAX_EDITABLE_BYTES

  const rows = useMemo(() => pager.pages.map(splitLines), [pager.pages])
  const totalRows = useMemo(() => rows.reduce((sum, page) => sum + page.length, 0), [rows])

  /** Pull the next page unless there is nothing left to pull. */
  const maybeLoadMore = useCallback((): void => {
    if (pager.atEnd || pager.atCap || pager.loadingAll) return
    pager.loadMore()
  }, [pager])

  // Fill the viewport: a page that does not reach the bottom leaves nothing to
  // scroll, so the scroll handler would never fire and the reader would sit in
  // front of a half-empty pane. Re-checking after each append makes a short file
  // load in as many pages as it takes to overflow — and stop at EOF.
  useEffect(() => {
    const el = bodyRef.current
    if (el === null || !visible) return
    if (el.scrollHeight <= el.clientHeight + 8) maybeLoadMore()
  }, [visible, pager.pages.length, pager.atEnd, pager.atCap, maybeLoadMore])

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= APPEND_THRESHOLD_PX) maybeLoadMore()
  }

  const toggle = useCallback((number: number): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(number)) next.delete(number)
      else next.add(number)
      return next
    })
  }, [])

  const firstNumber = pager.lineStarts[0] ?? 1
  const lastNumber = Math.max(firstNumber, firstNumber + totalRows - 1)
  /** The footer only means something while there is more to come, or once more
   *  than one window has arrived (a single-page file needs no commentary). */
  const showFooter = !pager.atEnd || pager.pages.length > 1

  return (
    <div className={css.largeFile}>
      {tooLarge && (
        <div className={css.largeFileNotice}>
          <span>{t('previewOnlyNotice', { size: formatByteSize(size), limit: MAX_EDITABLE_LABEL })}</span>
          <button
            type="button"
            className={css.largeFileNoticeAction}
            disabled={pager.atEnd || pager.atCap || pager.loadingAll}
            title={pager.atCap ? t('previewRowLimit', { rows: maxRows }) : undefined}
            onClick={pager.loadAll}
          >
            {pager.loadingAll
              ? t('loadAllProgress', {
                loaded: formatByteSize(pager.loadedBytes),
                total: formatByteSize(size),
              })
              : t('loadAll')}
          </button>
          <a className={css.largeFileDownload} href={downloadUrl(scope, path)} download>
            {t('downloadToView')}
          </a>
        </div>
      )}
      {pager.atCap && (
        <div className={css.editorBanner}>{t('previewRowLimit', { rows: maxRows })}</div>
      )}
      <div
        className={clsx(css.largeFileBody, records && css.largeFileRecords)}
        ref={bodyRef}
        onScroll={onScroll}
      >
        {pager.error !== null && <div className={css.editorError}>{pager.error}</div>}
        {pager.error === null && pager.loading && pager.pages.length === 0 && (
          <div className={css.editorPlaceholder}>{t('loading')}</div>
        )}
        {pager.error === null && pager.pages.length > 0 && records && (
          <ol className={css.largeFileList} start={firstNumber}>
            {rows.flatMap((lines, pageIndex) => {
              const start = pager.lineStarts[pageIndex] ?? 1
              return lines.map((line, rowIndex) => {
                const number = start + rowIndex
                return (
                  <RecordRow
                    key={number}
                    number={number}
                    line={line}
                    expanded={expanded.has(number)}
                    labels={labels}
                    onToggle={toggle}
                  />
                )
              })
            })}
          </ol>
        )}
        {pager.error === null && pager.pages.length > 0 && !records && (
          <div className={css.largeFileLines}>
            {rows.flatMap((lines, pageIndex) => {
              const start = pager.lineStarts[pageIndex] ?? 1
              return lines.map((line, rowIndex) => (
                <div className={css.largeFileLine} key={`${pageIndex}:${rowIndex}`}>
                  <span className={css.largeFileLineNo} aria-hidden="true">{start + rowIndex}</span>
                  <span className={css.largeFileLineText}>{line === '' ? '\u00a0' : line}</span>
                </div>
              ))
            })}
          </div>
        )}
        {pager.error === null && pager.atEnd && totalRows === 0 && !pager.loading && (
          <div className={css.editorPlaceholder}>{t('largeFileEmpty')}</div>
        )}
      </div>
      {showFooter && (
        <div className={css.largeFilePager}>
          <span className={css.largeFilePageLabel}>
            {records
              ? t('jsonlRecordRange', { from: firstNumber, to: lastNumber })
              : t('pagedLineRange', { from: firstNumber, to: lastNumber })}
            {' · '}
            {`${formatByteSize(pager.loadedBytes)} / ${formatByteSize(size)}`}
          </span>
          {pager.loading && !pager.loadingAll && <span className={css.largeFilePageLabel}>{t('loading')}</span>}
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={pager.reload}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * One JSONL record row: a summary line, expanding into the host's JSON tree.
 *
 * Memoized because appending a page re-renders the whole list: without this,
 * every already-mounted record would be reconciled again on each append, and the
 * list is expected to grow into the tens of thousands. The record is parsed here
 * (rather than by the caller) so the parent's `flatMap` only builds elements.
 */
const RecordRow = memo(function RecordRow(props: {
  number: number
  /** The raw line, shown verbatim when the record does not parse. */
  line: string
  expanded: boolean
  labels: JsonTreeLabels
  onToggle: (number: number) => void
}): ReactNode {
  const { number, line, expanded, labels, onToggle } = props
  const record = useMemo(() => parseRecord(line), [line])
  if (!record.ok) {
    // A blank line is not a broken record — JSONL files normally end with one,
    // and the host's pages are line-aligned, so it lands as its own row.
    if (record.error === '') return null
    return (
      <li className={clsx(css.largeFileRecord, css.largeFileRecordInvalid)}>
        <span className={css.largeFileRecordNo} aria-hidden="true">{number}</span>
        <div className={css.largeFileRecordBody}>
          <div className={css.largeFileRecordSummary}>{t('jsonlInvalidRecord')}</div>
          <pre className={css.largeFileRecordRaw}>{line}</pre>
        </div>
      </li>
    )
  }
  const value = record.value
  const tree = isTreeRecord(value)
  return (
    <li className={clsx(css.largeFileRecord, expanded && css.largeFileRecordExpanded)}>
      <span className={css.largeFileRecordNo} aria-hidden="true">{number}</span>
      <div className={css.largeFileRecordBody}>
        <button
          type="button"
          className={css.largeFileRecordSummary}
          aria-expanded={tree ? expanded : undefined}
          disabled={!tree}
          onClick={() => { onToggle(number) }}
        >
          {summarizeRecord(value)}
        </button>
        {tree && expanded && (
          <div className={css.largeFileRecordTree}>
            <JsonTree data={value} label={`#${number}`} labels={labels} copyable expandTopLevel />
          </div>
        )}
      </div>
    </li>
  )
})
