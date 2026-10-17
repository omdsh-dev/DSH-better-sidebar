/**
 * Feishu document renderer (`feishu.docs.xml` / `feishu.docs.markdown`).
 *
 * Two payload shapes share the format:
 * - a READ result (`FeishuDocReadData`): immutable XML/Markdown projection,
 *   rendered as escaped text (never HTML) with freshness/source metadata;
 * - an EDIT load (`FeishuDocEditData`): a controlled block editor whose save
 *   callback stays with S6/the source's `saveEdit`. Only text blocks are
 *   editable; complex containers are shown read-only. Markdown is never a
 *   write input.
 *
 * The text is React-escaped, links/commands inside the document remain
 * untrusted source data, and the component never calls the CLI itself.
 */
import { useId, type ReactNode } from 'react'
import type { ClueFormatRendererProps, JsonValue } from '../../../../clues/types.ts'
import {
  DOCS_EDIT_SCOPE_NOTE,
  parseDocEditData,
  parseDocReadData,
  type FeishuDocEditBlock,
  type FeishuDocEditData,
  type FeishuDocReadData,
} from '../../../../clues/sources/feishu/format.ts'
import css from './feishu.module.css'
import type { FeishuClientLabels } from './labels.ts'

/** Rendering bound: the host already pages the source; never freeze the DOM. */
const MAX_PREVIEW_CHARS = 40_000

/** Props of {@link FeishuDocsPreview}. */
export interface FeishuDocsPreviewProps extends ClueFormatRendererProps {
  readonly labels: FeishuClientLabels
}

/** The read-only fallback when the payload is not a Feishu document. */
function InvalidDocument(props: { readonly labels: FeishuClientLabels }): ReactNode {
  return (
    <section className={css.panel} data-feishu-docs-invalid="" role="note">
      <p className={css.hint}>{props.labels.invalidDocument}</p>
    </section>
  )
}

/** Human-readable freshness stamp; never invent a time when absent. */
function stampOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value
}

/** The "open original source" entry, only for a real http(s) URL. */
function SourceLink(props: { readonly url?: string; readonly labels: FeishuClientLabels }): ReactNode {
  const { url, labels } = props
  if (url === undefined || !/^https?:\/\//i.test(url)) return null
  return (
    <a
      className={css.linkButton}
      href={url}
      target="_blank"
      rel="noreferrer"
      data-feishu-docs-source-link=""
    >
      {labels.sourceLink}
    </a>
  )
}

/** Revision + freshness metadata of one read. */
function ReadMeta(props: {
  readonly data: FeishuDocReadData
  readonly limited: boolean
  readonly fetchedAt?: string
  readonly freshness?: string
  readonly labels: FeishuClientLabels
}): ReactNode {
  const { data, limited, fetchedAt, freshness, labels } = props
  const stamp = stampOf(fetchedAt)
  return (
    <div className={css.meta}>
      <span className={css.badge} data-feishu-docs-format={data.projection}>
        {data.projection === 'markdown' ? labels.markdown : labels.xml}
      </span>
      <span className={css.badge} data-feishu-docs-read-only="">
        {labels.readOnly}
      </span>
      {data.revisionId !== undefined && (
        <span className={css.badge}>
          {labels.revision} {data.revisionId}
        </span>
      )}
      {freshness !== undefined && (
        <span className={css.badge} data-feishu-docs-freshness={freshness}>
          {labels.freshness}: {freshness}
        </span>
      )}
      {stamp !== undefined && (
        <span className={css.badge} data-feishu-docs-fetched-at="">
          {labels.fetchedAt} {stamp}
        </span>
      )}
      {limited && (
        <span className={css.badge} data-feishu-docs-limited="">
          {labels.limitedFragment}
        </span>
      )}
    </div>
  )
}

/**
 * The read-only XML/Markdown preview.
 * @param props - the rendered read payload.
 */
function ReadPreview(props: {
  readonly read: FeishuDocReadData
  readonly document: ClueFormatRendererProps['document']
  readonly labels: FeishuClientLabels
}): ReactNode {
  const { read, document, labels } = props
  const limited = 'limited' in document && document.limited === true
  const truncated = read.content.length > MAX_PREVIEW_CHARS
  const content = truncated ? read.content.slice(0, MAX_PREVIEW_CHARS) : read.content
  const fetchedAt = 'fetchedAt' in document && typeof document.fetchedAt === 'string'
    ? document.fetchedAt
    : undefined
  const freshness = 'freshness' in document && typeof document.freshness === 'string'
    ? document.freshness
    : undefined
  return (
    <section className={css.panel} data-feishu-docs-preview="" data-feishu-docs-kind={read.kind}>
      <ReadMeta
        data={read}
        limited={limited}
        {...(fetchedAt === undefined ? {} : { fetchedAt })}
        {...(freshness === undefined ? {} : { freshness })}
        labels={labels}
      />
      {read.title !== '' && <h3 className={css.title}>{read.title}</h3>}
      {read.content === '' ? (
        <p className={css.hint}>{labels.emptyContent}</p>
      ) : (
        <pre className={css.pre} data-feishu-docs-content="">
          {content}
        </pre>
      )}
      {truncated && <p className={css.hint}>{labels.contentTruncated}</p>}
      <p className={css.hint} data-feishu-docs-edit-note="">
        {labels.docsEditScopeNote}
      </p>
      {read.projection === 'markdown' && (
        <p className={css.hint} data-feishu-docs-markdown-read-only="">
          {labels.markdownReadOnly}
        </p>
      )}
      <SourceLink url={read.sourceUrl} labels={labels} />
    </section>
  )
}

/** Replace one block's text without dropping any other source-owned field. */
function withBlockText(data: FeishuDocEditData, id: string, text: string): FeishuDocEditData {
  return {
    ...data,
    blocks: data.blocks.map(block => (block.id === id ? { ...block, text } : block)),
  }
}

/** One editable text block. */
function EditBlock(props: {
  readonly block: FeishuDocEditBlock
  readonly labels: FeishuClientLabels
  readonly onChange: (text: string) => void
  readonly disabled: boolean
  readonly describedBy?: string
}): ReactNode {
  const { block, labels, onChange, disabled, describedBy } = props
  const label = `${labels.blocks}: ${block.tag}`
  return (
    <div className={css.field} data-feishu-docs-block={block.id} data-feishu-docs-block-tag={block.tag}>
      <span className={css.fieldLabel}>{block.tag}</span>
      <textarea
        className={css.textarea}
        value={block.text}
        rows={block.tag === 'pre' ? 6 : 3}
        spellCheck={false}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        data-feishu-docs-block-input={block.id}
        onChange={(event) => { onChange(event.target.value) }}
      />
    </div>
  )
}

/** The controlled block editor. */
function EditPreview(props: {
  readonly data: FeishuDocEditData
  readonly labels: FeishuClientLabels
  readonly onChange: (data: JsonValue) => void
  readonly onSave?: () => void
  readonly saving: boolean
}): ReactNode {
  const { data, labels, onChange, onSave, saving } = props
  const prefix = useId()
  const titleInvalid = data.titleEditable && data.title.trim() === ''
  const emit = (next: FeishuDocEditData): void => { onChange(next as unknown as JsonValue) }
  return (
    <section className={css.panel} data-feishu-docs-editor="" data-feishu-docs-kind={data.kind}>
      <div className={css.meta}>
        <span className={css.badge} data-feishu-docs-format="xml">{labels.xml}</span>
        {data.revisionId !== undefined && (
          <span className={css.badge}>
            {labels.revision} {data.revisionId}
          </span>
        )}
      </div>

      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor={`${prefix}-title`}>{labels.title}</label>
        {data.titleEditable ? (
          <>
            <input
              id={`${prefix}-title`}
              className={css.input}
              type="text"
              value={data.title}
              data-feishu-docs-title=""
              aria-invalid={titleInvalid}
              aria-describedby={titleInvalid ? `${prefix}-title-error` : undefined}
              onChange={(event) => { emit({ ...data, title: event.target.value }) }}
            />
            {titleInvalid && (
              <p
                className={css.error}
                id={`${prefix}-title-error`}
                data-feishu-docs-error="title"
                role="alert"
              >
                {labels.titleRequired}
              </p>
            )}
          </>
        ) : (
          <div className={css.hint} data-feishu-docs-title-read-only="">
            {data.title} — {labels.blockReadOnly}
          </div>
        )}
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{labels.blocks}</span>
        {data.blocks.length === 0 && (
          <p className={css.hint} data-feishu-docs-no-blocks="">{labels.noBlocks}</p>
        )}
        {data.blocks.map(block => (
          <EditBlock
            key={block.id}
            block={block}
            labels={labels}
            onChange={(text) => { emit(withBlockText(data, block.id, text)) }}
            disabled={saving}
          />
        ))}
      </div>

      {data.readOnlyBlocks.length > 0 && (
        <div className={css.field} data-feishu-docs-read-only-blocks="">
          {data.readOnlyBlocks.map((block, index) => (
            <div
              className={css.hint}
              key={`${block.tag}-${index}`}
              data-feishu-docs-read-only-block={block.tag}
            >
              <span className={css.badge}>{labels.blockReadOnly}</span>{' '}
              {block.text === '' ? `(${block.tag})` : block.text}
            </div>
          ))}
        </div>
      )}

      <p className={css.hint} data-feishu-docs-edit-note="">{labels.docsEditScopeNote}</p>
      <SourceLink url={data.sourceUrl} labels={labels} />
      {onSave !== undefined && (
        <div className={css.actions}>
          <button
            type="button"
            className={css.saveButton}
            data-feishu-docs-save=""
            disabled={saving || titleInvalid}
            onClick={() => { onSave() }}
          >
            {saving ? labels.saving : labels.save}
          </button>
        </div>
      )}
    </section>
  )
}

/** Static rendering of an edit payload when the host opened a preview. */
function EditReadOnly(props: {
  readonly data: FeishuDocEditData
  readonly labels: FeishuClientLabels
}): ReactNode {
  const { data, labels } = props
  return (
    <section className={css.panel} data-feishu-docs-preview="" data-feishu-docs-kind={data.kind}>
      <div className={css.meta}>
        <span className={css.badge} data-feishu-docs-format="xml">{labels.xml}</span>
        <span className={css.badge} data-feishu-docs-read-only="">{labels.readOnly}</span>
        {data.revisionId !== undefined && (
          <span className={css.badge}>{labels.revision} {data.revisionId}</span>
        )}
      </div>
      <h3 className={css.title}>{data.title}</h3>
      {data.blocks.map(block => (
        <pre className={css.pre} key={block.id}>{block.text}</pre>
      ))}
      <p className={css.hint}>{labels.docsEditScopeNote}</p>
      <SourceLink url={data.sourceUrl} labels={labels} />
    </section>
  )
}

/**
 * The XML/Markdown document renderer (read preview or block editor).
 * @param props - the document renderer props plus localized labels.
 */
export function FeishuDocsPreview(props: FeishuDocsPreviewProps): ReactNode {
  const edit = parseDocEditData(props.document.data)
  if (edit !== undefined) {
    if (props.readOnly) return <EditReadOnly data={edit} labels={props.labels} />
    return (
      <EditPreview
        data={edit}
        labels={props.labels}
        onChange={props.onChange}
        {...(props.onSave === undefined ? {} : { onSave: props.onSave })}
        saving={props.saving}
      />
    )
  }
  const read = parseDocReadData(props.document.data)
  if (read === undefined) return <InvalidDocument labels={props.labels} />
  return <ReadPreview read={read} document={props.document} labels={props.labels} />
}

/** The host-visible scope note (exported for S9's settings copy). */
export const FEISHU_DOCS_EDIT_SCOPE_NOTE = DOCS_EDIT_SCOPE_NOTE

/** The editable-block contract is exported for S9 renderer wiring/tests. */
export type { FeishuDocEditBlock, FeishuDocEditData, FeishuDocReadData }
