/**
 * The built-in GitHub inbox view: status line (setup guide / auth warning /
 * stale-snapshot warning), filter chips, a repo-grouped thread list, and
 * the per-thread action surface — mark read / done, open in the sidebar
 * browser or externally, PR review verdicts (approve / request changes),
 * general comments, and the gated merge panel (CI status + method +
 * explicit confirm).
 *
 * The store owns polling; this component only renders its snapshot. Chips
 * write the same SidebarPrefs keys the Side card settings popup binds, and
 * apply optimistically through the sidebar store (the SideCardSection
 * mechanism), so the badge and the settings popup stay in sync live.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCheckOutline14, IconRefreshOutline14, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import type { SidebarStore } from './service.ts'
import type {
  GithubMergeMethod,
  GithubMergeStatus,
  GithubReviewEvent,
  GithubStateResult,
  GithubThread,
  GithubThreadDetail,
} from '../github-shared.ts'
import {
  categorizeThread,
  countUnread,
  filterThreads,
  GITHUB_CATEGORY_PREF_KEYS,
  groupThreads,
  reviewVerdict,
  threadNumber,
  type GithubCategory,
  type GithubInboxStore,
} from './github-inbox.ts'
import { api, SidebarApiError, type SessionScope } from './api.ts'
import { relativeTime, t, type CopyKey } from './locales.ts'
import css from './GitHubInboxView.module.css'

/** The category order of the filter chips (declaration order of the design). */
const CATEGORY_ORDER: readonly GithubCategory[] = ['reviewRequested', 'prActivity', 'comments', 'ci', 'other']

/** The chip label key of one category. */
const CHIP_LABELS: Record<GithubCategory, CopyKey> = {
  reviewRequested: 'githubChipReviewRequested',
  prActivity: 'githubChipPrActivity',
  comments: 'githubChipComments',
  ci: 'githubChipCi',
  other: 'githubChipOther',
}

/** The inline tag label key of one category. */
const TAG_LABELS: Record<GithubCategory, CopyKey> = {
  reviewRequested: 'githubCategoryReviewRequested',
  prActivity: 'githubCategoryPrActivity',
  comments: 'githubCategoryComments',
  ci: 'githubCategoryCi',
  other: 'githubCategoryOther',
}

/** The merge-method button label key. */
const METHOD_LABELS: Record<GithubMergeMethod, CopyKey> = {
  squash: 'githubMergeMethodSquash',
  merge: 'githubMergeMethodMerge',
  rebase: 'githubMergeMethodRebase',
}

/** Fold an action failure into a displayable message. */
function actionMessage(error: unknown): string {
  if (error instanceof SidebarApiError) return t('githubActionFailed', { message: error.message })
  const message = error instanceof Error ? error.message : String(error)
  return t('githubActionFailed', { message })
}

/** The merge panel's failure text: the gate reads differently from GitHub's rejections. */
function mergeMessage(error: unknown): string {
  if (error instanceof SidebarApiError) {
    if (error.code === 'github-forbidden') return t('githubMergeDisabled')
    return error.message
  }
  const message = error instanceof Error ? error.message : String(error)
  return message
}

/** One thread row plus its expansion (detail, actions, merge panel). */
function ThreadRow(props: {
  thread: GithubThread
  expanded: boolean
  busy: boolean
  detail: GithubThreadDetail | null
  detailLoading: boolean
  detailFailed: boolean
  commentDraft: string
  mergeAllowed: boolean
  mergeOpen: boolean
  mergeStatus: GithubMergeStatus | null
  mergeLoading: boolean
  mergeError: string | null
  mergeMethod: GithubMergeMethod
  onToggle: () => void
  onMarkRead: () => void
  onMarkDone: () => void
  onOpenSidebar: () => void
  onApprove: () => void
  onRequestChanges: () => void
  onMergeOpen: () => void
  onMergeMethod: (method: GithubMergeMethod) => void
  onMergeConfirm: () => void
  onCommentDraft: (value: string) => void
  onCommentSend: () => void
}): ReactNode {
  const { thread, busy } = props
  const category = categorizeThread(thread)
  const verdict = thread.type === 'PullRequest' ? reviewVerdict(thread.title) : undefined
  const pr = threadNumber(thread.url)
  return (
    <div className={css.thread}>
      <button className={css.row} onClick={props.onToggle}>
        <span className={clsx(css.dot, thread.unread && css.dotUnread)} />
        <span className={css.rowTitle}>{thread.title}</span>
        <span className={css.rowMeta}>
          <span className={css.tag}>{t(TAG_LABELS[category])}</span>
          {verdict !== undefined && (
            <span className={clsx(css.verdict, verdict === 'approved' ? css.verdictOk : css.verdictBad)}>
              {t(verdict === 'approved' ? 'githubVerdictApproved' : 'githubVerdictChanges')}
            </span>
          )}
          <span className={css.rowTime}>{relativeTime(thread.updatedAt)}</span>
        </span>
      </button>
      {props.expanded && (
        <div className={css.detail}>
          <div className={css.detailBody}>
            {props.detailLoading && <span>{t('githubLoading')}</span>}
            {props.detailFailed && <span>{t('githubDetailLoadFailed')}</span>}
            {!props.detailLoading && !props.detailFailed && (
              props.detail !== null && props.detail.commentBody !== undefined && props.detail.commentBody !== ''
                ? <MarkdownText text={props.detail.commentBody} codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }} />
                : <span>{t('githubNoComment')}</span>
            )}
          </div>
          <div className={css.actions}>
            <button className={css.action} disabled={busy} onClick={props.onMarkRead}>{t('githubMarkRead')}</button>
            <button className={css.action} disabled={busy} onClick={props.onMarkDone}>{t('githubMarkDone')}</button>
            {/* CheckSuite threads carry no subject URL — nothing to open. */}
            <button className={css.action} disabled={busy || thread.htmlUrl === ''} onClick={props.onOpenSidebar}>{t('githubOpenInSidebar')}</button>
            <button className={css.action} disabled={busy || thread.htmlUrl === ''} onClick={() => { window.open(thread.htmlUrl, '_blank', 'noopener') }}>{t('githubOpenExternal')}</button>
            {thread.type === 'PullRequest' && (
              <>
                <button className={clsx(css.action, css.actionApprove)} disabled={busy} onClick={props.onApprove}>{t('githubApprove')}</button>
                <button className={clsx(css.action, css.actionChanges)} disabled={busy} onClick={props.onRequestChanges}>{t('githubRequestChanges')}</button>
                {props.mergeAllowed && <button className={clsx(css.action, css.actionMerge)} disabled={busy} onClick={props.onMergeOpen}>{t('githubMerge')}</button>}
              </>
            )}
          </div>
          {/* Only issue/PR threads can take a comment (the number is the endpoint key). */}
          {pr !== undefined && <div className={css.commentBox}>
            <textarea
              className={css.commentInput}
              value={props.commentDraft}
              placeholder={t('githubCommentPlaceholder')}
              onChange={(event) => { props.onCommentDraft(event.target.value) }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  props.onCommentSend()
                }
              }}
            />
            <button className={css.action} disabled={busy || props.commentDraft.trim() === ''} onClick={props.onCommentSend}>{t('githubSend')}</button>
          </div>}
          {props.mergeOpen && (
            <div className={css.mergePanel}>
              <div className={css.mergeTitle}>{t('githubMergeTitle')}</div>
              {props.mergeLoading && <div>{t('githubLoading')}</div>}
              {props.mergeError !== null && <div className={css.errorLine}>{props.mergeError}</div>}
              {props.mergeStatus !== null && (
                <>
                  <div className={css.mergeRow}>
                    <span>{t('githubMergeState')}: {props.mergeStatus.state}</span>
                  </div>
                  <div className={css.mergeRow}>
                    <span>{t('githubMergeChecks')}:</span>
                    {props.mergeStatus.checks.length === 0 && <span className={css.mergeMeta}>—</span>}
                    {props.mergeStatus.checks.map(check => (
                      <span
                        key={check.name}
                        className={clsx(css.check, check.conclusion === 'success' && css.checkOk, check.conclusion !== null && check.conclusion !== 'success' && check.conclusion !== 'skipped' && check.conclusion !== 'neutral' && css.checkBad)}
                      >
                        {check.name}
                      </span>
                    ))}
                  </div>
                  <div className={css.mergeRow}>
                    <span>{t('githubMergeMethod')}:</span>
                    {(Object.keys(METHOD_LABELS) as GithubMergeMethod[]).map(method => (
                      <button
                        key={method}
                        className={clsx(css.method, props.mergeMethod === method && css.methodOn)}
                        onClick={() => { props.onMergeMethod(method) }}
                      >
                        {t(METHOD_LABELS[method])}
                      </button>
                    ))}
                  </div>
                  {props.mergeStatus.mergeable === false
                    ? <div className={css.errorLine}>{t('githubMergeUnavailable')}</div>
                    : (
                      <button className={css.mergeConfirm} disabled={props.mergeLoading} onClick={props.onMergeConfirm}>
                        {t('githubMergeConfirm', { repo: thread.repo, pr: pr ?? 0 })}
                      </button>
                    )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The GitHub inbox tab body. */
export function GitHubInboxView(props: {
  githubStore: GithubInboxStore
  sidebarStore: SidebarStore
  ctx: Context
  scope: SessionScope
}): ReactNode {
  const { githubStore, sidebarStore, ctx, scope } = props
  const state = useSyncExternalStore(githubStore.subscribe, githubStore.getState)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<GithubThreadDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailFailed, setDetailFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [mergeFor, setMergeFor] = useState<string | null>(null)
  const [mergeStatus, setMergeStatus] = useState<GithubMergeStatus | null>(null)
  const [mergeLoading, setMergeLoading] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeMethod, setMergeMethod] = useState<GithubMergeMethod>('squash')
  // The id of the CURRENTLY expanded thread, kept in a ref so the async
  // detail fetch can discard its result when the user already switched
  // threads (or collapsed) before the response settled.
  const expandedRef = useRef<string | null>(null)

  useEffect(() => { githubStore.ensurePolling() }, [githubStore])

  const snapshot: GithubStateResult | null = state.snapshot
  const threads = snapshot === null ? [] : filterThreads(snapshot.threads, state.prefs)
  const unread = countUnread(threads)
  const groups = groupThreads(threads)

  const collapse = (): void => {
    expandedRef.current = null
    setExpanded(null)
    setDetail(null)
    setDetailLoading(false)
    setDetailFailed(false)
    setMergeFor(null)
    setMergeStatus(null)
    setMergeError(null)
    setCommentDraft('')
  }

  const refresh = (): void => {
    void githubStore.refresh().catch(error => { setActionError(actionMessage(error)) })
  }

  const toggleThread = (thread: GithubThread): void => {
    if (expanded === thread.id) {
      collapse()
      return
    }
    expandedRef.current = thread.id
    setExpanded(thread.id)
    setDetail(null)
    setDetailFailed(false)
    setDetailLoading(true)
    setMergeFor(null)
    setMergeStatus(null)
    setMergeError(null)
    void api.githubThread(thread.id)
      .then(result => {
        // A settle for a thread the user already left must not overwrite
        // the current thread's detail (the fetch has no abort handle).
        if (expandedRef.current === thread.id) setDetail(result)
      })
      .catch(() => {
        if (expandedRef.current === thread.id) setDetailFailed(true)
      })
      .finally(() => {
        if (expandedRef.current === thread.id) setDetailLoading(false)
      })
  }

  const markRead = async (thread: GithubThread): Promise<void> => {
    setBusy(`read:${thread.id}`)
    setActionError(null)
    try {
      await api.githubMarkRead(thread.id)
      githubStore.removeLocal(thread.id)
      collapse()
    } catch (error) {
      setActionError(actionMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const markDone = async (thread: GithubThread): Promise<void> => {
    setBusy(`done:${thread.id}`)
    setActionError(null)
    try {
      await api.githubMarkDone(thread.id)
      githubStore.removeLocal(thread.id)
      collapse()
    } catch (error) {
      setActionError(actionMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const markAllRead = async (): Promise<void> => {
    setBusy('all')
    setActionError(null)
    try {
      await api.githubMarkAllRead()
      githubStore.clearLocal()
      collapse()
    } catch (error) {
      setActionError(actionMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const submitReview = async (thread: GithubThread, event: GithubReviewEvent): Promise<void> => {
    const pr = threadNumber(thread.url)
    if (pr === undefined) return
    setBusy(`review:${thread.id}`)
    setActionError(null)
    try {
      await api.githubReview(thread.repo, pr, event)
    } catch (error) {
      setActionError(actionMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const submitComment = async (thread: GithubThread): Promise<void> => {
    const number = threadNumber(thread.url)
    const body = commentDraft.trim()
    if (number === undefined || body === '') return
    setBusy(`comment:${thread.id}`)
    setActionError(null)
    try {
      await api.githubComment(thread.repo, number, body)
      setCommentDraft('')
    } catch (error) {
      setActionError(actionMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const openMerge = (thread: GithubThread): void => {
    const pr = threadNumber(thread.url)
    if (pr === undefined) return
    setMergeFor(thread.id)
    setMergeStatus(null)
    setMergeError(null)
    setMergeLoading(true)
    void api.githubMergeStatus(thread.repo, pr)
      .then(result => { setMergeStatus(result) })
      .catch(error => { setMergeError(mergeMessage(error)) })
      .finally(() => { setMergeLoading(false) })
  }

  const confirmMerge = async (thread: GithubThread): Promise<void> => {
    const pr = threadNumber(thread.url)
    if (pr === undefined) return
    setMergeLoading(true)
    setMergeError(null)
    try {
      await api.githubMerge(thread.repo, pr, mergeMethod)
      await api.githubMarkRead(thread.id).catch(() => { /* the merge already succeeded — read marking is best-effort */ })
      githubStore.removeLocal(thread.id)
      collapse()
    } catch (error) {
      setMergeError(mergeMessage(error))
    } finally {
      setMergeLoading(false)
    }
  }

  const toggleChip = (category: GithubCategory): void => {
    const key = GITHUB_CATEGORY_PREF_KEYS[category]
    const next = state.prefs[key] !== true
    sidebarStore.setPrefs({ ...state.prefs, [key]: next })
    setActionError(null)
    void api.settingsUpdate({ [key]: next }).catch(() => {
      setActionError(t('settingsSaveFailed'))
    })
  }

  const openInSidebar = (thread: GithubThread): void => {
    ctx.betterSidebar.openTab({ type: 'browser', title: thread.repo, url: thread.htmlUrl }, scope)
  }

  return (
    <div className={css.github}>
      <div className={css.header}>
        <span className={css.title}>{t('github')}</span>
        {unread > 0 && <span className={css.count}>{t('githubUnread', { count: unread })}</span>}
        <button className={css.iconBtn} disabled={busy === 'all'} title={t('githubRefresh')} onClick={refresh}><IconRefreshOutline14 /></button>
        <button className={css.iconBtn} disabled={busy === 'all'} title={t('githubMarkAllRead')} onClick={() => { void markAllRead() }}><IconCheckOutline14 /></button>
      </div>
      <div className={css.chips}>
        <span className={css.chipsLabel}>{t('githubFilterLabel')}</span>
        {CATEGORY_ORDER.map(category => {
          const enabled = state.prefs[GITHUB_CATEGORY_PREF_KEYS[category]] === true
          return (
            <button
              key={category}
              className={clsx(css.chip, enabled && css.chipOn)}
              onClick={() => { toggleChip(category) }}
            >
              {t(CHIP_LABELS[category])}
            </button>
          )
        })}
      </div>
      {snapshot === null && <div className={css.status}>{t('githubLoading')}</div>}
      {snapshot !== null && !snapshot.configured && (
        <div className={css.status}>
          {snapshot.ghAvailable === false ? t('githubUnconfiguredNoGh') : t('githubUnconfiguredGh')}
        </div>
      )}
      {snapshot?.configured === true && snapshot.error !== undefined && (
        <div className={clsx(css.status, css.statusError)}>
          {snapshot.error.code === 'github-auth'
            ? t('githubAuthError')
            : t('githubNetworkError', { message: snapshot.error.message })}
        </div>
      )}
      {actionError !== null && <div className={clsx(css.status, css.statusError)}>{actionError}</div>}
      {snapshot?.configured === true && snapshot.error === undefined && groups.length === 0 && <div className={css.status}>{t('githubEmpty')}</div>}
      <div className={css.list}>
        {groups.map(group => (
          <div key={group.repo} className={css.group}>
            <div className={css.groupHeader}>{group.repo}</div>
            {group.threads.map(thread => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                expanded={expanded === thread.id}
                busy={busy !== null}
                detail={detail}
                detailLoading={detailLoading}
                detailFailed={detailFailed}
                commentDraft={commentDraft}
                mergeAllowed={snapshot?.allowMerge === true}
                mergeOpen={mergeFor === thread.id}
                mergeStatus={mergeStatus}
                mergeLoading={mergeLoading}
                mergeError={mergeError}
                mergeMethod={mergeMethod}
                onToggle={() => { toggleThread(thread) }}
                onMarkRead={() => { void markRead(thread) }}
                onMarkDone={() => { void markDone(thread) }}
                onOpenSidebar={() => { openInSidebar(thread) }}
                onApprove={() => { void submitReview(thread, 'APPROVE') }}
                onRequestChanges={() => { void submitReview(thread, 'REQUEST_CHANGES') }}
                onMergeOpen={() => { openMerge(thread) }}
                onMergeMethod={setMergeMethod}
                onMergeConfirm={() => { void confirmMerge(thread) }}
                onCommentDraft={setCommentDraft}
                onCommentSend={() => { void submitComment(thread) }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
