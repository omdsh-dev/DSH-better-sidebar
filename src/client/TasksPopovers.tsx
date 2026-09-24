/**
 * The anchored-popover CONTENTS of the Tasks page (geometry and dismissal
 * live in AnchoredPopover): the agent node detail with a transcript jump and
 * the workflow run detail with clickable member rows. Both share one grammar:
 * a letter-spaced uppercase head, a dt/dd key/value grid, a titled well and
 * one full-width jump action.
 *
 * The two cards are ONE skeleton: the same head band, the same [glyph][title]
 * title row (the card's own host glyph, never a typed character), the same
 * inset list well of 28px rows, and one l1 hairline around whatever closes the
 * card. The only intended difference is where a group header sits: a single
 * list keeps its label fixed above the well, while a multi-phase run scrolls
 * each phase label with its own rows.
 *
 * Every control is a host primitive (`Button` / `StateDot` / `Tag`) — a row
 * that opens something IS a `<button>`, so it is keyboard reachable — and the
 * boxes around them are the page's own module classes (`popCard`, `popRows`,
 * `popList*`). The card is the portal's content root, so it paints the floating
 * surface itself: the popover shell only positions the box it portals.
 *
 * A member row with a child session jumps to that transcript; a member without
 * one (a declaration that never spawned) stays a plain tally line.
 *
 * The team board is NOT here: it is always visible as a strip above the
 * canvas (TeamBoard.tsx).
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRightUpOutlineRegular, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSubagentAddress } from '../context-types.ts'
import type { TasksAgentNode, TasksWorkflowNode } from './tasks-model.ts'
import {
  AgentGlyph, WorkflowGlyph, flatten, modeLabel, nodeDotState, taskDotState, taskStatusKey, workflowStatusKey,
} from './tasks-shared.tsx'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** The display-state label key. */
function stateKey(state: TasksAgentNode['state']): CopyKey {
  switch (state) {
    case 'running': return 'tasksStateRunning'
    case 'idle': return 'tasksStateIdle'
    case 'done': return 'tasksStateDone'
    case 'error': return 'tasksStateError'
  }
}

/** The popover's key/value grid. */
function PopRows(props: { children: ReactNode }): ReactNode {
  return <dl className={css.popRows}>{props.children}</dl>
}

/** One key/value row of a popover. */
function PopRow(props: { label: string; mono?: boolean; children: ReactNode }): ReactNode {
  return (
    <>
      <dt className={css.popKey}>{props.label}</dt>
      <dd className={clsx(css.popValue, props.mono === true && css.popValueMono)}>{props.children}</dd>
    </>
  )
}

/** The title row both popovers open with: the card's host glyph, then the name. */
function PopTitleRow(props: { glyph: ReactNode; title: string }): ReactNode {
  return (
    <div className={css.popTitleRow}>
      <span className={css.popGlyph} aria-hidden="true">{props.glyph}</span>
      <span className={css.popTitle} title={props.title}>{props.title}</span>
    </div>
  )
}

/** The agent node detail popover. */
export function AgentNodePopover(props: {
  node: TasksAgentNode
  onJump(node: TasksAgentNode): void
  /** Open the shared task window for one of the node's tasks. */
  onOpenTask(taskId: string, anchor: HTMLElement): void
}): ReactNode {
  const { node, onJump, onOpenTask } = props
  /** The row's mode word; `unknown` claims no mode and this row is omitted. */
  const nodeMode = modeLabel(node.mode)
  const liveText = node.live?.text !== undefined ? flatten(node.live.text) : undefined
  const liveTool = node.live?.tool !== undefined
    ? `${node.live.tool.name}${node.live.tool.args === '' ? '' : ` ${node.live.tool.args}`}`
    : undefined
  return (
    <div className={css.popCard}>
      <div className={css.popHead}>
        <span>{t('tasksNodeDetail')}</span>
      </div>
      <PopTitleRow glyph={<AgentGlyph node={node} />} title={node.label} />
      <PopRows>
        <PopRow label={t('tasksNodeState')}>
          <StateDot state={nodeDotState(node.state)} size={6} /> {t(stateKey(node.state))}
        </PopRow>
        {nodeMode !== undefined && (
          <PopRow label={t('tasksNodeMode')}>{nodeMode}</PopRow>
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
        <div className={css.popHint}>{liveText}</div>
      )}
      {(node.tasks?.length ?? 0) > 0 && (
        <div className={css.popSection}>
          <div className={css.popGroup}>{t('tasksNodeTasks')}</div>
          <div className={css.popList}>
            {(node.tasks ?? []).map(task => (
              // The whole row opens the shared task window.
              <Button
                key={task.id}
                variant="ghost"
                size="sm"
                className={css.popListRow}
                title={task.subject}
                onClick={(event) => { onOpenTask(task.id, event.currentTarget) }}
              >
                <StateDot state={taskDotState(task)} size={6} />
                <span className={css.popListLabel}>{task.subject}</span>
                <Tag tone={task.status === 'completed' ? 'success' : task.ready ? 'info' : 'warning'}>
                  {t(taskStatusKey(task.status))}
                </Tag>
              </Button>
            ))}
          </div>
        </div>
      )}
      {(node.childAddress !== undefined || node.parentId === undefined) && (
        <div className={css.popFoot}>
          <Button
            variant="primary"
            size="sm"
            icon={<IconRightUpOutlineRegular size={12} />}
            onClick={() => { onJump(node) }}
          >
            {t('tasksNodeJump')}
          </Button>
        </div>
      )}
    </div>
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
    <div className={css.popCard}>
      <div className={css.popHead}>
        <span>{t('workflowRun')}</span>
      </div>
      <PopTitleRow glyph={<WorkflowGlyph />} title={run.name} />
      <PopRows>
        <PopRow label={t('tasksNodeState')}>{t(workflowStatusKey(run.status))}</PopRow>
      </PopRows>
      {run.phases.length > 0 && (
        <div className={css.popSection}>
          <div className={css.popList}>
            {run.phases.map((phase, phaseIndex) => (
              <div key={`${phase.title ?? 'phase'}-${phaseIndex}`}>
                <div className={css.popGroup}>{phase.title ?? t('workflowPhaseUnnamed')}</div>
                {phase.members.length === 0 && (
                  <div className={css.popHint}>{t('subagentEmpty')}</div>
                )}
                {phase.members.map(member => {
                  const body = (
                    <>
                      <StateDot size={6} state={memberDot(member.outcome)} />
                      <span className={css.popListLabel}>{member.label}</span>
                    </>
                  )
                  // A member row IS a jump affordance when it has a child
                  // session (a real button, so it is keyboard reachable);
                  // without one it stays a plain tally line.
                  return member.childId === ''
                    ? (
                      <div key={member.seq} className={css.popListRow} title={member.label}>{body}</div>
                    )
                    : (
                      <Button
                        key={member.seq}
                        variant="ghost"
                        size="sm"
                        className={css.popListRow}
                        title={member.label}
                        onClick={() => {
                          onJumpMember({
                            parentSessionId: run.originSessionId,
                            childSessionId: member.childId,
                            mode: 'one-shot',
                          })
                        }}
                      >
                        {body}
                      </Button>
                    )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
