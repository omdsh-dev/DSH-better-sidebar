/**
 * The review panel: every file that differs from the last commit, in one list,
 * with the change visible inline and an Accept / Reject decision per file.
 *
 * This is deliberately NOT a second source-control panel. GitView answers
 * "what am I about to commit?" and splits a file into staged and unstaged
 * rows to help compose that commit. This answers "the agent just changed my
 * tree — what did it do, and do I want it?", so a file appears exactly once
 * and carries a decision instead of a section (see review-list.ts).
 *
 * Git is the safety net, which is why the panel is built on it rather than on
 * a snapshot of its own: the last commit already holds the pre-change copy of
 * every tracked file, so Reject can never destroy work that git was not
 * already able to restore.
 *
 * - Accept stages the file (`git add`). It stays staged and out of the queue.
 * - Reject returns the file to its committed state. A staged file is unstaged
 *   first, so Reject always means "back to the last commit" whether or not it
 *   was accepted earlier, rather than the weaker "back to the index".
 * - An UNTRACKED file has no committed version, so rejecting it would mean
 *   deleting it outright. There is no file-delete route in this plugin, and
 *   adding one for a button labelled Reject is not a trade worth making, so
 *   Reject is disabled on those rows and says why.
 *
 * The list polls while visible (the same 2s cadence GitView uses), so files
 * the agent writes appear without a manual refresh.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconRefreshOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitStatusResult, SessionScope } from './api.ts'
import { api } from './api.ts'
import { DiffView } from './DiffView.tsx'
import { diffStats, pendingCount, reviewFromStatus, untrackedStats, type DiffStats, type ReviewEntry } from './review-list.ts'
import { resolveSidebarPath } from './produced-files.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** How often the visible panel re-reads git status (mirrors GitView). */
const POLL_MS = 2_000

/** One row's loaded change. */
interface LoadedDiff {
  diff: string
  /** Full text for an untracked file, which `git diff` never covers. */
  untracked?: string
  stats: DiffStats
}

export interface ReviewViewProps {
  scope: SessionScope
  /** Poll only while the tab is actually visible. */
  visible: boolean
  onOpenFile?: (path: string) => void
}

export function ReviewView({ scope, visible, onOpenFile }: ReviewViewProps): ReactNode {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [diffs, setDiffs] = useState<Record<string, LoadedDiff>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ReviewEntry | null>(null)

  const entries = reviewFromStatus(status)
  const pending = pendingCount(entries)
  const root = status?.root ?? scope.cwd

  /** Re-read status. `quiet` is the poll path: it must not flash the spinner. */
  const refresh = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setLoading(true)
    try {
      const next = await api.gitStatus(scope)
      setStatus(next)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [scope])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => { void refresh(true) }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [visible, refresh])

  /**
   * Load one row's diff. Re-runs whenever the status snapshot changes, not
   * just on expand: the agent may write the same file again while the row is
   * open, and a cached diff would then show the reader a stale change.
   */
  const loadDiff = useCallback(async (entry: ReviewEntry): Promise<void> => {
    try {
      if (entry.untracked) {
        const text = await api.fsRead(scope, resolveSidebarPath(root, entry.path))
        const content = text.kind === 'text' ? text.content : ''
        setDiffs((prev) => ({
          ...prev,
          [entry.path]: { diff: '', untracked: content, stats: untrackedStats(content) },
        }))
        return
      }
      // Both halves: a staged-then-edited file's full change against the last
      // commit is the index diff plus the worktree diff, and showing only one
      // would hide half of what Reject is about to undo.
      const [unstaged, staged] = await Promise.all([
        api.gitDiff(scope, entry.path, false),
        entry.state === 'pending' ? Promise.resolve({ diff: '' }) : api.gitDiff(scope, entry.path, true),
      ])
      const combined = [staged.diff, unstaged.diff].filter((part) => part !== '').join('\n')
      setDiffs((prev) => ({ ...prev, [entry.path]: { diff: combined, stats: diffStats(combined) } }))
    } catch {
      // A row whose diff cannot be read still lists and still accepts/rejects;
      // it just shows no body. Failing the whole panel would be worse.
      setDiffs((prev) => ({ ...prev, [entry.path]: { diff: '', stats: { added: 0, removed: 0 } } }))
    }
  }, [scope, root])

  // Keep every OPEN row's diff current with the latest status snapshot.
  const statusKey = entries.map((entry) => `${entry.path}:${entry.xy}`).join('\n')
  const lastKey = useRef('')
  useEffect(() => {
    if (statusKey === lastKey.current) return
    lastKey.current = statusKey
    for (const entry of entries) {
      if (expanded.has(entry.path)) void loadDiff(entry)
    }
  }, [statusKey, expanded, entries, loadDiff])

  const toggle = (entry: ReviewEntry): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else { next.add(entry.path); void loadDiff(entry) }
      return next
    })
  }

  /** Run one decision, then re-read status so the row's state is truthful. */
  const run = async (path: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(path)
    try {
      await action()
      await refresh(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const accept = (entry: ReviewEntry): void => {
    void run(entry.path, () => api.gitStage(scope, entry.path))
  }

  /** Back to the last commit: unstage first so an accepted file really resets. */
  const reject = (entry: ReviewEntry): void => {
    void run(entry.path, async () => {
      if (entry.state !== 'pending') await api.gitUnstage(scope, entry.path)
      await api.gitDiscard(scope, entry.path)
    })
  }

  const acceptAll = (): void => {
    void run('*', () => api.gitStage(scope))
  }

  if (status !== null && !status.isRepo) {
    return <div className={css.reviewEmpty}>{t('reviewNoRepo')}</div>
  }

  return (
    <div className={css.reviewRoot}>
      <div className={css.reviewHeader}>
        <span className={css.reviewCount}>
          {pending === 0 ? t('noChanges') : t('reviewPending', { count: String(pending) })}
        </span>
        <div className={css.reviewHeaderActions}>
          <Button
            variant="outline"
            disabled={pending === 0 || busy !== null}
            onClick={acceptAll}
          >
            {t('acceptAll')}
          </Button>
          <button
            type="button"
            className={css.reviewIconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={() => { void refresh() }}
          >
            <IconRefreshOutline16 />
          </button>
        </div>
      </div>

      {error !== null && <div className={css.reviewError}>{error}</div>}
      {loading && status === null && <div className={css.reviewEmpty}>{t('loading')}</div>}
      {!loading && entries.length === 0 && <div className={css.reviewEmpty}>{t('noChanges')}</div>}

      <div className={css.reviewList}>
        {entries.map((entry) => {
          const loaded = diffs[entry.path]
          const open = expanded.has(entry.path)
          const rowBusy = busy === entry.path || busy === '*'
          return (
            <div key={entry.path} className={css.reviewItem} data-state={entry.state}>
              <div className={css.reviewRow}>
                <button
                  type="button"
                  className={css.reviewDisclosure}
                  aria-expanded={open}
                  aria-label={entry.path}
                  onClick={() => { toggle(entry) }}
                >
                  <span className={css.reviewBadge} data-state={entry.state}>{entry.xy.trim() || 'M'}</span>
                  <span className={css.reviewPath} title={entry.path}>
                    {relativeTo(root ?? '', resolveSidebarPath(root, entry.path))}
                  </span>
                  {loaded !== undefined && (
                    <span className={css.reviewStats}>
                      <span className={css.reviewAdded}>+{loaded.stats.added}</span>
                      <span className={css.reviewRemoved}>-{loaded.stats.removed}</span>
                    </span>
                  )}
                </button>
                <div className={css.reviewActions}>
                  {entry.state === 'accepted'
                    ? <span className={css.reviewAcceptedTag}>{t('reviewAccepted')}</span>
                    : (
                      <button
                        type="button"
                        className={css.reviewAccept}
                        disabled={rowBusy}
                        title={t('accept')}
                        onClick={() => { accept(entry) }}
                      >
                        {t('accept')}
                      </button>
                    )}
                  <button
                    type="button"
                    className={css.reviewReject}
                    disabled={rowBusy || entry.untracked}
                    title={entry.untracked ? t('rejectUntracked') : t('reject')}
                    onClick={() => { setConfirm(entry) }}
                  >
                    {t('reject')}
                  </button>
                </div>
              </div>
              {open && (
                <div className={css.reviewDiff}>
                  {loaded === undefined
                    ? <div className={css.reviewEmpty}>{t('loading')}</div>
                    : (
                      <DiffView
                        diff={loaded.diff}
                        {...(loaded.untracked !== undefined
                          ? { untrackedPath: entry.path, untrackedContent: loaded.untracked }
                          : {})}
                      />
                    )}
                  {onOpenFile !== undefined && (
                    <button
                      type="button"
                      className={css.reviewOpen}
                      onClick={() => { onOpenFile(resolveSidebarPath(root, entry.path)) }}
                    >
                      {t('openEditor')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Reject throws work away, so it lands here first. */}
      <Modal
        open={confirm !== null}
        onClose={() => { setConfirm(null) }}
        title={t('discardTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                const pendingEntry = confirm
                if (pendingEntry === null) return
                setConfirm(null)
                reject(pendingEntry)
              }}
            >
              {t('reject')}
            </Button>
          </>
        )}
      >
        <p className={css.gitConfirmDesc}>{t('discardDesc', { path: confirm?.path ?? '' })}</p>
      </Modal>
    </div>
  )
}
