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
 *
 * Visual language: Tailwind utilities over the shadcn tokens
 * (src/client/ui/theme.css) — mono meta is `font-mono tabular-nums`, ink stays
 * on the three token levels, and color is semantic only (running = primary,
 * done = success, blocked = warning; errors only exist on nodes).
 */
import type { ReactNode } from 'react'
import {
  IconAgentPresetOutline16, IconBranchOutline16, IconChecklistOutline14, IconUserOutline16,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LastActivity } from '../subagent-activity.ts'
import type { TasksAgentNode, TasksNodeState, TasksNodeTask, TasksWorkflowNode } from './tasks-model.ts'
import { toolGlyph } from './tool-icons.tsx'
import { t, type CopyKey } from './locales.ts'

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

/** The task status label key. */
export function taskStatusKey(status: TasksNodeTask['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
  }
}

/** The host StateDot semantic of a task row/line. */
export function taskDotState(task: TasksNodeTask): StateDotState {
  if (task.status === 'completed') return 'done'
  return task.ready ? 'ongoing' : 'warning'
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
  if (props.node.team?.role === 'teammate') return <IconUserOutline16 size={size} />
  return <IconAgentPresetOutline16 size={size} />
}

/** The workflow-run glyph. */
export function WorkflowGlyph(props: { size?: number }): ReactNode {
  return <IconBranchOutline16 size={props.size ?? 11} />
}

/** The fold aggregate glyph. */
export function FoldGlyph(props: { size?: number }): ReactNode {
  return <IconChecklistOutline14 size={props.size ?? 11} />
}

/**
 * The mono meta line of an agent card — at most two short tokens:
 * - the topology root: 主代理 · 状态
 * - a teammate with a known model: 模型 · 状态
 * - any other agent: 模式 · 状态
 */
export function agentMeta(node: TasksAgentNode): string {
  const state = stateLabel(node.state)
  if (node.parentId === undefined) return `${t('subagentMainAgent')} · ${state}`
  if (node.team?.role === 'teammate' && node.team.model !== undefined && node.team.model !== '') {
    return `${node.team.model} · ${state}`
  }
  if (node.mode !== undefined) {
    return `${node.mode === 'one-shot' ? t('subagentModeOneShot') : t('subagentModeContinuable')} · ${state}`
  }
  return state
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
 * The status word's semantic ink: done = success, in progress = primary,
 * blocked = warning, anything else stays a plain meta token. No hue is used
 * as decoration — the card stays quiet when many nodes are on screen.
 */
function taskTone(task: TasksNodeTask): string {
  if (task.status === 'completed') return 'text-success'
  if (task.status === 'in_progress') return 'text-primary'
  return task.ready ? 'text-muted-foreground' : 'text-warning'
}

/**
 * The node's shared-task line: an icon, the primary task's subject, its
 * status word, and a `+N` tail when the agent owns more. Renders nothing
 * without tasks, so non-team nodes keep the three-line shape.
 *
 * The whole line is one inline hover slab (`hover:bg-muted`) that opens the
 * task window; it stops the click from reaching the node behind it, which is
 * the node's own detail affordance, not this one.
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
      className="group -mx-1 mt-1 flex min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring"
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
      <span className="flex-none" aria-hidden="true"><IconChecklistOutline14 size={11} /></span>
      <span className="min-w-0 flex-1 truncate group-hover:text-foreground">{primary.subject}</span>
      <span className={`flex-none font-mono tabular-nums ${taskTone(primary)}`}>{t(taskStatusKey(primary.status))}</span>
      {tasks.length > 1 && (
        <span className="flex-none rounded-sm border border-border px-1 font-mono tabular-nums text-foreground-3">{`+${tasks.length - 1}`}</span>
      )}
    </span>
  )
}

/**
 * The live activity row of a RUNNING agent: the tool's own icon + tool name +
 * args (the approved format), plus the flattened last text line underneath.
 * A running node with neither reads as thinking. Running ink is the accent
 * (primary); the args/text tails drop to the secondary token.
 */
export function LiveLine(props: { live: LastActivity | undefined }): ReactNode {
  const { live } = props
  if (live?.text === undefined && live?.tool === undefined) {
    return (
      <span className="mt-0.5 truncate font-mono text-xs tabular-nums text-muted-foreground">
        {t('subagentThinking')}
      </span>
    )
  }
  return (
    <>
      {live.tool !== undefined && (
        <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate font-mono text-xs tabular-nums text-primary">
          <span className="flex size-3 flex-none items-center justify-center rounded-sm border border-current" aria-hidden="true">
            {toolGlyph(live.tool.name)(9)}
          </span>
          <span className="flex-none">{live.tool.name}</span>
          {live.tool.args !== '' && (
            <span className="min-w-0 truncate text-muted-foreground">{preview(live.tool.args)}</span>
          )}
        </span>
      )}
      {live.text !== undefined && (
        <span className="mt-0.5 truncate font-mono text-xs tabular-nums text-muted-foreground">
          {preview(flatten(live.text), TEXT_PREVIEW)}
        </span>
      )}
    </>
  )
}

/** The fold aggregate's subtitle: up to two label previews joined by ·. */
export function foldPreviews(previews: readonly string[]): string {
  return previews.join(' / ')
}
