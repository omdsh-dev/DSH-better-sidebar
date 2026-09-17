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
 * - AGENT TEAMS (experimental host layer): when the root leads a team, the
 *   roster enriches matching nodes and a header chip opens the shared task
 *   board popover (CAS operations); without the layer the UI hides itself
 *   entirely;
 * - BACKGROUND JOBS: a bottom drawer replaces the old in-page section and
 *   auto-collapses once the tree has many agents; job output opens as an
 *   anchored popover (event replay — never the model's cursor).
 *
 * Node click jumps straight into the transcript (root → main session); the
 * ⓘ button opens the detail popover. Completed leaf agents fold into one
 * aggregate node per parent (click it or the control-cluster toggle to
 * expand/collapse).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import {
  IconAgentPresetOutline16, IconRefreshOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Context,
  SidebarSubagentAddress,
} from '../context-types.ts'
import {
  collectBranchIds,
  countSubagentDescendants,
  isSideThreadSummary,
  rootAncestor,
} from './subagent-detect.ts'
import { type LastActivity } from '../subagent-activity.ts'
import { collectTreeJobs, orderJobs } from './subagent-jobs.ts'
import { api, type TeamsViewResult } from './api.ts'
import { usePolling } from './use-polling.ts'
import { t } from './locales.ts'
import { buildTasksModel, type TasksAgentNode, type TasksWorkflowNode } from './tasks-model.ts'
import { TasksGraph } from './TasksGraph.tsx'
import { TasksTree } from './TasksTree.tsx'
import { JobsDrawer, JobOutputPopoverContent } from './JobsDrawer.tsx'
import { AnchoredPopover } from './AnchoredPopover.tsx'
import { AgentNodePopover, WorkflowNodePopover } from './TasksPopovers.tsx'
import { TeamBoard } from './TeamBoard.tsx'
import { TaskPopover } from './TaskWindow.tsx'
import type { SidebarStore } from './state.ts'
import type { WorkflowRunView } from '../workflow-runs.ts'
import { Button as UiButton } from './ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx'
import legacy from './SubagentView.module.css'

/** Refresh cadence of the live "last text + tool call" lines while a child runs. */
const POLL_MS = 3000
/** Poll cadence of the workflow-run and team views while the page is visible. */
const TELEMETRY_POLL_MS = 5000

/**
 * One shared live-preview poller for the whole tree. At most ONE
 * `subagents.live` request in flight (self-scheduling); a response settling
 * after the poller stopped is dropped via the aborted signal.
 */
function useSubagentLive(
  rootId: string | undefined,
  active: boolean,
): Readonly<Record<string, LastActivity>> {
  const [live, setLive] = useState<Record<string, LastActivity>>({})

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

/** The team view of the tree's root (poll-driven, structurally degraded). */
function useTeamView(
  rootId: string | undefined,
  active: boolean,
): { view: TeamsViewResult | undefined; refresh(): void } {
  const [view, setView] = useState<TeamsViewResult | undefined>(undefined)
  const [epoch, setEpoch] = useState(0)
  useEffect(() => { setView(undefined) }, [rootId])
  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (rootId === undefined) return
    const result = await api.teamsView(rootId, signal)
    if (!signal.aborted) setView(result)
    // `epoch` is the manual-refresh trigger: bumping it changes the task
    // identity, which restarts the poller with an immediate tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, epoch])
  usePolling(rootId !== undefined && active, poll, {
    intervalMs: TELEMETRY_POLL_MS,
    mode: 'self-scheduling',
    immediate: true,
  })
  const refresh = useCallback((): void => { setEpoch(current => current + 1) }, [])
  return { view, refresh }
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

  // The same list feed the official catalog consumes (byId lineage + the
  // lazy per-parent catalogs). Older DSH snapshots without the subagent seam
  // simply leave these surfaces empty — the page degrades to the empty state.
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
    useCallback(() => sessions.list.getSnapshot(), [sessions]),
  )
  const byId = list.byId
  // Memoized so the empty-catalog fallback keeps a stable identity — a fresh
  // `{}` per render would invalidate every catalog-dependent memo/effect.
  const catalogs = useMemo(() => list.subagentsByParent ?? {}, [list.subagentsByParent])

  // The topology root: the main agent of the current session's tree.
  const rootId = useMemo(() => rootAncestor(byId, sessionId), [byId, sessionId])
  const rootSummary = rootId === undefined ? undefined : byId[rootId]
  const live = useSubagentLive(rootId, active)
  const runs = useWorkflowRuns(rootId, active)
  const team = useTeamView(rootId, active)
  const teamView = team.view
  const teamMembers = useMemo(
    () => (teamView?.available === true ? teamView.team?.members ?? [] : []),
    [teamView],
  )

  // The default view mode comes from the side card prefs (settings select);
  // the in-page toggle overrides it ephemerally.
  const prefsMode = useSyncExternalStore(
    useMemo(() => (callback: () => void) => store?.subscribe(callback) ?? (() => {}), [store]),
    useCallback(() => store?.getPrefs().tasksViewMode ?? 'graph', [store]),
  )
  const [modeOverride, setModeOverride] = useState<'graph' | 'tree' | undefined>(undefined)
  const mode = modeOverride ?? prefsMode

  const [folded, setFolded] = useState(true)
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
        teamTasks: teamView?.available === true ? teamView.team?.tasks ?? [] : [],
        folded,
      })),
    [byId, catalogs, rootId, sessionId, live, runs, teamMembers, teamView, folded],
  )

  /** Catalog owners currently consuming live membership updates. */
  const observedRef = useRef(new Set<string>())

  const observe = useCallback((parentSessionId: string, open: boolean): void => {
    sessions.setSubagentCatalogOpen?.(parentSessionId, open)
    if (open) observedRef.current.add(parentSessionId)
    else observedRef.current.delete(parentSessionId)
  }, [sessions])

  // While the page is visible the topology root consumes live membership; a
  // root change (switching to another main agent's tree) or the page hiding
  // (tab switched away / panel collapsed) releases everything observed.
  useEffect(() => {
    if (rootId === undefined || !active) return
    observe(rootId, true)
    return () => {
      // The cleanup must release everything observed AT cleanup time (the set
      // mutates as branches open), so reading the ref here is the point.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const parentSessionId of observedRef.current) {
        sessions.setSubagentCatalogOpen?.(parentSessionId, false)
      }
      observedRef.current.clear()
    }
  }, [rootId, active, observe, sessions])

  // Every branch of the always-expanded topology consumes live membership.
  const branches = useMemo(() => collectBranchIds(catalogs, rootId), [catalogs, rootId])
  useEffect(() => {
    if (!active) return
    for (const id of branches) {
      if (!observedRef.current.has(id)) observe(id, true)
    }
  }, [branches, active, observe])

  // Unobserve everything on unmount (the host stops refreshing unused catalogs).
  useEffect(() => () => {
    for (const parentSessionId of observedRef.current) {
      sessions.setSubagentCatalogOpen?.(parentSessionId, false)
    }
    observedRef.current.clear()
  }, [sessions])

  const openChild = useCallback((address: SidebarSubagentAddress): void => {
    // Notify the shell first: the jump switches the sidebar to the child
    // session's own layout, and the shell re-opens the Tasks page on top
    // of it (the topology stays rooted at the main agent with the child
    // highlighted) — the README "page stays open" contract.
    onOpenChild?.(address)
    try {
      sessions.openSubagent?.(address)
    } catch (error) {
      console.error('[dsh-better-sidebar] openSubagent failed:', error)
    }
  }, [sessions, onOpenChild])

  /** Jump back to the main agent (the topology root) from its node. */
  const openMain = useCallback((): void => {
    if (rootId === undefined) return
    try {
      sessions.open?.(rootId)
    } catch (error) {
      console.error('[dsh-better-sidebar] open session failed:', error)
    }
  }, [sessions, rootId])

  const refresh = useCallback((parentSessionId: string): void => {
    void sessions.refreshSubagents?.(parentSessionId)
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

  /** The tree's ordered job rows (owner-labeled). */
  const jobRows = useMemo(
    () => orderJobs(collectTreeJobs(byId, list.jobsBySession, rootId)),
    [byId, list.jobsBySession, rootId],
  )

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
      if (teamView?.available !== true || teamView.team === null || rootId === undefined) return null
      const task = popover.taskId === undefined
        ? undefined
        : teamView.team.tasks.find(candidate => candidate.id === popover.taskId)
      // A task that vanished (deleted elsewhere) closes the window instead of
      // showing a stale card.
      if (popover.taskId !== undefined && task === undefined) return null
      return (
        <TaskPopover
          rootId={rootId}
          task={task}
          members={teamView.team.members}
          onChanged={team.refresh}
          onClose={closePopover}
          anchor={popover.anchor}
        />
      )
    }
    if (popover.kind === 'job') {
      const row = jobRows.find(candidate => candidate.job.id === popover.jobId)
      if (row === undefined) return null
      return <JobOutputPopoverContent ownerSessionId={row.ownerSessionId} job={row.job} active={active} />
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
    <div className={`dsw-tasks ${legacy.subagent} relative`}>
      {/*
        Page header: title + mono descendant count + refresh, closed by a 1px
        hairline. The control cluster (view toggle / fold / zoom) stays on the
        canvas itself, so it is visible in BOTH modes.
      */}
      <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t('subagent')}
          {rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== ''
            ? ` · ${rootSummary.displayTitle}`
            : ''}
        </span>
        {countLabel !== undefined && (
          <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
            {countLabel}
          </span>
        )}
        {/* Delay so the label never flashes while the pointer crosses the row. */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <UiButton
                variant="ghost"
                size="icon"
                className="size-7 flex-none"
                aria-label={t('refresh')}
                title={t('refresh')}
                disabled={rootId === undefined}
                onClick={() => {
                  if (rootId !== undefined) refresh(rootId)
                  team.refresh()
                }}
              >
                <IconRefreshOutline14 size={13} />
              </UiButton>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">{t('refresh')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {rootId !== undefined && teamView?.available === true && teamView.team !== null && (
        <TeamBoard
          rootId={rootId}
          members={teamView.team.members}
          tasks={teamView.team.tasks}
          onOpenTask={openTaskFromBoard}
          collapsed={teamBoardCollapsed}
          onToggleCollapsed={() => { setTeamBoardCollapsed(current => !current) }}
        />
      )}
      {failedParents.length > 0 && (
        <div className="flex flex-none items-center justify-between gap-2 px-3 py-2 text-xs text-destructive">
          <span>{t('catalogLoadFailed', { count: failedParents.length })}</span>
          <UiButton
            variant="ghost"
            size="sm"
            className="flex-none"
            onClick={() => { for (const parent of failedParents) refresh(parent) }}
          >
            <IconRefreshOutline14 size={12} />
            {t('retry')}
          </UiButton>
        </div>
      )}
      {readyEmpty && (
        <Empty className="flex-1 gap-4 border-0 p-4">
          <EmptyHeader className="gap-2">
            <EmptyMedia variant="icon" className="size-8 rounded-md">
              <IconAgentPresetOutline16 size={16} />
            </EmptyMedia>
            <EmptyTitle className="text-sm font-medium">{t('subagentEmpty')}</EmptyTitle>
            <EmptyDescription className="text-xs">{t('subagentEmptyDesc')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!readyEmpty && rootId !== undefined && (
        mode === 'graph'
          ? (
            <TasksGraph
              nodes={model}
              folded={folded}
              rootId={rootId}
              onNodeInfo={(node, anchor) => { setPopover({ kind: 'node', nodeId: node.id, anchor }) }}
              onWorkflowInfo={(node, anchor) => { setPopover({ kind: 'workflow', nodeId: node.id, anchor }) }}
              onOpenTask={openTaskById}
              onToggleFold={() => { setFolded(current => !current) }}
              mode={mode}
              onModeChange={setModeOverride}
              loading={summaryBackedLoading}
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
        openJobId={popover?.kind === 'job' ? popover.jobId : undefined}
        onOpenOutput={(row, anchor) => {
          setPopover(popover?.kind === 'job' && popover.jobId === row.job.id
            ? null
            : { kind: 'job', jobId: row.job.id, anchor })
        }}
      />
      {popover?.kind === 'task'
        ? popoverContent
        : (
          <AnchoredPopover
            anchor={popover?.anchor ?? null}
            onClose={closePopover}
            draggable={popover?.kind === 'job'}
            width={popover?.kind === 'job' ? 380 : 280}
          >
            {popoverContent}
          </AnchoredPopover>
        )}
    </div>
  )
}
