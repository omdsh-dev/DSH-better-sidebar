/**
 * Feishu task form editor (`feishu.task.document`).
 *
 * The renderer is a CONTROLLED form: every keystroke emits the source-owned
 * document through `onChange`; saving stays with the host (`onSave`), which
 * routes to the source's `saveEdit`. The form never calls the CLI itself.
 * When `onSave` is supplied this renderer owns the ONE Save control (the S6
 * host forwards the callback but renders no action button); S9 must not add a
 * second save action for the same document.
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
  FEISHU_FORMATS,
  parseTaskDocument,
  validateTaskDocument,
  type FeishuTaskDocumentData,
  type FeishuTaskField,
  type FeishuTaskTime,
} from '../../../../clues/sources/feishu/format.ts'
import css from './feishu.module.css'
import type { FeishuClientLabels } from './labels.ts'
import { appDate, appDateTime } from './time.ts'

/** Props of {@link FeishuTaskEditor}. */
export interface FeishuTaskEditorProps extends ClueFormatRendererProps {
  readonly labels: FeishuClientLabels
  /** App-locale date/time formatter (S9 supplies it; fallback is the browser locale). */
  readonly formatDateTime?: (value: string) => string
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

/** Human-readable updated timestamp (app locale when supplied). */
function displayUpdatedAt(
  value: string | undefined,
  formatDateTime: ((value: string) => string) | undefined,
): string | undefined {
  if (value === undefined || value === '') return undefined
  if (formatDateTime !== undefined) return formatDateTime(value)
  return appDateTime(value)
}

/** Human-readable time for the read-only view (app locale when supplied). */
function displayTime(
  time: FeishuTaskTime | null,
  labels: FeishuClientLabels,
  formatDateTime: ((value: string) => string) | undefined,
): string {
  if (time === null) return labels.noTime
  // All-day semantics win over the generic formatter: an all-day date must not
  // be rendered as a date+time just because S9 supplied a date-time formatter.
  if (time.isAllDay) return appDate(time.timestamp)
  if (formatDateTime !== undefined) return formatDateTime(time.timestamp)
  return appDateTime(time.timestamp)
}

/** The static read-only task view (a preview read is read-only by definition). */
function TaskReadOnly(props: {
  readonly task: FeishuTaskDocumentData
  readonly labels: FeishuClientLabels
  readonly formatDateTime?: (value: string) => string
}): ReactNode {
  const { task, labels, formatDateTime } = props
  const updatedAt = displayUpdatedAt(task.updatedAt, formatDateTime)
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
          <dd>{displayTime(task.start, labels, formatDateTime)}</dd>
        </div>
        <div className={css.fieldRow}>
          <dt>{labels.due}</dt>
          <dd>{displayTime(task.due, labels, formatDateTime)}</dd>
        </div>
        <div className={css.fieldRow}>
          <dt>{labels.description}</dt>
          <dd>{task.description === '' ? labels.emptyDescription : task.description}</dd>
        </div>
        {updatedAt !== undefined && (
          <div className={css.fieldRow} data-feishu-task-updated-at="">
            <dt>{labels.updatedAt}</dt>
            <dd>{updatedAt}</dd>
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
  readonly disabled: boolean
  onChange(time: FeishuTaskTime | null): void
}): ReactNode {
  const { id, field, label, time, labels, error, disabled, onChange } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const wasNull = useRef(time === null)
  const [clearError, setClearError] = useState<string | undefined>(undefined)
  useEffect(() => {
    // Clicking “Set time” replaces the button with the input; move focus there
    // so keyboard users are not dropped onto the document body.
    if (wasNull.current && time !== null) inputRef.current?.focus()
    wasNull.current = time === null
    // A controlled value change (a clear, an external reset or the host
    // reloading another task) invalidates the local parse error: keeping it
    // would describe text that is no longer in the input.
    setClearError(undefined)
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
          disabled={disabled}
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
          disabled={disabled}
          data-feishu-task-input={field}
          aria-invalid={shownError !== undefined}
          aria-describedby={shownError === undefined ? undefined : errorId}
          onChange={(event) => {
            if (event.target.value === '') {
              // Clearing an input emits no time; the host names the field in
              // `update_fields` and omits it from the native PATCH body.
              setClearError(undefined)
              onChange(null)
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
            disabled={disabled}
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
  const { labels } = props
  // The task format only. A payload mix-up under another format must not open
  // a form whose save the source would reject.
  const task = props.format === FEISHU_FORMATS.taskDocument
    ? parseTaskDocument(props.document.data)
    : undefined
  if (task === undefined) {
    return (
      <section className={css.panel} data-feishu-task-invalid="" role="note">
        <p className={css.hint}>{labels.invalidTask}</p>
      </section>
    )
  }
  if (props.readOnly) {
    return (
      <TaskReadOnly
        task={task}
        labels={labels}
        {...(props.formatDateTime === undefined ? {} : { formatDateTime: props.formatDateTime })}
      />
    )
  }

  const errors = validateTaskDocument(task)
  const errorOf = (field: FeishuTaskField): string | undefined => {
    const error = errors.find(candidate => candidate.field === field)
    if (error === undefined) return undefined
    switch (error.code) {
      case 'title-required':
        return labels.titleRequired
      case 'start-after-due':
        return labels.startAfterDue
      case 'all-day-mismatch':
        return labels.allDayMismatch
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
        {displayUpdatedAt(task.updatedAt, props.formatDateTime) !== undefined && (
          <span className={css.badge} data-feishu-task-updated-at="">
            {labels.updatedAt} {displayUpdatedAt(task.updatedAt, props.formatDateTime)}
          </span>
        )}
      </div>

      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor={idOf('title')}>{labels.title}</label>
        <input
          id={idOf('title')}
          className={css.input}
          type="text"
          value={task.title}
          disabled={props.saving}
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
          disabled={props.saving}
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
        disabled={props.saving}
        onChange={(time) => { emit({ start: time }) }}
      />
      <TimeField
        id={idOf('due')}
        field="due"
        label={labels.due}
        time={task.due}
        labels={labels}
        error={errorOf('due')}
        disabled={props.saving}
        onChange={(time) => { emit({ due: time }) }}
      />

      <label className={css.checkbox}>
        <input
          type="checkbox"
          checked={task.completed}
          disabled={props.saving}
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
