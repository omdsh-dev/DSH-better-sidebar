/**
 * Per-turn file-change history for the current session.
 *
 * The view polls the generic `sessions.history` RPC (the same transport the
 * Side Chat transcript uses), walks the append-only log, and folds the
 * produced paths of each completed turn — reusing the plugin's own
 * `producedPaths` mutation-intent derivation (a `diff` card or a generic
 * `edit` card carries `locations`; reads, deletes and failed calls
 * contribute nothing, matching the ui-deliverables contract). One row per
 * turn that changed files; the chips open the path in the sidebar editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { IconCodeOutline16, IconRefreshOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconDiffOutline16 } from './icons.tsx'
import type { Context, SidebarHistoryEntry } from '../context-types.ts'
import { openSidebarFile } from './intercept.tsx'
import { producedPaths } from './produced-files.ts'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'
import subagentCss from './SubagentView.module.css'

/** Tail-page size for one change poll. Small on purpose: streaming polls
 *  ride the tail and merge by seq, like Side Chat's transcript. */
const CHANGES_PAGE_EVENTS = 200
/** First-attach walk cap: how many backward pages the initial load fetches.
 *  6 × 200 = 1200 events is ample for the recent-change history; older
 *  turns simply fall off the view (the max-turns cap also bounds the list). */
const CHANGES_WALK_CAP = 6
/** Poll cadence while the tab is visible. */
const CHANGES_POLL_MS = 2000
/** How many turn rows to keep at most (newest first). */
const CHANGES_MAX_TURNS = 60
/** How many file chips one turn row shows before collapsing into `+N`. */
const CHANGES_CHIP_LIMIT = 8

/** One completed turn that produced files. */
interface TurnChange {
  turn: number
  seq: number
  time: number
  paths: string[]
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

/**
 * Fold one history log into per-turn produced paths. A `turn/start` begins a
 * new accumulation and clears the call→view index (the upstream deliverables
 * Definition keeps its own per-turn calls map, so a result only derives paths
 * from calls observed within the same turn); `turn/end` seals the turn. Paths
 * keep first-seen order and appear once per turn.
 * @param entries - merged history rows (event + host-computed view) in seq order.
 * @returns turns that produced files, oldest first.
 */
export function collectTurnChanges(entries: readonly SidebarHistoryEntry[]): TurnChange[] {
  const turns: TurnChange[] = []
  const callViews = new Map<string, unknown>()
  let current: { turn: number; seq: number; time: number; paths: string[]; seen: Set<string> } | null = null
  const flush = (): void => {
    if (current !== null && current.paths.length > 0) {
      turns.push({ turn: current.turn, seq: current.seq, time: current.time, paths: current.paths })
    }
    current = null
  }
  for (const entry of entries) {
    const event = entry?.event
    if (event === null || typeof event !== 'object') continue
    const data = (event as { data?: Record<string, unknown> }).data ?? {}
    if (event.type === 'turn/start') {
      const turn = typeof data.turn === 'number' ? data.turn : NaN
      if (current !== null && current.turn !== turn) flush()
      callViews.clear()
      current = { turn, seq: event.seq, time: event.time, paths: [], seen: new Set() }
    } else if (event.type === 'turn/end') {
      flush()
    } else if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const view = entry.view
      if (callId !== undefined) {
        callViews.set(
          callId,
          view !== undefined && view !== null && (view as { for?: string }).for === 'call'
            ? (view as { view?: unknown }).view
            : null,
        )
      }
    } else if (event.type === 'tool/result' && current !== null) {
      const message = (data as { message?: { source?: unknown; content?: unknown } }).message
      const source = message?.source
      const callId = source !== null && typeof source === 'object'
        && typeof (source as { callId?: unknown }).callId === 'string'
        ? (source as { callId: string }).callId
        : undefined
      const content = message?.content
      const isError = Array.isArray(content)
        && content[0] !== null
        && typeof content[0] === 'object'
        && (content[0] as { isError?: unknown }).isError === true
      if (isError || callId === undefined) continue
      const view = callViews.get(callId)
      if (view === undefined || view === null) continue
      for (const path of producedPaths(view)) {
        if (current.seen.has(path)) continue
        current.seen.add(path)
        current.paths.push(path)
      }
    }
  }
  flush()
  return turns
}

/** The file chips of one turn row (opened in the sidebar editor). */
function ChangeChips(props: {
  paths: readonly string[]
  ctx: Context
  store: SidebarStore
  sessionId: string
}): React.ReactNode {
  const { paths, ctx, store, sessionId } = props
  const shown = paths.slice(0, CHANGES_CHIP_LIMIT)
  const hidden = paths.length - shown.length
  return (
    <div className={css.producedRow}>
      {shown.map(path => {
        const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        const name = at === -1 ? path : path.slice(at + 1)
        return (
          <button
            key={path}
            type="button"
            className={css.producedChip}
            title={path}
            onClick={() => { openSidebarFile(ctx, store, sessionId, path) }}
          >
            <IconCodeOutline16 size={12} />
            <span>{name}</span>
          </button>
        )
      })}
      {hidden > 0 && <span className={css.producedMore}>+{hidden}</span>}
    </div>
  )
}

/** The per-turn file-change history page (one row per changed turn). */
export function ChangesView(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  visible: boolean
}): React.ReactNode {
  const { ctx, store, scope, visible } = props
  const sessionId = scope.sessionId
  const sessions = ctx.sessions
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
    useCallback(() => sessions.list.getSnapshot(), [sessions]),
  )
  const [revision, setRevision] = useState(0)
  const cacheRef = useRef<{ entries: SidebarHistoryEntry[] }>({ entries: [] })
  const controllerRef = useRef<AbortController | null>(null)

  const fetchChanges = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const cache = cacheRef.current
    try {
      let merged = cache.entries
      if (merged.length === 0) {
        const collected: SidebarHistoryEntry[] = []
        let beforeSeq: number | undefined
        for (let page = 0; page < CHANGES_WALK_CAP; page++) {
          const response = await ctx.connection.api.sessions.history({
            sessionId,
            maxMessages: CHANGES_PAGE_EVENTS,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          }, controller.signal)
          if (!response.result.ok) throw new Error('history walk failed')
          const value = response.result.value
          if (value.events.length === 0) break
          collected.push(...value.events)
          if (!value.hasMore) break
          const last = value.events[value.events.length - 1]
          if (last === undefined) break
          beforeSeq = last.event.seq
        }
        merged = mergeBySeq([], collected)
      } else {
        const response = await ctx.connection.api.sessions.history({
          sessionId,
          maxMessages: CHANGES_PAGE_EVENTS,
        }, controller.signal)
        if (response.result.ok) merged = mergeBySeq(cache.entries, response.result.value.events)
      }
      cache.entries = merged
      setRevision(value => value + 1)
    } catch {
      // Poll errors are swallowed (the next tick retries); an aborted
      // controller on teardown is expected and not an error.
    }
  }, [ctx, sessionId])

  useEffect(() => {
    cacheRef.current = { entries: [] }
    controllerRef.current?.abort()
    setRevision(0)
  }, [sessionId])

  useEffect(() => {
    if (!visible) return
    void fetchChanges()
    const timer = window.setInterval(() => { void fetchChanges() }, CHANGES_POLL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [visible, sessionId, fetchChanges])

  useEffect(() => () => {
    controllerRef.current?.abort()
  }, [])

  const turns = useMemo(
    () => collectTurnChanges(cacheRef.current.entries).reverse().slice(0, CHANGES_MAX_TURNS),
    [revision], // eslint-disable-line react-hooks/exhaustive-deps -- cacheRef is intentionally a live mutable store
  )
  const totalFiles = useMemo(() => turns.reduce((acc, row) => acc + row.paths.length, 0), [turns])
  const isEmpty = turns.length === 0

  return (
    <div className={subagentCss.subagent}>
      <div className={subagentCss.subagentHeader}>
        <span className={subagentCss.subagentTitle}>{t('changes')}</span>
        {!isEmpty && <span className={subagentCss.subagentCount}>{t('changesFiles', { count: totalFiles })}</span>}
        <button
          type="button"
          className={subagentCss.subagentRefresh}
          aria-label={t('changesRefresh')}
          title={t('changesRefresh')}
          onClick={() => { void fetchChanges() }}
        >
          <IconRefreshOutline14 />
        </button>
      </div>
      <div className={subagentCss.subagentBody}>
        {isEmpty ? (
          <div className={subagentCss.subagentEmpty}>
            <span>{t('changesEmpty')}</span>
            <span className={subagentCss.subagentEmptyHint}>{t('changesEmptyHint')}</span>
          </div>
        ) : turns.map(row => (
          <div key={row.seq} className={subagentCss.subagentRow} style={{ cursor: 'default' }}>
            <StateDot state="done" className={subagentCss.subagentDot} />
            <div className={subagentCss.subagentContent}>
              <span className={subagentCss.subagentLabel}>
                {t('changesTurn', { turn: row.turn })} · {t('changesFiles', { count: row.paths.length })}
              </span>
              <ChangeChips paths={row.paths} ctx={ctx} store={store} sessionId={sessionId} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
