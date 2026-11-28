/**
 * Structured document presentation for the public window host. Source renderers
 * receive their original data. The optional mode switch presents a read-only
 * preview or an editor from ONE controlled draft; no renderer owns persistence.
 * Unknown formats stay read-only and never acquire a generic save path.
 */
import { createElement, useCallback, useId, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { MarkdownText, type MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { BUILTIN_SOURCE_IDS } from '../../clues/types.ts'
import { hostHttpBase } from '../desktop-env.ts'
import { desktopFileUrl } from '../markdown-images.ts'
import type { ClueFormatRenderer, ClueFormatRendererProps, JsonValue } from '../../clues/types.ts'
import type { WindowDocumentContent } from './types.ts'
import { markdownTextProps } from '../markdown-labels.tsx'
import { t } from '../locales.ts'
import { LoadingIndicator, Tabs, TextArea } from '../ui/index.ts'
import { MdToc } from '../md-toc.tsx'
import css from './windows.module.css'

export interface FormatRendererRegistry {
  getFormatRenderer(format: string): ClueFormatRenderer | undefined
  subscribe(listener: () => void): () => void
}

export interface ClueFormatHostProps extends WindowDocumentContent {
  readonly registry: FormatRendererRegistry
}

const TEXT_FORMATS = new Set(['text/plain', 'text/markdown'])

function useFormatRenderer(registry: FormatRendererRegistry, format: string): ClueFormatRenderer | undefined {
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry])
  const getSnapshot = useCallback(() => registry.getFormatRenderer(format), [registry, format])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function rawText(value: JsonValue): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? String(value)
    const MAX_RAW = 20_000
    return text.length > MAX_RAW ? `${text.slice(0, MAX_RAW)}\n…` : text
  } catch {
    return '[unserializable data]'
  }
}

function textOf(data: JsonValue): string | undefined {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const text = (data as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

/** Whether the host can offer an editable surface without inventing a format. */
export function supportsWindowEditing(registry: FormatRendererRegistry, format: string, data: JsonValue): boolean {
  return registry.getFormatRenderer(format) !== undefined || (TEXT_FORMATS.has(format) && textOf(data) !== undefined)
}

function dataWithText(data: JsonValue, text: string): JsonValue {
  if (typeof data === 'string') return text
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { text }
  return { ...data, text }
}

export interface TextDocumentContentProps {
  readonly text: string
  readonly readOnly: boolean
  readonly markdown?: boolean
  readonly pathImages?: MarkdownPathImages
  readonly saving?: boolean
  onChange(text: string): void
}

/** Lightweight editor plus the same Markdown renderer used elsewhere in DSH. */
export function TextDocumentContent(props: TextDocumentContentProps): ReactNode {
  const { text, readOnly, markdown, saving, onChange } = props
  if (readOnly) {
    if (markdown === true) {
      return <div className={css.markdownPreview} data-window-text-read-only data-window-markdown-preview>
        <MarkdownText {...markdownTextProps(text, {
          copyLabel: t('copy'), copiedLabel: t('copied'), codeLabel: t('codeBlockTitle'),
          wrapLabel: t('codeBlockWrap'), unwrapLabel: t('codeBlockUnwrap'),
        }, props.pathImages)} />
      </div>
    }
    return <pre className={css.textReadOnly} data-window-text-read-only>{text}</pre>
  }
  return (
    <TextArea
      className={css.textEditor}
      data-window-text-editor
      aria-label={t('editor')}
      spellCheck={false}
      disabled={saving === true}
      value={text}
      onChange={(event) => { onChange(event.target.value) }}
    />
  )
}

/** Keep SVG and remote diagrams in image context, never an inline document. */
export function DocumentImage({ url, alt, original }: { url?: string; alt: string; original?: string }): ReactNode {
  const [failed, setFailed] = useState(false)
  return <figure className={css.documentImage} data-clue-image-preview data-image-unavailable={url === undefined || failed ? '' : undefined}>
    {url !== undefined && !failed
      ? <img src={url} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => { setFailed(true) }} />
      : <figcaption>{t('cluePreviewImageUnavailable')}{original !== undefined && <a href={original} target="_blank" rel="noreferrer">{t('clueDetailOpenSource')}</a>}</figcaption>}
  </figure>
}

export function ClueFormatHost(props: ClueFormatHostProps): ReactNode {
  const {
    registry, sourceId, typeId, format, document, readOnly, saving, saved, loading, error, onChange, onSave,
    presentation, mode: controlledMode, onModeChange, editLoading, header, embedded, afterBody, bodyWrapper, pathImages,
  } = props
  const renderer = useFormatRenderer(registry, format)
  const text = renderer === undefined ? textOf(document.data) : undefined
  const known = renderer !== undefined || (text !== undefined && TEXT_FORMATS.has(format))
  const modes = presentation === 'modes'
  // A preview is read-only by default, but a caller that owns a lazy edit load
  // may still offer the switch: `onModeChange` is the signal that it will swap
  // in a real edit document when the reader asks for one. A truly read-only
  // source simply never defines it.
  const canSwitch = modes && known && (readOnly !== true || onModeChange !== undefined)
  const [internalMode, setInternalMode] = useState<'preview' | 'edit'>('preview')
  const mode = controlledMode ?? internalMode
  const activeMode = canSwitch ? mode : 'preview'
  const selectMode = (next: 'preview' | 'edit'): void => {
    if (controlledMode === undefined) setInternalMode(next)
    onModeChange?.(next)
  }
  const modeId = useId()
  const previewPanelId = `${modeId}-preview-panel`
  const editPanelId = `${modeId}-edit-panel`
  const previewTabId = `${modeId}-preview-tab`
  const editTabId = `${modeId}-edit-tab`

  /** Embedded documents: Ctrl/Cmd+Enter commits through the host-owned Save. */
  const onDocumentKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (embedded !== true || onSave === undefined || saving === true) return
    if (event.defaultPrevented || event.altKey || event.nativeEvent.isComposing) return
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    onSave()
  }

  const body = (preview: boolean): ReactNode => {
    if (renderer !== undefined) {
      const rendererProps: ClueFormatRendererProps & { readonly embedded?: boolean; readonly pathImages?: MarkdownPathImages } = {
        sourceId, typeId, format, document,
        readOnly: preview,
        saving: saving === true,
        onChange: (data: JsonValue) => { if (!preview) onChange?.(data) },
        // Embedded detail windows keep ONE Save in their stable footer: the
        // renderer never gets a second save control or shortcut. Standalone
        // mounts keep the source renderer's own save affordance.
        ...(preview || onSave === undefined || embedded === true ? {} : { onSave }),
        ...(embedded === undefined ? {} : { embedded }),
        ...(pathImages === undefined ? {} : { pathImages }),
      }
      return createElement(renderer, rendererProps)
    }
    if (known && text !== undefined) {
      return <div className={css.textContent} data-window-text-content data-window-text-format={format}>
        <TextDocumentContent
          text={text}
          readOnly={preview}
          markdown={format === 'text/markdown'}
          pathImages={pathImages}
          saving={saving === true}
          onChange={(next) => { onChange?.(dataWithText(document.data, next)) }}
        />
      </div>
    }
    if (sourceId === BUILTIN_SOURCE_IDS.files && 'assets' in document && document.freshness !== 'snapshot') {
      const image = document.assets?.find(asset => asset.mime?.startsWith('image/') === true && asset.path !== undefined)
      if (image?.path !== undefined) {
        const url = desktopFileUrl(image.path, hostHttpBase())
        return <DocumentImage key={url + (document.revision ?? '')} url={url} alt={image.path.split(/[\\/]/).at(-1) ?? ''} original={url} />
      }
    }
    return <section className={css.unknownFormat} data-window-unknown-format role="note">
      <div className={css.unknownHead}>
        <span className={css.readOnlyBadge} data-window-read-only>{t('windowReadOnly')}</span>
        <span className={css.unknownTitle}>{t('windowUnknownFormat')}</span>
      </div>
      <p className={css.hint}>{t('windowUnknownFormatHint')}</p>
      <dl className={css.meta}>
        <div><dt>format</dt><dd>{format}</dd></div>
        <div><dt>source</dt><dd>{sourceId}</dd></div>
        <div><dt>type</dt><dd>{typeId}</dd></div>
      </dl>
      <pre className={css.raw} data-window-raw>{rawText(document.data)}</pre>
    </section>
  }

  const previewBody = (readOnly: boolean): ReactNode => {
    const rendered = body(readOnly)
    return <>
      {readOnly && <MdToc scopeSelector="[data-window-document-body]" />}
      <div className={css.documentBody} data-window-document-body>
        {bodyWrapper === undefined ? rendered : bodyWrapper(rendered)}
      </div>
      {afterBody !== undefined && <div className={css.afterBody} data-window-document-after-body>{afterBody}</div>}
    </>
  }

  return <div
    className={css.document}
    data-window-document
    data-window-presentation={modes ? 'modes' : 'single'}
    data-window-mode={modes ? activeMode : undefined}
    onKeyDown={onDocumentKeyDown}
  >
    {header !== undefined && <div className={css.documentHeader} data-window-document-header>{header}</div>}
    {modes && canSwitch && <div className={css.modeBar}>
      <Tabs
        value={activeMode}
        ariaLabel={`${t('preview')} / ${t('edit')}`}
        onChange={value => { selectMode(value as 'preview' | 'edit') }}
        options={[
          { value: 'preview', label: t('preview'), id: previewTabId, controls: previewPanelId, 'data-window-mode-tab': 'preview' },
          { value: 'edit', label: t('edit'), id: editTabId, controls: editPanelId, 'data-window-mode-tab': 'edit' },
        ]}
      />
    </div>}
    {loading === true && <div className={css.documentStatus} data-window-loading><LoadingIndicator inline label={t('loading')} /></div>}
    {error !== undefined && error !== '' && <div className={css.documentError} data-window-error role="alert">{error}</div>}
    {saved === true && saving !== true && <div className={css.documentStatus} data-window-saved>{t('saved')}</div>}
    {/* A preview that can switch to an editor is a preview, not a read-only
        source: the tab pair and the reason strip already say what applies. */}
    {readOnly === true && known && !canSwitch && <div className={css.documentStatus}>
      <span className={css.readOnlyBadge} data-window-read-only>{t('windowReadOnly')}</span>
    </div>}
    {modes
      ? <>
          <div className={css.documentModes} data-window-document-modes>
            <section
              className={css.documentPane}
              role={canSwitch ? 'tabpanel' : 'region'}
              id={previewPanelId}
              aria-labelledby={canSwitch ? previewTabId : undefined}
              aria-label={canSwitch ? undefined : t('preview')}
              tabIndex={canSwitch ? 0 : undefined}
              hidden={activeMode !== 'preview'}
              data-window-document-preview
            >
              <div className={css.formatContent}>{previewBody(true)}</div>
            </section>
            {canSwitch && <section
              className={css.documentPane}
              role="tabpanel"
              id={editPanelId}
              aria-labelledby={editTabId}
              tabIndex={0}
              hidden={activeMode !== 'edit'}
              aria-busy={editLoading === true}
              data-window-document-editor
            >
              <div className={css.formatContent}>
                {editLoading === true
                  ? <div className={css.documentStatus} data-window-edit-loading><LoadingIndicator centered label={t('clueResourceEditLoading')} /></div>
                  : body(false)}
              </div>
            </section>}
          </div>
        </>
      : <div className={css.formatContent}>{previewBody(readOnly === true)}</div>}
  </div>
}
