/**
 * Side Chat page: Codex-style side conversations for the current session.
 *
 * EVERY side conversation is its own sidebar tab (侧边对话1/2/3 …): the
 * descriptor's createTab mints a fresh tab flagged `autoCreate` and this
 * view creates the EMPTY thread on mount (one click = one conversation,
 * exactly like the Codex app); the composer owns the first message (the
 * host wraps it with the side boundary + the in-progress snapshot parked
 * at creation, and the thread earns its real label — and the tab its
 * title — from that first message). Closing the tab releases the thread's
 * live agent (its history stays persisted); the header menu reopens any
 * existing thread into a tab (deduped by threadId).
 *
 * Each side thread is a child session the plugin created itself with a
 * custom seed (the parent's full log up to the click moment — see
 * sidechat-core.ts). Transport: EVERY thread operation — creation,
 * follow-up, cancel, dispose, info, and the transcript itself — goes
 * through the plugin's own /sidebar/api sidechat.* routes (subagent-origin
 * identities are fenced from the generic session RPCs, and DSH
 * 0.1.2-alpha.1's Remote-gateway migration removed the client
 * session-history face the transcript used to poll). The transcript route
 * cuts the inherited seed host-side and answers afterSeq deltas; the
 * mapping (boundary row dropped, chunk streaming accumulated) lives in
 * sidechat-transcript.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  DiffBlock,
  IconApiOutline14,
  IconBrowseOutline16,
  IconChevronRightOutline14,
  IconEditOutline16,
  IconNewChatOutline16,
  IconPlusOutline16,
  IconSearchOutline16,
  IconSendOutline16,
  IconSparkle16,
  IconStopFill16,
  MarkdownText,
  Menu,
  ReadBlock,
  StateDot,
  TerminalBlock,
  type DiffBlockLabels,
  type MenuEntry,
  type ReadBlockLabels,
  type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps } from './markdown-labels.tsx'
import { IconHistoryOutline16, IconSaveOutline16 } from './icons.tsx'
import type { Context, SidebarHistoryEntry, SidebarSessionEvent } from '../context-types.ts'
import {
  SIDE_LABEL_PREFIX,
  SIDE_NEW_THREAD_TITLE,
  sideThreadRows,
  threadHasCompletedTurn,
  threadTrailingPending,
  type SidechatLiveStep,
  type SidechatThreadInfo,
} from '../sidechat-core.ts'
import {
  formatDurationMs,
  formatTokens,
  toolArgsSummary,
  transcriptRows,
  type SidechatToolCard,
  type SidechatTranscriptRow,
} from './sidechat-transcript.ts'
import { api } from './api.ts'
import { usePolling } from './use-polling.ts'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import css from './SideChatView.module.css'

/** Poll cadence while the selected thread is running and the tab visible. */
const POLL_MS = 2000
/** Textarea auto-grow ceiling (px) — the composer scrolls beyond it. */
const COMPOSER_MAX_HEIGHT = 132

/** The thread a tab is bound to (durable in tab.meta across refreshes). */
export function sidechatThreadIdOf(tab: SidebarTab): string | undefined {
  const meta = tab.meta as { threadId?: unknown } | undefined
  return typeof meta?.threadId === 'string' ? meta.threadId : undefined
}

/** The parked reopen target consumed by the descriptor's createTab (the
 *  service's createTab receives no seed, so a thread-switch parks the id
 *  here and openTab picks it up synchronously — exactly one consume per
 *  park). */
let parkedReopen: string | undefined

/** Park a thread id for the NEXT sidechat openTab to reattach. */
export function parkSidechatReopen(threadId: string): void {
  parkedReopen = threadId
}

/** Consume the parked reopen target (undefined = mint a fresh thread tab). */
export function consumeSidechatSeed(): string | undefined {
  const value = parkedReopen
  parkedReopen = undefined
  return value
}

/** In-flight thread creations keyed by tab id (double-mount guard: React
 *  StrictMode / HMR must not mint two threads for one tab). */
const inFlightStarts = new Set<string>()

/** Per-thread transcript cache: thread-own events merged by seq (polls ride
 * the afterSeq delta and never re-download what they already hold), plus the
 * last poll's in-flight assistant prefix (transient — replaced or dropped by
 * every poll, never merged into `entries`). */
interface ThreadCache {
  entries: SidebarHistoryEntry[]
  live?: SidechatLiveStep
}

/** Row-render labels (locale-dependent, memoized once per mount). */
interface RowLabels {
  copyLabel: string
  copiedLabel: string
  thinkLabel: string
  injectionLabel: string
  terminal: TerminalBlockLabels
  diff: DiffBlockLabels
  read: ReadBlockLabels
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

/** The display title of a thread: the durable label minus the 'Side: '
 *  prefix, with the fresh-thread placeholder localized. */
function threadDisplayTitle(title: string): string {
  if (title === SIDE_NEW_THREAD_TITLE) return t('sideChatUntitled')
  return title.startsWith(SIDE_LABEL_PREFIX) ? title.slice(SIDE_LABEL_PREFIX.length) : title
}

/**
 * One collapsible context row — the shared Codex-style chrome of tool
 * calls, thinking and context injections: a single quiet line (chevron +
 * label + one-line summary) that expands into an indented body hung on a
 * hairline thread. Rows with nothing to reveal render as a static line.
 */
function CollapsibleRow(props: {
  label: string
  meta?: string
  mono?: boolean
  streaming?: boolean
  failed?: boolean
  /** 16px leading glyph (tool-kind icon, the main conversation's row head). */
  icon?: React.ReactNode
  children?: React.ReactNode
}): React.ReactNode {
  const leading = props.icon === undefined ? null : (
    <span className={css.sidechatRowIcon}>{props.icon}</span>
  )
  const label = (
    <span
      className={clsx(
        css.sidechatRowLabel,
        props.mono === true && css.sidechatRowMono,
        props.streaming === true && css.sidechatShimmerText,
      )}
    >
      {props.label}
    </span>
  )
  const meta = props.meta !== undefined && props.meta !== ''
    ? <span className={css.sidechatRowMeta}>{props.meta}</span>
    : null
  if (props.children === undefined) {
    return (
      <div className={clsx(css.sidechatRowLine, css.sidechatRowStatic, props.failed === true && css.sidechatRowFailed)}>
        {leading}
        {label}
        {meta}
      </div>
    )
  }
  return (
    <details className={css.sidechatRow}>
      <summary
        className={clsx(
          css.sidechatRowLine,
          css.sidechatRowSummary,
          props.failed === true && css.sidechatRowFailed,
        )}
      >
        <span className={css.sidechatRowChevron}>
          <IconChevronRightOutline14 size={12} />
        </span>
        {leading}
        {label}
        {meta}
      </summary>
      <div className={css.sidechatRowBody}>{props.children}</div>
    </details>
  )
}

/** The host Block body for a structured tool card (main-conversation atoms:
 *  terminal surface, diff hunks, line-numbered read window). */
function toolCardBody(card: SidechatToolCard, executing: boolean, labels: RowLabels): React.ReactNode {
  if (card.type === 'terminal') {
    return (
      <TerminalBlock
        command={card.command}
        cwd={card.cwd}
        output={card.output}
        exitCode={card.exitCode}
        signal={card.signal}
        running={executing}
        labels={labels.terminal}
      />
    )
  }
  if (card.type === 'diff') {
    return <DiffBlock diffs={card.diffs} labels={labels.diff} />
  }
  return <ReadBlock label={card.label} lines={card.lines} totalLines={card.totalLines} lang={card.lang} labels={labels.read} />
}

/** The tool row's 16px leading slot, the way the main conversation draws it
 *  (GenericToolCard's variant table): the tool-kind glyph at 14, replaced by
 *  an error StateDot on failed rows. */
function toolLeading(name: string, failed: boolean): React.ReactNode {
  if (failed) return <StateDot state="error" />
  switch (name) {
    case 'bash':
    case 'pwsh':
      return <IconApiOutline14 size={14} />
    case 'read':
    case 'web_fetch':
      return <IconBrowseOutline16 size={14} />
    case 'edit':
    case 'write':
      return <IconEditOutline16 size={14} />
    case 'grep':
    case 'glob':
    case 'web_search':
      return <IconSearchOutline16 size={14} />
    default:
      return <IconSparkle16 size={14} />
  }
}

/** One row renderer (React keys ride the source event seq). */
function renderRow(row: SidechatTranscriptRow, labels: RowLabels): React.ReactNode {
  switch (row.kind) {
    case 'user':
      return (
        <div key={`${row.kind}:${row.seq}`} className={css.sidechatUser}>
          <MarkdownText {...markdownTextProps(row.text, labels)} />
        </div>
      )
    case 'assistant':
      return (
        <div key={`${row.kind}:${row.seq}`} className={css.sidechatAssistant}>
          <MarkdownText {...markdownTextProps(row.text, labels)} />
        </div>
      )
    case 'reasoning':
      return (
        <CollapsibleRow
          key={`${row.kind}:${row.seq}`}
          label={labels.thinkLabel}
          streaming={!row.settled}
        >
          <div className={css.sidechatRowProse}>{row.text}</div>
        </CollapsibleRow>
      )
    case 'injection':
      return (
        <CollapsibleRow key={`${row.kind}:${row.seq}`} label={labels.injectionLabel}>
          <div className={css.sidechatRowProse}>{row.text}</div>
        </CollapsibleRow>
      )
    case 'turnSummary': {
      // Quiet turn-tail metrics: token usage + wall duration, main-pane
      // StatsLine formatting. Parts appear only when computable.
      const parts: string[] = []
      if (row.inputTokens !== undefined && row.outputTokens !== undefined) {
        parts.push(t('sideChatTurnUsage', { input: formatTokens(row.inputTokens), output: formatTokens(row.outputTokens) }))
      }
      if (row.durationMs !== undefined) parts.push(formatDurationMs(row.durationMs))
      if (parts.length === 0) return null
      return (
        <div key={`${row.kind}:${row.seq}`} className={css.sidechatTurnSummary}>
          {parts.join(' · ')}
        </div>
      )
    }
    case 'tool': {
      const body = row.card !== undefined
        ? toolCardBody(row.card, row.executing === true, labels)
        : (
          <>
            {row.args !== undefined && <pre className={css.sidechatRowCode}>{row.args}</pre>}
            {row.resultText !== undefined && <pre className={css.sidechatRowCode}>{row.resultText}</pre>}
          </>
        )
      return (
        <CollapsibleRow
          key={`${row.kind}:${row.seq}`}
          label={row.name}
          meta={toolArgsSummary(row.args)}
          icon={toolLeading(row.name, row.failed)}
          mono
          streaming={row.executing === true}
          failed={row.failed}
          {...(row.args === undefined && row.resultText === undefined && row.card === undefined ? {} : { children: body })}
        />
      )
    }
  }
}

/** One side conversation tab (one thread per tab, Codex-style). */
export function SideChatView(props: {
  ctx: Context
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
}): React.ReactNode {
  const { ctx, scope, tab, visible } = props
  const rowLabels = useMemo<RowLabels>(() => {
    // Shared Block chrome: copy buttons reuse the sidebar's copy pair, the
    // collapse/expand family is common to every Block kind.
    const shared = {
      copy: t('copy'),
      copied: t('copied'),
      collapse: t('sideChatBlockCollapse'),
      collapseAria: t('sideChatBlockCollapseAria'),
      expand: (hidden: number) => t('sideChatBlockExpand', { hidden }),
      expandAria: (hidden: number) => t('sideChatBlockExpandAria', { hidden }),
    }
    return {
      copyLabel: t('copy'),
      copiedLabel: t('copied'),
      thinkLabel: t('sideChatThink'),
      injectionLabel: t('sideChatInjection'),
      terminal: {
        ...shared,
        signal: (signal: string) => t('sideChatBlockSignal', { signal }),
        exitCode: (exitCode: number) => t('sideChatBlockExitCode', { code: exitCode }),
        running: t('sideChatBlockRunning'),
        failed: t('sideChatBlockFailed'),
        done: t('sideChatBlockDone'),
        noOutput: t('sideChatBlockNoOutput'),
      },
      diff: { ...shared, files: (count: number) => t('sideChatBlockFiles', { count }) },
      read: { ...shared, window: (shown: number, total: number) => t('sideChatBlockWindow', { shown, total }) },
    }
  }, [])

  // The session list feed: thread rows (the header menu) + running states.
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const threads = useMemo(
    () => sideThreadRows(list.byId, scope.sessionId),
    [list, scope.sessionId],
  )

  // The thread this tab is bound to rides tab.meta (refresh-restored).
  const threadId = sidechatThreadIdOf(tab)
  const autoCreate = (tab.meta as { autoCreate?: unknown } | undefined)?.autoCreate === true

  const [composer, setComposer] = useState('')
  const [busy, setBusy] = useState<'starting' | 'sending' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  const [info, setInfo] = useState<SidechatThreadInfo | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const cacheRef = useRef<ThreadCache>({ entries: [] })
  // The previous poll's rows (see the mapping's reuse pass below).
  const prevRowsRef = useRef<SidechatTranscriptRow[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const summary = threadId === undefined ? undefined : list.byId[threadId]
  const running = summary?.running === true

  // Connection recovery state (DSH 0.1.2-alpha.2+): drives the disconnect
  // banner and an immediate catch-up pull when the wire comes back. The poll
  // loop itself stays silent on wire failures; absent service (older host)
  // reads as `undefined` = never show the banner.
  const connectionState = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.connection?.state.subscribe(callback) ?? (() => {}), [ctx]),
    useCallback(() => ctx.connection?.state.getSnapshot(), [ctx]),
  )

  /** The agent-identity badge of the thread header (preset · model). */
  const agentBadge = useMemo(() => {
    if (info === null) return ''
    return [info.preset, info.model ?? info.provider].filter(Boolean).join(' · ')
  }, [info])

  /** Create this tab's thread (immediate-create tabs and hero retries). */
  const startThread = useCallback(async (): Promise<void> => {
    if (inFlightStarts.has(tab.id)) return
    inFlightStarts.add(tab.id)
    setBusy('starting')
    setError(null)
    try {
      const { childId } = await api.sidechatStart(scope.sessionId)
      ctx.get('betterSidebar')?.updateTab(tab.id, { meta: { threadId: childId } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlightStarts.delete(tab.id)
      setBusy(null)
    }
  }, [ctx, scope.sessionId, tab.id])

  // Codex-style immediate create: an autoCreate tab spawns its thread as
  // soon as it first renders.
  useEffect(() => {
    if (threadId !== undefined || !autoCreate || !visible) return
    void startThread()
  }, [threadId, autoCreate, visible, startThread])

  // The tab title follows the thread's durable label (the first prompt
  // renames the thread; the strip picks it up here).
  useEffect(() => {
    const display = summary?.displayTitle
    if (display === undefined) return
    const title = threadDisplayTitle(display)
    if (title !== '' && title !== tab.title) {
      try {
        ctx.get('betterSidebar')?.updateTab(tab.id, { title })
      } catch {
        // A stale title is cosmetic; the thread keeps working.
      }
    }
  }, [summary, tab.id, tab.title, ctx])

  /** One transcript pull: the thread's own events beyond the cached tail
   *  (first attach = the whole seed-cut slice; polls = afterSeq deltas),
   *  merged by seq. */
  const fetchThread = useCallback(async (childId: string): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const cache = cacheRef.current
      const afterSeq = cache.entries.at(-1)?.event.seq
      const { events, live } = await api.sidechatEvents(childId, afterSeq, controller.signal)
      // The in-flight prefix grows without any new event, so its change is a
      // re-render trigger of its own.
      const liveChanged = live?.text !== cache.live?.text || live?.reasoning !== cache.live?.reasoning
      cache.live = live
      if (events.length > 0) {
        // Wire events arrive as parsed JSON; the mirror narrows data to the
        // record the mapping reads.
        const incoming = events.map(event => ({ event: event as SidebarSessionEvent }))
        cache.entries = mergeBySeq(cache.entries, incoming)
      }
      if (events.length > 0 || liveChanged) setRevision(value => value + 1)
    } catch {
      // Aborted by a newer pull or a wire failure: keep the last rows.
    }
  }, [])

  /** The thread header badge pull (live state + preset/model identity). */
  const fetchInfo = useCallback(async (childId: string): Promise<void> => {
    try {
      setInfo(await api.sidechatInfo(childId))
    } catch {
      // The badge is decorative; a wire failure keeps the last value.
    }
  }, [])

  // Reset the transcript cache whenever the binding changes, then focus
  // the composer — it owns the first message of a fresh thread.
  useEffect(() => {
    cacheRef.current = { entries: [] }
    prevRowsRef.current = []
    controllerRef.current?.abort()
    setError(null)
    setSaved(false)
    setInfo(null)
    if (threadId !== undefined) {
      void fetchInfo(threadId)
      window.setTimeout(() => composerRef.current?.focus(), 0)
    }
  }, [threadId, fetchInfo])

  // One transcript pull on every input change (attach, visibility flip,
  // run-state flip — the last one catches a thread's terminal state once it
  // stops running).
  useEffect(() => {
    if (!visible || threadId === undefined) return
    void fetchThread(threadId)
    // `running` is not read here, but re-triggering this pull on run-state
    // flips is load-bearing (see above); the badge fetch rides the ticks.
  }, [visible, threadId, running, fetchThread])

  // Poll while the tab is visible and the thread runs: transcript deltas +
  // badge refresh on a fixed cadence. Each pull self-guards (fetchThread
  // aborts its predecessor; a late settle keeps the last rows).
  const pollTick = useCallback(async (): Promise<void> => {
    if (threadId === undefined) return
    void fetchThread(threadId)
    void fetchInfo(threadId)
  }, [threadId, fetchThread, fetchInfo])
  usePolling(visible && running && threadId !== undefined, pollTick, { intervalMs: POLL_MS })

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  // When the wire recovers (disconnected → connected), pull immediately
  // instead of waiting for the next poll tick — or, on an idle thread that
  // stopped polling, forever.
  const prevConnectionRef = useRef(connectionState)
  useEffect(() => {
    const previous = prevConnectionRef.current
    prevConnectionRef.current = connectionState
    if (previous === 'disconnected' && connectionState === 'connected' && threadId !== undefined) {
      void fetchThread(threadId)
      void fetchInfo(threadId)
    }
  }, [connectionState, threadId, fetchThread, fetchInfo])

  // The previous poll's rows ride into the mapping so unchanged rows keep
  // their object identity (see reuseRows): the 2s poll re-renders only the
  // changed tail instead of re-parsing markdown for the whole transcript.
  const rows = useMemo(() => {
    const next = threadId === undefined
      ? []
      : transcriptRows(cacheRef.current.entries, prevRowsRef.current, cacheRef.current.live)
    prevRowsRef.current = next
    return next
  },
    // The cache is a ref; revision bumps on every successful pull.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, revision],
  )
  const canSave = threadId !== undefined && threadHasCompletedTurn(cacheRef.current.entries)
  const trailingPending = threadId !== undefined && threadTrailingPending(cacheRef.current.entries)
  const freshThread = threadId !== undefined && rows.length === 0

  // Follow the stream: stick to the bottom while the transcript grows. The
  // in-flight prefix grows a row's text without adding one, so this tracks
  // the mapped rows themselves (a fresh array per changed poll).
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    scroller.scrollTop = scroller.scrollHeight
  }, [rows, threadId])

  /** Open a NEW thread tab (createTab mints the autoCreate tab; its view
   *  creates the thread on mount). */
  const openNewThread = (): void => {
    setMenuOpen(false)
    ctx.get('betterSidebar')?.openTab({ type: 'sidechat' }, scope)
  }

  /** Switch to an existing thread: parked for createTab, deduped to the
   *  already-open tab when there is one. */
  const openExistingThread = (id: string): void => {
    setMenuOpen(false)
    if (id === threadId) return
    parkSidechatReopen(id)
    ctx.get('betterSidebar')?.openTab({ type: 'sidechat' }, scope)
  }

  const menuItems = useMemo<MenuEntry[]>(() => {
    const items: MenuEntry[] = [
      { id: '$new', label: t('sideChatNew'), icon: <IconPlusOutline16 /> },
    ]
    if (threads.length > 0) {
      items.push({ type: 'separator', id: '$sep' })
      for (const row of threads) {
        items.push({
          id: row.id,
          label: threadDisplayTitle(row.title),
          ...(row.running ? { icon: <StateDot state="ongoing" size={8} /> } : {}),
        })
      }
    }
    return items
  }, [threads])

  const growComposer = (): void => {
    const field = composerRef.current
    if (field === null) return
    field.style.height = '0px'
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  }

  const handleSend = async (): Promise<void> => {
    const text = composer.trim()
    if (text === '' || threadId === undefined || busy !== null) return
    setBusy('sending')
    setError(null)
    try {
      await api.sidechatPrompt(threadId, text)
      setComposer('')
      const field = composerRef.current
      if (field !== null) field.style.height = ''
      void fetchThread(threadId)
      void fetchInfo(threadId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (threadId === undefined || busy !== null) return
    try {
      await api.sidechatCancel(threadId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleSave = async (): Promise<void> => {
    if (threadId === undefined || !canSave || busy !== null) return
    setBusy('saving')
    setError(null)
    setSaved(false)
    try {
      // NOTE: fork must stay a METHOD call — `ctx.sessions.fork` is the
      // client-runtime sessions service, and an unbound reference loses
      // `this` (its fork reads this.list for the title bump).
      if (ctx.sessions.fork === undefined) throw new Error('session fork is unavailable')
      const newId = await ctx.sessions.fork({ sessionId: threadId, increaseTitle: true })
      const title = summary === undefined ? '' : threadDisplayTitle(summary.displayTitle).trim()
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

  // ── unbound tab: the hero (fresh autoCreate tabs flash a creating state
  //    until the thread lands; legacy persisted tabs offer a manual start) ──
  if (threadId === undefined) {
    return (
      <div className={css.sidechat}>
        <div className={css.sidechatHero}>
          <IconNewChatOutline16 />
          <div
            className={clsx(
              css.sidechatHeroTitle,
              busy === 'starting' && css.sidechatShimmerText,
            )}
          >
            {busy === 'starting' ? t('sideChatCreating') : t('sideChatEmpty')}
          </div>
          <div className={css.sidechatHeroDesc}>{t('sideChatEmptyDesc')}</div>
          {error !== null && <div className={css.sidechatError}>{t('sideChatError', { message: error })}</div>}
          {busy !== 'starting' && (
            <button
              type="button"
              className={css.sidechatPrimaryBtn}
              onClick={() => void startThread()}
            >
              {error === null ? t('sideChatNew') : t('sideChatRetry')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={css.sidechat}>
      <div className={css.sidechatDetailHeader}>
        {running && <StateDot state="ongoing" size={8} className={css.sidechatHeaderDot} />}
        {agentBadge !== '' && <span className={css.sidechatAgentBadge}>{agentBadge}</span>}
        <span className={css.sidechatHeaderSpacer} />
        <Menu
          open={menuOpen}
          anchor={(
            <button
              type="button"
              className={css.sidechatIconBtn}
              onClick={() => { setMenuOpen(value => !value) }}
              title={t('sideChatThreads')}
            >
              <IconHistoryOutline16 />
            </button>
          )}
          items={menuItems}
          selectedId={threadId}
          onSelect={(id) => { if (id === '$new') openNewThread(); else openExistingThread(id) }}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          portal
          dense
        />
        <button
          type="button"
          className={css.sidechatIconBtn}
          onClick={() => void handleSave()}
          disabled={!canSave || busy !== null}
          title={`${t('sideChatSave')} — ${t('sideChatSaveTitle')}`}
        >
          <IconSaveOutline16 />
        </button>
      </div>
      {connectionState !== undefined && connectionState !== 'connected' && (
        <ConnectionIndicator
          state={connectionState}
          disconnectedLabel={t('sideChatConnDisconnected')}
          reconnectLabel={t('sideChatConnReconnect')}
          connectingLabel={t('sideChatConnConnecting')}
          recoveredLabel={t('sideChatConnRecovered')}
          reconnectActionLabel={t('sideChatConnReconnectAction')}
          restartActionLabel={t('sideChatConnRestartAction')}
          onReconnect={() => { ctx.connection?.reconnect() }}
        />
      )}
      {!canSave && !freshThread && <div className={css.sidechatHint}>{t('sideChatNoTurn')}</div>}
      {canSave && trailingPending
        && <div className={css.sidechatHint}>{t('sideChatPendingDrop')}</div>}
      {saved && <div className={css.sidechatHint}>{t('sideChatSaved')}</div>}
      {error !== null && <div className={css.sidechatError}>{t('sideChatError', { message: error })}</div>}
      <div ref={scrollRef} className={css.sidechatScroll}>
        {rows.map(row => renderRow(row, rowLabels))}
      </div>
      {running && (
        <div className={css.sidechatStatus}>
          <StateDot state="ongoing" size={8} />
          <span className={css.sidechatStatusText}>{t('sideChatThinking')}</span>
        </div>
      )}
      <div className={css.sidechatComposer}>
        <textarea
          ref={composerRef}
          className={css.sidechatComposerInput}
          value={composer}
          placeholder={freshThread ? t('sideChatFirstPlaceholder') : t('sideChatComposerPlaceholder')}
          rows={1}
          onChange={event => {
            setComposer(event.target.value)
            growComposer()
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void handleSend()
          }}
        />
        <div className={css.sidechatComposerBar}>
          <span className={css.sidechatComposerMeta}>
            {running ? '' : agentBadge}
          </span>
          {running ? (
            <button
              key="stop"
              type="button"
              className={css.sidechatSendBtn}
              onClick={() => void handleCancel()}
              disabled={busy !== null}
              title={t('sideChatCancelTitle')}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              key="send"
              type="button"
              className={css.sidechatSendBtn}
              onClick={() => void handleSend()}
              disabled={composer.trim() === '' || busy !== null}
              title={t('sideChatSend')}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
