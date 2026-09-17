/**
 * The unified view model of the Tasks page: one ordered node list the graph
 * canvas AND the tree mode both render (same data, same fold state). Pure
 * derivation over the sessions list feed (byId lineage + per-parent
 * catalogs), the live activity map, the folded workflow runs, and the
 * optional team view — kept framework-free for node-environment unit tests.
 *
 * Shape rules:
 * - agent rows walk the lazy per-parent catalogs in pre-order (the same
 *   recursion the classic tree used); Side Chat threads and diagnostic rows
 *   never become nodes;
 * - a workflow run hangs under its ORIGIN agent; member agents that already
 *   exist as the origin's catalog children are RE-PARENTED under the run
 *   node, members without a catalog row are synthesized from the run's own
 *   member data (so a finished run still shows its members);
 * - team members enrich matching agent nodes in place (role/model/status);
 *   the lead's membership lands on the root node;
 * - fold: per parent, settled agent LEAVES (state done/error, never the
 *   current session, never a workflow member's run node) collapse into one
 *   trailing `fold` node carrying the member ids and label previews.
 */
import type {
  SidebarSessionSummary,
  SidebarSubagentAddress,
  SidebarSubagentCatalog,
  SidebarSubagentChildEntry,
  SidebarTeamMemberView,
  SidebarTeamTaskView,
} from '../context-types.ts'
import type { LastActivity } from '../subagent-activity.ts'
import type { WorkflowRunView } from '../workflow-runs.ts'
import { isSideThreadSummary } from './subagent-detect.ts'

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
  mode?: 'one-shot' | 'continuable'
  state: TasksNodeState
  /** The catalog's raw activity word (the secondary line localizes it). */
  activity: 'running' | 'inactive'
  /** The on-screen session (the "you are here" marker). */
  current: boolean
  /** Live tail of a running child (the icon + tool + args line). */
  live?: LastActivity
  /** Team enrichment (membership view matched by session id). */
  team?: {
    role: 'lead' | 'teammate'
    name: string
    model?: string
    status: SidebarTeamMemberView['status']
    diagnostics: string[]
  }
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
  run: WorkflowRunView
}

/** One fold aggregate node (settled leaves of one parent, collapsed). */
export interface TasksFoldNode {
  kind: 'fold'
  id: string
  parentId: string
  count: number
  /** The folded session ids, in original order (expansion restores them). */
  memberIds: string[]
  /** Up to two label previews for the collapsed subtitle. */
  previews: string[]
}

export type TasksNode = TasksAgentNode | TasksWorkflowNode | TasksFoldNode

/** Inputs of the model build (all already-resolved client mirrors). */
export interface TasksModelInput {
  byId: Readonly<Record<string, SidebarSessionSummary>>
  catalogs: Readonly<Record<string, SidebarSubagentCatalog | undefined>>
  rootId: string
  currentSessionId: string
  live: Readonly<Record<string, LastActivity | undefined>>
  runs: readonly WorkflowRunView[]
  teamMembers: readonly SidebarTeamMemberView[]
  /** The team's shared tasks; each lands on its OWNER's node. */
  teamTasks?: readonly SidebarTeamTaskView[]
  /** Whether settled leaves collapse into fold nodes. */
  folded: boolean
}

/** Human label of one catalog child (the classic rule). */
function childLabel(
  entry: SidebarSubagentChildEntry,
  summary: SidebarSessionSummary | undefined,
): string {
  return entry.label ?? summary?.displayTitle ?? entry.id
}

/** Map a team member's runtime status onto the node display state. */
function teamState(status: SidebarTeamMemberView['status']): TasksNodeState {
  switch (status) {
    case 'running': return 'running'
    case 'provisioning': return 'running'
    case 'failed': return 'error'
    case 'idle':
    case 'inactive': return 'idle'
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
  const { byId, catalogs, rootId, currentSessionId, live, runs, teamMembers, folded } = input
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
      : { role: member.role, name: member.name, model: member.model, status: member.status, diagnostics: member.diagnostics }
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
    for (const entry of catalog.entries) {
      if (entry.kind === 'child') knownAgentIds.add(entry.id)
    }
  }
  // The local children lists of `appendChildren` are built lazily per parent,
  // so this global set is what makes the guard below order-independent.

  /** The agent children of one parent, in catalog order (side threads and
   *  diagnostics excluded), with workflow runs appended in start order. */
  const appendChildren = (parentId: string): void => {
    const catalog = catalogs[parentId]
    const entries = catalog?.state === 'ready' ? catalog.entries : []
    const agentChildren: TasksAgentNode[] = []
    for (const entry of entries) {
      if (entry.kind !== 'child') continue
      const summary = byId[entry.id]
      if (summary !== undefined && isSideThreadSummary(summary)) continue
      if (entry.label?.startsWith('Side: ') ?? false) continue
      const team = teamOf(entry.id)
      const state: TasksNodeState = entry.activity === 'running'
        ? 'running'
        : team !== undefined ? teamState(team.status) : 'done'
      agentChildren.push({
        kind: 'agent',
        id: entry.id,
        parentId,
        label: childLabel(entry, summary),
        ...(summary?.displayTitle !== undefined && summary.displayTitle !== entry.label
          ? { title: summary.displayTitle } : {}),
        mode: entry.mode,
        state,
        activity: entry.activity,
        current: entry.id === currentSessionId,
        ...(live[entry.id] !== undefined ? { live: live[entry.id] } : {}),
        ...(team !== undefined ? { team } : {}),
        ...(tasksByNode.get(entry.id) !== undefined ? { tasks: tasksByNode.get(entry.id) } : {}),
        hasChildren: entry.hasChildren,
        childAddress: { parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode },
      })
    }

    // Workflow runs of this agent: member agents with a catalog row are
    // re-parented under the run; the rest are synthesized from run data.
    const runNodes: TasksWorkflowNode[] = []
    const memberNodes: TasksAgentNode[][] = []
    for (const run of runsByOrigin.get(parentId) ?? []) {
      const runNode: TasksWorkflowNode = { kind: 'workflow', id: `run:${run.runId}`, parentId, run }
      runNodes.push(runNode)
      const members: TasksAgentNode[] = []
      for (const phase of run.phases) {
        for (const member of phase.members) {
          const existing = member.childId !== ''
            ? agentChildren.find(candidate => candidate.id === member.childId)
            : undefined
          if (existing !== undefined) {
            existing.parentId = runNode.id
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

    // Fold: settled agent leaves of THIS parent collapse into one aggregate.
    const kept: TasksAgentNode[] = []
    const foldCandidates: TasksAgentNode[] = []
    for (const child of visibleAgentChildren) {
      // A leaf: no durable children (catalog signal) and no workflow run of
      // its own — folding a parent would hide its live branch.
      const isLeaf = child.hasChildren !== true && !runsByOrigin.has(child.id)
      if (
        folded && isLeaf && !child.current && child.team === undefined
        && (child.state === 'done' || child.state === 'error')
      ) {
        foldCandidates.push(child)
      } else {
        kept.push(child)
      }
    }

    for (const child of kept) {
      out.push(child)
      appendChildren(child.id)
    }
    if (foldCandidates.length > 0) {
      out.push({
        kind: 'fold',
        id: `fold:${parentId}`,
        parentId,
        count: foldCandidates.length,
        memberIds: foldCandidates.map(child => child.id),
        previews: foldCandidates.slice(0, 2).map(child => child.label),
      })
    }
    for (let index = 0; index < runNodes.length; index += 1) {
      const runNode = runNodes[index]
      if (runNode === undefined) continue
      out.push(runNode)
      const members = memberNodes[index] ?? []
      // Fold settled members of the run too (same leaf rule, run as parent).
      const keptMembers: TasksAgentNode[] = []
      const foldedMembers: TasksAgentNode[] = []
      for (const member of members) {
        if (folded && !member.current && (member.state === 'done' || member.state === 'error')) {
          foldedMembers.push(member)
        } else {
          keptMembers.push(member)
        }
      }
      out.push(...keptMembers)
      if (foldedMembers.length > 0) {
        out.push({
          kind: 'fold',
          id: `fold:${runNode.id}`,
          parentId: runNode.id,
          count: foldedMembers.length,
          memberIds: foldedMembers.map(member => member.id),
          previews: foldedMembers.slice(0, 2).map(member => member.label),
        })
      }
    }
  }

  const rootSummary = byId[rootId]
  const rootTeam = teamOf(rootId)
  out.push({
    kind: 'agent',
    id: rootId,
    label: rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== ''
      ? rootSummary.displayTitle
      : rootId,
    state: rootSummary?.running === true ? 'running' : 'done',
    activity: rootSummary?.running === true ? 'running' : 'inactive',
    current: rootId === currentSessionId,
    ...(rootTeam !== undefined ? { team: rootTeam } : {}),
    ...(tasksByNode.get(rootId) !== undefined ? { tasks: tasksByNode.get(rootId) } : {}),
  })
  appendChildren(rootId)

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
