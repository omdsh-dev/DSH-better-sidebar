/**
 * Shared presentation bits of the Tasks page's two modes (graph + tree):
 * the state dot, the agent/workflow/task GLYPHS (host primitive icons — the
 * page draws no glyphs of its own), the short mono meta line, the node task
 * line, and the iconified live activity row ("tool icon + tool + args").
 *
 * Card content contract (the page's answer to "everything is ellipsized"):
 *   line 1  state dot + agent icon + name   (11px semibold, one line)
 *   line 2  mode/model · activity           (9px mono, one line)
 *   line 3  live tool line                  (running nodes only)
 *   line 4  owned shared task               (team members only)
 * Everything else lives in the popovers.
 */
import type { ReactNode } from 'react'
import {
  IconAgentPresetOutlineRegular, IconBranchOutlineRegular, IconChecklistOutlineRegular, IconUserOutlineRegular,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarChildLiveView } from '../context-types.ts'
import { liveActivityLabel } from './process-labels.ts'
import type {
  TasksAgentNode, TasksFoldNode, TasksNodeState, TasksNodeTask, TasksWorkflowNode,
} from './tasks-model.ts'
import { toolGlyph } from './tool-icons.tsx'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** Preview cap of one tool-call argument line. */
const ARGS_PREVIEW = 48
/** Preview cap of one text line. */
const TEXT_PREVIEW = 72

/** The host StateDot semantic of a node display state. */
export function nodeDotState(state: TasksNodeState): StateDotState {
  switch (state) {
    case 'running': return 'ongoing'
    case 'idle': return 'idle'
    case 'done': return 'done'
    case 'error': return 'error'
  }
}

/** The short state word of a node (the meta line's second token). */
export function stateLabel(state: TasksNodeState): string {
  const key: CopyKey = state === 'running'
    ? 'tasksStateRunning'
    : state === 'idle'
      ? 'subagentInactive'
      : state === 'error' ? 'tasksStateError' : 'tasksStateDone'
  return t(key)
}

/**
 * The two facts every task display rule reads. Deliberately NARROWER than
 * either carrier (`TasksNodeTask` on the graph, `SidebarTeamTaskView` in the
 * board and the task window) so one rule serves all of them — the window sees
 * a `deleted` status the graph never draws, and only the shared rule needs to
 * know that a deleted task is not "blocked".
 */
export interface TaskStatusFacts {
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  ready: boolean
}

/** The task status label key. */
export function taskStatusKey(status: TaskStatusFacts['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
    case 'deleted': return 'teamTaskDeleted'
  }
}

/**
 * Whether a shared task is HELD UP by its blockers.
 *
 * The service's `ready` flag means exactly one thing: "a pending task whose
 * every blocker completed, so it can be CLAIMED". It is therefore false for
 * every task that is not queued — which makes `!ready` the wrong test for
 * "blocked": a claimed task (in_progress) and a finished one both report
 * `ready: false`, and reading the flag alone labelled a task that is actively
 * being worked on as 阻塞 (reproduced on the real board: claiming a task made
 * its Tag flip from 待办 to 阻塞).
 */
export function taskBlocked(task: TaskStatusFacts): boolean {
  return task.status === 'pending' && !task.ready
}

/** The status word of a task row: its own status, or 阻塞 when held up. */
export function taskStatusLabel(task: TaskStatusFacts): string {
  return t(taskBlocked(task) ? 'teamTaskBlocked' : taskStatusKey(task.status))
}

/** The tone of a task's status Tag (or dot) — the same three-way rule. */
export function taskTone(task: TaskStatusFacts): 'success' | 'info' | 'warning' {
  if (task.status === 'completed') return 'success'
  return taskBlocked(task) ? 'warning' : 'info'
}

/** The host StateDot semantic of a task row/line. */
export function taskDotState(task: TaskStatusFacts): StateDotState {
  if (task.status === 'completed') return 'done'
  return taskBlocked(task) ? 'warning' : 'ongoing'
}

/** First `limit` characters with an ellipsis when truncated. */
export function preview(text: string, limit: number = ARGS_PREVIEW): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Collapse whitespace for single-line previews. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The host icon of one agent node (the lead and plain children share one). */
export function AgentGlyph(props: { node: TasksAgentNode; size?: number }): ReactNode {
  const size = props.size ?? 11
  if (props.node.team?.role === 'teammate') return <IconUserOutlineRegular size={size} />
  return <IconAgentPresetOutlineRegular size={size} />
}

/** The workflow-run glyph. */
export function WorkflowGlyph(props: { size?: number }): ReactNode {
  return <IconBranchOutlineRegular size={props.size ?? 11} />
}

/** The fold aggregate glyph. */
export function FoldGlyph(props: { size?: number }): ReactNode {
  return <IconChecklistOutlineRegular size={props.size ?? 11} />
}

/**
 * The mode word of one catalog row, or undefined when it names no mode. DSH
 * 0.1.7 added `unknown` (a child the host's catalog fold kept without a
 * readable descriptor): it claims NEITHER mode, so the segment is omitted
 * rather than mislabelled.
 */
export function modeLabel(mode: TasksAgentNode['mode']): string | undefined {
  switch (mode) {
    case 'one-shot': return t('subagentModeOneShot')
    case 'continuable': return t('subagentModeContinuable')
    case 'unknown':
    case undefined: return undefined
  }
}

/**
 * The mono meta line of an agent card — at most two short tokens:
 * - the topology root: 主代理 · 状态
 * - any other agent: 模式 · 状态 (a teammate without a catalog mode falls back
 *   to its team role, the one durable identity the roster still carries — the
 *   `agentTeam` projection has no model field to print, see team-projection.ts)
 */
export function agentMeta(node: TasksAgentNode): string {
  const state = stateLabel(node.state)
  if (node.parentId === undefined) return `${t('subagentMainAgent')} · ${state}`
  const mode = modeLabel(node.mode)
  if (mode !== undefined) return `${mode} · ${state}`
  const fallback = node.team === undefined ? undefined : teamRoleLabel(node.team)
  return fallback === undefined ? state : `${fallback} · ${state}`
}

/**
 * The CARD's mono meta line: WHO the node is, never its state.
 *
 * The state belongs to the card's bottom bar (the state word sits next to the
 * state dot there), so repeating it here would print "已完成" twice inside one
 * 190px card — the densest complaint the readability pass had to fix. The
 * accessible name keeps {@link agentMeta} (state included), because a screen
 * reader never sees the bar's dot.
 */
export function agentIdentity(node: TasksAgentNode): string {
  // The root's badge already reads 主代理: an identity line would repeat it.
  if (node.parentId === undefined) return ''
  const mode = modeLabel(node.mode)
  if (mode !== undefined) return mode
  return node.team === undefined ? '' : teamRoleLabel(node.team) ?? ''
}

/** The roster row's own identity word (the fallback for a modelless teammate). */
function teamRoleLabel(team: NonNullable<TasksAgentNode['team']>): string | undefined {
  if (team.role === 'lead') return undefined
  if (team.phase === 'provisioning') return t('tasksStateProvisioning')
  if (team.phase === 'failed') return t('tasksStateError')
  return t('tasksKindTeammate')
}

/** The mono meta line of a workflow run card: status · member tally. */
export function workflowMeta(node: TasksWorkflowNode): string {
  const { run } = node
  let done = 0
  let total = 0
  for (const phase of run.phases) {
    for (const member of phase.members) {
      total += 1
      if (member.outcome !== undefined) done += 1
    }
  }
  return `${t(workflowStatusKey(run.status))} · ${t('workflowMembers', { done, total })}`
}

/** The workflow run status label key. */
export function workflowStatusKey(status: TasksWorkflowNode['run']['status']): CopyKey {
  switch (status) {
    case 'running': return 'workflowRunning'
    case 'completed': return 'workflowCompleted'
    case 'cancelled': return 'workflowCancelled'
    case 'failed': return 'workflowFailed'
  }
}

/** The task a node surfaces first: in-progress, else pending, else the last. */
export function primaryTask(tasks: readonly TasksNodeTask[]): TasksNodeTask | undefined {
  return tasks.find(task => task.status === 'in_progress')
    ?? tasks.find(task => task.status === 'pending')
    ?? tasks[tasks.length - 1]
}

/**
 * The node's shared-task line: an icon, the primary task's subject, its
 * status word, and a `+N` tail when the agent owns more. Renders nothing
 * without tasks, so non-team nodes keep the three-line shape.
 */
export function TaskLine(props: {
  tasks: readonly TasksNodeTask[] | undefined
  onOpenTask(taskId: string, anchor: HTMLElement): void
}): ReactNode {
  const tasks = props.tasks ?? []
  const primary = primaryTask(tasks)
  if (primary === undefined) return null
  return (
    <span
      role="button"
      tabIndex={0}
      className={css.taskLine}
      title={tasks.map(task => `${task.subject}（${t(taskStatusKey(task.status))}）`).join('\n')}
      onClick={(event) => {
        event.stopPropagation()
        props.onOpenTask(primary.id, event.currentTarget)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        props.onOpenTask(primary.id, event.currentTarget)
      }}
    >
      <span className={css.taskGlyph} aria-hidden="true"><IconChecklistOutlineRegular size={9} /></span>
      <span className={css.taskSubject}>{primary.subject}</span>
      <span className={css.taskState}>{t(taskStatusKey(primary.status))}</span>
      {tasks.length > 1 && <span className={css.taskMore}>{`+${tasks.length - 1}`}</span>}
    </span>
  )
}

/**
 * The live activity row of a RUNNING agent: the merged process summary the
 * main conversation would show for the child's newest range (category wording
 * + the running call's detail), plus the flattened last text line underneath.
 * A running node with neither reads as thinking.
 */
export function LiveLine(props: { live: SidebarChildLiveView | undefined }): ReactNode {
  const { live } = props
  const activity = liveActivityLabel(live?.summary)
  if (activity === undefined && live?.text === undefined) {
    return <span className={css.nodeMeta}>{t('subagentThinking')}</span>
  }
  return (
    <>
      {activity !== undefined && (
        <span className={css.live}>
          <span className={css.liveGlyph} aria-hidden="true">{toolGlyph('bash')(9)}</span>
          <span className={css.liveTool} title={activity}>{activity}</span>
        </span>
      )}
      {live?.text !== undefined && (
        <span className={css.liveText}>{preview(flatten(live.text), TEXT_PREVIEW)}</span>
      )}
    </>
  )
}

/**
 * The fold aggregate's name line: two label previews, plus `+N` when the group
 * holds more.
 *
 * A roster aggregate can swallow dozens of members, and the card has one line
 * for them. Naming two and saying how many are left over is what keeps that
 * line honest at any size — the exact `+N` the team task line already uses,
 * not a second convention. The group's total is also on the badge and the bar,
 * so `+N` is a tail, never the only count.
 *
 * @param previews - member labels, in page order (see {@link TasksFoldNode.previews}).
 * @param count - how many members the group holds in total.
 */
export function foldPreviews(previews: readonly string[], count: number): string {
  const tail = count > previews.length ? ` +${count - previews.length}` : ''
  return `${previews.join(' / ')}${tail}`
}

/**
 * The fold aggregate's bar text.
 *
 * The two groups read differently on purpose. The `done` row counts its
 * finished members and calls out failures beside them (`✓ 4 已完成 · 出错 1`
 * — a row of nothing but failures is `出错 N`), because "✓ N 已完成" alone
 * would quietly include them. The `idle` row says what the members are doing
 * now: nothing (`N 待命`), which is why they were swept away.
 */
export function foldTally(node: TasksFoldNode): string {
  if (node.foldKind === 'idle') return t('tasksFoldIdle', { count: node.count })
  const parts: string[] = []
  if (node.doneCount > 0) parts.push(t('tasksFoldCompleted', { count: node.doneCount }))
  if (node.errorCount > 0) parts.push(`${t('tasksStateError')} ${node.errorCount}`)
  return parts.join(' · ')
}
