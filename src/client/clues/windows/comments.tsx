/** Whole-resource discussion. Source replies/reviews stay separate from the body. */
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { MarkdownText, type MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { ClueComment, ClueCommentCapabilities, ClueDiscussionPage } from '../../../clues/types.ts'
import { markdownTextProps } from '../../markdown-labels.tsx'
import { t, type CopyKey } from '../../locales.ts'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import { ActionButton, ErrorBlock, Notice, TextArea } from '../../ui/index.ts'
import { clueErrorMessage } from '../copy.ts'
import { ResourcePerson, personLabel, formatResourceTime } from '../resource-summary.tsx'
import { ResourceSelectionActions, type ClueSelectionActionTarget } from '../selection-actions.tsx'
import css from './comments.module.css'

const copy = (key: CopyKey): string => t(key)

export interface ResourceDiscussionProps {
  readonly page?: ClueDiscussionPage
  readonly capabilities?: ClueCommentCapabilities
  readonly loading: boolean
  readonly error?: string
  readonly readOnly?: boolean
  readonly pathImages?: MarkdownPathImages
  readonly showAvatars?: boolean
  /** Captured resource ownership; only each comment's body enters this surface. */
  readonly selectionTarget?: Pick<ClueSelectionActionTarget, 'workspaceId' | 'sessionId' | 'resource' | 'onInsert'>
  onLoad(cursor?: string, parentId?: string): void
  onCreate(body: string, replyToId: string | undefined, requestId: string): Promise<void>
}

function reviewStateLabel(state: string): string {
  switch (state.toUpperCase()) {
    case 'APPROVED': return copy('clueReviewApproved')
    case 'CHANGES_REQUESTED': return copy('clueReviewChangesRequested')
    case 'COMMENTED': return copy('clueReviewCommented')
    case 'DISMISSED': return copy('clueReviewDismissed')
    case 'PENDING': return copy('clueReviewPending')
    default: return state
  }
}

/** Invalid or credential-bearing source links never become clickable. */
function commentUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

/** Missing/invalid provider timestamps stay unknown; never replace them with "now". */
function commentTimeOf(comment: ClueComment): number | undefined {
  for (const value of [comment.createdAt, comment.updatedAt]) {
    if (value === undefined) continue
    const time = Date.parse(value)
    if (Number.isFinite(time)) return time
  }
  return undefined
}

export function ResourceDiscussion(props: ResourceDiscussionProps): ReactNode {
  const { page, capabilities, loading, error, readOnly } = props
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<ClueComment | undefined>()
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | undefined>()
  const inFlight = useRef(false)
  // A retry of exactly the same submission reuses its idempotency key.
  const submission = useRef<{ body: string; replyToId?: string; requestId: string } | undefined>()
  const inputId = useId()
  const canCreate = capabilities?.create === true && readOnly !== true
  const items = page?.items
  const comments = useMemo(() => {
    const entries = items?.map(comment => ({ comment, time: commentTimeOf(comment) })) ?? []
    const timed = entries.filter(entry => entry.time !== undefined).sort((left, right) => left.time! - right.time!)
    let next = 0
    // Unknown-time entries retain their arrival slots. Known timestamps sort
    // between those slots, stably retaining arrival order for equal instants.
    return entries.map(entry => entry.time === undefined ? entry.comment : timed[next++]!.comment)
  }, [items])
  const authors = new Map(items?.map(item => [item.id, item.author]) ?? [])
  const canReply = canCreate && capabilities?.reply !== 'none'
  const submit = async (): Promise<void> => {
    const body = draft
    if (!canCreate || body.trim() === '' || inFlight.current) return
    inFlight.current = true
    setSending(true)
    setSendError(undefined)
    if (submission.current?.body !== body || submission.current.replyToId !== reply?.id) {
      submission.current = { body, ...(reply === undefined ? {} : { replyToId: reply.id }), requestId: crypto.randomUUID() }
    }
    try {
      await props.onCreate(body, reply?.id, submission.current.requestId)
      setDraft('')
      setReply(undefined)
      submission.current = undefined
    } catch (failure) {
      setSendError(clueErrorMessage(failure, t('error')))
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }
  return <section className={css.discussion} data-clue-discussion aria-busy={loading}>
    <div className={css.heading}>
      <h2 title={copy('clueDiscussionDocumentOnly')}>{copy('clueDiscussionHeading')}{page?.total === undefined ? '' : ` · ${page.total}`}</h2>
    </div>
    {loading && <LoadingIndicator inline />}
    {comments.map(comment => {
      const url = commentUrl(comment.url)
      const body = comment.format === 'text/markdown'
        ? <div className={css.body}><MarkdownText {...markdownTextProps(comment.body, { copyLabel: t('copy'), copiedLabel: t('copied'), codeLabel: t('codeBlockTitle'), wrapLabel: t('codeBlockWrap'), unwrapLabel: t('codeBlockUnwrap') }, props.pathImages)} /></div>
        : <div className={css.body}>{comment.body}</div>
      return <article key={comment.id} className={css.comment} data-clue-comment={comment.id} data-clue-reply-to={comment.replyToId}>
        <div className={css.meta}>
          <strong>{props.showAvatars && comment.author !== undefined
            ? <ResourcePerson person={comment.author} linked />
            : personLabel(comment.author) ?? t('clueResourceUnknownPerson')}</strong>
          {comment.createdAt !== undefined && <time dateTime={comment.createdAt}>{formatResourceTime(comment.createdAt)}</time>}
          {comment.reviewState !== undefined && <span className={css.state} data-clue-review-state={comment.reviewState}>{reviewStateLabel(comment.reviewState)}</span>}
          {comment.resolved === true && <span className={css.state}>{copy('clueCommentResolved')}</span>}
          {url !== undefined && <a href={url} target="_blank" rel="noreferrer">{t('clueDetailOpenSource')}</a>}
        </div>
        {comment.replyToId !== undefined && <div className={css.hint}>{copy('clueCommentReplyTo')} {personLabel(authors.get(comment.replyToId)) ?? comment.replyToId}</div>}
        {props.selectionTarget === undefined ? body : <ResourceSelectionActions {...props.selectionTarget} comment>{body}</ResourceSelectionActions>}
        <div className={css.actions}>
          {canReply && <ActionButton size="sm" variant="ghost" type="button" disabled={sending} onClick={() => { setReply(comment); document.getElementById(inputId)?.focus() }} data-clue-comment-reply={comment.id}>{copy('clueCommentReply')}</ActionButton>}
          {comment.nextRepliesCursor !== undefined && <ActionButton size="sm" variant="ghost" type="button" disabled={loading} data-clue-comment-replies={comment.id} onClick={() => { props.onLoad(comment.nextRepliesCursor, comment.id) }}>{copy('clueCommentMoreReplies')}</ActionButton>}
        </div>
      </article>
    })}
    {page?.status === 'ok' && page.items.length === 0 && !loading && <p className={css.hint}>{copy('clueDiscussionEmpty')}</p>}
    {page !== undefined && page.status !== 'ok' && <p className={css.hint}>{copy(page.status === 'not-captured' ? 'clueDiscussionNotCaptured' : 'clueDiscussionUnavailable')}</p>}
    {(error !== undefined || page?.error !== undefined) && (
      <ErrorBlock
        message={error ?? page?.error?.message ?? ''}
        retryLabel={t('retry')}
        busy={loading}
        onRetry={() => { props.onLoad() }}
      />
    )}
    {page?.nextCursor !== undefined && <ActionButton size="sm" type="button" disabled={loading} data-clue-comments-more onClick={() => { props.onLoad(page.nextCursor) }}>{copy('clueDiscussionMore')}</ActionButton>}
    {canCreate && <form className={css.composer} onSubmit={event => { event.preventDefault(); void submit() }}>
      <label className={css.composerLabel} htmlFor={inputId}>{copy(reply === undefined ? 'clueCommentWrite' : 'clueCommentReply')}</label>
      {reply !== undefined && <div className={css.replyContext}><span>{copy('clueCommentReplyTo')} {personLabel(reply.author) ?? reply.id}{capabilities?.reply === 'quote' ? ` · ${copy('clueCommentQuoteReply')}` : ''}</span><ActionButton size="sm" variant="ghost" type="button" disabled={sending} onClick={() => { setReply(undefined) }}>{t('cancel')}</ActionButton></div>}
      <TextArea id={inputId} rows={3} value={draft} disabled={sending} onChange={event => { setDraft(event.target.value) }} data-clue-comment-input />
      {sendError !== undefined && <Notice kind="error" tone="inline">{sendError}</Notice>}
      <div className={css.actions}><ActionButton size="sm" variant="primary" type="submit" busy={sending} disabled={draft.trim() === ''} data-clue-comment-submit>{copy('clueCommentPost')}</ActionButton></div>
    </form>}
  </section>
}
