/**
 * The GitHub `text/markdown` renderer (S3 client half).
 *
 * One editable document is a title plus a Markdown body (the only fields the
 * source can save). The renderer is presentation only: every keystroke goes
 * back to the caller through `onChange` (the ORIGINAL data object is copied,
 * never replaced with an invented shape), and the source's `saveEdit` stays
 * the only write path.
 *
 * The format registry is keyed by MIME, so this renderer is also the one a
 * local-file `text/markdown` document resolves to. Non-GitHub documents are
 * therefore delegated to S6's reusable single-text carrier
 * (`TextDocumentContent`) INSIDE the same wrapper/data carrier the built-in
 * S6 path renders (`data-window-text-content` / `data-window-text-format` and
 * its `textContent` flex layout), so registering this renderer does not
 * change local-file markdown layout or selectors.
 *
 * Read-only states:
 * - the HOST says read-only (a preview): render the content, no editors (S6
 *   already shows the shared read-only badge);
 * - the SOURCE marks the document read-only (`data.readOnly`, e.g. archived
 *   repository, read-only permission, oversized body): same read-only surface
 *   with the source's reason code in `data-github-read-only-reason` AND as a
 *   visible reason line (S9 can replace that line with localized copy using
 *   the attribute).
 *
 * Save state: while S6 reports `saving`, the controlled inputs are disabled so
 * a late edit cannot be silently dropped when the save completes; the
 * renderer never saves by itself (`onSave`, when wired, is exposed on
 * Ctrl/Cmd+Enter and remains the caller's source-owned write path).
 */
import { createElement, type KeyboardEvent, type ReactNode } from 'react'
import type {
  ClueFormatRenderer,
  ClueFormatRendererProps,
  JsonValue,
} from '../../../../clues/types.ts'
import { kindOfSourceId } from '../../../../clues/sources/github/ids.ts'
import { TextDocumentContent } from '../../../windows/format-content.tsx'
import windowsCss from '../../../windows/windows.module.css'
import { t } from '../../../locales.ts'
import css from './github.module.css'

/** Whether one source id is one of the built-in GitHub sources. */
export function isGithubSource(sourceId: string): boolean {
  return kindOfSourceId(sourceId) !== undefined
}

/** The plain-object view of one document payload. */
function recordOf(data: JsonValue): Record<string, JsonValue> | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  return data as Record<string, JsonValue>
}

/** The single `text` field S6's built-in carrier understands. */
function textOf(data: JsonValue): string | undefined {
  if (typeof data === 'string') return data
  const record = recordOf(data)
  return typeof record?.text === 'string' ? record.text : undefined
}

/** Replace the text field without dropping any other source-owned field. */
function withText(data: JsonValue, text: string): JsonValue {
  const record = recordOf(data)
  return record === undefined ? { text } : { ...record, text }
}

/** The GitHub title/body pair, when this payload has one. */
function titleBodyOf(data: JsonValue): { title: string; body: string } | undefined {
  const record = recordOf(data)
  if (record === undefined) return undefined
  if (typeof record.title !== 'string' || typeof record.body !== 'string') return undefined
  return { title: record.title, body: record.body }
}

/** Copy the source data and apply one title/body edit. */
function withFields(data: JsonValue, patch: { readonly title?: string; readonly body?: string }): JsonValue {
  return { ...(recordOf(data) ?? {}), ...patch }
}

/** The source-owned read-only marker (or undefined when editable). */
function sourceReadOnly(data: JsonValue): { reason?: string } | undefined {
  const record = recordOf(data)
  if (record?.readOnly !== true) return undefined
  return typeof record.readOnlyReason === 'string' ? { reason: record.readOnlyReason } : {}
}

/** Localized explanation of a source-owned read-only reason code. */
function readOnlyReasonLabel(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'archived':
      return t('clueDetailReadOnlyArchived')
    case 'permission-denied':
      return t('clueDetailReadOnlyPermission')
    case 'size':
      return t('clueDetailReadOnlySize')
    default:
      return reason
  }
}

/** The read-only content surface shared by previews and source-locked docs. */
function readOnlySurface(
  title: string,
  body: string,
  reason: string | undefined,
  hostReadOnly: boolean,
): ReactNode {
  return (
    <div
      className={css.document}
      data-github-document
      data-github-read-only
      data-github-read-only-reason={reason ?? 'read-only'}
    >
      {/* S6 renders the shared badge for a host preview; the source-locked
          document needs its own. The reason code stays visible until S9
          localizes it from the data attribute. */}
      {!hostReadOnly && <div className={css.readOnlyBadge}>{t('windowReadOnly')}</div>}
      {reason !== undefined && <div className={css.readOnlyReason}>{readOnlyReasonLabel(reason)}</div>}
      <div className={css.readOnlyTitle}>{title}</div>
      <pre className={css.readOnlyBody}>{body}</pre>
    </div>
  )
}

/** The title + Markdown body editor (controlled by the caller's document). */
function editableSurface(
  title: string,
  body: string,
  onChange: ClueFormatRendererProps['onChange'],
  data: JsonValue,
  saving: boolean,
  onSave: (() => void) | undefined,
): ReactNode {
  const saveOnKey = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    if (saving || onSave === undefined) return
    event.preventDefault()
    onSave()
  }
  return (
    <div className={css.document} data-github-document data-github-saving={saving ? 'true' : undefined}>
      <input
        className={css.titleInput}
        data-github-title
        aria-label={t('rename')}
        spellCheck={false}
        disabled={saving}
        value={title}
        onKeyDown={saveOnKey}
        onChange={(event) => { onChange(withFields(data, { title: event.target.value })) }}
      />
      <textarea
        className={css.bodyInput}
        data-github-body
        aria-label={t('editor')}
        spellCheck={false}
        disabled={saving}
        value={body}
        onKeyDown={saveOnKey}
        onChange={(event) => { onChange(withFields(data, { body: event.target.value })) }}
      />
    </div>
  )
}

/**
 * The `text/markdown` renderer: GitHub title+body, otherwise the S6 text
 * carrier. Never saves by itself.
 */
export const githubMarkdownRenderer: ClueFormatRenderer = (props: ClueFormatRendererProps): ReactNode => {
  const { sourceId, format, document, readOnly, saving, onChange, onSave } = props
  const data = document.data
  if (!isGithubSource(sourceId)) {
    return (
      <div className={windowsCss.textContent} data-window-text-content data-window-text-format={format}>
        {createElement(TextDocumentContent, {
          text: textOf(data) ?? '',
          readOnly,
          onChange: (next: string) => { onChange(withText(data, next)) },
        })}
      </div>
    )
  }
  const fields = titleBodyOf(data)
  if (fields === undefined) {
    // A GitHub document without a title/body pair is not editable; showing the
    // raw payload as text is the least surprising read-only fallback.
    return createElement(TextDocumentContent, {
      text: textOf(data) ?? '',
      readOnly: true,
      onChange: () => undefined,
    })
  }
  const locked = sourceReadOnly(data)
  if (readOnly || locked !== undefined) {
    return readOnlySurface(fields.title, fields.body, locked?.reason, readOnly)
  }
  return editableSurface(fields.title, fields.body, onChange, data, saving, onSave)
}
