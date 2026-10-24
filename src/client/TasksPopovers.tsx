/**
 * The anchored-popover CONTENTS of the Tasks page (geometry and dismissal
 * live in AnchoredPopover): the agent node detail with a transcript jump and
 * the workflow run detail with clickable member rows. Both share one grammar:
 * a letter-spaced uppercase head, a [glyph][title] title row, a dt/dd
 * key/value grid, a titled well and one full-width jump action.
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
import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, IconRightUpOutlineRegular, MenuSurface, StateDot, Tag,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSubagentAddress, SidebarTokenUsage } from '../context-types.ts'
import type { TasksAgentNode, TasksWorkflowNode } from './tasks-model.ts'
import type { ContextDiagnosticTarget } from './context-diagnostics.ts'
import { ContextDiagnosticsButton, diagnosticAddressOf } from './context-diagnostics-ui.tsx'
import {
  activityLine, AgentGlyph, WorkflowGlyph, flatten, modeLabel, nodeDotState, taskDotState,
  taskStatusLabel, taskTone, workflowStatusKey,
} from './tasks-shared.tsx'
import { elapsedMs, totalTokens } from './session-metrics.ts'
import { formatJobDuration } from './subagent-jobs.ts'
import { formatTokens } from './sidechat-transcript.ts'
import { chatT, t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/**
 * The usage row's tooltip: the four buckets the host bills separately, in the
 * host's own words (the `chat` namespace's usage dialog). Undefined when that
 * wording is unavailable — an empty `title` would still swallow the hover.
 */
function usageTitle(usage: SidebarTokenUsage): string | undefined {
  const buckets: [string | undefined, number][] = [
    [chatT('message.turnUsage.input'), usage.uncachedInputTokens],
    [chatT('message.turnUsage.cacheRead'), usage.cacheReadTokens],
    [chatT('message.turnUsage.cacheWrite'), usage.cacheWriteTokens],
    [chatT('message.turnUsage.output'), usage.outputTokens],
  ]
  const parts = buckets
    .filter(([label]) => label !== undefined)
    .map(([label, count]) => `${label ?? ''} ${formatTokens(count)}`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

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

/**
 * The transcript jump, offered the way the host's own subagent list offers it:
 * the primary action opens the child's transcript in the NATIVE right sidebar
 * (the `subagentchat` tab type — the page never re-implements a transcript
 * pane), and the caret beside it opens the main window instead.
 *
 * The ROOT node has no child to embed — it IS the main session — and a host
 * without the `subagentchat` type has no sidebar to open into, so both keep the
 * single button.
 *
 * The optional `children` slot carries the card's OTHER footer control (the
 * diagnostics jump): the two live in one row so the card still has exactly one
 * action band, and the split's own box stays fixed-width beside it.
 */
function JumpActions(props: {
  node: TasksAgentNode
  asideAvailable: boolean
  onJump(node: TasksAgentNode, place: 'side' | 'main'): void
  children?: ReactNode
}): ReactNode {
  const { node, asideAvailable, onJump } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  useDismissOnOutsidePointer(rootRef, open, setOpen)
  const split = asideAvailable && node.childAddress !== undefined
  const primaryPlace = split ? 'side' : 'main'
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        icon={<IconRightUpOutlineRegular size={12} />}
        onClick={() => { onJump(node, primaryPlace) }}
      >
        {t('tasksNodeJump')}
      </Button>
      {split && (
        <span className={css.jumpMore} ref={rootRef}>
          <Button
            variant="primary"
            size="sm"
            className={css.jumpMoreButton}
            aria-label={t('tasksNodeOpenMain')}
            aria-haspopup="menu"
            aria-expanded={open}
            title={t('tasksNodeOpenMain')}
            onClick={() => { setOpen(current => !current) }}
          >
            {/*
              The split's caret, the same split the host's own jump control
              shows: the glyph names the MENU it opens, never the primary
              action beside it.
            */}
            <IconChevronDownOutlineRegular size={12} />
          </Button>
          {open && (
            <MenuSurface compact className={css.jumpMenu} role="menu">
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className={css.jumpMenuItem}
                onClick={() => {
                  setOpen(false)
                  onJump(node, 'main')
                }}
              >
                {t('tasksNodeOpenMain')}
              </Button>
            </MenuSurface>
          )}
        </span>
      )}
      {props.children}
    </>
  )
}

/**
 * The agent node detail popover.
 *
 * The merged activity is a SUBTITLE, not a fact: it sits under the title in
 * the card's smallest voice instead of filling a row of the key/value grid
 * (where the right-aligned value column ellipsised it at 280px and the label
 * "最近活动" spent a third of the width saying what the position already says).
 * With no process data at all the block renders nothing — a settled node must
 * never claim to be analysing a request.
 */
export function AgentNodePopover(props: {
  node: TasksAgentNode
  /**
   * Whether the host can host a child transcript in its right column. Without
   * it (no `subagentchat` tab type, no right column) the footer is a single
   * main-view button — the choice simply does not exist.
   */
  asideAvailable: boolean
  onJump(node: TasksAgentNode, place: 'side' | 'main'): void
  /** Open the shared task window for one of the node's tasks. */
  onOpenTask(taskId: string, anchor: HTMLElement): void
  onClose(): void
}): ReactNode {
  const { node, onJump, onOpenTask } = props
  /** The row's mode word; `unknown` claims no mode and this row is omitted. */
  const nodeMode = modeLabel(node.mode)
  const liveText = node.live?.text !== undefined ? flatten(node.live.text) : undefined
  /** Tokens the node's own session was billed for (host projection). */
  const usage = node.metrics?.usage
  /**
   * How long it worked. Read per render on purpose: the page re-reads its live
   * snapshot every 3s, which is also the cadence at which a running node's open
   * turn grows (the projection's `through` only moves when an event commits).
   */
  const elapsed = elapsedMs(node.metrics?.timing, Date.now())
  const usageTip = usage === undefined ? undefined : usageTitle(usage)
  // The merged activity the main conversation would show for this node's
  // newest range — the host's own wording, in its running or settled form
  // (see activityLine).
  const activity = activityLine(node)
  /**
   * The diagnostics jump's address: a child node carries the durable
   * parent/child address its catalog row built, and the ROOT node has none —
   * it IS the tree's main session — so it is addressed by its own session id.
   * A node whose address is incomplete (a stale parent, a synthesized member)
   * yields no diagnostics control; the transcript's original footer gate is
   * independent of this optional integration.
   */
  const diagnosticsAddress = node.parentId === undefined
    ? undefined
    : diagnosticAddressOf(node.id, node.childAddress)
  const diagnosticsUsable = node.parentId === undefined ? true : diagnosticsAddress !== undefined
  const diagnosticsTarget: ContextDiagnosticTarget | undefined = diagnosticsUsable
    ? { sessionId: node.id, label: node.label, ...(diagnosticsAddress === undefined ? {} : { address: diagnosticsAddress }) }
    : undefined
  return (
    <div className={css.popCard}>
      <div className={css.popHead}>
        <span>{t('tasksNodeDetail')}</span>
      </div>
      <PopTitleRow glyph={<AgentGlyph node={node} />} title={node.label} />
      {(activity !== undefined || liveText !== undefined) && (
        <div className={css.popActivityBlock} data-node-activity>
          {activity !== undefined && (
            <span className={css.popActivity} title={activity}>{activity}</span>
          )}
          {liveText !== undefined && (
            <span className={css.popHint} title={liveText}>{liveText}</span>
          )}
        </div>
      )}
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
        {/*
          What the node SPENT and how long it worked: both come from the host's
          session projections, and either row is omitted when the host published
          nothing — a "0 tok / 0s" line would claim measurements we do not have.
        */}
        {usage !== undefined && (
          <PopRow label={t('tasksNodeTokens')}>
            <span {...(usageTip === undefined ? {} : { title: usageTip })}>
              {formatTokens(totalTokens(usage))}
            </span>
          </PopRow>
        )}
        {elapsed !== undefined && (
          <PopRow label={t('tasksNodeDuration')}>
            {formatJobDuration(elapsed, t)}
          </PopRow>
        )}
      </PopRows>
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
                <Tag tone={taskTone(task)}>{taskStatusLabel(task)}</Tag>
              </Button>
            ))}
          </div>
        </div>
      )}
      {(node.childAddress !== undefined || node.parentId === undefined) && (
        <div className={css.popFoot}>
          <JumpActions
            node={node}
            asideAvailable={props.asideAvailable}
            onJump={onJump}
          >
            <ContextDiagnosticsButton kind="agent" target={diagnosticsTarget} iconSize={14} className={css.popActionIcon} onNavigate={props.onClose} />
          </JumpActions>
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
