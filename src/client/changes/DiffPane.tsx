/**
 * The changes tab's shared bottom preview pane: one selected target — a git
 * worktree change, a commit patch, or a session file op — rendered through
 * the unified diff stack (the same one the diff tab uses). Git targets load
 * on demand (refreshable, with the untracked full-addition fallback); op
 * targets are pure snapshots (diff / read view / error text). The pane is
 * resizable by drag (clamped; the height commits to the tab's persisted
 * meta on release) and by keyboard; git targets can expand into a dedicated
 * diff tab via the shell.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { IconCloseOutline16, IconRefreshOutline16, IconRightUpOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from '../api.ts'
import { api } from '../api.ts'
import { t } from '../locales.ts'
import { baseName } from '../paths.ts'
import { resolveSidebarPath } from '../produced-files.ts'
import type { SidebarDiffRef, SidebarTab } from '../state.ts'
import { DiffRows, ReadRows } from '../diff/DiffRows.tsx'
import { DiffFiles } from '../diff/DiffFiles.tsx'
import { langOfPath } from '../diff/highlight.ts'
import { buildDiffSegments, diffLines, diffStats, parseUnifiedDiff, unifiedSegments, type DiffRow } from '../diff/rows.ts'
import { parseReadLines, type FileOp } from './ops.ts'
import { createFrameBatcher } from '../frame-batcher.ts'
import css from './changes.module.css'
import diffCss from '../diff/diff.module.css'

/** The drag handle height clamp (px) and keyboard-resize step. */
const HEIGHT_MIN = 140
const HEIGHT_STEP = 24

/** What the pane is showing right now. */
export type ChangesPreview =
  | { kind: 'git'; ref: SidebarDiffRef }
  | { kind: 'op'; path: string; op: FileOp; prior?: string }

/** Diff material for one op snapshot: an edit reconstructs the full file
 *  from the window's known prior content when possible (hunk-style context);
 *  a write with unknown prior content renders all-added. */
function diffOf(op: FileOp, prior: string | undefined): readonly DiffRow[] {
  if (op.kind === 'read') return []
  if (op.kind === 'edit' && op.edit !== undefined) {
    const { oldString, newString } = op.edit
    if (prior !== undefined && prior.includes(oldString)) {
      const newFile = prior.replace(oldString, newString)
      return diffLines(prior, newFile)
    }
    return diffLines(oldString, newString)
  }
  if (op.kind === 'write') {
    const content = op.content ?? ''
    const old = prior !== undefined && prior !== content ? prior : undefined
    return diffLines(old ?? '', content)
  }
  return []
}

/** The diff tab a git preview expands into (the shell owns placement). */
export function diffTabOf(ref: SidebarDiffRef): SidebarTab {
  if (ref.kind === 'worktree') {
    return {
      id: `diff:w:${encodeURIComponent(ref.worktree ?? '')}:${ref.staged ? 's' : 'u'}:${ref.path}`,
      type: 'diff',
      title: baseName(ref.path),
      diff: ref,
    }
  }
  return {
    id: `diff:c:${encodeURIComponent(ref.worktree ?? '')}:${ref.hashFull}`,
    type: 'diff',
    title: `${ref.hash} ${ref.subject}`,
    diff: ref,
  }
}

export interface DiffPaneProps {
  target: ChangesPreview
  scope: SessionScope
  /** The persisted pane height (px); drag commits a new one upwards. */
  height: number
  onHeightCommit: (height: number) => void
  onClose: () => void
  /** Expand the current git target into a dedicated diff tab. */
  onExpand: () => void
}

export function DiffPane({ target, scope, height, onHeightCommit, onClose, onExpand }: DiffPaneProps) {
  // ── Git target loading (mirrors the diff tab: staged-side fallback, the
  //    untracked full-addition fallback, refresh by tick). ─────────────────
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(target.kind === 'git')
  const [error, setError] = useState<string | null>(null)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [untracked, setUntracked] = useState<string | undefined>(undefined)
  const gitRef = target.kind === 'git' ? target.ref : null

  useEffect(() => {
    if (gitRef === null) return
    let cancelled = false
    const paneScope: SessionScope = {
      sessionId: scope.sessionId,
      cwd: scope.cwd,
      ...(gitRef.repoRoot !== undefined ? { repoRoot: gitRef.repoRoot } : {}),
    }
    setLoading(true)
    setError(null)
    setDiffText(null)
    setUntracked(undefined)
    const load = async (): Promise<void> => {
      try {
        if (gitRef.kind === 'commit') {
          const result = await api.gitCommitDiff(paneScope, gitRef.hashFull, gitRef.worktree)
          if (!cancelled) setDiffText(result.diff)
          return
        }
        let result = await api.gitDiff(paneScope, gitRef.path, gitRef.staged, gitRef.worktree)
        if (result.diff === '') {
          // The requested side is empty — try the OTHER side once (the change
          // may have moved sides after the preview target was minted).
          const other = await api.gitDiff(paneScope, gitRef.path, !gitRef.staged, gitRef.worktree)
          if (other.diff !== '') result = other
        }
        if (result.diff !== '') {
          if (!cancelled) setDiffText(result.diff)
          return
        }
        // Empty diff: an untracked file (git diff never lists it) falls back
        // to a full-file addition from its content.
        if (gitRef.untracked === true && !gitRef.staged) {
          const text = await api.fsRead(paneScope, resolveSidebarPath(gitRef.repoRoot ?? gitRef.worktree ?? scope.cwd, gitRef.path))
          if (!cancelled && text.kind === 'text') {
            setDiffText('')
            setUntracked(text.content)
          }
          return
        }
        if (!cancelled) setDiffText('')
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [gitRef, scope.sessionId, scope.cwd, tick])

  // ── Op target material (pure snapshots; the prior content came with the
  //    target so a running op shows what is already known). ────────────────
  const op = target.kind === 'op' ? target.op : null
  const prior = target.kind === 'op' ? target.prior : undefined
  const opLang = useMemo(() => (target.kind === 'op' ? langOfPath(target.path) : undefined), [target])
  const opRows = useMemo(() => (op === null ? [] : diffOf(op, prior)), [op, prior])
  const opSegments = useMemo(() => buildDiffSegments(opRows), [opRows])
  const opStats = useMemo(() => diffStats(opSegments), [opSegments])
  const opReadLines = useMemo(
    () => (op?.kind === 'read' && op.read !== undefined ? parseReadLines(op.read) : []),
    [op],
  )

  // Header stats for git targets come off the parsed patch text.
  const gitStats = useMemo(() => {
    if (target.kind !== 'git' || diffText === null || diffText === '') return null
    let added = 0
    let deleted = 0
    for (const file of parseUnifiedDiff(diffText).files) {
      const stats = diffStats(unifiedSegments(file))
      added += stats.added
      deleted += stats.deleted
    }
    return { added, deleted }
  }, [target, diffText])

  // ── Resize: drag the top handle; commit on release (persisted by the
  //    shell). Arrow keys resize by a step for keyboard users. ────────────
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const paneHeight = dragHeight ?? height
  const clamp = (value: number): number => Math.min(Math.max(value, HEIGHT_MIN), Math.round(window.innerHeight * 0.7))
  const dragOrigin = useRef<{ y: number; h: number } | null>(null)
  // Pointer streams fire several times per frame; one setState per event
  // re-rendered the whole pane at event cadence (see frame-batcher).
  const dragBatcher = useRef(createFrameBatcher()).current
  useEffect(() => () => dragBatcher.dispose(), [dragBatcher])
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragOrigin.current = { y: event.clientY, h: paneHeight }
    const onMove = (ev: PointerEvent): void => {
      if (dragOrigin.current === null) return
      const next = clamp(dragOrigin.current.h + (dragOrigin.current.y - ev.clientY))
      dragBatcher.schedule(() => { setDragHeight(next) })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragOrigin.current = null
      dragBatcher.flushNow()
      setDragHeight(current => {
        if (current !== null) onHeightCommit(current)
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const title = target.kind === 'op'
    ? target.path
    : target.ref.kind === 'worktree' ? target.ref.path : `${target.ref.hash} ${target.ref.subject}`
  const stats = gitStats ?? (target.kind === 'op' && op !== null && op.kind !== 'read' && !op.isError ? opStats : null)

  return (
    <div className={css.diffPane} style={{ height: paneHeight }}>
      <div
        className={css.dragHandle}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('changesResizePreview')}
        tabIndex={0}
        onPointerDown={onHandleDown}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') { event.preventDefault(); onHeightCommit(clamp(paneHeight + HEIGHT_STEP)) }
          if (event.key === 'ArrowDown') { event.preventDefault(); onHeightCommit(clamp(paneHeight - HEIGHT_STEP)) }
        }}
      />
      <div className={css.diffHead}>
        {target.kind === 'op' && (
          <span className={css.diffKind} data-kind={target.op.kind}>
            {t(target.op.kind === 'read' ? 'changesRead' : target.op.kind === 'write' ? 'changesWrite' : 'changesEdit')}
          </span>
        )}
        {target.kind === 'git' && target.ref.kind === 'worktree' && (
          <span className={css.diffKind} data-kind="git">{target.ref.staged ? t('staged') : t('unstaged')}</span>
        )}
        {target.kind === 'git' && target.ref.kind === 'commit' && (
          <span className={css.diffKind} data-kind="git">{target.ref.hash}</span>
        )}
        <span className={css.diffPath} title={title}>{title}</span>
        {stats !== null && (stats.added > 0 || stats.deleted > 0) && (
          <span className={css.diffStats}>
            {stats.added > 0 && <span className={diffCss.statAdd}>+{String(stats.added)}</span>}
            {stats.deleted > 0 && <span className={diffCss.statDel}>−{String(stats.deleted)}</span>}
          </span>
        )}
        {target.kind === 'git' && (
          <>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('refresh')}
              title={t('refresh')}
              disabled={loading}
              onClick={() => { setTick(value => value + 1) }}
            >
              <IconRefreshOutline16 size={14} />
            </button>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('changesOpenDiffTab')}
              title={t('changesOpenDiffTab')}
              onClick={onExpand}
            >
              <IconRightUpOutline16 size={14} />
            </button>
          </>
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('changesClosePreview')}
          title={t('changesClosePreview')}
          onClick={onClose}
        >
          <IconCloseOutline16 size={14} />
        </button>
      </div>
      {target.kind === 'op' && op !== null && op.isError
        ? (
          <div className={css.paneBody}>
            <div className={css.readError} role="alert">
              {op.errorText ?? t('changesError')}
            </div>
          </div>
        )
        : target.kind === 'op' && op !== null && op.kind === 'read'
          ? (
            <div className={css.paneBody}>
              <ReadRows lines={opReadLines} lang={opLang} />
            </div>
          )
          : target.kind === 'op'
            ? (
              <div className={css.paneBody}>
                {op !== null && op.kind === 'write'
                  && prior === undefined
                  && <div className={css.priorUnknown}>{t('changesPriorUnknown')}</div>}
                <DiffRows key={target.op.callId} segments={opSegments} lang={opLang} />
              </div>
            )
            : loading
              ? <div className={css.paneBody}><div className={css.gitPlaceholder}>{t('loading')}</div></div>
              : error !== null
                ? <div className={css.paneBody}><div className={css.gitError}>{t('diffLoadError')}: {error}</div></div>
                : (
                  <div className={css.paneBody}>
                    {diffText !== null && diffText !== '' && (
                      <DiffFiles
                        diff={diffText}
                        untrackedPath={untracked !== undefined && target.ref.kind === 'worktree' ? target.ref.path : undefined}
                        untrackedContent={untracked}
                      />
                    )}
                    {diffText === '' && untracked === undefined && (
                      <div className={css.gitEmpty}>{t('diffEmpty')}</div>
                    )}
                  </div>
                )}
    </div>
  )
}
