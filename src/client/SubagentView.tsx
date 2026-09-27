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
 * aggregate node per parent (click it or the control-cluster toggle to
 * expand/collapse).
 *
 * The shell itself is the page's own module stylesheet plus host primitives:
 * the header's refresh and the failure banner's retry are host `Button`s, the
 * descendant count is mono micro-type, and the canvas / tree / board / drawer
 * own their own chrome.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
import { buildTasksModel, type TasksAgentNode, type TasksWorkflowNode } from './tasks-model.ts'
import { TasksGraph } from './TasksGraph.tsx'
import { TasksTree } from './TasksTree.tsx'
import { JobsDrawer, JobOutputWindow } from './JobsDrawer.tsx'
import { AnchoredPopover } from './AnchoredPopover.tsx'
import { AgentNodePopover, WorkflowNodePopover } from './TasksPopovers.tsx'
import { TeamBoard } from './TeamBoard.tsx'
import { TaskWindow } from './TaskWindow.tsx'
import type { SidebarStore } from './state.ts'
import type { WorkflowRunView } from '../workflow-runs.ts'
import legacy from './SubagentView.module.css'

/** Poll cadence of the live "last text + tool call" lines while a child runs. */
const POLL_MS = 3000
/** Poll cadence of the workflow-run and team views while the page is visible. */
const TELEMETRY_POLL_MS = 5000

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
  const [live, setLive] = useState<Record<string, SidebarChildLiveView>>({})

  // A new tree must never inherit another root's live previews.
  useEffect(() => { setLive({}) }, [rootId])

  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (rootId === undefined) return
    const result = await api.subagentsLive(rootId, signal)
    if (!signal.aborted) setLive(result.live)
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
  const [runs, setRuns] = useState<readonly WorkflowRunView[]>([])
  useEffect(() => { setRuns([]) }, [rootId])
  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (rootId === undefined) return
    const result = await api.workflowsList(rootId, signal)
    if (!signal.aborted) setRuns(result.runs)
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
  const prefsMode = useSyncExternalStore(
    useMemo(() => (callback: () => void) => store?.subscribe(callback) ?? (() => {}), [store]),
    useCallback((): 'graph' | 'tree' => {
      const prefs = store?.getPrefs()
      if (narrow && prefs?.mobileDefaultTree === true) return 'tree'
      return prefs?.tasksViewMode ?? 'graph'
    }, [store, narrow]),
  )
  const [modeOverride, setModeOverride] = useState<'graph' | 'tree' | undefined>(undefined)
  const mode = modeOverride ?? prefsMode

  const [folded, setFolded] = useState(true)
  /**
   * Nodes the reader folded by hand from their own card bar. Kept apart from
   * `folded` (the global rule) so the control cluster and a single card never
   * fight: the aggregate's click clears BOTH, which is what "expand" means.
   */
  const [foldedIds, setFoldedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [teamBoardCollapsed, setTeamBoardCollapsed] = useState(false)
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
        runs,
        teamMembers,
        teamTasks: team?.tasks ?? [],
        folded,
        foldedIds,
      })),
    [byId, catalogs, rootId, sessionId, live, runs, teamMembers, team, folded, foldedIds],
  )

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

  const openChild = useCallback((address: SidebarSubagentAddress): void => {
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
  }, [openConversation, onOpenChild])

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
  const jumpToNode = useCallback((node: TasksAgentNode): void => {
    if (node.childAddress !== undefined) {
      openChild(node.childAddress)
      setPopover(null)
      return
    }
    if (node.parentId === undefined) {
      openMain()
      setPopover(null)
    }
  }, [openChild, openMain])

  /** Fold one settled node into its parent's aggregate (its card's chevron). */
  const foldNode = useCallback((node: TasksAgentNode): void => {
    setFoldedIds(current => {
      const next = new Set(current)
      next.add(node.id)
      return next
    })
  }, [])

  /** Expand every fold: the global rule off AND the manual folds cleared. */
  const expandFold = useCallback((): void => {
    setFolded(false)
    setFoldedIds(current => (current.size === 0 ? current : new Set()))
  }, [])

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
          onJump={jumpToNode}
          onOpenTask={openTaskById}
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
              onToggleFold={() => { setFolded(current => !current) }}
              onExpandFold={expandFold}
              onFoldNode={foldNode}
              mode={mode}
              onModeChange={setModeOverride}
            />
          )
          : (
            <TasksTree
              nodes={model}
              folded={folded}
              loading={summaryBackedLoading}
              onNodeInfo={(node, anchor) => { setPopover({ kind: 'node', nodeId: node.id, anchor }) }}
              onWorkflowInfo={(node, anchor) => { setPopover({ kind: 'workflow', nodeId: node.id, anchor }) }}
              onOpenTask={openTaskById}
              onToggleFold={() => { setFolded(current => !current) }}
              mode={mode}
              onModeChange={setModeOverride}
            />
          )
      )}
      <JobsDrawer
        rows={jobRows}
        agentCount={agentCount}
        jobs={treeJobs.jobs}
        observed={observedJob}
        openJobId={popover?.kind === 'job' ? popover.jobId : undefined}
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
