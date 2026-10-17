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
 * (`TextDocumentContent`) with the built-in `{ text }` payload — registering
 * this renderer never changes local-file editing.
 *
 * Read-only states:
 * - the HOST says read-only (a preview): render the content, no editors;
 * - the SOURCE marks the document read-only (`data.readOnly`, e.g. archived
 *   repository, read-only permission, oversized body): same read-only surface
 *   and the source's reason code in `data-github-read-only-reason`, which the
 *   integrating surface (S9) localizes.
 */
import { createElement, type ReactNode } from 'react'
import type {
  ClueFormatRenderer,
  ClueFormatRendererProps,
  JsonValue,
} from '../../../../clues/types.ts'
import { kindOfSourceId } from '../../../../clues/sources/github/ids.ts'
import { TextDocumentContent } from '../../../windows/format-content.tsx'
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

/** The read-only content surface shared by previews and source-locked docs. */
function readOnlySurface(
  title: string,
  body: string,
  reason: string | undefined,
): ReactNode {
  return (
    <div
      className={css.document}
      data-github-document
      data-github-read-only
      data-github-read-only-reason={reason ?? 'read-only'}
    >
      <div className={css.readOnlyBadge}>{t('windowReadOnly')}</div>
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
): ReactNode {
  return (
    <div className={css.document} data-github-document>
      <input
        className={css.titleInput}
        data-github-title
        aria-label={t('rename')}
        spellCheck={false}
        value={title}
        onChange={(event) => { onChange(withFields(data, { title: event.target.value })) }}
      />
      <textarea
        className={css.bodyInput}
        data-github-body
        aria-label={t('editor')}
        spellCheck={false}
        value={body}
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
  const { sourceId, document, readOnly, onChange } = props
  const data = document.data
  if (!isGithubSource(sourceId)) {
    return createElement(TextDocumentContent, {
      text: textOf(data) ?? '',
      readOnly,
      onChange: (next: string) => { onChange(withText(data, next)) },
    })
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
    return readOnlySurface(fields.title, fields.body, locked?.reason)
  }
  return editableSurface(fields.title, fields.body, onChange, data)
}
