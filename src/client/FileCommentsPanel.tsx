/** Current-file review queue shown in the editor's independent side dock. */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { LuCheck, LuHistory, LuInbox, LuPencil, LuSend, LuTrash2, LuX } from 'react-icons/lu'
import type { Context } from '../context-types.ts'
import { sendToConversation } from './conversation-draft.ts'
import { fileCommentStore, formatFileCommentsPrompt, type FileComment } from './file-comments.ts'
import { t } from './locales.ts'
import { headerOf } from './selection-payload.ts'
import css from './sidebar.module.css'

type CommentView = 'current' | 'history'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function FileCommentsPanel(props: {
  ctx: Context
  sessionId: string
  cwd: string | undefined
  path: string
}) {
  const { ctx, sessionId, cwd, path } = props
  const comments = useSyncExternalStore(
    useCallback(listener => fileCommentStore.subscribe(sessionId, listener), [sessionId]),
    useCallback(() => fileCommentStore.getSnapshot(sessionId), [sessionId]),
  )
  const [view, setView] = useState<CommentView>('current')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')

  const current = useMemo(
    () => comments.filter(comment => comment.path === path && comment.sentAt === undefined),
    [comments, path],
  )
  const history = useMemo(
    () => comments
      .filter(comment => comment.path === path && comment.sentAt !== undefined)
      .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0)),
    [comments, path],
  )
  const rows = view === 'current' ? current : history

  const sendCurrent = async (): Promise<void> => {
    if (sending || editingId !== null || current.length === 0) return
    const ids = current.map(comment => comment.id)
    setSending(true)
    setSendError('')
    try {
      await sendToConversation(ctx, sessionId, formatFileCommentsPrompt(current, cwd))
      fileCommentStore.markSent(sessionId, ids)
      setView('history')
    } catch (error) {
      setSendError(t('fileCommentsSendFailed', { error: errorText(error) }))
    } finally {
      setSending(false)
    }
  }

  const startEditing = (comment: FileComment): void => {
    setEditingId(comment.id)
    setEditBody(comment.body)
  }

  const commitEdit = (): void => {
    if (editingId === null || editBody.trim() === '') return
    fileCommentStore.update(sessionId, editingId, editBody)
    setEditingId(null)
    setEditBody('')
  }

  return (
    <section className={css.fileCommentsPanel} aria-label={t('fileCommentsPanel')}>
      <header className={css.fileCommentsHeader}>
        <div className={css.fileCommentsModes} role="tablist" aria-label={t('fileCommentsPanel')}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'current'}
            className={view === 'current' ? css.fileCommentsModeActive : undefined}
            onClick={() => { setView('current') }}
          >
            <LuInbox size={14} />
            <span>{t('fileCommentsCurrent')}</span>
            {current.length > 0 && <span className={css.fileCommentsModeCount}>{current.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'history'}
            className={view === 'history' ? css.fileCommentsModeActive : undefined}
            onClick={() => { setView('history') }}
          >
            <LuHistory size={14} />
            <span>{t('history')}</span>
          </button>
        </div>
        <button
          type="button"
          className={css.fileCommentsSend}
          aria-label={t('fileCommentsSend')}
          title={t('fileCommentsSend')}
          disabled={sending || editingId !== null || current.length === 0}
          onClick={() => { void sendCurrent() }}
        >
          <LuSend size={15} />
        </button>
      </header>

      {sendError !== '' && <div className={css.fileCommentsError} role="alert">{sendError}</div>}

      <div className={css.fileCommentsList} role="tabpanel">
        {rows.length === 0 && (
          <div className={css.fileCommentsEmpty}>
            {view === 'current' ? t('fileCommentsEmptyCurrent') : t('fileCommentsEmptyHistory')}
          </div>
        )}
        {rows.map(comment => (
          <article key={comment.id} className={css.fileCommentRow}>
            <div className={css.fileCommentMeta}>
              <span title={comment.path}>{headerOf(comment.path, cwd, comment.lines)}</span>
              {comment.sentAt !== undefined && (
                <time dateTime={new Date(comment.sentAt).toISOString()}>{new Date(comment.sentAt).toLocaleString()}</time>
              )}
            </div>
            {comment.selectionOmitted
              ? <div className={css.fileCommentSelectionOmitted}>{t('fileCommentsSelectionOmitted')}</div>
              : comment.selectedText !== '' && <pre className={css.fileCommentSelection}>{comment.selectedText}</pre>}
            {editingId === comment.id ? (
              <div className={css.fileCommentEdit}>
                <textarea
                  value={editBody}
                  aria-label={t('fileCommentsEdit')}
                  autoFocus
                  onChange={(event) => { setEditBody(event.currentTarget.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditingId(null)
                      setEditBody('')
                    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault()
                      commitEdit()
                    }
                  }}
                />
                <div className={css.fileCommentEditActions}>
                  <button type="button" aria-label={t('cancel')} title={t('cancel')} onClick={() => { setEditingId(null); setEditBody('') }}>
                    <LuX size={14} />
                  </button>
                  <button type="button" aria-label={t('save')} title={t('save')} disabled={editBody.trim() === ''} onClick={commitEdit}>
                    <LuCheck size={14} />
                  </button>
                </div>
              </div>
            ) : (
              <div className={css.fileCommentBody}>{comment.body}</div>
            )}
            {view === 'current' && editingId !== comment.id && (
              <div className={css.fileCommentActions}>
                <button type="button" aria-label={t('fileCommentsEdit')} title={t('fileCommentsEdit')} disabled={sending} onClick={() => { startEditing(comment) }}>
                  <LuPencil size={13} />
                </button>
                <button type="button" aria-label={t('fileCommentsDelete')} title={t('fileCommentsDelete')} disabled={sending} onClick={() => { fileCommentStore.remove(sessionId, comment.id) }}>
                  <LuTrash2 size={13} />
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
