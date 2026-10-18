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
 * live agent (its history stays persisted); the composer bar's thread menu
 * reopens any existing thread into a tab (deduped by threadId).
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
 *
 * Freshness and visibility (2026-10-12): the transcript advances on the
 * host's own staleness push (use-sidechat-push.ts) with a slow fallback poll;
 * a just-sent message shows as a local echo until the host reports it in the
 * unclaimed inbox; that inbox renders as pending bubbles with a dequeue
 * button; and EVERY thread function (model route, thread menu, save-as-new-
 * session, archive) lives in the COMPOSER BAR, not a top header — the reader's
 * attention is on the input, and a header's actions went unnoticed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  DiffBlock,
  IconApiOutlineRegular,
  IconArchiveOutlineRegular,
  IconBrowseOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconEditOutlineRegular,
  IconNewChatOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSendOutlineRegular,
  IconSparkleRegular,
  IconStopFillRegular,
  MarkdownText,
  Menu,
  MarkdownDelegateProvider,
  ReadBlock,
  StateDot,
  TerminalBlock,
  Tooltip,
  type DiffBlockLabels,
  type MenuEntry,
  type ReadBlockLabels,
  type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps } from './markdown-labels.tsx'
import { useMarkdownSurface } from './use-markdown-surface.ts'
import { IconHistoryOutline16, IconSaveOutline16 } from './icons.tsx'
import type { Context, SidebarHistoryEntry, SidebarSessionEvent } from '../context-types.ts'
import {
  SIDE_LABEL_PREFIX,
  SIDE_NEW_THREAD_TITLE,
  sideThreadRows,
  threadHasCompletedTurn,
  threadTrailingPending,
  type SidechatLiveEvent,
  type SidechatModelCatalog,
  type SidechatModelInfo,
  type SidechatPendingInput,
  type SidechatThreadInfo,
  type SideThreadRow,
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
import { useSidechatPush } from './use-sidechat-push.ts'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import css from './SideChatView.module.css'

/**
 * Fallback poll cadence while the selected thread is running and the tab
 * visible. The push socket is the primary refresh path (see
 * use-sidechat-push.ts); this is the safety net for a socket that cannot be
 * established at all.
 */
const POLL_MS = 15_000
/** Coalescing window for push notices: one pull per burst of host frames.
 *  `fetchThread` already aborts its predecessor, so a shorter window would
 *  only turn one burst into a request storm. */
const PUSH_DEBOUNCE_MS = 80
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

/** Where the last side-chat thread of each main session is remembered (the
 *  client store's own key space, like the diff pane's redaction flag). */
const LAST_THREAD_KEY = 'dsh-sidebar:v1:sidechat-thread'

/**
 * How many sessions keep their remembered thread. The map lives for the life
 * of the page and is serialised WHOLE, so it needs both a bound (LRU: the
 * least recently bound session is forgotten) and — below — a write that is
 * coalesced instead of re-serialising the map on every bind.
 */
const LAST_THREAD_MAX = 32

/** The in-memory mirror of {@link LAST_THREAD_KEY}. */
const lastThreadBySession = new Map<string, string>()

/** Whether the localStorage mirror has been read into the map yet. */
let lastThreadsLoaded = false

/** Pending coalesced write of {@link LAST_THREAD_KEY} (undefined = none). */
let lastThreadsWrite: number | undefined

/**
 * Write the whole map once the binds stop coming. A thread switch binds two
 * or three ids in a row (mint, switch, reattach); serialising per bind was
 * pure churn for a value nothing reads back mid-page. Best-effort like the
 * rest of this storage: a denied or full write keeps the in-memory binding.
 */
function scheduleLastThreadsWrite(): void {
  if (lastThreadsWrite !== undefined) window.clearTimeout(lastThreadsWrite)
  lastThreadsWrite = window.setTimeout(() => {
    lastThreadsWrite = undefined
    try {
      localStorage.setItem(LAST_THREAD_KEY, JSON.stringify(Object.fromEntries(lastThreadBySession)))
    } catch {
      // A full or denied storage keeps the in-memory binding: reattaching
      // within this page still works, only a reload loses it.
    }
  }, 200)
}

/**
 * A native tab's record and its navigation params live in the host's memory
 * only, so collapsing the sidebar (or restarting DSH) remounts the tab with
 * NO thread bound — the autoCreate path — and the reader would land in a
 * brand-new empty thread instead of the one they were in. Remembering the
 * last thread per session is what makes the reattach below possible; the
 * storage is best-effort (a denied or unparseable entry just means the
 * reattach falls back to the newest thread).
 */
function loadLastThreads(): void {
  if (lastThreadsLoaded) return
  lastThreadsLoaded = true
  try {
    const raw = localStorage.getItem(LAST_THREAD_KEY)
    if (raw === null) return
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [sessionId, threadId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof threadId === 'string') lastThreadBySession.set(sessionId, threadId)
    }
  } catch {
    // No storage (or unreadable JSON): nothing was remembered.
  }
}

/** The thread a session's side-chat tab was last bound to, if any. */
function lastSidechatThread(sessionId: string): string | undefined {
  loadLastThreads()
  return lastThreadBySession.get(sessionId)
}

/** Remember the side-chat thread a session is bound to (also across reloads). */
function rememberSidechatThread(sessionId: string, threadId: string): void {
  loadLastThreads()
  if (lastThreadBySession.get(sessionId) === threadId) return
  // delete + set: a Map keeps an existing key's position otherwise, and the
  // cap below drops from the front.
  lastThreadBySession.delete(sessionId)
  lastThreadBySession.set(sessionId, threadId)
  while (lastThreadBySession.size > LAST_THREAD_MAX) {
    const oldest = lastThreadBySession.keys().next()
    if (oldest.done === true) break
    lastThreadBySession.delete(oldest.value)
  }
  scheduleLastThreadsWrite()
}

/** Per-thread transcript cache: thread-own events merged by seq (polls ride
 * the afterSeq delta and never re-download what they already hold). */
interface ThreadCache {
  entries: SidebarHistoryEntry[]
  /** The CURRENT attempt's live deltas (replaced every pull, never merged). */
  live: SidechatLiveEvent[]
  /** The thread's unclaimed inbox as of the last pull (replaced, never merged). */
  pending: SidechatPendingInput[]
}

/** The catalog row of one route: the model picker reads its reasoning efforts
 *  and its default effort. Undefined when the route is not in the catalog
 *  (an inherited route, or a catalog that failed to load). */
function catalogModel(
  catalog: SidechatModelCatalog | null,
  provider: string | undefined,
  model: string | undefined,
): SidechatModelInfo | undefined {
  if (catalog === null || provider === undefined || model === undefined) return undefined
  for (const group of catalog.groups ?? []) {
    if (group.id !== provider) continue
    for (const entry of group.models ?? []) if (entry.id === model) return entry
  }
  return undefined
}

/** Row-render labels (locale-dependent, memoized once per mount). */
interface RowLabels {
  copyLabel: string
  copiedLabel: string
  /** Code-card chrome (DSH 0.1.7-rc.1's fence toolbar): the markdown rows read
   *  these three straight off this object, the diff / read cards mix them in. */
  codeLabel: string
  wrapLabel: string
  unwrapLabel: string
  thinkLabel: string
  injectionLabel: string
  terminal: TerminalBlockLabels
  diff: DiffBlockLabels
  read: ReadBlockLabels
}

/** The host services this view reaches for archiving. Neither face lives on
 *  the plugin's own context type — `workspaces` is the session-list service and
 *  `uiWorkspace` the session surface — so they are read through the same
 *  structural probe the other views use for host services. */
interface ArchivedSessionsFace {
  list?: {
    getSnapshot?: () => { archivedSessionIds?: readonly string[] }
    subscribe?: (callback: () => void) => () => void
  }
}

interface ArchiveSessionFace {
  archiveSession?: (sessionId: string, options: { stopActivity: boolean }) => Promise<void>
}

/** A stable "nothing is archived" snapshot: the archive set feeds
 *  `useSyncExternalStore`, and a fresh `[]` per read would re-render forever. */
const NO_ARCHIVED_SESSIONS: readonly string[] = []

/** The sessions the host currently hides as archived. A host without the
 *  `workspaces` service (or a context that throws on `get`) reads as "nothing
 *  is archived", so the thread menu simply keeps every thread. */
function archivedSessionIdsOf(ctx: Context): readonly string[] {
  try {
    const service = ctx.get('workspaces') as unknown as ArchivedSessionsFace | undefined
    return service?.list?.getSnapshot?.()?.archivedSessionIds ?? NO_ARCHIVED_SESSIONS
  } catch {
    return NO_ARCHIVED_SESSIONS
  }
}

/** Subscribe to the host's archive set. DSH hides archived sessions from the
 *  session list, so the thread menu has to follow the same set — otherwise it
 *  would keep offering a thread the host refuses to open. */
function useArchivedSessionIds(ctx: Context): readonly string[] {
  const subscribe = useMemo(
    () => (callback: () => void) => {
      try {
        const service = ctx.get('workspaces') as unknown as ArchivedSessionsFace | undefined
        return service?.list?.subscribe?.(callback) ?? (() => {})
      } catch {
        return () => {}
      }
    },
    [ctx],
  )
  const getSnapshot = useCallback(() => archivedSessionIdsOf(ctx), [ctx])
  return useSyncExternalStore(subscribe, getSnapshot)
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

/** How long a composer-bar control waits before its hover bubble opens. */
const TIP_DELAY_MS = 120

/**
 * One composer-bar control with its hover bubble.
 *
 * The bubble anchors on an ENABLED wrapper span, not on the button itself: a
 * disabled control fires no pointer events, and save/archive are disabled
 * exactly when their label matters most ("至少完成一轮对话后才能保存" /
 * "该线程正在运行，停止后才能归档"). `portal` + `side="top"` keep the bubble
 * inside the viewport from a bar pinned to the panel's bottom edge.
 * @param props.label - bubble text.
 * @param props.children - the control (a button, or a Menu whose trigger is one).
 */
function ComposerTip(props: {
  label: string
  children: React.ReactNode
  /** Extra class on the anchor box (the model capsule needs to be shrinkable). */
  className?: string
}): React.ReactNode {
  return (
    <Tooltip label={props.label} side="top" portal delayMs={TIP_DELAY_MS} maxWidth={220}>
      <span className={clsx(css.sidechatTipAnchor, props.className)}>{props.children}</span>
    </Tooltip>
  )
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
          <IconChevronRightOutlineRegular size={12} />
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
      return <IconApiOutlineRegular size={14} />
    case 'read':
    case 'web_fetch':
      return <IconBrowseOutlineRegular size={14} />
    case 'edit':
    case 'write':
      return <IconEditOutlineRegular size={14} />
    case 'grep':
    case 'glob':
    case 'web_search':
      return <IconSearchOutlineRegular size={14} />
    default:
      return <IconSparkleRegular size={14} />
  }
}

/** One row renderer (React keys ride the source event seq). `rewrite` is the
 *  surface's markdown link pass — the rows are model prose, so a relative link
 *  resolves against the session cwd (see use-markdown-surface). */
function renderRow(row: SidechatTranscriptRow, labels: RowLabels, rewrite: (text: string) => string): React.ReactNode {
  switch (row.kind) {
    case 'user':
      return (
        <div key={`${row.kind}:${row.seq}`} className={css.sidechatUser}>
          <MarkdownText {...markdownTextProps(rewrite(row.text), labels)} />
        </div>
      )
    case 'assistant':
      return (
        <div key={`${row.kind}:${row.seq}`} className={css.sidechatAssistant}>
          <MarkdownText {...markdownTextProps(rewrite(row.text), labels)} />
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
    case 'error':
      // A provider/agent failure: rendered plainly (never markdown) so a raw
      // provider message with odd punctuation survives verbatim.
      return (
        <div key={`${row.kind}:${row.seq}`} className={css.sidechatErrorRow}>
          {t('sideChatRunError', { message: row.text })}
        </div>
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
    // DSH 0.1.7-rc.1 widened the diff / read cards into code cards and DELETED
    // `DiffBlockLabels.files`, so the old "N files" footer is gone and these
    // three strings are required by both cards.
    const codeCard = {
      codeLabel: t('codeBlockTitle'),
      wrapLabel: t('codeBlockWrap'),
      unwrapLabel: t('codeBlockUnwrap'),
    }
    return {
      copyLabel: t('copy'),
      copiedLabel: t('copied'),
      ...codeCard,
      thinkLabel: t('sideChatThink'),
      injectionLabel: t('sideChatInjection'),
      terminal: {
        ...shared,
        commandLine: (line: number) => t('sideChatBlockCommandLine', { line }),
        signal: (signal: string) => t('sideChatBlockSignal', { signal }),
        exitCode: (exitCode: number) => t('sideChatBlockExitCode', { code: exitCode }),
        // DSH 0.1.6-alpha.2 added this pill text: a settle the view cannot
        // name (killed by an unknown signal, or never started).
        noExitCode: t('sideChatBlockNoExitCode'),
        running: t('sideChatBlockRunning'),
        failed: t('sideChatBlockFailed'),
        done: t('sideChatBlockDone'),
        noOutput: t('sideChatBlockNoOutput'),
      },
      diff: { ...shared, ...codeCard },
      read: { ...shared, ...codeCard, window: (shown: number, total: number) => t('sideChatBlockWindow', { shown, total }) },
    }
  }, [])

  // The session list feed: thread rows (the composer-bar thread menu) + running states.
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  // Archived threads are dropped from the menu (and from the switch targets):
  // the host hides archived sessions itself, and binding a tab to one would
  // strand the panel on a session it refuses to open.
  const archivedIds = useArchivedSessionIds(ctx)
  const threads = useMemo(() => {
    const archived = new Set(archivedIds)
    return sideThreadRows(list.byId, scope.sessionId).filter(row => !archived.has(row.id))
  }, [list, scope.sessionId, archivedIds])

  /** The newest thread of `candidates`: the session list carries the thread
   *  rows but not their age, so the creation order comes from the host's
   *  subagent catalog. An untouched "new thread" placeholder only wins when
   *  nothing else is left. */
  const newestThreadId = useCallback((candidates: readonly SideThreadRow[]): string | undefined => {
    const catalog = list.projectionsBySession?.[scope.sessionId]?.values.subagentCatalog
    const createdAt = new Map((catalog ?? []).map(entry => [entry.id, entry.createdAt]))
    const rank = (id: string): number => createdAt.get(id) ?? 0
    const real = candidates.filter(row => row.title !== SIDE_NEW_THREAD_TITLE)
    const pool = real.length > 0 ? real : candidates
    if (pool.length === 0) return undefined
    return pool.reduce((newest, row) => (rank(row.id) > rank(newest.id) ? row : newest)).id
  }, [list, scope.sessionId])

  // The thread this tab is bound to rides tab.meta (refresh-restored).
  const threadId = sidechatThreadIdOf(tab)
  const autoCreate = (tab.meta as { autoCreate?: unknown } | undefined)?.autoCreate === true

  const [composer, setComposer] = useState('')
  const [busy, setBusy] = useState<'starting' | 'sending' | 'saving' | 'archiving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  const [info, setInfo] = useState<SidechatThreadInfo | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [catalog, setCatalog] = useState<SidechatModelCatalog | null>(null)
  /** Local echo of the message just sent: shown until the host reports it
   *  pending or logs it durably (see the drop effect below). `seq` is the
   *  transcript tail at send time, so an OLDER identical message cannot
   *  retire the echo. */
  const [echo, setEcho] = useState<{ text: string; seq: number } | null>(null)

  const cacheRef = useRef<ThreadCache>({ entries: [], live: [], pending: [] })
  // The previous poll's rows (see the mapping's reuse pass below).
  const prevRowsRef = useRef<SidechatTranscriptRow[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  /** The pending push-driven pull (one per burst of host frames). */
  const invalidateRef = useRef<number | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** Heading slugs, anchor jumps and `.md` link claiming for the transcript (a
   *  prose surface: it renders no file of its own, so a relative link target
   *  resolves against the session cwd). */
  const { surfaceRef: chatSurfaceRef, openFile: openChatFile, rewrite: rewriteChatText } = useMarkdownSurface({
    ctx,
    sessionId: scope.sessionId,
    cwd: scope.cwd,
  })
  const transcriptRef = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    chatSurfaceRef(element)
  }, [chatSurfaceRef])
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

  /** The agent-identity badge of the composer bar (preset · model). */
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
      // Name the seat session: the same native id names a tab in every session.
      ctx.get('betterSidebar')?.updateTab(tab.id, { meta: { threadId: childId } }, scope.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlightStarts.delete(tab.id)
      setBusy(null)
    }
  }, [ctx, scope.sessionId, tab.id])

  /**
   * The existing thread an unbound side chat should reattach to: the binding
   * this session was last in (kept only while the thread is still listed — a
   * deleted or archived thread must not be revived), then the newest thread
   * that already carries a real first prompt.
   */
  const reattachTarget = useCallback((): string | undefined => {
    const remembered = lastSidechatThread(scope.sessionId)
    if (remembered !== undefined && (threads.length === 0 || threads.some(row => row.id === remembered))) {
      return remembered
    }
    return newestThreadId(threads)
  }, [newestThreadId, scope.sessionId, threads])

  // Codex-style immediate create: an autoCreate tab spawns its thread as soon
  // as it first renders. A tab that LOST its binding (a panel collapse or a
  // restart — the host holds navigation params in memory only, see
  // loadLastThreads) reattaches to the thread the session was last in instead
  // of leaving yet another orphan "Side: New thread" session behind.
  useEffect(() => {
    if (threadId !== undefined || !autoCreate || !visible) return
    const reattach = reattachTarget()
    if (reattach !== undefined) {
      // Name the seat session: the same native id names a tab in every session.
      ctx.get('betterSidebar')?.updateTab(tab.id, { meta: { threadId: reattach } }, scope.sessionId)
      return
    }
    void startThread()
  }, [threadId, autoCreate, visible, startThread, reattachTarget, ctx, tab.id, scope.sessionId])

  // Remember the thread this tab holds, so reopening the panel (or a restart)
  // reattaches it instead of minting another one.
  useEffect(() => {
    if (threadId !== undefined) rememberSidechatThread(scope.sessionId, threadId)
  }, [threadId, scope.sessionId])

  // The tab title follows the thread's durable label (the first prompt
  // renames the thread; the strip picks it up here).
  useEffect(() => {
    const display = summary?.displayTitle
    if (display === undefined) return
    const title = threadDisplayTitle(display)
    if (title !== '' && title !== tab.title) {
      try {
        ctx.get('betterSidebar')?.updateTab(tab.id, { title }, scope.sessionId)
      } catch {
        // A stale title is cosmetic; the thread keeps working.
      }
    }
  }, [summary, tab.id, tab.title, ctx, scope.sessionId])

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
      const { events, live, pending } = await api.sidechatEvents(childId, afterSeq, controller.signal)
      // The live set is the CURRENT attempt, so it replaces whatever the
      // previous pull held; a settled step drops out of the host buffer and
      // its durable assistant/message takes over in the mapping. The pending
      // inbox is a snapshot too (replaced, never merged).
      cache.live = live ?? []
      cache.pending = pending ?? []
      if (events.length > 0) {
        // Wire events arrive as parsed JSON; the mirror narrows data to the
        // record the mapping reads.
        const incoming = events.map(event => ({ event: event as SidebarSessionEvent }))
        cache.entries = mergeBySeq(cache.entries, incoming)
      }
      setRevision(value => value + 1)
    } catch {
      // Aborted by a newer pull or a wire failure: keep the last rows.
    }
  }, [])

  /** The composer-bar badge pull (live state + preset/model identity). */
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
    cacheRef.current = { entries: [], live: [], pending: [] }
    prevRowsRef.current = []
    controllerRef.current?.abort()
    if (invalidateRef.current !== undefined) {
      window.clearTimeout(invalidateRef.current)
      invalidateRef.current = undefined
    }
    setError(null)
    setSaved(false)
    setInfo(null)
    setEcho(null)
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

  // Poll as the FALLBACK: the push socket (below) is the primary refresh
  // path, this keeps a thread without a usable socket moving. Each pull
  // self-guards (fetchThread aborts its predecessor; a late settle keeps the
  // last rows).
  const pollTick = useCallback(async (): Promise<void> => {
    if (threadId === undefined) return
    void fetchThread(threadId)
    void fetchInfo(threadId)
  }, [threadId, fetchThread, fetchInfo])
  usePolling(visible && running && threadId !== undefined, pollTick, { intervalMs: POLL_MS })

  // The host's staleness notices for the ONE thread this tab holds: coalesce
  // a burst into a single pull (fetchThread's own abort guard drops the
  // predecessor, so overlapping pulls are already safe).
  const handleInvalidate = useCallback((childId: string): void => {
    if (invalidateRef.current !== undefined) window.clearTimeout(invalidateRef.current)
    invalidateRef.current = window.setTimeout(() => {
      invalidateRef.current = undefined
      void fetchThread(childId)
      void fetchInfo(childId)
    }, PUSH_DEBOUNCE_MS)
  }, [fetchThread, fetchInfo])
  const watchedThreads = useMemo(
    () => (threadId === undefined ? [] : [threadId]),
    [threadId],
  )
  useSidechatPush({ threadIds: watchedThreads, visible, onInvalidate: handleInvalidate })

  // The model catalog is deployment-scoped, so one read per mount serves every
  // switch; a failed read leaves the picker on the inheritance fallback.
  useEffect(() => {
    let cancelled = false
    void api.sidechatModels()
      .then(result => { if (!cancelled) setCatalog(result) })
      .catch(() => { if (!cancelled) setCatalog(null) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => {
    controllerRef.current?.abort()
    if (invalidateRef.current !== undefined) window.clearTimeout(invalidateRef.current)
  }, [])

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
  // their object identity (see reuseRows): a pull re-renders only the
  // changed tail instead of re-parsing markdown for the whole transcript.
  // The live deltas are appended AFTER the durable events (they are the
  // in-flight tail), and a delta whose step already settled durably is
  // dropped: the durable message is authoritative and would otherwise render
  // twice.
  const rows = useMemo(() => {
    const cache = cacheRef.current
    const settled = new Set(
      cache.entries
        .filter(entry => entry.event.type === 'assistant/message')
        .map(entry => {
          const data = entry.event.data as { turn?: unknown; step?: unknown }
          return `${String(data.turn)}:${String(data.step)}`
        }),
    )
    const live = cache.live
      .filter(event => !settled.has(`${String(event.data.turn)}:${String(event.data.step)}`))
      .map(event => ({ event: event as SidebarSessionEvent }))
    const next = threadId === undefined ? [] : transcriptRows([...cache.entries, ...live], prevRowsRef.current)
    prevRowsRef.current = next
    return next
  },
    // The cache is a ref; revision bumps on every successful pull.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, revision],
  )

  /** The unclaimed inbox rows that still need a bubble: a pending message the
   *  host already logged durably (the claim raced the read) must not render
   *  twice, so it is matched by the durable message id. */
  const pendingRows = useMemo(() => {
    if (threadId === undefined) return []
    const durable = new Set<string>()
    for (const row of rows) {
      if (row.kind === 'user' && row.messageId !== undefined) durable.add(row.messageId)
    }
    return cacheRef.current.pending.filter(item => !durable.has(item.id))
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, revision, rows],
  )

  // Retire the local echo once the host accounts for the message it carries:
  // either the unclaimed inbox lists it (the claim has not happened yet) or a
  // durable user row NEWER than the send logged it (the claim already ran).
  // An identical older message cannot retire the echo — the seq gate.
  const echoText = echo?.text ?? ''
  useEffect(() => {
    if (echo === null || busy === 'sending') return
    if (pendingRows.some(item => item.text === echo.text)) {
      setEcho(null)
      return
    }
    if (rows.some(row => row.kind === 'user' && row.seq > echo.seq && row.text === echo.text)) {
      setEcho(null)
    }
  }, [echo, busy, pendingRows, rows])
  /** The echo is hidden the moment the inbox already carries the same text
   *  (the retire effect above then drops the state) so the message never shows
   *  twice for a frame. */
  const showEcho = echo !== null && !pendingRows.some(item => item.text === echo.text)

  const canSave = threadId !== undefined && threadHasCompletedTurn(cacheRef.current.entries)
  const trailingPending = threadId !== undefined && threadTrailingPending(cacheRef.current.entries)
  const freshThread = threadId !== undefined && rows.length === 0
  /** Whether the transcript shows model output yet: until it does, a
   *  just-sent thread gets the immediate thinking row even before the host
   *  reports it running. A RUNNING thread keeps the row regardless (the
   *  long-tool-call window has no streaming text to show progress). */
  const hasOutputRow = rows.some(row => row.kind === 'assistant' || row.kind === 'reasoning')
  const showThinking = threadId !== undefined && (running || (echo !== null && !hasOutputRow))

  // Follow the stream: stick to the bottom while the log — or the pending
  // tail — grows.
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    scroller.scrollTop = scroller.scrollHeight
  }, [rows.length, pendingRows.length, echoText, threadId])

  /** Open a NEW thread tab: the thread is created FIRST and parked for the
   *  descriptor's createTab, so the tab that opens is already bound to it —
   *  the pane never sits on the empty hero while a thread is being created,
   *  and the native page kind (which re-delivers its one tab instead of
   *  copying it) switches to the new thread through the same navigation the
   *  thread menu uses. */
  const openNewThread = async (): Promise<void> => {
    setMenuOpen(false)
    if (busy !== null) return
    setBusy('starting')
    setError(null)
    try {
      const { childId } = await api.sidechatStart(scope.sessionId)
      rememberSidechatThread(scope.sessionId, childId)
      parkSidechatReopen(childId)
      ctx.get('betterSidebar')?.openTab({ type: 'sidechat' }, scope)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
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
      { id: '$new', label: t('sideChatNew'), icon: <IconPlusOutlineRegular /> },
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

  /** The selected route's menu id (the picker's check mark). */
  const selectedModelId = info?.provider !== undefined && info.model !== undefined
    ? `model:${info.provider}:${info.model}`
    : undefined
  /** The reasoning effort the thread currently requests with, as a menu id. */
  const selectedEffortId = info?.reasoningEffort === undefined
    ? undefined
    : `effort:${info.reasoningEffort}`

  /** The model picker's rows: the host catalog grouped by provider, plus the
   *  reasoning efforts of the model in use. Without a readable catalog (or
   *  with an empty one) the only honest row is the inherited route — the host
   *  has no "inherit" write, so that row is informational.
   *
   *  The efforts are FLAT ROWS, deliberately not a `submenu`: the host's Menu
   *  opens a nested card to the RIGHT of its parent, and this picker sits at
   *  the sidebar's right edge, so a submenu lands off-screen (and, worse, the
   *  host's menu is non-scrolling as soon as any entry carries a submenu, so a
   *  long catalog could not scroll either). One right-aligned column is
   *  clip-proof by construction; the two groups stay distinguishable through
   *  their labels and the per-row check marks. */
  const modelItems = useMemo<MenuEntry[]>(() => {
    const groups = catalog?.available === true ? (catalog.groups ?? []) : []
    if (groups.length === 0) {
      return [{ id: '$inherit', label: t('sideChatModelInherit'), disabled: true }]
    }
    const items: MenuEntry[] = []
    for (const group of groups) {
      items.push({ type: 'label', id: `group:${group.id}`, text: group.name ?? group.id })
      for (const entry of group.models ?? []) {
        items.push({ id: `model:${group.id}:${entry.id}`, label: entry.name ?? entry.id })
      }
    }
    const efforts = catalogModel(catalog, info?.provider, info?.model)?.reasoning?.efforts ?? []
    if (efforts.length > 0) {
      items.push({ type: 'separator', id: '$reasoning-sep' })
      items.push({ type: 'label', id: '$reasoning', text: t('sideChatReasoning') })
      for (const effort of efforts) {
        items.push({ id: `effort:${effort.id}`, label: effort.name ?? effort.id })
      }
    }
    return items
  }, [catalog, info])

  /** Pin one model route (or one reasoning effort of the current route) on the
   *  bound thread, then re-read the composer-bar identity. */
  const handleModelSelect = async (id: string): Promise<void> => {
    setModelMenuOpen(false)
    if (threadId === undefined) return
    let provider: string
    let model: string
    let reasoningEffort: string | undefined
    if (id.startsWith('model:')) {
      // The model id may itself contain colons; only the provider separator
      // is structural.
      const rest = id.slice('model:'.length)
      const separator = rest.indexOf(':')
      if (separator <= 0) return
      provider = rest.slice(0, separator)
      model = rest.slice(separator + 1)
      reasoningEffort = catalogModel(catalog, provider, model)?.reasoning?.defaultEffort
    } else if (id.startsWith('effort:')) {
      if (info?.provider === undefined || info.model === undefined) return
      provider = info.provider
      model = info.model
      reasoningEffort = id.slice('effort:'.length)
    } else {
      return
    }
    setError(null)
    try {
      await api.sidechatModel(threadId, provider, model, reasoningEffort)
      await fetchInfo(threadId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

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
    // Local echo: the host accepts a message into the child's inbox and only
    // LOGS it when a step claims it, so between those moments the message used
    // to be invisible ("sent, nothing happened"). The bubble shows at once and
    // is retired once the inbox or the log carries the message.
    setEcho({ text, seq: cacheRef.current.entries.at(-1)?.event.seq ?? 0 })
    try {
      await api.sidechatPrompt(threadId, text)
      setComposer('')
      const field = composerRef.current
      if (field !== null) field.style.height = ''
      void fetchThread(threadId)
      void fetchInfo(threadId)
    } catch (cause) {
      // Nothing reached the host: drop the echo and say why.
      setEcho(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  /** Drop one unclaimed inbox message: the row leaves the queue immediately,
   *  then the pull reconciles (a refused dequeue brings it back). */
  const handleDequeue = async (id: string): Promise<void> => {
    if (threadId === undefined) return
    cacheRef.current.pending = cacheRef.current.pending.filter(item => item.id !== id)
    setRevision(value => value + 1)
    try {
      await api.sidechatDequeue(threadId, id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    void fetchThread(threadId)
  }

  const handleCancel = async (): Promise<void> => {
    if (threadId === undefined || busy !== null) return
    try {
      await api.sidechatCancel(threadId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** The thread that should replace `excludeId` once it is archived: the newest
   *  real thread first (the host's own subagent catalog carries the creation
   *  order), the newest placeholder only when nothing else is left, and
   *  `undefined` when the thread menu is empty — the tab then unbinds to the
   *  empty state instead of staying bound to an archived session. */
  const fallbackThreadId = useCallback(
    (excludeId: string): string | undefined => newestThreadId(threads.filter(row => row.id !== excludeId)),
    [newestThreadId, threads],
  )

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

  /** Archive the bound thread on the host (the same capability the session
   *  list's own archive action uses; `stopActivity` settles a running agent
   *  first). The tab then moves to another live thread: leaving it bound to an
   *  archived session would dead-end the panel, because the host refuses to
   *  open archived sessions. */
  const handleArchive = async (): Promise<void> => {
    if (threadId === undefined || busy !== null) return
    setBusy('archiving')
    setError(null)
    setSaved(false)
    try {
      const service = ctx.get('uiWorkspace') as unknown as ArchiveSessionFace | undefined
      if (service?.archiveSession === undefined) throw new Error('the workspace service is unavailable')
      await service.archiveSession(threadId, { stopActivity: true })
      const next = fallbackThreadId(threadId)
      ctx.get('betterSidebar')?.updateTab(tab.id, { meta: next === undefined ? {} : { threadId: next } })
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
          <IconNewChatOutlineRegular />
          <div
            className={clsx(
              css.sidechatHeroTitle,
              busy === 'starting' && css.sidechatShimmerText,
            )}
          >
            {busy === 'starting' || (autoCreate && error === null) ? t('sideChatCreating') : t('sideChatEmpty')}
          </div>
          <div className={css.sidechatHeroDesc}>{t('sideChatEmptyDesc')}</div>
          {error !== null && <div className={css.sidechatError}>{t('sideChatError', { message: error })}</div>}
          {busy !== 'starting' && (!autoCreate || error !== null) && (
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
      {connectionState !== undefined && connectionState !== 'connected' && (
        <ConnectionIndicator
          state={connectionState}
          disconnectedLabel={t('sideChatConnDisconnected')}
          connectingLabel={t('sideChatConnConnecting')}
          recoveredLabel={t('sideChatConnRecovered')}
          reconnectActionLabel={t('sideChatConnReconnectAction')}
          restartActionLabel={t('sideChatConnRestartAction')}
          onReconnect={() => { ctx.connection?.reconnect() }}
        />
      )}
      <div ref={transcriptRef} className={css.sidechatScroll}>
        {/* The host delegate is what makes a local markdown link in a row
            clickable at all (see use-markdown-surface), scoped to this
            transcript so nothing outside it is claimed. */}
        <MarkdownDelegateProvider openFile={openChatFile}>
          {rows.map(row => renderRow(row, rowLabels, rewriteChatText))}
          {/* The unclaimed inbox: accepted messages whose claim has not logged
              them yet. The same bubble surface (and markdown pass) as a
              durable user row, plus the state word and the dequeue button. */}
          {pendingRows.map(item => (
            <div key={`pending:${item.id}`} className={css.sidechatPending}>
              <div className={css.sidechatPendingText}>
                <MarkdownText {...markdownTextProps(rewriteChatText(item.text), rowLabels)} />
              </div>
              <div className={css.sidechatPendingMeta}>
                <StateDot state="ongoing" size={8} />
                <span>{t('sideChatQueued')}</span>
                <button
                  type="button"
                  className={css.sidechatDequeueBtn}
                  onClick={() => void handleDequeue(item.id)}
                  title={t('sideChatDequeue')}
                  aria-label={t('sideChatDequeue')}
                >
                  <IconCloseFillRegular size={12} />
                </button>
              </div>
            </div>
          ))}
          {/* The local echo: in flight until the host reports it pending. */}
          {showEcho && echo !== null && (
            <div className={css.sidechatPending}>
              <div className={css.sidechatPendingText}>
                <MarkdownText {...markdownTextProps(rewriteChatText(echo.text), rowLabels)} />
              </div>
              <div className={css.sidechatPendingMeta}>
                <StateDot state="ongoing" size={8} />
                <span>{busy === 'sending' ? t('sideChatSending') : t('sideChatQueued')}</span>
              </div>
            </div>
          )}
        </MarkdownDelegateProvider>
      </div>
      {showThinking && (
        <div className={css.sidechatStatus}>
          <StateDot state="ongoing" size={8} />
          <span className={css.sidechatStatusText}>{t('sideChatThinking')}</span>
        </div>
      )}
      {/* Thread feedback sits directly above the composer: the reader's eye is
          on the input, so the save hint, the queue warning and the failure
          banner all have to be readable from there (the functions they
          describe live in the composer bar below). */}
      {!canSave && !freshThread && <div className={css.sidechatHint}>{t('sideChatNoTurn')}</div>}
      {canSave && trailingPending
        && <div className={css.sidechatHint}>{t('sideChatPendingDrop')}</div>}
      {saved && <div className={css.sidechatHint}>{t('sideChatSaved')}</div>}
      {error !== null && <div className={css.sidechatError}>{t('sideChatError', { message: error })}</div>}
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
          {/* Mirrors the MAIN composer's bottom bar: the thread actions sit
              left (new thread · thread menu · save-as-new-session · archive),
              the model selector sits right, next to send. Every control opens
              a hover bubble (ComposerTip) so its meaning is readable without
              leaving the input. */}
          <div className={css.sidechatComposerTools}>
            <ComposerTip label={t('sideChatNew')}>
              <button
                type="button"
                className={css.sidechatIconBtn}
                onClick={() => void openNewThread()}
                disabled={busy !== null}
                aria-label={t('sideChatNew')}
              >
                <IconPlusOutlineRegular size={16} />
              </button>
            </ComposerTip>
            <ComposerTip label={t('sideChatThreads')}>
              <Menu
                open={menuOpen}
                anchor={(
                  <button
                    type="button"
                    className={css.sidechatIconBtn}
                    onClick={() => { setMenuOpen(value => !value) }}
                    aria-label={t('sideChatThreads')}
                  >
                    <IconHistoryOutline16 />
                  </button>
                )}
                items={menuItems}
                selectedId={threadId}
                onSelect={(id) => { if (id === '$new') void openNewThread(); else openExistingThread(id) }}
                onClose={() => { setMenuOpen(false) }}
                align="end"
                portal
                dense
              />
            </ComposerTip>
            <ComposerTip label={`${t('sideChatSave')} — ${t('sideChatSaveTitle')}`}>
              <button
                type="button"
                className={css.sidechatIconBtn}
                onClick={() => void handleSave()}
                disabled={!canSave || busy !== null}
                aria-label={t('sideChatSave')}
              >
                <IconSaveOutline16 />
              </button>
            </ComposerTip>
            <ComposerTip label={running ? t('sideChatArchiveRunning') : t('sideChatArchive')}>
              <button
                type="button"
                className={css.sidechatIconBtn}
                onClick={() => void handleArchive()}
                disabled={running || busy !== null}
                aria-label={t('sideChatArchive')}
              >
                <IconArchiveOutlineRegular size={16} />
              </button>
            </ComposerTip>
          </div>
          <span className={css.sidechatComposerSpacer} />
          <ComposerTip
            label={agentBadge === '' ? t('sideChatModel') : `${t('sideChatModel')} — ${agentBadge}`}
            className={css.sidechatTipShrink}
          >
            <Menu
              open={modelMenuOpen}
              anchor={(
                <button
                  type="button"
                  className={css.sidechatModelBtn}
                  onClick={() => { setModelMenuOpen(value => !value) }}
                  aria-label={t('sideChatModel')}
                >
                  <span className={css.sidechatModelName}>{info?.model ?? info?.provider ?? t('sideChatModel')}</span>
                </button>
              )}
              items={modelItems}
              selectedIds={[selectedModelId, selectedEffortId].filter((id): id is string => id !== undefined)}
              onSelect={(id) => { void handleModelSelect(id) }}
              onClose={() => { setModelMenuOpen(false) }}
              align="end"
              portal
              dense
            />
          </ComposerTip>
          {running ? (
            <ComposerTip label={t('sideChatCancelTitle')}>
              <button
                key="stop"
                type="button"
                className={css.sidechatSendBtn}
                onClick={() => void handleCancel()}
                disabled={busy !== null}
                aria-label={t('sideChatCancelTitle')}
              >
                <IconStopFillRegular />
              </button>
            </ComposerTip>
          ) : (
            <ComposerTip label={t('sideChatSend')}>
              <button
                key="send"
                type="button"
                className={css.sidechatSendBtn}
                onClick={() => void handleSend()}
                disabled={composer.trim() === '' || busy !== null}
                aria-label={t('sideChatSend')}
              >
                <IconSendOutlineRegular size={16} />
              </button>
            </ComposerTip>
          )}
        </div>
      </div>
    </div>
  )
}
