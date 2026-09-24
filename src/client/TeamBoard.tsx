/**
 * The Agent Teams board — ALWAYS VISIBLE under the page header whenever the
 * tree's root leads a team. Every control is a host primitive (Menu / Pill /
 * Tag / Button / StateDot); the page ships no native form control of its own.
 *
 * Layout: the strip is full width because the native sidebar is narrow — a
 * member row of Pills (also the owner filter), then task rows (subject +
 * owner + status Tag + ONE overflow Menu).
 *
 * Readability: the four blocks (bar / filters / rows / footer) share one 12px
 * gutter and one 6px vertical beat, divided by the 1px l1 rules the stylesheet
 * draws; a row sits on the 28px rhythm and every line that can be ellipsised
 * (subject, owner) carries its full text as `title`.
 *
 * Behaviour: a row and EVERY entry of its menu open the shared task window,
 * which is the ONE surface owning view / edit / create and every CAS mutation
 * — the menu is that window's affordance list hoisted onto the row, not a
 * second mutation path. A conflict therefore still surfaces in the window and
 * re-syncs through the parent's poller.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChecklistOutlineRegular, IconCheckOutlineRegular, IconChevronUpOutlineRegular, IconEditOutlineRegular,
  IconEllipsisOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular,
  IconUserOutlineRegular, Menu, Pill, StateDot, Tag,
  type MenuEntry, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** The task status label key. */
function taskStatusKey(status: SidebarTeamTaskView['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
    case 'deleted': return 'teamTaskDeleted'
  }
}

/** The status Tag tone of one task. */
function taskTone(task: SidebarTeamTaskView): TagTone {
  if (task.status === 'completed') return 'success'
  if (!task.ready) return 'warning'
  return task.status === 'in_progress' ? 'info' : 'neutral'
}

/**
 * One task's row menu: the shared task window's own affordance list hoisted
 * onto the row — complete (or reopen, once completed), edit, reassign the
 * owner, delete. Every entry opens that window rather than mutating anything,
 * so the labels mirror the window's actions and the delete stays NEUTRAL: it
 * does not delete, it opens the surface whose own delete is the two-step
 * confirm (a permanently red row would over-signal).
 *
 * The owner submenu lists TEAMMATES only — a shared task is handed to a
 * worker, not back to the lead (the member chips above still list everyone).
 */
function taskMenuItems(
  task: SidebarTeamTaskView,
  teammates: readonly SidebarTeamMemberView[],
): MenuEntry[] {
  const completed = task.status === 'completed'
  return [
    {
      id: 'state',
      label: t(completed ? 'teamTaskReopen' : 'teamTaskComplete'),
      icon: completed ? <IconRefreshOutlineRegular size={14} /> : <IconCheckOutlineRegular size={14} />,
    },
    { id: 'edit', label: t('teamTaskEdit'), icon: <IconEditOutlineRegular size={14} /> },
    {
      id: 'owner',
      label: t('teamTaskOwner'),
      icon: <IconUserOutlineRegular size={14} />,
      submenu: [
        { id: 'owner:', label: t('teamTaskUnowned') },
        ...teammates.map(member => ({ id: `owner:${member.name}`, label: member.name })),
      ],
    },
    { type: 'separator', id: 'team-task-sep' },
    { id: 'delete', label: t('teamTaskDelete'), icon: <IconTrashOutlineRegular size={14} /> },
  ]
}

/**
 * One board row: state dot, subject, owner, status Tag, and the row's overflow
 * Menu.
 *
 * The press target is a real `<button>` covering the row (the whole row opens
 * the shared task window) and the Menu is its SIBLING — a control may not nest
 * inside another, and the trigger is the only part of the row that belongs to
 * the menu. The row node is held in a ref so a menu pick can hand a MOUNTED
 * anchor to the window: the menu list is portaled and unmounts the moment an
 * entry is picked, while the window measures its anchor on mount.
 */
function TeamTaskRow(props: {
  task: SidebarTeamTaskView
  teammates: readonly SidebarTeamMemberView[]
  onOpenTask(task: SidebarTeamTaskView, anchor: HTMLElement): void
}): ReactNode {
  const { task, teammates, onOpenTask } = props
  const [menuOpen, setMenuOpen] = useState(false)
  /** The row itself: the anchor every window opened from this row shares. */
  const rowRef = useRef<HTMLDivElement>(null)
  /** Every entry lands on the same surface (the window owns the actions). */
  const openWindow = (): void => {
    const row = rowRef.current
    if (row !== null) onOpenTask(task, row)
  }

  return (
    // The row is a flex line so the trailing Menu can sit beside the press
    // target (`.teamTaskRow`).
    <div ref={rowRef} className={css.teamTaskRow}>
      <Button
        variant="ghost"
        size="sm"
        className={css.teamTask}
        aria-label={`${t('teamTaskDetail')} ${task.subject}`}
        title={t('teamTaskDetail')}
        onClick={(event) => { onOpenTask(task, event.currentTarget) }}
      >
        <StateDot
          size={6}
          state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'}
        />
        <span className={css.teamTaskSubject} title={task.subject}>{task.subject}</span>
        {task.ownerName !== undefined && (
          <span className={css.teamTaskOwner} title={task.ownerName}>{task.ownerName}</span>
        )}
        <Tag tone={taskTone(task)}>
          {t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')}
        </Tag>
      </Button>
      <Menu
        open={menuOpen}
        onClose={() => { setMenuOpen(false) }}
        items={taskMenuItems(task, teammates)}
        onSelect={() => {
          setMenuOpen(false)
          openWindow()
        }}
        align="end"
        portal
        compact
        anchor={(
          <Button
            variant="ghost"
            size="sm"
            icon={<IconEllipsisOutlineRegular size={13} />}
            aria-label={`${t('teamTaskActions')} ${task.subject}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t('teamTaskActions')}
            onClick={() => { setMenuOpen(current => !current) }}
          />
        )}
      />
    </div>
  )
}

export interface TeamBoardProps {
  rootId: string
  members: readonly SidebarTeamMemberView[]
  tasks: readonly SidebarTeamTaskView[]
  /** Open the shared task window (undefined = create) anchored at the click. */
  onOpenTask(task: SidebarTeamTaskView | undefined, anchor: HTMLElement): void
  /** The strip's own collapse state (the reader's choice, remembered while mounted). */
  collapsed: boolean
  onToggleCollapsed(): void
}

export function TeamBoard(props: TeamBoardProps): ReactNode {
  const { members, tasks, onOpenTask, collapsed, onToggleCollapsed } = props
  const [ownerFilter, setOwnerFilter] = useState<string | undefined>(undefined)

  const live = useMemo(() => tasks.filter(task => task.status !== 'deleted'), [tasks])
  const shown = useMemo(
    () => live.filter(task => ownerFilter === undefined || task.ownerName === ownerFilter),
    [live, ownerFilter],
  )
  const teammates = useMemo(() => members.filter(member => member.role === 'teammate'), [members])

  return (
    <section className={css.teamBoard} aria-label={t('teamBoard')}>
      <button
        type="button"
        className={css.teamBoardBar}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        <span className={css.teamBoardIcon} aria-hidden="true"><IconChecklistOutlineRegular size={11} /></span>
        <span>{t('teamBoard')}</span>
        <span className={css.teamBoardCount}>
          {t('teamChip', { members: members.length, tasks: live.length })}
        </span>
        <span
          className={css.teamBoardChev}
          style={{ display: 'inline-flex', transform: collapsed ? undefined : 'rotate(180deg)' }}
          aria-hidden="true"
        >
          <IconChevronUpOutlineRegular size={12} />
        </span>
      </button>
      {!collapsed && (
        <>
          <div className={css.teamMembers}>
            <Pill
              active={ownerFilter === undefined}
              onClick={() => { setOwnerFilter(undefined) }}
            >
              {t('teamFilterAll')}
            </Pill>
            {members.map(member => (
              <Pill
                key={member.id}
                active={ownerFilter === member.name}
                title={`${member.name} · ${member.role}`}
                onClick={() => {
                  setOwnerFilter(current => (current === member.name ? undefined : member.name))
                }}
              >
                <StateDot
                  size={6}
                  state={member.status === 'running' || member.status === 'provisioning'
                    ? 'ongoing'
                    : member.status === 'failed' ? 'error' : 'idle'}
                />
                <span className={css.teamMemberName}>{member.name}</span>
              </Pill>
            ))}
          </div>
          <div className={css.teamTasks}>
            {shown.length === 0 && <div className={css.teamEmpty}>{t('teamTasksEmpty')}</div>}
            {shown.map(task => (
              <TeamTaskRow
                key={task.id}
                task={task}
                teammates={teammates}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
          <div className={css.teamActions}>
            <Button
              variant="outline"
              size="sm"
              icon={<IconPlusOutlineRegular size={13} />}
              onClick={(event) => { onOpenTask(undefined, event.currentTarget) }}
            >
              {t('teamTaskCreate')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
