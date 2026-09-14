/**
 * The anchored-popover CONTENTS of the Tasks page (geometry and dismissal
 * live in AnchoredPopover): the agent node detail with a transcript jump and
 * the workflow run detail with clickable member rows. Both follow the mockup
 * grammar — a letter-spaced uppercase head, a dt/dd key/value grid, and one
 * full-width jump action. The team board is NOT here: it is always visible as
 * a strip above the canvas (TeamBoard.tsx).
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSubagentAddress } from '../context-types.ts'
import type { TasksAgentNode, TasksWorkflowNode } from './tasks-model.ts'
import { flatten, nodeDotState, workflowStatusKey } from './tasks-shared.tsx'
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

/** The agent node detail popover. */
export function AgentNodePopover(props: {
  node: TasksAgentNode
  onJump(node: TasksAgentNode): void
}): ReactNode {
  const { node, onJump } = props
  const liveText = node.live?.text !== undefined ? flatten(node.live.text) : undefined
  const liveTool = node.live?.tool !== undefined
    ? `${node.live.tool.name}${node.live.tool.args === '' ? '' : ` ${node.live.tool.args}`}`
    : undefined
  return (
    <div className={css.popCard}>
      <div className={css.popHead}>
        <span>{t('tasksNodeDetail')}</span>
      </div>
      <span className={css.popTitle} title={node.label}>{node.label}</span>
      <PopRows>
        <PopRow label={t('tasksNodeState')}>
          <StateDot state={nodeDotState(node.state)} size={6} /> {t(stateKey(node.state))}
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
        <div className={css.popHint}>{liveText}</div>
      )}
      {(node.childAddress !== undefined || node.parentId === undefined) && (
        <button type="button" className={css.popPrimary} onClick={() => { onJump(node) }}>
          {t('tasksNodeJump')}
        </button>
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
  return (
    <div className={css.popCard}>
      <div className={css.popHead}>
        <span>{t('workflowRun')}</span>
      </div>
      <span className={css.popTitle} title={run.name}>▶ {run.name}</span>
      <PopRows>
        <PopRow label={t('tasksNodeState')}>{t(workflowStatusKey(run.status))}</PopRow>
      </PopRows>
      <div className={css.popSection}>
        <div className={css.popList}>
          {run.phases.map((phase, phaseIndex) => (
            <div key={`${phase.title ?? 'phase'}-${phaseIndex}`}>
              <div className={css.popGroup}>{phase.title ?? t('workflowPhaseUnnamed')}</div>
              {phase.members.map(member => (
                <div
                  key={member.seq}
                  role={member.childId === '' ? undefined : 'button'}
                  className={css.popListRow}
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
                  <StateDot
                    size={6}
                    state={member.outcome === undefined
                      ? 'ongoing'
                      : member.outcome === 'completed' ? 'done'
                        : member.outcome === 'failed' ? 'error' : 'idle'}
                  />
                  <span className={css.popListLabel}>{member.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
