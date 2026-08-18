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
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconBranchOutline16, IconCodeOutline16, IconCopyOutline16, IconRefreshOutline16,
  IconTrashOutline16, Input, Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLogEntry, GitRepositoryStatus, GitStatusEntry, SessionScope } from './api.ts'
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

/** Last path segment of a repository root, separator-agnostic. */
function repositoryName(root: string): string {
  return baseName(root.replace(/[\\/]+$/, '')) || root
}

/** Absolute path for one repository-relative status entry. */
function repositoryPath(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${path}`
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
  /** Open a diff tab (the shell places it below the git pane on first use). */
  onOpenDiff: (tab: SidebarTab) => void
}) {
  const { scope, onOpenFile, onOpenDiff } = props
  const [repositories, setRepositories] = useState<GitRepositoryStatus[] | null>(null)
  const [selectedRepository, setSelectedRepository] = useState<string | null>(null)
  const selectedRepositoryRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ repository: string; entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ repository: string; entry: GitLogEntry; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const refresh = useCallback(async (targetRepository?: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const statusResult = await api.gitStatus(scope)
      const wanted = targetRepository ?? selectedRepositoryRef.current
      const selected = statusResult.find(repository => repository.root === wanted)?.root
        ?? statusResult[0]?.root
        ?? null
      const [branchResult, logResult] = selected === null
        ? [{ current: '', names: [] as string[] }, [] as GitLogEntry[]]
        : await Promise.all([
            api.gitBranch(scope, selected).catch(() => ({ current: '', names: [] as string[] })),
            // The first history page only; the rest arrives via "load more".
            api.gitLog(scope, selected, LOG_BATCH, 0).catch(() => [] as GitLogEntry[]),
          ])
      setRepositories(statusResult)
      selectedRepositoryRef.current = selected
      setSelectedRepository(selected)
      setBranchNames(branchResult.names)
      setLogEntries(logResult)
      setLogEnded(logResult.length < LOG_BATCH)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => { void refresh() }, [refresh])

  /** Append the next history page (lazy: only when the user asks for more). */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded || selectedRepository === null) return
    setLogLoadingMore(true)
    try {
      const next = await api.gitLog(scope, selectedRepository, LOG_BATCH, logEntries.length)
      setLogEntries(entries => [...entries, ...next])
      if (next.length < LOG_BATCH) setLogEnded(true)
    } catch (reason) {
      setCommitError(`${t('historyLoadError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setLogLoadingMore(false)
    }
  }

  /** The diff tab for one changed file (one tab per path+side; same id = focused). */
  const openWorktreeDiff = (repository: string, entry: GitStatusEntry, staged: boolean): void => {
    onOpenDiff({
      id: `diff:w:${staged ? 's' : 'u'}:${repository}:${entry.path}`,
      type: 'diff',
      title: baseName(entry.path),
      diff: { kind: 'worktree', path: entry.path, staged, untracked: isUntracked(entry), repository },
    })
  }

  /** The diff tab for one commit (one tab per commit). */
  const openCommitDiff = (repository: string, entry: GitLogEntry): void => {
    onOpenDiff({
      id: `diff:c:${repository}:${entry.hashFull}`,
      type: 'diff',
      title: `${entry.hash} ${entry.subject}`,
      diff: { kind: 'commit', hash: entry.hash, hashFull: entry.hashFull, subject: entry.subject, repository },
    })
  }

  const stageEntry = async (repository: string, entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, repository, entry.path)
      else await api.gitStage(scope, repository, entry.path)
      await refresh(repository)
    } finally {
      setBusy(false)
    }
  }

  const stageAll = async (repository: string, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(scope, repository)
      else await api.gitStage(scope, repository)
      await refresh(repository)
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (message === '' || busy || selectedRepository === null) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCommit(scope, selectedRepository, message)
      setCommitMsg('')
      await refresh()
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (branch: string): Promise<void> => {
    const selected = repositories?.find(repository => repository.root === selectedRepository)
    if (branch === selected?.branch || busy || selectedRepository === null) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCheckout(scope, selectedRepository, branch)
      await refresh(selectedRepository)
    } catch (reason) {
      setCommitError(`${t('checkoutError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
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

  const openFileMenu = (event: MouseEvent, repository: string, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ repository, entry, staged, x: event.clientX, y: event.clientY })
  }

  const openHistoryMenu = (event: MouseEvent, repository: string, entry: GitLogEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ repository, entry, x: event.clientX, y: event.clientY })
  }

  const selectedStatus = repositories?.find(repository => repository.root === selectedRepository) ?? null
  const selectedStagedEntries = (selectedStatus?.entries ?? []).filter(isStagedEntry)

  const renderEntry = (repository: string, entry: GitStatusEntry, staged: boolean): ReactNode => {
    return (
      <div key={`${staged ? 's' : 'u'}:${entry.path}`} className={css.gitRow}>
        <button
          type="button"
          className={css.gitRowMain}
          title={entry.path}
          onClick={() => { openWorktreeDiff(repository, entry, staged) }}
          onContextMenu={(event) => { openFileMenu(event, repository, entry, staged) }}
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
          onClick={() => { void stageEntry(repository, entry, staged) }}
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
          value={selectedStatus?.branch ?? ''}
          onChange={(event) => { void checkout(event.target.value) }}
          disabled={busy || selectedStatus === null}
        >
          {(selectedStatus?.branch ?? '') !== '' && <option value={selectedStatus!.branch}>{selectedStatus!.branch}</option>}
          {branchNames.filter(name => name !== selectedStatus?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
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
      {!loading && repositories !== null && repositories.length === 0 && (
        <div className={css.gitPlaceholder}>{t('notRepo')}</div>
      )}

      {repositories !== null && repositories.length > 0 && (
        <>
          {repositories.map(repository => {
            const stagedEntries = repository.entries.filter(isStagedEntry)
            const unstagedEntries = repository.entries.filter(isUnstagedEntry)
            const selected = repository.root === selectedRepository
            return (
              <div key={repository.root} className={`${css.gitRepository}${selected ? ` ${css.gitRepositorySelected}` : ''}`}>
                <button
                  type="button"
                  className={css.gitRepositoryHeader}
                  title={repository.root}
                  onClick={() => { selectedRepositoryRef.current = repository.root; setSelectedRepository(repository.root); void refresh(repository.root) }}
                >
                  <span className={css.gitRepositoryName}>{repositoryName(repository.root)}</span>
                  <span className={css.gitRepositoryBranch}>{repository.branch ?? ''}</span>
                </button>
                <div className={css.gitSection}>
                  <div className={css.gitSectionHeader}>
                    <span>{t('staged')} ({stagedEntries.length})</span>
                    {stagedEntries.length > 0 && (
                      <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(repository.root, true) }}>
                        {t('unstageAll')}
                      </button>
                    )}
                  </div>
                  {stagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
                  {stagedEntries.map(entry => renderEntry(repository.root, entry, true))}
                </div>
                <div className={css.gitSection}>
                  <div className={css.gitSectionHeader}>
                    <span>{t('unstaged')} ({unstagedEntries.length})</span>
                    {unstagedEntries.length > 0 && (
                      <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(repository.root, false) }}>
                        {t('stageAll')}
                      </button>
                    )}
                  </div>
                  {unstagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
                  {unstagedEntries.map(entry => renderEntry(repository.root, entry, false))}
                </div>
              </div>
            )
          })}

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
              disabled={busy || commitMsg.trim() === '' || selectedStagedEntries.length === 0}
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
                onClick={() => { if (selectedRepository !== null) openCommitDiff(selectedRepository, entry) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    if (selectedRepository !== null) openCommitDiff(selectedRepository, entry)
                  }
                }}
                onContextMenu={(event) => { if (selectedRepository !== null) openHistoryMenu(event, selectedRepository, entry) }}
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
                onOpenFile(repositoryPath(target.repository, target.entry.path))
                return
              }
              if (id === 'stage') {
                void stageEntry(target.repository, target.entry, target.staged)
                return
              }
              if (id === 'discard') {
                runConfirmed({
                  title: t('discardTitle'),
                  description: t('discardDesc', { path: target.entry.path }),
                  confirmLabel: t('discard'),
                  onConfirm: () => api.gitDiscard(scope, target.repository, target.entry.path),
                })
                return
              }
              if (id === 'relative') {
                copy(relativeTo(scope.cwd ?? '', repositoryPath(target.repository, target.entry.path)))
                return
              }
              if (id === 'absolute') copy(repositoryPath(target.repository, target.entry.path))
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
                openCommitDiff(target.repository, target.entry)
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
                  onConfirm: () => api.gitRevert(scope, target.repository, target.entry.hashFull),
                })
                return
              }
              if (id === 'cherryPick') {
                runConfirmed({
                  title: t('cherryPickTitle'),
                  description: t('cherryPickDesc', { subject: target.entry.subject }),
                  confirmLabel: t('cherryPickCommit'),
                  onConfirm: () => api.gitCherryPick(scope, target.repository, target.entry.hashFull),
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
    </div>
  )
}
