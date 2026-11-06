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
import { SidechatImages } from './SidechatImages.tsx'
import { useSidechatDraft, encodeSidechatImages } from './sidechat-draft.ts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  DiffBlock,
  FileTypeIcon,
  IconApiOutlineRegular,
  IconArchiveOutlineRegular,
  IconBrowseOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconEditOutlineRegular,
  IconNewChatOutlineRegular,
  IconPaperclipOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSendOutlineRegular,
  IconSparkleRegular,
  IconStopFillRegular,
  MarkdownText,
  Menu,
  MarkdownDelegateProvider,
  ReadBlock,
  SearchBlock,
  StateDot,
  TerminalBlock,
  Tooltip,
  WebBlock,
  classifyFileType,
  type DiffBlockLabels,
  type MarkdownFileMentions,
  type MenuEntry,
  type ReadBlockLabels,
  type SearchBlockLabels,
  type TerminalBlockLabels,
  type WebBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels, markdownTextProps } from './markdown-labels.tsx'
import { producedFilePaths, resolveProducedPath } from './sidechat-mentions.ts'
import {
  foldsSettledTurns,
  showsLiveProcessDetail,
  useSidechatWorkDetails,
} from './sidechat-work-details.ts'
import { COMPOSITION_END_GRACE_MS, compositionPhase, isGuardedKeydown, isSubmitGesture } from './composer-keymap.ts'
import { SIDECHAT_IMAGE_MEDIA_TYPES } from '../sidechat-images.ts'
import { SidechatAssistantRow, type SidechatRowSurfaceBinding } from './SidechatAssistantRow.tsx'
import { SidechatAttachments } from './SidechatAttachments.tsx'
import { rewriteProseLocalImageUrls } from './markdown-images.ts'
import { hostTransportBase } from './desktop-env.ts'
import { baseName, resolveSidebarPath } from './paths.ts'
import { openSidebarFile } from './sidebar-file.ts'
import { useMarkdownSurface } from './use-markdown-surface.ts'
import { IconHistoryOutline16, IconSaveOutline16 } from './icons.tsx'
import type { Context, SidebarHistoryEntry, SidebarSessionEvent } from '../context-types.ts'
import type { SidechatForkPoint } from '../sidechat-core.ts'
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
  sidechatRowKey,
  type SidechatAttachment,
  type SidechatToolCard,
  type SidechatTranscriptRow,
} from './sidechat-transcript.ts'
import { api, mediaUrl, SidebarApiError } from './api.ts'
import { usePolling } from './use-polling.ts'
import { useSidechatPush } from './use-sidechat-push.ts'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import { SIDECHAT_SUBMIT_KEY_DEFAULT, type SidechatSubmitKey } from '../prefs-shared.ts'
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
/** Transcript rows MOUNTED at once. The mapping still produces every row (see
 *  `transcriptRows`); only the DOM is bounded — a long thread used to mount
 *  every code card, table and image it ever contained. */
const TRANSCRIPT_WINDOW_MAX = 50
/** How many more rows one "reveal earlier" activation mounts. */
const TRANSCRIPT_REVEAL_STEP = 25
/** Declared height of ONE hidden row in the top spacer (px). jsdom performs no
 *  layout and a measured height would read 0 there, so the spacer carries its
 *  height inline; the contract only needs it to be linear in the hidden row
 *  count, because a revealed row takes back exactly the height it frees. */
const TRANSCRIPT_HIDDEN_ROW_PX = 28
/** The host's own near-bottom rule: within this distance of the bottom offset
 *  (scrollHeight - clientHeight - scrollTop) the reader is following the tail. */
const TRANSCRIPT_FOLLOW_THRESHOLD_PX = 24

/**
 * Run one callback on the next animation frame, or on the next macrotask when
 * the environment has no `requestAnimationFrame` (jsdom without a visual
 * timer). Returns the cancel handle.
 * @param callback - the deferred work.
 * @returns the disposer that cancels a still-pending frame.
 */
function nextFrame(callback: () => void): () => void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    const handle = window.requestAnimationFrame(() => { callback() })
    return () => { window.cancelAnimationFrame(handle) }
  }
  const handle = window.setTimeout(callback, 0)
  return () => { window.clearTimeout(handle) }
}

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
  /** Rows must never be rebound to a different child while a reset is pending. */
  threadId?: string
  entries: SidebarHistoryEntry[]
  /** The CURRENT attempt's live deltas (replaced every pull, never merged). */
  live: SidechatLiveEvent[]
  /** The thread's unclaimed inbox as of the last pull (replaced, never merged). */
  pending: SidechatPendingInput[]
  /** The FIRST pull of this thread was answered from a capped (tail-sliced)
   *  log: the transcript opens mid-history and has to say so. */
  truncated: boolean
  /** Where the FIRST pull said this thread forked off its parent conversation
   *  (the route's additive `fork`); absent for an unseeded thread. */
  fork?: SidechatForkPoint
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
  /** The host search card (grep / glob results). */
  search: SearchBlockLabels
  /** The host web card (web_search / web_fetch results), whose answer is
   *  rendered as markdown and therefore carries its own markdown chrome. */
  web: WebBlockLabels
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

/** Whether a row is a WORK-DETAIL row: the only rows a Turn fold wraps (a
 *  question, an answer, a delivery or an attachment is content, not work). */
function isWorkRow(
  row: SidechatTranscriptRow,
): row is Extract<SidechatTranscriptRow, { kind: 'reasoning' | 'tool' }> {
  return row.kind === 'reasoning' || row.kind === 'tool'
}

/** Longest live-detail snippet a running Turn's line carries. */
const RUNNING_LINE_MAX = 80

/**
 * What a RUNNING turn's control line says beyond its label (host
 * `liveProcessDetail`): the running tool with its one-line arguments, or the
 * first line of the reasoning being streamed.
 * @param row - the latest work row of the running turn.
 * @returns the detail, or undefined when the row has nothing to quote.
 */
function runningProcessLine(
  row: Extract<SidechatTranscriptRow, { kind: 'reasoning' | 'tool' }>,
): string | undefined {
  if (row.kind === 'tool') {
    const summary = toolArgsSummary(row.args)
    return summary === '' ? row.name : `${row.name} · ${summary}`
  }
  const first = row.text.split('\n', 1)[0]?.trim() ?? ''
  return first === '' ? undefined : first.slice(0, RUNNING_LINE_MAX)
}

/**
 * One Turn's work-detail disclosure (the host's `foldCompletedTurns`): the
 * line is the localized label (plus live detail while the turn runs), and its
 * WORK rows live in the body. Question and answer rows never enter it.
 */
function TurnFold(props: {
  /** The line's copy: the host's own turn-process vocabulary (took / done /
   *  running), localized by the planner that knows the measured duration. */
  label: string
  rows: React.ReactNode[]
  liveDetail: string | undefined
  open: boolean
}): React.ReactNode {
  return (
    <details className={css.sidechatTurnFold} data-sidechat-turn-fold="" open={props.open}>
      {/* The live detail rides the line's TITLE, not its text: the line stays
          the reader's fixed anchor while a turn runs, and a tool name in the
          summary text would collide with every "find the row for tool X"
          lookup that keys on summary text. */}
      <summary
        className={css.sidechatTurnFoldLine}
        {...(props.liveDetail === undefined ? {} : { title: props.liveDetail })}
      >
        <span className={css.sidechatRowChevron}>
          <IconChevronRightOutlineRegular size={12} />
        </span>
        <span className={css.sidechatRowLabel}>{props.label}</span>
      </summary>
      <div className={css.sidechatTurnFoldBody}>{props.rows}</div>
    </details>
  )
}

/**
 * The pre-fork context, rendered as the conversation it was.
 *
 * The reader's verdict on the card that shipped first was that this should not
 * be a card at all: two matching divider lines bracket the block — the first
 * says where it came from, the last where the inherited context stops — and the
 * parent's last exchange between them looks exactly like the messages under it:
 * the question as this thread's own user bubble, the answer as its own assistant
 * prose, both through the same markdown renderer (and the same prose pass) the
 * rows use, both carried verbatim. Nothing here expands or collapses.
 */
function ForkBlock(props: {
  /** The parent's last question, verbatim. */
  user: string | undefined
  /** The parent's last answer, verbatim; absent when there is none. */
  answer: string | undefined
  /** Markdown chrome, the same label bag the transcript rows thread through. */
  labels: RowLabels
  /** The view's row prose pass (image destinations, then local links). */
  rewrite: (text: string) => string
}): React.ReactNode {
  return (
    <div className={css.sidechatForkPoint} data-sidechat-fork-point="">
      <div className={css.sidechatForkDivider} data-sidechat-fork-divider="">
        {t('sideChatForkDivider')}
      </div>
      {props.user === undefined
        ? null
        : (
          // The same presentation block a user row renders, so the inherited
          // question can never drift from the thread's own bubbles.
          <div className={css.sidechatUser} data-sidechat-fork-question="">
            <MarkdownText {...markdownTextProps(props.rewrite(props.user), props.labels)} />
          </div>
        )}
      {props.answer === undefined || props.answer === ''
        ? null
        : (
          <div className={css.sidechatAssistant}>
            <MarkdownText {...markdownTextProps(props.rewrite(props.answer), props.labels)} />
          </div>
        )}
      {/* The same line closes the block: the inherited context stops here, so
          what follows reads as this thread's own conversation again. */}
      <div className={css.sidechatForkDivider} data-sidechat-fork-divider-end="">
        {t('sideChatForkDividerEnd')}
      </div>
    </div>
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
  if (card.type === 'search') {
    return <SearchBlock {...card.card} labels={labels.search} />
  }
  if (card.type === 'web') {
    return <WebBlock {...card.card} labels={labels.web} />
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

/** The per-view helpers every row renderer needs, collected in one stable
 *  object so a row body never rebuilds them per render. */
interface RowSurface {
  /** The row's prose pass: local image destinations become session media URLs
   *  first, then the surface's local-link pass runs (see the view's wiring).
   *  Takes the ROW (not its text) so the view can reuse an unchanged row's
   *  rewrite result by object identity. Only prose rows (user / assistant)
   *  carry `text`; the other kinds never run this pass. */
  rewrite: (row: Extract<SidechatTranscriptRow, { text: string }>) => string
  /** Open one delivered file through the plugin's own open path. */
  openFile: (path: string) => void
  /** The session-scoped media URL of one image deliverable. */
  media: (path: string) => string
  /** The absolute spelling of one delivered path (the row's title tooltip;
   *  call-argument paths arrive relative to the session cwd). */
  resolvePath: (path: string) => string
  /** Inline-code file-mention vocabulary: the paths THIS thread produced (see
   *  sidechat-mentions.ts). Undefined when the thread has produced nothing, so
   *  the renderer keeps every token inert code. */
  mentions: MarkdownFileMentions | undefined
  /** Render one row's `image` / `file` blocks (D13); the read is bound to the
   *  thread that owns the referencing log. */
  attachments: (list: readonly SidechatAttachment[]) => React.ReactNode
}

/** One row renderer (React keys ride the source event seq). `surface` is the
 *  markdown prose pass the rows run before rendering — the rows are model
 *  prose, so a relative destination resolves against the session cwd (see
 *  use-markdown-surface) — plus the delivered-file open and media helpers.
 *  `genui` binds the rows to the owning child thread: the key remounts every
 *  row when the tab switches threads, and a registered GenUI consumer may
 *  claim a visible, settled assistant row (see SidechatAssistantRow). */
function renderRow(row: SidechatTranscriptRow, labels: RowLabels, surface: RowSurface, genui: SidechatRowSurfaceBinding): React.ReactNode {
  const key = `${genui.threadId ?? 'unbound'}:${sidechatRowKey(row)}`
  switch (row.kind) {
    case 'user':
      return (
        <div key={key} className={css.sidechatUser}>
          {row.text !== '' && <MarkdownText {...markdownTextProps(surface.rewrite(row), labels, surface.mentions)} />}
          <SidechatImages visible={genui.visible} childId={genui.threadId} messageId={row.messageId} images={row.images} />
          {row.attachments === undefined || row.attachments.every(a => a.kind !== 'file')
            ? null
            : surface.attachments(row.attachments.filter(a => a.kind === 'file'))}
        </div>
      )
    case 'attachment':
      // One `image` / `file` content block of an assistant message, kept in
      // block order as its own row (D13). User-message images do NOT land here
      // — the user bubble draws them through the upstream `SidechatImages`
      // surface, and the bubble keeps only its `file` blocks on this path.
      return (
        <div key={key} className={css.sidechatAttachmentRow}>
          {surface.attachments([row.attachment])}
        </div>
      )
    case 'assistant':
      return (
        <SidechatAssistantRow
          key={key}
          row={row}
          labels={labels}
          rewrite={surface.rewrite}
          fileMentions={surface.mentions}
          surface={genui}
        />
      )
    case 'reasoning':
      // Reasoning is PROSE from a model that writes markdown (emphatic lists,
      // inline code, file references). It renders through the host renderer —
      // the same component (and the same delegate surface) as the assistant
      // row, so emphasis/lists/code become elements and a local link is
      // claimed by the host instead of showing its literal syntax. The
      // collapsed summary reports how much thinking there is; no duration is
      // available for a reasoning row, so none is invented.
      return (
        <CollapsibleRow
          key={key}
          label={labels.thinkLabel}
          meta={t('sideChatReasoningSummary', { chars: row.text.length })}
          streaming={!row.settled}
        >
          <MarkdownText {...markdownTextProps(surface.rewrite(row), labels, surface.mentions)} />
        </CollapsibleRow>
      )
    case 'injection':
      return (
        <CollapsibleRow key={key} label={labels.injectionLabel}>
          <div className={css.sidechatRowProse}>{row.text}</div>
        </CollapsibleRow>
      )
    case 'error':
      // A provider/agent failure: rendered plainly (never markdown) so a raw
      // provider message with odd punctuation survives verbatim.
      return (
        <div key={key} className={css.sidechatErrorRow}>
          {t('sideChatRunError', { message: row.text })}
        </div>
      )
    case 'terminal':
      // The turn ended without a normal completion: say which way (the reader
      // stopped it vs the output limit cut it), because the next thing the
      // reader does differs — resend, or continue in a fresh turn.
      return (
        <div key={key} className={css.sidechatTerminal}>
          {t(row.reason === 'max-tokens' ? 'sideChatTerminalMaxTokens' : 'sideChatTerminalAborted')}
        </div>
      )
    case 'compaction': {
      // The row LINE is a label plus the counts it has; the summary body (when
      // the thread still has it) lives behind the disclosure, because a
      // compacted summary is a page of prose, not a line.
      const meta = [
        row.shadowedItemCount === null ? '' : t('sideChatCompactionItems', { count: row.shadowedItemCount }),
        row.shadowedTokenCount === null ? '' : t('sideChatCompactionTokens', { tokens: row.shadowedTokenCount }),
      ].filter(part => part !== '').join(' · ')
      return (
        <CollapsibleRow
          key={key}
          label={t('sideChatCompactionSummary')}
          {...(meta === '' ? {} : { meta })}
        >
          {row.text === '' ? undefined : <div className={css.sidechatRowProse}>{row.text}</div>}
        </CollapsibleRow>
      )
    }
    case 'retry':
      // One quiet line per retry CHAIN: how many attempts, and why the model
      // call failed. The provider's own failure text is the reason, so it rides
      // the meta slot rather than a sentence the plugin invents.
      return (
        <CollapsibleRow
          key={key}
          label={t('sideChatRetryAttempt', { retry: row.retry })}
          {...(row.failureMessage === undefined ? {} : { meta: row.failureMessage })}
        />
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
        <div key={key} className={css.sidechatTurnSummary}>
          {parts.join(' · ')}
        </div>
      )
    }
    case 'deliverables': {
      return (
        <div key={`${row.kind}:${row.seq}`} className={css.sidechatDeliverables}>
          <div className={css.sidechatDeliverablesHead}>{t('sideChatDeliverables')}</div>
          <ul className={css.sidechatDeliverablesList}>
            {row.files.map((file, index) => {
              const name = baseName(file.path)
              // The visible description is part of the button's accessible
              // name too: an `Open {name}` label alone would hide it from
              // assistive tech while sighted readers see it.
              const openLabel = file.description === undefined
                ? t('sideChatDeliverableOpen', { name })
                : `${t('sideChatDeliverableOpen', { name })}: ${file.description}`
              return (
                <li key={`${String(index)}:${file.path}`} className={css.sidechatDeliverableItem}>
                  {/* One row per delivered file: the type glyph (and an image's
                      own thumbnail) plus the basename, the description, and a
                      click that opens the file through the plugin's editor
                      path — the same open the transcript's file links use. */}
                  <button
                    type="button"
                    className={css.sidechatDeliverable}
                    title={surface.resolvePath(file.path)}
                    aria-label={openLabel}
                    onClick={() => { surface.openFile(file.path) }}
                  >
                    {classifyFileType(file.path) === 'image'
                      ? <img className={css.sidechatDeliverableThumb} src={surface.media(file.path)} alt="" loading="lazy" />
                      : null}
                    <FileTypeIcon path={file.path} size={16} />
                    <span className={css.sidechatDeliverableName}>{name}</span>
                    {file.description !== undefined && (
                      <span className={css.sidechatDeliverableDesc}>{file.description}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )
    }
    case 'tool': {
      // A tool WITHOUT a structured card (grep/glob/web_search and every host
      // tool this view does not know): the collapsed line carries the one-line
      // argument summary, and the disclosed body splits into two LABELLED
      // sections — raw arguments, then raw output — so a reader who expands
      // always knows which block is which (two unlabelled <pre>s of JSON next
      // to raw output was a wall of escaped quotes).
      const resultAttachments = row.resultAttachments === undefined || row.resultAttachments.length === 0
        ? null
        : surface.attachments(row.resultAttachments)
      const body = (
        <>
          {row.card !== undefined
            ? toolCardBody(row.card, row.executing === true, labels)
            : (
              <>
                {row.args !== undefined && (
                  <>
                    <div className={css.sidechatToolSectionLabel}>{t('sideChatToolArguments')}</div>
                    <pre className={css.sidechatRowCode}>{row.args}</pre>
                  </>
                )}
                {row.resultText !== undefined && (
                  <>
                    <div className={css.sidechatToolSectionLabel}>{t('sideChatToolResult')}</div>
                    <pre className={css.sidechatRowCode}>{row.resultText}</pre>
                  </>
                )}
              </>
            )}
          {resultAttachments}
        </>
      )
      return (
        <CollapsibleRow
          key={key}
          label={row.name}
          meta={toolArgsSummary(row.args)}
          icon={toolLeading(row.name, row.failed)}
          mono
          streaming={row.executing === true}
          failed={row.failed}
          {...(row.args === undefined && row.resultText === undefined && row.card === undefined
            && resultAttachments === null ? {} : { children: body })}
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
  /** Which gesture submits the draft: a plain `Enter` (the default, host
   *  semantics) or exactly `Cmd+Enter` / `Ctrl+Enter`. The side card settings
   *  page feeds it from the side-chat feature's own preferences (see
   *  `sidechatSubmitKeyOf` in prefs.ts); absent reads the default, which keeps
   *  every existing composition unchanged. */
  submitKey?: SidechatSubmitKey
}): React.ReactNode {
  const { ctx, scope, tab, visible } = props
  const submitKey = props.submitKey ?? SIDECHAT_SUBMIT_KEY_DEFAULT
  /** The main conversation's work-details preference, read live (see
   *  sidechat-work-details.ts): the two transcripts of one conversation must
   *  agree about how much process detail to show. */
  const workDetails = useSidechatWorkDetails(ctx)
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
      // The host cards' summaries are FUNCTIONS (the shown/total pair folds
      // into one clause), so the two count pairs stay separate keys rather than
      // a template with six placeholders. `noResults` is shared: an empty grep
      // and an empty web search say the same thing to the reader.
      search: {
        ...shared,
        pathsSummary: (shown: number, total: number, truncated: boolean) => t(
          truncated ? 'sideChatSearchPathsTruncated' : 'sideChatSearchPaths',
          { shown, total },
        ),
        matchesSummary: (shown: number, total: number, files: number, truncated: boolean) => t(
          truncated ? 'sideChatSearchMatchesTruncated' : 'sideChatSearchMatches',
          { shown, total, files },
        ),
        noResults: t('sideChatSearchNoResults'),
      },
      web: {
        noResults: t('sideChatSearchNoResults'),
        sourcesTruncated: t('sideChatWebSourcesTruncated'),
        http: t('sideChatWebHttp'),
        contentTruncated: t('sideChatWebContentTruncated'),
        // The card renders the provider's answer as markdown of its own, so it
        // needs the same nested chrome (and the cached identity) as the rows.
        markdown: markdownLabels({ copyLabel: t('copy'), copiedLabel: t('copied'), ...codeCard }),
      },
    }
  }, [])
  /**
   * Remote-image previews: the host's `MarkdownImage` wraps an `<img>` in its
   * preview button and mounts `ImageLightbox` ONLY when the surrounding
   * `MarkdownDelegateProvider` supplies `fileImages` — the main conversation
   * always did, the side chat never did, so the same screenshot enlarged in the
   * main pane and did nothing here.
   *
   * `resolve` declines on purpose. It is the LOCAL-image vocabulary (a decoded
   * workspace path → displayable URL); the transcript already rewrites local
   * destinations into session media URLs before rendering (markdown-images.ts),
   * and the host only grows a hover preview card on an image LINK when
   * `resolve` answers with a URL — declining is what keeps a `[shot](a.png)`
   * link a plain file button.
   *
   * Identity matters: the provider memoizes its delegate on this object, and a
   * fresh one per render would push a new context value through every memoized
   * markdown row on every keystroke.
   *
   * `fileDrag` (DSH 0.2.2) is the handle the host's `useImageDrag` asks before
   * it starts a drag. The side chat owns no file transport of its own — a drag
   * out of this transcript is the browser's own image drag — so `start` answers
   * `true` WITHOUT writing a transfer payload (the contract's "browser dragging"
   * branch) and there is never a prepared resource to release. `reportFailure`
   * reuses the transcript's existing image-error surface, so a refused
   * preparation is visible instead of silent.
   */
  const fileImages = useMemo(() => ({
    fileDrag: {
      prepare: async () => ({ start: () => true, release: () => {} }),
      reportFailure: () => { setError(t('sideChatImageFailed')) },
    },
    resolve: (): string | undefined => undefined,
    labels: {
      open: t('sideChatImageOpen'),
      loading: t('sideChatImageLoading'),
      failed: t('sideChatImageFailed'),
      dialog: t('sideChatImageDialog'),
      close: t('sideChatImageClose'),
    },
  }), [])

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

  const draft = useSidechatDraft(threadId)
  const composer = draft.owner.text
  const setComposer = draft.setText
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState<'starting' | 'sending' | 'saving' | 'archiving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  const [info, setInfo] = useState<SidechatThreadInfo | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [catalog, setCatalog] = useState<SidechatModelCatalog | null>(null)
  /** Rows the reader explicitly revealed above the tail window (one
   *  {@link TRANSCRIPT_REVEAL_STEP} per activation). */
  const [revealedRows, setRevealedRows] = useState(0)
  /** Whether the reader is following the tail (the host's near-bottom rule,
   *  re-read from the scroller's own `scroll` events). It is an INTENT: the
   *  stream pins the scroller only while it holds, so a reader who scrolled up
   *  to re-read an answer is not yanked back by the next host push. */
  const [followingTail, setFollowingTail] = useState(true)
  /** Local echo of the message just sent: shown until the host reports it
   *  pending or logs it durably (see the drop effect below). The echo is
   *  retired by the host-assigned `messageId`, so an OLDER identical message
   *  cannot retire it. */
  const [echo, setEcho] = useState<{ text: string; messageId: string; hasImages: boolean } | null>(null)

  const cacheRef = useRef<ThreadCache>({ entries: [], live: [], pending: [], truncated: false })
  // The previous poll's rows (see the mapping's reuse pass below).
  const prevRowsRef = useRef<SidechatTranscriptRow[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  /** The pending push-driven pull (one per burst of host frames). */
  const invalidateRef = useRef<number | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** Heading slugs, anchor jumps and local file links for the transcript (a
   *  prose surface: it renders no file of its own, so a relative link target
   *  resolves against the session cwd). */
  const { surfaceRef: chatSurfaceRef, openFile: openChatFile, rewrite: rewriteChatLinks } = useMarkdownSurface({
    ctx,
    sessionId: scope.sessionId,
    cwd: scope.cwd,
    allLocalFiles: true,
  })
  /**
   * The prose pass every row runs before rendering: LOCAL image destinations
   * become absolute `/sidebar/file` media URLs FIRST (the host renderer only
   * draws absolute http(s) image sources, and a row is not a file, so relative
   * destinations resolve against the session cwd), and the surface's local-link
   * pass runs second — it must never see a raw image destination (see
   * markdown-navigation.ts). Both passes mask code regions, so a fenced
   * example stays literal.
   */
  const rewriteChatText = useCallback(
    (text: string): string => rewriteChatLinks(
      rewriteProseLocalImageUrls(text, scope, scope.cwd, hostTransportBase()),
    ),
    [rewriteChatLinks, scope],
  )
  /** The media URL base the rewrite bakes into image destinations. */
  const transportBase = hostTransportBase()
  /**
   * The row-level prose pass, memoized by ROW OBJECT: the transcript reuses an
   * unchanged row's object across updates (`sidechat-transcript.ts`), so a
   * composer keystroke or a streaming push must not re-run two regex passes
   * over every unchanged row's text. The cache is rebuilt when the inputs the
   * pass resolves against change (session, cwd, transport base); the row's own
   * text is compared too, so a row mutated in place never serves a stale
   * rewrite.
   */
  const rewriteCache = useMemo(() => {
    // The cache is keyed by rows, but its RESULTS were resolved against the
    // session cwd and the transport base, so it must not outlive either. The
    // reads below make the dependency real to the hook linter (the repo's
    // `void wantedKey` idiom).
    void scope.sessionId
    void scope.cwd
    void transportBase
    return new WeakMap<object, { text: string; out: string }>()
  }, [scope.sessionId, scope.cwd, transportBase])
  const rewriteRow = useCallback((row: Extract<SidechatTranscriptRow, { text: string }>): string => {
    const cached = rewriteCache.get(row)
    if (cached !== undefined && cached.text === row.text) return cached.out
    const out = rewriteChatText(row.text)
    rewriteCache.set(row, { text: row.text, out })
    return out
  }, [rewriteCache, rewriteChatText])
  /** Open one delivered file: the plugin's own editor path, session-scoped
   *  like every other open in this view (a relative path resolves against the
   *  session cwd). */
  const openDeliveredFile = useCallback((path: string): void => {
    try {
      openSidebarFile(ctx, scope.sessionId, path)
    } catch (error) {
      console.error('[dsh-better-sidebar] side chat deliverable open failed', error)
    }
  }, [ctx, scope.sessionId])
  /** The session-scoped media URL of one image deliverable (the card's
   *  thumbnail; the same route the markdown image pass produces). */
  const deliverableMediaUrl = useCallback((path: string): string => mediaUrl(scope, path), [scope])
  /** The absolute spelling of one delivered path for the card's title tooltip
   *  (the call-argument copy is cwd-relative; the event copy is already
   *  absolute and passes through unchanged). */
  const deliverableTitlePath = useCallback((path: string): string => resolveSidebarPath(scope.cwd, path), [scope.cwd])
  const transcriptRef = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    chatSurfaceRef(element)
  }, [chatSurfaceRef])
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  /** The IME guard's live composition flag (tracked from the textarea's own
   *  composition events: some engines only signal a composition there). */
  const composingRef = useRef(false)
  /** When the composition-end grace window closes (see
   *  {@link COMPOSITION_END_GRACE_MS}: Safari delivers the composition-closing
   *  keydown AFTER `compositionend`). */
  const composingUntilRef = useRef(0)

  const summary = threadId === undefined ? undefined : list.byId[threadId]
  const running = summary?.running === true
  /** The fork point the first pull reported — only when the parent prefix had
   *  something to summarise (a `cutSeq`-only field draws no banner). */
  const forkReport = cacheRef.current.fork
  const forkPoint = forkReport !== undefined
    && (forkReport.user !== undefined || forkReport.assistant !== undefined)
    ? forkReport
    : undefined
  /**
   * Whether the host's own session list can ever show the bound session again
   * after archiving it. It cannot for a subagent-origin row: the host's
   * `sessionVisible()` returns false for `origin === 'subagent'` BEFORE the
   * archived filter runs, and the only "unarchive" control lives on that list,
   * so archiving a side thread is a one-way door (issue #949). Every thread
   * this view binds is such a row; an absent summary is treated the same way —
   * this view must not archive a session it cannot classify. The composer tip
   * says why the action is disabled.
   */
  const archiveBlocked = summary === undefined || summary.origin === 'subagent'
  /** The archive control's hover text: the blocked reason wins over the
   *  running hint — stopping the thread would not make archiving recoverable. */
  const archiveTip = archiveBlocked
    ? t('sideChatArchiveBlocked')
    : running
      ? t('sideChatArchiveRunning')
      : t('sideChatArchive')

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
    if (threadId !== undefined || !visible) return
    const reattach = reattachTarget()
    if (reattach !== undefined) {
      // Name the seat session: the same native id names a tab in every session.
      ctx.get('betterSidebar')?.updateTab(tab.id, { meta: { threadId: reattach } }, scope.sessionId)
      return
    }
    if (autoCreate) void startThread()
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
    const cache = cacheRef.current
    if (cache.threadId !== childId) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const afterSeq = cache.entries.at(-1)?.event.seq
      const { events, live, pending, truncated, fork } = await api.sidechatEvents(childId, afterSeq, controller.signal)
      if (controller.signal.aborted || cacheRef.current !== cache) return
      // The live set is the CURRENT attempt, so it replaces whatever the
      // previous pull held; a settled step drops out of the host buffer and
      // its durable assistant/message takes over in the mapping. The pending
      // inbox is a snapshot too (replaced, never merged).
      cache.live = live ?? []
      cache.pending = pending ?? []
      // Only the FIRST pull of a binding answers from the whole log, so only it
      // can report a capped head; a poll must not clear a flag the first pull
      // established.
      if (afterSeq === undefined) {
        cache.truncated = truncated === true
        // The fork point is answered by the first pull only; a poll must not
        // clear what it established.
        cache.fork = fork
      }
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
      const cache = cacheRef.current
      const result = await api.sidechatInfo(childId)
      if (cache === cacheRef.current && cache.threadId === childId) setInfo(result)
    } catch {
      // The badge is decorative; a wire failure keeps the last value.
    }
  }, [])

  // Reset the transcript cache whenever the binding changes, then focus
  // the composer — it owns the first message of a fresh thread.
  useEffect(() => {
    cacheRef.current = { threadId, entries: [], live: [], pending: [], truncated: false }
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
    setBusy(null)
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
    const next = threadId === undefined || cache.threadId !== threadId
      ? [] : transcriptRows([...cache.entries, ...live], prevRowsRef.current)
    prevRowsRef.current = next
    return next
  },
    // The cache is a ref; revision bumps on every successful pull.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, revision],
  )

  /** The tail window: at most {@link TRANSCRIPT_WINDOW_MAX} rows are MOUNTED,
   *  plus whatever the reader revealed by hand. `rows` itself keeps every
   *  mapped row — the window bounds the DOM, never the model of the thread. */
  const mountedRowCount = Math.min(rows.length, TRANSCRIPT_WINDOW_MAX + revealedRows)
  /** How many mapped rows the window leaves out (0 = nothing hidden). */
  const hiddenRowCount = rows.length - mountedRowCount
  const visibleRows = useMemo(() => rows.slice(hiddenRowCount), [rows, hiddenRowCount])

  /**
   * Inline-code file mentions (D12): the vocabulary is the thread's OWN
   * produced paths — `tool/call` arguments plus `deliverables` rows — so a
   * token resolves without a single lookup request, and a token outside the set
   * (or an ambiguous basename) stays inert code.
   *
   * Both memos key on the vocabulary's CONTENT, never on the row array: the
   * array is a fresh value on every poll (the row objects inside it are reused)
   * and `MarkdownText` memoizes its parse on the resolver's identity, so a
   * resolver rebuilt per pull would re-parse every row's markdown every 2 s.
   */
  const producedPaths = useMemo(() => producedFilePaths(rows), [rows])
  /** Content key for {@link producedPaths} (a path carries no newline). */
  const producedMentionKey = producedPaths.join('\n')
  const fileMentions = useMemo<MarkdownFileMentions | undefined>(() => {
    if (producedPaths.length === 0) return undefined
    return {
      resolve: (token: string) => {
        const path = resolveProducedPath(producedPaths, token)
        if (path === undefined) return undefined
        // The RESOLVED spelling is what the tooltip and the accessible name
        // carry: the reader is told which FILE opens, not which token the
        // model happened to write.
        const title = deliverableTitlePath(path)
        return {
          open: () => { openDeliveredFile(path) },
          label: t('sideChatMentionOpen', { path: title }),
          title,
        }
      },
    }
  },
    // `producedMentionKey` IS `producedPaths`' content; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [producedMentionKey, deliverableTitlePath, openDeliveredFile])

  /** Render one row's `image` / `file` blocks. The byte read is addressed to
   *  the THREAD whose log references the attachment (a side thread is not a
   *  retained scope, so the chat image cache cannot serve it). */
  const renderAttachments = useCallback(
    (list: readonly SidechatAttachment[]): React.ReactNode => (
      threadId === undefined
        ? null
        : <SidechatAttachments ctx={ctx} sessionId={threadId} attachments={list} />
    ),
    [ctx, threadId],
  )
  const rowSurface = useMemo<RowSurface>(
    () => ({
      rewrite: rewriteRow,
      openFile: openDeliveredFile,
      media: deliverableMediaUrl,
      resolvePath: deliverableTitlePath,
      mentions: fileMentions,
      attachments: renderAttachments,
    }),
    [rewriteRow, openDeliveredFile, deliverableMediaUrl, deliverableTitlePath, fileMentions, renderAttachments],
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

  const echoText = echo?.text ?? ''
  useEffect(() => {
    if (echo === null || busy === 'sending') return
    if (pendingRows.some(item => item.id === echo.messageId)) {
      setEcho(null)
      return
    }
    if (rows.some(row => row.kind === 'user' && row.messageId === echo.messageId)) {
      setEcho(null)
    }
  }, [echo, busy, pendingRows, rows])
  const showEcho = echo !== null && !pendingRows.some(item => item.id === echo.messageId) && !rows.some(row => row.kind === 'user' && row.messageId === echo.messageId)

  const canSave = threadId !== undefined && threadHasCompletedTurn(cacheRef.current.entries)
  const trailingPending = threadId !== undefined && threadTrailingPending(cacheRef.current.entries)
  const freshThread = threadId !== undefined && rows.length === 0
  /** Whether the transcript shows model output yet: until it does, a
   *  just-sent thread gets the immediate thinking row even before the host
   *  reports it running. A RUNNING thread keeps the row regardless (the
   *  long-tool-call window has no streaming text to show progress). */
  const hasOutputRow = rows.some(row => row.kind === 'assistant' || row.kind === 'reasoning')
  const showThinking = threadId !== undefined && (running || ((echo !== null || busy === 'sending') && !hasOutputRow))

  // Follow the stream: while the reader is at (or near) the bottom, growth
  // pins the scroller to the BOTTOM OFFSET (scrollHeight - clientHeight) — the
  // raw scrollHeight is a browser-clamped over-scroll that hides the offset
  // arithmetic. A reader who scrolled away is never moved: the host pushes an
  // invalidation every ~250 ms while a turn streams, so an unconditional write
  // made re-reading the middle of an answer impossible.
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null || !followingTail) return
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
  }, [followingTail, rows.length, pendingRows.length, echoText, threadId])

  // A different thread starts at its own tail with nothing revealed — both the
  // window and the follow intent are per transcript, not per tab.
  useEffect(() => {
    setRevealedRows(0)
    setFollowingTail(true)
  }, [threadId])

  /** Re-read the follow intent from the scroller itself (the only source a real
   *  user scroll emits). */
  const handleTranscriptScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const scroller = event.currentTarget
    const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
    const next = distance <= TRANSCRIPT_FOLLOW_THRESHOLD_PX
    setFollowingTail(current => (current === next ? current : next))
  }

  /** Return to the tail: re-pin immediately (the click IS the reader's intent)
   *  and keep following from then on. */
  const returnToLatest = (): void => {
    const scroller = scrollRef.current
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
    setFollowingTail(true)
  }

  /** The content height captured when the reader asked for more history (see
   *  {@link revealEarlier}): the layout effect below corrects the scroll offset
   *  by the height the commit added ABOVE the viewport. */
  const revealAnchorRef = useRef<number | null>(null)

  /** Mount one more step of hidden history, keeping the reader's line in place. */
  const revealEarlier = (): void => {
    revealAnchorRef.current = scrollRef.current?.scrollHeight ?? null
    setRevealedRows(value => value + TRANSCRIPT_REVEAL_STEP)
  }

  // The rows a reveal mounts sit ABOVE the viewport, so the browser keeps
  // `scrollTop` while the content above grows and the line the reader was
  // reading slides down by the inserted height. Correcting the offset by the
  // height DELTA after the commit is what holds that line still; a reader who
  // is following the tail is instead pinned to the bottom offset of the NEW
  // geometry, so they stay at the newest content rather than trailing behind.
  useLayoutEffect(() => {
    const before = revealAnchorRef.current
    if (before === null) return
    revealAnchorRef.current = null
    const scroller = scrollRef.current
    if (scroller === null) return
    if (followingTail) {
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
      return
    }
    scroller.scrollTop += scroller.scrollHeight - before
  }, [revealedRows, followingTail])

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

  /** Fit the textarea to its draft (up to the ceiling). Reading `scrollHeight`
   *  forces a synchronous layout flush, so this only ever runs from a frame
   *  scheduled by {@link scheduleComposerGrow}, never inline in a keystroke. */
  const growComposer = useCallback((): void => {
    const field = composerRef.current
    if (field === null) return
    field.style.height = '0px'
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  }, [])
  /** The cancel handle of the pending auto-grow frame (coalesced: one frame
   *  per burst of keystrokes). */
  const growCancelRef = useRef<(() => void) | undefined>(undefined)
  /** Schedule one auto-grow on the next frame: the keystroke that changed the
   *  draft must not pay for the layout flush. A keystroke arriving before the
   *  frame is coalesced into that frame, which reads the LATEST draft. */
  const scheduleComposerGrow = useCallback((): void => {
    if (growCancelRef.current !== undefined) return
    growCancelRef.current = nextFrame(() => {
      growCancelRef.current = undefined
      growComposer()
    })
  }, [growComposer])
  useEffect(() => () => {
    growCancelRef.current?.()
    growCancelRef.current = undefined
  }, [])

  // Capture a binding generation, not a mutable "current session" fallback.
  // A deferred slider action from an old row must fail even after A → B → A.
  const surfaceBinding = useMemo(() => ({ childId: threadId, active: visible }), [threadId, visible])
  useLayoutEffect(() => {
    surfaceBinding.active = visible
    return () => { surfaceBinding.active = false }
  }, [surfaceBinding, visible])
  const sendSurfacePrompt = useCallback(async (text: string): Promise<void> => {
    try {
      const childId = surfaceBinding.childId
      if (!surfaceBinding.active || childId === undefined || childId.trim() === '' || text.trim() === '') {
        throw new Error('Sidechat surface is no longer active or the prompt is empty')
      }
      setError(null)
      await api.sidechatPrompt(childId, text)
      if (surfaceBinding.active) {
        void fetchThread(childId)
        void fetchInfo(childId)
      }
    } catch (cause) {
      if (surfaceBinding.active) setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }, [surfaceBinding, fetchThread, fetchInfo])
  /** The GenUI binding every transcript row shares (identity matters: the row
   *  memo below must not rebuild a row for an unchanged thread/visibility). */
  const genuiRowSurface = useMemo<SidechatRowSurfaceBinding>(
    () => ({ service: ctx.get('betterSidebar'), threadId, visible, sendPrompt: sendSurfacePrompt }),
    [ctx, threadId, visible, sendSurfacePrompt],
  )
  /**
   * The MOUNTED transcript. Memoized by its inputs (`rows` are reused by object
   * identity across pushes and the window only moves on a reveal), so an
   * unrelated state change — a composer keystroke above all — reuses the same
   * React elements: React bails out of an identical element, and no row
   * renderer (`toolArgsSummary`'s JSON parse, `formatTokens`, the markdown
   * pass) runs again for a row that did not change.
   *
   * Each mounted row sits in its own `display: contents` mount box: the box is
   * the stable test/DOM hook (`data-sidechat-transcript-row`) and keeps a row
   * that renders NOTHING (a turn tail with no metrics) countable, while taking
   * no part in the flex layout, so the rows keep their own alignment and the
   * scroller's gap.
   */
  const rowNodes = useMemo(() => {
    /** One row in its mount box (the scroller's `gap` still separates rows). */
    const mount = (row: SidechatTranscriptRow): React.ReactNode => (
      <div
        key={`${threadId ?? 'unbound'}:${sidechatRowKey(row)}`}
        className={css.sidechatRowMount}
        data-sidechat-transcript-row=""
      >
        {renderRow(row, rowLabels, rowSurface, genuiRowSurface)}
      </div>
    )
    if (!foldsSettledTurns(workDetails.mode)) return visibleRows.map(mount)
    /** The newest turn whose `turn/end` landed: the one `next-input` keeps open. */
    let newestCompletedTurn: number | undefined
    /** turn → the wall time its `turn/end` measured (the tail metrics row). */
    const turnDurations = new Map<number, number>()
    for (const row of rows) {
      if (isWorkRow(row) && row.turnEnded === true) newestCompletedTurn = row.turn
      if (row.kind === 'turnSummary' && row.turn !== undefined && row.durationMs !== undefined) {
        turnDurations.set(row.turn, row.durationMs)
      }
    }
    const nodes: React.ReactNode[] = []
    let index = 0
    while (index < visibleRows.length) {
      const row = visibleRows[index]
      if (row === undefined) {
        index += 1
        continue
      }
      if (!isWorkRow(row) || row.turn === undefined) {
        nodes.push(mount(row))
        index += 1
        continue
      }
      // One contiguous run of THIS turn's work rows: a turn whose work is split
      // by an answered question would draw one control per run, which keeps the
      // answer readable instead of hiding it inside the fold.
      const turn = row.turn
      const run: SidechatTranscriptRow[] = []
      while (index < visibleRows.length) {
        const candidate = visibleRows[index]
        if (candidate === undefined || !isWorkRow(candidate) || candidate.turn !== turn) break
        run.push(candidate)
        index += 1
      }
      const settled = run.some(entry => isWorkRow(entry) && entry.turnEnded === true)
      const open = !settled
        || (workDetails.collapseTiming === 'next-input' && turn === newestCompletedTurn)
      // The host labels this same control from its turn-process vocabulary: a
      // settled turn says how long it took (its own measured tail duration, the
      // one the usage line below already printed), a settled turn without a
      // measurement says done, and a running one says so.
      const duration = turnDurations.get(turn)
      const label = settled
        ? (duration === undefined
          ? t('sideChatTurnDone')
          : t('sideChatTurnTook', { duration: formatDurationMs(duration) }))
        : t('sideChatTurnRunning')
      const last = run.at(-1)
      const liveDetail = !settled && showsLiveProcessDetail(workDetails.mode) && last !== undefined && isWorkRow(last)
        ? runningProcessLine(last)
        : undefined
      const first = run[0]
      nodes.push(
        <TurnFold
          key={`fold:${threadId ?? 'unbound'}:${String(turn)}:${first === undefined ? '' : sidechatRowKey(first)}`}
          open={open}
          label={label}
          liveDetail={liveDetail}
          rows={run.map(mount)}
        />,
      )
    }
    return nodes
  }, [visibleRows, rows, threadId, rowLabels, rowSurface, genuiRowSurface, workDetails])

  const addImages = (files: readonly File[]): void => {
    try { draft.add(files, info?.images?.available === true ? info.images.limits : undefined); setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const handleSend = async (): Promise<void> => {
    const attempt = draft.capture()
    const childId = attempt.owner.childId
    if ((attempt.text === '' && attempt.images.length === 0) || childId === undefined || busy !== null) return
    setBusy('sending')
    setError(null)
    try {
      const images = await encodeSidechatImages(attempt)
      if (!attempt.owner.active) return
      const result = await api.sidechatPrompt(childId, attempt.text, images)
      if (!attempt.owner.active) return
      setEcho({ text: attempt.text, messageId: result.messageId, hasImages: images.length > 0 })
      draft.accept(attempt)
      void fetchThread(childId)
      void fetchInfo(childId)
    } catch (cause) {
      if (attempt.owner.active) setError(cause instanceof SidebarApiError && cause.code === 'network'
        ? t('sideChatSendUncertain')
        : cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (attempt.owner.active) setBusy(null)
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
   *  first). Disabled for a side thread: the host session list never lists a
   *  subagent-origin row, so no "unarchive" entry could ever recover it (issue
   *  #949) — the guard below makes that a hard rule, not just a disabled
   *  styling. For a recoverable binding the tab then moves to another live
   *  thread: leaving it bound to an archived session would dead-end the panel,
   *  because the host refuses to open archived sessions. */
  const handleArchive = async (): Promise<void> => {
    if (threadId === undefined || busy !== null || archiveBlocked) return
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
      {/* The transcript box: the scroller PLUS the floating controls that must
          not scroll with it. It is the positioning context for the
          back-to-latest pill, so the pill is anchored to the edge of the
          transcript (never to a magic offset), and the composer stays a sibling
          below — the pill can never cover the input. */}
      <div className={css.sidechatTranscript}>
        <div
          ref={transcriptRef}
          className={css.sidechatScroll}
          data-genui-surface="dsh-better-sidebar/sidechat"
          onScroll={handleTranscriptScroll}
        >
        {/* The route caps a very long log at its newest events, so this
            transcript may OPEN mid-history: say so above the first row instead
            of letting the first answer read like the thread's beginning. It is
            chrome, not conversation — no row hook, no row count. */}
        {cacheRef.current.truncated && (
          <div className={css.sidechatTruncatedNotice} data-sidechat-truncated-notice="">
            {t('sideChatTruncatedNotice')}
          </div>
        )}
        {/* Where this thread forked off the parent conversation: the cut the
            route performs is otherwise invisible, so the reader could not tell
            which main-pane question they were asking. Chrome, not
            conversation — no row hook, no row count. */}
        {forkPoint !== undefined && (
          <ForkBlock
            user={forkPoint.user?.text}
            answer={forkPoint.assistant?.text}
            labels={rowLabels}
            rewrite={rewriteChatText}
          />
        )}
        {/* The hidden head of the thread: the spacer holds the scroll space the
            unmounted rows used to occupy (their DECLARED height — jsdom has no
            layout, and a revealed row gives back exactly the height it frees),
            and the control mounts one more step of history at a time. Neither
            is rendered while the whole transcript is mounted, so a short thread
            has no chrome at all. */}
        {hiddenRowCount > 0 && (
          <>
            <div
              className={css.sidechatSpacer}
              data-sidechat-spacer=""
              aria-hidden="true"
              style={{ height: `${hiddenRowCount * TRANSCRIPT_HIDDEN_ROW_PX}px` }}
            />
            <button
              type="button"
              className={css.sidechatRevealEarlier}
              data-sidechat-reveal-earlier=""
              onClick={revealEarlier}
            >
              {t('sideChatRevealEarlier', { hidden: hiddenRowCount })}
            </button>
          </>
        )}
        {/* The host delegate is what makes a local markdown link in a row
            clickable at all (see use-markdown-surface), scoped to this
            transcript so nothing outside it is claimed. `fileImages` is the
            preview vocabulary that turns an image into the host's lightbox
            button; `resolve` declines (see the view's `fileImages` memo). */}
        <MarkdownDelegateProvider openFile={openChatFile} fileImages={fileImages}>
          {rowNodes}
          {/* The unclaimed inbox: accepted messages whose claim has not logged
              them yet. The same bubble surface (and markdown pass) as a
              durable user row, plus the state word and the dequeue button. */}
          {pendingRows.map(item => (
            <div key={`pending:${item.id}`} className={css.sidechatPending}>
              <div className={css.sidechatPendingText}>
                {item.text !== '' && <MarkdownText {...markdownTextProps(rewriteChatText(item.text), rowLabels)} />}
                <SidechatImages visible={visible} childId={threadId} messageId={item.id} images={item.images} />
              </div>
              <div className={css.sidechatPendingMeta}>
                <StateDot state="ongoing" size={8} />
                <span>{t('sideChatQueued')}</span>
                <button
                  type="button"
                  className={css.sidechatDequeueBtn}
                  onClick={() => void handleDequeue(item.id)}
                  disabled={item.removable === false}
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
                {echo.text !== '' && <MarkdownText {...markdownTextProps(rewriteChatText(echo.text), rowLabels)} />}
                {echo.hasImages && <span role="status">{t('sideChatImageLoading')}</span>}
              </div>
              <div className={css.sidechatPendingMeta}>
                <StateDot state="ongoing" size={8} />
                <span>{busy === 'sending' ? t('sideChatSending') : t('sideChatQueued')}</span>
              </div>
            </div>
          )}
        </MarkdownDelegateProvider>
        </div>
        {/* Only while the reader is AWAY from the tail: one tap returns to the
            newest content and resumes following. It is not rendered at the tail
            (nothing to return to). The slot is zero-height, so it never takes
            space from the transcript. */}
        {!followingTail && (
          <div className={css.sidechatToLatestSlot}>
            <button
              type="button"
              className={css.sidechatToLatest}
              data-sidechat-to-bottom=""
              onClick={returnToLatest}
            >
              {t('sideChatToLatest')}
            </button>
          </div>
        )}
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
        <input ref={fileInputRef} type="file" accept={SIDECHAT_IMAGE_MEDIA_TYPES.join(',')} multiple hidden
          aria-label={t('sideChatAddImages')} onChange={event => { addImages(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        {draft.owner.images.length > 0 && <div className={css.sidechatImages}>
          {draft.owner.images.map(image => <div className={css.sidechatImagePreview} key={image.id}>
            <img className={css.sidechatImage} src={image.preview} alt={image.file.name} />
            <button type="button" className={css.sidechatIconBtn} aria-label={t('sideChatRemoveImage', { name: image.file.name })}
              onClick={() => { draft.remove(image.id) }}><IconCloseFillRegular size={14} /></button>
          </div>)}
        </div>}
        {busy === 'sending' && <span role="status">{t('sideChatSending')}</span>}
        <textarea
          ref={composerRef}
          className={css.sidechatComposerInput}
          value={composer}
          placeholder={freshThread ? t('sideChatFirstPlaceholder') : t('sideChatComposerPlaceholder')}
          rows={1}
          onChange={event => {
            setComposer(event.target.value)
            scheduleComposerGrow()
          }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => {
            composingRef.current = false
            composingUntilRef.current = Date.now() + COMPOSITION_END_GRACE_MS
          }}
          onPaste={event => {
            const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => { const file = item.getAsFile(); return file === null ? [] : [file] })
            if (files.length === 0) return
            event.preventDefault()
            event.stopPropagation()
            addImages(files)
          }}
          onKeyDown={event => {
            // The submit contract (and the guards that outrank it) live in
            // composer-keymap.ts; the legacy signals and the modifier queries
            // only exist on the native event.
            const native = event.nativeEvent
            const gesture = {
              key: event.key,
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              altKey: native.altKey,
              altGraph: native.getModifierState('AltGraph'),
              repeat: native.repeat,
              isComposing: native.isComposing,
              keyCode: native.keyCode,
            }
            // A LIVE composition owns every key outright: no submit and no
            // consumption, not even when the event also carries Alt or is a
            // held-key repeat — those belong to the IME's candidate picker.
            // (The composition-CLOSING window is a different case: see below.)
            const phase = compositionPhase(gesture, composingRef.current, composingUntilRef.current)
            if (phase === 'active') return
            if (isSubmitGesture(
              gesture,
              submitKey,
              composingRef.current,
              composingUntilRef.current,
            )) {
              event.preventDefault()
              // A held key repeats the gesture it first pressed: the repeat is
              // consumed (no stacking newlines) but only the first press sends.
              if (gesture.repeat !== true) void handleSend()
              return
            }
            if (gesture.key !== 'Enter') return
            // A shortcut / layout chord (Alt, AltGraph, Ctrl+Meta, Shift with
            // Ctrl/Meta) is not a composer gesture: it must neither send nor
            // leave a newline behind. The host keymap
            // stops its fallback line break at CRITICAL priority for exactly
            // these keys; a plain textarea has only the one lever. A repeat is
            // NOT handled here — it is judged by the gesture it repeats, so a
            // repeated newline gesture (Shift+Enter, or the bare Enter of
            // 'mod-enter' mode) keeps its native line break.
            if (isGuardedKeydown(gesture)) {
              event.preventDefault()
              return
            }
            // Safari delivers the composition-closing Enter AFTER
            // `compositionend`, i.e. with no composition flag: the guard
            // already refused to submit, and the textarea would now insert a
            // line break on its own. The host's composer "neither submits nor
            // breaks the line" for that key, so consume it. A LIVE composition
            // key is left untouched (the IME owns it — that case returned
            // above), and Shift+Enter keeps its native newline in every state.
            if (phase === 'closing' && !gesture.shiftKey) {
              event.preventDefault()
            }
          }}
        />
        <div className={css.sidechatComposerBar}>
          {/* Mirrors the MAIN composer's bottom bar: the thread actions sit
              left (new thread · thread menu · save-as-new-session · archive),
              the model selector sits right, next to send. Every control opens
              a hover bubble (ComposerTip) so its meaning is readable without
              leaving the input. */}
          <div className={css.sidechatComposerTools}>
            <ComposerTip label={info?.images?.available === true ? t('sideChatAddImages') : t('sideChatImagesDisabled')}>
              <button type="button" className={css.sidechatIconBtn} aria-label={t('sideChatAddImages')}
                disabled={info?.images?.available !== true} onClick={() => { fileInputRef.current?.click() }}><IconPaperclipOutlineRegular size={16} /></button>
            </ComposerTip>
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
            <ComposerTip label={archiveTip}>
              <button
                type="button"
                className={css.sidechatIconBtn}
                onClick={() => void handleArchive()}
                disabled={archiveBlocked || running || busy !== null}
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
          {/* Stopping and sending are TWO actions, not one ternary: while a turn
              runs the reader can still queue a follow-up (the host accepts it
              into the thread's inbox — the keyboard path always could), so the
              send action stays mounted beside an independent stop control.
              Their availability is decided per control: the draft only gates
              sending, and `busy` alone gates both. The stop control exists only
              while the thread runs. */}
          {running && (
            <ComposerTip label={t('sideChatCancelTitle')}>
              <button
                type="button"
                className={css.sidechatSendBtn}
                onClick={() => void handleCancel()}
                disabled={busy !== null}
                aria-label={t('sideChatCancelTitle')}
              >
                <IconStopFillRegular />
              </button>
            </ComposerTip>
                    )}
            <ComposerTip label={t('sideChatSend')}>
              <button
                key="send"
                type="button"
                className={css.sidechatSendBtn}
                onClick={() => void handleSend()}
                disabled={(composer.trim() === '' && draft.owner.images.length === 0) || busy !== null}
                aria-label={t('sideChatSend')}
              >
                <IconSendOutlineRegular size={16} />
              </button>
            </ComposerTip>
        </div>
      </div>
    </div>
  )
}
