/**
 * The unified view model of the Tasks page: one ordered node list the graph
 * canvas AND the tree mode both render (same data, same fold state). Pure
 * derivation over the sessions list feed (byId lineage + the host's
 * per-session `subagentCatalog` projection views), the live activity map, the
 * folded workflow runs, and the optional team view — kept framework-free for
 * node-environment unit tests.
 *
 * Shape rules:
 * - agent rows walk the per-parent catalog views in pre-order (the same
 *   recursion the classic tree used); Side Chat threads never become nodes;
 * - a workflow run hangs under its ORIGIN agent; member agents that already
 *   exist as the origin's catalog children are RE-PARENTED under the run
 *   node, members without a catalog row are synthesized from the run's own
 *   member data (so a finished run still shows its members);
 * - team members enrich matching agent nodes in place (role/phase/status);
 *   the lead's roster row lands on the root node;
 * - fold: per parent, settled agent leaves and fully settled known branches
 *   (never the current session or its ancestors) collapse into one
 *   trailing `fold` node per GROUP (finished work / waiting members) carrying
 *   the member ids and label previews; a group the reader opened
 *   ({@link TasksModelInput.expandedGroups}) keeps its members visible while
 *   its sibling group stays folded.
 */
import type {
  SidebarSessionSummary,
  SidebarSubagentAddress,
  SidebarSubagentCatalogEntry,
  SidebarTeamMemberProjection,
  SidebarTeamTaskView,
} from '../context-types.ts'
import type { SidebarChildLiveView } from '../context-types.ts'
import type { WorkflowRunView } from '../workflow-runs.ts'
import { isSideThreadSummary } from './subagent-detect.ts'
import { childLive, isKnownLeaf, type SubagentCatalogView } from './subagent-catalog.ts'
import type { SessionMetrics } from './session-metrics.ts'
import type { TeamMemberRow } from './team-projection.ts'

/** Display state of one agent node (drives the dot + fold candidacy). */
export type TasksNodeState = 'running' | 'idle' | 'done' | 'error'

/** One shared task as a node shows it (the board owns the full editing). */
export interface TasksNodeTask {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Not ready = blocked by another task. */
  ready: boolean
}

/** One agent node (root, subagent, teammate, or synthesized workflow member). */
export interface TasksAgentNode {
  kind: 'agent'
  id: string
  parentId?: string
  /** Card line 1: durable label, else summary title, else the id. */
  label: string
  /** The summary's display title when it differs from the label. */
  title?: string
  /** The catalog row's mode; `unknown` claims neither and renders nothing. */
  mode?: SidebarSubagentCatalogEntry['mode']
  state: TasksNodeState
  /** The catalog's raw activity word (the secondary line localizes it). */
  activity: 'running' | 'inactive'
  /** The on-screen session (the "you are here" marker). */
  current: boolean
  /** Live tail of a running child (the merged activity + newest text). */
  live?: SidebarChildLiveView
  /** Token usage + turn timing of the node's own session (see ./session-metrics.ts). */
  metrics?: SessionMetrics
  /** Team enrichment (roster row matched by session id). */
  team?: {
    role: 'lead' | 'teammate'
    name: string
    /** Durable lifecycle of the roster row (`provisioning | active | failed`). */
    phase: SidebarTeamMemberProjection['phase']
    /** The member's derived display status (see ./team-projection.ts). */
    status: TeamMemberRow['status']
    diagnostics: string[]
  }
  /**
   * Tree depth (the root is 0). Drives the card's GROUP COLOUR: every node of
   * one level wears the same left edge, so a wide graph still reads as bands.
   */
  depth: number
  /** Workflow phase this node is a member of (workflow runs only). */
  phase?: { key: string; index: number; title?: string }
  /** Unknown/nonempty catalog signal (known branches are checked as subtrees). */
  hasChildren?: boolean
  /** Shared tasks owned by this agent (team boards only; empty otherwise). */
  tasks?: TasksNodeTask[]
  /** Synthesized from a workflow run's member row (no catalog entry). */
  synthesized?: boolean
  /** Jump target of the row (absent on the root node). */
  childAddress?: SidebarSubagentAddress
}

/** One workflow run node (its members hang below as agent children). */
export interface TasksWorkflowNode {
  kind: 'workflow'
  id: string
  parentId: string
  /** Tree depth (see {@link TasksAgentNode.depth}). */
  depth: number
  run: WorkflowRunView
}

/**
 * Which kind of state one fold aggregate holds. The two are SEPARATE rows:
 * mixing them meant the aggregate had to explain itself with a tally and its
 * badge had to hedge ("✓ N 已完成 · N 待命"), and a reader who wanted to sweep
 * the waiting teammates away had to take the finished work with them.
 */
export type TasksFoldKind = 'done' | 'idle'

/** One fold aggregate node (the settled or the waiting children of one parent). */
export interface TasksFoldNode {
  kind: 'fold'
  /** Which group this row is: finished work, or members waiting for a turn. */
  foldKind: TasksFoldKind
  id: string
  parentId: string
  /** Tree depth (see {@link TasksAgentNode.depth}). */
  depth: number
  count: number
  /** How many of {@link count} are done (the badge's own count). */
  doneCount: number
  /** How many are waiting for a turn (待命 idle members, never executing). */
  idleCount: number
  /** How many ended in a failure (出错); they belong to the `done` group. */
  errorCount: number
  /** All hidden agent ids, including descendants, in topology order. */
  memberIds: string[]
  /** Up to two label previews for the collapsed subtitle. */
  previews: string[]
}

export type TasksNode = TasksAgentNode | TasksWorkflowNode | TasksFoldNode

/** Inputs of the model build (all already-resolved client mirrors). */
export interface TasksModelInput {
  byId: Readonly<Record<string, SidebarSessionSummary>>
  /** Per-parent catalog views (DSH 0.1.7 projectors, see {@link subagentCatalogs}). */
  catalogs: Readonly<Record<string, SubagentCatalogView | undefined>>
  rootId: string
  currentSessionId: string
  live: Readonly<Record<string, SidebarChildLiveView | undefined>>
  /**
   * Per-session token usage and turn timing, keyed by session id (the same
   * shape as {@link TasksModelInput.live}). Both are host projections, so a
   * session the snapshot does not carry simply has no metrics and the popover
   * hides the row.
   */
  metrics?: Readonly<Record<string, SessionMetrics | undefined>>
  runs: readonly WorkflowRunView[]
  teamMembers: readonly TeamMemberRow[]
  /** The team's shared tasks; each lands on its OWNER's node. */
  teamTasks?: readonly SidebarTeamTaskView[]
  /** Global gate for automatic folding; manual foldedIds remain independent. */
  folded: boolean
  /** Automatically aggregate settled leaves (default true). */
  autoFoldSettled?: boolean
  /** Automatically aggregate fully settled, known branches (default true). */
  autoFoldBranches?: boolean
  /** Automatically aggregate idle members at the existing threshold (default true). */
  autoFoldIdle?: boolean
  /**
   * Nodes the READER folded by hand (a settled card's bar chevron). This is a
   * PER-NODE trigger, not a second copy of the global rule, so it only has to
   * satisfy the existing per-node guards: never a
   * running node, never the current session. It is deliberately NOT subject to
   * the automatic subtree rule — the chevron is drawn on every settled card, and a
   * trigger that cannot fire is a dead control.
   */
  foldedIds?: ReadonlySet<string>
  /**
   * The fold GROUPS the reader expanded by clicking their aggregate card
   * ({@link foldGroupId}). A group listed here shows its members while every
   * other group stays folded — expanding one aggregate must never unfold the
   * page. It is consulted only where a member would otherwise be folded, and it
   * yields to {@link foldedIds}: folding one node back by hand is the reader's
   * newest explicit intent, and a group that ignored it would leave that card's
   * own chevron dead.
   */
  expandedGroups?: ReadonlySet<string>
}

/** Human label of one catalog child (the classic rule). */
function childLabel(
  entry: SidebarSubagentCatalogEntry,
  summary: SidebarSessionSummary | undefined,
): string {
  return entry.label ?? summary?.displayTitle ?? entry.id
}

/** Manual folds preserve the existing per-node running/current guards. */
function nodeFoldable(node: TasksAgentNode, currentSessionId: string): boolean {
  return !node.current && node.id !== currentSessionId && node.state !== 'running'
}

/**
 * How many IDLE team members one parent needs before the page-level rule
 * sweeps them into the aggregate too.
 *
 * A teammate that has finished its turn is `idle`: it is not executing, has
 * nothing in flight, and can be resumed later — the same fact a plain
 * subagent reports as `done`. It used to stay out of the aggregate entirely,
 * so a wide team kept a card per member forever. The count is kept at three
 * on purpose: one or two idle members are the team's working set (and their
 * cards are where a task line shows up), while three or more is a roster the
 * reader is scanning rather than watching. Nothing is lost either way — the
 * aggregate row names the counts and expands on one click.
 */
export const FOLD_IDLE_MIN = 3

/** The state tally of one fold group. */
interface FoldTally {
  done: number
  idle: number
  error: number
}

/** Count one future fold group's members by display state. */
function tally(folded: readonly TasksAgentNode[]): FoldTally {
  const counts: FoldTally = { done: 0, idle: 0, error: 0 }
  for (const node of folded) {
    if (node.state === 'done') counts.done += 1
    else if (node.state === 'idle') counts.idle += 1
    else if (node.state === 'error') counts.error += 1
  }
  return counts
}

/**
 * The id of one fold GROUP (the aggregate card a set of folded members
 * collapses into). Derived from the parent and the group kind only, so the id
 * is stable while membership changes underneath it — the page keys the
 * reader's per-group expansions by exactly this string.
 *
 * @param foldKind - which group (`done` = finished/failed, `idle` = waiting).
 * @param parentId - the parent whose children were folded.
 */
export function foldGroupId(foldKind: TasksFoldKind, parentId: string): string {
  return foldKind === 'idle' ? `fold:${parentId}:idle` : `fold:${parentId}`
}

/**
 * Build one aggregate row for the given group of children.
 *
 * `foldKind` decides which members the row owns: the `done` group takes the
 * finished and failed ones, the `idle` group the waiting members. The caller
 * passes only its own members, so the counts and previews come straight off
 * that list.
 *
 * @param foldKind - which group this row is.
 * @param parentId - the row's parent (its tree position).
 * @param depth - the row's tree depth.
 * @param members - the children this group swallowed, in page order.
 */
function foldNode(
  foldKind: TasksFoldKind,
  parentId: string,
  depth: number,
  members: readonly TasksAgentNode[],
): TasksFoldNode {
  const counts = tally(members)
  return {
    kind: 'fold',
    foldKind,
    id: foldGroupId(foldKind, parentId),
    parentId,
    depth,
    count: members.length,
    doneCount: counts.done,
    idleCount: counts.idle,
    errorCount: counts.error,
    memberIds: members.map(member => member.id),
    previews: members.slice(0, 2).map(member => member.label),
  }
}

/**
 * Map a team member's derived status onto the node display state. The status
 * already folds in the durable phase (./team-projection.ts), so this is a
 * vocabulary translation and nothing more.
 */
function teamState(status: TeamMemberRow['status']): TasksNodeState {
  switch (status) {
    case 'running': return 'running'
    case 'provisioning': return 'running'
    case 'failed': return 'error'
    case 'idle': return 'idle'
  }
}

/** The workflow member's display state from its outcome (undefined = live). */
function memberOutcomeState(outcome: 'completed' | 'failed' | 'cancelled' | undefined): TasksNodeState {
  switch (outcome) {
    case undefined: return 'running'
    case 'completed': return 'done'
    case 'cancelled': return 'done'
    case 'failed': return 'error'
  }
}

/**
 * Build the ordered (pre-order) node list of the Tasks page. The result is
 * stable for a stable input set: catalog order is preserved, runs follow
 * their origin's agent children in startedSeq order, and each fold node
 * trails its parent's remaining children.
 */
export function buildTasksModel(input: TasksModelInput): TasksNode[] {
  const {
    byId, catalogs, rootId, currentSessionId, live, runs, teamMembers, folded, foldedIds,
  } = input
  const expandedGroups = input.expandedGroups
  const metrics = input.metrics
  const teamTasks = input.teamTasks ?? []
  const teamById = new Map(teamMembers.map(member => [member.id, member]))
  /** Owner display name → node id (the board assigns by member name). */
  const nodeByOwner = new Map<string, string>()
  for (const member of teamMembers) nodeByOwner.set(member.name, member.id)
  const tasksByNode = new Map<string, TasksNodeTask[]>()
  for (const task of teamTasks) {
    if (task.status === 'deleted' || task.ownerName === undefined) continue
    const nodeId = nodeByOwner.get(task.ownerName)
    if (nodeId === undefined) continue
    const list = tasksByNode.get(nodeId)
    const entry: TasksNodeTask = {
      id: task.id, subject: task.subject, status: task.status, ready: task.ready,
    }
    if (list === undefined) tasksByNode.set(nodeId, [entry])
    else list.push(entry)
  }
  const runsByOrigin = new Map<string, WorkflowRunView[]>()
  for (const run of runs) {
    const list = runsByOrigin.get(run.originSessionId)
    if (list === undefined) runsByOrigin.set(run.originSessionId, [run])
    else list.push(run)
  }

  const teamOf = (id: string): TasksAgentNode['team'] => {
    const member = teamById.get(id)
    return member === undefined
      ? undefined
      : { role: member.role, name: member.name, phase: member.phase, status: member.status, diagnostics: member.diagnostics }
  }

  const out: (TasksAgentNode | TasksWorkflowNode)[] = []
  const seen = new Set<string>([rootId])

  /**
   * Every session id the catalogs know about, anywhere in the tree. A
   * workflow member whose `childId` is listed under a DIFFERENT parent (or
   * whose catalog row is missing from the run's origin) must NOT be
   * synthesized into a second node with the same id: duplicate ids collide in
   * React keys and in the edge map. Known ids keep their single real node;
   * unknown ones are synthesized below.
   */
  const knownAgentIds = new Set<string>()
  for (const catalog of Object.values(catalogs)) {
    if (catalog?.state !== 'ready') continue
    for (const entry of catalog.entries) knownAgentIds.add(entry.id)
  }
  // The local children lists of `buildChildren` are built lazily per parent,
  // so this global set is what makes the guard below order-independent.

  /** The agent children of one parent, in catalog order (side threads
   *  excluded), with workflow runs appended in start order. */
  const buildChildren = (parentId: string, depth: number): (TasksAgentNode | TasksWorkflowNode)[] => {
    const catalog = catalogs[parentId]
    const entries = catalog?.state === 'ready' ? catalog.entries : []
    const agentChildren: TasksAgentNode[] = []
    for (const entry of entries) {
      if (seen.has(entry.id)) continue
      const summary = byId[entry.id]
      if (summary !== undefined && isSideThreadSummary(summary)) continue
      if (entry.label?.startsWith('Side: ') ?? false) continue
      seen.add(entry.id)
      const team = teamOf(entry.id)
      // DSH 0.1.7's catalog row carries the identity only: the live channel
      // reports EVERY child with an explicit `running` flag, and a row keeps
      // its disclosure unless its own catalog is known-empty.
      const view = childLive(live, entry.id)
      // …but that flag is SESSION RESIDENCY, not "an agent is running": the
      // host's own field doc says it means "recursive catalog listing observed
      // a resident Session … does not encode a durable outcome or guarantee
      // continuation delivery". After a crash-restart, opening a child's
      // history retains its session WITHOUT starting an agent, so residency
      // reads `running` for a child nothing is driving (issue #800: the card
      // showed 运行中 with a live preview line for an interrupted subagent).
      // The session summary's `running` is the authoritative run bit — the root
      // card below reads it, so does DSH's own subagent dropdown, and
      // ./subagent-lineage.ts already counts descendants from it — so it wins
      // whenever the host reports the field; the catalog flag stays the
      // fallback for a deployment whose summaries do not carry it.
      const running = summary?.running ?? (view?.running === true)
      const activity: 'running' | 'inactive' = running ? 'running' : 'inactive'
      const state: TasksNodeState = activity === 'running'
        ? 'running'
        : team !== undefined ? teamState(team.status) : 'done'
      agentChildren.push({
        kind: 'agent',
        id: entry.id,
        parentId,
        depth: depth + 1,
        label: childLabel(entry, summary),
        ...(summary?.displayTitle !== undefined && summary.displayTitle !== entry.label
          ? { title: summary.displayTitle } : {}),
        mode: entry.mode,
        state,
        activity,
        current: entry.id === currentSessionId,
        ...(view !== undefined ? { live: view } : {}),
        ...(metrics?.[entry.id] !== undefined ? { metrics: metrics[entry.id] } : {}),
        ...(team !== undefined ? { team } : {}),
        ...(tasksByNode.get(entry.id) !== undefined ? { tasks: tasksByNode.get(entry.id) } : {}),
        hasChildren: !isKnownLeaf(catalogs, entry.id),
        childAddress: { parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode },
      })
    }

    const agentChildrenById = new Map(agentChildren.map(node => [node.id, node]))
    // Workflow runs of this agent: member agents with a catalog row are
    // re-parented under the run; the rest are synthesized from run data.
    const runNodes: TasksWorkflowNode[] = []
    const memberNodes: TasksAgentNode[][] = []
    for (const run of runsByOrigin.get(parentId) ?? []) {
      const runNode: TasksWorkflowNode = {
        kind: 'workflow', id: `run:${run.runId}`, parentId, depth: depth + 1, run,
      }
      if (seen.has(runNode.id)) continue
      seen.add(runNode.id)
      runNodes.push(runNode)
      const members: TasksAgentNode[] = []
      for (const [phaseIndex, phase] of run.phases.entries()) {
        for (const member of phase.members) {
          const existing = member.childId !== ''
            ? agentChildrenById.get(member.childId)
            : undefined
          const phaseRef = {
            key: `${run.runId}:${phaseIndex}`,
            index: phaseIndex,
            ...(phase.title === undefined ? {} : { title: phase.title }),
          }
          if (existing !== undefined && existing.phase === undefined) {
            existing.parentId = runNode.id
            existing.depth = runNode.depth + 1
            existing.phase = phaseRef
            if (tasksByNode.get(existing.id) !== undefined) existing.tasks = tasksByNode.get(existing.id)
            members.push(existing)
          } else if (member.childId !== '' && (knownAgentIds.has(member.childId) || seen.has(member.childId))) {
            // Its real node exists elsewhere in the tree: the run's popover
            // already lists the member, so no card is duplicated here.
          } else {
            const childKnown = member.childId !== ''
            const id = childKnown ? member.childId : `wfmember:${run.runId}:${member.seq}`
            if (seen.has(id)) continue
            seen.add(id)
            const team = teamOf(id)
            const view = childLive(live, id)
            const running = byId[id]?.running ?? (view?.running === true)
            const state = running ? 'running' : team !== undefined ? teamState(team.status) : memberOutcomeState(member.outcome)
            members.push({
              kind: 'agent',
              id,
              parentId: runNode.id,
              depth: runNode.depth + 1,
              phase: phaseRef,
              label: member.label,
              state,
              activity: state === 'running' ? 'running' : 'inactive',
              ...(team !== undefined ? { team } : {}),
              ...(view !== undefined ? { live: view } : {}),
              ...(childKnown && catalogs[id] !== undefined ? { hasChildren: !isKnownLeaf(catalogs, id) } : {}),
              current: member.childId !== '' && member.childId === currentSessionId,
              synthesized: true,
              ...(childKnown && metrics?.[member.childId] !== undefined
                ? { metrics: metrics[member.childId] } : {}),
              ...(childKnown && tasksByNode.get(member.childId) !== undefined
                ? { tasks: tasksByNode.get(member.childId) } : {}),
              ...(childKnown
                ? { childAddress: { parentSessionId: parentId, childSessionId: member.childId, mode: 'one-shot' as const } }
                : {}),
            })
          }
        }
      }
      memberNodes.push(members)
    }
    const visibleAgentChildren = agentChildren.filter(child => child.parentId === parentId)

    const children: (TasksAgentNode | TasksWorkflowNode)[] = [...visibleAgentChildren]
    for (let index = 0; index < runNodes.length; index += 1) {
      const runNode = runNodes[index]
      if (runNode === undefined) continue
      children.push(runNode, ...(memberNodes[index] ?? []))
    }
    return children
  }

  const rootSummary = byId[rootId]
  const rootTeam = teamOf(rootId)
  // The topology root carries its live view like every child: the live route
  // folds the root's own range into the same map (the `subagents` service
  // cannot classify an agent it did not spawn, so its `running` flag is absent
  // there — the summary and text are not). Without it the main agent's card and
  // tree row fell back to the hardcoded thinking wording no matter what the
  // session was actually doing.
  const rootLive = childLive(live, rootId)
  out.push({
    kind: 'agent',
    id: rootId,
    depth: 0,
    label: rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== ''
      ? rootSummary.displayTitle
      : rootId,
    state: rootSummary?.running === true ? 'running' : 'done',
    activity: rootSummary?.running === true ? 'running' : 'inactive',
    current: rootId === currentSessionId,
    ...(rootLive !== undefined ? { live: rootLive } : {}),
    ...(metrics?.[rootId] !== undefined ? { metrics: metrics[rootId] } : {}),
    ...(rootTeam !== undefined ? { team: rootTeam } : {}),
    ...(tasksByNode.get(rootId) !== undefined ? { tasks: tasksByNode.get(rootId) } : {}),
  })
  // Explicit stacks preserve pre-order without a call-stack limit on deep trees.
  const pending = buildChildren(rootId, 0).reverse()
  while (pending.length > 0) {
    const node = pending.pop()!
    out.push(node)
    if (node.kind === 'workflow') continue
    const children = buildChildren(node.id, node.depth)
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!)
  }

  const childrenById = new Map<string, (TasksAgentNode | TasksWorkflowNode)[]>()
  for (const node of out) {
    if (node.parentId === undefined) continue
    const children = childrenById.get(node.parentId)
    if (children === undefined) childrenById.set(node.parentId, [node])
    else children.push(node)
  }

  // Reverse pre-order means every child's facts are ready before its parent.
  // Subtree ranges also let aggregates collect hidden agents once, including
  // descendants that would have formed their own groups when visible.
  const settled = new Map<string, boolean>()
  const subtreeEnd = new Map<string, number>()
  const indexById = new Map(out.map((node, index) => [node.id, index]))
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const node = out[index]!
    const children = childrenById.get(node.id) ?? []
    const known = node.kind === 'workflow' || catalogs[node.id]?.state === 'ready'
      || (node.synthesized === true && node.childAddress === undefined && catalogs[node.id] === undefined)
    const ownSettled = node.kind === 'workflow'
      ? node.run.status !== 'running'
      : nodeFoldable(node, currentSessionId) && node.state !== 'idle' && known
    // An opened child group keeps this branch reachable under automatic rules;
    // manual folds below still override it without consulting subtree facts.
    settled.set(node.id, ownSettled
      && expandedGroups?.has(foldGroupId('done', node.id)) !== true
      && expandedGroups?.has(foldGroupId('idle', node.id)) !== true
      && children.every(child => settled.get(child.id) === true))
    const last = children.at(-1)
    subtreeEnd.set(node.id, last === undefined ? index + 1 : subtreeEnd.get(last.id)!)
  }

  const projectChildren = (parent: TasksAgentNode | TasksWorkflowNode): TasksNode[] => {
    const visible: TasksNode[] = []
    const children = childrenById.get(parent.id) ?? []
    const idleCount = children.filter(child => child.kind === 'agent' && child.state === 'idle' && child.team !== undefined).length
    const foldIdle = parent.kind === 'workflow' || idleCount >= FOLD_IDLE_MIN
    const groups: Record<TasksFoldKind, TasksAgentNode[]> = { done: [], idle: [] }
    const workflows: TasksWorkflowNode[] = []
    for (const child of children) {
      if (child.kind === 'workflow') {
        workflows.push(child)
        continue
      }
      const group: TasksFoldKind = child.state === 'idle' ? 'idle' : 'done'
      const descendants = childrenById.get(child.id) ?? []
      const branch = descendants.length > 0 || child.hasChildren === true
      const idleSafe = child.state === 'idle' && !branch && nodeFoldable(child, currentSessionId)
        && (catalogs[child.id]?.state === 'ready'
          || (child.synthesized === true && child.childAddress === undefined && catalogs[child.id] === undefined))
      const auto = folded && (group === 'idle'
        ? input.autoFoldIdle !== false && foldIdle && idleSafe
        : settled.get(child.id) === true && (branch ? input.autoFoldBranches !== false : input.autoFoldSettled !== false)
          // Keep the existing roster guard for failed members below threshold.
          && (child.team === undefined || foldIdle))
      const manual = foldedIds?.has(child.id) === true && nodeFoldable(child, currentSessionId)
      const expanded = expandedGroups?.has(foldGroupId(group, parent.id)) === true
      if (manual || (auto && !expanded)) {
        const start = indexById.get(child.id)!
        const end = subtreeEnd.get(child.id)!
        for (let index = start; index < end; index += 1) {
          const hidden = out[index]!
          if (hidden.kind === 'agent') groups[group].push(hidden)
        }
      } else {
        visible.push(child)
      }
    }
    for (const group of ['done', 'idle'] as const) {
      if (groups[group].length > 0) visible.push(foldNode(group, parent.id, parent.depth + 1, groups[group]))
    }
    visible.push(...workflows)
    return visible
  }
  const projected: TasksNode[] = []
  const pendingProjection: TasksNode[] = [out[0]!]
  while (pendingProjection.length > 0) {
    const node = pendingProjection.pop()!
    projected.push(node)
    if (node.kind === 'fold') continue
    const children = projectChildren(node)
    for (let index = children.length - 1; index >= 0; index -= 1) pendingProjection.push(children[index]!)
  }
  return projected
}

/** The parent→child edges of a model (derived, kept out of the build). */
export interface TasksEdge {
  from: string
  to: string
  /** Visual class: teammate links and workflow relations get the accent. */
  kind: 'agent' | 'team' | 'workflow'
}

/** Derive the edge list of a built model (pre-order preserved). */
export function tasksEdges(nodes: readonly TasksNode[]): TasksEdge[] {
  const byNodeId = new Map(nodes.map(node => [node.id, node]))
  const edges: TasksEdge[] = []
  for (const node of nodes) {
    if (node.parentId === undefined || !byNodeId.has(node.parentId)) continue
    const parent = byNodeId.get(node.parentId)
    const kind: TasksEdge['kind'] = node.kind === 'workflow' || parent?.kind === 'workflow'
      ? 'workflow'
      : node.kind === 'agent' && node.team?.role === 'teammate'
        ? 'team'
        : 'agent'
    edges.push({ from: node.parentId, to: node.id, kind })
  }
  return edges
}
