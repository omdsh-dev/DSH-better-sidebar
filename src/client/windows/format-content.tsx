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
 * Unknown formats are READ-ONLY: a summary plus the raw JSON is shown, and no
 * generic save button exists. A generic save would have to invent a write
 * path, bypassing the source's own `saveEdit` / CLI / auth contract — exactly
 * what the clue design forbids.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
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

/**
 * Render one structured document through the format renderer its source
 * registered, or the read-only unknown-format summary.
 */
export function ClueFormatHost(props: ClueFormatHostProps): ReactNode {
  const {
    registry, sourceId, typeId, format, document, readOnly, saving, onChange, onSave,
  } = props
  const renderer = useFormatRenderer(registry, format)
  if (renderer !== undefined) {
    return (
      <>
        {renderer({
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
  return (
    <section className={css.unknownFormat} data-window-unknown-format role="note">
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
