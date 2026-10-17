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
 * When `onSave` is supplied this renderer owns the ONE Save control (the S6
 * host forwards the callback but renders no action button); S9 must not add a
 * second save action for the same document.
 */
import { useId, useState, type ReactNode } from 'react'
import type { ClueFormatRendererProps, JsonValue } from '../../../../clues/types.ts'
import {
  DOCS_EDIT_SCOPE_NOTE,
  FEISHU_FORMATS,
  parseDocEditData,
  parseDocReadData,
  type FeishuDocEditBlock,
  type FeishuDocEditData,
  type FeishuDocReadData,
} from '../../../../clues/sources/feishu/format.ts'
import css from './feishu.module.css'
import type { FeishuClientLabels } from './labels.ts'
import { appDateTime } from './time.ts'

/** Rendering bound: the host already pages the source; never freeze the DOM. */
const MAX_PREVIEW_CHARS = 40_000

/** Props of {@link FeishuDocsPreview}. */
export interface FeishuDocsPreviewProps extends ClueFormatRendererProps {
  readonly labels: FeishuClientLabels
  /** App-locale date/time formatter (S9 supplies it; fallback is the browser locale). */
  readonly formatDateTime?: (value: string) => string
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
function stampOf(
  value: string | undefined,
  formatDateTime: ((value: string) => string) | undefined,
): string | undefined {
  if (value === undefined || value === '') return undefined
  if (formatDateTime !== undefined) return formatDateTime(value)
  return appDateTime(value)
}

/** The localized freshness word, falling back to the raw S1 value. */
function freshnessLabel(value: string, labels: FeishuClientLabels): string {
  if (value === 'live') return labels.freshnessLive
  if (value === 'snapshot') return labels.freshnessSnapshot
  return value
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
  readonly formatDateTime?: (value: string) => string
}): ReactNode {
  const { data, limited, fetchedAt, freshness, labels, formatDateTime } = props
  const stamp = stampOf(fetchedAt, formatDateTime)
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
          {labels.freshness}: {freshnessLabel(freshness, labels)}
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
  readonly formatDateTime?: (value: string) => string
}): ReactNode {
  const { read, document, labels, formatDateTime } = props
  const prefix = useId()
  const limited = 'limited' in document && document.limited === true
  // The cap is a rendering bound, not a source read bound. When the source
  // returned the whole content, the user must be able to expand it; claiming
  // the full document is only "available through the source" was misleading.
  const [expanded, setExpanded] = useState(false)
  const collapsible = read.content.length > MAX_PREVIEW_CHARS
  const content = collapsible && !expanded ? read.content.slice(0, MAX_PREVIEW_CHARS) : read.content
  const fetchedAt = 'fetchedAt' in document && typeof document.fetchedAt === 'string'
    ? document.fetchedAt
    : undefined
  const freshness = 'freshness' in document && typeof document.freshness === 'string'
    ? document.freshness
    : undefined
  const fragmentNote = read.fragment === 'blocks'
    ? labels.fragmentBlocks
    : read.fragment === 'bytes'
      ? labels.fragmentBytes
      : undefined
  return (
    <section className={css.panel} data-feishu-docs-preview="" data-feishu-docs-kind={read.kind}>
      <ReadMeta
        data={read}
        limited={limited}
        {...(fetchedAt === undefined ? {} : { fetchedAt })}
        {...(freshness === undefined ? {} : { freshness })}
        labels={labels}
        {...(formatDateTime === undefined ? {} : { formatDateTime })}
      />
      {read.title !== '' && <h3 className={css.title}>{read.title}</h3>}
      {read.content === '' ? (
        <p className={css.hint}>{labels.emptyContent}</p>
      ) : (
        <pre className={css.pre} id={`${prefix}-content`} data-feishu-docs-content="">
          {content}
        </pre>
      )}
      {collapsible && (
        <p className={css.hint} data-feishu-docs-truncated="">
          {labels.contentTruncated}{' '}
          <button
            type="button"
            className={css.linkButton}
            data-feishu-docs-expand=""
            aria-expanded={expanded}
            aria-controls={`${prefix}-content`}
            onClick={() => { setExpanded(current => !current) }}
          >
            {expanded ? labels.showLess : labels.showFullContent}
          </button>
        </p>
      )}
      {fragmentNote !== undefined && (
        <p className={css.hint} data-feishu-docs-fragment={read.fragment}>
          {fragmentNote}
        </p>
      )}
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

/** One editable or read-only entry, interleaved by document order. */
type EditEntry =
  | { readonly kind: 'editable'; readonly at: number; readonly block: FeishuDocEditBlock }
  | { readonly kind: 'readOnly'; readonly at: number; readonly block: FeishuDocEditData['readOnlyBlocks'][number] }

/** Merge editable and read-only blocks so a table in the middle stays in the middle. */
function editEntriesOf(data: FeishuDocEditData): EditEntry[] {
  return [
    ...data.blocks.map(block => ({ kind: 'editable' as const, at: block.order, block })),
    ...data.readOnlyBlocks.map(block => ({ kind: 'readOnly' as const, at: block.order, block })),
  ].sort((left, right) => left.at - right.at)
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

/** One read-only complex block with its own resource entry, when it has a URL. */
function ReadOnlyBlockRow(props: {
  readonly block: FeishuDocEditData['readOnlyBlocks'][number]
  readonly labels: FeishuClientLabels
}): ReactNode {
  const { block, labels } = props
  return (
    <div className={css.hint} data-feishu-docs-read-only-block={block.tag}>
      <span className={css.badge}>{labels.blockReadOnly}</span>{' '}
      {block.text === '' ? `(${block.tag})` : block.text}
      <span data-feishu-docs-read-only-reason="">{' '}— {block.reason}</span>
      {block.url !== undefined && /^https?:\/\//i.test(block.url) && (
        <>
          {' '}
          <a className={css.linkButton} href={block.url} target="_blank" rel="noreferrer">
            {labels.resourceLink}
          </a>
        </>
      )}
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
              disabled={saving}
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
                {labels.docsTitleRequired}
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
        {data.blocks.length === 0 && data.readOnlyBlocks.length === 0 && (
          <p className={css.hint} data-feishu-docs-no-blocks="">{labels.noBlocks}</p>
        )}
        {editEntriesOf(data).map(entry => (entry.kind === 'editable' ? (
          <EditBlock
            key={`editable:${entry.block.id}`}
            block={entry.block}
            labels={labels}
            onChange={(text) => { emit(withBlockText(data, entry.block.id, text)) }}
            disabled={saving}
          />
        ) : (
          <ReadOnlyBlockRow
            key={`read-only:${entry.block.tag}:${entry.at}`}
            block={entry.block}
            labels={labels}
          />
        )))}
      </div>

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
      {editEntriesOf(data).map(entry => (entry.kind === 'editable' ? (
        <pre className={css.pre} key={`editable:${entry.block.id}`}>{entry.block.text}</pre>
      ) : (
        <ReadOnlyBlockRow
          key={`read-only:${entry.block.tag}:${entry.at}`}
          block={entry.block}
          labels={labels}
        />
      )))}
      <p className={css.hint}>{labels.docsEditScopeNote}</p>
      <SourceLink url={data.sourceUrl} labels={labels} />
    </section>
  )
}

/**
 * The XML/Markdown document renderer (read preview or block editor).
 *
 * The editable form is only dispatched for the XML format. A client-side
 * payload mix-up (an edit document under `feishu.docs.markdown`) must not
 * expose a form whose save the source will reject.
 * @param props - the document renderer props plus localized labels.
 */
export function FeishuDocsPreview(props: FeishuDocsPreviewProps): ReactNode {
  const edit = props.format === FEISHU_FORMATS.docsXml
    ? parseDocEditData(props.document.data)
    : undefined
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
  return (
    <ReadPreview
      read={read}
      document={props.document}
      labels={props.labels}
      {...(props.formatDateTime === undefined ? {} : { formatDateTime: props.formatDateTime })}
    />
  )
}

/** The host-visible scope note (exported for S9's settings copy). */
export const FEISHU_DOCS_EDIT_SCOPE_NOTE = DOCS_EDIT_SCOPE_NOTE

/** The editable-block contract is exported for S9 renderer wiring/tests. */
export type { FeishuDocEditBlock, FeishuDocEditData, FeishuDocReadData }
