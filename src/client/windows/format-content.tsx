/**
 * The content host for S1 structured documents inside a floating window.
 *
 * The public window face never guesses how a source's `data` should look. A
 * caller hands a document descriptor (`kind: 'document'`) and the plugin that
 * OWNS the format registers a renderer through
 * `ctx.betterSidebar.clues.registerFormatRenderer`; this component resolves
 * that renderer and forwards the original `document`, `readOnly`, `saving`,
 * `onChange` and `onSave` untouched.
 *
 * Two built-in carriers exist so a plain source does not fall into the raw
 * read-only summary: `text/plain` and `text/markdown` (`{ text }` data, the
 * shape S1's local-file source produces) render through
 * {@link TextDocumentContent} — a reusable single-text editor. A registered
 * source renderer always wins over a built-in.
 *
 * Unknown formats are READ-ONLY: a summary plus the raw JSON is shown, and no
 * generic save button exists. A generic save would have to invent a write
 * path, bypassing the source's own `saveEdit` / CLI / auth contract — exactly
 * what the clue design forbids.
 */
import { createElement, useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type { ClueFormatRenderer, JsonValue } from '../../clues/types.ts'
import type { WindowDocumentContent } from './types.ts'
import { t } from '../locales.ts'
import css from './windows.module.css'

/** The registry subset the host needs (the real one is `ctx.betterSidebar.clues`). */
export interface FormatRendererRegistry {
  getFormatRenderer(format: string): ClueFormatRenderer | undefined
  subscribe(listener: () => void): () => void
}

/** Props of {@link ClueFormatHost}. */
export interface ClueFormatHostProps extends WindowDocumentContent {
  readonly registry: FormatRendererRegistry
}

/** Formats the built-in single-text carrier renders. */
const TEXT_FORMATS = new Set(['text/plain', 'text/markdown'])

/** Resolve the live renderer for one format (registration is observable). */
function useFormatRenderer(registry: FormatRendererRegistry, format: string): ClueFormatRenderer | undefined {
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry])
  const getSnapshot = useCallback(() => registry.getFormatRenderer(format), [registry, format])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Pretty raw JSON, bounded so a pathological document cannot freeze the DOM. */
function rawText(value: JsonValue): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? String(value)
    const MAX_RAW = 20_000
    return text.length > MAX_RAW ? `${text.slice(0, MAX_RAW)}\n…` : text
  } catch {
    return '[unserializable data]'
  }
}

/** The single-text payload of a document (`{ text }` or a bare string), if any. */
function textOf(data: JsonValue): string | undefined {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const text = (data as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

/** Replace the text field without dropping any other source-owned data field. */
function dataWithText(data: JsonValue, text: string): JsonValue {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { text }
  return { ...data, text }
}

/** Props of the reusable single-text carrier. */
export interface TextDocumentContentProps {
  readonly text: string
  readonly readOnly: boolean
  onChange(text: string): void
}

/**
 * The reusable text / Markdown EDITING carrier: one textarea over the source's
 * own `text` field (or a read-only block for a preview). It never saves by
 * itself — every keystroke goes back to the source through `onChange`, and the
 * source's `saveEdit` remains the only write path.
 */
export function TextDocumentContent(props: TextDocumentContentProps): ReactNode {
  const { text, readOnly, onChange } = props
  if (readOnly) {
    return <pre className={css.textReadOnly} data-window-text-read-only>{text}</pre>
  }
  return (
    <textarea
      className={css.textEditor}
      data-window-text-editor
      aria-label={t('editor')}
      spellCheck={false}
      value={text}
      onChange={(event) => { onChange(event.target.value) }}
    />
  )
}

/**
 * Render one structured document through the format renderer its source
 * registered, through the built-in text carrier, or through the read-only
 * unknown-format summary.
 */
export function ClueFormatHost(props: ClueFormatHostProps): ReactNode {
  const {
    registry, sourceId, typeId, format, document, readOnly, saving, saved, loading, error, onChange, onSave,
  } = props
  const renderer = useFormatRenderer(registry, format)
  const text = renderer === undefined ? textOf(document.data) : undefined
  const builtInText = renderer === undefined && text !== undefined && TEXT_FORMATS.has(format)
  const status = (
    <>
      {loading === true && <div className={css.documentStatus} data-window-loading>{t('loading')}</div>}
      {error !== undefined && error !== '' && (
        <div className={css.documentError} data-window-error role="alert">{error}</div>
      )}
      {saved === true && saving !== true && (
        <div className={css.documentStatus} data-window-saved>{t('saved')}</div>
      )}
    </>
  )
  const readOnlyBadge = readOnly === true && (
    <div className={css.documentStatus}>
      <span className={css.readOnlyBadge} data-window-read-only>{t('windowReadOnly')}</span>
    </div>
  )
  if (renderer !== undefined) {
    return (
      <>
        {status}
        {readOnlyBadge}
        {createElement(renderer, {
          sourceId,
          typeId,
          format,
          document,
          readOnly: readOnly === true,
          saving: saving === true,
          onChange: (data: JsonValue) => { onChange?.(data) },
          ...(onSave === undefined ? {} : { onSave }),
        })}
      </>
    )
  }
  if (builtInText) {
    return (
      <div className={css.textContent} data-window-text-content data-window-text-format={format}>
        {status}
        {readOnlyBadge}
        <TextDocumentContent
          text={text}
          readOnly={readOnly === true}
          onChange={(next) => { onChange?.(dataWithText(document.data, next)) }}
        />
      </div>
    )
  }
  return (
    <section className={css.unknownFormat} data-window-unknown-format role="note">
      {status}
      <div className={css.unknownHead}>
        <span className={css.readOnlyBadge} data-window-read-only>{t('windowReadOnly')}</span>
        <span className={css.unknownTitle}>{t('windowUnknownFormat')}</span>
      </div>
      <p className={css.hint}>{t('windowUnknownFormatHint')}</p>
      <dl className={css.meta}>
        <div>
          <dt>format</dt>
          <dd>{format}</dd>
        </div>
        <div>
          <dt>source</dt>
          <dd>{sourceId}</dd>
        </div>
        <div>
          <dt>type</dt>
          <dd>{typeId}</dd>
        </div>
      </dl>
      <pre className={css.raw} data-window-raw>{rawText(document.data)}</pre>
    </section>
  )
}
