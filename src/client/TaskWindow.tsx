/**
 * The ONE task window: view, edit and create all live here, and every task
 * surface (the board's rows, an agent node's task line, the node detail
 * popover) opens THIS component — pointer targets stay thin, the window owns
 * the behaviour.
 *
 * Shape: a non-fullscreen, DRAGGABLE card (never a modal dialog). Details
 * render as multi-line MARKDOWN by default; 编辑 switches the same card into
 * multi-line editing, so reading and writing never jump between surfaces.
 * Actions: owner reassignment (Pills, CAS-immediate), edit/save, reopen or
 * complete, and a two-step delete.
 *
 * Host primitives everywhere (Button / Input / Pill / Tag / StateDot) plus
 * the plugin's own `MultilineField` (the host set ships no multi-line input)
 * and the shared `MarkdownText` renderer with the plugin's copy labels.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconEditOutlineRegular,
  IconRefreshOutlineRegular, IconTrashOutlineRegular, Input, MarkdownText, Pill, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { api } from './api.ts'
import { markdownTextProps } from './markdown-labels.tsx'
import { AnchoredPopover } from './AnchoredPopover.tsx'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** One mutation outcome (the host route's own union). */
type MutationResult = { ok: true } | { ok: false; error: { code: string; message: string } }

/** The task status label key. */
function taskStatusKey(status: SidebarTeamTaskView['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
    case 'deleted': return 'teamTaskDeleted'
  }
}

/**
 * The plugin's own multi-line input: the host primitive set ships no
 * textarea, so this is OUR component (token-styled, drag-exempt) and every
 * multi-line edit in the page goes through it.
 */
export function MultilineField(props: {
  value: string
  label: string
  placeholder?: string
  rows?: number
  onChange?(next: string): void
}): ReactNode {
  return (
    <textarea
      className={css.taskTextarea}
      value={props.value}
      rows={props.rows ?? 7}
      placeholder={props.placeholder}
      aria-label={props.label}
      data-popover-no-drag
      onChange={(event) => { props.onChange?.(event.target.value) }}
    />
  )
}

/** The owner picker (Pills; CAS-immediate, so it is never a draft field). */
function OwnerPicker(props: {
  members: readonly SidebarTeamMemberView[]
  owner: string | undefined
  disabled: boolean
  onPick(owner: string): void
}): ReactNode {
  return (
    <div className={css.taskOwnerRow} role="group" aria-label={t('teamTaskOwner')}>
      <Pill
        className={clsx(css.taskOwnerPill, props.owner === undefined && css.taskOwnerPillActive)}
        active={props.owner === undefined}
        disabled={props.disabled}
        onClick={() => { props.onPick('') }}
      >
        {t('teamTaskUnowned')}
      </Pill>
      {props.members.map(member => (
        <Pill
          key={member.id}
          className={clsx(css.taskOwnerPill, props.owner === member.name && css.taskOwnerPillActive)}
          active={props.owner === member.name}
          disabled={props.disabled}
          onClick={() => { props.onPick(member.name) }}
        >
          {member.name}
        </Pill>
      ))}
    </div>
  )
}

/** The read-only body: markdown description, meta, owner picker. */
function TaskViewBody(props: {
  task: SidebarTeamTaskView
  teammates: readonly SidebarTeamMemberView[]
  busy: boolean
  onReassign(owner: string): void
}): ReactNode {
  const { task } = props
  const body = task.description.trim()
  return (
    <>
      <div className={css.jobPopTitle}>
        <StateDot
          size={6}
          state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'}
        />
        <span className={css.popTitle} title={task.subject}>{task.subject}</span>
        <Tag tone={task.status === 'completed' ? 'success' : task.ready ? 'info' : 'warning'}>
          {t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')}
        </Tag>
      </div>
      <div className={css.jobPopMeta}>
        <span className={css.popKey}>{t('teamTaskOwner')}</span>
        <span className={css.jobPopValue}>{task.ownerName ?? t('teamTaskUnowned')}</span>
        {task.blockedBy.length > 0 && (
          <>
            <span className={css.popKey}>{t('teamTaskBlockedBy')}</span>
            <span className={css.jobPopValue}>{task.blockedBy.join(' · ')}</span>
          </>
        )}
      </div>
      <div className={css.taskMarkdown}>
        {body === ''
          ? <div className={css.popHint}>{t('teamTaskNoDescription')}</div>
          : (
            <MarkdownText
              {...markdownTextProps(body, {
                copyLabel: t('copy'),
                copiedLabel: t('copied'),
                codeLabel: t('codeBlockTitle'),
                wrapLabel: t('codeBlockWrap'),
                unwrapLabel: t('codeBlockUnwrap'),
              })}
            />
          )}
      </div>
      <div className={css.taskField}>
        <span className={css.taskLabel}>{t('teamTaskOwner')}</span>
        <OwnerPicker
          members={props.teammates}
          owner={task.ownerName}
          disabled={props.busy}
          onPick={props.onReassign}
        />
      </div>
    </>
  )
}

/**
 * The editing body: subject (host Input) + description (our multi-line field).
 *
 * A BLANK subject is the form's only invalid state. Save stays disabled until
 * it is filled, so the state must also be REPORTED — otherwise clearing the
 * field greys the button with no reason given. The input carries
 * `aria-invalid` and points at the hint below it, which reuses the subject's
 * own placeholder copy (no new i18n key): it reads as the field's rule, and it
 * appears only once the reader has been in the field.
 */
function TaskEditBody(props: {
  subject: string
  description: string
  invalid: boolean
  onSubject(next: string): void
  onDescription(next: string): void
}): ReactNode {
  const subjectHintId = useId()
  return (
    <div className={css.taskForm} data-popover-no-drag>
      <label className={css.taskField}>
        <span className={css.taskLabel}>{t('teamTaskSubject')}</span>
        <Input
          className={css.taskInput}
          value={props.subject}
          placeholder={t('teamTaskSubjectPlaceholder')}
          aria-label={t('teamTaskSubject')}
          aria-invalid={props.invalid ? true : undefined}
          aria-describedby={props.invalid ? subjectHintId : undefined}
          onChange={(event) => { props.onSubject(event.target.value) }}
        />
        {props.invalid && (
          <span id={subjectHintId} className={css.popHint}>
            {t('teamTaskSubjectPlaceholder')}
          </span>
        )}
      </label>
      <label className={css.taskField}>
        <span className={css.taskLabel}>{t('teamTaskDescription')}</span>
        <MultilineField
          value={props.description}
          label={t('teamTaskDescription')}
          placeholder={t('teamTaskDescriptionPlaceholder')}
          onChange={props.onDescription}
        />
      </label>
    </div>
  )
}

export interface TaskWindowProps {
  rootId: string
  /** The task under view/edit; undefined = create mode. */
  task: SidebarTeamTaskView | undefined
  members: readonly SidebarTeamMemberView[]
  /** Re-pull `teams.view` after a mutation (the parent owns the poller). */
  onChanged(): void
  /** Close the window (the caller's popover state). */
  onClose(): void
}

/** The task window content (the caller supplies the popover shell). */
export function TaskWindow(props: TaskWindowProps): ReactNode {
  const { rootId, task, members, onChanged, onClose } = props
  const creating = task === undefined
  const [editing, setEditing] = useState(creating)
  const [subject, setSubject] = useState(task?.subject ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  /** The reader has been in the subject field (see TaskEditBody's contract). */
  const [subjectTouched, setSubjectTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [armedDelete, setArmedDelete] = useState(false)

  // Re-seed the draft when the caller swaps the subject task: the poller
  // hands us fresh revisions, and unsaved text must not leak across tasks.
  // Keyed by id on purpose — a same-id revision bump must NOT clobber the
  // reader's in-flight edit (the seed rides a render-time ref so the effect
  // depends on the id alone).
  const seedRef = useRef({
    subject: task?.subject ?? '',
    description: task?.description ?? '',
    creating: task === undefined,
  })
  seedRef.current = {
    subject: task?.subject ?? '',
    description: task?.description ?? '',
    creating: task === undefined,
  }
  useEffect(() => {
    const seed = seedRef.current
    setSubject(seed.subject)
    setDescription(seed.description)
    setSubjectTouched(false)
    setEditing(seed.creating)
  }, [task?.id])

  const teammates = members.filter(member => member.role === 'teammate')

  /** Run one CAS mutation with the shared busy/conflict handling. */
  const mutate = async (
    action: () => Promise<MutationResult>,
    options: { close?: boolean } = {},
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(undefined)
    try {
      const result = await action()
      if (!result.ok) {
        setNote(result.error.code === 'team-task-conflict'
          ? t('teamTaskConflict')
          : t('teamTaskError', { message: result.error.message }))
      } else {
        if (options.close === true) onClose()
        else setEditing(false)
      }
      onChanged()
    } catch (error) {
      setNote(t('teamTaskError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  /** Save the draft (create closes the window; edit returns to the view). */
  const save = (): void => {
    const nextSubject = subject.trim()
    if (nextSubject === '') return
    void mutate(() => (creating
      ? api.teamsTaskCreate(rootId, { subject: nextSubject, description: description.trim() })
      : api.teamsTaskUpdate(rootId, {
        taskId: task.id,
        expectedRevision: task.revision,
        action: 'edit',
        subject: nextSubject,
        description: description.trim(),
      })), { close: creating })
  }

  /** Reassign the task (or return it to the unowned pool). */
  const reassign = (owner: string): void => {
    if (task === undefined || busy) return
    void mutate(() => api.teamsTaskUpdate(rootId, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      ...(owner === '' ? {} : { owner }),
    }))
  }

  return (
    <div className={css.popCard} data-popover-handle>
      <div className={css.popHead}>
        <span>{creating ? t('teamTaskCreate') : editing ? t('teamTaskEdit') : t('teamTaskDetail')}</span>
        <span className={css.popHeadActions} data-popover-no-drag>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconCloseOutlineRegular size={12} />}
            aria-label={t('teamTaskCancel')}
            title={t('teamTaskCancel')}
            onClick={onClose}
          />
        </span>
      </div>

      {editing || task === undefined
        ? (
          <TaskEditBody
            subject={subject}
            description={description}
            invalid={subjectTouched && subject.trim() === ''}
            onSubject={(next) => { setSubjectTouched(true); setSubject(next) }}
            onDescription={setDescription}
          />
        )
        : (
          <TaskViewBody
            task={task}
            teammates={teammates}
            busy={busy}
            onReassign={reassign}
          />
        )}

      {note !== undefined && <div className={css.teamNote}>{note}</div>}

      <div className={css.jobPopActions} data-popover-no-drag>
        {editing
          ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<IconCheckOutlineRegular size={12} />}
                disabled={busy || subject.trim() === ''}
                onClick={save}
              >
                {creating ? t('teamTaskCreate') : t('teamTaskSave')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (creating) onClose()
                  else if (task !== undefined) {
                    setSubject(task.subject)
                    setDescription(task.description)
                    setSubjectTouched(false)
                    setEditing(false)
                  }
                }}
              >
                {t('teamTaskCancel')}
              </Button>
            </>
          )
          : task === undefined ? null : (
            <>
              <Button
                variant="outline"
                size="sm"
                icon={<IconEditOutlineRegular size={12} />}
                onClick={() => { setEditing(true) }}
              >
                {t('teamTaskEdit')}
              </Button>
              {/* One primary per card: the affirmative state change (完成 /
                  重新打开) is it, so 编辑 stays a plain outline and 删除 keeps
                  the danger ink beside it. */}
              {task.status === 'completed'
                ? (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<IconRefreshOutlineRegular size={12} />}
                    disabled={busy}
                    onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                      taskId: task.id, expectedRevision: task.revision, action: 'reopen',
                    }))}
                  >
                    {t('teamTaskReopen')}
                  </Button>
                )
                : (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<IconCheckOutlineRegular size={12} />}
                    disabled={busy}
                    onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                      taskId: task.id, expectedRevision: task.revision, action: 'complete',
                    }))}
                  >
                    {t('teamTaskComplete')}
                  </Button>
                )}
              <Button
                variant="outline"
                size="sm"
                className={clsx(css.taskDanger, armedDelete && css.taskDangerArmed)}
                icon={<IconTrashOutlineRegular size={12} />}
                disabled={busy}
                onClick={() => {
                  if (!armedDelete) { setArmedDelete(true); return }
                  setArmedDelete(false)
                  void mutate(() => api.teamsTaskUpdate(rootId, {
                    taskId: task.id, expectedRevision: task.revision, action: 'delete',
                  }), { close: true })
                }}
              >
                {armedDelete ? t('teamTaskDeleteConfirm') : t('teamTaskDelete')}
              </Button>
            </>
          )}
      </div>
    </div>
  )
}

/**
 * The task window inside its draggable popover shell — the single entry point
 * every task surface uses (board row, node task line, node detail list).
 */
export function TaskPopover(props: TaskWindowProps & { anchor: HTMLElement | null }): ReactNode {
  const { anchor, onClose, ...windowProps } = props
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} draggable width={430}>
      {anchor === null ? null : <TaskWindow {...windowProps} onClose={onClose} />}
    </AnchoredPopover>
  )
}
