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
 * - fold: per parent, settled agent LEAVES (state done/error, never the
 *   current session, never a workflow member's run node) collapse into one
 *   trailing `fold` node carrying the member ids and label previews.
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
  /** The catalog's durable children signal (fold candidacy's leaf test). */
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
  /** The folded session ids, in original order (expansion restores them). */
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
  runs: readonly WorkflowRunView[]
  teamMembers: readonly TeamMemberRow[]
  /** The team's shared tasks; each lands on its OWNER's node. */
  teamTasks?: readonly SidebarTeamTaskView[]
  /** Whether settled leaves collapse into fold nodes. */
  folded: boolean
  /**
   * Nodes the READER folded by hand (a settled card's bar chevron). This is a
   * PER-NODE trigger, not a second copy of the global rule, so it only has to
   * satisfy the guards that protect the reader from hiding live work: never a
   * running node, never the current session, never a branching one. It is
   * deliberately NOT subject to {@link isAutoFoldable} — the chevron is drawn
   * on every settled card, and a trigger that cannot fire is a dead control.
   */
  foldedIds?: ReadonlySet<string>
}

/** Human label of one catalog child (the classic rule). */
function childLabel(
  entry: SidebarSubagentCatalogEntry,
  summary: SidebarSessionSummary | undefined,
): string {
  return entry.label ?? summary?.displayTitle ?? entry.id
}

/**
 * Whether the aggregate may hide this node as part of a page-level fold. The
 * caller supplies `foldIdleMembers`: an idle teammate is only swept when its
 * parent has enough of them ({@link FOLD_IDLE_MIN}).
 *
 * - a branching node or one with a run of its own — folding it hides a whole
 *   branch, not a finished leaf;
 * - the session on screen — the "you are here" marker must stay reachable;
 * - a RUNNING or PROVISIONING node — work in flight is never hidden;
 * - a teammate — a roster row is a real, resumable worker, not a settled
 *   subagent to sweep away, so it needs the idle head count (a `failed` one
 *   is ordinary settled work and folds with the rest).
 *
 * The manual trigger ({@link TasksModelInput.foldedIds}) asks for ONE node by
 * name, so it answers only to the running/current guards — a trigger that
 * cannot fire is a dead control.
 */
function nodeFoldable(node: TasksAgentNode, currentSessionId: string): boolean {
  return !node.current && node.id !== currentSessionId
    && node.state !== 'running'
}

/** The extra guard the PAGE-LEVEL rule adds to {@link nodeFoldable}. */
function isAutoFoldable(
  node: TasksAgentNode,
  runsByOrigin: Map<string, WorkflowRunView[]>,
  foldIdleMembers: boolean,
): boolean {
  if (!foldIdleMembers && node.team !== undefined) return false
  return node.hasChildren !== true && !runsByOrigin.has(node.id)
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
    else counts.error += 1
  }
  return counts
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
 * @param idSuffix - disambiguates the two rows of one parent (`''` / `':idle'`).
 */
function foldNode(
  foldKind: TasksFoldKind,
  parentId: string,
  depth: number,
  members: readonly TasksAgentNode[],
  idSuffix: string,
): TasksFoldNode {
  const counts = tally(members)
  return {
    kind: 'fold',
    foldKind,
    id: `fold:${parentId}${idSuffix}`,
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

  const out: TasksNode[] = []

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
  // The local children lists of `appendChildren` are built lazily per parent,
  // so this global set is what makes the guard below order-independent.

  /** The agent children of one parent, in catalog order (side threads
   *  excluded), with workflow runs appended in start order. */
  const appendChildren = (parentId: string, depth: number): void => {
    const catalog = catalogs[parentId]
    const entries = catalog?.state === 'ready' ? catalog.entries : []
    const agentChildren: TasksAgentNode[] = []
    for (const entry of entries) {
      const summary = byId[entry.id]
      if (summary !== undefined && isSideThreadSummary(summary)) continue
      if (entry.label?.startsWith('Side: ') ?? false) continue
      const team = teamOf(entry.id)
      // DSH 0.1.7's catalog row carries the identity only: the live channel
      // reports EVERY child with an explicit `running` flag, and a row keeps
      // its disclosure unless its own catalog is known-empty.
      const view = childLive(live, entry.id)
      const activity: 'running' | 'inactive' = view?.running === true ? 'running' : 'inactive'
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
        ...(team !== undefined ? { team } : {}),
        ...(tasksByNode.get(entry.id) !== undefined ? { tasks: tasksByNode.get(entry.id) } : {}),
        hasChildren: !isKnownLeaf(catalogs, entry.id),
        childAddress: { parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode },
      })
    }

    // Workflow runs of this agent: member agents with a catalog row are
    // re-parented under the run; the rest are synthesized from run data.
    const runNodes: TasksWorkflowNode[] = []
    const memberNodes: TasksAgentNode[][] = []
    for (const run of runsByOrigin.get(parentId) ?? []) {
      const runNode: TasksWorkflowNode = {
        kind: 'workflow', id: `run:${run.runId}`, parentId, depth: depth + 1, run,
      }
      runNodes.push(runNode)
      const members: TasksAgentNode[] = []
      for (const [phaseIndex, phase] of run.phases.entries()) {
        for (const member of phase.members) {
          const existing = member.childId !== ''
            ? agentChildren.find(candidate => candidate.id === member.childId)
            : undefined
          const phaseRef = {
            key: `${run.runId}:${phaseIndex}`,
            index: phaseIndex,
            ...(phase.title === undefined ? {} : { title: phase.title }),
          }
          if (existing !== undefined) {
            existing.parentId = runNode.id
            existing.depth = runNode.depth + 1
            existing.phase = phaseRef
            if (tasksByNode.get(existing.id) !== undefined) existing.tasks = tasksByNode.get(existing.id)
            members.push(existing)
          } else if (member.childId !== '' && knownAgentIds.has(member.childId)) {
            // Its real node exists elsewhere in the tree: the run's popover
            // already lists the member, so no card is duplicated here.
          } else {
            const childKnown = member.childId !== ''
            members.push({
              kind: 'agent',
              id: childKnown ? member.childId : `wfmember:${run.runId}:${member.seq}`,
              parentId: runNode.id,
              depth: runNode.depth + 1,
              phase: phaseRef,
              label: member.label,
              state: memberOutcomeState(member.outcome),
              activity: member.outcome === undefined ? 'running' : 'inactive',
              current: member.childId !== '' && member.childId === currentSessionId,
              synthesized: true,
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

    // Fold: this parent's non-executing children collapse into one aggregate
    // PER GROUP — finished/failed work in one row, waiting members in another,
    // so the badge can say what it holds and a reader can sweep one without
    // the other. Two triggers, two guard sets: the page-level `folded` rule
    // also spares branching nodes and (below the idle head count) teammates; a
    // manual `foldedIds` fold is the reader asking for THAT node, so it only
    // spares running/current work.
    const idleMembers = visibleAgentChildren
      .filter(child => child.state === 'idle' && child.team !== undefined).length
    const foldIdleMembers = idleMembers >= FOLD_IDLE_MIN
    const kept: TasksAgentNode[] = []
    const doneFold: TasksAgentNode[] = []
    const idleFold: TasksAgentNode[] = []
    for (const child of visibleAgentChildren) {
      const foldable = nodeFoldable(child, currentSessionId)
      const auto = folded && foldable && isAutoFoldable(child, runsByOrigin, foldIdleMembers)
      const manual = foldedIds?.has(child.id) === true && foldable
      if (!auto && !manual) {
        kept.push(child)
      } else if (child.state === 'idle') {
        idleFold.push(child)
      } else {
        doneFold.push(child)
      }
    }

    for (const child of kept) {
      out.push(child)
      appendChildren(child.id, child.depth)
    }
    if (doneFold.length > 0) out.push(foldNode('done', parentId, depth + 1, doneFold, ''))
    if (idleFold.length > 0) out.push(foldNode('idle', parentId, depth + 1, idleFold, ':idle'))
    for (let index = 0; index < runNodes.length; index += 1) {
      const runNode = runNodes[index]
      if (runNode === undefined) continue
      out.push(runNode)
      const members = memberNodes[index] ?? []
      // The run's own members fold under the same two triggers and the same
      // two groups; they need no leaf test (they are leaves by construction
      // here) and no team guard (a run member is not a roster row).
      const keptMembers: TasksAgentNode[] = []
      const runDone: TasksAgentNode[] = []
      const runIdle: TasksAgentNode[] = []
      for (const member of members) {
        const hidden = (folded || foldedIds?.has(member.id) === true)
          && nodeFoldable(member, currentSessionId)
        if (!hidden) keptMembers.push(member)
        else if (member.state === 'idle') runIdle.push(member)
        else runDone.push(member)
      }
      out.push(...keptMembers)
      if (runDone.length > 0) out.push(foldNode('done', runNode.id, runNode.depth + 1, runDone, ''))
      if (runIdle.length > 0) out.push(foldNode('idle', runNode.id, runNode.depth + 1, runIdle, ':idle'))
    }
  }

  const rootSummary = byId[rootId]
  const rootTeam = teamOf(rootId)
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
    ...(rootTeam !== undefined ? { team: rootTeam } : {}),
    ...(tasksByNode.get(rootId) !== undefined ? { tasks: tasksByNode.get(rootId) } : {}),
  })
  appendChildren(rootId, 0)

  // Last-resort guard: one node per session id, first occurrence wins. Real
  // catalogs list a child under exactly one parent, so this only fires on
  // pathological trees (and keeps React keys unique when it does).
  const seen = new Set<string>()
  return out.filter((node) => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
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
