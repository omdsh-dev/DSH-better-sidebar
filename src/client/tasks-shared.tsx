/**
 * Shared presentation bits of the Tasks page's two modes (graph + tree): the
 * state-dot mapping, the SHORT mono meta line (one or two tokens — the card
 * is 132px wide in the narrow native sidebar, so anything longer moves into
 * the ⓘ popover), the iconified live activity row ("glyph + tool + args",
 * the approved format), and the fold aggregate caption.
 *
 * Card content contract (the page's answer to "everything is ellipsized"):
 *   line 1  dot + name            (11px, semibold, one line)
 *   line 2  mode/model · activity (9px mono, one line)
 *   line 3  live line             (running nodes only)
 * Everything else — display title, full model id, team role, phase names,
 * latest output text, jump action — lives in the anchored popover.
 */
import type { ReactNode } from 'react'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LastActivity } from '../subagent-activity.ts'
import type { TasksAgentNode, TasksNodeState, TasksWorkflowNode } from './tasks-model.ts'
import { toolGlyph } from './tool-icons.tsx'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** Preview cap of one tool-call argument line. */
const ARGS_PREVIEW = 42
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

/** First `limit` characters with an ellipsis when truncated. */
export function preview(text: string, limit: number = ARGS_PREVIEW): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Collapse whitespace for single-line previews. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
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

/**
 * The live activity row of a RUNNING agent: "glyph + tool + args" (the
 * approved format), plus the flattened last text line underneath. A running
 * node with neither reads as thinking.
 */
export function LiveLine(props: { live: LastActivity | undefined }): ReactNode {
  const { live } = props
  if (live?.text === undefined && live?.tool === undefined) {
    return <span className={css.nodeMeta}>{t('subagentThinking')}</span>
  }
  return (
    <>
      {live.tool !== undefined && (
        <span className={css.live}>
          <span className={css.liveGlyph} aria-hidden="true">{toolGlyph(live.tool.name)(8)}</span>
          <span className={css.liveTool}>{live.tool.name}</span>
          {live.tool.args !== '' && <span className={css.liveArgs}>{preview(live.tool.args)}</span>}
        </span>
      )}
      {live.text !== undefined && (
        <span className={css.liveText}>{preview(flatten(live.text), TEXT_PREVIEW)}</span>
      )}
    </>
  )
}

/** The fold aggregate's subtitle: up to two label previews joined by ·. */
export function foldPreviews(previews: readonly string[]): string {
  return previews.join(' / ')
}
