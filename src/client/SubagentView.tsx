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
  SidebarJobView,
  SidebarSessionList,
  SidebarSubagentAddress,
} from '../context-types.ts'
import {
  countSubagentDescendants,
  isSideThreadSummary,
  rootAncestor,
} from './subagent-detect.ts'
import { subagentCatalogs } from './subagent-catalog.ts'
import { treeSessionIds } from './subagent-lineage.ts'
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
import legacy from './SubagentView.module.css'

/** Poll cadence of the live "last text + tool call" lines while a child runs. */
const POLL_MS = 3000
/** Poll cadence of the workflow-run and team views while the page is visible. */
const TELEMETRY_POLL_MS = 5000
/** Poll cadence of the background-job lists (one read per tree session). */
const JOBS_POLL_MS = 3000

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

/**
 * The background-job lists of the whole tree, keyed by OWNER session.
 *
 * DSH 0.1.7 dropped the client session snapshot's `jobsBySession` push mirror,
 * so the registry is read through the plugin's own `jobs.list` route — and the
 * registry's access fence admits a job to its OWNER session only, so the whole
 * tree is one read per tree session, fanned out on each tick. A host without
 * the jobs service (503) or one dropped read degrades to an empty set for THAT
 * session; the next tick retries.
 */
function useTreeJobs(
  byId: SidebarSessionList['byId'],
  rootId: string | undefined,
  active: boolean,
): Readonly<Record<string, readonly SidebarJobView[]>> {
  const treeIds = useMemo(
    () => (rootId === undefined ? [] : [...treeSessionIds(byId, rootId)]),
    [byId, rootId],
  )
  const [jobsBySession, setJobsBySession] = useState<Readonly<Record<string, readonly SidebarJobView[]>>>({})
  useEffect(() => { setJobsBySession({}) }, [rootId])
  const poll = useCallback(async (signal: AbortSignal): Promise<void> => {
    const entries = await Promise.all(treeIds.map(async (sessionId): Promise<[string, readonly SidebarJobView[]]> => {
      try {
        const result = await api.jobsList(sessionId, signal)
        return [sessionId, result.jobs]
      } catch {
        return [sessionId, []]
      }
    }))
    if (!signal.aborted) setJobsBySession(Object.fromEntries(entries))
  }, [treeIds])
  usePolling(active && treeIds.length > 0, poll, {
    intervalMs: JOBS_POLL_MS,
    mode: 'self-scheduling',
    immediate: true,
  })
  return jobsBySession
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

  /** The tree's ordered job rows (owner-labeled, read per tree session). */
  const jobsBySession = useTreeJobs(byId, rootId, active)
  const jobRows = useMemo(
    () => orderJobs(collectTreeJobs(byId, jobsBySession, rootId)),
    [byId, jobsBySession, rootId],
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
            team.refresh()
          }}
        />
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
