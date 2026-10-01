/**
 * The session lens of the changes tab: agent truth — every file the model
 * read, wrote, or edited in this session, grouped by file, newest first,
 * with kind filters. Clicking an op previews it in the tab's shared bottom
 * pane (see {@link DiffPane}): writes and edits as line diffs, reads as a
 * line-numbered content view, failures as their real error text. The ops
 * arrive pre-folded from the tab (which owns the event poll); this
 * component is purely presentational.
 */
import { useMemo, useState } from 'react'
import { relativeTime, t } from '../locales.ts'
import { groupByFile, type FileOp, type FileOpKind } from './ops.ts'
import { formatBytes } from '../diff/rows.ts'
import { Chip, Notice, StatusBadge } from '../ui/index.ts'
import css from './changes.module.css'

/** The op-kind filter chips: 'all' or one concrete kind. */
type OpFilter = 'all' | FileOpKind

const KIND_LABEL = { read: 'changesRead', write: 'changesWrite', edit: 'changesEdit' } as const

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
        <Chip active={filter === 'all'} count={ops.length} onClick={() => { setFilter('all') }}>
          {t('changesFilterAll')}
        </Chip>
        {(['write', 'edit', 'read'] as const).map(kind => (
          <Chip
            key={kind}
            active={filter === kind}
            count={counts.get(kind) ?? 0}
            onClick={() => { setFilter(kind) }}
          >
            {t(KIND_LABEL[kind])}
          </Chip>
        ))}
      </div>
      <div className={css.sessionList}>
        {loadError && <Notice kind="error" role="alert">{t('changesLoadError')}</Notice>}
        {ops.length === 0 && !loadError && <Notice kind="empty" tone="page">{t('changesSessionEmpty')}</Notice>}
        {ops.length > 0 && filteredOps.length === 0 && <Notice kind="empty" tone="page">{t('changesFilterEmpty')}</Notice>}
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
                <StatusBadge tone={op.kind}>{t(KIND_LABEL[op.kind])}</StatusBadge>
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
