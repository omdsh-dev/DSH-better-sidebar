/**
 * Side Chat page: Codex-style side conversations for the current session.
 *
 * Each side thread is a child session the plugin created itself with a
 * custom seed (the parent's full log up to the click moment — see
 * sidechat-core.ts). The page shows the thread list of the current session
 * (durable `origin: 'subagent'` children whose pinned title carries the
 * 'Side: ' prefix) and, for the selected thread, its own conversation
 * (user / assistant / reasoning / tool rows), a composer for follow-ups,
 * and the "save as new session" promotion.
 *
 * Transport: thread creation/follow-up/cancel/dispose go through the
 * plugin's own /sidebar/api sidechat.* routes (subagent-origin identities
 * are fenced from the generic session RPCs); the transcript is polled from
 * the generic session.history RPC (seed-cut at session/end-seed, boundary
 * row dropped, chunk streaming accumulated) — see sidechat-transcript.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarHistoryEntry } from '../context-types.ts'
import {
  SIDE_LABEL_PREFIX,
  sideThreadRows,
  threadHasCompletedTurn,
  threadTrailingPending,
} from '../sidechat-core.ts'
import { transcriptRows, type SidechatTranscriptRow } from './sidechat-transcript.ts'
import { api } from './api.ts'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import css from './SideChatView.module.css'

/** Tail-page size for one transcript fetch (events per page). Small on
 *  purpose: a thread inherits the ENTIRE parent log as its seed, and the
 *  seed is dense with chunk/reasoning events — a large window would drag
 *  megabytes of inherited seed across the wire for every poll. */
const PAGE_MESSAGES = 8
/** Backward-page cap for the first seed-boundary walk. */
const SEED_WALK_PAGES = 32
/** Poll cadence while the selected thread is running and the tab visible. */
const POLL_MS = 2000

/** Per-thread transcript cache: seed boundary + thread-own events merged by
 *  seq (streaming polls never re-download the inherited seed). */
interface ThreadCache {
  seedBoundary: number | null
  entries: SidebarHistoryEntry[]
}

/** Merge history entries by event seq (newest wins), log order preserved. */
function mergeBySeq(
  previous: readonly SidebarHistoryEntry[],
  incoming: readonly SidebarHistoryEntry[],
): SidebarHistoryEntry[] {
  const bySeq = new Map<number, SidebarHistoryEntry>()
  for (const entry of previous) bySeq.set(entry.event.seq, entry)
  for (const entry of incoming) bySeq.set(entry.event.seq, entry)
  return [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq)
}

/** One row renderer (React keys ride the source event seq). */
function renderRow(row: SidechatTranscriptRow, codeLabels: { copyLabel: string; copiedLabel: string }): React.ReactNode {
  switch (row.kind) {
    case 'user':
      return (
        <div key={row.seq} className={css.sidechatUser}>
          <MarkdownText text={row.text} codeLabels={codeLabels} />
        </div>
      )
    case 'assistant':
      return (
        <div key={row.seq} className={css.sidechatAssistant}>
          <MarkdownText text={row.text} codeLabels={codeLabels} />
        </div>
      )
    case 'reasoning':
      return <div key={row.seq} className={css.sidechatReasoning}>{row.text}</div>
    case 'tool':
      return (
        <details key={row.seq} className={css.sidechatTool}>
          <summary className={clsx(css.sidechatToolSummary, row.failed && css.sidechatToolFailed)}>
            {row.name}{row.executing === true ? ' …' : ''}{row.failed ? ' ✕' : ''}
          </summary>
          {row.args !== undefined && <pre className={css.sidechatToolArgs}>{row.args}</pre>}
          {row.resultText !== undefined && <pre className={css.sidechatToolResult}>{row.resultText}</pre>}
        </details>
      )
  }
}

/** The Side Chat tab body. */
export function SideChatView(props: {
  ctx: Context
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
}): React.ReactNode {
  const { ctx, scope, tab, visible } = props
  const codeLabels = useMemo(
    () => ({ copyLabel: t('copy'), copiedLabel: t('copied') }),
    [],
  )

  // The session list feed: thread rows + running states.
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const threads = useMemo(
    () => sideThreadRows(list.byId, scope.sessionId),
    [list, scope.sessionId],
  )

  // Selected thread id rides tab.meta so a refresh restores the open thread.
  const [selectedId, setSelectedIdState] = useState<string | null>(
    () => {
      const meta = tab.meta as { threadId?: unknown } | undefined
      return typeof meta?.threadId === 'string' ? meta.threadId : null
    },
  )
  const setSelected = useCallback((id: string | null): void => {
    setSelectedIdState(id)
    try {
      const meta = (tab.meta ?? {}) as Record<string, unknown>
      ctx.betterSidebar?.updateTab(tab.id, { meta: { ...meta, threadId: id } })
    } catch {
      // Persisting the selection is best-effort; the tab stays usable.
    }
  }, [ctx, tab])

  const [newDraft, setNewDraft] = useState('')
  const [composer, setComposer] = useState('')
  const [busy, setBusy] = useState<'starting' | 'sending' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)

  const cacheRef = useRef<ThreadCache>({ seedBoundary: null, entries: [] })
  const controllerRef = useRef<AbortController | null>(null)

  const selectedSummary = selectedId === null ? undefined : list.byId[selectedId]
  const selectedRunning = selectedSummary?.running === true
  const selectedTitle = useMemo(() => {
    if (selectedId === null) return ''
    const row = threads.find(candidate => candidate.id === selectedId)
    return row?.title ?? selectedSummary?.displayTitle ?? selectedId
  }, [threads, selectedSummary, selectedId])

  /** One transcript pull: the first read walks back to the seed boundary,
   *  later reads fetch one tail page and merge (seq-deduped). */
  const fetchThread = useCallback(async (childId: string): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const cache = cacheRef.current
    try {
      if (cache.seedBoundary === null) {
        const collected: SidebarHistoryEntry[] = []
        let beforeSeq: number | undefined
        for (let page = 0; page < SEED_WALK_PAGES; page++) {
          const response = await ctx.connection.api.sessions.history(
            {
              sessionId: childId,
              maxMessages: PAGE_MESSAGES,
              ...(beforeSeq === undefined ? {} : { beforeSeq }),
            },
            controller.signal,
          )
          if (!response.result.ok) return
          const events = response.result.value.events
          if (events.length === 0) break
          const olderThan = collected.length > 0 ? collected[0]!.event.seq : undefined
          const fresh = olderThan === undefined
            ? events
            : events.filter(entry => entry.event.seq < olderThan)
          const seedEnd = fresh.findLastIndex(entry => entry.event.type === 'session/end-seed')
          if (seedEnd >= 0) {
            cache.seedBoundary = fresh[seedEnd]!.event.seq
            collected.unshift(...fresh.slice(seedEnd + 1))
            break
          }
          collected.unshift(...fresh)
          if (fresh.length === 0) break
          beforeSeq = fresh[0]!.event.seq
        }
        cache.entries = mergeBySeq(cache.entries, collected)
      } else {
        const response = await ctx.connection.api.sessions.history(
          { sessionId: childId, maxMessages: PAGE_MESSAGES },
          controller.signal,
        )
        if (!response.result.ok) return
        cache.entries = mergeBySeq(cache.entries, response.result.value.events)
      }
      setRevision(value => value + 1)
    } catch {
      // Aborted by a newer pull or a wire failure: keep the last rows.
    }
  }, [ctx])

  // Reset the transcript cache whenever the selection changes.
  useEffect(() => {
    cacheRef.current = { seedBoundary: null, entries: [] }
    controllerRef.current?.abort()
    setError(null)
    setSaved(false)
  }, [selectedId])

  // Poll while the tab is visible and the selected thread runs.
  useEffect(() => {
    if (!visible || selectedId === null) return
    void fetchThread(selectedId)
    if (!selectedRunning) return
    const timer = window.setInterval(() => { void fetchThread(selectedId) }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [visible, selectedId, selectedRunning, fetchThread])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  const rows = useMemo(
    () => (selectedId === null ? [] : transcriptRows(cacheRef.current.entries)),
    // The cache is a ref; revision bumps on every successful pull.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, revision],
  )
  const canSave = selectedId !== null && threadHasCompletedTurn(cacheRef.current.entries)
  const trailingPending = selectedId !== null && threadTrailingPending(cacheRef.current.entries)

  const handleStart = async (): Promise<void> => {
    const question = newDraft.trim()
    if (question === '' || busy !== null) return
    setBusy('starting')
    setError(null)
    try {
      const { childId } = await api.sidechatStart(scope.sessionId, question)
      setNewDraft('')
      setSelected(childId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const handleSend = async (): Promise<void> => {
    const text = composer.trim()
    if (text === '' || selectedId === null || busy !== null) return
    setBusy('sending')
    setError(null)
    try {
      await api.sidechatPrompt(selectedId, text)
      setComposer('')
      void fetchThread(selectedId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (selectedId === null || busy !== null) return
    try {
      await api.sidechatCancel(selectedId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleClose = async (): Promise<void> => {
    if (selectedId === null || busy !== null) return
    try {
      await api.sidechatDispose(selectedId)
      setSelected(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleSave = async (): Promise<void> => {
    if (selectedId === null || !canSave || busy !== null) return
    setBusy('saving')
    setError(null)
    setSaved(false)
    try {
      const fork = ctx.sessions.fork
      if (fork === undefined) throw new Error('session fork is unavailable')
      const newId = await fork({ sessionId: selectedId, increaseTitle: true })
      const title = selectedTitle.startsWith(SIDE_LABEL_PREFIX)
        ? selectedTitle.slice(SIDE_LABEL_PREFIX.length).trim()
        : selectedTitle.trim()
      const binding = ctx.sessions.binding?.(newId)
      if (binding !== undefined && title !== '') {
        await binding.session.rename(title)
      }
      ctx.sessions.open?.(newId)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={css.sidechat}>
      <div className={css.sidechatHeader}>
        <span className={css.sidechatTitle}>{t('sideChat')}</span>
      </div>
      <div className={css.sidechatBody}>
        <div className={css.sidechatList}>
          <input
            className={css.sidechatNewInput}
            value={newDraft}
            placeholder={t('sideChatPlaceholder')}
            disabled={busy !== null}
            onChange={event => { setNewDraft(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void handleStart()
            }}
          />
          {threads.length === 0 && (
            <div className={css.sidechatEmpty}>
              <div>{t('sideChatEmpty')}</div>
              <div className={css.sidechatEmptyDesc}>{t('sideChatEmptyDesc')}</div>
            </div>
          )}
          {threads.map(row => (
            <button
              key={row.id}
              type="button"
              className={clsx(css.sidechatThread, row.id === selectedId && css.sidechatThreadActive)}
              onClick={() => { setSelected(row.id) }}
              title={row.title}
            >
              <span className={clsx(css.sidechatDot, row.running && css.sidechatDotRunning)} />
              <span className={css.sidechatThreadTitle}>{row.title}</span>
            </button>
          ))}
        </div>
        <div className={css.sidechatDetail}>
          {selectedId === null ? (
            <div className={css.sidechatDetailEmpty}>{t('sideChatEmpty')}</div>
          ) : (
            <>
              <div className={css.sidechatDetailHeader}>
                <span className={css.sidechatDetailTitle}>{selectedTitle}</span>
                <button
                  type="button"
                  className={css.sidechatBtn}
                  onClick={() => void handleSave()}
                  disabled={!canSave || busy !== null}
                  title={t('sideChatSaveTitle')}
                >
                  {t('sideChatSave')}
                </button>
                {selectedRunning && (
                  <button
                    type="button"
                    className={css.sidechatBtn}
                    onClick={() => void handleCancel()}
                    disabled={busy !== null}
                    title={t('sideChatCancelTitle')}
                  >
                    {t('sideChatCancel')}
                  </button>
                )}
                <button
                  type="button"
                  className={css.sidechatBtn}
                  onClick={() => void handleClose()}
                  disabled={busy !== null}
                  title={t('sideChatCloseTitle')}
                >
                  {t('sideChatClose')}
                </button>
              </div>
              {selectedId !== null && !canSave && <div className={css.sidechatHint}>{t('sideChatNoTurn')}</div>}
              {selectedId !== null && canSave && trailingPending
                && <div className={css.sidechatHint}>{t('sideChatPendingDrop')}</div>}
              {saved && <div className={css.sidechatHint}>{t('sideChatSaved')}</div>}
              {error !== null && <div className={css.sidechatError}>{t('sideChatError', { message: error })}</div>}
              <div className={css.sidechatScroll}>
                {rows.length === 0
                  ? (selectedRunning
                    ? <div className={css.sidechatHint}>{t('subagentThinking')}</div>
                    : null)
                  : rows.map(row => renderRow(row, codeLabels))}
              </div>
              <div className={css.sidechatComposer}>
                <input
                  className={css.sidechatComposerInput}
                  value={composer}
                  placeholder={t('sideChatComposerPlaceholder')}
                  disabled={busy !== null}
                  onChange={event => { setComposer(event.target.value) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) void handleSend()
                  }}
                />
                <button
                  type="button"
                  className={css.sidechatBtn}
                  onClick={() => void handleSend()}
                  disabled={composer.trim() === '' || busy !== null}
                >
                  {t('sideChatSend')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
