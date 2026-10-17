/**
 * Feishu task form editor (`feishu.task.document`).
 *
 * The renderer is a CONTROLLED form: every keystroke emits the source-owned
 * document through `onChange`; saving stays with the host (`onSave`), which
 * routes to the source's `saveEdit`. The form never calls the CLI itself.
 *
 * Local rules mirrored from the host save path (`validateTaskDocument`):
 * - a non-empty title;
 * - a parseable start/due instant;
 * - start <= due (compared as instants; an all-day flag is preserved, never
 *   silently converted to a timed value).
 *
 * Completion is part of the document, but the HOST submits it as a separate
 * `+complete` / `+reopen` action — the form does not invent a second write
 * path. Read-only preview mode renders the same fields as static text.
 */
import { useId, type ReactNode } from 'react'
import type { ClueFormatRendererProps, JsonValue } from '../../../../clues/types.ts'
import {
  parseTaskDocument,
  validateTaskDocument,
  type FeishuTaskDocumentData,
  type FeishuTaskField,
  type FeishuTaskTime,
} from '../../../../clues/sources/feishu/format.ts'
import css from './feishu.module.css'
import type { FeishuClientLabels } from './labels.ts'

/** Props of {@link FeishuTaskEditor}. */
export interface FeishuTaskEditorProps extends ClueFormatRendererProps {
  readonly labels: FeishuClientLabels
}

/** Two-digit zero padding. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** The local `datetime-local` / `date` input value of one instant. */
function inputValueOf(time: FeishuTaskTime | null): string {
  if (time === null) return ''
  const millis = Number(time.timestamp)
  if (!Number.isFinite(millis)) return ''
  const date = new Date(millis)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (time.isAllDay) return day
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Parse one local input value back to an instant, preserving the all-day flag. */
function timeOfInput(value: string, allDay: boolean): FeishuTaskTime | undefined {
  if (value === '') return undefined
  const millis = new Date(allDay ? `${value}T00:00:00` : value).getTime()
  if (!Number.isFinite(millis)) return undefined
  return { timestamp: String(millis), isAllDay: allDay }
}

/** Human-readable time for the read-only view (local timezone). */
function displayTime(time: FeishuTaskTime | null, labels: FeishuClientLabels): string {
  if (time === null) return labels.noTime
  const millis = Number(time.timestamp)
  if (!Number.isFinite(millis)) return labels.noTime
  const date = new Date(millis)
  return time.isAllDay ? date.toLocaleDateString() : date.toLocaleString()
}

/** The static read-only task view (a preview read is read-only by definition). */
function TaskReadOnly(props: {
  readonly task: FeishuTaskDocumentData
  readonly labels: FeishuClientLabels
}): ReactNode {
  const { task, labels } = props
  return (
    <section className={css.panel} data-feishu-task-preview="" data-feishu-task-read-only="">
      <div className={css.meta}>
        <span className={css.badge}>{task.completed ? labels.completed : labels.open}</span>
        <span className={css.badge}>
          {labels.taskGuid} {task.guid}
        </span>
      </div>
      <h3 className={css.title}>{task.title}</h3>
      <dl className={css.fields}>
        <div className={css.fieldRow}>
          <dt>{labels.start}</dt>
          <dd>{displayTime(task.start, labels)}</dd>
        </div>
        <div className={css.fieldRow}>
          <dt>{labels.due}</dt>
          <dd>{displayTime(task.due, labels)}</dd>
        </div>
        <div className={css.fieldRow}>
          <dt>{labels.description}</dt>
          <dd>{task.description === '' ? labels.noTime : task.description}</dd>
        </div>
      </dl>
    </section>
  )
}

/** One editable time field (date/datetime-local + the task's all-day flag). */
function TimeField(props: {
  readonly id: string
  readonly field: 'start' | 'due'
  readonly label: string
  readonly time: FeishuTaskTime | null
  readonly labels: FeishuClientLabels
  onChange(time: FeishuTaskTime): void
}): ReactNode {
  const { id, field, label, time, labels, onChange } = props
  if (time === null) {
    return (
      <div className={css.field} data-feishu-task-field={field}>
        <span className={css.fieldLabel}>{label}</span>
        <button
          type="button"
          className={css.linkButton}
          data-feishu-task-set-time={field}
          onClick={() => { onChange({ timestamp: String(Date.now()), isAllDay: false }) }}
        >
          {labels.setTime}
        </button>
      </div>
    )
  }
  return (
    <div className={css.field} data-feishu-task-field={field}>
      <label className={css.fieldLabel} htmlFor={id}>{label}</label>
      <div className={css.timeRow}>
        <input
          id={id}
          className={css.input}
          type={time.isAllDay ? 'date' : 'datetime-local'}
          value={inputValueOf(time)}
          data-feishu-task-input={field}
          onChange={(event) => {
            const next = timeOfInput(event.target.value, time.isAllDay)
            if (next !== undefined) onChange(next)
          }}
        />
        <label className={css.checkbox}>
          <input
            type="checkbox"
            checked={time.isAllDay}
            data-feishu-task-allday={field}
            onChange={(event) => { onChange({ ...time, isAllDay: event.target.checked }) }}
          />
          {labels.allDay}
        </label>
      </div>
    </div>
  )
}

/**
 * The editable task form (or its static read-only projection).
 * @param props - document renderer props plus localized labels.
 */
export function FeishuTaskEditor(props: FeishuTaskEditorProps): ReactNode {
  const idPrefix = useId()
  const task = parseTaskDocument(props.document.data, guidOf(props.document.data))
  const { labels } = props
  if (task === undefined) {
    return (
      <section className={css.panel} data-feishu-task-invalid="" role="note">
        <p className={css.hint}>{labels.invalidDocument}</p>
      </section>
    )
  }
  if (props.readOnly) return <TaskReadOnly task={task} labels={labels} />

  const errors = validateTaskDocument(task)
  const errorOf = (field: FeishuTaskField): string | undefined => {
    const error = errors.find(candidate => candidate.field === field)
    if (error === undefined) return undefined
    if (field === 'title') return labels.titleRequired
    if (error.message.includes('start must not be later')) return labels.startAfterDue
    return error.message
  }
  const emit = (patch: Partial<FeishuTaskDocumentData>): void => {
    props.onChange({ ...task, ...patch } as unknown as JsonValue)
  }
  const idOf = (field: string): string => `${idPrefix}-${field}`
  return (
    <form
      className={css.panel}
      data-feishu-task-editor=""
      onSubmit={(event) => { event.preventDefault() }}
    >
      <div className={css.meta}>
        <span className={css.badge}>
          {labels.taskGuid} {task.guid}
        </span>
      </div>

      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor={idOf('title')}>{labels.title}</label>
        <input
          id={idOf('title')}
          className={css.input}
          type="text"
          value={task.title}
          data-feishu-task-input="title"
          aria-invalid={errorOf('title') !== undefined}
          onChange={(event) => { emit({ title: event.target.value }) }}
        />
        {errorOf('title') !== undefined && (
          <p className={css.error} data-feishu-task-error="title" role="alert">{errorOf('title')}</p>
        )}
      </div>

      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor={idOf('description')}>{labels.description}</label>
        <textarea
          id={idOf('description')}
          className={css.textarea}
          value={task.description}
          data-feishu-task-input="description"
          rows={4}
          onChange={(event) => { emit({ description: event.target.value }) }}
        />
      </div>

      <TimeField
        id={idOf('start')}
        field="start"
        label={labels.start}
        time={task.start}
        labels={labels}
        onChange={(time) => { emit({ start: time }) }}
      />
      {errorOf('start') !== undefined && (
        <p className={css.error} data-feishu-task-error="start" role="alert">{errorOf('start')}</p>
      )}
      <TimeField
        id={idOf('due')}
        field="due"
        label={labels.due}
        time={task.due}
        labels={labels}
        onChange={(time) => { emit({ due: time }) }}
      />
      {errorOf('due') !== undefined && (
        <p className={css.error} data-feishu-task-error="due" role="alert">{errorOf('due')}</p>
      )}

      <label className={css.checkbox}>
        <input
          type="checkbox"
          checked={task.completed}
          data-feishu-task-input="completed"
          onChange={(event) => { emit({ completed: event.target.checked }) }}
        />
        {labels.completed}
      </label>

      {props.onSave !== undefined && (
        <div className={css.actions}>
          <button
            type="button"
            className={css.saveButton}
            data-feishu-task-save=""
            disabled={props.saving || errors.length > 0}
            onClick={() => { props.onSave?.() }}
          >
            {props.saving ? labels.saving : labels.save}
          </button>
        </div>
      )}
    </form>
  )
}

/** The GUID carried by a task payload (the editor only validates it on save). */
function guidOf(data: JsonValue): string {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ''
  const guid = (data as { guid?: unknown }).guid
  return typeof guid === 'string' ? guid : ''
}
