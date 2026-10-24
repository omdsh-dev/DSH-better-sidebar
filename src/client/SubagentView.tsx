/**
 * Tasks page (task management): the FULL agent topology of the current
 * tree's main session, rendered in the user-approved postmodern style as a
 * workflow GRAPH canvas (default) or the classic indentation TREE — one
 * unified model (tasks-model.ts) feeds both, so the fold state and the
 * bottom-right view toggle never diverge.
 *
 * Beyond the topology this page now folds in:
 * - WORKFLOW RUNS: the host folds `tool-workflow/*` session events of the
 *   whole tree (workflows.list); a run hangs under its origin agent with its
 *   member agents re-parented below it and phase frames behind them;
 * - AGENT TEAMS (experimental host layer): when the root leads a team, its
 *   `agentTeam` Session projection feeds the always-visible team strip and
 *   enriches the matching nodes; the projection is absent without the layer,
 *   so the whole surface hides itself with no banner and no polling;
 * - BACKGROUND JOBS: a bottom drawer replaces the old in-page section and
 *   auto-collapses once the tree has many agents; job output opens as a
 *   persistent floating window (the host's own client jobs service — never
 *   the model's cursor).
 *
 * Node click jumps straight into the transcript (root → main session); the
 * ⓘ button opens the detail popover. Completed leaf agents fold into one
 * aggregate node per GROUP (finished work / waiting members); clicking an
 * aggregate reveals THAT group, while the control cluster's switch keeps the
 * page-level expand/collapse.
 *
 * The shell itself is the page's own module stylesheet plus host primitives:
 * the header's refresh and the failure banner's retry are host `Button`s, the
 * descendant count is mono micro-type, and the canvas / tree / board / drawer
 * own their own chrome.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import {
  Button, IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Context,
  SidebarClientJobsService,
  SidebarObservedJob,
  SidebarChildLiveView,
  SidebarSessionList,
  SidebarSubagentAddress,
} from '../context-types.ts'
import {
  countSubagentDescendants,
  isSideThreadSummary,
  rootAncestor,
} from './subagent-detect.ts'
import { subagentCatalogs } from './subagent-catalog.ts'
import { sessionMetrics } from './session-metrics.ts'
import { hasTranscriptAside, openTranscriptAside } from './subagent-chat.ts'
import { teamMembersOf, teamProjectionOf } from './team-projection.ts'
import { treeSessionIds } from './subagent-lineage.ts'
import { orderJobs, type TreeJob } from './subagent-jobs.ts'
import { api } from './api.ts'
import { usePolling } from './use-polling.ts'
import { useNarrowViewport } from './breakpoints.ts'
import {
  clientJobs, collectRows, useJobObservation, useJobWatchers, useJobsSnapshot,
} from './jobs-client.ts'
import { t } from './locales.ts'
import { diagnosticAddressOf } from './context-diagnostics-ui.tsx'
import type { ContextDiagnosticTarget } from './context-diagnostics.ts'
import { buildTasksModel, type TasksAgentNode, type TasksFoldNode, type TasksWorkflowNode } from './tasks-model.ts'
import { TasksGraph } from './TasksGraph.tsx'
import { TasksTree } from './TasksTree.tsx'
import { JobsDrawer, JobOutputWindow } from './JobsDrawer.tsx'
import { AnchoredPopover } from './AnchoredPopover.tsx'
import { AgentNodePopover, WorkflowNodePopover } from './TasksPopovers.tsx'
import { TeamBoard } from './TeamBoard.tsx'
import { TaskWindow } from './TaskWindow.tsx'
import type { SidebarStore } from './state.ts'
import type { WorkflowRunView } from '../workflow-runs.ts'
import type { ProcessActivitySummary } from '../process-activity.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../prefs-shared.ts'
import legacy from './SubagentView.module.css'

/** Poll cadence of the live "last text + tool call" lines while a child runs. */
const POLL_MS = 3000
/** Poll cadence of the workflow-run and team views while the page is visible. */
const TELEMETRY_POLL_MS = 5000

/** The empty live map / run list: ONE identity, so a reset that changes
 *  nothing (or a poll that returns nothing) never re-renders the page. */
const NO_LIVE: Readonly<Record<string, SidebarChildLiveView>> = {}
const NO_RUNS: readonly WorkflowRunView[] = []

/**
 * Whether two activity summaries say the same thing. Every field the cards
 * read is compared — the activity line (`running`, `preparing`,
 * `runningDetail`) and the settled tally (`counts`) — and nothing else, so a
 * re-serialized but equal summary is not a change.
 */
function sameSummary(left: ProcessActivitySummary | undefined, right: ProcessActivitySummary | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.running !== right.running || left.preparing !== right.preparing
    || left.runningDetail !== right.runningDetail || left.counts.length !== right.counts.length) return false
  return left.counts.every((entry, index) => {
    const other = right.counts[index]!
    return entry.kind === other.kind && entry.count === other.count
  })
}

/** Whether two children's live views say the same thing (see the card render
 *  sites for the fields: the running flag, the detail text, the summary). */
function sameLiveView(left: SidebarChildLiveView | undefined, right: SidebarChildLiveView | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.running === right.running && left.text === right.text
    && left.lastEventTime === right.lastEventTime && sameSummary(left.summary, right.summary)
}

/**
 * Whether two `subagents.live` answers are the same map. The route answers with
 * a FRESH object graph on every tick; publishing it unconditionally re-derived
 * the whole agent tree and the graph layout every 3 s although nothing had
 * changed.
 */
function sameLive(
  left: Readonly<Record<string, SidebarChildLiveView>>,
  right: Readonly<Record<string, SidebarChildLiveView>>,
): boolean {
  if (left === right) return true
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameLiveView(left[key], right[key]))
}

/** Whether two workflow-run answers are the same list (runs → phases →
 *  members, field by field). */
function sameRuns(left: readonly WorkflowRunView[], right: readonly WorkflowRunView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((run, index) => {
    const other = right[index]!
    if (run.runId !== other.runId || run.name !== other.name
      || run.originSessionId !== other.originSessionId || run.status !== other.status
      || run.stopReason !== other.stopReason || run.startedSeq !== other.startedSeq
      || run.startedAt !== other.startedAt || run.finishedAt !== other.finishedAt
      || run.phases.length !== other.phases.length) return false
    return run.phases.every((phase, phaseIndex) => {
      const peer = other.phases[phaseIndex]!
      if (phase.title !== peer.title || phase.members.length !== peer.members.length) return false
      return phase.members.every((member, memberIndex) => {
        const mate = peer.members[memberIndex]!
        return member.seq === mate.seq && member.label === mate.label && member.phase === mate.phase
          && member.childId === mate.childId && member.outcome === mate.outcome
      })
    })
  })
}

/**
 * The workspace face's "show this conversation" verb. DSH moved child and
 * session navigation off `ISessions` onto the service that owns the
 * main-view selection, so the mirror is declared here rather than widened in
 * `context-types.ts` (the optional old names stay as the fallback).
 */
interface ConversationNavigation {
  openSession?(target: SidebarSubagentAddress | string): void
}

/** The per-parent catalog refresh across the two DSH generations. */
interface CatalogRefreshFace {
  refreshProjections?(sessionId: string): Promise<void>
  refreshSubagents?(sessionId: string): Promise<void>
}

/**
 * One shared live-preview poller for the whole tree. At most ONE
 * `subagents.live` request in flight (self-scheduling); a response settling
 * after the poller stopped is dropped via the aborted signal.
 */
function useSubagentLive(
  rootId: string | undefined,
  active: boolean,
): Readonly<Record<string, SidebarChildLiveView>> {
  const [live, setLive] = useState<Readonly<Record<string, SidebarChildLiveView>>>(NO_LIVE)
  /**
   * What has been PUBLISHED. An equal answer must not reach React at all: even
   * handing `setLive` an updater that returns the previous state lets React
   * render the component once ("React may still need to render that specific
   * component again before bailing out"), and one render re-derives the whole
   * tasks model and the graph layout hanging off it.
   */
  const published = useRef<Readonly<Record<string, SidebarChildLiveView>>>(NO_LIVE)

  // A new tree must never inherit another root's live previews.
  useEffect(() => {
    published.current = NO_LIVE
    setLive(current => (Object.keys(current).length === 0 ? current : NO_LIVE))
  }, [rootId])

  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (rootId === undefined) return
    const result = await api.subagentsLive(rootId, signal)
    if (signal.aborted) return
    // The route answers with FRESH objects every tick; publishing them as-is
    // re-derived the agent tree (and the graph layout) every 3 s although
    // nothing had changed.
    if (sameLive(published.current, result.live)) return
    published.current = result.live
    setLive(current => (sameLive(current, result.live) ? current : result.live))
  }, [rootId])
  usePolling(rootId !== undefined && active, poll, {
    intervalMs: POLL_MS,
    mode: 'self-scheduling',
    immediate: true,
  })

  return live
}

/** The folded workflow runs of the tree (poll-driven; empty when none). */
function useWorkflowRuns(rootId: string | undefined, active: boolean): readonly WorkflowRunView[] {
  const [runs, setRuns] = useState<readonly WorkflowRunView[]>(NO_RUNS)
  const published = useRef<readonly WorkflowRunView[]>(NO_RUNS)
  useEffect(() => {
    published.current = NO_RUNS
    setRuns(current => (current.length === 0 ? current : NO_RUNS))
  }, [rootId])
  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (rootId === undefined) return
    const result = await api.workflowsList(rootId, signal)
    if (signal.aborted) return
    // Same identity rule as the live map: the run list is a model dependency,
    // so an equal answer (the common case — a run's phases only move when an
    // event commits) must publish nothing.
    if (sameRuns(published.current, result.runs)) return
    published.current = result.runs
    setRuns(current => (sameRuns(current, result.runs) ? current : result.runs))
  }, [rootId])
  usePolling(rootId !== undefined && active, poll, {
    intervalMs: TELEMETRY_POLL_MS,
    mode: 'self-scheduling',
    immediate: true,
  })
  return runs
}

/**
 * The tree's background jobs, read through the HOST's client jobs service
 * (`ctx.jobs` — see jobs-client.ts). Watching is per tree session (the host
 * shares one stream between watchers) and only while the page is on screen;
 * a deployment without the service renders no jobs surface at all.
 */
function useTreeJobs(
  ctx: Context,
  byId: SidebarSessionList['byId'],
  rootId: string | undefined,
  active: boolean,
): {
  rows: TreeJob[]
  jobs: SidebarClientJobsService | undefined
  /** The observed output per job id (the panel picks its own entry). */
  observed: Readonly<Record<string, SidebarObservedJob | undefined>>
} {
  const jobs = useMemo(() => clientJobs(ctx), [ctx])
  const snapshot = useJobsSnapshot(jobs)
  const treeIds = useMemo(
    () => (rootId === undefined ? [] : [...treeSessionIds(byId, rootId)]),
    [byId, rootId],
  )
  useJobWatchers(jobs, treeIds, active)
  const rows = useMemo(
    () => (rootId === undefined ? [] : orderJobs(collectRows(snapshot, byId, new Set(treeIds)))),
    [snapshot, byId, rootId, treeIds],
  )
  return { rows, jobs, observed: snapshot.observed }
}

/** The open popover of the page (one at a time, anchored). */
type PagePopover =
  | { kind: 'node'; nodeId: string; anchor: HTMLElement }
  | { kind: 'workflow'; nodeId: string; anchor: HTMLElement }
  | { kind: 'job'; jobId: string; anchor: HTMLElement }
  /** The shared task window; taskId undefined = create mode. */
  | { kind: 'task'; taskId: string | undefined; anchor: HTMLElement }

/**
 * The sidebar's Tasks page.
 * @param props - current session id, visibility, the client context, the
 *   shared store (the prefs drive the default view mode), and the optional
 *   jump-notify hook fired right before `openSubagent`.
 */
export function SubagentView(props: {
  sessionId: string
  active: boolean
  ctx: Context
  store?: SidebarStore
  onOpenChild?: (address: SidebarSubagentAddress) => void
}): ReactNode {
  const { sessionId, active, ctx, store, onOpenChild } = props
  const sessions = ctx.sessions

  // The same list feed the official catalog consumes. DSH 0.1.7 publishes the
  // host-computed `subagentCatalog` projection per session and loads every
  // session's projections once per connection, so there is no observe/refresh
  // handshake left to run — the page is a pure reader of the snapshot. A host
  // without the projection store leaves these surfaces empty and the page
  // degrades to its empty state.
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
    useCallback(() => sessions.list.getSnapshot(), [sessions]),
  )
  const byId = list.byId
  // The projected per-parent catalogs, already folded into the view shape the
  // topology consumes (see subagent-catalog.ts).
  const catalogs = useMemo(() => subagentCatalogs(list.projectionsBySession), [list.projectionsBySession])
  // Token usage and turn timing ride the same snapshot: the popover's two
  // extra facts are read here, not fetched (see ./session-metrics.ts).
  const metrics = useMemo(() => sessionMetrics(list.projectionsBySession), [list.projectionsBySession])

  // The topology root: the main agent of the current session's tree.
  const rootId = useMemo(() => rootAncestor(byId, sessionId), [byId, sessionId])
  const rootSummary = rootId === undefined ? undefined : byId[rootId]
  const live = useSubagentLive(rootId, active)
  const runs = useWorkflowRuns(rootId, active)
  // The root-led team, straight off the SAME snapshot the catalogs come from
  // (see team-projection.ts): undefined = no team here (no experimental layer,
  // or the root is not a Lead), which is exactly the "hide the strip" state.
  const team = useMemo(
    () => teamProjectionOf(list.projectionsBySession, rootId),
    [list.projectionsBySession, rootId],
  )
  const teamMembers = useMemo(
    () => teamMembersOf(team, live, byId),
    [team, live, byId],
  )

  // The default view mode comes from the side card prefs (settings select);
  // the in-page toggle overrides it ephemerally. On a NARROW viewport the
  // `mobileDefaultTree` preference swaps that default to the classic tree —
  // only the default: the toggle below still flips this session's page.
  const narrow = useNarrowViewport()
  // getPrefs() returns a copy; the snapshot's prefs keep their identity until
  // setPrefs(), so unrelated sidebar updates do not re-render this page.
  const prefs = useSyncExternalStore(
    useMemo(() => (callback: () => void) => store?.subscribe(callback) ?? (() => {}), [store]),
    useCallback(() => store?.getSnapshot().prefs ?? SIDEBAR_PREFS_DEFAULTS, [store]),
  )
  const prefsMode = narrow && prefs.mobileDefaultTree ? 'tree' : prefs.tasksViewMode
  const [modeOverride, setModeOverride] = useState<'graph' | 'tree' | undefined>(undefined)
  const mode = modeOverride ?? prefsMode

  const [foldOverride, setFoldOverride] = useState<boolean | undefined>(undefined)
  const autoFoldSettled = foldOverride ?? prefs.tasksAutoFoldSettled
  const autoFoldBranches = foldOverride ?? prefs.tasksAutoFoldBranches
  const autoFoldIdle = foldOverride ?? prefs.tasksAutoFoldIdle
  const folded = autoFoldSettled || autoFoldBranches || autoFoldIdle
  /**
   * Nodes the reader folded by hand from their own card bar. Kept apart from
   * `folded` (the global rule) so the control cluster and a single card never
   * fight.
   */
  const [foldedIds, setFoldedIds] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * The fold GROUPS the reader opened by clicking one aggregate card. Expanding
   * an aggregate reveals that group ONLY — it used to clear the manual folds and
   * switch the global rule off, so one click unfolded the whole page. The
   * control cluster keeps the page-level expand/collapse; collapsing there drops
   * these per-group openings (a global collapse must really collapse).
   */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [teamBoardCollapsed, setTeamBoardCollapsed] = useState(false)
  /**
   * Tree-mode SUBTREE disclosure: rows whose children the reader folded away.
   * Kept here (not inside TasksTree) so switching modes and coming back keeps
   * the shape the reader left, and cleared by 全部展开.
   */
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [popover, setPopover] = useState<PagePopover | null>(null)

  const model = useMemo(
    () => (rootId === undefined
      ? []
      : buildTasksModel({
        byId,
        catalogs,
        rootId,
        currentSessionId: sessionId,
        live,
        metrics,
        runs,
        teamMembers,
        teamTasks: team?.tasks ?? [],
        folded,
        autoFoldSettled,
        autoFoldBranches,
        autoFoldIdle,
        foldedIds,
        expandedGroups,
      })),
    [byId, catalogs, rootId, sessionId, live, metrics, runs, teamMembers, team, folded,
      autoFoldSettled, autoFoldBranches, autoFoldIdle, foldedIds, expandedGroups],
  )

  /**
   * The tree's agent nodes by their session id — the ONLY sanctioned source of
   * a job's diagnostics target. A jobs row is a roster entry under a WATCHED
   * session (`row.ownerSessionId`) whose real owner is `job.owner`; a roster
   * payload without an owner is announced under the watching session, which is
   * not necessarily the session that owns the job. Resolving through the model
   * therefore answers both halves at once: whether the owning session is in
   * this tree at all, and what that node's address is (the root node has none
   * — it IS the tree's main session — and must be addressed by its own id).
   */
  const agentNodeBySession = useMemo((): ReadonlyMap<string, TasksAgentNode> => {
    const nodes = new Map<string, TasksAgentNode>()
    for (const node of model) if (node.kind === 'agent') nodes.set(node.id, node)
    return nodes
  }, [model])

  /**
   * The diagnostics target of one conversation, when this tree holds its node.
   * The label is the NODE's own — the card's durable label, resolved by the
   * model — never a caller's title: a jobs row only knows the watched
   * session's display title, which is not the owning agent's name.
   */
  const diagnosticsTargetOf = useCallback((ownerId: string): ContextDiagnosticTarget | undefined => {
    const node = agentNodeBySession.get(ownerId)
    if (node === undefined) return undefined
    const address = diagnosticAddressOf(node.id, node.childAddress)
    if (node.parentId !== undefined && address === undefined) return undefined
    return { sessionId: node.id, label: node.label, ...(address === undefined ? {} : { address }) }
  }, [agentNodeBySession])

  /**
   * Show one conversation in the main view. DSH moved child and session
   * navigation OFF `ISessions` (0.1.6's `open` / `openSubagent` are gone from
   * the runtime, and the optional calls this page used were silently dead)
   * onto the workspace face, which owns the main-view selection. The old
   * names stay as the fallback for a host that predates the move.
   */
  const openConversation = useCallback((target: SidebarSubagentAddress | string): void => {
    const workspace = ctx.get('uiWorkspace') as unknown as ConversationNavigation | undefined
    if (typeof workspace?.openSession === 'function') {
      workspace.openSession(target)
      return
    }
    if (typeof target === 'string') sessions.open?.(target)
    else sessions.openSubagent?.(target)
  }, [ctx, sessions])

  /**
   * Show one child session. `'side'` (the default) hands the transcript to the
   * host's OWN right-sidebar tab and leaves the main column alone — that is the
   * native affordance the host's subagent list uses, and it is skipped when the
   * deployment cannot host it (no `subagentchat` type, no right column, or no
   * mounted seat). `'main'` is the old behavior: the shell re-roots the Tasks
   * page on the child and the main view follows.
   */
  const openChild = useCallback((address: SidebarSubagentAddress, place: 'side' | 'main' = 'side'): void => {
    if (place === 'side' && openTranscriptAside(ctx, address)) return
    // Notify the shell first: the jump switches the sidebar to the child
    // session's own layout, and the shell re-opens the Tasks page on top
    // of it (the topology stays rooted at the main agent with the child
    // highlighted) — the README "page stays open" contract.
    onOpenChild?.(address)
    try {
      openConversation(address)
    } catch (error) {
      console.error('[dsh-better-sidebar] open subagent failed:', error)
    }
  }, [ctx, openConversation, onOpenChild])

  /** Jump back to the main agent (the topology root) from its node. */
  const openMain = useCallback((): void => {
    if (rootId === undefined) return
    try {
      openConversation(rootId)
    } catch (error) {
      console.error('[dsh-better-sidebar] open session failed:', error)
    }
  }, [openConversation, rootId])

  const refresh = useCallback((parentSessionId: string): void => {
    // 0.1.7 renamed the per-parent catalog refresh to `refreshProjections`
    // (the projection store owns every session's values now); calling the
    // removed 0.1.6 name alone would make this button a silent no-op.
    const face = sessions as CatalogRefreshFace
    void (face.refreshProjections ?? face.refreshSubagents)?.(parentSessionId)
  }, [sessions])

  /** Jump from the detail window into the node's transcript. */
  const jumpToNode = useCallback((node: TasksAgentNode, place: 'side' | 'main' = 'side'): void => {
    if (node.childAddress !== undefined) {
      openChild(node.childAddress, place)
      setPopover(null)
      return
    }
    if (node.parentId === undefined) {
      openMain()
      setPopover(null)
    }
  }, [openChild, openMain])

  /**
   * Whether this deployment can host a child transcript in its right column.
   * Read once per ctx (the services arrive with the profile, not later), and it
   * drives whether the detail window offers the choice at all.
   */
  const asideAvailable = useMemo(() => hasTranscriptAside(ctx), [ctx])

  /** One tree row's disclosure: show or hide that node's own subtree. */
  const toggleCollapse = useCallback((nodeId: string): void => {
    setCollapsedIds(current => {
      const next = new Set(current)
      if (!next.delete(nodeId)) next.add(nodeId)
      return next
    })
  }, [])

  /** 全部收起: every node that HAS children, so only the roots stay visible. */
  const collapseAllTree = useCallback((): void => {
    const parents = new Set<string>()
    for (const node of model) if (node.parentId !== undefined) parents.add(node.parentId)
    setCollapsedIds(current => (current.size === parents.size && [...parents].every(id => current.has(id))
      ? current
      : parents))
  }, [model])

  /** 全部展开: forget every subtree fold. */
  const expandAllTree = useCallback((): void => {
    setCollapsedIds(current => (current.size === 0 ? current : new Set()))
  }, [])

  /** Fold one settled node into its parent's aggregate (its card's chevron). */
  const foldNode = useCallback((node: TasksAgentNode): void => {
    setFoldedIds(current => {
      const next = new Set(current)
      next.add(node.id)
      return next
    })
  }, [])

  /**
   * Expand ONE aggregate: the group the reader clicked shows its members while
   * every other group stays folded. The members it held are also released from
   * the manual per-node set — clicking an aggregate means "show me these nodes
   * now", and a hand-folded member left in `foldedIds` would stay hidden inside
   * a group the reader just opened.
   */
  const expandGroup = useCallback((node: TasksFoldNode): void => {
    setExpandedGroups(current => {
      if (current.has(node.id)) return current
      const next = new Set(current)
      next.add(node.id)
      return next
    })
    setFoldedIds(current => {
      if (!node.memberIds.some(id => current.has(id))) return current
      const next = new Set(current)
      for (const id of node.memberIds) next.delete(id)
      return next
    })
  }, [])

  /**
   * The control cluster's page-level switch. COLLAPSING there re-folds every
   * group, so the per-group openings are dropped with it; expanding leaves them
   * (an unfolded page already shows everything they would reveal).
   */
  const toggleFold = useCallback((): void => {
    if (!folded) setExpandedGroups(current => (current.size === 0 ? current : new Set()))
    setFoldOverride(!folded)
  }, [folded])

  /** Open the shared task window from a board row (undefined = create). */
  const openTaskFromBoard = useCallback((
    task: { id: string } | undefined,
    anchor: HTMLElement,
  ): void => {
    setPopover({ kind: 'task', taskId: task?.id, anchor })
  }, [])

  /** Open the shared task window by id (node task lines, detail lists). */
  const openTaskById = useCallback((taskId: string, anchor: HTMLElement): void => {
    setPopover({ kind: 'task', taskId, anchor })
  }, [])

  const totals = useMemo(
    () => rootId === undefined
      ? { count: 0, runningCount: 0 }
      : countSubagentDescendants(byId, rootId),
    [byId, rootId],
  )
  const agentCount = totals.count + 1

  /** The tree's ordered job rows (owner-labeled, off the host's push roster). */
  const treeJobs = useTreeJobs(ctx, byId, rootId, active)
  const jobRows = treeJobs.rows
  // Only the open panel's job is observed: the host streams output per observer.
  const openJob = popover?.kind === 'job'
    ? jobRows.find(row => row.job.id === popover.jobId)
    : undefined
  useJobObservation(treeJobs.jobs, openJob?.ownerSessionId, openJob?.job.id)
  const observedJob = openJob === undefined ? undefined : treeJobs.observed[openJob.job.id]

  /** Catalogs that failed to load (surfaced as one banner in both modes). */
  const failedParents = useMemo(
    () => Object.entries(catalogs)
      .filter(([, catalog]) => catalog?.state === 'error')
      .map(([parent]) => parent),
    [catalogs],
  )

  // Session summaries can announce membership before the descriptor-backed
  // catalog catches up (or a catalog that just went ready is still empty).
  const summaryBackedLoading = rootId !== undefined
    && (catalogs[rootId] === undefined
      || (catalogs[rootId]?.state === 'ready' && catalogs[rootId]?.entries.length === 0))
    && Object.values(byId).some(
      summary => summary.origin === 'subagent' && summary.parentId === rootId
        && !isSideThreadSummary(summary),
    )
  const readyEmpty = rootId !== undefined
    && catalogs[rootId]?.state === 'ready'
    && catalogs[rootId]?.entries.length === 0
    && runs.length === 0
    && teamMembers.length === 0
    && !Object.values(byId).some(
      summary => summary.origin === 'subagent' && summary.parentId === rootId
        && !isSideThreadSummary(summary),
    )

  const countLabel = totals.count === 0
    ? undefined
    : totals.runningCount > 0
      ? t('subagentCountRunning', { count: totals.count, running: totals.runningCount })
      : t('subagentCount', { count: totals.count })

  const closePopover = useCallback((): void => { setPopover(null) }, [])

  // A popover whose subject left the model (a settled job dropped from the
  // mirror, a tree switch) closes itself.
  useEffect(() => {
    if (popover === null) return
    if (popover.kind === 'job' && !jobRows.some(row => row.job.id === popover.jobId)) setPopover(null)
    if (popover.kind === 'node' && !model.some(node => node.id === popover.nodeId)) setPopover(null)
    if (popover.kind === 'workflow' && !model.some(node => node.id === popover.nodeId)) setPopover(null)
  }, [popover, jobRows, model])

  /** The current popover's resolved content (subjects re-resolve live). */
  const popoverContent = ((): ReactNode => {
    if (popover === null) return null
    if (popover.kind === 'task') {
      if (team === undefined || rootId === undefined) return null
      const task = popover.taskId === undefined
        ? undefined
        : team.tasks.find(candidate => candidate.id === popover.taskId)
      // A task that vanished (deleted elsewhere) closes the window instead of
      // showing a stale card.
      if (popover.taskId !== undefined && task === undefined) return null
      return (
        <TaskWindow
          rootId={rootId}
          task={task}
          members={teamMembers}
          ctx={ctx}
          onClose={closePopover}
          anchor={popover.anchor}
        />
      )
    }
    if (popover.kind === 'job') {
      const row = jobRows.find(candidate => candidate.job.id === popover.jobId)
      if (row === undefined) return null
      return (
        <JobOutputWindow
          jobs={treeJobs.jobs}
          ownerSessionId={row.ownerSessionId}
          job={row.job}
          observed={treeJobs.observed[row.job.id]}
          anchor={popover.anchor}
          onClose={closePopover}
          diagnostics={row.job.owner === undefined ? undefined : diagnosticsTargetOf(row.job.owner)}
        />
      )
    }
    const node = model.find(candidate => candidate.id === popover.nodeId)
    if (node === undefined) return null
    if (popover.kind === 'workflow' && node.kind === 'workflow') {
      return (
        <WorkflowNodePopover
          node={node as TasksWorkflowNode}
          onJumpMember={(address) => { openChild(address); setPopover(null) }}
        />
      )
    }
    if (popover.kind === 'node' && node.kind === 'agent') {
      return (
        <AgentNodePopover
          node={node}
          asideAvailable={asideAvailable}
          onJump={jumpToNode}
          onOpenTask={openTaskById}
          onClose={closePopover}
        />
      )
    }
    return null
  })()

  return (
    <div className={legacy.subagent} style={{ position: 'relative' }}>
      <div className={legacy.subagentHeader}>
        <span className={legacy.subagentHeading}>
          <span className={legacy.subagentTitle}>{t('subagent')}</span>
          {rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== '' && (
            <>
              <span className={legacy.subagentSep} aria-hidden="true">·</span>
              {/*
                The session the tree is rooted at: the header's subject, not the
                page name. It yields first when the row runs out of room, and
                carries the full title as a tooltip so a clipped one stays readable.
              */}
              <span className={legacy.subagentSubject} title={rootSummary.displayTitle}>
                {rootSummary.displayTitle}
              </span>
            </>
          )}
        </span>
        {countLabel !== undefined && <span className={legacy.subagentCount}>{countLabel}</span>}
        {/*
          The refresh control is the host ghost Button (28px) and carries the
          plugin's control chrome; the module class only keeps it from being
          squeezed by a long session title. Plain `title` rather than the host
          Tooltip: the Tooltip anchors by ref and the host Button forwards none.
        */}
        <Button
          variant="ghost"
          size="sm"
          className={legacy.subagentRefresh}
          icon={<IconRefreshOutlineRegular size={14} />}
          aria-label={t('refresh')}
          title={t('refresh')}
          disabled={rootId === undefined}
          onClick={() => {
            if (rootId !== undefined) refresh(rootId)
          }}
        />
      </div>
      {rootId !== undefined && team !== undefined && (
        <TeamBoard
          rootId={rootId}
          members={teamMembers}
          tasks={team.tasks}
          onOpenTask={openTaskFromBoard}
          collapsed={teamBoardCollapsed}
          onToggleCollapsed={() => { setTeamBoardCollapsed(current => !current) }}
        />
      )}
      {failedParents.length > 0 && (
        <div className={legacy.subagentError}>
          <span>{t('catalogLoadFailed', { count: failedParents.length })}</span>
          {/* Host outline Button (28px); the module class keeps the retry from
              being squeezed by the banner's message. */}
          <Button
            variant="outline"
            size="sm"
            className={legacy.subagentErrorRetry}
            icon={<IconRefreshOutlineRegular size={14} />}
            onClick={() => { for (const parent of failedParents) refresh(parent) }}
          >
            {t('retry')}
          </Button>
        </div>
      )}
      {readyEmpty && (
        <div className={legacy.subagentEmpty}>
          <div>{t('subagentEmpty')}</div>
          <div className={legacy.subagentEmptyHint}>{t('subagentEmptyDesc')}</div>
        </div>
      )}
      {!readyEmpty && rootId !== undefined && (
        mode === 'graph'
          ? (
            <TasksGraph
              nodes={model}
              folded={folded}
              rootId={rootId}
              loading={summaryBackedLoading}
              onNodeInfo={(node, anchor) => { setPopover({ kind: 'node', nodeId: node.id, anchor }) }}
              onWorkflowInfo={(node, anchor) => { setPopover({ kind: 'workflow', nodeId: node.id, anchor }) }}
              onOpenTask={openTaskById}
              onToggleFold={toggleFold}
              onExpandGroup={expandGroup}
              onFoldNode={foldNode}
              mode={mode}
              onModeChange={setModeOverride}
            />
          )
          : (
            <TasksTree
              nodes={model}
              folded={folded}
              collapsedIds={collapsedIds}
              onToggleCollapse={toggleCollapse}
              onCollapseAll={collapseAllTree}
              onExpandAll={expandAllTree}
              loading={summaryBackedLoading}
              onNodeInfo={(node, anchor) => { setPopover({ kind: 'node', nodeId: node.id, anchor }) }}
              onWorkflowInfo={(node, anchor) => { setPopover({ kind: 'workflow', nodeId: node.id, anchor }) }}
              onOpenTask={openTaskById}
              onToggleFold={toggleFold}
              onExpandGroup={expandGroup}
              mode={mode}
              onModeChange={setModeOverride}
            />
          )
      )}
      <JobsDrawer
        rows={jobRows}
        agentCount={agentCount}
        autoCollapse={prefs.jobsAutoCollapse}
        jobs={treeJobs.jobs}
        observed={observedJob}
        openJobId={popover?.kind === 'job' ? popover.jobId : undefined}
        // The page's own visibility, exactly as the pollers read it: a parked
        // Tasks tab keeps the drawer's rows (they are already rendered) but
        // runs no per-second clock.
        visible={active}
        onOpenOutput={(row, anchor) => {
          setPopover(popover?.kind === 'job' && popover.jobId === row.job.id
            ? null
            : { kind: 'job', jobId: row.job.id, anchor })
        }}
      />
      {/*
        Two surfaces, two lifecycles: the job output is a PERSISTENT window
        (its own frame, closed by its button/Escape only), while node and
        workflow details stay anchored popovers on the 280px card.
      */}
      {popover?.kind === 'job'
        ? popoverContent
        : popover?.kind === 'task'
          ? popoverContent
          : (
            <AnchoredPopover anchor={popover?.anchor ?? null} onClose={closePopover} width={280}>
              {popoverContent}
            </AnchoredPopover>
          )}
    </div>
  )
}
