/**
 * Per-turn file-change history for the current session.
 *
 * The view polls the generic `sessions.history` RPC (the same transport the
 * Side Chat transcript uses), walks the append-only log, and folds the
 * produced paths of each completed turn — reusing the plugin's own
 * `producedPaths` mutation-intent derivation (a `diff` card or a generic
 * `edit` card carries `locations`; reads, deletes and failed calls
 * contribute nothing, matching the ui-deliverables contract). One row per
 * turn that changed files; the chips open the change as a git-style diff tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCodeOutline16, IconRefreshOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarHistoryEntry } from '../context-types.ts'
import { producedPaths } from './produced-files.ts'
import { buildUnifiedDiff, type FileChangeText } from './diff.ts'
import { DiffView } from './DiffView.tsx'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'
import subagentCss from './SubagentView.module.css'

/** First-attach page size (messages). `maxMessages` counts MESSAGES and a
 *  single message can expand to hundreds of chunk/tool events — a 200-message
 *  page returned ~75k events / ~16 MB, which stalled the browser. 40 messages
 *  (~3 MB) covers ~2 completed turns and keeps the first paint responsive;
 *  the walk pages backward until it has enough turns or hits the cap. */
const CHANGES_PAGE_EVENTS = 40
/** Poll page size (messages): the incremental tail fetch only needs the NEWEST
 *  events, so a small page keeps the 2s poll light. */
const CHANGES_POLL_EVENTS = 8
/** First-attach walk cap: how many backward pages the initial load fetches
 *  before it must already have found the recent turns. */
const CHANGES_WALK_CAP = 6
/** Poll cadence while the tab is visible. */
const CHANGES_POLL_MS = 2000
/** How many turn rows to keep at most (newest first). */
const CHANGES_MAX_TURNS = 60
/** How many file chips one turn row shows before collapsing into `+N`. */
const CHANGES_CHIP_LIMIT = 8
/** Hard cap on retained history events (memory bound): the merged cache never
 *  grows unbounded across many polls — only the newest tail is kept, which is
 *  all the recent-turns view needs. */
const CHANGES_MAX_EVENTS = 30000

/** One completed turn that produced files. */
interface TurnChange {
  turn: number
  seq: number
  time: number
  paths: string[]
  /** Per-file before/after text for that turn (last mutation wins per file). */
  changes: FileChangeText[]
}

/** Merge history entries by event seq (newest wins), log order preserved.
 *  Keeps only the NEWEST {@link CHANGES_MAX_EVENTS} events so the cache stays
 *  bounded no matter how long the session runs. */
function mergeBySeq(
  previous: readonly SidebarHistoryEntry[],
  incoming: readonly SidebarHistoryEntry[],
): SidebarHistoryEntry[] {
  const bySeq = new Map<number, SidebarHistoryEntry>()
  for (const entry of previous) bySeq.set(entry.event.seq, entry)
  for (const entry of incoming) bySeq.set(entry.event.seq, entry)
  const sorted = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq)
  return sorted.length > CHANGES_MAX_EVENTS ? sorted.slice(sorted.length - CHANGES_MAX_EVENTS) : sorted
}

/**
 * Extract the per-file before/after text from a tool/result view. Mutation
 * tools (`write` / `edit`) return a `card: 'diff'` result view whose `diffs`
 * carry the applied change as `{ path, oldText, newText }` (full-file hunks
 * for `edit` via `computeHunkDiffs`, the whole content for `write`).
 * @param view - the `entry.view` of a `tool/result` event.
 * @returns file changes, or an empty array when the view is not a diff card.
 */
function diffChangesFromResultView(view: unknown): FileChangeText[] {
  if (view === null || typeof view !== 'object') return []
  const record = view as { for?: unknown; view?: unknown }
  if (record.for !== 'result') return []
  const inner = record.view as { card?: unknown; diffs?: unknown } | null
  if (inner === null || typeof inner !== 'object') return []
  if (inner.card !== 'diff') return []
  if (!Array.isArray(inner.diffs)) return []
  const changes: FileChangeText[] = []
  for (const item of inner.diffs) {
    if (item === null || typeof item !== 'object') continue
    const d = item as { path?: unknown; oldText?: unknown; newText?: unknown }
    if (typeof d.path !== 'string' || typeof d.newText !== 'string') continue
    changes.push({ path: d.path, oldText: d.oldText === null ? null : typeof d.oldText === 'string' ? d.oldText : null, newText: d.newText })
  }
  return changes
}

/**
 * Fold one history log into per-turn produced paths. A `turn/start` begins a
 * new accumulation and clears the call→view index (the upstream deliverables
 * Definition keeps its own per-turn calls map, so a result only derives paths
 * from calls observed within the same turn); `turn/end` seals the turn. Paths
 * keep first-seen order and appear once per turn; per-file before/after text
 * (from the result view's `diffs`) lets the click render a REAL per-turn diff.
 * @param entries - merged history rows (event + host-computed view) in seq order.
 * @returns turns that produced files, oldest first.
 */
export function collectTurnChanges(entries: readonly SidebarHistoryEntry[]): TurnChange[] {
  const turns: TurnChange[] = []
  const callViews = new Map<string, unknown>()
  let current: { turn: number; seq: number; time: number; paths: string[]; seen: Set<string>; changes: Map<string, FileChangeText> } | null = null
  const flush = (): void => {
    if (current !== null && current.paths.length > 0) {
      turns.push({
        turn: current.turn,
        seq: current.seq,
        time: current.time,
        paths: current.paths,
        changes: [...current.changes.values()],
      })
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
      current = { turn, seq: event.seq, time: event.time, paths: [], seen: new Set(), changes: new Map() }
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
      // Capture the per-file before/after from the result view (last write
      // wins: a file edited several times in one turn shows its final delta).
      for (const change of diffChangesFromResultView(entry.view)) {
        current.changes.set(change.path, change)
      }
    }
  }
  flush()
  return turns
}

/** One turn row: a clickable turn header (expand/collapse all files) with the
 *  file chips ALWAYS shown below it; clicking a chip expands THAT file's real
 *  per-turn diff inline (no git round-trip). */
function TurnRow(props: {
  row: TurnChange
  expanded: ReadonlySet<string>
  onToggleTurn: (row: TurnChange) => void
  onToggleFile: (seq: number, path: string) => void
  ctx: Context
}): React.ReactNode {
  const { row, expanded, onToggleTurn, onToggleFile, ctx } = props
  const keyOf = (path: string): string => `${row.seq}:${path}`
  const allOn = row.paths.length > 0 && row.paths.every(path => expanded.has(keyOf(path)))
  const changeFor = (path: string): FileChangeText | undefined => {
    const norm = (p: string): string => p.replace(/\\/g, '/')
    return row.changes.find(c => norm(c.path) === norm(path))
  }
  const shown = row.paths.slice(0, CHANGES_CHIP_LIMIT)
  const hidden = row.paths.length - shown.length
  return (
    <div className={subagentCss.subagentRow} style={{ cursor: 'default' }}>
      <StateDot state="done" className={subagentCss.subagentDot} />
      <div className={subagentCss.subagentContent}>
        <button
          type="button"
          className={css.changesTurnHeader}
          aria-expanded={allOn}
          onClick={() => { onToggleTurn(row) }}
        >
          <span aria-hidden="true" className={clsx(css.changesTurnChevron, allOn && css.changesTurnChevronExpanded)}>›</span>
          <span className={css.changesTurnLabel}>
            {t('changesTurn', { turn: row.turn })} · {t('changesFiles', { count: row.paths.length })}
          </span>
        </button>
        <div className={css.producedRow}>
          {shown.map(path => {
            const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
            const name = at === -1 ? path : path.slice(at + 1)
            const open = expanded.has(keyOf(path))
            const change = changeFor(path)
            return (
              <button
                key={path}
                type="button"
                className={clsx(css.producedChip, open && css.producedChipActive)}
                title={path}
                aria-expanded={open}
                onClick={() => {
                  // A captured per-turn change expands inline; a path without
                  // one (edge case) still opens the worktree git diff tab.
                  if (change !== undefined) {
                    onToggleFile(row.seq, path)
                  } else {
                    ctx.betterSidebar?.openTab({
                      type: 'diff',
                      id: `diff:w:u:${path}`,
                      title: name,
                      diff: { kind: 'worktree', path, staged: false, untracked: true },
                    })
                  }
                }}
              >
                <IconCodeOutline16 size={12} />
                <span>{name}</span>
              </button>
            )
          })}
          {hidden > 0 && <span className={css.producedMore}>+{hidden}</span>}
        </div>
        {shown.filter(path => expanded.has(keyOf(path))).map(path => {
          const change = changeFor(path)
          if (change === undefined) return null
          const unified = buildUnifiedDiff([change])
          if (unified === '') return null
          return (
            <div key={keyOf(path)} className={css.changesInlineDiff}>
              <DiffView diff={unified} defaultExpanded />
            </div>
          )
        })}
      </div>
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
  const { ctx, scope, visible } = props
  const sessionId = scope.sessionId
  const sessions = ctx.sessions
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
    useCallback(() => sessions.list.getSnapshot(), [sessions]),
  )
  const [revision, setRevision] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  /** Expanded per-file inline diffs: keys are `${seq}:${path}` (one turn can
   *  touch the same file more than once — the seq anchor keeps them apart). */
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set())
  const cacheRef = useRef<{ entries: SidebarHistoryEntry[] }>({ entries: [] })
  const controllerRef = useRef<AbortController | null>(null)

  const toggleFile = useCallback((seq: number, path: string): void => {
    setExpandedFiles(current => {
      const key = `${seq}:${path}`
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleTurn = useCallback((row: TurnChange): void => {
    setExpandedFiles(current => {
      const next = new Set(current)
      const allOn = row.paths.length > 0 && row.paths.every(path => next.has(`${row.seq}:${path}`))
      for (const path of row.paths) {
        const key = `${row.seq}:${path}`
        if (allOn) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }, [])

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
          if (!response.result.ok) throw new Error(`history failed: ${response.result.error.code} ${response.result.error.message}`)
          const value = response.result.value
          if (value.events.length === 0) break
          collected.push(...value.events)
          // Early stop: once the accumulated window holds a healthy number of
          // COMPLETED turns, the recent-changes view has what it needs — no
          // need to keep walking into the deep past (each page is multi-MB).
          const completed = collected.filter(e => e.event.type === 'turn/end').length
          if (!value.hasMore || completed >= CHANGES_MAX_TURNS) break
          // `history` returns events in log order (oldest first); the window
          // is cut at `beforeSeq` (exclusive), so to page OLDER we continue
          // from the OLDEST seq this page returned.
          const oldest = value.events[0]
          if (oldest === undefined) break
          beforeSeq = oldest.event.seq
        }
        merged = mergeBySeq([], collected)
      } else {
        const response = await ctx.connection.api.sessions.history({
          sessionId,
          maxMessages: CHANGES_POLL_EVENTS,
        }, controller.signal)
        if (response.result.ok) merged = mergeBySeq(cache.entries, response.result.value.events)
      }
      cache.entries = merged
      setLastError(null)
      setRevision(value => value + 1)
    } catch (error) {
      // Keep the last error visible so a broken fetch is diagnosable instead
      // of silently showing "no changes".
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setLastError(error instanceof Error ? error.message : String(error))
      }
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
        {lastError !== null ? (
          <div className={subagentCss.subagentEmpty} style={{ textAlign: 'left', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-danger, #f2a1a1)' }}>
            <span>Changes fetch error</span>
            <span className={subagentCss.subagentEmptyHint}>{lastError}</span>
            <span className={subagentCss.subagentEmptyHint}>session={sessionId}</span>
          </div>
        ) : isEmpty ? (
          <div className={subagentCss.subagentEmpty}>
            <span>{t('changesEmpty')}</span>
            <span className={subagentCss.subagentEmptyHint}>{t('changesEmptyHint')}</span>
            <span className={subagentCss.subagentEmptyHint}>session={sessionId} entries={cacheRef.current.entries.length}</span>
          </div>
        ) : turns.map(row => (
          <TurnRow
            key={row.seq}
            row={row}
            expanded={expandedFiles}
            onToggleTurn={toggleTurn}
            onToggleFile={toggleFile}
            ctx={ctx}
          />
        ))}
      </div>
    </div>
  )
}
