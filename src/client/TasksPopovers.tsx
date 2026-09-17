/**
 * The anchored-popover CONTENTS of the Tasks page (geometry and dismissal
 * live in AnchoredPopover): the agent node detail with a transcript jump and
 * the workflow run detail with clickable member rows.
 *
 * Visual language: the vendored shadcn/ui pieces (Card + Separator + Badge +
 * Button) over Tailwind utilities bound to the `--dsw-*` tokens. The surface
 * is flat — a 1px hairline plus the popover surface ladder carries the
 * layering; the only shadow is the one AnchoredPopover itself puts on the
 * floating card. Ink stays on three levels (foreground / muted-foreground /
 * foreground-3), mono meta is `font-mono tabular-nums`, and hue is semantic
 * only: success = settled, warning = blocked, destructive = failed, primary =
 * the one main action per popover.
 *
 * The team board is NOT here: it is always visible as a strip above the
 * canvas (TeamBoard.tsx).
 */
import type { ReactNode } from 'react'
import {
  IconBranchOutline16, IconRightUpOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSubagentAddress } from '../context-types.ts'
import type { TasksAgentNode, TasksWorkflowNode } from './tasks-model.ts'
import {
  flatten, nodeDotState, taskDotState, taskStatusKey, workflowStatusKey,
} from './tasks-shared.tsx'
import { t, type CopyKey } from './locales.ts'
import { Badge } from './ui/badge.tsx'
import { Button as UiButton } from './ui/button.tsx'
import { Card } from './ui/card.tsx'
import { Separator } from './ui/separator.tsx'

/** The workflow run status (the badge's semantic ink selector). */
type WorkflowStatus = TasksWorkflowNode['run']['status']

/** The display-state label key. */
function stateKey(state: TasksAgentNode['state']): CopyKey {
  switch (state) {
    case 'running': return 'tasksStateRunning'
    case 'idle': return 'tasksStateIdle'
    case 'done': return 'tasksStateDone'
    case 'error': return 'tasksStateError'
  }
}

/**
 * The semantic ink of one status word: settled = success, in progress = the
 * accent, blocked = warning, failed = destructive. The hue rides the text
 * only — the badge keeps a neutral outline, so a popover never turns into a
 * block of color.
 */
function statusTone(status: WorkflowStatus | 'pending' | 'in_progress' | 'completed'): string {
  if (status === 'completed') return 'text-success'
  if (status === 'running' || status === 'in_progress') return 'text-primary'
  if (status === 'pending') return 'text-muted-foreground'
  return 'text-destructive'
}

/** The popover's key/value grid (label left, value right, mono on request).
 *  The label column is a fixed 64px so every row's value starts on one axis —
 *  an `auto` column makes the labels ragged across rows. */
function PopRows(props: { children: ReactNode }): ReactNode {
  return <dl className="grid grid-cols-[64px_1fr] items-baseline gap-x-3 gap-y-1">{props.children}</dl>
}

/** One key/value row of a popover. */
function PopRow(props: { label: string; mono?: boolean; children: ReactNode }): ReactNode {
  return (
    <>
      <dt className="truncate text-xs text-foreground-3" title={props.label}>{props.label}</dt>
      <dd
        className={
          props.mono === true
            ? 'truncate text-right font-mono text-xs tabular-nums text-muted-foreground'
            : 'flex min-w-0 items-center justify-end gap-1.5 text-right text-xs'
        }
      >
        {props.children}
      </dd>
    </>
  )
}

/** The mono kicker above a popover list ("任务" / a phase title). */
function GroupLabel(props: { children: ReactNode }): ReactNode {
  return (
    <div className="px-1 pt-0.5 font-mono text-[11px] tracking-wide text-foreground-3 uppercase">
      {props.children}
    </div>
  )
}

/** One outlined status badge (neutral chrome, semantic ink only). */
function StatusBadge(props: { tone: string; children: ReactNode }): ReactNode {
  return <Badge variant="outline" className={`h-4 px-1.5 text-[11px] ${props.tone}`}>{props.children}</Badge>
}

/** The agent node detail popover. */
export function AgentNodePopover(props: {
  node: TasksAgentNode
  onJump(node: TasksAgentNode): void
  /** Open the shared task window for one of the node's tasks. */
  onOpenTask(taskId: string, anchor: HTMLElement): void
}): ReactNode {
  const { node, onJump, onOpenTask } = props
  const liveText = node.live?.text !== undefined ? flatten(node.live.text) : undefined
  const liveTool = node.live?.tool !== undefined
    ? `${node.live.tool.name}${node.live.tool.args === '' ? '' : ` ${node.live.tool.args}`}`
    : undefined
  const tasks = node.tasks ?? []
  return (
    // `dsw-tasks`: this card renders inside AnchoredPopover's portal at
    // document.body — OUTSIDE the page root — so it must re-declare the page
    // root class to pick up the scoped base reset the plugin ships instead of
    // preflight (see TaskWindow.tsx for the same pattern).
    <Card className="dsw-tasks gap-2 rounded-lg border-border bg-popover p-0 py-2.5">
      <div className="px-3 font-mono text-[11px] text-foreground-3">{t('tasksNodeDetail')}</div>
      <Separator />
      <div className="flex flex-col gap-1.5 px-3">
        <span className="truncate text-sm font-medium" title={node.label}>{node.label}</span>
        <PopRows>
          <PopRow label={t('tasksNodeState')}>
            <StateDot state={nodeDotState(node.state)} size={6} />
            <span className="text-muted-foreground">{t(stateKey(node.state))}</span>
          </PopRow>
          {node.mode !== undefined && (
            <PopRow label={t('tasksNodeMode')}>
              {node.mode === 'one-shot' ? t('subagentModeOneShot') : t('subagentModeContinuable')}
            </PopRow>
          )}
          {node.team !== undefined && (
            <PopRow label={t('tasksNodeTeamRole')}>
              {node.team.role === 'lead' ? 'lead' : node.team.name}
            </PopRow>
          )}
          {node.team?.model !== undefined && (
            <PopRow label={t('tasksNodeModel')} mono>{node.team.model}</PopRow>
          )}
          {(liveTool !== undefined || liveText !== undefined) && (
            <PopRow label={t('tasksNodeActivity')} mono>{liveTool ?? liveText}</PopRow>
          )}
        </PopRows>
        {liveText !== undefined && liveTool !== undefined && (
          <div className="line-clamp-2 text-xs text-muted-foreground" title={liveText}>{liveText}</div>
        )}
      </div>
      {tasks.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-1 px-3">
            <GroupLabel>{t('tasksNodeTasks')}</GroupLabel>
            <div className="-mx-1 flex max-h-[190px] flex-col gap-0.5 overflow-y-auto">
              {tasks.map(task => (
                <UiButton
                  key={task.id}
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start gap-1.5 rounded-sm px-1 py-1 text-left text-xs font-normal"
                  title={task.subject}
                  onClick={(event) => { onOpenTask(task.id, event.currentTarget) }}
                >
                  <StateDot state={taskDotState(task)} size={6} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.subject}</span>
                  <StatusBadge tone={statusTone(task.status)}>{t(taskStatusKey(task.status))}</StatusBadge>
                </UiButton>
              ))}
            </div>
          </div>
        </>
      )}
      {(node.childAddress !== undefined || node.parentId === undefined) && (
        <>
          {tasks.length > 0 && <Separator />}
          <UiButton size="sm" className="mx-3 w-auto" onClick={() => { onJump(node) }}>
            <IconRightUpOutline14 size={12} />
            {t('tasksNodeJump')}
          </UiButton>
        </>
      )}
    </Card>
  )
}

/** The workflow run detail popover (phases with clickable member rows). */
export function WorkflowNodePopover(props: {
  node: TasksWorkflowNode
  onJumpMember(address: SidebarSubagentAddress): void
}): ReactNode {
  const { node, onJumpMember } = props
  const { run } = node
  /** A member with no outcome yet still runs; only completed/failed settle. */
  const memberDot = (outcome: string | undefined): 'ongoing' | 'done' | 'error' | 'idle' => {
    if (outcome === undefined) return 'ongoing'
    if (outcome === 'completed') return 'done'
    if (outcome === 'failed') return 'error'
    return 'idle'
  }
  return (
    // `dsw-tasks`: same portal-scope reset as AgentNodePopover above.
    <Card className="dsw-tasks gap-2 rounded-lg border-border bg-popover p-0 py-2.5">
      <div className="px-3 font-mono text-[11px] text-foreground-3">{t('workflowRun')}</div>
      <Separator />
      <div className="flex flex-col gap-1.5 px-3">
        <div className="flex min-w-0 items-center gap-1.5" title={run.name}>
          <span className="flex-none text-muted-foreground" aria-hidden="true">
            <IconBranchOutline16 size={12} />
          </span>
          <span className="truncate text-sm font-medium">{run.name}</span>
        </div>
        <PopRows>
          <PopRow label={t('tasksNodeState')}>
            <StatusBadge tone={statusTone(run.status)}>{t(workflowStatusKey(run.status))}</StatusBadge>
          </PopRow>
        </PopRows>
      </div>
      {run.phases.length > 0 && (
        <>
          <Separator />
          <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto px-3">
            {run.phases.map((phase, phaseIndex) => (
              <div key={`${phase.title ?? 'phase'}-${phaseIndex}`} className="flex flex-col gap-0.5">
                <GroupLabel>{phase.title ?? t('workflowPhaseUnnamed')}</GroupLabel>
                {phase.members.length === 0 && (
                  <div className="px-1 py-1 text-xs text-foreground-3">{t('subagentEmpty')}</div>
                )}
                {phase.members.map(member => (
                  <div
                    key={member.seq}
                    role={member.childId === '' ? undefined : 'button'}
                    className={
                      member.childId === ''
                        ? 'flex items-center gap-1.5 rounded-sm px-1 py-1'
                        : 'flex cursor-pointer items-center gap-1.5 rounded-sm px-1 py-1 transition-colors hover:bg-muted'
                    }
                    title={member.label}
                    onClick={() => {
                      if (member.childId === '') return
                      onJumpMember({
                        parentSessionId: run.originSessionId,
                        childSessionId: member.childId,
                        mode: 'one-shot',
                      })
                    }}
                  >
                    <StateDot size={6} state={memberDot(member.outcome)} />
                    <span className="min-w-0 flex-1 truncate text-xs">{member.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
