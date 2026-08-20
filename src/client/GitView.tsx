/**
 * The source-control panel: status list (staged vs unstaged), stage/unstage,
 * commit with a message box, branch switch, and a VSCode-like history — rows
 * carry branch decorations, author and relative time. Clicking a changed
 * file or a history row opens a dedicated diff TAB (see {@link DiffTab}),
 * placed below the git pane on first use. File rows and history rows open a
 * right-click context menu with advanced operations (open in editor, discard,
 * revert, cherry-pick, copy paths/hashes). Refresh is manual + on mount/
 * focus (no file watcher — KISS).
 */
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconBranchOutline16, IconCodeOutline16, IconCopyOutline16, IconRefreshOutline16,
  IconTrashOutline16, Input, Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLogEntry, GitOperation, GitStatusEntry, GitStatusResult, GitWorktree, SessionScope } from './api.ts'
import { api } from './api.ts'
import { relativeTo } from './paths.ts'
import { relativeTime, t } from './locales.ts'
import type { SidebarTab } from './state.ts'
import css from './sidebar.module.css'

/** The XY status letters a row badge shows (X = index, Y = worktree). */
function badgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  const worktree = entry.xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  const index = entry.xy[0]
  return index !== undefined && index !== ' ' && index !== '?'
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  if (entry.xy === '??') return true
  const worktree = entry.xy[1]
  return worktree !== undefined && worktree !== ' ' && worktree !== '?'
}

/** Whether the entry is untracked (`??`): git diff never includes it. */
function isUntracked(entry: GitStatusEntry): boolean {
  return badgeOf(entry) === '?'
}

/** The last path segment (tab title for a file's diff). */
function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** The ref names of one log row's decorations (`HEAD -> main` → `main`), deduped. */
function refNames(refs: string): string[] {
  return [...new Set(
    refs
      .split(',')
      .map(ref => ref.trim())
      .filter(ref => ref !== '')
      .map(ref => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
      .map(ref => (ref.startsWith('tag: ') ? ref.slice(5) : ref)),
  )]
}

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm modal. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */
const LOG_BATCH = 20

export function GitView(props: {
  scope: SessionScope
  onOpenFile: (path: string) => void
  /** Register the Worktree as a DSH Workspace, create a session, and open it. */
  onOpenWorktree: (path: string) => Promise<void>
  /** Open a diff tab (the shell places it below the git pane on first use). */
  onOpenDiff: (tab: SidebarTab) => void
}) {
  const { scope, onOpenFile, onOpenDiff, onOpenWorktree } = props
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [mergeSource, setMergeSource] = useState<string | null>(null)
  const [rebaseTarget, setRebaseTarget] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  const [worktreeBranch, setWorktreeBranch] = useState('')
  const [worktreePath, setWorktreePath] = useState('')
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  const [worktreeMerge, setWorktreeMerge] = useState<GitWorktree | null>(null)
  const [operation, setOperation] = useState<GitOperation | null>(null)
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GitLogEntry; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [statusResult, branchResult, logResult, worktreeResult, operationResult] = await Promise.all([
        api.gitStatus(scope),
        api.gitBranch(scope).catch(() => ({ current: '', names: [] as string[] })),
        // The first history page only; the rest arrives via "load more".
        api.gitLog(scope, LOG_BATCH, 0).catch(() => [] as GitLogEntry[]),
        api.gitWorktrees(scope).catch(() => ({ entries: [] as GitWorktree[] })),
        api.gitOperation(scope).catch(() => ({ operation: null })),
      ])
      setStatus(statusResult)
      setBranchNames(branchResult.names)
      setLogEntries(logResult)
      setLogEnded(logResult.length < LOG_BATCH)
      setWorktrees(worktreeResult.entries)
      setOperation(operationResult.operation)
      const available = branchResult.names.filter(name => !worktreeResult.entries.some(entry => entry.branch === name))
      setWorktreeBranch(branch => available.includes(branch) ? branch : available[0] ?? '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => { void refresh() }, [refresh])

  /** Append the next history page (lazy: only when the user asks for more). */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded) return
    setLogLoadingMore(true)
    try {
      const next = await api.gitLog(scope, LOG_BATCH, logEntries.length)
      setLogEntries(entries => [...entries, ...next])
      if (next.length < LOG_BATCH) setLogEnded(true)
    } catch (reason) {
      setCommitError(`${t('historyLoadError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setLogLoadingMore(false)
    }
  }

  /** The diff tab for one changed file (one tab per path+side; same id = focused). */
  const openWorktreeDiff = (entry: GitStatusEntry, staged: boolean): void => {
    onOpenDiff({
      id: `diff:w:${staged ? 's' : 'u'}:${entry.path}`,
      type: 'diff',
      title: baseName(entry.path),
      diff: { kind: 'worktree', path: entry.path, staged, untracked: isUntracked(entry) },
    })
  }

  /** The diff tab for one commit (one tab per commit). */
  const openCommitDiff = (entry: GitLogEntry): void => {
    onOpenDiff({
      id: `diff:c:${entry.hashFull}`,
      type: 'diff',
      title: `${entry.hash} ${entry.subject}`,
      diff: { kind: 'commit', hash: entry.hash, hashFull: entry.hashFull, subject: entry.subject },
    })
  }

  const stageEntry = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, entry.path)
      else await api.gitStage(scope, entry.path)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const stageAll = async (staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope)
      else await api.gitStage(scope)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (message === '' || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCommit(scope, message)
      setCommitMsg('')
      await refresh()
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === status?.branch || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCheckout(scope, branch)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('checkoutError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const merge = async (branch: string): Promise<void> => {
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitMerge(scope, branch)
    } catch (reason) {
      setCommitError(`${t('mergeError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const addWorktree = async (): Promise<void> => {
    const path = worktreePath.trim()
    if (path === '' || worktreeBranch === '' || busy) return
    setBusy(true)
    setWorktreeError(null)
    try {
      await api.gitWorktreeAdd(scope, path, worktreeBranch)
      setWorktreePath('')
      await refresh()
    } catch (reason) {
      setWorktreeError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const rebase = async (branch: string): Promise<void> => {
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitRebase(scope, branch)
    } catch (reason) {
      setCommitError(`${t('rebaseError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const openWorktree = async (path: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setWorktreeError(null)
    try {
      await onOpenWorktree(path)
    } catch (reason) {
      setWorktreeError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const mergeWorktree = async (entry: GitWorktree, remove: boolean): Promise<void> => {
    if (entry.branch === undefined || busy) return
    setWorktreeMerge(null)
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitMerge(scope, entry.branch)
      if (remove) await api.gitWorktreeRemove(scope, entry.path)
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const finishOperation = async (abort: boolean): Promise<void> => {
    if (operation === null || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      if (abort) await api.gitOperationAbort(scope, operation)
      else await api.gitOperationContinue(scope, operation)
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  /** Run one destructive operation after the confirm modal, then refresh. */
  const runConfirmed = (confirmState: ConfirmState): void => {
    setConfirm({ ...confirmState, onConfirm: async () => {
      setBusy(true)
      setCommitError(null)
      try {
        await confirmState.onConfirm()
        await refresh()
      } catch (reason) {
        setCommitError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    } })
  }

  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  const openFileMenu = (event: MouseEvent, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ entry, staged, x: event.clientX, y: event.clientY })
  }

  const openHistoryMenu = (event: MouseEvent, entry: GitLogEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const stagedEntries = (status?.entries ?? []).filter(isStagedEntry)
  const unstagedEntries = (status?.entries ?? []).filter(isUnstagedEntry)

  const renderEntry = (entry: GitStatusEntry, staged: boolean): ReactNode => {
    return (
      <div key={`${staged ? 's' : 'u'}:${entry.path}`} className={css.gitRow}>
        <button
          type="button"
          className={css.gitRowMain}
          title={entry.path}
          onClick={() => { openWorktreeDiff(entry, staged) }}
          onContextMenu={(event) => { openFileMenu(event, entry, staged) }}
        >
          <span className={css.gitBadge}>{badgeOf(entry)}</span>
          <span className={css.gitName}>{entry.path}</span>
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={staged ? t('unstage') : t('stage')}
          title={staged ? t('unstage') : t('stage')}
          disabled={busy}
          onClick={() => { void stageEntry(entry, staged) }}
        >
          {staged ? <IconTrashOutline16 /> : <IconBranchOutline16 />}
        </button>
      </div>
    )
  }

  return (
    <div className={css.git}>
      <div className={css.gitHeader}>
        <select
          className={css.gitBranchSelect}
          value={status?.branch ?? ''}
          onChange={(event) => { void checkout(event.target.value) }}
          disabled={busy || (status !== null && !status.isRepo)}
        >
          {(status?.branch ?? '') !== '' && <option value={status!.branch}>{status!.branch}</option>}
          {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <Menu
          open={branchMenuOpen}
          onClose={() => { setBranchMenuOpen(false) }}
          items={[
            { id: 'merge', label: t('mergeBranch'), icon: <IconBranchOutline16 size={14} />, disabled: branchNames.every(name => name === status?.branch) },
            { id: 'rebase', label: t('rebaseBranch'), icon: <IconRefreshOutline16 size={14} />, disabled: branchNames.every(name => name === status?.branch) },
            { type: 'separator', id: 'branch-separator' },
            { id: 'worktree', label: t('worktrees'), icon: <IconBranchOutline16 size={14} /> },
          ]}
          onSelect={(id) => {
            const branch = branchNames.find(name => name !== status?.branch) ?? null
            setBranchMenuOpen(false)
            if (id === 'merge') setMergeSource(branch)
            if (id === 'rebase') setRebaseTarget(branch)
            if (id === 'worktree') {
              setWorktreeError(null)
              setWorktreeOpen(true)
            }
          }}
          portal
          align="end"
          compact
          anchor={(
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('branchActions')}
              title={t('branchActions')}
              disabled={busy || (status !== null && !status.isRepo)}
              onClick={() => { setBranchMenuOpen(open => !open) }}
            >
              <IconBranchOutline16 size={14} />
            </button>
          )}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>

      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{error}</div>}
      {!loading && status !== null && !status.isRepo && (
        <div className={css.gitPlaceholder}>{t('notRepo')}</div>
      )}
      {operation !== null && (
        <div className={css.gitOperation}>
          <span>{t('operationConflict', { operation: t(operation === 'merge' ? 'mergeBranch' : 'rebaseBranch') })}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void finishOperation(true) }}>{t('operationAbort')}</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void finishOperation(false) }}>{t('operationContinue')}</Button>
        </div>
      )}

      {status !== null && status.isRepo && (
        <>
          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{t('staged')} ({stagedEntries.length})</span>
              {stagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(true) }}>
                  {t('unstageAll')}
                </button>
              )}
            </div>
            {stagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {stagedEntries.map(entry => renderEntry(entry, true))}
          </div>
          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{t('unstaged')} ({unstagedEntries.length})</span>
              {unstagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(false) }}>
                  {t('stageAll')}
                </button>
              )}
            </div>
            {unstagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {unstagedEntries.map(entry => renderEntry(entry, false))}
          </div>

          <div className={css.gitCommit}>
            <Input
              className={css.gitCommitInput}
              placeholder={t('commitPlaceholder')}
              value={commitMsg}
              disabled={busy}
              onChange={(event) => { setCommitMsg(event.target.value); setCommitError(null) }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
              }}
            />
            <button
              type="button"
              className={css.gitCommitButton}
              disabled={busy || commitMsg.trim() === '' || stagedEntries.length === 0}
              onClick={() => { void commit() }}
            >
              {t('commit')}
            </button>
          </div>
          {commitError !== null && <div className={css.gitError}>{commitError}</div>}

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}><span>{t('history')}</span></div>
            {logEntries.map(entry => (
              <div
                key={entry.hashFull}
                role="button"
                tabIndex={0}
                className={css.gitLogRow}
                title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
                onClick={() => { openCommitDiff(entry) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openCommitDiff(entry)
                  }
                }}
                onContextMenu={(event) => { openHistoryMenu(event, entry) }}
              >
                <span className={css.gitLogLine1}>
                  <span className={css.gitLogHash}>{entry.hash}</span>
                  <span className={css.gitLogSubject}>{entry.subject}</span>
                </span>
                <span className={css.gitLogLine2}>
                  {refNames(entry.refs).map(ref => (
                    <span key={ref} className={css.gitLogRef}>{ref}</span>
                  ))}
                  <span className={css.gitLogMeta}>{entry.author} · {relativeTime(entry.date)}</span>
                </span>
              </div>
            ))}
            {!logEnded && (
              <button
                type="button"
                className={css.gitLogMore}
                disabled={logLoadingMore || busy}
                onClick={() => { void loadMoreLog() }}
              >
                {logLoadingMore ? t('loading') : t('loadMore')}
              </button>
            )}
          </div>

          {/*
            The one shared file-row context menu, positioned at the right-click
            cursor (portal so the panel's overflow clip cannot crop it).
          */}
          <Menu
            open={fileMenu !== null}
            onClose={() => { setFileMenu(null) }}
            items={[
              { id: 'open', label: t('openEditor'), icon: <IconCodeOutline16 size={14} /> },
              fileMenu?.staged === true
                ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutline16 size={14} /> }
                : { id: 'stage', label: t('stage'), icon: <IconBranchOutline16 size={14} /> },
              ...(fileMenu !== null && !isUntracked(fileMenu.entry)
                ? [{ id: 'discard', label: t('discard'), icon: <IconTrashOutline16 size={14} />, danger: true }]
                : []),
              { type: 'separator', id: 'sep1' },
              { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
            ]}
            onSelect={(id) => {
              const target = fileMenu
              if (target === null) return
              setFileMenu(null)
              if (id === 'open') {
                onOpenFile(target.entry.path)
                return
              }
              if (id === 'stage') {
                void stageEntry(target.entry, target.staged)
                return
              }
              if (id === 'discard') {
                runConfirmed({
                  title: t('discardTitle'),
                  description: t('discardDesc', { path: target.entry.path }),
                  confirmLabel: t('discard'),
                  onConfirm: () => api.gitDiscard(scope, target.entry.path),
                })
                return
              }
              if (id === 'relative') {
                copy(relativeTo(scope.cwd ?? '', target.entry.path))
                return
              }
              if (id === 'absolute') copy(target.entry.path)
            }}
            portal
            align="start"
            getAnchorRect={() => (fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* The shared history-row context menu. */}
          <Menu
            open={historyMenu !== null}
            onClose={() => { setHistoryMenu(null) }}
            items={[
              { id: 'view', label: t('viewCommitDiff') },
              { id: 'copyShort', label: t('copyShortHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copyFull', label: t('copyFullHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copySubject', label: t('copySubject'), icon: <IconCopyOutline16 size={14} /> },
              { type: 'separator', id: 'sep2' },
              { id: 'revert', label: t('revertCommit'), danger: true },
              { id: 'cherryPick', label: t('cherryPickCommit'), danger: true },
            ]}
            onSelect={(id) => {
              const target = historyMenu
              if (target === null) return
              setHistoryMenu(null)
              if (id === 'view') {
                openCommitDiff(target.entry)
                return
              }
              if (id === 'copyShort') {
                copy(target.entry.hash)
                return
              }
              if (id === 'copyFull') {
                copy(target.entry.hashFull)
                return
              }
              if (id === 'copySubject') {
                copy(target.entry.subject)
                return
              }
              if (id === 'revert') {
                runConfirmed({
                  title: t('revertTitle'),
                  description: t('revertDesc', { subject: target.entry.subject }),
                  confirmLabel: t('revertCommit'),
                  onConfirm: () => api.gitRevert(scope, target.entry.hashFull),
                })
                return
              }
              if (id === 'cherryPick') {
                runConfirmed({
                  title: t('cherryPickTitle'),
                  description: t('cherryPickDesc', { subject: target.entry.subject }),
                  confirmLabel: t('cherryPickCommit'),
                  onConfirm: () => api.gitCherryPick(scope, target.entry.hashFull),
                })
              }
            }}
            portal
            align="start"
            getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* Destructive actions land here first: Cancel / Confirm. */}
          <Modal
            open={confirm !== null}
            onClose={() => { setConfirm(null) }}
            title={confirm?.title ?? ''}
            closeLabel={t('cancel')}
            footer={(
              <>
                <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    const pending = confirm
                    if (pending === null) return
                    setConfirm(null)
                    void pending.onConfirm()
                  }}
                >
                  {confirm?.confirmLabel ?? ''}
                </Button>
              </>
            )}
          >
            <p className={css.gitConfirmDesc}>{confirm?.description}</p>
          </Modal>
        </>
      )}

      <Modal
        open={mergeSource !== null}
        onClose={() => { setMergeSource(null) }}
        title={t('mergeTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setMergeSource(null) }}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || mergeSource === null}
              onClick={() => {
                const branch = mergeSource
                if (branch === null) return
                setMergeSource(null)
                void merge(branch)
              }}
            >
              {t('mergeBranch')}
            </Button>
          </>
        )}
      >
        <p className={css.gitConfirmDesc}>{t('mergeDesc', { source: mergeSource ?? '', current: status?.branch ?? '' })}</p>
        <div className={css.gitBranchFlow}>
          <span title={mergeSource ?? ''}>{mergeSource}</span>
          <span aria-hidden="true">→</span>
          <span title={status?.branch ?? ''}>{status?.branch}</span>
        </div>
        <select
          className={css.gitBranchSelect}
          value={mergeSource ?? ''}
          onChange={(event) => { setMergeSource(event.target.value) }}
        >
          {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </Modal>

      <Modal
        open={rebaseTarget !== null}
        onClose={() => { setRebaseTarget(null) }}
        title={t('rebaseTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRebaseTarget(null) }}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || rebaseTarget === null}
              onClick={() => {
                const branch = rebaseTarget
                if (branch === null) return
                setRebaseTarget(null)
                void rebase(branch)
              }}
            >
              {t('rebaseBranch')}
            </Button>
          </>
        )}
      >
        <p className={css.gitConfirmDesc}>{t('rebaseDesc', { current: status?.branch ?? '', target: rebaseTarget ?? '' })}</p>
        <div className={css.gitBranchFlow}>
          <span title={status?.branch ?? ''}>{status?.branch}</span>
          <span aria-hidden="true">→</span>
          <span title={rebaseTarget ?? ''}>{rebaseTarget}</span>
        </div>
        <p className={css.gitRebaseWarning}>{t('rebaseWarning')}</p>
        <select
          className={css.gitBranchSelect}
          value={rebaseTarget ?? ''}
          onChange={(event) => { setRebaseTarget(event.target.value) }}
        >
          {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </Modal>

      <Modal
        open={worktreeOpen}
        onClose={() => { setWorktreeOpen(false) }}
        title={t('worktrees')}
        closeLabel={t('close')}
        footer={<Button variant="outline" onClick={() => { setWorktreeOpen(false) }}>{t('close')}</Button>}
      >
        <form
          className={css.gitWorktreeCreate}
          onSubmit={(event) => {
            event.preventDefault()
            void addWorktree()
          }}
        >
          <select
            className={css.gitBranchSelect}
            aria-label={t('worktreeBranch')}
            value={worktreeBranch}
            disabled={busy || worktreeBranch === ''}
            onChange={(event) => { setWorktreeBranch(event.target.value) }}
          >
            {branchNames
              .filter(name => !worktrees.some(entry => entry.branch === name))
              .map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <Input
            value={worktreePath}
            aria-label={t('worktreePath')}
            placeholder={t('worktreePathPlaceholder')}
            disabled={busy || worktreeBranch === ''}
            onChange={(event) => { setWorktreePath(event.target.value) }}
          />
          <Button type="submit" size="sm" variant="primary" disabled={busy || worktreeBranch === '' || worktreePath.trim() === ''}>
            {t('worktreeAdd')}
          </Button>
        </form>
        {worktreeBranch === '' && <p className={css.gitWorktreeHint}>{t('worktreeNoBranch')}</p>}
        {worktreeError !== null && <div className={css.gitError}>{worktreeError}</div>}
        <div className={css.gitWorktreeList}>
          {worktrees.map(entry => (
            <div key={entry.path} className={css.gitWorktreeRow}>
              <button
                type="button"
                className={css.gitWorktreeMain}
                disabled={busy || entry.prunable}
                title={t('worktreeOpenSession')}
                onClick={() => { void openWorktree(entry.path) }}
              >
                <span className={css.gitWorktreeLine}>
                  <span className={css.gitLogRef}>{entry.branch ?? t('worktreeDetached')}</span>
                  {entry.current && <span className={css.gitWorktreeCurrent}>{t('worktreeCurrent')}</span>}
                  {entry.locked && <span className={css.gitWorktreeCurrent}>{t('worktreeLocked')}</span>}
                </span>
                <span className={css.gitWorktreePath}>{entry.path}</span>
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('worktreeMerge')}
                title={t('worktreeMerge')}
                disabled={busy || entry.current || entry.branch === undefined || operation !== null}
                onClick={() => { setWorktreeOpen(false); setWorktreeMerge(entry) }}
              >
                <IconBranchOutline16 size={14} />
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('worktreeRemove')}
                title={entry.current ? t('worktreeCurrentRemove') : t('worktreeRemove')}
                disabled={busy || entry.current || entry.locked}
                onClick={() => {
                  setWorktreeOpen(false)
                  runConfirmed({
                    title: t('worktreeRemoveTitle'),
                    description: t('worktreeRemoveDesc', { path: entry.path }),
                    confirmLabel: t('worktreeRemove'),
                    onConfirm: () => api.gitWorktreeRemove(scope, entry.path),
                  })
                }}
              >
                <IconTrashOutline16 size={14} />
              </button>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={worktreeMerge !== null}
        onClose={() => { setWorktreeMerge(null) }}
        title={t('worktreeMergeTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setWorktreeMerge(null) }}>{t('cancel')}</Button>
            <Button variant="outline" disabled={busy} onClick={() => { if (worktreeMerge !== null) void mergeWorktree(worktreeMerge, true) }}>{t('worktreeMergeRemove')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => { if (worktreeMerge !== null) void mergeWorktree(worktreeMerge, false) }}>{t('worktreeMerge')}</Button>
          </>
        )}
      >
        <p className={css.gitConfirmDesc}>{t('worktreeMergeDesc', { source: worktreeMerge?.branch ?? '', current: status?.branch ?? '' })}</p>
      </Modal>
    </div>
  )
}
