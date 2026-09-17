/**
 * The ONE task window: view, edit and create all live here, and every task
 * surface (the board's rows, an agent node's task line, the node detail
 * popover) opens THIS component — pointer targets stay thin, the window owns
 * the behaviour.
 *
 * Shape: a non-fullscreen, DRAGGABLE card (never a modal dialog). Details
 * render as multi-line MARKDOWN by default; 编辑 switches the same card into
 * multi-line editing, so reading and writing never jump between surfaces.
 * Actions: owner reassignment (CAS-immediate), edit/save, reopen or complete,
 * and a two-step delete.
 *
 * Visual base: the vendored shadcn/ui set — `Card` shell, `Badge` status,
 * `Input` / `Textarea` fields, a `ToggleGroup` owner picker and `Button`
 * actions — over the token bridge in src/client/ui/theme.css, plus the shared
 * `MarkdownText` renderer with the plugin's copy labels. The shell paints no
 * surface of its own: the window is portaled to `document.body`, where
 * `AnchoredPopover` owns the floating border/radius/shadow, so this card is
 * layout and content only (the page's "static panels cast no shadow" rule).
 *
 * That portal also sits OUTSIDE the task page root, so the card re-declares
 * the page root class (`dsw-tasks`) to pick up the scoped base reset the
 * plugin ships instead of preflight — box-sizing and form-control font
 * inheritance; without preflight a bare `<button>`/`<textarea>` would render
 * in the UA's own font.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconCheckOutline14, IconCloseOutline16, IconEditOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconTrashOutline16, MarkdownText, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { api } from './api.ts'
import { markdownTextProps } from './markdown-labels.tsx'
import { AnchoredPopover } from './AnchoredPopover.tsx'
import { t, type CopyKey } from './locales.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card.tsx'
import { Input } from './ui/input.tsx'
import { Separator } from './ui/separator.tsx'
import { Textarea } from './ui/textarea.tsx'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'

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
 * The status badge's ink — hue carries meaning only: done = success, running =
 * accent, blocked = warning, everything else stays on quiet meta ink.
 */
function statusTone(task: SidebarTeamTaskView): string {
  if (task.status === 'completed') return 'border-success/40 text-success'
  if (task.status === 'in_progress') return 'border-primary/40 text-primary'
  return task.ready ? 'text-muted-foreground' : 'border-warning/40 text-warning'
}

/**
 * The plugin's own multi-line input: the host primitive set ships no
 * textarea, so this is OUR component (token-styled, drag-exempt) and every
 * multi-line edit in the page goes through it. The surface is the vendored
 * shadcn `Textarea`; `rows` keeps the caller's height contract and the
 * content-driven growth is capped so a long body cannot outgrow the viewport.
 */
export function MultilineField(props: {
  value: string
  label: string
  placeholder?: string
  rows?: number
  onChange?(next: string): void
}): ReactNode {
  return (
    <Textarea
      className="max-h-[45vh] min-h-[120px] resize-y leading-relaxed"
      value={props.value}
      rows={props.rows ?? 7}
      placeholder={props.placeholder}
      aria-label={props.label}
      data-popover-no-drag
      onChange={(event) => { props.onChange?.(event.target.value) }}
    />
  )
}

/**
 * The unowned option's sentinel value: Radix reads an EMPTY string as "nothing
 * is selected" (`value ? [value] : []`), so `''` could never render pressed —
 * and the unowned chip must be visibly the active one on an unowned task.
 */
const UNOWNED = '__unowned__'

/**
 * The owner chips' ink: an unselected owner is meta ink, the picked one is
 * full ink, and the vendored toggle adds its accent tint on top — the tint
 * alone would read exactly like hover. (Weight cannot carry the selection
 * here: the page's scoped base reset gives every form control `font: inherit`,
 * which outranks a font-weight utility.)
 */
const OWNER_CHIP = 'text-muted-foreground data-[state=on]:text-foreground'

/** The owner picker (single-select toggles; CAS-immediate, so never a draft field). */
export function OwnerPicker(props: {
  members: readonly SidebarTeamMemberView[]
  owner: string | undefined
  disabled: boolean
  onPick(owner: string): void
}): ReactNode {
  return (
    <ToggleGroup
      type="single"
      value={props.owner ?? UNOWNED}
      disabled={props.disabled}
      spacing={1}
      aria-label={t('teamTaskOwner')}
      className="flex-wrap"
      onValueChange={(next) => {
        // '' is Radix's deselect of the pressed chip (the reader re-clicked the
        // current owner): the old pill row re-sent the same owner, i.e. no
        // mutation — the window never unassigns behind a re-click.
        if (next === '') return
        props.onPick(next === UNOWNED ? '' : next)
      }}
    >
      <ToggleGroupItem value={UNOWNED} variant="outline" size="sm" className={OWNER_CHIP}>
        {t('teamTaskUnowned')}
      </ToggleGroupItem>
      {props.members.map(member => (
        <ToggleGroupItem key={member.id} value={member.name} variant="outline" size="sm" className={OWNER_CHIP}>
          {member.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <StateDot
          size={6}
          state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'}
        />
        <span className="min-w-0 flex-1 truncate font-medium" title={task.subject}>{task.subject}</span>
        <Badge variant="outline" className={`h-5 px-2 text-[11px] ${statusTone(task)}`}>
          {t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="text-foreground-3">{t('teamTaskOwner')}</span>
        <span>{task.ownerName ?? t('teamTaskUnowned')}</span>
        {task.blockedBy.length > 0 && (
          <>
            <span className="text-foreground-3">{t('teamTaskBlockedBy')}</span>
            <span className="font-mono tabular-nums">{task.blockedBy.join(' · ')}</span>
          </>
        )}
      </div>
      <div className="max-h-[260px] overflow-y-auto leading-[1.55] text-foreground">
        {body === ''
          ? <div className="text-xs leading-snug text-muted-foreground">{t('teamTaskNoDescription')}</div>
          : (
            <MarkdownText
              {...markdownTextProps(body, { copyLabel: t('copy'), copiedLabel: t('copied') })}
            />
          )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] text-foreground-3">{t('teamTaskOwner')}</span>
        <OwnerPicker
          members={props.teammates}
          owner={task.ownerName}
          disabled={props.busy}
          onPick={props.onReassign}
        />
      </div>
    </div>
  )
}

/** The editing body: subject (shadcn Input) + description (our multi-line field). */
function TaskEditBody(props: {
  subject: string
  description: string
  onSubject(next: string): void
  onDescription(next: string): void
}): ReactNode {
  return (
    <div className="flex flex-col gap-2.5" data-popover-no-drag>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-foreground-3">{t('teamTaskSubject')}</span>
        <Input
          className="h-8"
          value={props.subject}
          placeholder={t('teamTaskSubjectPlaceholder')}
          aria-label={t('teamTaskSubject')}
          onChange={(event) => { props.onSubject(event.target.value) }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-foreground-3">{t('teamTaskDescription')}</span>
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
    <Card
      className="dsw-tasks box-border gap-0 rounded-lg border-0 bg-transparent py-0 text-[13px]"
      data-popover-handle
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-3 py-2">
        <CardTitle className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground-3">
          {creating ? t('teamTaskCreate') : editing ? t('teamTaskEdit') : t('teamTaskDetail')}
        </CardTitle>
        <div className="flex flex-none items-center gap-1" data-popover-no-drag>
          <Button
            variant="ghost"
            size="icon"
            // Load-bearing reset: the plugin ships no preflight, so a control
            // whose variant declares no paint keeps the UA's `buttonface` fill
            // and 2px `outset` border. A ghost icon button must be chrome-free.
            className="size-7 border-0 bg-transparent"
            aria-label={t('teamTaskCancel')}
            title={t('teamTaskCancel')}
            onClick={onClose}
          >
            <IconCloseOutline16 />
          </Button>
        </div>
      </CardHeader>
      <Separator />

      <CardContent className="px-3 py-2.5">
        {editing || task === undefined
          ? (
            <TaskEditBody
              subject={subject}
              description={description}
              onSubject={setSubject}
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
        {note !== undefined && <div className="mt-2 text-xs leading-snug text-warning">{note}</div>}
      </CardContent>

      <Separator />
      <CardFooter className="flex-wrap justify-end gap-1.5 px-3 py-2" data-popover-no-drag>
        {editing
          ? (
            <>
              <Button
                size="sm"
                // Same preflight reset as the ghost button: `default` declares no
                // border, so the UA's 2px `outset` edge would frame the fill.
                className="border-0"
                disabled={busy || subject.trim() === ''}
                onClick={save}
              >
                <IconCheckOutline14 />
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
              <Button variant="outline" size="sm" onClick={() => { setEditing(true) }}>
                <IconEditOutline16 />
                {t('teamTaskEdit')}
              </Button>
              {task.status === 'completed'
                ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                      taskId: task.id, expectedRevision: task.revision, action: 'reopen',
                    }))}
                  >
                    <IconRefreshOutline14 />
                    {t('teamTaskReopen')}
                  </Button>
                )
                : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                      taskId: task.id, expectedRevision: task.revision, action: 'complete',
                    }))}
                  >
                    <IconCheckOutline14 />
                    {t('teamTaskComplete')}
                  </Button>
                )}
              <Button
                variant="outline"
                size="sm"
                // Two-step confirm, danger only on the armed click: outline +
                // destructive ink beats a permanently red button (and keeps the
                // variant's own 1px border).
                className={armedDelete ? 'border-destructive/40 text-destructive' : undefined}
                disabled={busy}
                onClick={() => {
                  if (!armedDelete) { setArmedDelete(true); return }
                  setArmedDelete(false)
                  void mutate(() => api.teamsTaskUpdate(rootId, {
                    taskId: task.id, expectedRevision: task.revision, action: 'delete',
                  }), { close: true })
                }}
              >
                <IconTrashOutline16 />
                {armedDelete ? t('teamTaskDeleteConfirm') : t('teamTaskDelete')}
              </Button>
            </>
          )}
      </CardFooter>
    </Card>
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

/** The create affordance every surface shares. */
export function TaskCreateButton(props: {
  disabled?: boolean
  onClick(anchor: HTMLElement): void
}): ReactNode {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={props.disabled}
      onClick={(event) => { props.onClick(event.currentTarget) }}
    >
      <IconPlusOutline16 />
      {t('teamTaskCreate')}
    </Button>
  )
}
