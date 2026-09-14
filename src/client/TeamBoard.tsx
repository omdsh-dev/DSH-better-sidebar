/**
 * The Agent Teams board — ALWAYS VISIBLE under the page header whenever the
 * tree's root leads a team (the explicit review ask: the board must not hide
 * behind a chip). It is a full-width strip, not a side rail, because the
 * native sidebar is narrow (~360px): members wrap as chips and the task list
 * scrolls inside a bounded height, so the canvas keeps its room.
 *
 * Mutations are CAS: every action sends the task's CURRENT revision; a
 * conflict surfaces as a note and re-syncs through the parent's poller.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronUpOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { api } from './api.ts'
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

/** One mutation outcome (the host route's own union). */
type MutationResult = { ok: true } | { ok: false; error: { code: string; message: string } }

export interface TeamBoardProps {
  rootId: string
  members: readonly SidebarTeamMemberView[]
  tasks: readonly SidebarTeamTaskView[]
  /** Re-pull `teams.view` now (after every mutation / conflict). */
  onChanged(): void
  /** The strip's own collapse state (the reader's choice, remembered while mounted). */
  collapsed: boolean
  onToggleCollapsed(): void
}

export function TeamBoard(props: TeamBoardProps): ReactNode {
  const { rootId, members, tasks, onChanged, collapsed, onToggleCollapsed } = props
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [armedDeleteId, setArmedDeleteId] = useState<string | undefined>(undefined)

  const open = tasks.filter(task => task.status !== 'deleted')

  /** Run one mutation with the shared busy/conflict handling. */
  const mutate = async (action: () => Promise<MutationResult>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(undefined)
    try {
      const result = await action()
      if (!result.ok) {
        setNote(result.error.code === 'team-task-conflict'
          ? t('teamTaskConflict')
          : t('teamTaskError', { message: result.error.message }))
      }
      onChanged()
    } catch (error) {
      setNote(t('teamTaskError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const teammates = members.filter(member => member.role === 'teammate')

  return (
    <section className={css.teamBoard} aria-label={t('teamBoard')}>
      <button
        type="button"
        className={css.teamBoardBar}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        <span>{t('teamBoard')}</span>
        <span className={css.teamBoardCount}>
          {t('teamChip', { members: members.length, tasks: open.length })}
        </span>
        <span
          className={css.teamBoardChev}
          style={{ display: 'inline-flex', transform: collapsed ? undefined : 'rotate(180deg)' }}
          aria-hidden="true"
        >
          <IconChevronUpOutline14 size={12} />
        </span>
      </button>
      {!collapsed && (
        <>
          <div className={css.teamMembers}>
            {members.map(member => (
              <span
                key={member.id}
                className={clsx(css.teamMember, member.role === 'lead' && css.teamMemberLead)}
                title={`${member.name} · ${member.role}`}
              >
                <StateDot
                  size={6}
                  state={member.status === 'running' || member.status === 'provisioning'
                    ? 'ongoing'
                    : member.status === 'failed' ? 'error' : 'idle'}
                />
                <span className={css.teamMemberName}>{member.name}</span>
              </span>
            ))}
          </div>
          {open.length === 0 && !creating && <div className={css.teamEmpty}>{t('teamTasksEmpty')}</div>}
          {open.length > 0 && (
            <div className={css.teamTasks}>
              {open.map(task => (
                <TeamTaskRow
                  key={task.id}
                  rootId={rootId}
                  task={task}
                  teammates={teammates}
                  busy={busy}
                  editing={editingId === task.id}
                  armedDelete={armedDeleteId === task.id}
                  onEdit={(edit) => { setEditingId(edit ? task.id : undefined) }}
                  onArmDelete={(armed) => { setArmedDeleteId(armed ? task.id : undefined) }}
                  mutate={mutate}
                />
              ))}
            </div>
          )}
          {note !== undefined && <div className={css.teamEmpty}>{note}</div>}
          {creating
            ? (
              <TeamTaskForm
                busy={busy}
                submitLabel={t('teamTaskCreate')}
                onCancel={() => { setCreating(false) }}
                onSubmit={(subject, description) => void mutate(async () => {
                  const result = await api.teamsTaskCreate(rootId, { subject, description })
                  if (result.ok) setCreating(false)
                  return result
                })}
              />
            )
            : (
              <div className={css.teamFormActions} style={{ padding: '0 12px 8px' }}>
                <button
                  type="button"
                  className={css.teamBtn}
                  disabled={busy}
                  onClick={() => { setCreating(true) }}
                >
                  {`＋ ${t('teamTaskCreate')}`}
                </button>
              </div>
            )}
        </>
      )}
    </section>
  )
}

/** One task row: status dot, subject, owner select, status chip, actions. */
function TeamTaskRow(props: {
  rootId: string
  task: SidebarTeamTaskView
  teammates: readonly SidebarTeamMemberView[]
  busy: boolean
  editing: boolean
  armedDelete: boolean
  onEdit(edit: boolean): void
  onArmDelete(armed: boolean): void
  mutate(action: () => Promise<MutationResult>): Promise<void>
}): ReactNode {
  const { rootId, task, teammates, busy, editing, armedDelete, onEdit, onArmDelete, mutate } = props
  if (editing) {
    return (
      <TeamTaskForm
        busy={busy}
        initialSubject={task.subject}
        initialDescription={task.description}
        submitLabel={t('teamTaskSave')}
        onCancel={() => { onEdit(false) }}
        onSubmit={(subject, description) => void mutate(async () => {
          const result = await api.teamsTaskUpdate(rootId, {
            taskId: task.id,
            expectedRevision: task.revision,
            action: 'edit',
            subject,
            description,
          })
          if (result.ok) onEdit(false)
          return result
        })}
      />
    )
  }
  return (
    <div className={css.teamTask}>
      <StateDot size={6} state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'} />
      <span className={css.teamTaskSubject} title={`${task.subject}${task.description === '' ? '' : `\n${task.description}`}`}>
        {task.subject}
      </span>
      <select
        className={css.teamOwnerSelect}
        aria-label={t('teamTaskOwner')}
        title={t('teamTaskOwner')}
        disabled={busy || task.status === 'completed'}
        value={task.ownerName ?? ''}
        onChange={(event) => {
          const owner = event.target.value
          void mutate(() => api.teamsTaskUpdate(rootId, {
            taskId: task.id,
            expectedRevision: task.revision,
            action: 'reassign',
            ...(owner === '' ? {} : { owner }),
          }))
        }}
      >
        <option value="">{t('teamTaskUnowned')}</option>
        {teammates.map(member => (
          <option key={member.id} value={member.name}>{member.name}</option>
        ))}
      </select>
      <span className={clsx(css.teamTaskStatus, !task.ready && css.teamTaskBlocked)}>
        {t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')}
      </span>
      <span className={css.teamActions}>
        {task.status !== 'completed'
          ? (
            <button
              type="button"
              className={css.teamBtn}
              disabled={busy}
              title={t('teamTaskComplete')}
              aria-label={`${t('teamTaskComplete')} ${task.subject}`}
              onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                taskId: task.id, expectedRevision: task.revision, action: 'complete',
              }))}
            >
              ✓
            </button>
          )
          : (
            <button
              type="button"
              className={css.teamBtn}
              disabled={busy}
              title={t('teamTaskReopen')}
              aria-label={`${t('teamTaskReopen')} ${task.subject}`}
              onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                taskId: task.id, expectedRevision: task.revision, action: 'reopen',
              }))}
            >
              ↺
            </button>
          )}
        <button
          type="button"
          className={css.teamBtn}
          disabled={busy}
          title={t('teamTaskEdit')}
          aria-label={`${t('teamTaskEdit')} ${task.subject}`}
          onClick={() => { onEdit(true) }}
        >
          ✎
        </button>
        <button
          type="button"
          className={clsx(css.teamBtn, armedDelete && css.teamBtnDanger)}
          disabled={busy}
          title={armedDelete ? t('teamTaskDeleteConfirm') : t('teamTaskDelete')}
          aria-label={`${armedDelete ? t('teamTaskDeleteConfirm') : t('teamTaskDelete')} ${task.subject}`}
          onClick={() => {
            if (!armedDelete) { onArmDelete(true); return }
            onArmDelete(false)
            void mutate(() => api.teamsTaskUpdate(rootId, {
              taskId: task.id, expectedRevision: task.revision, action: 'delete',
            }))
          }}
        >
          {armedDelete ? '!' : '✕'}
        </button>
      </span>
    </div>
  )
}

/** The create/edit task form (subject + description). */
function TeamTaskForm(props: {
  busy: boolean
  initialSubject?: string
  initialDescription?: string
  submitLabel: string
  onCancel(): void
  onSubmit(subject: string, description: string): void
}): ReactNode {
  const [subject, setSubject] = useState(props.initialSubject ?? '')
  const [description, setDescription] = useState(props.initialDescription ?? '')
  return (
    <div className={css.teamForm}>
      <input
        className={css.teamInput}
        placeholder={t('teamTaskSubject')}
        aria-label={t('teamTaskSubject')}
        value={subject}
        onChange={(event) => { setSubject(event.target.value) }}
      />
      <input
        className={css.teamInput}
        placeholder={t('teamTaskDescription')}
        aria-label={t('teamTaskDescription')}
        value={description}
        onChange={(event) => { setDescription(event.target.value) }}
      />
      <div className={css.teamFormActions}>
        <button
          type="button"
          className={css.teamBtn}
          disabled={props.busy || subject.trim() === ''}
          onClick={() => { props.onSubmit(subject.trim(), description.trim()) }}
        >
          {props.submitLabel}
        </button>
        <button type="button" className={css.teamBtn} disabled={props.busy} onClick={props.onCancel}>
          {t('teamTaskCancel')}
        </button>
      </div>
    </div>
  )
}
