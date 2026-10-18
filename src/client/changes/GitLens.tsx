/**
 * Source Control inside the unchanged changes-tab shell: independent Changes
 * and Graph disclosures, a draft above the resource groups, and a sticky
 * checkout/sync footer. Status still comes from the one shared Git poller;
 * mutations, worktree inventory and history reuse the existing host routes.
 *
 * UI semantics reference: VS Code 76f9f309edc0682f4ef9465be8d12af754b87236,
 * extensions/git and src/vs/workbench/contrib/scm (not a runtime dependency).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronRightOutlineRegular,
  IconCloseFillRegular, IconCodeOutlineRegular, IconCopyOutlineRegular, IconEllipsisOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular, IconSparkleRegular, IconTrashOutlineRegular, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import type { GitLineCounts, GitLogEntry, GitStatusEntry, GitStatusResult, GitWorktree, SessionScope } from '../api.ts'
import { api, SidebarApiError } from '../api.ts'
import { builtinFileIcon, builtinFolderIcon } from '../file-icons.tsx'
import { usePolling } from '../use-polling.ts'
import { baseName, relativeTo } from '../paths.ts'
import { resolveSidebarPath } from '../paths.ts'
import { isZh, t } from '../locales.ts'
import { GitGraphSection, type GraphDetailsSelection } from './GitGraphSection.tsx'
import type { SidebarDiffRef, SidebarStore } from '../state.ts'
import {
  ConfirmDialog, IconButton, Notice, StatusBadge, invalidateGitStatus, statusOfXY,
  useGitStatus, type GitFileStatus, type GitTone, type StatusTone,
} from '../ui/index.ts'
import { buildChangeTree, sumLineCounts, type ChangeDir, type ChangeFile, type ChangeNode } from './change-tree.ts'
import diffCss from '../diff/diff.module.css'
import css from './changes.module.css'

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  return statusOfXY(entry.xy)?.staged === true
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  return statusOfXY(entry.xy)?.unstaged === true
}

/** Whether a row is untracked (`??`): git diff never includes it, so the
 *  preview and the discard action must know. */
function isUntrackedStatus(status: GitFileStatus): boolean {
  return status.tone === 'untracked'
}

/** The porcelain tone → the kit badge tone (a copy reads as a rename). */
const BADGE_TONE: Record<GitTone, StatusTone> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'untracked',
  renamed: 'renamed',
  copied: 'renamed',
  conflict: 'conflict',
}

/** One thrown value as display text (every error line here normalizes through
 *  this so non-Error rejections never render as '[object Object]'). */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Whether two inventory listings say the same thing. Every listing pass answers
 * with a fresh array of fresh rows, so identity alone would republish on each
 * poll; a field-by-field compare is what lets an unchanged silent tick stay
 * silent (see `runOnce`).
 */
function sameWorktrees(left: readonly GitWorktree[], right: readonly GitWorktree[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]!
    return entry.path === other.path && entry.branch === other.branch
      && entry.current === other.current && entry.changes === other.changes
  })
}

/**
 * How many scopes' commit drafts are remembered. The lens is a kept-mounted tab
 * body, so this record lives for the page: without a bound, a session that
 * walked through many projects would pin one message per project forever.
 */
export const COMMIT_DRAFT_CAP = 32

/**
 * Write one scope's draft into the record, remembering at most
 * {@link COMMIT_DRAFT_CAP} scopes. Re-writing a key moves it to the back, so
 * the draft evicted past the cap is the scope typed into longest ago — a typed
 * message for another project is never what a commit here submits (the record
 * is keyed by scope, and `commit()` reads only its own key).
 *
 * @param prev - the current record (never mutated).
 * @param key - the scope key (session + cwd).
 * @param text - the draft (`''` = cleared; the key stays, so it reads back as
 *  an empty box rather than as a missing one).
 * @returns the next record.
 */
export function withCommitDraft(
  prev: Record<string, string>,
  key: string,
  text: string,
): Record<string, string> {
  const next: Record<string, string> = { ...prev }
  delete next[key]
  next[key] = text
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, Math.max(0, keys.length - COMMIT_DRAFT_CAP))) delete next[stale]
  return next
}

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm dialog. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** One open file-row context menu (cursor position for the portaled Menu). */
interface FileMenuState {
  path: string
  staged: boolean
  untracked: boolean
  x: number
  y: number
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */

/** Cadence of the background worktree re-list: the shared status store already
 *  polls the selected checkout's status, so the inventory (a different call)
 *  only needs to notice a linked checkout the agent created mid-session —
 *  within ~30s, without a second git process per status tick. */
const WORKTREE_POLL_MS = 30_000

/** Desktop's official Input typography, with a six-line SCM cap. */
const COMMIT_BOX_LINE_HEIGHT = 22
const COMMIT_BOX_MAX_ROWS = 6

/** A stable empty entry list: the tree memo must not rebuild on every render
 *  just because `snapshot?.entries ?? []` minted a new array. */
const NO_ENTRIES: readonly GitStatusEntry[] = []

// The horizontal half of the host's Plus artwork (no public Minus icon): the
// unstage affordance. The stage side reuses the host's own Plus, so the two
// directions never read as the same action (VS Code's `$(remove)` / `$(add)`).
const MINUS_ICON = <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="M2 8H14" stroke="currentColor" strokeWidth={1} />
</svg>

/** The tree's indent guides: one hairline per level ABOVE the row (the group's
 *  own column carries no line), drawn in the same 12px column the old nested
 *  tree used to draw at — 17px for the first level, +12 per level — so a deep
 *  path reads as deep as it did before the SCM rewrite. The lines are absolutely
 *  placed (no part in the flex row's metrics) and span the whole 28px band, so
 *  they stay continuous across every sibling and every hover/selected fill. */
function IndentGuides(props: { depth: number }): ReactNode {
  return <>{Array.from({ length: props.depth }, (_, index) => (
    <span key={index} className={css.guide} data-guide="" aria-hidden="true"
      style={{ left: (index + 1) * 12 + 5 }} />
  ))}</>
}

/**
 * A CONTENT key for one status answer. The shared store mints a brand-new
 * entries array for every poll — idle polls with byte-identical content
 * included — so array identity cannot decide whether the tree must be rebuilt.
 * This string can: the same paths, porcelain codes and line counts always
 * produce the same key, and a key change is exactly when the tree, its totals
 * and the row objects need to be recomputed. The counts belong in the key
 * because an edit that only moves lines leaves `xy` alone (#131): without them
 * the memoized rows would keep printing their first reading.
 */
function entriesKey(entries: readonly GitStatusEntry[]): string {
  let key = ''
  for (const entry of entries) {
    const lines = `${sideKey(entry.staged)}/${sideKey(entry.unstaged)}`
    key += `${entry.xy}\u0000${entry.path}\u0000${lines}\n`
  }
  return key
}

/** One side's counts as a key fragment ('' when that side has none). */
function sideKey(counts: GitLineCounts | undefined): string {
  if (counts === undefined) return ''
  return 'additions' in counts ? `${counts.additions}/${counts.deletions}` : 'binary'
}

/** The `+N` / `−M` pair, ink and sign included: shared by a file row and its
 *  group header so the two can never drift apart. A zero side is omitted (the
 *  diff pane's own convention), and both numbers stay on the element as
 *  `data-` attributes for the row's tests. */
function PlusMinus(props: { additions: number; deletions: number; note?: string }): ReactNode {
  return (
    <span className={css.lineCounts} data-lines={props.note ?? 'count'}
      data-added={props.additions} data-deleted={props.deletions}>
      {props.additions > 0 && <span className={diffCss.statAdd}>+{props.additions}</span>}
      {props.deletions > 0 && <span className={diffCss.statDel}>−{props.deletions}</span>}
    </span>
  )
}

/** One row's line counts (#131): the numbers for a text change and the binary
 *  mark when git has none for a blob. git never diffs an untracked entry (its
 *  `U` badge already says so), and an entry whose numstat read failed must not
 *  show an invented `+0 −0` — both render nothing. */
function LineCounts(props: { counts?: GitLineCounts }): ReactNode {
  const { counts } = props
  if (counts === undefined) return null
  if (!('additions' in counts)) return <span className={css.lineNote} data-lines="binary">{t('diffBinary')}</span>
  return <PlusMinus additions={counts.additions} deletions={counts.deletions} />
}

/** The preview ref for one changed file (one ref per path+side). */
function worktreeRefOf(
  path: string,
  untracked: boolean,
  staged: boolean,
  worktree: string | undefined,
  repoRoot: string | undefined,
): SidebarDiffRef {
  return { kind: 'worktree', path, staged, untracked, worktree, repoRoot }
}

/** One changed file's row: the host's file artwork + porcelain letter + name
 *  + the trailing stage action (revealed on hover/focus).
 *
 *  Memoized, and every prop keeps its identity across a status poll that
 *  changed nothing: the tree is content-keyed (so `node` is the same object),
 *  the callbacks are state-free, and `glyph` is a stable resolver. The icon
 *  resolution inside the row therefore doubles as the re-render probe the
 *  specs use — an idle poll must not resolve a single icon. */
const FileRow = memo(function FileRow(props: {
  row: ChangeFile
  depth: number
  glyph: (path: string) => ReactNode
  staged: boolean
  busy: boolean
  selected: boolean
  onPreview: (node: ChangeFile, staged: boolean) => void
  onContextMenu: (event: MouseEvent, node: ChangeFile, staged: boolean) => void
  onToggleStage: (path: string, staged: boolean) => void
}): ReactNode {
  const { row: node, staged, busy, selected } = props
  const action = staged ? t('unstage') : t('stage')
  return (
    <div className={css.row} style={{ paddingLeft: props.depth * 12 + 8 }} data-row={node.path} data-selected={selected ? 'true' : undefined}>
      <IndentGuides depth={props.depth} />
      <button
        type="button"
        className={css.rowMain}
        data-path={node.path}
        title={node.path}
        onClick={() => { props.onPreview(node, staged) }}
        onContextMenu={(event) => { props.onContextMenu(event, node, staged) }}
      >
        <span className={css.rowIcon} aria-hidden="true">{props.glyph(node.path)}</span>
        <span className={css.rowName}>{node.name}</span>
        <span className={css.rowPath}>{node.path.slice(0, -node.name.length).replace(/[\\/]+$/, '') || '/'}</span>
        <StatusBadge tone={BADGE_TONE[node.status.tone]} title={node.path}>{node.status.letter}</StatusBadge>
        {/* The row's own line counts (#131): read straight off the node, so a
            poll that answered different numbers re-renders this row with them. */}
        <LineCounts counts={node.counts} />
      </button>
      <IconButton
        size="sm"
        className={css.rowAction}
        disabled={busy}
        label={action}
        icon={staged ? MINUS_ICON : <IconPlusOutlineRegular size={12} />}
        onClick={() => { props.onToggleStage(node.path, staged) }}
      />
    </div>
  )
})

/** One directory row: the disclosure chevron + folder artwork + the label
 *  (a compressed chain reads as one 'a/b/c' line) + how much changed below,
 *  plus the SAME trailing action a file row carries — applied to the whole
 *  subtree (only this group's paths when conflicts exist). The action is a
 *  sibling of the disclosure button, so a click can never fold the row; it stops propagation anyway so
 *  the intent survives a future nesting change. Memoized like {@link FileRow}. */
const DirRow = memo(function DirRow(props: {
  row: ChangeDir
  depth: number
  folderGlyph: (path: string, open: boolean) => ReactNode
  staged: boolean
  open: boolean
  busy: boolean
  merge: boolean
  onToggle: (key: string) => void
  onToggleStage: (path: string, staged: boolean, merge?: boolean) => void
}): ReactNode {
  const { row: node, staged, open, busy, merge } = props
  const key = `${merge ? 'm' : staged ? 's' : 'u'}:${node.path}`
  const action = staged ? t('unstageAll') : t('stageAll')
  return (
    <div className={css.row} style={{ paddingLeft: props.depth * 12 + 8 }} data-row={node.path}>
      <IndentGuides depth={props.depth} />
      <button
        type="button"
        className={css.dirRow}
        data-dir={node.path}
        aria-expanded={open}
        title={node.path}
        onClick={() => { props.onToggle(key) }}
      >
        <span className={css.chevron} data-open={open ? 'true' : undefined} aria-hidden="true">
          <IconChevronRightOutlineRegular size={12} />
        </span>
        <span className={css.rowIcon} aria-hidden="true">{props.folderGlyph(node.path, open)}</span>
        <span className={css.dirName}>{node.name}</span>
      </button>
      <IconButton
        size="sm"
        className={css.rowAction}
        disabled={busy}
        label={action}
        icon={staged ? MINUS_ICON : <IconPlusOutlineRegular size={12} />}
        onClick={(event) => {
          event.stopPropagation()
          props.onToggleStage(node.path, staged, merge)
        }}
      />
    </div>
  )
})

/** The commit facts the history menu and the preview ref read — satisfied by
 *  the graph's own rows (`git.graph`) without the lens inventing a log entry. */
type CommitRow = Pick<GitLogEntry, 'hash' | 'hashFull' | 'subject'>

export interface GitLensProps {
  scope: SessionScope
  /** @deprecated The sidebar store is no longer read here (the fence guard it
   *  fed is gone); the prop stays for the caller's shape. */
  store: SidebarStore
  onOpenFile: (path: string) => void
  /** Preview one change in the shared bottom pane (worktree or commit ref). */
  onPreview: (ref: SidebarDiffRef) => void
  /** The ref currently previewed (row highlight); null when the pane is closed. */
  selectedRef: SidebarDiffRef | null
  /** Preview one commit the GRAPH selected. Unlike a change-row preview this
   *  does not move the bottom pane to `diff`: the FIRST graph selection lands
   *  on `details` (the tab decides when the entry arrives). Defaults to
   *  {@link GitLensProps.onPreview}. */
  onGraphPreview?: (ref: SidebarDiffRef) => void
  /** Drop a preview whose commit left the graph (a refresh that lost the row). */
  onClearPreview?: () => void
  /** The graph's selected commit, reported upward for the tab's bottom pane
   *  (`details` tab, see {@link CommitDetails}). Null when nothing is selected
   *  there; a HIDDEN graph keeps its report, the pane below is shared. */
  onDetailsChange?: (selection: GraphDetailsSelection | null) => void
  /** The tab is on screen: the lens retains its store slot. */
  visible: boolean
  /** THIS lens is the one on screen inside the tab. A hidden (retained) lens
   *  neither polls nor keeps fetching — only its state is kept. */
  active?: boolean
  /** The tab's context, for the registered file/folder icon chain (absent →
   *  the host's built-in artwork, exactly like the file tree falls back). */
  ctx?: Context
}

export function GitLens(props: GitLensProps) {
  const { scope, onOpenFile, onPreview, selectedRef, visible, active = visible, ctx } = props

  const service = ctx?.get('betterSidebar')
  /** The file row's artwork: a registered icon wins, else the host's own
   *  (the same chain the file tree runs, so both pages agree). */
  const fileGlyph = useCallback((path: string): ReactNode => (
    service === undefined ? builtinFileIcon(path, 14) : service.fileIcon(path, 14)
  ), [service])
  const folderGlyph = useCallback((path: string, open: boolean): ReactNode => (
    service === undefined ? builtinFolderIcon(open, 14) : service.folderIcon(path, open, 14)
  ), [service])

  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>()
  const [repoRoot, setRepoRoot] = useState<string | undefined>()
  /** The scope the Graph section reads with: the session's, plus the selected
   *  child repository once discovery picked one. */
  const graphScope = useMemo<SessionScope>(
    () => (repoRoot === undefined ? scope : { ...scope, repoRoot }),
    [scope, repoRoot],
  )
  /** Every repository of the session workspace, kept once discovered: the
   *  status of a SELECTED child reports only itself, so the selector's option
   *  list cannot be re-derived from the current snapshot alone. */
  const [repoChoices, setRepoChoices] = useState<string[]>([])
  const [branchNames, setBranchNames] = useState<string[]>([])
  /** Bumped by every explicit refresh, the repo/worktree switch and the
   *  branch switch: the commit graph (a child of the Graph section) re-reads
   *  its own bounded page on each tick instead of duplicating status here. */
  const [graphRefresh, setGraphRefresh] = useState(0)
  const [changesOpen, setChangesOpen] = useState(true)
  const [graphOpen, setGraphOpen] = useState(true)
  const [moreOpen, setMoreOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  /** Commit drafts, one per scope: the Commit button asks only for a message
   *  and a staged row, so a draft typed against another project would submit
   *  verbatim under this one. Keyed rather than cleared on a scope swap, so a
   *  kept-mounted tab shows a conversation its own message when it comes back
   *  (#712) — bounded to the newest {@link COMMIT_DRAFT_CAP} scopes, because
   *  that tab lives for the whole page. */
  const [commitDrafts, setCommitDrafts] = useState<Record<string, string>>({})
  // Primary selection canonicalizes to "" so the initial inventory cannot
  // move a just-typed draft to a different key; linked checkouts stay isolated.
  const draftWorktree = selectedWorktree === worktrees.find(entry => entry.current)?.path ? '' : selectedWorktree ?? ''
  const draftKey = `${scope.sessionId}\u0000${scope.cwd ?? ''}\u0000${repoRoot ?? ''}\u0000${draftWorktree}`
  const commitMsg = commitDrafts[draftKey] ?? ''
  const writeDraft = (text: string): void => {
    setCommitDrafts(prev => withCommitDraft(prev, draftKey, text))
  }
  const [busy, setBusy] = useState(false)
  const actionLock = useRef<symbol | null>(null)
  /** Whether a commit-message suggestion is being generated host-side (the
   *  host streams the diff through the harness LLM — no agent is spawned). */
  const [suggesting, setSuggesting] = useState(false)
  /** The route the next suggestion would use, for the button's tooltip. */
  const [commitModel, setCommitModel] = useState<string | undefined>(undefined)
  /** Whether a COMMIT is in flight (a subset of `busy`, which also covers
   *  staging/checkout): the input reports it with its own busy label. */
  const [committing, setCommitting] = useState(false)
  /** The commit box grows with its text, up to the scroll cap below. */
  const commitBoxRef = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const box = commitBoxRef.current
    // A layout-less environment (tests) reports 0: leave the CSS height alone.
    if (box === null || box.scrollHeight === 0) return
    const max = COMMIT_BOX_LINE_HEIGHT * COMMIT_BOX_MAX_ROWS
    // Reset first: a scrollHeight measured against the current height can only
    // ever grow, so a deleted line would leave the box too tall.
    box.style.height = 'auto'
    const next = Math.min(box.scrollHeight, max)
    box.style.height = `${next}px`
    box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden'
  }, [commitMsg, changesOpen, visible])
  /** One footer status channel for generation and Git mutations. */
  const [actionError, setActionError] = useState<string | null>(null)
  /** The lens-level error banner (refresh / branch switch / history paging). */
  const [viewError, setViewError] = useState<string | null>(null)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: CommitRow; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** Collapsed directory rows, keyed per GROUP + path: a directory that has
   *  changes on both sides folds independently in each section (and the two
   *  groups never fight over one key). Default: everything expanded. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())

  /** The selected checkout, readable synchronously by the refresh chain
   *  without making every callback depend on the state it writes. */
  const chosenPathRef = useRef<string | undefined>(undefined)
  /** The automatic preference for a dirty linked checkout runs ONCE per
   *  scope: after it (or after any explicit user choice) a later re-list
   *  must never yank the view off the checkout the user is working in. */
  const autoSelectDone = useRef(false)
  /** The scope and repo the git calls target, readable at call time: a repo
   *  switch refreshes with the NEW root even before React re-renders. */
  const scopeRef = useRef<{ sessionId: string; cwd: string | undefined }>({ sessionId: scope.sessionId, cwd: scope.cwd })
  const repoRootRef = useRef<string | undefined>(undefined)
  /** Bumped whenever the scope resets: a late response of the previous scope
   *  can never publish rows into the new one. */
  const scopeGen = useRef(0)
  /** The refresh chain's queue: a request landing while one runs is replayed
   *  once after it settles — a manual refresh is never silently dropped. */
  const gate = useRef({ inFlight: false, queued: false, queuedSilent: true })

  useEffect(() => { scopeRef.current = { sessionId: scope.sessionId, cwd: scope.cwd } }, [scope.sessionId, scope.cwd])

  /** The session scope every git call of this lens targets right now. */
  const gitScopeNow = useCallback((): SessionScope => {
    const base = scopeRef.current
    return repoRootRef.current === undefined ? { ...base } : { ...base, repoRoot: repoRootRef.current }
  }, [])

  /** Label the generate button with the model the next suggestion would use.
   *  Re-read whenever the panel becomes visible: the pinned route lives in the
   *  side card settings, so a change made there lands on the next visit. */
  const scopeSessionId = scope.sessionId
  const scopeCwd = scope.cwd
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    api.gitCommitModel({ sessionId: scopeSessionId, ...(scopeCwd === undefined ? {} : { cwd: scopeCwd }) })
      .then(view => {
        if (cancelled) return
        setCommitModel(view.route === undefined ? undefined : `${view.route.provider}/${view.route.model}`)
      })
      .catch(() => { if (!cancelled) setCommitModel(undefined) })
    return () => { cancelled = true }
  }, [visible, scopeSessionId, scopeCwd])

  // Keep the session cwd and pass the child selection explicitly: an attached
  // session overrides client cwd, so changing cwd alone still reads the first
  // repository. The status store includes repoRoot in its cache key.
  // The status store keys on `worktree`; the PRIMARY checkout is exactly what
  // an unscoped status call resolves to, so passing its path would mint a
  // second key (and a second 2.5s `git status` poll) for the same answer the
  // file tree already subscribes to. Only a LINKED checkout narrows the key.
  const primaryWorktree = worktrees.find(entry => entry.current)?.path
  const statusWorktree = selectedWorktree !== undefined && selectedWorktree !== primaryWorktree
    ? selectedWorktree
    : undefined
  // `visible` keeps the slot ALIVE (the tab is on screen, the lens may be
  // hidden behind the session lens and must not lose its snapshot); `poll:
  // active` states the cadence only while this lens is the one being looked
  // at. A retained slot serves its last answer, so switching lenses back shows
  // the previous rows until the fresh fetch lands.
  const status = useGitStatus(
    { sessionId: scope.sessionId, cwd: scope.cwd, repoRoot },
    { worktree: statusWorktree, visible, poll: active },
  )
  /** The last answer seen for THIS scope. While the lens is hidden the shared
   *  store may forget the slot (nothing in the session is watching it, and the
   *  store drops a slot whose last consumer left), so a RETAINED lens keeps
   *  painting the rows it already had instead of flashing its loading state the
   *  moment the user switches back. A scope change starts it over. */
  const lastStatus = useRef<{ key: string; value: GitStatusResult | null }>({ key: '', value: null })
  const statusKey = `${scope.sessionId}\u0000${scope.cwd ?? ''}\u0000${repoRoot ?? ''}\u0000${statusWorktree ?? ''}`
  if (lastStatus.current.key !== statusKey) lastStatus.current = { key: statusKey, value: null }
  if (status.snapshot !== null) lastStatus.current.value = status.snapshot
  const snapshot: GitStatusResult | null = status.snapshot ?? lastStatus.current.value
  useEffect(() => {
    const repositories = snapshot?.repositories
    if (repositories !== undefined && repositories.length > 1) setRepoChoices(repositories)
  }, [snapshot])

  /** Select one checkout (or none) and remember the choice synchronously. */
  const selectWorktree = (target: string | undefined): void => {
    chosenPathRef.current = target
    setSelectedWorktree(target)
  }

  /** Drop every checkout-derived surface before another one loads. */
  const clearDerived = (): void => {
    scopeGen.current += 1
    actionLock.current = null
    setBusy(false)
    setSuggesting(false)
    setCommitting(false)
    setBranchNames([])
    setGraphRefresh(value => value + 1)
    setActionError(null)
    setFileMenu(null)
    setHistoryMenu(null)
    setConfirm(null)
    setMoreOpen(false)
    setBranchOpen(false)
  }

  /** Load the branch choices of one checkout; its history is the commit
   *  graph's own business (the Graph section reads `git.graph` in pages). */
  const loadTarget = useCallback(async (target: string | undefined): Promise<void> => {
    const generation = scopeGen.current
    const gitScope = gitScopeNow()
    const branchResult = await api.gitBranch(gitScope, target).catch(() => ({ current: '', names: [] as string[] }))
    if (generation !== scopeGen.current || target !== chosenPathRef.current) return
    setBranchNames(branchResult.names)
  }, [gitScopeNow])

  /** One listing pass: re-read the worktree inventory, apply the first-pass
   *  automatic selection, then load the chosen checkout's derived surfaces.
   *  The shared status store follows the same selection on its own. */
  const runOnce = useCallback(async (silent: boolean, signal?: AbortSignal): Promise<void> => {
    const generation = scopeGen.current
    let listed: GitWorktree[]
    try {
      listed = await api.gitWorktrees(gitScopeNow(), signal)
    } catch (reason) {
      if (signal?.aborted !== true && generation === scopeGen.current) setViewError(errorMessage(reason))
      return
    }
    if (signal?.aborted === true || generation !== scopeGen.current) return
    // Republish the inventory only when it really says something new. Handing
    // React a fresh array (and fresh rows) on every 30 s tick re-rendered the
    // whole lens — the change trees included — although nothing had changed,
    // which is exactly what the "silent" tick below was supposed to avoid.
    // Keeping the previous identity when the listing is equal makes the tick
    // silent; a new linked checkout or a moved change count still lands.
    setWorktrees(previous => (sameWorktrees(previous, listed) ? previous : listed))
    const current = listed.find(entry => entry.current)
    const stillListed = chosenPathRef.current !== undefined
      && listed.some(entry => entry.path === chosenPathRef.current)
    let target = stillListed ? chosenPathRef.current : current?.path
    if (!autoSelectDone.current) {
      // DSH and other coding agents commonly create ONE linked checkout while
      // the session remains rooted at the clean primary checkout. Select that
      // checkout automatically only when the choice is unambiguous — and only
      // on this first pass, never again.
      const dirtyLinked = listed.filter(entry => !entry.current && entry.changes > 0)
      if ((current?.changes ?? 0) === 0 && dirtyLinked.length === 1) {
        target = dirtyLinked[0]!.path
        autoSelectDone.current = true
      } else if (current !== undefined) {
        target = current.path
        autoSelectDone.current = true
      }
    }
    const targetChanged = target !== chosenPathRef.current
    if (targetChanged) {
      const checkoutChanged = chosenPathRef.current !== undefined || target !== current?.path
      selectWorktree(target)
      // First inventory merely names the already-active primary checkout.
      if (checkoutChanged) clearDerived()
    }
    // A silent tick only keeps the inventory (and its change counts) fresh.
    if (silent && !targetChanged) return
    // A non-silent pass is the user asking for the truth (refresh, checkout,
    // stage/commit): the Graph section re-reads its bounded page too, since the
    // branch may have moved under it.
    setGraphRefresh(value => value + 1)
    await loadTarget(target)
  }, [gitScopeNow, loadTarget])

  /** Run one refresh, replaying a request that arrives mid-flight exactly once. */
  const refresh = useCallback(async (silent = false, signal?: AbortSignal): Promise<void> => {
    const current = gate.current
    if (current.inFlight) {
      current.queued = true
      if (!silent) current.queuedSilent = false
      return
    }
    current.inFlight = true
    let nextSilent = silent
    try {
      for (;;) {
        current.queued = false
        current.queuedSilent = true
        if (signal?.aborted === true) break
        if (!nextSilent) setViewError(null)
        await runOnce(nextSilent, signal)
        if (!current.queued) break
        nextSilent = current.queuedSilent
      }
    } finally {
      current.inFlight = false
    }
  }, [runOnce])

  // Mount / scope change: reset every piece of per-scope state, then load.
  // A tab mounted while hidden loads nothing (its status store has no visible
  // consumer either); the rising-edge catch-up below loads it on screen.
  useEffect(() => {
    scopeGen.current += 1
    gate.current = { inFlight: false, queued: false, queuedSilent: true }
    autoSelectDone.current = false
    chosenPathRef.current = undefined
    repoRootRef.current = undefined
    setWorktrees([])
    setSelectedWorktree(undefined)
    setRepoRoot(undefined)
    setRepoChoices([])
    clearDerived()
    setViewError(null)
    // The three destructive entry points are aimed at a ROW of the previous
    // scope: the menus carry that row's path and `confirmPending` executes a
    // closure over it, while `gitScopeNow()` already reads the NEW scope — so
    // a discard/revert/cherry-pick confirmed here would land in the project
    // that took over the pane (same class as the file tree's cross-session
    // delete).
    setFileMenu(null)
    setHistoryMenu(null)
    setConfirm(null)
    if (visible) void refresh(false)
    // Granular scope fields: the refresh identity is stable, only a real
    // session/cwd change restarts the chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd])

  // Becoming visible (or visible again): catch the derived surfaces up. The
  // shared status re-fetches on the same edge (its store drops the snapshot
  // when the last consumer goes away), so both halves of the lens agree.
  const wasVisible = useRef(visible)
  useEffect(() => {
    const rising = visible && !wasVisible.current
    wasVisible.current = visible
    if (!rising) return
    void refresh(false)
    // Granular scope fields: only the visibility edge drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  /** The inventory poll: a linked checkout created mid-session shows up
   *  without a manual refresh (the status poll itself belongs to the store). */
  const pollInventory = useCallback((signal: AbortSignal): Promise<void> => refresh(true, signal), [refresh])
  usePolling(visible && active, pollInventory, { intervalMs: WORKTREE_POLL_MS, mode: 'self-scheduling' })

  /** Lock one target's mutation and refresh even a partially failed sync. */
  const runAction = async (
    action: () => Promise<unknown>,
    failure: (reason: unknown) => string = errorMessage,
    onSuccess?: () => void,
  ): Promise<void> => {
    if (actionLock.current !== null) return
    const lock = Symbol()
    actionLock.current = lock
    const generation = scopeGen.current
    const sessionId = scope.sessionId
    setBusy(true)
    setActionError(null)
    try {
      await action()
      if (generation === scopeGen.current) onSuccess?.()
    } catch (reason) {
      if (generation === scopeGen.current) setActionError(failure(reason))
    } finally {
      // A Pull can succeed before Push fails: refresh on failure too.
      invalidateGitStatus(sessionId)
      if (generation === scopeGen.current) await refresh(false)
      if (actionLock.current === lock) {
        actionLock.current = null
        setBusy(false)
        setCommitting(false)
      }
    }
  }

  const stageError = (reason: unknown): string => t('changesStageFailed', { message: errorMessage(reason) })

  /** The remote actions prepend their own label: git's message for a missing
   *  upstream or a diverged branch says nothing about which button ran. */
  const pushError = (reason: unknown): string => `${t('pushError')}: ${errorMessage(reason)}`
  const pullError = (reason: unknown): string => `${t('pullError')}: ${errorMessage(reason)}`

  const stageEntry = (path: string | undefined, staged: boolean, merge = false): void => {
    const gitScope = gitScopeNow()
    const target = selectedWorktree
    // With conflicts, directory/all actions must only touch their own group:
    // git add/reset on the whole directory would silently resolve/reset Merge.
    const rows = staged ? stagedEntries : merge || mergeEntries.some(entry => entry.path === path) ? mergeEntries : unstagedEntries
    const paths = mergeEntries.length === 0 ? [path] : rows
      .filter(entry => path === undefined || entry.path === path || entry.path.startsWith(`${path}/`))
      .map(entry => entry.path)
    void runAction(async () => {
      for (const selectedPath of paths) {
        if (staged) await api.gitUnstage(gitScope, selectedPath, target)
        else await api.gitStage(gitScope, selectedPath, target)
      }
    }, stageError)
  }

  const stageAll = (staged: boolean, merge = false): void => { stageEntry(undefined, staged, merge) }

  const commit = (): void => {
    const message = commitMsg.trim()
    if (!canCommit || actionLock.current) return
    setCommitting(true)
    void runAction(
      () => api.gitCommit(gitScopeNow(), message, selectedWorktree),
      errorMessage,
      () => { writeDraft('') },
    )
  }

  /** The generate button's label/tooltip: names the model when one resolves,
   *  so the user knows which provider the draft will run on. */
  const generateLabel = commitModel === undefined
    ? t('generateCommitMessage')
    : t('generateCommitMessageWith', { model: commitModel })

  /** Ask the host to draft a commit message from the pending changes, then
   *  fill the message box (still editable; regenerating is allowed). */
  const suggestMessage = async (): Promise<void> => {
    if (actionLock.current !== null || entries.length === 0) return
    const lock = Symbol()
    actionLock.current = lock
    const generation = scopeGen.current
    setSuggesting(true)
    setActionError(null)
    try {
      const { message } = await api.gitSuggestMessage(gitScopeNow(), isZh() ? 'zh' : 'en', selectedWorktree)
      if (generation === scopeGen.current) writeDraft(message)
    } catch (reason) {
      if (generation !== scopeGen.current) return
      if (reason instanceof SidebarApiError && reason.code === 'git-suggest-empty') {
        setActionError(t('suggestCommitEmpty'))
      } else {
        setActionError(`${t('suggestCommitError')}: ${errorMessage(reason)}`)
      }
    } finally {
      if (actionLock.current === lock) {
        actionLock.current = null
        setSuggesting(false)
      }
    }
  }

  /** Push the selected checkout's branch. Local commits and the remote ride the
   *  SAME status line as every other git action — the failures share one cause
   *  (no upstream, auth, divergence), so a second error channel would only
   *  split the user's attention. */
  const push = (): void => {
    void runAction(() => api.gitPush(gitScopeNow(), selectedWorktree), pushError)
  }

  /** Pull into the selected checkout (fast-forward only host-side). */
  const pull = (): void => {
    void runAction(() => api.gitPull(gitScopeNow(), selectedWorktree), pullError)
  }

  const sync = (): void => {
    if (!canSync) return
    const gitScope = gitScopeNow()
    const target = selectedWorktree
    void runAction(async () => {
      try { await api.gitPull(gitScope, target) } catch (reason) { throw new Error(pullError(reason), { cause: reason }) }
      try { await api.gitPush(gitScope, target) } catch (reason) { throw new Error(pushError(reason), { cause: reason }) }
    })
  }

  /** Switching the selected checkout changes which rows are legitimate to act
   *  on: clear the derived surfaces before the asynchronous refresh resolves
   *  so a stale history row can never run over the new checkout's repository. */
  const chooseWorktree = (target: string): void => {
    if (target === chosenPathRef.current) return
    autoSelectDone.current = true
    selectWorktree(target)
    clearDerived()
    void refresh(false)
  }

  /** Switching the selected child repository: both the inventory and the
   *  status key follow the new root, and exactly ONE full refresh runs. The
   *  checkout choice resets to the new repository's current one — an explicit
   *  user choice never triggers the automatic linked-checkout preference. */
  const chooseRepo = (target: string): void => {
    if (target === repoRoot) return
    autoSelectDone.current = true
    chosenPathRef.current = undefined
    repoRootRef.current = target
    setSelectedWorktree(undefined)
    setRepoRoot(target)
    setWorktrees([])
    clearDerived()
    void refresh(false)
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === (snapshot?.branch ?? '') || actionLock.current !== null) return
    const lock = Symbol()
    actionLock.current = lock
    const generation = scopeGen.current
    setBusy(true)
    setViewError(null)
    try {
      await api.gitCheckout(gitScopeNow(), branch, selectedWorktree)
      invalidateGitStatus(scope.sessionId)
      if (generation === scopeGen.current) await refresh(false)
    } catch (reason) {
      if (generation === scopeGen.current) setViewError(`${t('checkoutError')}: ${errorMessage(reason)}`)
    } finally {
      if (actionLock.current === lock) {
        actionLock.current = null
        setBusy(false)
      }
    }
  }

  /** Run one destructive operation after the confirm dialog, then refresh. */
  const runConfirmed = (confirmState: ConfirmState): void => {
    setConfirm(confirmState)
  }

  const confirmPending = (): void => {
    const pending = confirm
    if (pending === null) return
    setConfirm(null)
    void runAction(pending.onConfirm)
  }


  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  const openHistoryMenu = (event: MouseEvent, entry: CommitRow): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  /** The preview ref for one commit. */
  const commitRefOf = (entry: CommitRow): SidebarDiffRef => ({
    kind: 'commit',
    hash: entry.hash,
    hashFull: entry.hashFull,
    subject: entry.subject,
    worktree: selectedWorktree,
    repoRoot,
  })

  /** Whether a worktree row is the one currently previewed. */
  const isPreviewedWorktree = (path: string, staged: boolean): boolean => {
    if (selectedRef === null || selectedRef.kind !== 'worktree') return false
    return selectedRef.path === path && selectedRef.staged === staged
      && (selectedRef.worktree ?? '') === (selectedWorktree ?? '')
      && (selectedRef.repoRoot ?? '') === (repoRoot ?? '')
  }

  const entries = snapshot?.entries ?? NO_ENTRIES
  // The CONTENT of the answer decides whether the tree must be rebuilt; the
  // array identity only decides whether the (cheap) key is recomputed.
  const contentKey = useMemo(() => entriesKey(entries), [entries])
  // One fold per group, rebuilt only when the change list's CONTENT changes —
  // never on a poll that answered the same files, however fresh its arrays are.
  const { mergeEntries, stagedEntries, unstagedEntries, mergeTree, stagedTree, unstagedTree } = useMemo(() => {
    const merge = entries.filter(entry => statusOfXY(entry.xy)?.tone === 'conflict')
    const regular = entries.filter(entry => statusOfXY(entry.xy)?.tone !== 'conflict')
    const staged = regular.filter(isStagedEntry)
    const unstaged = regular.filter(isUnstagedEntry)
    // A row's porcelain code is a PAIR, and each band reads its own half:
    // 'MD' is an 'M' in the Staged band and a 'D' in the Changes band. The
    // rewrite is display-only (a fresh object per row), so the mutations below
    // still see the real code.
    const sideEntries = (rows: GitStatusEntry[], index: number): GitStatusEntry[] => rows.map(entry => ({
      ...entry, xy: entry.xy === '??' ? '??' : index === 0 ? `${entry.xy[0]} ` : ` ${entry.xy[1]}`,
    }))
    return {
      mergeEntries: merge,
      stagedEntries: staged,
      unstagedEntries: unstaged,
      // A conflicted row prints no line count: both diffs see the conflict,
      // and printing either side's number as "the" number is the double-count
      // class #908 was about.
      mergeTree: buildChangeTree(merge),
      // Each band's rows carry THAT band's reading: a path changed on both
      // sides sits in both trees, and neither may see the other's number.
      stagedTree: buildChangeTree(sideEntries(staged, 0), 'staged'),
      unstagedTree: buildChangeTree(sideEntries(unstaged, 1), 'unstaged'),
    }
    // The key stands in for `entries`: same content ⇒ same tree objects ⇒ the
    // memoized rows below keep their props and never re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey])
  // The band totals (#131) sum the very nodes the rows render, so the header
  // can never disagree with the numbers printed under it.
  const unstagedTotal = useMemo(() => sumLineCounts(unstagedTree), [unstagedTree])
  const stagedTotal = useMemo(() => sumLineCounts(stagedTree), [stagedTree])
  const isRepo = snapshot?.isRepo === true
  const branch = snapshot?.branch ?? ''
  const clean = isRepo && entries.length === 0
  const canCommit = isRepo && !busy && !suggesting && mergeEntries.length === 0
    && stagedEntries.length > 0 && commitMsg.trim() !== ''
  const branchLabel = branch || t('gitDetached')
  const branchMarkers = `${unstagedEntries.length > 0 ? '*' : ''}${stagedEntries.length > 0 ? '+' : ''}${snapshot?.operation !== undefined || mergeEntries.length > 0 ? '!' : ''}`
  const shortcut = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? 'Cmd+Enter' : 'Ctrl+Enter'
  const messagePlaceholder = t('commitPlaceholder', { branch: branchLabel, shortcut })
  const canSync = isRepo && !busy && !suggesting && branch !== '' && snapshot?.detached !== true
    && snapshot?.upstream !== undefined && snapshot.ahead !== undefined && snapshot.behind !== undefined
    && snapshot.operation === undefined && mergeEntries.length === 0
  const syncLabel = snapshot?.detached === true || branch === '' ? t('gitDetached')
    : snapshot?.upstream === undefined ? t('gitNoUpstream')
    : snapshot.ahead === undefined || snapshot.behind === undefined ? t('gitSyncUnavailable')
    : `${t('gitSync')}: ${snapshot.upstream} · ${snapshot.behind}↓ ${snapshot.ahead}↑`

  /** Fold or unfold one directory row (keyed per group, see `collapsed`).
   *  Stable: it is a memoized row's prop. */
  const toggleDir = useCallback((key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** The latest-value holder for the actions a memoized row calls: a row's
   *  props must keep their identity across polls, so these callbacks read the
   *  current closures through the ref instead of closing over them. */
  const rowActions = useRef({
    preview: (_node: ChangeFile, _staged: boolean): void => { /* replaced below */ },
    stage: (_path: string, _staged: boolean, _merge?: boolean): void => { /* replaced below */ },
  })
  useEffect(() => {
    rowActions.current = {
      preview: (node, staged) => {
        onPreview(worktreeRefOf(node.path, isUntrackedStatus(node.status), staged, chosenPathRef.current, repoRootRef.current))
      },
      stage: (path, staged, merge) => { stageEntry(path, staged, merge) },
    }
  })

  /** Stable row callbacks (see rowActions). */
  const previewFile = useCallback((node: ChangeFile, staged: boolean): void => {
    rowActions.current.preview(node, staged)
  }, [])
  const stagePath = useCallback((path: string, staged: boolean, merge = false): void => {
    rowActions.current.stage(path, staged, merge)
  }, [])
  const openRowMenu = useCallback((event: MouseEvent, node: ChangeFile, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ path: node.path, staged, untracked: isUntrackedStatus(node.status), x: event.clientX, y: event.clientY })
  }, [])

  /** Indent the content, not its container: hover and selection stay full-width. */
  const renderFile = (node: ChangeFile, staged: boolean, depth = 0): ReactNode => (
    <FileRow
      key={`file:${staged ? 's' : 'u'}:${node.path}`}
      row={node}
      depth={depth}
      glyph={fileGlyph}
      staged={staged}
      busy={busy || suggesting}
      selected={isPreviewedWorktree(node.path, staged)}
      onPreview={previewFile}
      onContextMenu={openRowMenu}
      onToggleStage={stagePath}
    />
  )

  const renderDir = (node: ChangeDir, staged: boolean, merge: boolean, depth = 0): ReactNode => {
    const key = `${merge ? 'm' : staged ? 's' : 'u'}:${node.path}`
    const open = !collapsed.has(key)
    return (
      <div key={`dir:${key}`}>
        <DirRow row={node} depth={depth} folderGlyph={folderGlyph} staged={staged}
          open={open} busy={busy || suggesting} merge={merge} onToggle={toggleDir} onToggleStage={stagePath} />
        {open && node.children.map(child => child.kind === 'dir'
          ? renderDir(child, staged, merge, depth + 1) : renderFile(child, staged, depth + 1))}
      </div>
    )
  }

  const renderTree = (nodes: readonly ChangeNode[], staged: boolean, merge = false): ReactNode => (
    <div className={css.tree}>
      {nodes.map(node => (node.kind === 'dir' ? renderDir(node, staged, merge) : renderFile(node, staged)))}
    </div>
  )

  const renderGroup = (id: string, label: string, rows: readonly GitStatusEntry[], nodes: readonly ChangeNode[], staged: boolean, merge = false): ReactNode => {
    if (rows.length === 0) return null
    const key = `group:${id}`
    const open = !collapsed.has(key)
    const totals = staged ? stagedTotal : merge ? undefined : unstagedTotal
    return (
      <div className={css.group} data-group={id}>
        <div className={`${css.scmHeader} ${css.groupHeader}`}>
          <button type="button" className={css.scmDisclosure} aria-expanded={open} aria-label={`${label} (${rows.length})`} onClick={() => { toggleDir(key) }}>
            <span className={css.chevron} data-open={open ? 'true' : undefined} aria-hidden="true"><IconChevronRightOutlineRegular size={12} /></span>
            {label}
            {totals !== undefined && totals.files > 0 && <PlusMinus additions={totals.additions} deletions={totals.deletions} note="group" />}
          </button>
          <IconButton className={css.headerAction} size="sm" disabled={busy || suggesting}
            label={staged ? t('unstageAll') : t('stageAll')}
            icon={staged ? MINUS_ICON : <IconPlusOutlineRegular size={12} />}
            onClick={() => { stageAll(staged, merge) }} />
          <span className={css.countPill} data-count={rows.length}>{rows.length}</span>
        </div>
        {open && renderTree(nodes, staged, merge)}
      </div>
    )
  }

  return (
    <div className={css.git} data-git-root>
      {/* Changes and Graph scroll together; only the branch/sync footer docks. */}
      <div className={css.gitScroll} data-git-scroll>
        {viewError !== null && <Notice kind="error" role="alert">{viewError}</Notice>}

        {snapshot === null && status.loading && <Notice kind="loading" tone="page">{t('loading')}</Notice>}
        {snapshot === null && !status.loading && status.error && <Notice kind="error" tone="page">{t('error')}</Notice>}
        {snapshot !== null && !isRepo && <Notice kind="empty" tone="page">{t('notRepo')}</Notice>}
        {snapshot?.truncated === true && <Notice kind="warn">{t('statusTruncated')}</Notice>}

        {isRepo && (
          <section className={css.changesSection} data-scm-section="changes">
            <div className={css.scmHeader}>
              <button type="button" className={css.scmDisclosure} aria-expanded={changesOpen}
                onClick={() => { setChangesOpen(open => !open) }}>
                <span className={css.chevron} data-open={changesOpen ? 'true' : undefined} aria-hidden="true">
                  <IconChevronRightOutlineRegular size={12} />
                </span>
                {t('gitChanges')}
              </button>
              <div className={css.scmActions}>
                <IconButton size="sm" icon={<IconCheckOutlineRegular size={14} />} label={t('commit')}
                  disabled={!canCommit} onClick={commit} />
                <IconButton size="sm" icon={<IconRefreshOutlineRegular size={14} />} label={t('refresh')}
                  disabled={busy || suggesting} onClick={() => { invalidateGitStatus(scope.sessionId); void refresh(false) }} />
                <Menu open={moreOpen} onClose={() => { setMoreOpen(false) }} portal compact align="end" autoFocus
                  anchor={<IconButton size="sm" icon={<IconEllipsisOutlineRegular size={14} />} label={t('gitMoreActions')}
                    active={moreOpen} onClick={() => { setMoreOpen(open => !open) }} />}
                  items={[
                    { id: 'pull', label: t('pull'), disabled: busy || suggesting || snapshot?.detached === true },
                    { id: 'push', label: t('push'), disabled: busy || suggesting || snapshot?.detached === true },
                    ...(repoChoices.length > 1 ? [{ id: 'repos', label: t('gitRepository'),
                      submenu: repoChoices.map(root => ({ id: `repo:${root}`, label: baseName(root), disabled: busy || suggesting })),
                    }] : []),
                    ...(worktrees.length > 1 ? [{ id: 'worktrees', label: t('worktree'),
                      submenu: worktrees.map(entry => ({ id: `worktree:${entry.path}`,
                        label: `${entry.branch || t('gitDetached')} · ${baseName(entry.path)} (${entry.changes})`, disabled: busy || suggesting,
                      })),
                    }] : []),
                  ]}
                  onSelect={id => {
                    setMoreOpen(false)
                    if (id === 'push') push()
                    else if (id === 'pull') pull()
                    else if (id.startsWith('repo:')) chooseRepo(id.slice(5))
                    else if (id.startsWith('worktree:')) chooseWorktree(id.slice(9))
                  }} />
              </div>
            </div>
            {changesOpen && <div data-scm-changes>
              <div className={css.messageBox} data-message-box>
                <span className={css.commitInputWrap}>
                  <textarea ref={commitBoxRef} className={css.commitInput}
                    placeholder={busy || suggesting ? '' : messagePlaceholder}
                    value={commitMsg} disabled={busy || suggesting} aria-busy={busy || suggesting}
                    data-message-busy={suggesting || committing ? 'true' : undefined}
                    aria-label={messagePlaceholder} rows={1}
                    onChange={event => { writeDraft(event.currentTarget.value); setActionError(null) }}
                    onKeyDown={event => {
                      if (event.nativeEvent.isComposing) return
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); commit() }
                      if ((event.ctrlKey || event.metaKey) && (event.key === 'g' || event.key === 'G')) {
                        event.preventDefault(); void suggestMessage()
                      }
                    }} />
                  {(suggesting || committing) && <span className={css.commitBusyText} role="status" aria-live="polite">
                    {suggesting ? t('generatingCommitMessage') : t('committingMessage')}
                  </span>}
                  <button type="button" className={suggesting ? `${css.suggestButton} ${css.suggestBusy}` : css.suggestButton}
                    aria-label={generateLabel} aria-busy={suggesting} title={generateLabel}
                    disabled={busy || suggesting || entries.length === 0} onClick={() => { void suggestMessage() }}>
                    <IconSparkleRegular size={14} />
                  </button>
                </span>
              </div>
              {clean && <Notice kind="empty">{t('changesClean')}</Notice>}
              {renderGroup('merge', t('gitMergeChanges'), mergeEntries, mergeTree, false, true)}
              {renderGroup('staged', t('gitStagedChanges'), stagedEntries, stagedTree, true)}
              {renderGroup('unstaged', t('gitChanges'), unstagedEntries, unstagedTree, false)}
            </div>}
          </section>
        )}

        {isRepo && <section className={graphOpen ? css.graphSection : undefined} data-scm-section="graph">
          <div className={css.scmHeader}>
            <button type="button" className={css.scmDisclosure} aria-expanded={graphOpen}
              onClick={() => { setGraphOpen(open => !open) }}>
              <span className={css.chevron} data-open={graphOpen ? 'true' : undefined} aria-hidden="true">
                <IconChevronRightOutlineRegular size={12} />
              </span>
              {t('gitGraph')}
            </button>
          </div>
          {graphOpen && <div data-scm-graph className={css.graphArea}>
            <GitGraphSection
              scope={graphScope}
              worktree={selectedWorktree}
              visible={visible && active && graphOpen}
              refreshTick={graphRefresh}
              selectedRef={selectedRef}
              onPreview={props.onGraphPreview ?? onPreview}
              onClearPreview={() => { props.onClearPreview?.() }}
              onDetailsChange={props.onDetailsChange}
              onContextMenu={openHistoryMenu}
            />
          </div>}
        </section>}
      </div>

      {/* A sibling of the scroller: usable even with both sections folded. */}
      {isRepo && <div className={css.gitFooter} data-git-footer>
        {actionError !== null && <Notice kind="error" tone="inline" role="alert" className={css.actionError}>
          <span className={css.actionErrorText}>{actionError}</span>
          <IconButton size="sm" icon={<IconCloseFillRegular size={12} />} label={t('dismiss')}
            onClick={() => { setActionError(null) }} />
        </Notice>}
        <div className={css.footerRow} data-footer-row>
          <Menu open={branchOpen} onClose={() => { setBranchOpen(false) }} portal compact side="top" autoFocus
            className={css.branchMenu}
            anchor={<button type="button" className={css.branchButton} aria-haspopup="menu" aria-expanded={branchOpen}
              title={`${t('branch')}: ${branchLabel}${branchMarkers}`} disabled={busy || suggesting}
              onClick={() => { setBranchOpen(open => !open) }}>
              <IconBranchOutlineRegular size={14} /><span>{branchLabel}{branchMarkers}</span>
            </button>}
            items={branchNames.length === 0 ? [{ id: 'none', label: t('gitBranchesUnavailable'), disabled: true }]
              : branchNames.map(name => ({ id: name, label: name, disabled: busy || suggesting }))}
            selectedId={branch}
            onSelect={name => { setBranchOpen(false); void checkout(name) }} />
          <button type="button" className={css.syncButton} aria-label={syncLabel} title={syncLabel}
            disabled={!canSync} onClick={sync}>
            <IconRefreshOutlineRegular size={11} />
            <span>{snapshot?.upstream !== undefined && snapshot.ahead !== undefined && snapshot.behind !== undefined
              ? `${snapshot.behind}↓ ${snapshot.ahead}↑` : syncLabel}</span>
          </button>
        </div>
      </div>}

      {/*
        The one shared file-row context menu, positioned at the right-click
        cursor (portal so the panel's overflow clip cannot crop it).
      */}
      <Menu
        open={fileMenu !== null}
        onClose={() => { setFileMenu(null) }}
        items={[
          // The open action is always offered: the host's workspace fence
          // is gone, so a path under any checkout (linked worktree
          // included) opens like any other.
          ...(fileMenu !== null
            ? [{ id: 'open', label: t('openEditor'), icon: <IconCodeOutlineRegular size={14} /> }]
            : []),
          fileMenu?.staged === true
            ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutlineRegular size={14} /> }
            : { id: 'stage', label: t('stage'), icon: <IconPlusOutlineRegular size={14} /> },
          ...(fileMenu !== null && !fileMenu.untracked
            ? [{ id: 'discard', label: t('discard'), icon: <IconTrashOutlineRegular size={14} />, danger: true }]
            : []),
          { type: 'separator', id: 'sep1' },
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} /> },
        ]}
        onSelect={(id) => {
          const target = fileMenu
          if (target === null) return
          setFileMenu(null)
          if (id === 'open') {
            const resolved = resolveSidebarPath(selectedWorktree ?? repoRoot ?? snapshot?.root ?? scope.cwd, target.path)
            // The host accepts any path now (no containment), so the open
            // guard that mirrored the old fence is gone with it.
            onOpenFile(resolved)
            return
          }
          if (id === 'stage') {
            stageEntry(target.path, target.staged)
            return
          }
          if (id === 'discard') {
            runConfirmed({
              title: t('discardTitle'),
              description: t('discardDesc', { path: target.path }),
              confirmLabel: t('discard'),
              onConfirm: () => api.gitDiscard(gitScopeNow(), target.path, selectedWorktree),
            })
            return
          }
          if (id === 'relative') {
            copy(relativeTo(selectedWorktree ?? repoRoot ?? snapshot?.root ?? scope.cwd ?? '', target.path))
            return
          }
          if (id === 'absolute') copy(resolveSidebarPath(selectedWorktree ?? repoRoot ?? snapshot?.root ?? scope.cwd, target.path))
        }}
        portal
        compact
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
          { id: 'copyShort', label: t('copyShortHash'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'copyFull', label: t('copyFullHash'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'copySubject', label: t('copySubject'), icon: <IconCopyOutlineRegular size={14} /> },
          { type: 'separator', id: 'sep2' },
          { id: 'revert', label: t('revertCommit'), danger: true },
          { id: 'cherryPick', label: t('cherryPickCommit'), danger: true },
        ]}
        onSelect={(id) => {
          const target = historyMenu
          if (target === null) return
          setHistoryMenu(null)
          if (id === 'view') {
            onPreview(commitRefOf(target.entry))
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
              onConfirm: () => api.gitRevert(gitScopeNow(), target.entry.hashFull, selectedWorktree),
            })
            return
          }
          if (id === 'cherryPick') {
            runConfirmed({
              title: t('cherryPickTitle'),
              description: t('cherryPickDesc', { subject: target.entry.subject }),
              confirmLabel: t('cherryPickCommit'),
              onConfirm: () => api.gitCherryPick(gitScopeNow(), target.entry.hashFull, selectedWorktree),
            })
          }
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* Destructive actions land here first: Cancel / Confirm. */}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        cancelLabel={t('cancel')}
        danger
        busy={busy}
        onConfirm={confirmPending}
        onClose={() => { setConfirm(null) }}
      />
    </div>
  )
}
