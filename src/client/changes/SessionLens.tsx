/**
 * The session lens of the changes tab: agent truth — every file the model
 * read, wrote, or edited in this session, grouped by file, newest first,
 * with kind filters. Clicking an op previews it in the tab's shared bottom
 * pane (see {@link DiffPane}): writes and edits as line diffs, reads as a
 * line-numbered content view, failures as their real error text. The ops
 * arrive pre-folded from the tab (which owns the event poll); this
 * component is purely presentational.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { relativeTime, t } from '../locales.ts'
import { groupByFile, type FileOp, type FileOpKind } from './ops.ts'
import { formatBytes } from '../diff/rows.ts'
import css from './changes.module.css'

/** The op-kind filter chips: 'all' or one concrete kind. */
type OpFilter = 'all' | FileOpKind

export interface SessionLensProps {
  /** The folded file operations, newest first (the tab's poll owns them). */
  ops: readonly FileOp[]
  /** Every poll failed and nothing loaded: an inline notice, not an empty
   *  state that would read as "no operations". */
  loadError: boolean
  /** Preview one op in the shared bottom pane. */
  onPreview: (path: string, op: FileOp) => void
  /** The op currently previewed (row highlight); null when the pane is closed. */
  selectedCallId: string | null
}

export function SessionLens({ ops, loadError, onPreview, selectedCallId }: SessionLensProps) {
  const [filter, setFilter] = useState<OpFilter>('all')
  const filteredOps = useMemo(
    () => (filter === 'all' ? ops : ops.filter(op => op.kind === filter)),
    [ops, filter],
  )
  const groups = useMemo(() => groupByFile(filteredOps), [filteredOps])
  const counts = useMemo(() => {
    const map = new Map<FileOpKind, number>([['read', 0], ['write', 0], ['edit', 0]])
    for (const op of ops) map.set(op.kind, (map.get(op.kind) ?? 0) + 1)
    return map
  }, [ops])

  const chip = (value: OpFilter, label: string, count: number): ReactNode => (
    <button
      type="button"
      key={value}
      className={css.filterChip}
      data-active={filter === value ? 'true' : undefined}
      onClick={() => { setFilter(value) }}
      aria-pressed={filter === value}
    >
      {label}{value !== 'all' ? ` ${String(count)}` : ''}
    </button>
  )

  // Sizing a row's content constructs a Blob (a UTF-8 encode of the whole
  // edit) — that was per row PER RENDER, re-encoding every field on every
  // poll tick. ops keeps its identity between unchanged polls (see the
  // tab's opsRef), so one pass per changed fold covers every render.
  const opSizes = useMemo(() => {
    const sizes = new Map<string, string>()
    for (const op of ops) {
      if (op.kind !== 'read' && !op.isError) {
        sizes.set(op.callId, formatBytes(new Blob([op.edit?.newString ?? op.content ?? '']).size))
      }
    }
    return sizes
  }, [ops])

  return (
    <div className={css.session}>
      <div className={css.filterRow} role="group" aria-label={t('changesSessionLens')}>
        {chip('all', t('changesFilterAll'), ops.length)}
        {chip('write', t('changesWrite'), counts.get('write') ?? 0)}
        {chip('edit', t('changesEdit'), counts.get('edit') ?? 0)}
        {chip('read', t('changesRead'), counts.get('read') ?? 0)}
      </div>
      <div className={css.sessionList}>
        {loadError && <div className={css.loadError}>{t('changesLoadError')}</div>}
        {ops.length === 0 && !loadError && <div className={css.empty}>{t('changesSessionEmpty')}</div>}
        {ops.length > 0 && filteredOps.length === 0 && <div className={css.empty}>{t('changesFilterEmpty')}</div>}
        {[...groups.entries()].map(([path, fileOps]) => (
          <div key={path} className={css.fileGroup}>
            <div className={css.filePath} title={path}>{path}</div>
            {fileOps.map(op => (
              <button
                type="button"
                key={op.callId}
                className={css.opRow}
                data-op-kind={op.kind}
                data-op-error={op.isError ? 'true' : undefined}
                data-selected={selectedCallId === op.callId ? 'true' : undefined}
                onClick={() => { onPreview(path, op) }}
              >
                <span className={css.opKind} data-kind={op.kind}>
                  {t(op.kind === 'read' ? 'changesRead' : op.kind === 'write' ? 'changesWrite' : 'changesEdit')}
                </span>
                {op.running && <span className={css.opFlag}>{t('changesRunning')}</span>}
                {op.isError && <span className={css.opFlagError}>{t('changesError')}</span>}
                <span className={css.opMeta}>
                  {opSizes.get(op.callId) !== undefined && (
                    <span className={css.opSize}>
                      {opSizes.get(op.callId)}
                    </span>
                  )}
                  <span className={css.opTime}>{relativeTime(new Date(op.time).toISOString())}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
