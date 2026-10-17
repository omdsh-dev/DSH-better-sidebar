/**
 * Read-only Feishu document preview (`feishu.docs.xml` / `feishu.docs.markdown`).
 *
 * The document source is read-only this round: lark-cli exposes no lossless
 * local text-block update (only `str_replace` without a block scope, whole
 * block replace/delete/move, and append/overwrite), so the renderer NEVER
 * offers a save affordance and never converts Markdown back into a write
 * payload. The text is rendered as text (React escaping), not as HTML; content,
 * links and commands inside the document stay untrusted source data.
 */
import type { ReactNode } from 'react'
import type { ClueFormatRendererProps } from '../../../../clues/types.ts'
import { parseDocReadData, type FeishuDocReadData } from '../../../../clues/sources/feishu/format.ts'
import css from './feishu.module.css'
import type { FeishuClientLabels } from './labels.ts'

/** Rendering bound: the host already pages the source; never freeze the DOM. */
const MAX_PREVIEW_CHARS = 40_000

/** Props of {@link FeishuDocsPreview}. */
export interface FeishuDocsPreviewProps extends ClueFormatRendererProps {
  readonly labels: FeishuClientLabels
}

/** The read-only fallback when the payload is not a Feishu document read. */
function InvalidDocument(props: { readonly labels: FeishuClientLabels }): ReactNode {
  return (
    <section className={css.panel} data-feishu-docs-invalid="" role="note">
      <p className={css.hint}>{props.labels.invalidDocument}</p>
    </section>
  )
}

/** Metadata badges of one document. */
function DocumentMeta(props: {
  readonly data: FeishuDocReadData
  readonly limited: boolean
  readonly labels: FeishuClientLabels
}): ReactNode {
  const { data, limited, labels } = props
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
 * @param props - the document renderer props plus localized labels.
 */
export function FeishuDocsPreview(props: FeishuDocsPreviewProps): ReactNode {
  const data = parseDocReadData(props.document.data)
  if (data === undefined) return <InvalidDocument labels={props.labels} />
  const limited = 'limited' in props.document && props.document.limited === true
  const truncated = data.content.length > MAX_PREVIEW_CHARS
  const content = truncated ? data.content.slice(0, MAX_PREVIEW_CHARS) : data.content
  return (
    <section className={css.panel} data-feishu-docs-preview="" data-feishu-docs-kind={data.kind}>
      <DocumentMeta data={data} limited={limited} labels={props.labels} />
      {data.title !== '' && <h3 className={css.title}>{data.title}</h3>}
      {data.content === '' ? (
        <p className={css.hint}>{props.labels.emptyContent}</p>
      ) : (
        <pre className={css.pre} data-feishu-docs-content="">
          {content}
        </pre>
      )}
      {truncated && <p className={css.hint}>{props.labels.contentTruncated}</p>}
    </section>
  )
}
