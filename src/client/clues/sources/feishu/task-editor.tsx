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
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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

/** Human-readable updated timestamp (local timezone, raw if unparseable). */
function displayUpdatedAt(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const millis = Number(value)
  return Number.isFinite(millis) ? new Date(millis).toLocaleString() : value
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
          <dd>{task.description === '' ? labels.emptyDescription : task.description}</dd>
        </div>
        {displayUpdatedAt(task.updatedAt) !== undefined && (
          <div className={css.fieldRow} data-feishu-task-updated-at="">
            <dt>{labels.updatedAt}</dt>
            <dd>{displayUpdatedAt(task.updatedAt)}</dd>
          </div>
        )}
      </dl>
      {task.url !== undefined && /^https?:\/\//i.test(task.url) && (
        <a className={css.linkButton} href={task.url} target="_blank" rel="noreferrer">
          {labels.sourceLink}
        </a>
      )}
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
  readonly error?: string
  onChange(time: FeishuTaskTime): void
}): ReactNode {
  const { id, field, label, time, labels, error, onChange } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const wasNull = useRef(time === null)
  const [clearError, setClearError] = useState<string | undefined>(undefined)
  useEffect(() => {
    // Clicking “Set time” replaces the button with the input; move focus there
    // so keyboard users are not dropped onto the document body.
    if (wasNull.current && time !== null) inputRef.current?.focus()
    wasNull.current = time === null
  }, [time])
  if (time === null) {
    return (
      <div className={css.field} data-feishu-task-field={field}>
        <span className={css.fieldLabel}>{label}</span>
        <button
          type="button"
          className={css.linkButton}
          data-feishu-task-set-time={field}
          aria-label={`${label}: ${labels.setTime}`}
          onClick={() => { onChange({ timestamp: String(Date.now()), isAllDay: false }) }}
        >
          {labels.setTime}
        </button>
      </div>
    )
  }
  const shownError = error ?? clearError
  const errorId = `${id}-error`
  return (
    <div className={css.field} data-feishu-task-field={field}>
      <label className={css.fieldLabel} htmlFor={id}>{label}</label>
      <div className={css.timeRow}>
        <input
          ref={inputRef}
          id={id}
          className={css.input}
          type={time.isAllDay ? 'date' : 'datetime-local'}
          value={inputValueOf(time)}
          data-feishu-task-input={field}
          aria-invalid={shownError !== undefined}
          aria-describedby={shownError === undefined ? undefined : errorId}
          onChange={(event) => {
            if (event.target.value === '') {
              // The CLI has no documented “clear time” update; keeping the old
              // value and explaining why is safer than a silent no-op.
              setClearError(labels.clearingTimeUnsupported)
              return
            }
            setClearError(undefined)
            const next = timeOfInput(event.target.value, time.isAllDay)
            if (next !== undefined) onChange(next)
            else setClearError(labels.invalidTime)
          }}
        />
        <label className={css.checkbox}>
          <input
            type="checkbox"
            checked={time.isAllDay}
            data-feishu-task-allday={field}
            aria-label={`${label} ${labels.allDay}`}
            onChange={(event) => { onChange({ ...time, isAllDay: event.target.checked }) }}
          />
          {labels.allDay}
        </label>
      </div>
      {shownError !== undefined && (
        <p
          className={css.error}
          id={errorId}
          data-feishu-task-error={field}
          data-feishu-task-time-error={field}
          role="alert"
        >
          {shownError}
        </p>
      )}
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
    switch (error.code) {
      case 'title-required':
        return labels.titleRequired
      case 'start-after-due':
        return labels.startAfterDue
      case 'invalid-time':
        return labels.invalidTime
      default:
        return labels.genericValidation
    }
  }
  const emit = (patch: Partial<FeishuTaskDocumentData>): void => {
    props.onChange({ ...task, ...patch } as unknown as JsonValue)
  }
  const idOf = (field: string): string => `${idPrefix}-${field}`
  const errorIdOf = (field: string): string => `${idPrefix}-${field}-error`
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
          aria-describedby={errorOf('title') === undefined ? undefined : errorIdOf('title')}
          onChange={(event) => { emit({ title: event.target.value }) }}
        />
        {errorOf('title') !== undefined && (
          <p className={css.error} id={errorIdOf('title')} data-feishu-task-error="title" role="alert">
            {errorOf('title')}
          </p>
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
        error={errorOf('start')}
        onChange={(time) => { emit({ start: time }) }}
      />
      <TimeField
        id={idOf('due')}
        field="due"
        label={labels.due}
        time={task.due}
        labels={labels}
        error={errorOf('due')}
        onChange={(time) => { emit({ due: time }) }}
      />

      <label className={css.checkbox}>
        <input
          type="checkbox"
          checked={task.completed}
          data-feishu-task-input="completed"
          aria-label={labels.completed}
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
